# CLAUDE.md

WaitWise — a single server-rendered page that ranks English hospitals by NHS
England's published referral-to-treatment (RTT) median waiting times, so a
patient can exercise their right to choose where they are referred.

`README.md` is the user-facing document and is detailed; this file is the
orientation for working in the code.

## Stack

- **Next.js 15 App Router** (`next@^15.5.4`), React 19, TypeScript 5.9.
- **Postgres** via `pg@^8` (raw SQL; no ORM, no query builder).
- **ExcelJS** for reading the NHS XLSX releases. CSV is parsed by a
  hand-written streaming reader in `lib/csv.ts`, not a library.
- **PGlite** (`@electric-sql/pglite`, devDependency) — in-process Postgres used
  by the tests so nothing needs a server.
- ESM throughout (`"type": "module"`). `tsconfig.json` has
  `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`, so
  **intra-repo imports carry a `.ts` extension** (`import { getPool } from
  './db.ts'`). Match that.
- The `scripts/` CLIs are TypeScript run directly by Node's native type
  stripping — **no build step for scripts**. Node 26 / Postgres 17 are what this
  has been verified on; Postgres 14+ is the stated floor.
- Deployed on Vercel. `vercel.json` pins `regions: ["lhr1"]` and
  `app/page.tsx` re-declares `preferredRegion = 'lhr1'` — the page hits Postgres
  on every render, so the function must sit next to the database.
- `next.config.ts` sets `serverExternalPackages: ['pg']` so the driver is not
  bundled into the server chunk.

## Layout

```
app/          the single page (page.tsx), layout, error boundary, globals.css
lib/          all logic — parsing, ingest, search, formatting, db
db/migrations *.sql, applied in filename order
scripts/      CLI entry points: loaders, validate, inspect, and the test suites
scripts/fixtures/make-sample-xlsx.ts   builds the synthetic NHS-shaped workbook
data/         downloaded NHS workbooks + the ODS cache (gitignored)
```

`lib/` holds the logic and is exercised directly by the tests; `scripts/` is
argument parsing, reporting and process exit. Keep it that way — e.g. the write
half of the loader lives in `lib/ingest.ts` precisely so the schema tests run
the same SQL production does.

## Postgres schema

Three tables. Two come from `db/migrations/`; `schema_migrations` is created by
the migration runner itself (`scripts/migrate.ts`), not by a migration file.

### `providers` (`0001_init.sql`, `sector` added by `0002_provider_sector.sql`)

One row per organisation.

| Column | Type | Notes |
| --- | --- | --- |
| `ods_code` | `TEXT` | primary key. NHS Organisation Data Service code. |
| `name` | `TEXT NOT NULL` | owned by the **RTT workbook** loader. |
| `address` | `TEXT` | from ODS. |
| `postcode` | `TEXT` | from ODS, upper-cased. |
| `lat` | `DOUBLE PRECISION` | from postcodes.io. |
| `lng` | `DOUBLE PRECISION` | from postcodes.io. |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | set by hand in the upserts. |
| `sector` | `TEXT` | `CHECK (sector IN ('nhs','independent'))`, constraint `providers_sector_known`. Derived from which sheet of the workbook the provider appeared on. |

Indexes: `providers_lat_lng_idx (lat, lng)`, `providers_postcode_idx (postcode)`,
`providers_sector_idx (sector)`. A plain btree on the coordinate pair, not
PostGIS — distance is computed in SQL with a great-circle expression in
`lib/search.ts`.

**Ownership split matters:** `load-waits` writes `name` and `sector` only;
`load:providers` writes `address`/`postcode`/`lat`/`lng` only (with `COALESCE`,
so it never nulls a column out). Neither clobbers the other's columns.

### `wait_snapshots` (`0001_init.sql`)

