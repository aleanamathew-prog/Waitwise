import { Pool } from 'pg';
import type { PoolClient } from 'pg';

let pool: Pool | undefined;

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
    pool = new Pool({
      connectionString,
      // Hosted Postgres (Neon, Supabase, RDS) needs TLS; a local server usually
      // does not offer it. Opt in explicitly rather than guessing per host.
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
