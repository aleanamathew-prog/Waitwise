import { Pool } from 'pg';
import type { PoolClient } from 'pg';

let pool: Pool | undefined;

/**
 * How long to wait for a connection before giving up. pg's default is to wait
 * forever, which on a serverless host means the request hangs until the
 * platform kills the function — a timeout with no useful log, rather than an
 * error naming the database.
 */
const CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Checks the connection string is one, and says what it found if not.
 *
 * A value with anything before the scheme — a `DATABASE_URL=` prefix, wrapping
 * quotes, a `psql '...'` wrapper — parses without complaint and resolves to a
 * host named `base`, taken from the middle of the word "database". That
 * surfaces much later as `getaddrinfo ENOTFOUND base`, which names neither the
 * variable nor the mistake. Fail here instead, while we can still explain it.
 *
 * The value holds a password, so the message describes it rather than
 * quoting it.
 */
export function assertConnectionString(value: string): void {
  if (/^postgres(ql)?:\/\//.test(value)) return;

  // Most specific explanation first: the generic scheme check would otherwise
  // swallow `DATABASE_URL=postgresql://...`, whose leading text is the point.
  // No branch echoes the value itself — it may be, or contain, the password.
  const quoted = /^["']/.test(value);
  const assignment = value.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  const scheme = value.match(/^[^:\s'"]{1,40}:\/\//)?.[0];

  const found = quoted
    ? 'it is wrapped in quotes'
    : assignment
      ? `the variable name was included: it starts with "${assignment[1]}="`
      : scheme
        ? `it starts with "${scheme}"`
        : value.includes('://')
          ? 'there is text before the scheme'
          : 'it has no scheme at all';

  throw new Error(
    `DATABASE_URL must be a postgres:// or postgresql:// URL, but ${found}. ` +
      'Set it to the connection string alone, with no variable name, quotes or ' +
      'surrounding command.',
  );
}

/**
 * Lazily created connection pool. Reused across hot reloads in dev so we don't
 * leak a pool per module evaluation.
 */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. Copy .env.example to .env and fill it in.',
      );
    }
    assertConnectionString(connectionString);

    pool = new Pool({
      connectionString,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      // Only for a host that requires TLS but presents a certificate the driver
      // cannot verify. A connection string carrying sslmode is already handled
      // by the driver, and setting this alongside it would disable verification.
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
