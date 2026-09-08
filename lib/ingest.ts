/**
 * The write half of the loader, kept separate from the CLI so the schema tests
 * exercise exactly the SQL that production ingestion runs.
 */
export type Sector = 'nhs' | 'independent';

export type SnapshotRow = {
  odsCode: string;
  providerName: string | null;
  /** Which sheet of the workbook the provider was published on. */
  sector: Sector;
  treatmentFunctionCode: string;
  treatmentFunctionName: string | null;
  patientsWaiting: number | null;
  medianWaitWeeks: number | null;
  pctWithin18Weeks: number | null;
};

/** Anything with a parameterised `query` — a pg client, or PGlite in tests. */
export type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
};

const BATCH_SIZE = 500;
const COLUMNS_PER_ROW = 9;

export async function upsertProviders(
  client: Queryable,
  rows: SnapshotRow[],
): Promise<number> {
  const providers = new Map<string, { name: string; sector: Sector }>();
  for (const row of rows) {
    if (!providers.has(row.odsCode)) {
      providers.set(row.odsCode, { name: row.providerName ?? row.odsCode, sector: row.sector });
    }
  }

  // The RTT workbook carries only code and name. Address, postcode and
  // coordinates come from a separate ODS load, so they are left untouched here
  // rather than being overwritten with nulls.
  for (const [odsCode, { name, sector }] of providers) {
    await client.query(
      `INSERT INTO providers (ods_code, name, sector)
       VALUES ($1, $2, $3)
       ON CONFLICT (ods_code) DO UPDATE
         SET name = EXCLUDED.name, sector = EXCLUDED.sector, updated_at = now()`,
      [odsCode, name, sector],
    );
  }
  return providers.size;
}

/**
 * Upserts on (ods_code, treatment_function_code, period_end, source), so
 * re-running a load — or loading a revised release of the same month — replaces
 * the previous figures instead of duplicating them.
 */
export async function upsertSnapshots(
  client: Queryable,
  rows: SnapshotRow[],
  periodEnd: string,
  source: string,
): Promise<number> {
  await upsertProviders(client, rows);

  const ingestedAt = new Date();
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const values: unknown[] = [];
    const tuples = batch.map((row, i) => {
      const base = i * COLUMNS_PER_ROW;
      values.push(
        row.odsCode,
        row.treatmentFunctionCode,
        row.treatmentFunctionName,
        row.patientsWaiting,
        row.medianWaitWeeks,
        row.pctWithin18Weeks,
        periodEnd,
        source,
        ingestedAt,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
    });

    await client.query(
      `INSERT INTO wait_snapshots (
         ods_code, treatment_function_code, treatment_function_name,
         patients_waiting, median_wait_weeks, pct_within_18_weeks,
         period_end, source, ingested_at
       ) VALUES ${tuples.join(', ')}
       ON CONFLICT ON CONSTRAINT wait_snapshots_natural_key DO UPDATE SET
         treatment_function_name = EXCLUDED.treatment_function_name,
         patients_waiting        = EXCLUDED.patients_waiting,
         median_wait_weeks       = EXCLUDED.median_wait_weeks,
         pct_within_18_weeks     = EXCLUDED.pct_within_18_weeks,
         ingested_at             = EXCLUDED.ingested_at`,
      values,
    );
  }
  return rows.length;
}
