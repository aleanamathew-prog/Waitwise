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
import { REQUIRED_FIELDS, buildLabels, detectHeader, mapColumns } from './rtt-headers.ts';
import type { ColumnMap, FieldKey } from './rtt-headers.ts';
import type { SnapshotRow, Sector } from './ingest.ts';

export { REQUIRED_FIELDS };

export type ParseOptions = {
  /** Read only this sheet. Default: every sheet whose header maps. */
  sheet?: string | null;
  headerRow?: number | null;
  scanRows?: number;
  overrides?: ColumnMap;
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

export type SheetResult = {
  sheetName: string;
  headerRowNumber: number;
  labels: string[];
  columns: ColumnMap;
  rows: SnapshotRow[];
  skipped: { noProvider: number; noTreatmentFunction: number; aggregate: number };
  /** Fields that only resolved once the header row was read without its caption. */
  viaLeaf: FieldKey[];
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
  const overrides = options.overrides ?? {};
  const explicitHeaderRow = options.headerRow ?? null;

  const sheets: SheetResult[] = [];
  const skippedSheets: Array<{ sheetName: string; reason: string }> = [];
  const unmatched = new Map<string, string[]>();

  await eachSheet(file, async (sheetName, sheetRows) => {
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

    for await (const row of sheetRows) {
      if (!columns) {
        // `scanned` mirrors sheet rows 1..n, so index + 1 is the row number.
        while (scanned.length < row.number - 1) scanned.push([]);
        scanned.push(row.cells);

        if (explicitHeaderRow !== null) {
          if (row.number < explicitHeaderRow) continue;
          labels = buildLabels(scanned, scanned.length - 1);
          const mapped = mapColumns(labels, buildLabels(scanned, scanned.length - 1, 0));
          columns = { ...mapped.columns, ...overrides };
          viaLeaf = mapped.viaLeaf;
          headerRowNumber = row.number;
        } else {
          const detected = detectHeader(scanned);
          if (detected) {
            labels = detected.labels;
            columns = { ...detected.columns, ...overrides };
            viaLeaf = detected.viaLeaf;
            headerRowNumber = detected.headerRowIndex + 1;
          } else if (scanned.length >= scanRows) {
            // Give up on this sheet, not on the workbook: a cover sheet has no
            // header at all, and the data sheets may come later.
            return 'continue';
          }
        }

        if (columns) {
          sector = labels.some((label) => INDEPENDENT_SECTOR.test(label)) ? 'independent' : 'nhs';
          const totalLabel = labels[(columns.patients_waiting ?? 0) - 1] ?? '';
          if (DIFFERENT_MEASURE.test(totalLabel)) {
            skippedSheets.push({ sheetName, reason: `total column is "${totalLabel}"` });
            return 'continue';
          }
        }
        continue;
      }

      const cells = row.cells;
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
      unmatched.set(sheetName, buildLabels(scanned, Math.max(scanned.length - 1, 0)));
      return 'continue';
    }

    sheets.push({ sheetName, headerRowNumber, labels, columns, rows, skipped, viaLeaf, sector });
    return 'continue';
  });

  if (sheets.length === 0) {
    const report = [...unmatched.entries()]
      .map(([sheet, sheetLabels]) => {
        const shown = sheetLabels
          .map((label, i) => `      ${columnLetter(i + 1)}: ${label || '(blank)'}`)
          .join('\n');
        return `  [${sheet}]\n${shown || '      (no labels)'}`;
      })
      .join('\n');

    throw new Error(
      (wantedSheet
        ? `Sheet "${wantedSheet}" had no recognisable header.`
        : `No sheet in ${file} had a recognisable header in its first ${scanRows} rows.`) +
        `\n\nLabels seen:\n${report}\n\n` +
        'Run `npm run inspect` to view the raw rows, then pass --sheet, --header-row and/or --map.',
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
