/**
 * Applies the migrations to an in-process Postgres (PGlite) and checks the
 * constraints the loader depends on. No server or DATABASE_URL needed.
 *
 *   npm run test:schema
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { upsertSnapshots } from '../lib/ingest.ts';
import type { SnapshotRow } from '../lib/ingest.ts';

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'db',
  'migrations',
);

const PERIOD = '2025-06-30';
const SOURCE = 'nhs-england-rtt-incomplete-provider';

function snapshot(overrides: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    odsCode: 'R0A',
    providerName: 'Manchester University NHS FT',
    treatmentFunctionCode: 'C_110',
    treatmentFunctionName: 'Trauma & Orthopaedics',
    patientsWaiting: 12431,
    medianWaitWeeks: 14.2,
    pctWithin18Weeks: 61.2,
    ...overrides,
  };
}

const checks: Array<[string, (db: PGlite) => Promise<void>]> = [
  [
    'inserts providers and snapshots',
    async (db) => {
      await upsertSnapshots(db, [snapshot(), snapshot({ treatmentFunctionCode: 'C_120' })], PERIOD, SOURCE);
      const providers = await db.query<{ count: string | number }>('SELECT count(*) FROM providers');
      const snapshots = await db.query<{ count: string | number }>('SELECT count(*) FROM wait_snapshots');
      assert.equal(Number(providers.rows[0].count), 1);
      assert.equal(Number(snapshots.rows[0].count), 2);
    },
  ],
  [
    're-running a load updates in place rather than duplicating',
    async (db) => {
      await upsertSnapshots(db, [snapshot()], PERIOD, SOURCE);
      await upsertSnapshots(db, [snapshot({ patientsWaiting: 999, medianWaitWeeks: 3.5 })], PERIOD, SOURCE);
      const result = await db.query<{ patients_waiting: number; median_wait_weeks: string }>(
        'SELECT patients_waiting, median_wait_weeks FROM wait_snapshots',
      );
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].patients_waiting, 999);
      assert.equal(Number(result.rows[0].median_wait_weeks), 3.5);
    },
  ],
  [
    'the same month from a different source is a separate row',
    async (db) => {
      await upsertSnapshots(db, [snapshot()], PERIOD, SOURCE);
      await upsertSnapshots(db, [snapshot()], PERIOD, 'manual-correction');
      const result = await db.query<{ count: string | number }>('SELECT count(*) FROM wait_snapshots');
      assert.equal(Number(result.rows[0].count), 2);
    },
  ],
  [
    'a different month is a separate row',
    async (db) => {
      await upsertSnapshots(db, [snapshot()], PERIOD, SOURCE);
      await upsertSnapshots(db, [snapshot()], '2025-07-31', SOURCE);
      const result = await db.query<{ count: string | number }>('SELECT count(*) FROM wait_snapshots');
      assert.equal(Number(result.rows[0].count), 2);
    },
  ],
  [
    'suppressed values stay null instead of becoming zero',
    async (db) => {
      await upsertSnapshots(
        db,
        [snapshot({ medianWaitWeeks: null, pctWithin18Weeks: null })],
        PERIOD,
        SOURCE,
      );
      const result = await db.query<{ median_wait_weeks: string | null }>(
        'SELECT median_wait_weeks, pct_within_18_weeks FROM wait_snapshots',
      );
      assert.equal(result.rows[0].median_wait_weeks, null);
    },
  ],
  [
    'a snapshot cannot reference an unknown provider',
    async (db) => {
      await assert.rejects(
        () =>
          db.query(
            `INSERT INTO wait_snapshots (ods_code, treatment_function_code, period_end, source)
             VALUES ('NOPE', 'C_110', $1, $2)`,
            [PERIOD, SOURCE],
          ),
        /foreign key/i,
      );
    },
  ],
  [
    'deleting a provider removes its snapshots',
    async (db) => {
      await upsertSnapshots(db, [snapshot()], PERIOD, SOURCE);
      await db.query("DELETE FROM providers WHERE ods_code = 'R0A'");
      const result = await db.query<{ count: string | number }>('SELECT count(*) FROM wait_snapshots');
      assert.equal(Number(result.rows[0].count), 0);
    },
  ],
];

async function freshDatabase(sql: string[]): Promise<PGlite> {
  const db = new PGlite();
  for (const statement of sql) await db.exec(statement);
  return db;
}

async function main(): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const sql = await Promise.all(
    files.map((file) => readFile(path.join(migrationsDir, file), 'utf8')),
  );

  let failed = 0;
  for (const [name, check] of checks) {
    const db = await freshDatabase(sql);
    try {
      await check(db);
      console.log(`  ok  ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${name}`);
      console.error(`       ${error instanceof Error ? error.message : error}`);
    } finally {
      await db.close();
    }
  }

  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
