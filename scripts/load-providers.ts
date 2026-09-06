/**
 * Fills in provider addresses and coordinates from the NHS Organisation Data
 * Service, for the providers already loaded from an RTT workbook.
 *
 *   npm run load:providers                 # only providers still missing details
 *   npm run load:providers -- --refresh    # re-fetch every provider
 *   npm run load:providers -- --dry-run    # fetch and report, write nothing
 *
 * Flags:
 *   --refresh        ignore the cache and re-fetch every provider
 *   --dry-run        no database writes
 *   --concurrency n  simultaneous ORD requests (default 6)
 *   --limit n        stop after n providers, for a quick trial run
 *
 * ORD supplies the registered address; it has no coordinates, so postcodes are
 * geocoded through postcodes.io. Responses are cached in data/.ods-cache.json
 * so a re-run does not hit the API again.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, DATA_DIR } from '../lib/cli.ts';
import { closePool, getPool, withTransaction } from '../lib/db.ts';
import { fetchOrganisation, geocodePostcodes, mapWithConcurrency } from '../lib/ods.ts';
import type { OdsProvider } from '../lib/ods.ts';

const CACHE_FILE = path.join(DATA_DIR, '.ods-cache.json');
const DEFAULT_CONCURRENCY = 6;

type Cache = Record<string, { fetchedAt: string; provider: OdsProvider | null }>;

async function readCache(): Promise<Cache> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, 'utf8')) as Cache;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const refresh = args.refresh === true;
  const dryRun = args['dry-run'] === true;
  const concurrency = Number(args.concurrency ?? DEFAULT_CONCURRENCY);

  const pool = getPool();
  const { rows: targets } = await pool.query<{ ods_code: string }>(
    refresh
      ? 'SELECT ods_code FROM providers ORDER BY ods_code'
      : `SELECT ods_code FROM providers
          WHERE postcode IS NULL OR lat IS NULL OR lng IS NULL OR address IS NULL
          ORDER BY ods_code`,
  );

  const limit = args.limit ? Number(args.limit) : targets.length;
  const codes = targets.slice(0, limit).map((row) => row.ods_code);

  if (codes.length === 0) {
    console.log('Every provider already has an address and coordinates. Use --refresh to re-fetch.');
    return;
  }

  console.log(`providers to look up: ${codes.length}${limit < targets.length ? ` (of ${targets.length})` : ''}`);

  const cache = refresh ? {} : await readCache();
  const cached = codes.filter((code) => cache[code]).length;
  if (cached > 0) console.log(`  ${cached} already in ${CACHE_FILE}`);

  let done = 0;
  const fetched = await mapWithConcurrency(codes, concurrency, async (code) => {
    const hit = cache[code];
    const provider = hit ? hit.provider : await fetchOrganisation(code);
    if (!hit) cache[code] = { fetchedAt: new Date().toISOString(), provider };
    done += 1;
    if (done % 50 === 0 || done === codes.length) {
      process.stdout.write(`\r  ORD lookups: ${done}/${codes.length}`);
    }
    return provider;
  });
  process.stdout.write('\n');

  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));

  const found = fetched.filter((provider): provider is OdsProvider => provider !== null);
  const notInOds = codes.filter((_, i) => fetched[i] === null);
  const noPostcode = found.filter((provider) => provider.postcode === null);

  const coordinates = await geocodePostcodes(
    found.map((provider) => provider.postcode ?? '').filter(Boolean),
    (batchDone, total) => process.stdout.write(`\r  geocoding: ${batchDone}/${total} postcodes`),
  );
  process.stdout.write('\n');

  const updates = found.map((provider) => ({
    provider,
    coords: provider.postcode ? coordinates.get(provider.postcode) ?? null : null,
  }));
  const noCoords = updates.filter((update) => update.coords === null && update.provider.postcode);
  const inactive = found.filter((provider) => provider.status && provider.status !== 'Active');

  console.log('');
  console.log(`  ODS records found      : ${found.length}`);
  console.log(`  not in ODS             : ${notInOds.length}${notInOds.length ? ` -> ${notInOds.slice(0, 10).join(', ')}` : ''}`);
  console.log(`  found but no postcode  : ${noPostcode.length}${noPostcode.length ? ` -> ${noPostcode.slice(0, 10).map((p) => p.odsCode).join(', ')}` : ''}`);
  console.log(`  postcode not geocoded  : ${noCoords.length}${noCoords.length ? ` -> ${noCoords.slice(0, 10).map((u) => `${u.provider.odsCode} ${u.provider.postcode}`).join(', ')}` : ''}`);
  console.log(`  ODS status not Active  : ${inactive.length}${inactive.length ? ` -> ${inactive.slice(0, 10).map((p) => `${p.odsCode} ${p.status}`).join(', ')}` : ''}`);

  console.log('\nfirst 3 resolved:');
  for (const { provider, coords } of updates.slice(0, 3)) {
    console.log(`  ${provider.odsCode}  ${provider.name}`);
    console.log(`      ${provider.address}  ${provider.postcode}  ${coords ? `${coords.lat}, ${coords.lng}` : '(no coordinates)'}`);
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written');
    return;
  }

  // The RTT workbook owns `name`; ODS only fills in the location columns, so a
  // provider's display name stays consistent with the waiting-time data.
  await withTransaction(async (client) => {
    for (const { provider, coords } of updates) {
      await client.query(
        `UPDATE providers
            SET address = COALESCE($2, address),
                postcode = COALESCE($3, postcode),
                lat = COALESCE($4, lat),
                lng = COALESCE($5, lng),
                updated_at = now()
          WHERE ods_code = $1`,
        [provider.odsCode, provider.address, provider.postcode, coords?.lat ?? null, coords?.lng ?? null],
      );
    }
  });

  console.log(`\nupdated ${updates.length} provider(s)`);
}

main()
  .catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  })
  .finally(closePool);
