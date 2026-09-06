import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export type Args = Record<string, string | boolean | undefined>;

/** Minimal `--flag`, `--flag value` and `--flag=value` parser. */
export function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals !== -1) {
      args[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[body] = next;
      i += 1;
    } else {
      args[body] = true;
    }
  }
  return args;
}

export const DATA_DIR = 'data';

/**
 * Resolves the workbook to read: an explicit --file, or the only .xlsx in
 * ./data. Refuses to pick for you when there is more than one.
 */
export async function resolveInputFile(given: string | boolean | undefined): Promise<string> {
  if (typeof given === 'string') {
    await stat(given);
    return given;
  }

  let entries: string[];
  try {
    entries = await readdir(DATA_DIR);
  } catch {
    throw new Error(`No ./${DATA_DIR} directory. Create it and drop the NHS England XLSX in.`);
  }

  const workbooks = entries
    .filter((name) => name.toLowerCase().endsWith('.xlsx') && !name.startsWith('~$'))
    .sort();

  if (workbooks.length === 0) {
    throw new Error(
      `No .xlsx files in ./${DATA_DIR}. Download an "Incomplete Provider" workbook from\n` +
        'https://www.england.nhs.uk/statistics/statistical-work-areas/rtt-waiting-times/ and put it there.',
    );
  }
  if (workbooks.length > 1) {
    throw new Error(
      `Several workbooks in ./${DATA_DIR}; pass --file to choose one:\n` +
        workbooks.map((name) => `  --file ${path.join(DATA_DIR, name)}`).join('\n'),
    );
  }
  return path.join(DATA_DIR, workbooks[0]);
}

const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

function lastDayOfMonth(year: number, monthIndex: number): string {
  const date = new Date(Date.UTC(year, monthIndex + 1, 0));
  return date.toISOString().slice(0, 10);
}

export type PeriodResolution = { periodEnd: string; source: 'flag' | 'filename' };

/**
 * The reporting month is the one thing the workbook body does not carry, so it
 * comes from --period=YYYY-MM-DD or, failing that, from the filename NHS
 * England publishes ("...-Incomplete-Provider-Jun25-XLSX-..."). Whatever it
 * resolves to is printed, never applied silently.
 */
export function resolvePeriodEnd(
  flag: string | boolean | undefined,
  file: string,
): PeriodResolution {
  if (typeof flag === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(flag)) {
      throw new Error(`--period must be YYYY-MM-DD, got "${flag}"`);
    }
    return { periodEnd: flag, source: 'flag' };
  }

  const name = path.basename(file);

  const isoMatch = name.match(/(20\d{2})[-_]?(0[1-9]|1[0-2])(?!\d)/);
  if (isoMatch) {
    return {
      periodEnd: lastDayOfMonth(Number(isoMatch[1]), Number(isoMatch[2]) - 1),
      source: 'filename',
    };
  }

  const monthMatch = name
    .toLowerCase()
    .match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_ ]?(\d{2}|20\d{2})/);
  if (monthMatch) {
    const monthIndex = MONTHS.indexOf(monthMatch[1]);
    const rawYear = Number(monthMatch[2]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    return { periodEnd: lastDayOfMonth(year, monthIndex), source: 'filename' };
  }

  throw new Error(
    `Could not work out the reporting month from "${name}".\n` +
      'Pass it explicitly, e.g. --period 2025-06-30 (use the last day of the month).',
  );
}
