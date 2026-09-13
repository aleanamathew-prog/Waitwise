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
import { parseOverrides } from '../lib/overrides.ts';
import { upsertSnapshots } from '../lib/ingest.ts';
import { writeSampleWorkbook, writeRenamedRequiredColumnWorkbook } from './fixtures/make-sample-xlsx.ts';

/**
 * Runs a workbook through the parser with --map applied exactly as the CLI
 * would, and returns whatever it threw. The four ways of mis-stating an
 * override all have to surface as an error, not as empty or wrong data.
 */
async function overrideFailure(map: string, extra: Parameters<typeof parseWorkbook>[1] = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'waitwise-map-'));
  const file = path.join(dir, 'Incomplete-Provider-Jun26-XLSX-1234K.xlsx');
  try {
    await writeSampleWorkbook(file);
    try {
      const result = await parseWorkbook(file, { ...extra, overrides: parseOverrides(map) });
      return { thrown: null as Error | null, result };
    } catch (error) {
      return { thrown: error as Error, result: null };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'db', 'migrations');

/**
 * A data sheet whose header cannot be read is a failure, not an omission.
 * Returning the sheets that did parse would drop the independent-sector sheet —
 * the majority of the rows in a real release — with exit code 0.
 *
 * `dataRows` and `scanRows` choose which way the scan gives up; both exits are
 * exercised below, because each was a separate hole.
 */
async function assertFailedDetectionThrows(
  dataRows: number,
  scanRows: number,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'waitwise-renamed-'));
  const file = path.join(dir, 'Incomplete-Provider-Jun26-XLSX-1234K.xlsx');
  try {
    await writeRenamedRequiredColumnWorkbook(file, dataRows);

    let thrown: Error | null = null;
    let parsed: Awaited<ReturnType<typeof parseWorkbook>> | null = null;
    try {
      parsed = await parseWorkbook(file, { scanRows });
    } catch (error) {
      thrown = error as Error;
    }

    assert.ok(
      thrown,
      'a sheet that fails header detection must throw, not be dropped; ' +
        `instead it returned ${parsed?.sheets.length} sheet(s) and ${parsed?.rows.length} row(s)`,
    );
    assert.match(thrown.message, /IS Provider/, 'the error must name the sheet that failed');
    assert.match(
      thrown.message,
      /provider_code/,
      'the error must say which required column could not be found',
    );
    // The same per-column-letter dump the all-sheets-failed path produces.
    assert.match(thrown.message, /\bC: /, 'the error must list labels by column letter');
    assert.match(
      thrown.message,
      /organisation identifier/i,
      'including the label actually published in place of the expected one',
    );
    // The header sits on row 6. A suggestion has to pair --map with
    // --header-row: an override is only applied once the header row is known,
    // so recommending --map on its own sends the operator to a command that
    // fails exactly as the one they just ran did. The column itself is left as
    // a placeholder rather than guessed — the labels are printed above it.
    assert.match(
      thrown.message,
      /--header-row 6 --map provider_code=/,
      'the error must pair --map with the --header-row that makes it work',
    );
    assert.match(
      thrown.message,
      /--map on its own is not enough/,
      'and must say why --map alone will not do',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The failing sheet holds its header on row 6 and one data row, so the row
 * stream ends at row 7 — well inside a 30-row scan window. Detection gives up
 * because the sheet ran out of rows without a candidate.
 */
async function checkNoCandidateThrows(): Promise<void> {
  await assertFailedDetectionThrows(1, 30);
}

/**
 * The failing sheet holds 60 data rows below its header, so the scan window is
 * exhausted long before the rows are — the branch a real release takes, where
 * every data sheet runs to thousands of rows. A 10-row window makes that
 * certain rather than incidental.
 */
async function checkScanExhaustedThrows(): Promise<void> {
  await assertFailedDetectionThrows(60, 10);
}

async function checkSampleWorkbook(): Promise<void> {
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

    assert.equal(nhs.sector, 'nhs');

    const is = result.sheets[1];
    assert.equal(is.sector, 'independent', 'the sheet captions itself Independent Sector');
    assert.ok(
      result.rows.filter((row) => row.sector === 'independent').length === is.rows.length,
      'every row from that sheet carries the sector',
    );
    assert.ok(
      result.rows.some((row) => row.sector === 'nhs'),
      'and rows from the trust sheet do not',
    );
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
    const sectors = await db.query<{ sector: string; n: number }>(
      'SELECT sector, count(*)::int AS n FROM providers GROUP BY sector ORDER BY sector',
    );
    assert.deepEqual(
      sectors.rows,
      [{ sector: 'independent', n: 2 }, { sector: 'nhs', n: 3 }],
      'the sector reaches the providers table',
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A typo'd field name must not be accepted and then quietly do nothing. */
async function checkUnknownFieldThrows(): Promise<void> {
  assert.throws(
    () => parseOverrides('provider_cde=C'),
    (error: Error) => {
      assert.match(error.message, /provider_cde/, 'names the field that was not recognised');
      assert.match(error.message, /provider_code/, 'lists the valid fields');
      assert.match(error.message, /pct_within_18_weeks/, 'lists all of them, not a sample');
      return true;
    },
  );
}

/**
 * Column A is blank on the caption-style sheets: the headers start at B. An
 * override pointing there used to skip every row and still exit 0.
 */
async function checkBlankColumnThrows(): Promise<void> {
  const { thrown, result } = await overrideFailure('provider_code=A');
  assert.ok(thrown, `a blank target column must throw; got ${result?.rows.length} row(s)`);
  assert.match(thrown.message, /Provider/, 'names the sheet');
  assert.match(thrown.message, /provider_code/, 'names the field');
  assert.match(thrown.message, /\bA\b/, 'names the column letter');
}

/** Past the last column of the sheet: previously nulls for every row. */
async function checkOutOfRangeColumnThrows(): Promise<void> {
  const { thrown, result } = await overrideFailure('median_wait_weeks=ZZ');
  assert.ok(thrown, `an out-of-range column must throw; got ${result?.rows.length} row(s)`);
  assert.match(thrown.message, /Provider/, 'names the sheet');
  assert.match(thrown.message, /median_wait_weeks/, 'names the field');
  assert.match(thrown.message, /\bZZ\b/, 'names the column letter');
}

/** A scoped override for a sheet that is not in the workbook. */
async function checkUnknownSheetThrows(): Promise<void> {
  const { thrown } = await overrideFailure('IS Providers:patients_waiting=H');
  assert.ok(thrown, 'a scoped override naming an absent sheet must throw');
  assert.match(thrown.message, /IS Providers/, 'names the sheet that was asked for');
  assert.match(thrown.message, /IS Provider\b/, 'lists the sheets the workbook does hold');
}

/**
 * The two sheets publish patients_waiting at different columns — J on Provider,
 * H on IS Provider — so one global override is wrong for both. A scoped
 * override must reach its own sheet and no other.
 */
async function checkScopedOverrideDoesNotLeak(): Promise<void> {
  // K is deliberately NOT the detected column (J=10), so this fails if the
  // override is ignored as well as if it leaks. IS Provider must keep its own
  // detected H=8, which K=11 does not even exist as on that 10-column sheet.
  const { thrown, result } = await overrideFailure('Provider:patients_waiting=K');
  assert.equal(thrown, null, `scoped overrides should parse cleanly: ${thrown?.message}`);
  const provider = result!.sheets.find((sheet) => sheet.sheetName === 'Provider')!;
  const independent = result!.sheets.find((sheet) => sheet.sheetName === 'IS Provider')!;
  assert.equal(provider.columns.patients_waiting, 11, 'Provider takes the override, column K');
  assert.equal(independent.columns.patients_waiting, 8, 'IS Provider keeps its detected column H');
}

/** The unscoped form keeps applying everywhere, as it always has. */
async function checkGlobalOverrideStillApplies(): Promise<void> {
  const { thrown, result } = await overrideFailure('treatment_function_code=E');
  assert.equal(thrown, null, `a global override should parse cleanly: ${thrown?.message}`);
  for (const sheet of result!.sheets) {
    assert.equal(
      sheet.columns.treatment_function_code,
      5,
      `${sheet.sheetName} should take the global override`,
    );
  }
}

/**
 * The double-count guard must not be reachable from --map. Overriding
 * patients_waiting used to relocate the label the guard inspects.
 */
async function checkDtaGuardSurvivesOverride(): Promise<void> {
  // G is a week band, whose label says nothing about a decision to admit. A
  // guard that reads only the overridden column would therefore not fire, and
  // the DTA sheet would load alongside the main one and double count.
  const { thrown, result } = await overrideFailure('Provider with DTA:patients_waiting=G');
  assert.equal(thrown, null, `expected a clean parse, got: ${thrown?.message}`);
  assert.deepEqual(
    result!.skippedSheets.map((sheet) => sheet.sheetName),
    ['Provider with DTA'],
    'the decision-to-admit sheet must still be skipped when its total column is overridden',
  );
}

const checks: Array<[string, () => Promise<void>]> = [
  ['workbook parses, loads, re-loads idempotently and ranks', checkSampleWorkbook],
  ['a short sheet with no header candidate throws instead of being dropped', checkNoCandidateThrows],
  ['a long sheet that exhausts the scan window throws instead of being dropped', checkScanExhaustedThrows],
  ['--map with an unknown field name throws, listing the valid fields', checkUnknownFieldThrows],
  ['--map onto a blank column throws instead of skipping every row', checkBlankColumnThrows],
  ['--map onto an out-of-range column throws instead of loading nulls', checkOutOfRangeColumnThrows],
  ['--map naming a sheet not in the workbook throws', checkUnknownSheetThrows],
  ['a sheet-scoped --map does not leak to the other sheet', checkScopedOverrideDoesNotLeak],
  ['an unscoped --map still applies to every sheet', checkGlobalOverrideStillApplies],
  ['the decision-to-admit guard survives an override of its total column', checkDtaGuardSurvivesOverride],
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
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exitCode = 1;
