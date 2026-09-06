/**
 * End-to-end check: build a workbook shaped like the NHS release (cover sheet,
 * title rows, merged two-row header, thousands separators, suppressed values,
 * a total row), parse it, load it into an in-process Postgres, and assert what
 * landed in the tables.
 *
 *   npm run test:load
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { parseWorkbook } from '../lib/parse-workbook.ts';
import { upsertSnapshots } from '../lib/ingest.ts';
import { writeSampleWorkbook } from './fixtures/make-sample-xlsx.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'db', 'migrations');

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'waitwise-'));
  const file = path.join(dir, 'Incomplete-Provider-Jun26-XLSX-1234K.xlsx');

  try {
    await writeSampleWorkbook(file);

    const result = await parseWorkbook(file);

    const sheetNames = result.sheets.map((sheet) => sheet.sheetName);
    assert.deepEqual(sheetNames, ['Provider', 'IS Provider'], 'cover sheet skipped, both provider sheets read');
    assert.deepEqual(
      result.skippedSheets.map((sheet) => sheet.sheetName),
      ['Provider with DTA'],
      'the decision-to-admit sheet measures something else and must not be loaded',
    );
    assert.deepEqual(result.duplicates, [], 'no provider appears on two sheets');

    const nhs = result.sheets[0];
    assert.equal(nhs.headerRowNumber, 6);
    assert.equal(nhs.columns.provider_code, 3);
    assert.equal(
      nhs.columns.treatment_function_name,
      6,
      'column F is headed just "Treatment Function", under a "Provider Level Data" caption',
    );
    assert.equal(nhs.columns.patients_waiting, 10);
    assert.equal(nhs.skipped.aggregate, 1, 'the Total row should not become a snapshot');
    assert.equal(nhs.rows.length, 4);

    const is = result.sheets[1];
    assert.equal(is.columns.treatment_function_name, 4, 'merged two-row header still resolves');
    assert.equal(is.skipped.aggregate, 1);
    assert.equal(is.rows.length, 2);

    assert.equal(result.rows.length, 6, 'both provider sheets are loaded together');
    assert.equal(
      result.rows.filter((row) => row.treatmentFunctionName === null).length,
      0,
      'every row carries a treatment function name',
    );

    const named = result.rows.find((row) => row.odsCode === 'R0A');
    assert.equal(named?.treatmentFunctionName, 'Trauma and Orthopaedic Service');

    const suppressed = result.rows.find((row) => row.odsCode === 'RGT');
    assert.equal(suppressed?.medianWaitWeeks, null, 'a "-" must not become 0');
    assert.equal(suppressed?.patientsWaiting, 412);

    const withThousands = result.rows.find((row) => row.odsCode === 'R0A');
    assert.equal(withThousands?.patientsWaiting, 12431, '"12,431" should parse');
    assert.equal(withThousands?.pctWithin18Weeks, 61.2, '0.612 should scale to percent');

    const independent = result.rows.find((row) => row.odsCode === 'Z9Z1G');
    assert.equal(independent?.patientsWaiting, 318, 'independent sector rows are loaded');

    const db = new PGlite();
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const migration of files) {
      await db.exec(await readFile(path.join(migrationsDir, migration), 'utf8'));
    }

    await upsertSnapshots(db, result.rows, '2026-06-30', 'test');
    // A second pass over the same file must not duplicate anything.
    await upsertSnapshots(db, result.rows, '2026-06-30', 'test');

    const counts = await db.query<{ providers: number; snapshots: number }>(
      `SELECT (SELECT count(*) FROM providers)::int AS providers,
              (SELECT count(*) FROM wait_snapshots)::int AS snapshots`,
    );
    assert.equal(counts.rows[0].providers, 5);
    assert.equal(counts.rows[0].snapshots, 6);

    // The query the app will actually run: shortest median wait for a specialty.
    const ranked = await db.query<{ ods_code: string; median_wait_weeks: string }>(
      `SELECT ods_code, median_wait_weeks
         FROM wait_snapshots
        WHERE treatment_function_code = $1 AND period_end = $2
          AND median_wait_weeks IS NOT NULL
        ORDER BY median_wait_weeks ASC`,
      ['C_110', '2026-06-30'],
    );
    assert.deepEqual(
      ranked.rows.map((row) => row.ods_code),
      ['RJ1', 'R0A'],
    );

    await db.close();
    console.log('  ok  workbook parses, loads, re-loads idempotently and ranks');
    console.log('\n1/1 passed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