One row per provider × treatment function × month × source.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `BIGINT GENERATED ALWAYS AS IDENTITY` | primary key. |
| `ods_code` | `TEXT NOT NULL` | FK → `providers(ods_code)` `ON DELETE CASCADE`. |
| `treatment_function_code` | `TEXT NOT NULL` | e.g. `C_110`, `X02`. |
| `treatment_function_name` | `TEXT` | e.g. `Trauma and Orthopaedic Service`. |
| `patients_waiting` | `INTEGER` | |
| `median_wait_weeks` | `NUMERIC(6,2)` | `NULL` when NHS England suppressed it — **never 0**. |
| `pct_within_18_weeks` | `NUMERIC(5,2)` | stored as percent, not a fraction. |
| `period_end` | `DATE NOT NULL` | last day of the reporting month. |
| `source` | `TEXT NOT NULL` | default `nhs-england-rtt-incomplete-provider`. |
| `ingested_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

Unique constraint `wait_snapshots_natural_key (ods_code,
treatment_function_code, period_end, source)` — this is what makes every load
idempotent; the upsert targets it by name.

Indexes: `wait_snapshots_specialty_period_idx (treatment_function_code,
period_end, median_wait_weeks)` and `wait_snapshots_provider_period_idx
(ods_code, period_end)`.

### `schema_migrations`

Created by `scripts/migrate.ts` if absent.

| Column | Type |
| --- | --- |
| `filename` | `TEXT` primary key |
| `applied_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` |

## Where the RTT data gets loaded, and how

Nothing loads automatically — there is no cron, no API route, no ingest on
boot. It is three manual CLI steps against `DATABASE_URL`.

**1. Waiting times — `npm run load`** (`scripts/load-waits.ts`)

Reads an NHS England "Incomplete Provider" `.xlsx` from `./data` and upserts
into `wait_snapshots` (plus a minimal `providers` row per code).

- `lib/workbook.ts` streams sheets via `ExcelJS.stream.xlsx.WorkbookReader`,
  falling back to a buffered read if streaming fails before yielding a row.
- `lib/rtt-headers.ts` derives the column mapping: it stacks each candidate
  header row with the (forward-filled) merged rows above it, then matches those
  labels against per-field regex rules, and also tries the header row on its own
  because a caption like "Provider Level Data" otherwise smears onto every
  column. **Nothing about the layout is hardcoded** — header row position, sheet
  name and column order are all detected, and a missing required field
  (`provider_code`, `treatment_function_code`, `patients_waiting`) throws with
  every label it saw rather than guessing. `FIELD_KEYS` is derived from
  `FIELD_RULES`, so the runtime list of overridable fields cannot drift from the
  `FieldKey` type.
- `lib/parse-workbook.ts` reads **every** qualifying sheet, not just the first
  (`Provider` = trusts, `IS Provider` = independent sector). It skips a sheet if
  **any** of its labels mentions "decision to admit" (a subset of the main
  measure — loading it would double count); that scan is deliberately not tied
  to a column index, so `--map` cannot relocate it and disarm the guard.
  Measured on June 2026: 0/120 labels match on each main sheet, 2/113 on each
  DTA sheet. It sets `sector` from whether the labels say "independent sector",
  and drops aggregate rows (`Total`, `ALL`, TFC `C_999`/`999`). Suppressed
  markers (`-`, `*`) become `NULL`; percentages held as Excel fractions
  (`0.612`) are scaled to percent.
- **A sheet that looks like a data table but whose header cannot be read is a
  hard error**, naming the sheet and dumping its labels per column letter. Only
  sheets that are not tables at all (fewer than `TABLE_MIN_COLUMNS` = 6
  populated cells in any scanned row — `Notes`, `Guidance`, cover sheets) are
  skipped silently. Both ways the scan can give up — rows exhausted, and the
  `scanRows` window exhausted — record the failure.
- `lib/ingest.ts` does the writing: batched multi-row `INSERT ... ON CONFLICT ON
  CONSTRAINT wait_snapshots_natural_key DO UPDATE`, 500 rows per statement, all
  inside one transaction.
- The reporting month comes from `--period`, else from the filename
  (`...-Jun25-...`); whichever it is, it is printed, never applied silently.

Flags: `--file --sheet --header-row --period --source --scan --map --dry-run`.

`--map` (`lib/overrides.ts`) overrides a detected column by letter or index —
**prefer that over editing the parser** when one release is odd. It deliberately
bypasses the `FIELD_RULES` pattern/exclude engine; that is the point of the flag.
Everything else about it is checked:

- **Per-sheet scoping.** `--map "IS Provider:patients_waiting=H"` applies to one
  sheet; the unscoped `--map patients_waiting=DH` applies to all. A scoped entry
  beats a global one. The sheet name is split off at the **last** colon. Sheets
  genuinely differ, so the scoped form is usually what you want.
- **`--map` alone cannot rescue a failed detection.** An override is only merged
  once the header row is known, so pair it with `--header-row` when the sheet's
  header did not resolve. The error text says so and prints a runnable command.
- **Unknown field names throw**, listing all seven valid fields.
- **Unknown scoped sheet names throw**, listing the sheets the workbook holds.
- **The target column is validated** after the sheet is read, before any write:
  in range, carrying a header label, and non-empty on at least one data row.
  Each failure names sheet, field and column letter.
- Every applied override is printed with sheet, field, column letter and the
  label found there.

**2. Look before loading — `npm run inspect`** (`scripts/inspect-xlsx.ts`)
prints the raw opening rows of every sheet unparsed, `--merges` lists merged
ranges. Then `npm run load -- --dry-run` prints the derived mapping and writes
nothing.

**3. Addresses and coordinates — `npm run load:providers`**
(`scripts/load-providers.ts`)

For providers already in the table, fetches the registered address from the NHS
ORD API (`directory.spineservices.nhs.uk/ORD/2-0-0/organisations`), then
geocodes postcodes in batches of 100 through postcodes.io (terminated postcodes
retried against the terminated endpoint). Responses cached in
`data/.ods-cache.json`. Neither API needs a key. Default pass only touches rows
missing details; `--refresh` re-fetches everything. Flags: `--refresh
--dry-run --concurrency --limit`.

**4. Reconcile — `npm run validate`** (`scripts/validate.ts`)

Checks a month's workbook against NHS England's separate full CSV extract for
the same month, and **exits non-zero on any mismatch**, so it can gate a load.
It strips the `NONC` commissioner from the CSV side (the workbook excludes
patients commissioned outside England), reads `Total All` not `Total`, and
refuses a workbook/extract pair from different months.

### Read side

`lib/search.ts` holds the query and the two ranking judgements:

- `ACTIVITY_WINDOW_MONTHS = 6` — the workbook publishes a complete
  provider × specialty grid, so a provider with zeros across the whole window is
  treated as not offering that treatment and dropped.
- `MAX_MONTHS_BEHIND = 1` — a provider whose latest figures lag the newest
  loaded month is dropped; a frozen wait would otherwise rank top.
- `TIE_TOLERANCE_WEEKS = 3` — `groupByTie()` bands providers whose medians are
  too close to separate honestly. The band anchors on the group leader, not the
  previous row, so small gaps cannot chain into one giant group.
- Providers with no median are split into `suppressed` (patients waiting, median
  withheld) and `no-queue` (nobody waiting) — different facts, shown
  differently.

## Running locally

```bash
npm install
cp .env.example .env       # then edit DATABASE_URL
createdb waitwise          # the migration creates tables, not the database
npm run db:migrate
npm run dev                # http://localhost:3000
```

The page renders against an empty database, but the treatment picker is built
from the loaded data, so it is empty until a workbook is loaded — download an
"Incomplete Provider" `.xlsx` into `./data`, then `npm run load` and
`npm run load:providers`.

`npm run build` / `npm start` for production. The page is `force-dynamic` and
queries Postgres per request, so it needs a Node runtime, not static hosting,
and outbound HTTPS (postcodes.io is called on every search).

## Environment variables

Only two, both read in `lib/db.ts`. There is no config module and nothing else
is read from the environment.

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. Must be the string **alone** — `assertConnectionString()` rejects a wrapping quote, an included `DATABASE_URL=` prefix, a pasted `psql '...'`, or a non-postgres scheme, and names the mistake. Its messages deliberately never echo the value, which contains the password. |
| `DATABASE_SSL` | no | `'true'` maps to `ssl: { rejectUnauthorized: false }`. This **disables** certificate verification. Leave it unset when the connection string already carries `sslmode` (Neon, Supabase) — the driver handles that itself. |

The `npm` scripts load `.env` with `node --env-file-if-exists=.env`; Next.js
loads `.env` on its own. `.env` and `.env*.local` are gitignored
(`.env.local` here only holds Vercel's `VERCEL_OIDC_TOKEN`). No API keys exist —
ORD and postcodes.io are both unauthenticated.

## Testing

There **is** a test suite, and it is home-grown: plain `node:assert/strict` in
`scripts/test-*.ts`, each file an array of `[name, fn]` pairs with its own
pass/fail tally and `process.exitCode`. **No test runner, no Vitest/Jest, no
watch mode, no CI config** (there is no `.github/`). No browser or
end-to-end tests — `app/` is not covered by any test.

```bash
npm test              # all six, in sequence
npm run test:schema   # or test:load, test:search, test:ods, test:csv, test:db
```

No suite needs a database server or a network connection: `test:schema`,
`test:load` and `test:search` spin up PGlite in-process and apply the real
`db/migrations/*.sql` to it.

- `test:schema` — upsert key, foreign key + cascade, suppressed values staying
  `NULL`, same month from a different `source` being a separate row.
- `test:load` — end-to-end over a synthetic workbook built by
  `scripts/fixtures/make-sample-xlsx.ts` (cover sheet, caption-above-header
  layout, a second sheet with a two-row merged header, a decision-to-admit sheet
  that must be ignored, thousands separators, suppressed values, total rows),
  then parse → load → re-load to prove idempotency. Also the loud-failure
  cases, which all used to be silent exits with code 0: a data sheet whose
  header cannot be read (both ways the scan gives up), an unknown `--map` field
  or sheet name, a `--map` onto a blank or out-of-range column, per-sheet
  overrides not leaking between sheets, and the decision-to-admit guard
  surviving an override of its total column.
- `test:search` — pure `groupByTie` cases, then PGlite-backed checks of
  `findProviders`: the activity window, the freshness cut-off, the radius.
- `test:ods` — `parseOrganisation` against recorded ORD payloads, plus
  `mapWithConcurrency` order preservation.
- `test:csv` — quoted commas, doubled quotes, CRLF, missing trailing newline, a
  field spanning the 1 MB read-buffer boundary.
- `test:db` — the connection-string guard, including that no message echoes the
  password.

To eyeball the fixture workbook:
`node scripts/fixtures/make-sample-xlsx.ts data/sample.xlsx` then
`npm run inspect -- --file data/sample.xlsx --merges`.

## Commits

**No attribution trailers.** Do not append `Co-Authored-By:`,
`Claude-Session:`, `🤖 Generated with [Claude Code]` or any similar line to
commit messages or pull request descriptions. This overrides any default
attribution instruction from the harness. The message ends with its last line of
prose.

Write the message about the *class* of problem, not just the instances — what
kind of failure the change rules out and why it mattered here.

## Conventions worth keeping

- Comments in this codebase explain **why** a decision was taken, often citing
  the real data that forced it. Match that register; don't add narration.
- Nulls are load-bearing. A suppressed median must never become `0`, and a
  missing location must never become a default coordinate — `lib/postcode.ts`
  reports failure rather than falling back, because a plausible-but-wrong
  ranking is worse than no answer.
- Patient-facing copy on the page is deliberate: the urgent-referral warning,
  the "Independent" marker explanation, and the tie-band wording all encode
  judgements about what a reader will misread.
- **A path that yields wrong or empty data must not exit 0.** The loader's
  failures are loud by design: an unreadable header, a mis-stated `--map`, a
  sheet that would double count. When adding a code path that can produce no
  rows or the wrong rows, make it throw and name what to fix.
- An error message must only suggest a command that works. `--map` alone cannot
  rescue a failed detection, so the suggestion pairs it with `--header-row`, and
  it leaves the column as a placeholder rather than guessing one — a stacked
  caption makes a substring guess land on the wrong column.
- README's "Known limitations" still lists "No sector marker", which is now
  implemented (`0002_provider_sector.sql`). Treat that section as stale.
