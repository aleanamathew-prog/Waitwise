/**
 * Checks the tie grouping, which is the one piece of ranking judgement in the
 * app. Pure function, no database.
 *
 *   npm run test:search
 */
import assert from 'node:assert/strict';
import { groupByTie, displaySpecialty, TIE_TOLERANCE_WEEKS } from '../lib/search.ts';
import type { ProviderWait } from '../lib/search.ts';

function provider(
  odsCode: string,
  medianWaitWeeks: number | null,
  patientsWaiting = 100,
): ProviderWait {
  return {
    odsCode,
    name: odsCode,
    sector: 'nhs',
    postcode: 'LS1 4AP',
    distanceMiles: 5,
    medianWaitWeeks,
    pctWithin18Weeks: patientsWaiting === 0 ? 0 : 80,
    patientsWaiting,
    periodEnd: '2026-06-30',
  };
}

const codes = (group: { rows: ProviderWait[] }) => group.rows.map((row) => row.odsCode);

const checks: Array<[string, () => void]> = [
  [
    'providers within the tolerance are one group',
    () => {
      const groups = groupByTie([provider('A', 6), provider('B', 7.5), provider('C', 8)]);
      assert.equal(groups.length, 1);
      assert.deepEqual(codes(groups[0]), ['A', 'B', 'C']);
    },
  ],
  [
    'a gap wider than the tolerance starts a new group',
    () => {
      const groups = groupByTie([provider('A', 6), provider('B', 7), provider('C', 14)]);
      assert.equal(groups.length, 2);
      assert.deepEqual(codes(groups[0]), ['A', 'B']);
      assert.deepEqual(codes(groups[1]), ['C']);
    },
  ],
  [
    'exactly the tolerance apart still ties',
    () => {
      assert.equal(groupByTie([provider('A', 6), provider('B', 9)]).length, 1);
      assert.equal(groupByTie([provider('A', 6), provider('B', 9.01)]).length, 2);
    },
  ],
  [
    'the default tolerance is three weeks',
    () => {
      assert.equal(TIE_TOLERANCE_WEEKS, 3);
      // The real case that prompted it: three singleton bands at 2 weeks.
      const groups = groupByTie([provider('A', 10.3), provider('B', 12.7), provider('C', 14.8)]);
      assert.deepEqual(codes(groups[0]), ['A', 'B'], '10.3 and 12.7 are within three weeks');
      assert.deepEqual(codes(groups[1]), ['C']);
    },
  ],
  [
    'small gaps do not chain into one giant group',
    () => {
      // Every step is under the tolerance, but 4 and 16 weeks are not equivalent.
      const rows = [
        provider('A', 4), provider('B', 5.5), provider('C', 7),
        provider('D', 8.5), provider('E', 10), provider('F', 16),
      ];
      const groups = groupByTie(rows, 2);
      assert.deepEqual(codes(groups[0]), ['A', 'B'], 'anchor is the group leader, not the previous row');
      assert.ok(groups.length >= 3, `expected several groups, got ${groups.length}`);
      assert.deepEqual(codes(groups[groups.length - 1]), ['F']);

      // Widening the tolerance widens the bands but never merges everything.
      const wider = groupByTie(rows, 3);
      assert.deepEqual(codes(wider[0]), ['A', 'B', 'C']);
      assert.ok(wider.length > 1, 'a chain of small gaps must not collapse into one band');
    },
  ],
  [
    'unsorted input is still grouped from the shortest wait',
    () => {
      const groups = groupByTie([provider('C', 20), provider('A', 4), provider('B', 5)]);
      assert.deepEqual(codes(groups[0]), ['A', 'B']);
      assert.deepEqual(codes(groups[1]), ['C']);
    },
  ],
  [
    'providers with no median go to trailing groups, never dropped',
    () => {
      const groups = groupByTie([
        provider('A', 6),
        provider('B', null, 11),
        provider('C', null, 0),
      ]);
      assert.deepEqual(groups.map((group) => group.kind), ['ranked', 'suppressed', 'no-queue']);
      assert.deepEqual(codes(groups[1]), ['B']);
      assert.deepEqual(codes(groups[2]), ['C']);
      assert.equal(
        groups.flatMap((group) => group.rows).length,
        3,
        'every provider appears exactly once',
      );
    },
  ],
  [
    'an empty queue is not the same as a suppressed median',
    () => {
      // Both have no median, but one has patients waiting and one has none.
      const groups = groupByTie([provider('WAITING', null, 4), provider('EMPTY', null, 0)]);
      assert.deepEqual(groups.map((group) => group.kind), ['suppressed', 'no-queue']);
    },
  ],
  [
    'suppressed rows lead with the busiest provider',
    () => {
      const groups = groupByTie([provider('A', null, 2), provider('B', null, 19)]);
      assert.deepEqual(codes(groups[0]), ['B', 'A']);
    },
  ],
  [
    'only empty queues yields just that group',
    () => {
      const groups = groupByTie([provider('A', null, 0)]);
      assert.deepEqual(groups.map((group) => group.kind), ['no-queue']);
    },
  ],
  [
    'no providers yields no groups',
    () => assert.deepEqual(groupByTie([]), []),
  ],
  [
    'specialty names drop the trailing "Service"',
    () => {
      assert.equal(displaySpecialty('Ophthalmology Service'), 'Ophthalmology');
      assert.equal(displaySpecialty('Other - Medical Services'), 'Other - Medical');
      assert.equal(displaySpecialty('Cardiology'), 'Cardiology');
    },
  ],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    check();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error instanceof Error ? error.message : error}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exitCode = 1;

