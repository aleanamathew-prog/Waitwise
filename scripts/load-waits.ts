/**
 * Loads an NHS England "Incomplete Provider" workbook into wait_snapshots.
 *
 *   npm run inspect                 # look at the raw rows first
 *   npm run load -- --dry-run       # show the detected mapping, write nothing
 *   npm run load                    # upsert
 *
 * Flags:
 *   --file <path>          workbook to read (default: the only .xlsx in ./data)
 *   --sheet <name>         sheet to read (default: the first with a usable header)
 *   --header-row <n>       force the header row instead of detecting it
 *   --period <YYYY-MM-DD>  reporting month end (default: parsed from the filename)
 *   --source <text>        value stored in wait_snapshots.source
 *   --scan <n>             rows to search for the header row (default 30)
 *   --map k=B,k2=D         override detected columns by letter or index
 *   --dry-run              parse and report, no database writes
 */
import { columnLetter } from '../lib/xlsx.ts';
import { parseArgs, resolveInputFile, resolvePeriodEnd } from '../lib/cli.ts';
import { REQUIRED_FIELDS, parseWorkbook } from '../lib/parse-workbook.ts';
import type { ColumnMap, FieldKey } from '../lib/rtt-headers.ts';
import { closePool, withTransaction } from '../lib/db.ts';
import { upsertSnapshots } from '../lib/ingest.ts';

const DEFAULT_SOURCE = 'nhs-england-rtt-incomplete-provider';

const REPORTED_FIELDS: FieldKey[] = [
  'provider_code',
  'provider_name',
  'treatment_function_code',
  'treatment_function_name',
  'patients_waiting',
  'median_wait_weeks',
  'pct_within_18_weeks',
];

/** Parses `--map provider_code=B,patients_waiting=12` into column indexes. */
function parseOverrides(raw: string | boolean | undefined): ColumnMap {
  if (typeof raw !== 'string') return {};
  const overrides: ColumnMap = {};
  for (const pair of raw.split(',')) {
    const [key, value] = pair.split('=').map((part) => part.trim());
    if (!key || !value) throw new Error(`Bad --map entry "${pair}", expected field=column`);
    const index = /^\d+$/.test(value)
      ? Number(value)
      : value
          .toUpperCase()
          .split('')
          .reduce((acc, char) => acc * 26 + (char.charCodeAt(0) - 64), 0);
    if (!Number.isFinite(index) || index < 1) throw new Error(`Bad column "${value}" in --map`);
    overrides[key as FieldKey] = index;
  }
  return overrides;
}

async function main(): Promise<void> {

  const args = parseArgs(process.argv.slice(2));
  const file = await resolveInputFile(args.file);
  const { periodEnd, source: periodSource } = resolvePeriodEnd(args.period, file);
  const source = typeof args.source === 'string' ? args.source : DEFAULT_SOURCE;

  console.log(`file        : ${file}`);
  console.log(`period_end  : ${periodEnd} (from ${periodSource})`);
  console.log(`source      : ${source}`);

  const result = await parseWorkbook(file, {
    sheet: typeof args.sheet === 'string' ? args.sheet : null,
    headerRow: typeof args['header-row'] === 'string' ? Number(args['header-row']) : null,
    scanRows: args.scan ? Number(args.scan) : undefined,
    overrides: parseOverrides(args.map),
  });

  for (const { sheetName, reason } of result.skippedSheets) {
    console.log(`skipped sheet "${sheetName}": ${reason}`);
  }

  for (const sheet of result.sheets) {
    console.log(`\nsheet       : ${sheet.sheetName}  (header row ${sheet.headerRowNumber})`);
    console.log('  column mapping:');
    for (const field of REPORTED_FIELDS) {
      const index = sheet.columns[field];
      const required = REQUIRED_FIELDS.includes(field) ? ' (required)' : '';
      console.log(
        index
          ? `    ${field.padEnd(24)} ${columnLetter(index).padEnd(3)} "${sheet.labels[index - 1]}"`
          : `    ${field.padEnd(24)} —   not found${required}`,
      );
    }
    const missing = REQUIRED_FIELDS.filter((field) => sheet.columns[field] === undefined);
    if (missing.length > 0) {
      throw new Error(
        `Sheet "${sheet.sheetName}" is missing required column(s): ${missing.join(', ')}. ` +
          'Pass --map to set them.',
      );
    }
    console.log(
      `  header fallback: ${
        sheet.viaLeaf.length === 0
          ? 'not needed'
          : `fired for ${sheet.viaLeaf.join(', ')}`
      }`,
    );
    console.log(
      `  ${sheet.rows.length} data row(s); skipped ` +
        `${sheet.skipped.noProvider} without a provider code, ` +
        `${sheet.skipped.noTreatmentFunction} without a treatment function, ` +
        `${sheet.skipped.aggregate} aggregate row(s)`,
    );
  }

  if (result.duplicates.length > 0) {
    // Upserting these would silently keep whichever sheet was read last.
    console.log(
      `\nWARNING: ${result.duplicates.length} provider/treatment-function pair(s) appear on more than one sheet:`,
    );
    for (const duplicate of result.duplicates.slice(0, 10)) {
      console.log(`  ${duplicate.key} on ${duplicate.sheets.join(' and ')}`);
    }
  }

  const providers = new Set(result.rows.map((row) => row.odsCode));
  console.log(
    `\ntotal: ${result.rows.length} row(s) across ${result.sheets.length} sheet(s), ` +
      `${providers.size} provider(s)`,
  );
  console.log('\nfirst 3 parsed rows:');
  for (const row of result.rows.slice(0, 3)) console.log(' ', JSON.stringify(row));

  if (args['dry-run']) {
    console.log('\n--dry-run: nothing written');
    return;
  }

  await withTransaction((client) => upsertSnapshots(client, result.rows, periodEnd, source));
  console.log(`\nupserted ${result.rows.length} snapshot(s) for ${periodEnd}`);
}

main()
  .catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  })
  .finally(closePool);
