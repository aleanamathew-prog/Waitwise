/**
 * Turns an NHS England "Incomplete Provider" workbook into snapshot rows.
 *
 * Nothing about the layout is assumed: the opening rows of each sheet are
 * scanned, headers split over merged rows are joined into one label per column,
 * and the derived mapping is returned so the caller can print it. When no sheet
 * yields the required columns it throws with every label it saw, rather than
 * guessing.
 *
 * Every qualifying sheet is read, not just the first. The release splits
 * providers across "Provider" (NHS trusts) and "IS Provider" (independent
 * sector), and a patient exercising choice can be referred to either.
 */
import { columnLetter, toInteger, toNumber } from './xlsx.ts';
import { eachSheet } from './workbook.ts';
import {
  REQUIRED_FIELDS,
  buildLabels,
  detectBestEffortHeader,
  detectHeader,
  mapColumns,
} from './rtt-headers.ts';
import type { ColumnMap, FieldKey } from './rtt-headers.ts';
import type { SnapshotRow, Sector } from './ingest.ts';
import { noOverrides, overridesFor } from './overrides.ts';
import type { ColumnOverrides } from './overrides.ts';

export { REQUIRED_FIELDS };

export type ParseOptions = {
  /** Read only this sheet. Default: every sheet whose header maps. */
  sheet?: string | null;
  headerRow?: number | null;
  scanRows?: number;
  overrides?: ColumnOverrides;
};

const DEFAULT_SCAN_ROWS = 30;

/**
 * The same workbook also carries "with DTA" sheets — incomplete pathways with a
 * decision to admit for treatment. That is a subset of the main measure, so
 * loading it alongside would double count. Its total column names itself, which
 * is what we match on rather than the sheet name.
 */
const DIFFERENT_MEASURE = /decision to admit/;

/**
 * The independent-sector sheet captions itself "Independent Sector Provider
 * Level Data", which is carried into every stacked column label. Read the
 * sector from the sheet's own words rather than its name, for the same reason
 * the decision-to-admit guard does.
 */
const INDEPENDENT_SECTOR = /independent sector/;

/**
 * How many populated cells a row must carry for its sheet to count as a data
 * table, and so for a failure to read its header to be an error rather than an
 * omission.
 *
 * Measured on the June 2026 release: data rows hold 112-119 populated cells,
 * the metadata rows above them hold 2-3, and the Notes and Guidance sheets
 * produce no rows at all. Six is the narrowest sheet that could be worth
 * loading — the three required columns plus a provider name, a treatment
 * function name and one measure — so it sits far below any real table and
 * above anything that is prose.
 */
const TABLE_MIN_COLUMNS = 6;

/** A sheet that looks like a data table but whose header could not be read. */
type UnmatchedSheet = {
  labels: string[];
  missing: FieldKey[];
  /** The most header-like row found, 1-based, or null if nothing resembled one. */
  headerRowNumber: number | null;
};

function describeUnmatched(unmatched: Map<string, UnmatchedSheet>): string {
  return [...unmatched.entries()]
    .map(([sheet, { labels, missing }]) => {
      const shown = labels
        .map((label, i) => `      ${columnLetter(i + 1)}: ${label || '(blank)'}`)
        .join('\n');
      const lacking =
        missing.length > 0 ? missing.join(', ') : 'none resolved from any row';
      return `  [${sheet}] missing required column(s): ${lacking}\n${shown || '      (no labels)'}`;
    })
    .join('\n');
}

/**
 * A command the operator can actually run.
 *
 * A column override is only applied once the header row is known, so --map on
 * its own fails exactly as the run that produced this error did. The suggestion
 * therefore always carries --header-row, anchored on the most header-like row
 * found, and names a column for every required field that is missing.
 */
