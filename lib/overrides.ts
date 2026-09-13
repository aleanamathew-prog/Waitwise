/**
 * Parsing for --map, the loader's column-override escape hatch.
 *
 * An override deliberately bypasses the pattern and exclude rules in
 * rtt-headers.ts: when a release changes shape, the operator reading the labels
 * knows more than the regex does. What it must not do is fail quietly, so every
 * way of mis-stating one is rejected — here where the string alone shows it,
 * and in parse-workbook.ts where judging it needs the workbook.
 */
import { FIELD_KEYS } from './rtt-headers.ts';
import type { ColumnMap, FieldKey } from './rtt-headers.ts';

export type ColumnOverrides = {
  /** Applied to every sheet. */
  global: ColumnMap;
  /** Applied to one sheet by name, beating any global entry for that field. */
  bySheet: Map<string, ColumnMap>;
};

export function noOverrides(): ColumnOverrides {
  return { global: {}, bySheet: new Map() };
}

export function hasOverrides(overrides: ColumnOverrides): boolean {
  return Object.keys(overrides.global).length > 0 || overrides.bySheet.size > 0;
}

/** The columns to apply to one sheet: a scoped entry beats a global one. */
export function overridesFor(overrides: ColumnOverrides, sheetName: string): ColumnMap {
  return { ...overrides.global, ...(overrides.bySheet.get(sheetName) ?? {}) };
}

function parseColumn(value: string, pair: string): number {
  const index = /^\d+$/.test(value)
    ? Number(value)
    : value
        .toUpperCase()
        .split('')
        .reduce((acc, char) => acc * 26 + (char.charCodeAt(0) - 64), 0);
  if (!/^\d+$/.test(value) && !/^[A-Za-z]+$/.test(value)) {
    throw new Error(`Bad column "${value}" in --map entry "${pair}"`);
  }
  if (!Number.isFinite(index) || index < 1) throw new Error(`Bad column "${value}" in --map`);
  return index;
}

/**
 * Parses `--map [<sheet>:]<field>=<column>`, comma-separated.
 *
 *   --map patients_waiting=DH
 *   --map "IS Provider:patients_waiting=H,Provider:patients_waiting=J"
 *
 * The sheet name is split off at the last colon, so it is the field name that
 * has to be colon-free, not the sheet name.
 */
export function parseOverrides(raw: string | boolean | undefined): ColumnOverrides {
  const overrides = noOverrides();
  if (typeof raw !== 'string') return overrides;

  for (const pair of raw.split(',')) {
    if (pair.trim() === '') continue;
    const equals = pair.indexOf('=');
    if (equals === -1) throw new Error(`Bad --map entry "${pair}", expected field=column`);
    const left = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (!left || !value) throw new Error(`Bad --map entry "${pair}", expected field=column`);

    const colon = left.lastIndexOf(':');
    const sheetName = colon === -1 ? null : left.slice(0, colon).trim();
    const field = (colon === -1 ? left : left.slice(colon + 1)).trim();

    if (!FIELD_KEYS.includes(field as FieldKey)) {
      throw new Error(
        `--map does not know the field "${field}". Valid fields are:\n` +
          FIELD_KEYS.map((key) => `  ${key}`).join('\n') +
          '\n\nTo scope an override to one sheet, write --map "<sheet>:<field>=<column>".',
      );
    }
    if (sheetName === '') {
      throw new Error(`Bad --map entry "${pair}": the sheet name before ":" is empty.`);
    }

    const index = parseColumn(value, pair);
    if (sheetName === null) {
      overrides.global[field as FieldKey] = index;
    } else {
      const forSheet = overrides.bySheet.get(sheetName) ?? {};
      forSheet[field as FieldKey] = index;
      overrides.bySheet.set(sheetName, forSheet);
    }
  }
  return overrides;
}
