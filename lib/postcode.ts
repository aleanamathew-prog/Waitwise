/**
 * Single postcode lookup for the search form.
 *
 * Deliberately reports failure instead of falling back to a default location:
 * a silently wrong origin would produce a plausible but wrong ranking, which is
 * worse than no answer.
 */
const POSTCODES_URL = 'https://api.postcodes.io/postcodes';

export type PostcodeLookup =
  | { ok: true; postcode: string; lat: number; lng: number }
  | { ok: false; reason: 'invalid' | 'not-found' | 'unavailable' };

const POSTCODE_SHAPE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

export async function lookupPostcode(raw: string): Promise<PostcodeLookup> {
  const trimmed = raw.trim();
  if (!POSTCODE_SHAPE.test(trimmed)) return { ok: false, reason: 'invalid' };

  let response: Response;
  try {
    response = await fetch(`${POSTCODES_URL}/${encodeURIComponent(trimmed)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  if (response.status === 404) return { ok: false, reason: 'not-found' };
  if (!response.ok) return { ok: false, reason: 'unavailable' };

  const payload = (await response.json()) as {
    result?: { postcode?: string; latitude?: number | null; longitude?: number | null };
  };
  const result = payload.result;
  if (!result || typeof result.latitude !== 'number' || typeof result.longitude !== 'number') {
    return { ok: false, reason: 'not-found' };
  }

  return { ok: true, postcode: result.postcode ?? trimmed.toUpperCase(), lat: result.latitude, lng: result.longitude };
}