function suggestCommand(unmatched: Map<string, UnmatchedSheet>): string {
  const generic =
    'Run `npm run inspect` to view the raw rows, then pass --sheet, --header-row and/or --map.';

  const [sheet, entry] = [...unmatched.entries()].find(
    ([, candidate]) => candidate.headerRowNumber !== null && candidate.missing.length > 0,
  ) ?? [null, null];
  if (!sheet || !entry) return generic;

  // No column is guessed. The label did not match, and a caption stacked onto
  // every column ("provider level data") makes a substring guess land on the
  // wrong one — "region code" reads as a provider code. The letters are listed
  // above; the operator picks.
  const pairs = entry.missing.map((field) => `${field}=COLUMN`).join(',');

  return (
    'Run `npm run inspect` to view the raw rows. To load a sheet whose header ' +
    'cannot be read, give the header row and the column together:\n\n' +
    `  npm run load -- --sheet "${sheet}" --header-row ${entry.headerRowNumber} --map ${pairs}\n\n` +
    '--map on its own is not enough: a column override is only applied once the ' +
    'header row is known. Replace COLUMN with the letter from the list above.'
  );
}

export type SheetResult = {
  sheetName: string;
  headerRowNumber: number;
  labels: string[];
  columns: ColumnMap;
  rows: SnapshotRow[];
  skipped: { noProvider: number; noTreatmentFunction: number; aggregate: number };
  /** Fields that only resolved once the header row was read without its caption. */
  viaLeaf: FieldKey[];
  /** Fields whose column came from --map rather than from the header rules. */
  overridden: FieldKey[];
  sector: Sector;
};

export type ParseResult = {
  /** One entry per sheet read, in workbook order. */
  sheets: SheetResult[];
  /** Every sheet's rows, concatenated. */
  rows: SnapshotRow[];
  /** Sheets skipped because their total column measures something else. */
  skippedSheets: Array<{ sheetName: string; reason: string }>;
  /**
   * Provider + treatment function seen on more than one sheet. Provider codes
   * are disjoint across the sheets in practice; if that ever stops being true
   * one sheet would silently overwrite the other on upsert.
   */
  duplicates: Array<{ key: string; sheets: string[] }>;
};

/**
 * A percentage arrives either as 0-100 or as an Excel fraction (0.92 formatted
 * as 92%). Scale the fraction so the column always means percent.
 */
export function toPercent(value: string | undefined): number | null {
  const parsed = toNumber(value);
  if (parsed === null) return null;
  if (parsed >= 0 && parsed <= 1) return Number((parsed * 100).toFixed(2));
  return Number(parsed.toFixed(2));
}

/**
 * Rows for "Total" / "All specialties" pseudo-providers are aggregates, not
 * hospitals a patient can choose, so they never become snapshots.
 */
export function isAggregate(odsCode: string, treatmentFunctionCode: string): boolean {
  const code = odsCode.toUpperCase();
  const tfc = treatmentFunctionCode.toUpperCase();
  return (
    code === 'TOTAL' ||
    code === 'ALL' ||
    tfc === 'TOTAL' ||
    tfc === 'ALL' ||
    tfc === 'C_999' ||
    tfc === '999'
  );
}