// --- the all-months activity filter, against a real Postgres --------------

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { findProviders, ACTIVITY_WINDOW_MONTHS, MAX_MONTHS_BEHIND } from '../lib/search.ts';
import { upsertSnapshots } from '../lib/ingest.ts';

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'db',
  'migrations',
);

const LEEDS = { lat: 53.7997, lng: -1.5492 };

function snapshot(odsCode: string, patientsWaiting: number, median: number | null) {
  return {
    odsCode,
    providerName: odsCode,
    sector: 'nhs' as const,
    treatmentFunctionCode: 'C_320',
    treatmentFunctionName: 'Cardiology Service',
    patientsWaiting,
    medianWaitWeeks: median,
    pctWithin18Weeks: patientsWaiting === 0 ? 0 : 90,
    ingestedAt: undefined,
  };
}

const db = new PGlite();
for (const file of (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(await readFile(path.join(migrationsDir, file), 'utf8'));
}

// BUSY has patients in both months. CLEARED had patients in May and none in
// June. NEVER has zeros in both, which is how the workbook records a hospital
// that does not offer the specialty at all.
// Eight monthly periods, newest last. BUSY has patients throughout. CLEARED
// had patients last month and none now. NEVER is all zeros, which is how the
// workbook records a hospital that does not offer the specialty. LAPSED had
// patients only in the oldest month, outside a six-month window.
const MONTHS = [
  '2025-11-30', '2025-12-31', '2026-01-31', '2026-02-28',
  '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30',
];
for (const [index, period] of MONTHS.entries()) {
  const newest = index === MONTHS.length - 1;
  await upsertSnapshots(
    db,
    [
      snapshot('BUSY', 500 - index, 9),
      snapshot('CLEARED', newest ? 0 : 40, newest ? null : 6),
      snapshot('NEVER', 0, null),
      snapshot('LAPSED', index === 0 ? 25 : 0, index === 0 ? 5 : null),
      // Stops reporting after the fifth month, with a short wait frozen in.
      ...(index <= 4 ? [snapshot('STALE', 30, 2)] : []),
    ],
    period,
    'test',
  );
}
for (const code of ['BUSY', 'CLEARED', 'NEVER', 'LAPSED', 'STALE']) {
  await db.query('UPDATE providers SET lat = $2, lng = $3 WHERE ods_code = $1', [code, LEEDS.lat, LEEDS.lng]);
}

const dbChecks: Array<[string, () => Promise<void>]> = [
  [
    'a provider with zero in every loaded month is dropped',
    async () => {
      const found = await findProviders(LEEDS.lat, LEEDS.lng, 'C_320', 25, db);
      assert.ok(!found.some((row) => row.odsCode === 'NEVER'), 'NEVER should not appear');
    },
  ],
  [
    'a provider that cleared its queue is kept',
    async () => {
      const found = await findProviders(LEEDS.lat, LEEDS.lng, 'C_320', 25, db);
      const cleared = found.find((row) => row.odsCode === 'CLEARED');
      assert.ok(cleared, 'CLEARED should still appear');
      assert.equal(cleared?.patientsWaiting, 0, 'showing its latest month, which is zero');
      assert.equal(cleared?.periodEnd, MONTHS[MONTHS.length - 1]);
    },
  ],
  [
    'each provider is shown at its most recent month',
    async () => {
      const found = await findProviders(LEEDS.lat, LEEDS.lng, 'C_320', 25, db);
      const busy = found.find((row) => row.odsCode === 'BUSY');
      assert.equal(busy?.patientsWaiting, 500 - (MONTHS.length - 1), 'the newest month, not an older one');
      assert.equal(busy?.periodEnd, MONTHS[MONTHS.length - 1]);
    },
  ],
  [
    'a provider whose last patient predates the window is dropped',
    async () => {
      const found = await findProviders(LEEDS.lat, LEEDS.lng, 'C_320', 25, db);
      assert.ok(!found.some((row) => row.odsCode === 'LAPSED'), 'LAPSED is outside a six-month window');
    },
  ],
  [
    'widening the window readmits it, so the window is what decides',
    async () => {
      const wide = await findProviders(LEEDS.lat, LEEDS.lng, 'C_320', 25, db, 12);
      assert.ok(wide.some((row) => row.odsCode === 'LAPSED'), 'a 12-month window should keep LAPSED');
      const narrow = await findProviders(LEEDS.lat, LEEDS.lng, 'C_320', 25, db, 2);
      assert.ok(!narrow.some((row) => row.odsCode === 'LAPSED'));
      assert.ok(narrow.some((row) => row.odsCode === 'CLEARED'), 'CLEARED survives even a 2-month window');
    },
  ],
  [
    'the window is a named constant, not a literal in the SQL',
    async () => {
      assert.equal(ACTIVITY_WINDOW_MONTHS, 6);
      const byDefault = await findProviders(LEEDS.lat, LEEDS.lng, 'C_320', 25, db);
      const explicit = await findProviders(LEEDS.lat, LEEDS.lng, 'C_320', 25, db, ACTIVITY_WINDOW_MONTHS);
      assert.deepEqual(byDefault.map((r) => r.odsCode), explicit.map((r) => r.odsCode));
    },
  ],
  [
    'a provider that stopped reporting is excluded, however good its last figure',
    async () => {
      const found = await findProviders(LEEDS.lat, LEEDS.lng, 'C_320', 25, db);
      assert.ok(
        !found.some((row) => row.odsCode === 'STALE'),
        'a 2-week wait frozen three months ago would otherwise rank first',
      );
      // It is the freshness rule doing this, not the activity window: STALE had
      // patients well inside the window.
      const wide = await findProviders(LEEDS.lat, LEEDS.lng, 'C_320', 25, db, 12);
      assert.ok(!wide.some((row) => row.odsCode === 'STALE'), 'a wider activity window must not readmit it');
    },
  ],
  [
    'one month of lag is tolerated, so a late submission is not dropped',
    async () => {
      assert.equal(MAX_MONTHS_BEHIND, 1);
      // CLEARED reports in the newest month; BUSY too. Allowing three months
      // behind is the only thing that brings STALE back.
      const lenient = await findProviders(LEEDS.lat, LEEDS.lng, 'C_320', 25, db, ACTIVITY_WINDOW_MONTHS, 3);
      assert.ok(lenient.some((row) => row.odsCode === 'STALE'));
      const strict = await findProviders(LEEDS.lat, LEEDS.lng, 'C_320', 25, db, ACTIVITY_WINDOW_MONTHS, 0);
      assert.ok(strict.some((row) => row.odsCode === 'BUSY'), 'the newest month always survives');
      assert.ok(!strict.some((row) => row.odsCode === 'STALE'));
    },
  ],
  [
    'every row returned carries the same recent vintage',
    async () => {
      const found = await findProviders(LEEDS.lat, LEEDS.lng, 'C_320', 25, db);
      const cutoff = MONTHS[MONTHS.length - 1 - MAX_MONTHS_BEHIND];
      for (const row of found) {
        assert.ok(row.periodEnd >= cutoff, `${row.odsCode} shows ${row.periodEnd}, older than ${cutoff}`);
      }
    },
  ],
  [
    'the radius still excludes distant providers',
    async () => {
      const found = await findProviders(50.7, -3.5, 'C_320', 25, db);
      assert.equal(found.length, 0);
    },
  ],
];

let dbFailed = 0;
for (const [name, check] of dbChecks) {
  try {
    await check();
    console.log(`  ok  ${name}`);
  } catch (error) {
    dbFailed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error instanceof Error ? error.message : error}`);
  }
}
await db.close();

console.log(`\n${dbChecks.length - dbFailed}/${dbChecks.length} database checks passed`);
if (failed + dbFailed > 0) process.exitCode = 1;
