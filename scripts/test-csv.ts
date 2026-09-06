/**
 * Checks the CSV reader against the shapes that silently corrupt a naive
 * split: quoted commas, doubled quotes, empty fields, CRLF.
 *
 *   npm run test:csv
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { csvRows, headerIndex } from '../lib/csv.ts';

const dir = await mkdtemp(path.join(tmpdir(), 'waitwise-csv-'));

async function parse(content: string): Promise<string[][]> {
  const file = path.join(dir, `case-${Math.random().toString(36).slice(2)}.csv`);
  await writeFile(file, content, 'utf8');
  const rows: string[][] = [];
  for await (const row of csvRows(file)) rows.push(row);
  return rows;
}

const checks: Array<[string, () => Promise<void>]> = [
  [
    'a quoted field containing a comma stays one field',
    async () => {
      // This is the real shape: an ICB name with a comma in it.
      const rows = await parse('a,"NHS BATH AND NORTH EAST SOMERSET, SWINDON AND WILTSHIRE ICB - 92G",c\n');
      assert.equal(rows[0].length, 3);
      assert.equal(rows[0][1], 'NHS BATH AND NORTH EAST SOMERSET, SWINDON AND WILTSHIRE ICB - 92G');
      assert.equal(rows[0][2], 'c');
    },
  ],
  [
    'a doubled quote inside a quoted field is one literal quote',
    async () => {
      const rows = await parse('a,"say ""hello"" now",c\n');
      assert.deepEqual(rows[0], ['a', 'say "hello" now', 'c']);
    },
  ],
  [
    'empty fields are preserved, including trailing ones',
    async () => {
      const rows = await parse('a,,c,\n');
      assert.deepEqual(rows[0], ['a', '', 'c', '']);
    },
  ],
  [
    'CRLF line endings do not leak into the last field',
    async () => {
      const rows = await parse('a,b\r\nc,d\r\n');
      assert.deepEqual(rows, [['a', 'b'], ['c', 'd']]);
    },
  ],
  [
    'a final row without a trailing newline is still yielded',
    async () => {
      const rows = await parse('a,b\nc,d');
      assert.deepEqual(rows, [['a', 'b'], ['c', 'd']]);
    },
  ],
  [
    'rows are split correctly across a chunk boundary',
    async () => {
      // Larger than the 1MB read buffer, so the parser has to carry state.
      const filler = 'x'.repeat(1024 * 1024);
      const rows = await parse(`a,"${filler}",c\nd,e,f\n`);
      assert.equal(rows.length, 2);
      assert.equal(rows[0][1].length, filler.length);
      assert.deepEqual(rows[1], ['d', 'e', 'f']);
    },
  ],
  [
    'headerIndex maps trimmed names to positions',
    async () => {
      const index = headerIndex([' Period ', 'Total All']);
      assert.equal(index.get('Period'), 0);
      assert.equal(index.get('Total All'), 1);
    },
  ],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    await check();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error instanceof Error ? error.message : error}`);
  }
}
await rm(dir, { recursive: true, force: true });
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exitCode = 1;
