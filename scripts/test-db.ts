/**
 * Checks the connection-string guard. A malformed DATABASE_URL is otherwise
 * accepted silently and fails much later as `getaddrinfo ENOTFOUND base`.
 *
 *   npm run test:db
 */
import assert from 'node:assert/strict';
import { assertConnectionString } from '../lib/db.ts';

function rejects(value: string, expected: RegExp): void {
  assert.throws(() => assertConnectionString(value), expected);
  // The value carries a password; the message must describe it, not quote it.
  try {
    assertConnectionString(value);
  } catch (error) {
    assert.ok(
      !(error as Error).message.includes('hunter2'),
      'the password must never appear in the error',
    );
  }
}

const URL_WITH_SECRET = 'postgresql://neondb_owner:hunter2@ep-x.eu-west-2.aws.neon.tech/neondb?sslmode=require';

const checks: Array<[string, () => void]> = [
  [
    'accepts both accepted schemes',
    () => {
      assertConnectionString(URL_WITH_SECRET);
      assertConnectionString('postgres://user@localhost:5432/waitwise');
    },
  ],
  [
    'rejects the variable name being included in the value',
    () => {
      // The real Vercel failure: the whole .env line pasted into the value box.
      rejects(`DATABASE_URL=${URL_WITH_SECRET}`, /variable name was included/);
    },
  ],
  [
    'rejects a value wrapped in quotes',
    () => {
      rejects(`"${URL_WITH_SECRET}"`, /wrapped in quotes/);
      rejects(`'${URL_WITH_SECRET}'`, /wrapped in quotes/);
    },
  ],
  [
    'rejects a pasted psql command',
    () => rejects(`psql '${URL_WITH_SECRET}'`, /must be a postgres/),
  ],
  [
    'rejects another database entirely',
    () => rejects('mysql://user:hunter2@localhost/db', /starts with "mysql:\/\/"/),
  ],
  [
    'rejects a value that is not a URL at all',
    () => rejects('hunter2', /must be a postgres/),
  ],
  [
    'names DATABASE_URL so the reader knows which variable to fix',
    () => {
      assert.throws(() => assertConnectionString('nonsense'), /^Error: DATABASE_URL/);
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