export async function parseWorkbook(
  file: string,
  options: ParseOptions = {},
): Promise<ParseResult> {
  const scanRows = options.scanRows ?? DEFAULT_SCAN_ROWS;
  const wantedSheet = options.sheet ?? null;
  const overrides = options.overrides ?? noOverrides();
  const explicitHeaderRow = options.headerRow ?? null;

  const sheets: SheetResult[] = [];
  const skippedSheets: Array<{ sheetName: string; reason: string }> = [];
  const unmatched = new Map<string, UnmatchedSheet>();
  const seenSheetNames: string[] = [];

  await eachSheet(file, async (sheetName, sheetRows) => {
    seenSheetNames.push(sheetName);
    if (wantedSheet && sheetName !== wantedSheet) return 'continue';

    // Rows seen before the header is found, kept so headers split over merged
    // rows can be joined and so a failure can report every label it saw.
    const scanned: string[][] = [];
    const rows: SnapshotRow[] = [];
    const skipped = { noProvider: 0, noTreatmentFunction: 0, aggregate: 0 };

    let columns: ColumnMap | null = null;
    let labels: string[] = [];
    let headerRowNumber = 0;
    let viaLeaf: FieldKey[] = [];
    let sector: Sector = 'nhs';
    // --map entries that apply to this sheet: a scoped entry beats a global one.
    const sheetOverrides = overridesFor(overrides, sheetName);
    const overridden = Object.keys(sheetOverrides) as FieldKey[];
    // Whether each overridden column was ever seen holding a value. An override
    // onto an empty column yields nulls for every row, or skips every row when
    // the field is required, so it has to be caught rather than loaded.
    const sawValue = new Map(overridden.map((field) => [field, false]));
    // Widest row seen while scanning, which decides whether this sheet is a
    // data table at all. A cover, notes or guidance sheet never gets close.
    let widestRow = 0;

    /**
     * Records a sheet whose header could not be read, so the caller can refuse
     * the workbook. Sheets that are not data tables are left out: they are an
     * intentional exclusion, not a failure.
     */
    const recordFailedDetection = (): void => {
      if (widestRow < TABLE_MIN_COLUMNS) return;
      const best = detectBestEffortHeader(scanned);
      unmatched.set(sheetName, {
        labels: best ? best.labels : buildLabels(scanned, Math.max(scanned.length - 1, 0)),
        missing: REQUIRED_FIELDS.filter((field) => best?.columns[field] === undefined),
        headerRowNumber: best?.headerRowNumber ?? null,
      });
    };

    for await (const row of sheetRows) {
      if (!columns) {
        // `scanned` mirrors sheet rows 1..n, so index + 1 is the row number.
        while (scanned.length < row.number - 1) scanned.push([]);
        scanned.push(row.cells);
        widestRow = Math.max(widestRow, row.cells.filter((cell) => cell !== '').length);

        if (explicitHeaderRow !== null) {
          if (row.number < explicitHeaderRow) continue;
          labels = buildLabels(scanned, scanned.length - 1);
          const mapped = mapColumns(labels, buildLabels(scanned, scanned.length - 1, 0));
          columns = { ...mapped.columns, ...sheetOverrides };
          viaLeaf = mapped.viaLeaf;
          headerRowNumber = row.number;
        } else {
          const detected = detectHeader(scanned);
          if (detected) {
            labels = detected.labels;
            columns = { ...detected.columns, ...sheetOverrides };
            viaLeaf = detected.viaLeaf;
            headerRowNumber = detected.headerRowIndex + 1;
          } else if (scanned.length >= scanRows) {
            // Give up on this sheet, not on the workbook: a cover sheet has no
            // header at all, and the data sheets may come later. A sheet that
            // does look like a table is recorded, so it cannot be lost.
            recordFailedDetection();
            return 'continue';
          }
        }

        if (columns) {
          sector = labels.some((label) => INDEPENDENT_SECTOR.test(label)) ? 'independent' : 'nhs';
          // Read from the sheet's own labels, not from a column index: --map can
          // move patients_waiting, and a guard that followed it could be pointed
          // at a week band and silently disarmed, loading a DTA sheet alongside
          // the main one and double counting.
          const measureLabel = labels.find((label) => DIFFERENT_MEASURE.test(label));
          if (measureLabel !== undefined) {
            skippedSheets.push({ sheetName, reason: `a column reads "${measureLabel}"` });
            return 'continue';
          }
        }
        continue;
      }

      const cells = row.cells;
      for (const field of overridden) {
        if (sawValue.get(field)) continue;
        const index = sheetOverrides[field];
        if (index !== undefined && (cells[index - 1] ?? '') !== '') sawValue.set(field, true);
      }
      const odsCode = cells[(columns.provider_code ?? 0) - 1] ?? '';
      const treatmentFunctionCode = cells[(columns.treatment_function_code ?? 0) - 1] ?? '';

      if (odsCode === '') {
        skipped.noProvider += 1;
        continue;
      }
      if (treatmentFunctionCode === '') {
        skipped.noTreatmentFunction += 1;
        continue;
      }
      if (isAggregate(odsCode, treatmentFunctionCode)) {
        skipped.aggregate += 1;
        continue;
      }

      const pick = (field: FieldKey): string | undefined => {
        const index = columns?.[field];
        return index ? cells[index - 1] : undefined;
      };

      rows.push({
        odsCode: odsCode.toUpperCase(),
        providerName: pick('provider_name') || null,
        sector,
        treatmentFunctionCode,
        treatmentFunctionName: pick('treatment_function_name') || null,
        patientsWaiting: toInteger(pick('patients_waiting')),
        medianWaitWeeks: toNumber(pick('median_wait_weeks')),
        pctWithin18Weeks: toPercent(pick('pct_within_18_weeks')),
      });
    }

    if (!columns) {
      recordFailedDetection();
      return 'continue';
    }

    // An override that names a column which does not exist, carries no label, or
    // never holds a value is a mistake, not a mapping. Left alone it produces
    // nulls for every row, or skips every row when the field is required, and
    // exits 0 either way. Checked here, after the sheet is read, so nothing has
    // been written when it throws.
    const width = Math.max(labels.length, widestRow);
    for (const field of overridden) {
      const index = sheetOverrides[field]!;
      const where = `--map ${field}=${columnLetter(index)} on sheet "${sheetName}"`;
      if (index > width) {
        throw new Error(
          `${where} is out of range: that sheet has ${width} column(s), ` +
            `so its last is ${columnLetter(width)}.`,
        );
      }
      const label = labels[index - 1] ?? '';
      if (label === '') {
        throw new Error(
          `${where} points at a column with no header label. ` +
            'Check the letter against `npm run inspect`.',
        );
      }
      if (!sawValue.get(field)) {
        throw new Error(
          `${where} points at "${label}", which is empty on every data row of that sheet.`,
        );
      }
    }

    sheets.push({
      sheetName, headerRowNumber, labels, columns, rows, skipped, viaLeaf, overridden, sector,
    });
    return 'continue';
  });

  // A scoped override for a sheet that is not in the workbook does nothing at
  // all, which is the same silent no-op as a typo'd field name.
  for (const wanted of overrides.bySheet.keys()) {
    if (seenSheetNames.includes(wanted)) continue;
    throw new Error(
      `--map names sheet "${wanted}", which is not in this workbook.\n\nSheets found:\n` +
        seenSheetNames.map((name) => `  ${name}`).join('\n'),
    );
  }

  // A data sheet whose header cannot be read is a failure, never an omission.
  // Returning only the sheets that did parse would drop the independent-sector
  // sheet — most of the rows in a real release — with nothing said and a zero
  // exit code.
  if (unmatched.size > 0 || sheets.length === 0) {
    const names = [...unmatched.keys()].map((name) => `"${name}"`).join(', ');
    const opening =
      sheets.length === 0
        ? wantedSheet
          ? `Sheet "${wantedSheet}" had no recognisable header.`
          : `No sheet in ${file} had a recognisable header in its first ${scanRows} rows.`
        : `${unmatched.size} sheet(s) in ${file} hold a data table but had no recognisable ` +
          `header in their first ${scanRows} rows: ${names}. ` +
          `${sheets.length} other sheet(s) parsed; loading those alone would silently drop these.`;

    throw new Error(
      `${opening}\n\nLabels seen:\n${describeUnmatched(unmatched)}\n\n` +
        suggestCommand(unmatched),
    );
  }

  const seen = new Map<string, string[]>();
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      const key = `${row.odsCode}|${row.treatmentFunctionCode}`;
      const owners = seen.get(key);
      if (owners) {
        if (!owners.includes(sheet.sheetName)) owners.push(sheet.sheetName);
      } else seen.set(key, [sheet.sheetName]);
    }
  }
  const duplicates = [...seen.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([key, owners]) => ({ key, sheets: owners }));

  return {
    sheets,
    rows: sheets.flatMap((sheet) => sheet.rows),
    skippedSheets,
    duplicates,
  };
}
