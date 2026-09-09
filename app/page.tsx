import {
  listSpecialties,
  listPeriods,
  findProviders,
  groupByTie,
  ACTIVITY_WINDOW_MONTHS,
  RADII,
  TIE_TOLERANCE_WEEKS,
} from '../lib/search.ts';
import type { ProviderWait, Radius, TieGroup } from '../lib/search.ts';
import { lookupPostcode } from '../lib/postcode.ts';
import type { PostcodeLookup } from '../lib/postcode.ts';
import { formatCount, formatMiles, formatPercent, formatPeriod, formatWeeks } from '../lib/format.ts';

export const dynamic = 'force-dynamic';

/**
 * Run next to the database. Every render makes two Postgres round trips and a
 * search makes three, so placing the function away from the data adds a
 * transatlantic hop to each one — the first deployment ran in iad1 against a
 * database in eu-west-2. Kept here as well as in the project settings so the
 * choice is reviewable and travels with the code.
 */
export const preferredRegion = 'lhr1';

type Params = Record<string, string | string[] | undefined>;

/** A repeated query parameter (?postcode=a&postcode=b) arrives as an array. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const FAILURE_TEXT: Record<Exclude<PostcodeLookup, { ok: true }>['reason'], [string, string]> = {
  invalid: [
    'That does not look like a UK postcode.',
    'Enter a full postcode, such as LS1 4AP.',
  ],
  'not-found': [
    'No such postcode.',
    'Check the postcode and try again. Results are for hospitals in England.',
  ],
  unavailable: [
    'The postcode lookup is not responding, so we cannot work out distances.',
    'Nothing is wrong with your postcode — try again in a moment.',
  ],
};

/** Bars share one scale so a short wait reads as short, not just as first. */
function measureScale(groups: TieGroup[]): number {
  const longest = Math.max(
    0,
    ...groups.flatMap((group) =>
      group.kind === 'ranked' ? group.rows.map((row) => row.medianWaitWeeks ?? 0) : [],
    ),
  );
  return Math.max(longest, 12);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function bandLabel(group: Extract<TieGroup, { kind: 'ranked' }>): string {
  if (group.rows.length === 1) return `${formatWeeks(group.minWeeks)} weeks`;
  return `${formatWeeks(group.minWeeks)}–${formatWeeks(group.maxWeeks)} weeks`;
}

function ResultRow({ provider, scale }: { provider: ProviderWait; scale: number }) {
  const { medianWaitWeeks: weeks } = provider;
  // With nobody waiting there is no percentage and no queue to state; "0%" and
  // "0" would read as a terrible service rather than an absent one.
  const nothingWaiting = provider.patientsWaiting === 0;
  // NHS England withholds the median where too few patients are waiting. The
  // percentage is computed from that same handful, so it is no more robust: of
  // the rows with a single patient, it reads 0% or 100% depending on that one
  // person. Showing it as a rate invites it to be read as a quality score.
  const rateNotMeaningful = weeks === null && !nothingWaiting;
  return (
    <tr className={nothingWaiting ? 'row-quiet' : undefined}>
      <td>
        <span className="provider-name">{provider.name}</span>{' '}
        {provider.sector === 'independent' && (
          <span
            className="sector"
            title="Treats NHS patients under NHS contract — free at the point of use, referred by your GP the same way"
          >
            Independent
          </span>
        )}
        <span className="vintage">
          data to {formatPeriod(provider.periodEnd)}
          {provider.postcode ? ` · ${provider.postcode}` : ''}
        </span>
      </td>
      <td className="num" data-label="Distance">{formatMiles(provider.distanceMiles)}</td>
      <td data-label="Median wait">
        <div className="wait">
          {weeks === null ? (
            <span className={nothingWaiting ? 'wait-empty' : 'wait-unreported'}>
              {nothingWaiting ? 'no one waiting' : 'not published'}
            </span>
          ) : (
            <>
              <span className="wait-figure">
                {formatWeeks(weeks)}{' '}
                <span className="unit">weeks</span>
              </span>
              <span className="measure" aria-hidden="true">
                <span style={{ width: `${Math.min(100, (weeks / scale) * 100)}%` }} />
              </span>
            </>
          )}
        </div>
      </td>
      <td className="num" data-label="Seen within 18 weeks">
        {nothingWaiting || rateNotMeaningful || provider.pctWithin18Weeks === null ? (
          <span className="muted" aria-label="not applicable">&mdash;</span>
        ) : (
          formatPercent(provider.pctWithin18Weeks)
        )}
      </td>
      <td className="num" data-label="Patients waiting">
        {nothingWaiting || provider.patientsWaiting === null ? (
          <span className="muted" aria-label="not applicable">&mdash;</span>
        ) : (
          formatCount(provider.patientsWaiting)
        )}
      </td>
    </tr>
  );
}

function ResultTable({
  rows,
  scale,
  showHeader,
}: {
  rows: ProviderWait[];
  scale: number;
  showHeader: boolean;
}) {
  return (
    // Every group is its own table, so the columns are pinned to the same
    // widths; otherwise each group would size its own columns and nothing would
    // line up down the page. Later groups keep the header for screen readers
    // but hide it, since repeating it under every band is just noise.
    <table className={showHeader ? undefined : 'headerless'}>
      <colgroup>
        <col style={{ width: '33%' }} />
        <col style={{ width: '11%' }} />
        <col style={{ width: '21%' }} />
        <col style={{ width: '19%' }} />
        <col style={{ width: '16%' }} />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">Hospital</th>
          <th scope="col" className="num">Distance</th>
          <th scope="col" className="num">Median wait</th>
          <th scope="col" className="num">Seen within 18 weeks</th>
          <th scope="col" className="num">Patients waiting</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((provider) => (
          <ResultRow key={provider.odsCode} provider={provider} scale={scale} />
        ))}
      </tbody>
    </table>
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const [specialties, periods] = await Promise.all([listSpecialties(), listPeriods()]);

  const postcodeInput = (first(params.postcode) ?? '').trim();
  const specialtyParam = first(params.specialty);
  const specialty = specialties.find((entry) => entry.code === specialtyParam) ?? null;
  const radius = (RADII.find((value) => String(value) === first(params.radius)) ?? 25) as Radius;
  const submitted = postcodeInput !== '' || specialtyParam !== undefined;

  const lookup = submitted && postcodeInput !== '' ? await lookupPostcode(postcodeInput) : null;
  const providers =
    lookup?.ok && specialty ? await findProviders(lookup.lat, lookup.lng, specialty.code, radius) : [];
  const groups = groupByTie(providers);
  const scale = measureScale(groups);

  return (
    <div className="shell">
      <header className="masthead">
        <h1>Where would you be seen sooner?</h1>
        <p>
          You have the right to choose which hospital treats you. Compare how long hospitals near you
          are taking, using NHS England&rsquo;s published waiting times.
        </p>
      </header>

      <form className="search" method="get" action="/">
        <div className="field">
          <label htmlFor="postcode">Your postcode</label>
          <input
            id="postcode"
            name="postcode"
            defaultValue={postcodeInput}
            placeholder="LS1 4AP"
            autoComplete="postal-code"
            spellCheck={false}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="specialty">Treatment you need</label>
          <select id="specialty" name="specialty" defaultValue={specialty?.code ?? ''} required>
            <option value="" disabled>
              Choose a treatment
            </option>
            {specialties
              .filter((entry) => !entry.residual)
              .map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.hint ? `${entry.name} — ${entry.hint}` : entry.name}
                </option>
              ))}
            {/*
              NHS England's residual categories. A referral letter never names
              one, so they sit apart from the specialties someone is looking
              for — but they hold a fifth of everyone waiting, so they are not
              hidden either.
            */}
            <optgroup label="If your referral does not match any of the above">
              {specialties
                .filter((entry) => entry.residual)
                .map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.hint ? `${entry.name} — ${entry.hint}` : entry.name}
                  </option>
                ))}
            </optgroup>
          </select>
        </div>

        <div className="field">
          <label htmlFor="radius">How far you can travel</label>
          <select id="radius" name="radius" defaultValue={String(radius)}>
            {RADII.map((value) => (
              <option key={value} value={value}>
                Within {value} miles
              </option>
            ))}
          </select>
        </div>

        <button type="submit">Show hospitals</button>
      </form>

      {submitted && postcodeInput === '' && (
        <div className="notice">
          <p>Enter your postcode to compare hospitals near you.</p>
        </div>
      )}

      {lookup && !lookup.ok && (
        <div className="notice">
          <p>{FAILURE_TEXT[lookup.reason][0]}</p>
          <p>{FAILURE_TEXT[lookup.reason][1]}</p>
        </div>
      )}

      {lookup?.ok && !specialty && (
        <div className="notice">
          <p>Choose the treatment you need to see which hospitals are quickest.</p>
        </div>
      )}

      {lookup?.ok && specialty && (
        <>
          <section className="alert" role="note" aria-labelledby="urgent-heading">
            <h2 id="urgent-heading">If your referral is urgent, do not choose on waiting times</h2>
            <p>
              Urgent referrals and suspected-cancer referrals — the ones often called
              two-week-wait — are booked through a different route, and these figures do not
              describe them. Choosing a hospital from this page could delay you.
            </p>
            <p>Speak to your GP, or to whoever referred you, before you do anything else.</p>
          </section>

          <section className="summary">
            <h2>
              {specialty.name} within {radius} miles of {lookup.postcode}
            </h2>
            <p>
              {providers.length === 0
                ? 'No hospitals in range reported this treatment. Try a wider distance.'
                : `${providers.length} hospital${providers.length === 1 ? '' : 's'}, shortest wait first. Hospitals within ${TIE_TOLERANCE_WEEKS} weeks of each other are shown together, because the difference between them is not big enough to rank.`}
            </p>
          </section>

          {groups.map((group, index) => {
            const heading =
              group.kind === 'ranked'
                ? {
                    band: bandLabel(group),
                    note:
                      group.rows.length > 1
                        ? `${group.rows.length} hospitals, too close to separate`
                        : null,
                  }
                : group.kind === 'suppressed'
                  ? {
                      band: 'Wait not published',
                      note: `${plural(group.rows.length, 'hospital')} had too few patients waiting for NHS England to publish a median, so the percentage is not shown either`,
                    }
                  : {
                      band: 'No one waiting now',
                      note:
                        group.rows.length === 1
                          ? '1 hospital does this treatment but had nobody waiting when it last reported'
                          : `${group.rows.length} hospitals do this treatment but had nobody waiting when they last reported`,
                    };

            return (
              <section
                className="group"
                key={group.kind === 'ranked' ? `ranked-${group.minWeeks}-${index}` : group.kind}
              >
                <div className="group-head">
                  <span className="group-band">{heading.band}</span>
                  {heading.note && <span className="group-note">{heading.note}</span>}
                </div>
                <ResultTable rows={group.rows} scale={scale} showHeader={index === 0} />
              </section>
            );
          })}
        </>
      )}

      {lookup?.ok && specialty && providers.length > 0 && (
        <section className="guide">
          <h2>Asking to be treated somewhere else</h2>
          <ol>
            {providers.some((provider) => provider.sector === 'independent') && (
              <li>
                <strong>
                  Hospitals marked <span className="sector">Independent</span> are still NHS
                  treatment.
                </strong>{' '}
                They are independent-sector providers treating NHS patients under an NHS
                contract: free at the point of use, and your GP refers you the same way. They
                appear here for that reason.
              </li>
            )}
            <li>
              <strong>Say so before you are referred.</strong> Tell your GP which hospital you
              would prefer. For most planned care you can name any hospital in England that
              offers the treatment and holds an NHS contract.
            </li>
            <li>
              <strong>You can still ask after a referral has been made.</strong> Contact your GP
              practice and ask to be referred somewhere else. A referral can be changed.
            </li>
            <li>
              <strong>Check you can get there.</strong> Travel is usually your own
              responsibility, and treatment can mean several visits, not one.
            </li>
            <li>
              <strong>Ask the hospital what its wait means for you.</strong> A median is the
              middle of everyone currently waiting. Your own wait depends on your condition and
              on how urgent your referral is.
            </li>
          </ol>
          <p>
            More on this right:{' '}
            <a href="https://www.nhs.uk/using-the-nhs/about-the-nhs/your-choices-in-the-nhs/">
              your choices in the NHS
            </a>
            .
          </p>
        </section>
      )}

      <footer>
        <p>
          Waiting times are from NHS England&rsquo;s monthly referral to treatment statistics. The
          median wait is how long half of the patients still waiting have been waiting; it is not a
          prediction of your own wait.
        </p>
        <p>
          Distances are straight-line from the centre of your postcode. Talk to your GP before asking
          to be referred elsewhere.
        </p>
        <p>
          {periods.length === 0
            ? 'No waiting times are loaded yet.'
            : `Covering ${periods.length === 1 ? 'one month' : `${periods.length} months`}, ${formatPeriod(periods[periods.length - 1])} to ${formatPeriod(periods[0])}. A hospital that has had nobody waiting for a treatment for the last ${ACTIVITY_WINDOW_MONTHS} months is not listed for it.`}
        </p>
      </footer>
    </div>
  );
}
