import { normaliseHeader } from './xlsx.ts';

export type FieldKey =
  | 'provider_code'
  | 'provider_name'
  | 'treatment_function_code'
  | 'treatment_function_name'
  | 'patients_waiting'
  | 'median_wait_weeks'
  | 'pct_within_18_weeks';

/** Column index per field, 1-based to match ExcelJS. */
export type ColumnMap = Partial<Record<FieldKey, number>>;

export type MappedColumns = {
  columns: ColumnMap;
  /**
   * Fields that the stacked labels could not resolve at all, and which only
   * exist because the header row was also read on its own. This is the honest
   * measure of whether the fallback was load-bearing for a release — a field
   * that merely matched a different pattern is not counted.
   */
  viaLeaf: FieldKey[];
};

export const REQUIRED_FIELDS: FieldKey[] = [
  'provider_code',
  'treatment_function_code',
  'patients_waiting',
];

type FieldRule = {
  key: FieldKey;
  /** Tried in order; the first pattern that matches a column wins. */
  patterns: RegExp[];
  /** A column matching any of these is never used for this field. */
  exclude?: RegExp[];
};

/**
 * Matched against a normalised label built from the header row plus the rows
 * merged above it, so "Provider" / "Code" stacked in two rows reads as
 * "provider code". Ordered most specific first.
 */
const FIELD_RULES: FieldRule[] = [
  {
    key: 'provider_code',
    patterns: [
      /^provider (org(anisation)? )?code$/,
      /provider (org(anisation)? )?code/,
      /^org(anisation)? code$/,
    ],
    exclude: [/parent/, /commissioner/, /region/],
  },
  {
    key: 'provider_name',
    patterns: [
      /^provider (org(anisation)? )?name$/,
      /provider (org(anisation)? )?name/,
      /^org(anisation)? name$/,
    ],
    exclude: [/parent/, /commissioner/, /region/],
  },
  {
    key: 'treatment_function_code',
    patterns: [/treatment function code/, /^tfc$/, /^tfc code$/, /specialty code/],
  },
  {
    key: 'treatment_function_name',
    patterns: [/treatment function name/, /^treatment function$/, /specialty name/],
    exclude: [/code/],
  },
  {
    key: 'patients_waiting',
    patterns: [
      /total (number of )?(incomplete )?pathways/,
      /total number waiting/,
      /^total$/,
      /^total all$/,
      /grand total/,
    ],
    exclude: [/within 18/, /%/, /over/, /gt /, /unknown/, /52/, /65/, /78/, /104/],
  },
  {
    key: 'median_wait_weeks',
    patterns: [
      /average median waiting time/,
      /median waiting time/,
      /^median$/,
      /median wait/,
    ],
  },
  {
    key: 'pct_within_18_weeks',
    patterns: [
      /% within 18 weeks/,
      /percentage within 18 weeks/,
      /within 18 weeks %/,
      /% *(of )?patients within 18/,
    ],
  },
];

/**
 * Copies a value rightwards into the blank cells that follow it. A merged
 * header block only carries a value in its top-left cell, so this restores the
 * label for every column the block spans. Rows with a single value (a sheet
 * title, a footnote) are left alone so they cannot smear across the sheet.
 */
function forwardFill(row: string[]): string[] {
  const nonEmpty = row.filter((cell) => cell !== '').length;
  if (nonEmpty < 2) return row;
  const filled = [...row];
  let last = '';
  for (let i = 0; i < filled.length; i += 1) {
    if (filled[i] !== '') last = filled[i];
    else filled[i] = last;
  }
  return filled;
}

/**
 * Builds one label per column by stacking the candidate row with up to
 * `depth` rows above it, so multi-row headers read as a single string.
 */
export function buildLabels(rows: string[][], rowIndex: number, depth = 2): string[] {
  const start = Math.max(0, rowIndex - depth);
  // Only the rows above carry merged group labels worth spreading; a blank in
  // the header row itself is genuinely blank.
  const slice = rows
    .slice(start, rowIndex + 1)
    .map((row, i, all) => (i === all.length - 1 ? row : forwardFill(row)));
  const width = Math.max(...slice.map((row) => row.length), 0);

  const labels: string[] = [];
  for (let col = 0; col < width; col += 1) {
    const parts: string[] = [];
    for (const row of slice) {
      const text = normaliseHeader(row[col] ?? '');
      if (text !== '' && !parts.includes(text)) parts.push(text);
    }
    labels.push(parts.join(' ').trim());
  }
  return labels;
}

/**
 * Maps fields to 1-based column indexes.
 *
 * `labels` are the stacked labels, which resolve headers genuinely split over
 * several merged rows. `leafLabels` are the header row on its own. Both are
 * tried, because a caption sitting above the table ("Provider Level Data") gets
 * stacked onto every column beneath it and can stop an anchored pattern
 * matching — column F reads `Treatment Function` on its own but
 * `provider level data treatment function` once stacked.
 */
export function mapColumns(labels: string[], leafLabels: string[] = []): MappedColumns {
  const withLeaf = resolve(labels, leafLabels);
  if (leafLabels.length === 0) return { columns: withLeaf, viaLeaf: [] };

  // What the stacked labels alone could do, so the report can say which fields
  // genuinely depended on reading the header row without its caption.
  const stackedOnly = resolve(labels, []);
  const viaLeaf = (Object.keys(withLeaf) as FieldKey[]).filter(
    (field) => stackedOnly[field] === undefined,
  );
  return { columns: withLeaf, viaLeaf };
}

function resolve(labels: string[], leafLabels: string[]): ColumnMap {
  const map: ColumnMap = {};
  const taken = new Set<number>();

  const find = (source: string[], pattern: RegExp, rule: FieldRule): number =>
    source.findIndex(
      (label, i) =>
        label !== '' &&
        !taken.has(i) &&
        pattern.test(label) &&
        !(rule.exclude ?? []).some((bad) => bad.test(label)),
    );

  for (const rule of FIELD_RULES) {
    let found = -1;
    for (const pattern of rule.patterns) {
      found = find(labels, pattern, rule);
      if (found === -1) found = find(leafLabels, pattern, rule);
      if (found !== -1) break;
    }
    if (found !== -1) {
      map[rule.key] = found + 1;
      taken.add(found);
    }
  }
  return map;
}

export type HeaderDetection = {
  headerRowIndex: number;
  headerRowNumber: number;
  /** Header row stacked with the merged rows above it. */
  labels: string[];
  /** The header row on its own. */
  leafLabels: string[];
  columns: ColumnMap;
  viaLeaf: FieldKey[];
  matchedFields: number;
};

/**
 * Finds the header row by trying every row in the scanned window and keeping
 * the one that resolves the most fields. Nothing about the row position or the
 * number of header rows is assumed.
 */
export function detectHeader(rows: string[][]): HeaderDetection | null {
  let best: HeaderDetection | null = null;

  for (let i = 0; i < rows.length; i += 1) {
    const labels = buildLabels(rows, i);
    const leafLabels = buildLabels(rows, i, 0);
    const { columns, viaLeaf } = mapColumns(labels, leafLabels);
    const matchedFields = Object.keys(columns).length;
    const hasRequired = REQUIRED_FIELDS.every((field) => columns[field] !== undefined);
    if (!hasRequired) continue;
    if (!best || matchedFields > best.matchedFields) {
      best = {
        headerRowIndex: i,
        headerRowNumber: i + 1,
        labels,
        leafLabels,
        columns,
        viaLeaf,
        matchedFields,
      };
    }
  }
  return best;
}
