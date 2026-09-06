/**
 * Prints the raw opening rows of an NHS England XLSX so the real layout can be
 * confirmed before any parsing rules are written. It assumes nothing about
 * which sheet holds the data, where the header rows are, or how many there are.
 *
 *   npm run inspect                          # first .xlsx found in ./data
 *   npm run inspect -- --file data/foo.xlsx  # a specific file
 *   npm run inspect -- --rows 25             # more rows
 *   npm run inspect -- --merges              # also list merged ranges
 *
 * A merged block carries its value only in its top-left cell, so a merged
 * header shows as one value followed by columns that are simply absent from the
 * row. --merges prints the ranges that produced those gaps.
 */
import { columnLetter } from '../lib/xlsx.ts';
import { parseArgs, resolveInputFile } from '../lib/cli.ts';
import { eachSheet, readMerges } from '../lib/workbook.ts';

const DEFAULT_ROWS = 15;

function firstRowOf(range: string): number {
  return Number(range.split(':')[0].replace(/[^0-9]/g, ''));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const file = await resolveInputFile(args.file);
  const rowLimit = Number(args.rows ?? DEFAULT_ROWS);

  console.log(`file: ${file}`);
  console.log(`showing the first ${rowLimit} row(s) of every sheet, unparsed\n`);

  await eachSheet(file, async (name, rows) => {
    console.log(`=== sheet: ${name} ===`);
    let printed = 0;
    for await (const row of rows) {
      if (printed >= rowLimit) break;
      const cells = row.cells
        .map((text, i) => (text === '' ? null : `${columnLetter(i + 1)}=${JSON.stringify(text)}`))
        .filter((entry): entry is string => entry !== null);
      console.log(
        cells.length === 0
          ? `  row ${String(row.number).padStart(3)} | (empty)`
          : `  row ${String(row.number).padStart(3)} | ${cells.join('  ')}`,
      );
      printed += 1;
    }
    if (printed === 0) console.log('  (no rows)');
    console.log('');
    return 'continue';
  });

  if (args.merges) {
    console.log('merged ranges in the rows above:');
    for (const [sheet, ranges] of await readMerges(file)) {
      const inRange = ranges.filter((range) => firstRowOf(range) <= rowLimit);
      console.log(`  [${sheet}] ${inRange.length > 0 ? inRange.join(', ') : 'none'}`);
    }
    console.log('');
  }

  console.log('Next: confirm which sheet and which row holds the column headers,');
  console.log('then run `npm run load -- --dry-run` to see the mapping the loader derives.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
