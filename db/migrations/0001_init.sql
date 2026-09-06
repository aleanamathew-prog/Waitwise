-- WaitWise data layer: providers and RTT waiting-time snapshots.

CREATE TABLE IF NOT EXISTS providers (
  ods_code   TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  address    TEXT,
  postcode   TEXT,
  lat        DOUBLE PRECISION,
  lng        DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Geo lookups ("hospitals near me") scan providers by coordinate; a plain
-- btree on the pair is enough until we need PostGIS.
CREATE INDEX IF NOT EXISTS providers_lat_lng_idx ON providers (lat, lng);
CREATE INDEX IF NOT EXISTS providers_postcode_idx ON providers (postcode);

CREATE TABLE IF NOT EXISTS wait_snapshots (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ods_code                TEXT NOT NULL REFERENCES providers (ods_code) ON DELETE CASCADE,
  treatment_function_code TEXT NOT NULL,
  treatment_function_name TEXT,
  patients_waiting        INTEGER,
  median_wait_weeks       NUMERIC(6, 2),
  pct_within_18_weeks     NUMERIC(5, 2),
  period_end              DATE NOT NULL,
  source                  TEXT NOT NULL,
  ingested_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wait_snapshots_natural_key
    UNIQUE (ods_code, treatment_function_code, period_end, source)
);

-- The main query is "for this specialty in this month, rank providers", so the
-- leading columns are the filter and the trailing one is the sort input.
CREATE INDEX IF NOT EXISTS wait_snapshots_specialty_period_idx
  ON wait_snapshots (treatment_function_code, period_end, median_wait_weeks);

CREATE INDEX IF NOT EXISTS wait_snapshots_provider_period_idx
  ON wait_snapshots (ods_code, period_end);
