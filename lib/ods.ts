/**
 * NHS Organisation Data Service lookups.
 *
 * The ORD API gives a provider's registered address but no coordinates, so
 * postcodes are geocoded separately through postcodes.io. Both are public and
 * need no key.
 */
const ORD_URL = 'https://directory.spineservices.nhs.uk/ORD/2-0-0/organisations';
const POSTCODES_URL = 'https://api.postcodes.io';
const POSTCODES_BATCH = 100;

export type OdsProvider = {
  odsCode: string;
  name: string | null;
  status: string | null;
  address: string | null;
  postcode: string | null;
  country: string | null;
};

export type Coordinates = { lat: number; lng: number };

type OrdLocation = {
  AddrLn1?: string;
  AddrLn2?: string;
  AddrLn3?: string;
  Town?: string;
  County?: string;
  PostCode?: string;
  Country?: string;
};

type OrdResponse = {
  Organisation?: {
    Name?: string;
    Status?: string;
    GeoLoc?: { Location?: OrdLocation };
  };
};

/** Flattens the ORD address block; the postcode is kept in its own column. */
export function parseOrganisation(odsCode: string, payload: unknown): OdsProvider {
  const organisation = (payload as OrdResponse).Organisation;
  const location = organisation?.GeoLoc?.Location ?? {};
  const address = [location.AddrLn1, location.AddrLn2, location.AddrLn3, location.Town, location.County]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join(', ');

  return {
    odsCode,
    name: organisation?.Name?.trim() || null,
    status: organisation?.Status?.trim() || null,
    address: address || null,
    postcode: location.PostCode?.trim().toUpperCase() || null,
    country: location.Country?.trim() || null,
  };
}

async function fetchJson(url: string, init?: RequestInit, attempt = 1): Promise<Response> {
  const MAX_ATTEMPTS = 4;
  try {
    const response = await fetch(url, {
      ...init,
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    // 404 is a real answer ("no such organisation"), not a failure to retry.
    if (response.status === 429 || response.status >= 500) {
      if (attempt >= MAX_ATTEMPTS) return response;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      return fetchJson(url, init, attempt + 1);
    }
    return response;
  } catch (error) {
    if (attempt >= MAX_ATTEMPTS) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    return fetchJson(url, init, attempt + 1);
  }
}

/** Returns null when ORD has no record for the code. */
export async function fetchOrganisation(odsCode: string): Promise<OdsProvider | null> {
  const response = await fetchJson(`${ORD_URL}/${encodeURIComponent(odsCode)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`ORD ${odsCode}: HTTP ${response.status}`);
  return parseOrganisation(odsCode, await response.json());
}

type PostcodesBulkResponse = {
  result?: Array<{
    query: string;
    result: { latitude: number | null; longitude: number | null } | null;
  }>;
};

/**
 * Geocodes postcodes in batches. Terminated postcodes are absent from the live
 * lookup, so those are retried against the terminated endpoint, which still
 * carries coordinates.
 */
export async function geocodePostcodes(
  postcodes: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, Coordinates>> {
  const unique = [...new Set(postcodes.map((code) => code.trim().toUpperCase()).filter(Boolean))];
  const found = new Map<string, Coordinates>();
  const missing: string[] = [];

  for (let start = 0; start < unique.length; start += POSTCODES_BATCH) {
    const batch = unique.slice(start, start + POSTCODES_BATCH);
    const response = await fetchJson(`${POSTCODES_URL}/postcodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postcodes: batch }),
    });
    if (!response.ok) throw new Error(`postcodes.io bulk lookup: HTTP ${response.status}`);
    const payload = (await response.json()) as PostcodesBulkResponse;

    for (const entry of payload.result ?? []) {
      const { latitude, longitude } = entry.result ?? { latitude: null, longitude: null };
      if (latitude !== null && longitude !== null) {
        found.set(entry.query.trim().toUpperCase(), { lat: latitude, lng: longitude });
      } else {
        missing.push(entry.query.trim().toUpperCase());
      }
    }
    onProgress?.(Math.min(start + POSTCODES_BATCH, unique.length), unique.length);
  }

  for (const postcode of missing) {
    const response = await fetchJson(
      `${POSTCODES_URL}/terminated_postcodes/${encodeURIComponent(postcode)}`,
    );
    if (!response.ok) continue;
    const payload = (await response.json()) as {
      result?: { latitude: number | null; longitude: number | null };
    };
    const { latitude, longitude } = payload.result ?? { latitude: null, longitude: null };
    if (latitude !== null && longitude !== null) {
      found.set(postcode, { lat: latitude, lng: longitude });
    }
  }

  return found;
}

/** Runs `worker` over `items` with a bounded number of requests in flight. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
