'use client';

/**
 * Catches anything thrown while rendering the page — most likely the database
 * being unreachable — so a failure explains itself instead of becoming a blank
 * 500 with a digest. The digest is shown because it is the only handle the
 * server logs share with the person looking at the screen.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="shell">
      <header className="masthead">
        <h1>Waiting times are unavailable</h1>
        <p>
          We could not reach the waiting-time data just now. Nothing is wrong with what you
          entered.
        </p>
      </header>

      <div className="notice">
        <p>This is a fault at our end, not with your postcode or your search.</p>
        <p>
          Try again in a moment. If it keeps happening, the published figures are on NHS
          England&rsquo;s{' '}
          <a href="https://www.england.nhs.uk/statistics/statistical-work-areas/rtt-waiting-times/">
            referral to treatment waiting times
          </a>{' '}
          page.
        </p>
      </div>

      <p style={{ marginTop: '1.5rem' }}>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </p>

      {error.digest && (
        <footer>
          <p>
            If you are reporting this, quote reference <code>{error.digest}</code>.
          </p>
        </footer>
      )}
    </div>
  );
}
