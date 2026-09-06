/**
 * Reconciles a month's "Incomplete Provider" workbook against NHS England's
 * full CSV extract for the same month, so a parsing regression is caught before
 * the figures reach patients.
 *
 *   npm run validate -- --file data/Incomplete-Provider-Jun26-...xlsx \
 *                       --csv data/20260630-RTT-June-2026-full-extract.csv
 *
 * Flags:
 *   --file <path>  workbook to check (default: the only .xlsx in ./data)
 *   --csv <path>   full extract to check against (default: the only .csv)
 *   --limit <n>    mismatching providers to list (default 20)
 *
 * The two publications do not agree line for line by design. The provider
 * workbook excludes the NONC commissioner — patients commissioned outside
 * England — while the full extract includes it, so NONC rows are removed from
 * the CSV side before comparing. On the June 2026 release that accounts for
 * every one of the 113 providers that otherwise differ, and the remaining 537
 * reconcile exactly.
 *
 * Exits non-zero if anything fails to reconcile.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, resolvePeriodEnd, DATA_DIR } from '../lib/cli.ts';
import { csvRows, headerIndex } from '../lib/csv.ts';
import { parseWorkbook } from '../lib/parse-workbook.ts';

/** Incomplete pathways. The other parts are different measures. */
const INCOMPLETE_PART = 'Part_2';
/** The workbook's per-provider subtotal row, not a specialty. */
const TOTAL_TFC = 'C_999';
/** Commissioners outside England, which the provider workbook leaves out. */
const EXCLUDED_COMMISSIONER = 'NONC';
/**
 * The CSV's "Total" column is empty on incomplete-pathway rows; "Total All"
 * carries the figure. Reading the wrong one silently yields zero everywhere.
 */
const TOTAL_COLUMN = 'Total All';

const REQUIRED_CSV_COLUMNS = [
  'Period',
  'Provider Org Code',
  'RTT Part Type',
  'Treatment Function Code',
  'Commissioner Org Code',
  TOTAL_COLUMN,
];

type CsvTotals = {
  byProvider: Map<string, number>;
  pairs: Set<string>;
  periods: Set<string>;
  rowsRead: number;
  rowsCounted: number;
  excludedByCommissioner: number;
};

async function resolveOnly(given: string | boolean | undefined, extension: string): Promise<string> {
  if (typeof given === 'string') {
    await stat(given);
    return given;
  }
  const entries = (await readdir(DATA_DIR)).filter(
    (name) => name.toLowerCase().endsWith(extension) && !name.startsWith('~$'),
  );
  if (entries.length === 0) throw new Error(`No ${extension} file in ./${DATA_DIR}.`);
  if (entries.length > 1) {
    throw new Error(
      `Several ${extension} files in ./${DATA_DIR}; choose one:\n` +
        entries.sort().map((name) => `  ${path.join(DATA_DIR, name)}`).join('\n'),
    );
  }
  return path.join(DATA_DIR, entries[0]);
}

async function readCsv(file: string): Promise<CsvTotals> {
  const totals: CsvTotals = {
    byProvider: new Map(),
    pairs: new Set(),
    periods: new Set(),
    rowsRead: 0,
    rowsCounted: 0,
    excludedByCommissioner: 0,
  };

  let index: Map<string, number> | null = null;
  for await (const row of csvRows(file)) {
    if (!index) {
      index = headerIndex(row);
      const missing = REQUIRED_CSV_COLUMNS.filter((name) => !index!.has(name));
      if (missing.length > 0) {
        throw new Error(`CSV is missing column(s): ${missing.join(', ')}`);
      }
      continue;
    }
    if (row.length < REQUIRED_CSV_COLUMNS.length) continue;
    totals.rowsRead += 1;

    const at = (name: string) => row[index!.get(name)!] ?? '';
    if (at('RTT Part Type') !== INCOMPLETE_PART) continue;

    const treatmentFunction = at('Treatment Function Code').trim();
    if (treatmentFunction === TOTAL_TFC) continue;

    if (at('Commissioner Org Code').trim().toUpperCase() === EXCLUDED_COMMISSIONER) {
      totals.excludedByCommissioner += 1;
      continue;
    }

    totals.periods.add(at('Period').trim());
    const provider = at('Provider Org Code').trim().toUpperCase();
    const patients = Number(at(TOTAL_COLUMN) || 0);
    totals.byProvider.set(provider, (totals.byProvider.get(provider) ?? 0) + patients);
    totals.pairs.add(`${provider}|${treatmentFunction}`);
    totals.rowsCounted += 1;
  }

  if (!index) throw new Error(`${file} is empty.`);
  return totals;
}

