import { getPool } from './db.ts';
import { SPECIALTY_HINTS, isResidualCategory } from './specialties.ts';

/** Anything with a parameterised `query` — a pg pool, or PGlite in tests. */
export type Queryable = {
  query: <R>(text: string, values?: unknown[]) => Promise<{ rows: R[] }>;
};

export type Specialty = { code: string; name: string; hint: string | null; residual: boolean };

export type ProviderWait = {
  odsCode: string;
  name: string;
  sector: 'nhs' | 'independent' | null;
  postcode: string | null;
  distanceMiles: number;
  medianWaitWeeks: number | null;
  pctWithin18Weeks: number | null;
  patientsWaiting: number | null;
  periodEnd: string;
};

/**
 * How many recent months decide whether a provider still offers a treatment.
 *
 * The workbook publishes a complete provider x specialty grid, so absence has
 * to be inferred from a run of zeros. Sensitivity on the loaded data: the kept
 * count is flat from a 2-month window through a 9-month one, and only grows at
 * 10+, where it starts readmitting services that saw a single patient over a
 * year ago. Six sits in the middle of that flat region — long enough to survive
 * a seasonal gap, short enough to exclude a service that has quietly stopped.
 *
 * Only the filter uses the window. Every loaded month stays in the table for
 * trend and history.
 */
export const ACTIVITY_WINDOW_MONTHS = 6;

/**
 * How far behind the newest loaded month a provider's figures may be and still
 * be shown.
 *
 * A wait frozen in the past does not grow, so a stale row ranks better than a
 * current one and lands at the top of the list — the bias points at exactly the
 * wrong answer. RTT submission is monthly and mandatory, so a provider missing
 * from the newest month has stopped reporting, and there is no current figure
 * to compare it against.
 *
 * One month of tolerance rather than zero, because a late submission is the one
 * legitimate reason to be behind.
 */
export const MAX_MONTHS_BEHIND = 1;

/** Radii offered in the form, in miles. */
export const RADII = [25, 50, 100] as const;
export type Radius = (typeof RADII)[number];

/**
 * Two providers whose medians are this close are not ranked against each other.
 * Three weeks, not two: at two, real data produced singleton bands at 10.3,
 * 12.7 and 14.8 weeks, which ranks trusts that are not meaningfully different.
 */
export const TIE_TOLERANCE_WEEKS = 3;

const EARTH_RADIUS_MILES = 3959;

/** The reporting months held, newest first. */
export async function listPeriods(): Promise<string[]> {
  const { rows } = await getPool().query<{ period_end: string }>(
    `SELECT to_char(period_end, 'YYYY-MM-DD') AS period_end
       FROM wait_snapshots GROUP BY period_end ORDER BY period_end DESC`,
  );
  return rows.map((row) => row.period_end);
}

/** Only the specialties that actually appear in the loaded data. */
export async function listSpecialties(): Promise<Specialty[]> {
  const { rows } = await getPool().query<{ code: string; name: string | null }>(
    `SELECT treatment_function_code AS code,
            max(treatment_function_name) AS name
       FROM wait_snapshots
      GROUP BY treatment_function_code
      ORDER BY max(treatment_function_name) NULLS LAST, treatment_function_code`,
  );
  return rows.map((row) => ({
    code: row.code,
    name: displaySpecialty(row.name ?? row.code),
    hint: SPECIALTY_HINTS[row.code] ?? null,
    residual: isResidualCategory(row.code),
  }));
}

/** "Ophthalmology Service" is how the return names it; patients just say the specialty. */
export function displaySpecialty(name: string): string {
  return name.replace(/\s+Services?$/i, '').trim() || name;
}

