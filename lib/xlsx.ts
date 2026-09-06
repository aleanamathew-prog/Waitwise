import type { CellValue } from 'exceljs';

/**
 * ExcelJS hands back a different shape per cell type (rich text, formula
 * results, hyperlinks, errors). Flatten all of them to a trimmed string.
 */
export function cellText(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  const object = value as unknown as Record<string, unknown>;
  if (Array.isArray(object.richText)) {
    return (object.richText as Array<{ text?: string }>)
      .map((run) => run.text ?? '')
      .join('')
      .trim();
  }
  if ('result' in object) return cellText(object.result as CellValue);
  if ('text' in object) return String(object.text ?? '').trim();
  if ('error' in object) return String(object.error);
  return String(value).trim();
}

/**
 * Numbers in these sheets arrive as numbers, as strings with thousands
 * separators, or as suppression markers ("-", "*", "n/a"). Anything that is
 * not a real number becomes null rather than 0, so suppressed values never
 * masquerade as "no wait".
 */
export function toNumber(value: CellValue | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = cellText(value);
  if (text === '') return null;
  const cleaned = text.replace(/,/g, '').replace(/%$/, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toInteger(value: CellValue | undefined): number | null {
  const parsed = toNumber(value);
  return parsed === null ? null : Math.round(parsed);
}

/** Lowercases, strips punctuation and collapses whitespace for header matching. */
export function normaliseHeader(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9% ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function columnLetter(index: number): string {
  let n = index;
  let letters = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}