function describePeriods(periods: Set<string>): string {
  return [...periods].sort().join(', ') || '(none)';
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * The extract labels its period "RTT-June-2026". Converted to a month end so it
 * can be compared with the workbook's own period, because pairing the wrong
 * month's files is the easiest mistake to make and produces hundreds of
 * mismatches that look like a parsing bug.
 */
function csvPeriodEnd(label: string): string | null {
  const match = label.toLowerCase().match(/([a-z]+)[-_ ](20\d{2})/);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]);
  if (month === -1) return null;
  return new Date(Date.UTC(Number(match[2]), month + 1, 0)).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workbookFile = await resolveOnly(args.file, '.xlsx');
  const csvFile = await resolveOnly(args.csv, '.csv');
  const limit = Number(args.limit ?? 20);

  console.log(`workbook : ${workbookFile}`);
  console.log(`extract  : ${csvFile}\n`);

  const parsed = await parseWorkbook(workbookFile);
  const csv = await readCsv(csvFile);

  const workbookByProvider = new Map<string, number>();
  const workbookNames = new Map<string, string>();
  const workbookPairs = new Set<string>();
  for (const row of parsed.rows) {
    workbookByProvider.set(row.odsCode, (workbookByProvider.get(row.odsCode) ?? 0) + (row.patientsWaiting ?? 0));
    if (row.providerName) workbookNames.set(row.odsCode, row.providerName);
    workbookPairs.add(`${row.odsCode}|${row.treatmentFunctionCode}`);
  }

  console.log(`workbook : ${parsed.rows.length} rows over ${parsed.sheets.length} sheet(s), ${workbookByProvider.size} providers`);
  console.log(`extract  : ${csv.rowsCounted} incomplete-pathway rows counted of ${csv.rowsRead}, ${csv.byProvider.size} providers`);
  console.log(`           ${csv.excludedByCommissioner} row(s) excluded as commissioner ${EXCLUDED_COMMISSIONER}`);
  console.log(`           period(s) in extract: ${describePeriods(csv.periods)}\n`);

  const failures: string[] = [];

  if (csv.periods.size > 1) {
    failures.push(`the extract mixes ${csv.periods.size} periods: ${describePeriods(csv.periods)}`);
  }

  const workbookPeriod = resolvePeriodEnd(args.period, workbookFile).periodEnd;
  const [csvLabel] = [...csv.periods];
  const extractPeriod = csvLabel ? csvPeriodEnd(csvLabel) : null;
  console.log(`workbook period : ${workbookPeriod}`);
  console.log(`extract period  : ${extractPeriod ?? `${csvLabel} (unrecognised)`}\n`);
  if (extractPeriod && extractPeriod !== workbookPeriod) {
    failures.push(
      `the files are for different months: workbook is ${workbookPeriod}, extract is ${extractPeriod}. ` +
        'Compare a workbook against the extract for the same month.',
    );
  }

  const onlyCsv = [...csv.byProvider.keys()].filter((code) => !workbookByProvider.has(code));
  const onlyWorkbook = [...workbookByProvider.keys()].filter((code) => !csv.byProvider.has(code));
  console.log(`providers only in the extract  : ${onlyCsv.length}`);
  console.log(`providers only in the workbook : ${onlyWorkbook.length}`);
  if (onlyCsv.length > 0) failures.push(`${onlyCsv.length} provider(s) appear only in the extract: ${onlyCsv.slice(0, 10).join(', ')}`);
  if (onlyWorkbook.length > 0) failures.push(`${onlyWorkbook.length} provider(s) appear only in the workbook: ${onlyWorkbook.slice(0, 10).join(', ')}`);

  // The workbook publishes a complete provider x specialty grid including
  // zeros; the extract only carries combinations with activity. So every
  // extract pair must exist in the workbook, but not the reverse.
  const pairsMissingFromWorkbook = [...csv.pairs].filter((pair) => !workbookPairs.has(pair));
  console.log(`provider x specialty pairs in the extract but not the workbook : ${pairsMissingFromWorkbook.length}`);
  if (pairsMissingFromWorkbook.length > 0) {
    failures.push(`${pairsMissingFromWorkbook.length} pair(s) missing from the workbook: ${pairsMissingFromWorkbook.slice(0, 5).join(', ')}`);
  }

  const mismatches: Array<{ code: string; name: string; workbook: number; extract: number }> = [];
  for (const [code, workbookTotal] of workbookByProvider) {
    const extractTotal = csv.byProvider.get(code);
    if (extractTotal === undefined) continue;
    if (workbookTotal !== extractTotal) {
      mismatches.push({ code, name: workbookNames.get(code) ?? code, workbook: workbookTotal, extract: extractTotal });
    }
  }

  const compared = [...workbookByProvider.keys()].filter((code) => csv.byProvider.has(code)).length;
  console.log(`\nproviders compared : ${compared}`);
  console.log(`totals disagree    : ${mismatches.length}`);

  if (mismatches.length > 0) {
    failures.push(`${mismatches.length} provider total(s) disagree`);
    console.log(`\nworst ${Math.min(limit, mismatches.length)} by absolute difference:`);
    for (const entry of mismatches
      .sort((a, b) => Math.abs(b.workbook - b.extract) - Math.abs(a.workbook - a.extract))
      .slice(0, limit)) {
      console.log(
        `  ${entry.code.padEnd(7)} ${entry.name.slice(0, 44).padEnd(46)}` +
          ` workbook=${String(entry.workbook).padStart(8)} extract=${String(entry.extract).padStart(8)}` +
          ` diff=${String(entry.workbook - entry.extract).padStart(8)}`,
      );
    }
  }

  const workbookGrand = [...workbookByProvider.values()].reduce((total, value) => total + value, 0);
  const extractGrand = [...csv.byProvider.values()].reduce((total, value) => total + value, 0);
  console.log(`\ngrand total  workbook=${workbookGrand}  extract=${extractGrand}  difference=${workbookGrand - extractGrand}`);

  if (failures.length > 0) {
    console.error(`\nFAILED to reconcile:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nreconciled: every provider total matches the full extract');
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