export async function findProviders(
  lat: number,
  lng: number,
  specialtyCode: string,
  radiusMiles: number,
  client: Queryable = getPool() as unknown as Queryable,
  windowMonths: number = ACTIVITY_WINDOW_MONTHS,
  maxMonthsBehind: number = MAX_MONTHS_BEHIND,
): Promise<ProviderWait[]> {
  // One row per provider: the most recent period loaded for this specialty.
  const { rows } = await client.query<{
    ods_code: string;
    name: string;
    sector: 'nhs' | 'independent' | null;
    postcode: string | null;
    distance_miles: string;
    median_wait_weeks: string | null;
    pct_within_18_weeks: string | null;
    patients_waiting: number | null;
    period_end: string;
  }>(
    `WITH fresh_start AS (
       -- The oldest month whose figures are still current enough to show.
       SELECT min(period_end) AS from_period
         FROM (SELECT DISTINCT period_end FROM wait_snapshots
                ORDER BY period_end DESC LIMIT $7) recent
     ),
     window_start AS (
       -- The oldest month inside the activity window, taken from the periods
       -- actually loaded so a missing month does not silently widen it.
       SELECT min(period_end) AS from_period
         FROM (SELECT DISTINCT period_end FROM wait_snapshots
                ORDER BY period_end DESC LIMIT $6) recent
     ),
     activity AS (
       -- NHS England publishes a complete provider x specialty grid, so a
       -- hospital that does not offer a specialty still gets a row of zeros.
       -- A provider with no patient waiting for this treatment anywhere in the
       -- window does not offer it, and is dropped. One that had patients inside
       -- the window but none now has simply cleared its queue, which is worth
       -- showing.
       SELECT ods_code, max(coalesce(patients_waiting, 0)) AS peak
         FROM wait_snapshots, window_start
        WHERE treatment_function_code = $3
          AND period_end >= window_start.from_period
        GROUP BY ods_code
     ),
     latest AS (
       SELECT DISTINCT ON (ods_code)
              ods_code, patients_waiting, median_wait_weeks, pct_within_18_weeks,
              to_char(period_end, 'YYYY-MM-DD') AS period_end
         FROM wait_snapshots
        WHERE treatment_function_code = $3
        ORDER BY ods_code, period_end DESC
     ),
     current_latest AS (
       -- Drop providers whose most recent figures for this specialty predate
       -- the freshness cut-off. They have stopped reporting, and their frozen
       -- wait would otherwise rank above hospitals publishing current numbers.
       SELECT l.* FROM latest l, fresh_start
        WHERE l.period_end >= to_char(fresh_start.from_period, 'YYYY-MM-DD')
     ),
     located AS (
       SELECT p.ods_code, p.name, p.sector, p.postcode, l.patients_waiting, l.median_wait_weeks,
              l.pct_within_18_weeks, l.period_end,
              $5 * acos(greatest(-1, least(1,
                cos(radians($1)) * cos(radians(p.lat)) * cos(radians(p.lng) - radians($2))
                + sin(radians($1)) * sin(radians(p.lat))
              ))) AS distance_miles
         FROM current_latest l
         JOIN providers p USING (ods_code)
         JOIN activity a USING (ods_code)
        WHERE p.lat IS NOT NULL AND p.lng IS NOT NULL
          AND a.peak > 0
     )
     SELECT * FROM located
      WHERE distance_miles <= $4
      ORDER BY median_wait_weeks ASC NULLS LAST, patients_waiting DESC NULLS LAST, distance_miles ASC`,
    [lat, lng, specialtyCode, radiusMiles, EARTH_RADIUS_MILES, windowMonths, maxMonthsBehind + 1],
  );

  return rows.map((row) => ({
    odsCode: row.ods_code,
    name: row.name,
    sector: row.sector,
    postcode: row.postcode,
    distanceMiles: Number(row.distance_miles),
    medianWaitWeeks: row.median_wait_weeks === null ? null : Number(row.median_wait_weeks),
    pctWithin18Weeks: row.pct_within_18_weeks === null ? null : Number(row.pct_within_18_weeks),
    patientsWaiting: row.patients_waiting,
    periodEnd: row.period_end,
  }));
}

export type TieGroup =
  | { kind: 'ranked'; rows: ProviderWait[]; minWeeks: number; maxWeeks: number }
  /** Patients are waiting, but too few for a median to be published. */
  | { kind: 'suppressed'; rows: ProviderWait[] }
  /** The hospital treats this specialty but has nobody waiting right now. */
  | { kind: 'no-queue'; rows: ProviderWait[] };

/**
 * Groups providers whose waits are too close to separate honestly.
 *
 * Walking down the sorted list, the shortest ungrouped wait anchors a group and
 * takes everyone within `toleranceWeeks` of *it*. Chaining off each successive
 * member instead would let a long run of small gaps swallow the whole list, so
 * a 6-week and a 20-week wait could end up presented as equivalent.
 *
 * Providers with no median are not ranked at all, and they are not all the same
 * case: some have nobody waiting, others have a handful of patients and a median
 * NHS England suppressed. Those mean different things to a patient, so they get
 * separate trailing groups rather than one bucket labelled "not reported".
 */
export function groupByTie(
  providers: ProviderWait[],
  toleranceWeeks: number = TIE_TOLERANCE_WEEKS,
): TieGroup[] {
  const ranked = providers
    .filter((provider): provider is ProviderWait & { medianWaitWeeks: number } => provider.medianWaitWeeks !== null)
    .sort((a, b) => a.medianWaitWeeks - b.medianWaitWeeks);
  const noMedian = providers.filter((provider) => provider.medianWaitWeeks === null);
  const suppressed = noMedian.filter((provider) => (provider.patientsWaiting ?? 0) > 0);
  const noQueue = noMedian.filter((provider) => (provider.patientsWaiting ?? 0) === 0);

  const groups: TieGroup[] = [];
  let index = 0;
  while (index < ranked.length) {
    const anchor = ranked[index].medianWaitWeeks;
    const rows: ProviderWait[] = [];
    while (index < ranked.length && ranked[index].medianWaitWeeks - anchor <= toleranceWeeks) {
      rows.push(ranked[index]);
      index += 1;
    }
    groups.push({
      kind: 'ranked',
      rows,
      minWeeks: anchor,
      maxWeeks: rows[rows.length - 1].medianWaitWeeks as number,
    });
  }

  if (suppressed.length > 0) {
    groups.push({
      kind: 'suppressed',
      rows: [...suppressed].sort((a, b) => (b.patientsWaiting ?? 0) - (a.patientsWaiting ?? 0)),
    });
  }
  if (noQueue.length > 0) {
    groups.push({
      kind: 'no-queue',
      rows: [...noQueue].sort((a, b) => a.distanceMiles - b.distanceMiles),
    });
  }
  return groups;
}
