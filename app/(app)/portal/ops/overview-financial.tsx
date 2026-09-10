"use client";

/**
 * SECTION B — FINANCIAL STATUS. Replaces the old Cost card entirely.
 *
 * The card this replaces reported "£26,557 across 46 jobs" while the cohort
 * held 776, ranked sites by "Aldgate 898%" against a pro-rated annual budget
 * half the estate did not have, and finished with a link to the compliance
 * register. Three separate ways of presenting a data fault as a metric. §3 of
 * the master prompt deletes all three and this file is that deletion.
 *
 * ── WHAT CHANGED, AND WHY EACH ONE MATTERS ────────────────────────────────
 *
 * 1. COVERAGE IS READ FIRST (§3.2). `CoverageStrip` is the first element in
 *    the card, before a single total, and it decides its own banner tone from
 *    the numbers rather than from a flag a caller could get backwards. Under
 *    40% the amber sentence fires; the totals still render beneath it, because
 *    §3.2 says "do not hide the numbers at low coverage" — a hidden number is
 *    not more honest than a qualified one, it is just less useful.
 *
 * 2. THERE IS NO BUDGET UI (§3.3, gate 17). No "Spend against budget", no
 *    pro-rating note, no "N sites have no budget set" link. The budget DATA is
 *    untouched in the database — §8 forbids deleting it — it is simply not
 *    presented until cost coverage can support the comparison.
 *
 * 3. THERE IS NO COMPLIANCE LINK (§3.7, gate 21). It belongs on the Compliance
 *    page. Its absence here is pinned by this card's suite, because a link
 *    that drifted back would pass every other check on the page.
 *
 * 4. THE CONTRACTOR CHIP IS DRAWN IN BOTH CASES (§3.6). "Linked" is stated as
 *    plainly as "Not linked": a chip that appears only on failures teaches the
 *    reader that a missing chip means nothing was checked.
 *
 * ── WHY THE MONEY BREAKDOWNS ARE NOT `BreakdownSection` ───────────────────
 *
 * §3.5's breakdowns are of SPEND, and `BreakdownDimension.recorded` / `.total`
 * carry integer PENCE for them — 534200, not a job count. Three shared pieces
 * assume a count and print one:
 *
 *   · `BreakdownSection` heads itself with `coverageSentence`, giving
 *     "Spend by label — 534200 of 534200 recorded (100%)";
 *   · it passes no `format` through, so every bar reads "534200";
 *   · `Donut` prints `centreValue` and each legend value raw and says
 *     "N jobs" in its tooltip, so it cannot render money at all.
 *
 * All three would be false statements about money. So `MoneyBreakdown` below
 * composes the SAME shared parts — `ChartFrame` and `RankedBars`, the one
 * chart that takes a `format` — with `formatMoneyPence` and a header that
 * names its denominator in pounds. Nothing is re-implemented; only the two
 * lines the shared section cannot express are written here. It goes back to
 * `BreakdownSection` the moment that component accepts a formatter and a
 * coverage override, and that is the one upstream change this card wants.
 *
 * The shape rule loses nothing by this. §1.10 prefers a ring at five
 * categories or fewer because seven slices stop being comparable; a ranked
 * list is never the wrong answer, and it is the only shape that can carry
 * "£1,750" instead of "175000".
 */

import { useState, type ReactNode } from "react";
import analysisCss from "./overview-analysis.css?url";
import { EmptyState, ProgressMeter, SkeletonRow, StatusChip, plural } from "./ops-primitives";
import {
  ChartFrame,
  CohortHeader,
  CoverageStrip,
  DataQualityRow,
  MetricTile,
  formatCount,
  formatMoneyPence,
  useAbbreviatedNumbers,
} from "./overview-shared";
import { RankedBars, TimeSeries, type RankedRow } from "./overview-charts";
import type { BreakdownDimension, CostPayload, CostSiteRow } from "./overview-contract";
import { NOT_RECORDED_INK, sharesOfRecorded, tealScale } from "../../../lib/overview-meters";

/* ── The sentences this card is held to, verbatim ─────────────────────────── */

/**
 * §3.1, ONCE, AND WORD FOR WORD.
 *
 * A constant rather than JSX text: it is the one sentence on this page a
 * client's finance team will read as a statement about who invoices them, and
 * it is pinned by the suite exactly as written here. Keeping it out of the
 * markup also keeps its apostrophe out of the `react/no-unescaped-entities`
 * argument, which is how a sentence like this gets quietly reworded.
 */
export const SPEND_SUBTITLE =
  "Trade spend recorded against jobs. Contractors invoice you directly, so these are your " +
  "contractors' charges — Maintsupp coordination fees are not included here.";

/** §3.1's definition of spend, shown under the title. Not invoiced, not quoted. */
const SPEND_DEFINITION =
  "Spend is the Cost of Works value recorded on a job — not an invoiced amount and not a quoted " +
  "amount. A job with no cost recorded contributes zero.";

/** §3.2 — every figure below the strip is computed from the costed subset. */
const BASED_ON = "Based on jobs with a cost recorded.";

/* ── Pure helpers, exported because they are the part worth testing ───────── */

/**
 * THE CONFIDENCE BANNER — §3.2's table, computed, never passed in.
 *
 * `CoverageStrip` decides its TONE from the same `sharesOfRecorded` call over
 * the same two numbers, so the sentence this returns and the colour it is
 * painted in can never disagree. Over 75% there is no sentence at all, which
 * is the third row of that table and the reason this returns `undefined`
 * rather than an empty string.
 */
export function costBanner(coverageShare: number | null): string | undefined {
  /*
   * NULL IS "NOTHING TO COVER", AND IT GETS NO SENTENCE.
   *
   * A period holding no job at all has no coverage to report, and the amber
   * arm below would otherwise read "Cost data covers 0% of jobs in this
   * period" — a confident judgement about data that does not exist. §1.5 keeps
   * zero, null and "no data" apart, and this is the null. The strip beneath
   * still says what happened, because `coverageSentence` answers "nothing in
   * this period" on a zero denominator rather than "0 of 0 recorded (0%)".
   */
  if (coverageShare === null) return undefined;
  if (coverageShare < 40) {
    return (
      `Cost data covers ${coverageShare}% of jobs in this period. ` +
      "Treat these figures as indicative, not as portfolio spend."
    );
  }
  if (coverageShare <= 75) {
    return (
      `Cost data covers ${coverageShare}% of jobs in this period, so the figures below are a ` +
      "partial view of trade spend."
    );
  }
  return undefined;
}

/**
 * §3.5's derived sentence, computed from the payload on every render.
 *
 * The brief's example — "Lights and AC account for 46% of recorded spend" — is
 * a sentence about the top two categories, so that is what this reads, and the
 * share comes from `sharesOfRecorded` over the buckets actually drawn rather
 * than from the `share` on the wire. Empty when there is nothing to say: a
 * card that always prints a sentence eventually prints a meaningless one.
 */
export function spendConcentration(dimension: BreakdownDimension): string {
  const recorded = dimension.buckets.filter((bucket) => !bucket.notRecorded);
  if (recorded.length < 2 || dimension.recorded <= 0) return "";
  const shares = sharesOfRecorded(recorded.map((bucket) => bucket.value));
  return (
    `${recorded[0].label} and ${recorded[1].label} account for ${shares[0] + shares[1]}% ` +
    "of recorded spend."
  );
}

/**
 * §3.4 — how one site's median job compares with the portfolio's.
 *
 * Three answers and not two: `null` is "this site has no costed job", which is
 * §1.5's whole point and is not the same statement as "this site is average".
 */
export function medianStanding(
  medianPence: number | null,
  portfolioPence: number | null,
): "above" | "below" | "level" | null {
  if (medianPence === null || portfolioPence === null || portfolioPence <= 0) return null;
  if (medianPence > portfolioPence) return "above";
  if (medianPence < portfolioPence) return "below";
  return "level";
}

/** The three standings in words, so colour is never the only signal. */
const STANDING_WORD: Record<"above" | "below" | "level", string> = {
  above: "above the portfolio median",
  below: "below the portfolio median",
  level: "at the portfolio median",
};

/* ── The money breakdown: the shared chart, formatted as money ────────────── */

function MoneyBreakdown({
  dimension,
  abbreviate,
  onSelect,
}: {
  dimension: BreakdownDimension;
  abbreviate: boolean;
  onSelect?: (bucketKey: string) => void;
}) {
  const recordedBuckets = dimension.buckets.filter((bucket) => !bucket.notRecorded);
  const greyBucket = dimension.buckets.find((bucket) => bucket.notRecorded);
  const unlabelled = greyBucket ? greyBucket.value : 0;
  const shares = sharesOfRecorded(recordedBuckets.map((bucket) => bucket.value));
  const money = (pence: number) => formatMoneyPence(pence, abbreviate);

  return (
    <section className="ova-section">
      <div className="ova-section__head">
        <h4 className="ova-section__title">{dimension.label}</h4>
        {/*
          §1.4 — the denominator is on screen, in the unit the bars are drawn
          in. "534200 of 534200 recorded" is what the shared header prints
          here, and that is a job count's sentence wrapped round money.
        */}
        <p className="ova-section__meta">
          {money(dimension.recorded)} of {money(dimension.total)} recorded spend
        </p>
      </div>
      <ChartFrame
        empty={dimension.recorded <= 0}
        emptyLabel={`No spend is recorded against ${dimension.label.toLowerCase()} in this period.`}
        minHeight={180}
        table={{
          caption: `${dimension.label} — ${formatMoneyPence(dimension.recorded, false)} of ${formatMoneyPence(dimension.total, false)} recorded spend`,
          head: ["Category", "Spend", "Share of recorded spend"],
          rows: [
            ...recordedBuckets.map((bucket, index) => [
              bucket.label,
              formatMoneyPence(bucket.value, false),
              `${shares[index]}%`,
            ]),
            ...(unlabelled > 0
              ? [["No value recorded", formatMoneyPence(unlabelled, false), "not a recorded value"]]
              : []),
          ] as Array<Array<string | number>>,
        }}
      >
        <RankedBars
          rows={recordedBuckets.map((bucket, index): RankedRow => ({
            key: bucket.key,
            label: bucket.label,
            value: bucket.value,
            share: shares[index],
            colour: bucket.colour || tealScale(index),
          }))}
          format={money}
          onSelect={onSelect}
        />
      </ChartFrame>
      {/*
        §1.5 — the grey figure is a count of pounds with no percentage beside
        it, for the same reason a grey job count carries none: it was never in
        the denominator. It is drawn in the "not recorded" grey the brief
        reserves for a value that is not a real category.
      */}
      {unlabelled > 0 ? (
        <p className="ova-note">
          <span
            className="ovw-breakdown__swatch"
            style={{ background: NOT_RECORDED_INK }}
            aria-hidden="true"
          />
          {money(unlabelled)} of recorded spend sits on jobs with no{" "}
          {dimension.label.toLowerCase()} value recorded, and is not shared out above.
        </p>
      ) : null}
    </section>
  );
}

/* ── The card ─────────────────────────────────────────────────────────────── */

export function FinancialStatusCard({
  state,
  measure: requestedMeasure,
  filterChips,
  onToggle,
  onDrill,
  onOpenRecords,
  onOpenResolveNames,
  onOpenJob,
}: {
  state: { data: CostPayload | null; loading: boolean; error: string | null; reload: () => void };
  measure: "requested" | "completed";
  filterChips: Array<{ key: string; label: string; onRemove?: () => void }>;
  /** Cross-filters the whole page — adds the chip, or removes it when it is on. */
  onToggle: (key: string, value: string) => void;
  /** Through to the Jobs list, carrying the page's own range and filters. */
  onDrill: (extra: Record<string, string>) => void;
  /** The Overview's own record panel, for the questions the Jobs filter bar has no word for. */
  onOpenRecords: (query: string) => void;
  onOpenResolveNames: () => void;
  onOpenJob: (id: string) => void;
}) {
  /*
   * Every hook runs before the two early returns below, because a card that
   * called one fewer hook while loading crashes on its first successful fetch.
   *
   * `basis` is local state rather than URL state on purpose. Every aggregate on
   * this page is keyed by the query string, so putting a display toggle in the
   * address bar would refetch six endpoints to redraw two figures that are
   * already on the wire.
   */
  const abbreviate = useAbbreviatedNumbers();
  const [basis, setBasis] = useState<"period" | "annual">("period");
  const data = state.data;

  /*
   * THE COHORT'S VERB IS THE SERVER'S, NOT THE CONTROL'S.
   *
   * `/api/dashboard/cost` reads the axis out of the query string and nowhere
   * else — `parseFilters` has no route to a stored per-user preference — while
   * the page resolves `measure` by layering that preference over the URL. On a
   * bare `/dashboard` with a saved axis of `completed` the two disagree, and
   * this header asserted "N jobs completed in this period" over a cohort cut on
   * `requested_at`. `CostPayload.measure` is the axis that was actually
   * counted, so the sentence is drawn from it; the prop arrives as
   * `requestedMeasure` and the local `measure` is what was APPLIED. The intent
   * is still read, for the single render before a payload exists, and no cohort
   * sentence is drawn in that render — see the two guards below.
   */
  const measure = data?.measure ?? requestedMeasure;

  if (state.error) {
    return (
      <section className="ops-card" id="ops-cost">
        <link rel="stylesheet" href={analysisCss} precedence="default" />
        {/*
          THE TITLE, WITHOUT THE COHORT LINE.

          `CohortHeader` cannot draw one without the other, and what it would
          have drawn here is "0 jobs requested in this period" — a zero this
          card did not measure, over a verb the server never confirmed, beside
          a `role="alert"` saying the query failed. §1.5's rule that a failure
          must never look like a zero is exactly this case, and it is the shape
          `JobBreakdownCard` and `SitesAttentionCard` already take.
        */}
        <h2 className="ovw-cohort__title" id="ovw-money-title">
          Financial status
        </h2>
        {/*
          §1.5 and §9.10 — a failure never looks like a zero. `ChartFrame` owns
          all three appearances, so the error here is the same `role="alert"`
          and the same Retry a chart inside the card would draw, and neither is
          the empty state's sentence.
        */}
        <ChartFrame error={state.error} onRetry={state.reload} minHeight={180}>
          <></>
        </ChartFrame>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="ops-card" id="ops-cost">
        <link rel="stylesheet" href={analysisCss} precedence="default" />
        {/* The same title-only header the error branch draws, and for the same
            reason: a wait has no cohort and no axis to state either. */}
        <h2 className="ovw-cohort__title" id="ovw-money-title">
          Financial status
        </h2>
        {/* Skeletons occupy the finished dimensions — §9.44, no layout shift. */}
        <SkeletonRow lines={4} height={96} />
        <SkeletonRow lines={3} height={220} />
      </section>
    );
  }

  const money = (pence: number) => formatMoneyPence(pence, abbreviate);
  const exact = (pence: number) => formatMoneyPence(pence, false);

  /*
   * ONE coverage share, from the shared implementation, used by the banner and
   * by the tile. `CoverageStrip` recomputes it identically from the same two
   * numbers, so the sentence and the paint cannot drift apart.
   */
  const [derivedCoverage] = sharesOfRecorded([
    Math.max(0, data.costedJobs),
    Math.max(0, data.cohortTotal - data.costedJobs),
  ]);

  /*
   * NOTHING TO COVER IS NOT ZERO COVER.
   *
   * `sharesOfRecorded([0, 0])` is `[0, 0]` by design — a breakdown with nothing
   * recorded still has to draw its legend, and `NaN` is not a legend. But a 0
   * read as a COVERAGE percentage is a judgement, and on a period holding no
   * job at all this card announced "Cost data covers 0% of jobs in this period.
   * Treat these figures as indicative, not as portfolio spend." above a card
   * with no figures on it whatsoever.
   *
   * Two guards rather than one, because either source can answer the question:
   * `cohortTotal` is what this card's own derivation divides by, and
   * `coveragePercent` is the server's own null for the same state. The
   * derivation itself is untouched, so the banner's sentence and the strip's
   * paint still come from one implementation over the same two numbers.
   */
  const coverageShare =
    data.cohortTotal <= 0 || data.coveragePercent === null ? null : derivedCoverage;

  const banner = costBanner(coverageShare);

  const annual = basis === "annual" ? data.annual : null;
  const spendPence = annual ? annual.totalSpendPence : data.totalSpendPence;
  const costedJobs = annual ? annual.costedJobs : data.costedJobs;
  const previousMedian = data.previous?.medianCostPence ?? null;
  const largest = data.largest;

  /* ── Spend by site — §3.4 ─────────────────────────────────────────────── */

  /*
   * "Unassigned site" is not a site. §6.1 takes it out of the Sites card as "a
   * broken foreign key, not a location", and ranking it against real stores
   * distorts this card for exactly the same reason. It is reconciled in a
   * sentence beneath the list instead, so no pound leaves the total unexplained.
   */
  const namedSites = data.sites.filter((site) => !site.unassigned);
  const unassignedSite = data.sites.find((site) => site.unassigned) ?? null;
  const namedSpend = namedSites.reduce((sum, site) => sum + Math.max(0, site.spendPence), 0);
  const siteShares = sharesOfRecorded(namedSites.map((site) => site.spendPence));
  const medianCeiling = Math.max(
    data.portfolioMedianPence ?? 0,
    ...namedSites.map((site) => site.medianPence ?? 0),
    1,
  );
  const portfolioMarkerAt =
    data.portfolioMedianPence === null
      ? null
      : Math.min(100, (data.portfolioMedianPence / medianCeiling) * 100);

  const siteSuffix = (site: CostSiteRow): ReactNode => {
    const standing = medianStanding(site.medianPence, data.portfolioMedianPence);
    return (
      <span className="ova-rowstat">
        <span className="ova-rowstat__facts">
          <span>
            <b>{formatCount(site.costedJobs, false)}</b>{" "}
            {site.costedJobs === 1 ? "job with cost" : "jobs with cost"}
          </span>
          <span>
            median <b>{site.medianPence === null ? "no cost data" : exact(site.medianPence)}</b>
            {standing ? ` · ${STANDING_WORD[standing]}` : ""}
          </span>
          <span>
            coverage <b>{site.coveragePercent}%</b> of {formatCount(site.jobsInCohort, false)}
          </span>
        </span>
        {/*
          §3.4's portfolio marker, on the axis where it means something. The bar
          above carries the site's TOTAL spend; a per-job median drawn across a
          per-site-total scale would be a mark whose position says nothing. This
          track is the per-job scale, shared by every row, with the portfolio
          median as one hairline across all of them — which is how "this site
          runs expensive per job" becomes something the eye can read.
        */}
        {site.medianPence === null ? null : (
          <span className="ova-median">
            <ProgressMeter
              value={site.medianPence}
              max={medianCeiling}
              tone={tealScale(4)}
              height={6}
              label={`${site.siteName}: median ${exact(site.medianPence)} per job${
                standing ? `, ${STANDING_WORD[standing]}` : ""
              }`}
            />
            {portfolioMarkerAt === null ? null : (
              <span
                className="ova-median__marker"
                style={{ left: `${portfolioMarkerAt}%` }}
                aria-hidden="true"
              />
            )}
          </span>
        )}
      </span>
    );
  };

  /* ── Contractor spend — §3.6 ──────────────────────────────────────────── */

  const [attributionShare] = sharesOfRecorded([
    Math.max(0, data.contractorAttributedPence),
    Math.max(0, data.totalSpendPence - data.contractorAttributedPence),
  ]);
  const contractorShares = sharesOfRecorded(data.contractors.map((row) => row.spendPence));

  /* ── The trend — §3.3 ─────────────────────────────────────────────────── */

  /*
   * The columns carry WHOLE POUNDS rather than pence, and this is the one place
   * on the card where money leaves its integer unit. `TimeSeries` prints its
   * own axis ceiling — "Columns to 30000" — without passing it through
   * `formatValue`, so a pence series would label its axis with a number a
   * hundred times every figure in the tooltips beneath it. Pounds make the two
   * agree to the pound, and the exact pence survive in the data table, which is
   * where a reader checking a figure actually looks.
   */
  const trendPounds = data.trend.map((bucket) => Math.round(bucket.spendPence / 100));
  const trendEmpty = data.trend.length === 0 || data.trend.every((bucket) => bucket.spendPence <= 0);

  return (
    <section className="ops-card" id="ops-cost">
      <link rel="stylesheet" href={analysisCss} precedence="default" />

      <CohortHeader
        /*
         * `ovw-money-title` is the id the page's jump bar scrolls to — SECTIONS
         * in `overview-page.tsx` names it — and no element carried it, so
         * `getElementById` returned null and the "Cost" button silently did
         * nothing. The two loading shapes above carry the same id for the same
         * reason: a jump target that exists only once the payload lands is a
         * control that works intermittently.
         */
        id="ovw-money-title"
        title="Financial status"
        total={data.cohortTotal}
        measure={measure}
        filterChips={filterChips}
        subtitle={SPEND_SUBTITLE}
        action={
          /*
            §3.3's Period / Annual toggle. Annual is a rolling twelve months
            ending today and IGNORES the page range, so the header says so
            wherever it applies: the two modes cannot be told apart from the
            figures alone, which is exactly why the brief asks for the label.
          */
          <fieldset className="ova-switch">
            <legend className="visually-hidden">Which window the headline figures cover</legend>
            <button
              type="button"
              className="ova-switch__button"
              aria-pressed={basis === "period"}
              onClick={() => setBasis("period")}
            >
              Period
            </button>
            <button
              type="button"
              className="ova-switch__button"
              aria-pressed={basis === "annual"}
              onClick={() => setBasis("annual")}
              disabled={data.annual === null}
            >
              Annual
            </button>
          </fieldset>
        }
      />

      <p className="ova-definition">{SPEND_DEFINITION}</p>

      {/* ── 1. Coverage, read first — §3.2 ─────────────────────────────── */}
      <CoverageStrip
        recorded={data.costedJobs}
        total={data.cohortTotal}
        label="Jobs with a cost recorded"
        actionLabel="Add missing costs →"
        onAction={() => onOpenRecords("no_cost")}
        banner={banner}
      />

      {/* ── 2. The four headline figures — §3.3 ────────────────────────── */}
      <section className="ova-section">
        <div className="ova-section__head">
          <h3 className="ova-section__title">
            {annual ? "Recorded spend — rolling 12 months" : "Recorded spend in this period"}
          </h3>
          <p className="ova-section__meta">
            {annual
              ? `${annual.from} to ${annual.to} — the page date range does not apply`
              : `${data.period.label} · ${BASED_ON}`}
          </p>
        </div>

        <div className={`ova-tiles${annual ? " ova-tiles--three" : ""}`} title={BASED_ON}>
          <MetricTile
            label="Recorded spend"
            value={money(spendPence)}
            accessibleValue={exact(spendPence)}
            accent={tealScale(0)}
            /*
              The comparison is a FOOTNOTE rather than `MetricTile`'s own arrow,
              because the tile formats a delta with `deltaText`, which prints a
              bare integer — "Up 534200" for a pence figure. Until the tile can
              take a formatter, the change is written out in the unit the reader
              is looking at. The exact figure rides here too, so an abbreviated
              "£5.3k" on a phone always has its full value on screen (§1.8) and
              not only in the accessible label.
            */
            footnote={
              annual
                ? `${formatCount(annual.costedJobs, false)} costed jobs in the rolling year. ${exact(spendPence)} exactly.`
                : data.previous
                  ? `Previous period ${exact(data.previous.totalSpendPence)}. ${exact(spendPence)} exactly.`
                  : `${exact(spendPence)} exactly. No comparable previous period.`
            }
          />

          <MetricTile
            label="Jobs with cost"
            value={costedJobs}
            accent={tealScale(1)}
            share={annual ? null : coverageShare}
            delta={annual || !data.previous ? null : data.costedJobs - data.previous.costedJobs}
            previous={annual || !data.previous ? null : data.previous.costedJobs}
            footnote={
              annual
                ? "Rolling twelve months. Coverage is a share of the page range and is not shown here."
                : `of ${formatCount(data.cohortTotal, false)} in the cohort`
            }
            onSelect={() => onOpenRecords("no_cost")}
          />

          {annual ? null : (
            <MetricTile
              label="Median cost per job"
              value={data.medianCostPence === null ? null : money(data.medianCostPence)}
              accessibleValue={
                data.medianCostPence === null ? "no cost data" : exact(data.medianCostPence)
              }
              accent={tealScale(2)}
              footnote={
                data.medianCostPence === null
                  ? "No job in this period has a cost recorded."
                  : `A median, not an average. Previous period ${
                      previousMedian === null ? "not comparable" : exact(previousMedian)
                    }.`
              }
            />
          )}

          {annual ? null : (
            <MetricTile
              label="Largest single job"
              value={largest === null ? null : money(largest.spendPence)}
              accessibleValue={largest === null ? "no cost data" : exact(largest.spendPence)}
              accent={tealScale(3)}
              footnote={
                largest === null
                  ? "No job in this period has a cost recorded."
                  : `${largest.reference ? `${largest.reference} · ` : ""}${largest.title}`
              }
              onSelect={largest === null ? undefined : () => onOpenJob(largest.id)}
            />
          )}
        </div>

        {annual ? (
          <p className="ova-note">
            The median cost per job and the largest single job are computed for the page range
            only. Switch back to Period to read them. Everything below this row always follows the
            page range.
          </p>
        ) : null}
      </section>

      {/* ── 3. The spend trend — §3.3 ──────────────────────────────────── */}
      <section className="ova-section">
        <div className="ova-section__head">
          <h3 className="ova-section__title">Spend trend</h3>
          <p className="ova-section__meta">
            {data.period.label} · {data.bucketing} buckets
            {annual ? " · the page range, not the rolling year" : ""}
          </p>
        </div>
        <ChartFrame
          empty={trendEmpty}
          emptyLabel="No spend is recorded in any bucket of this range."
          minHeight={240}
          table={{
            caption: `Recorded spend and jobs with a cost recorded, ${data.bucketing}`,
            head: ["Period", "Recorded spend", "Jobs with cost", "Status"],
            rows: data.trend.map((bucket) => [
              bucket.label,
              formatMoneyPence(bucket.spendPence, false),
              bucket.costedJobs,
              bucket.partial ? "Still running" : "Complete",
            ]),
          }}
        >
          <TimeSeries
            label="Recorded spend by period, with the count of jobs carrying a cost"
            buckets={data.trend.map((bucket) => ({
              label: bucket.label,
              start: bucket.start,
              endInclusive: bucket.endInclusive,
              partial: bucket.partial,
              sample: bucket.costedJobs,
            }))}
            columns={[
              { key: "spend", label: "Recorded spend", colour: tealScale(1), values: trendPounds },
            ]}
            /*
              §3.3 — "plus a thin line for the jobs-with-cost count, so a spend
              spike caused by more jobs is distinguishable from one caused by
              dearer jobs". Pounds and job counts are two units, and
              `TimeSeries` gives each its own ceiling for exactly that reason.
            */
            lines={[
              {
                key: "jobs",
                label: "Jobs with cost",
                colour: tealScale(5),
                values: data.trend.map((bucket) => bucket.costedJobs),
              },
            ]}
            formatValue={(value, seriesKey) =>
              seriesKey === "spend"
                ? formatMoneyPence(Math.round(value * 100), abbreviate)
                : formatCount(value, false)
            }
            onSelectBucket={(bucket) =>
              onDrill({ period: "custom", from: bucket.start, to: bucket.endInclusive })
            }
          />
        </ChartFrame>
      </section>

      {/* ── 4. Spend by site — §3.4 ────────────────────────────────────── */}
      <section className="ova-section">
        <div className="ova-section__head">
          <h3 className="ova-section__title">Spend by site</h3>
          <p className="ova-section__meta">
            {money(namedSpend)} across {plural(namedSites.length, "site")} · percentages are a
            share of that
          </p>
        </div>
        {data.portfolioMedianPence === null ? null : (
          <p className="ova-median__key">
            <span className="ova-median__swatch" aria-hidden="true" />
            Portfolio median {exact(data.portfolioMedianPence)} per job, marked on every median
            track below
          </p>
        )}
        <ChartFrame
          empty={namedSites.length === 0}
          emptyLabel="No site in this period carries a job."
          minHeight={200}
          table={{
            caption: `Spend by site — ${formatMoneyPence(namedSpend, false)} across ${namedSites.length} sites`,
            head: ["Site", "Spend", "Jobs with cost", "Median per job", "Coverage"],
            rows: namedSites.map((site) => [
              site.siteName,
              site.costedJobs === 0 ? "No cost data" : formatMoneyPence(site.spendPence, false),
              site.costedJobs,
              site.medianPence === null ? "No cost data" : formatMoneyPence(site.medianPence, false),
              `${site.coveragePercent}%`,
            ]),
          }}
        >
          <RankedBars
            rows={namedSites.map((site, index): RankedRow => ({
              key: site.siteId,
              label: site.siteName,
              value: site.spendPence,
              share: siteShares[index],
              colour: tealScale(index),
              /*
                §3.4 — a site with no costed job reads "No cost data", never £0,
                and carries no percentage: it was never in the denominator. The
                unfilled bar says the same thing a second way.
              */
              notRecorded: site.costedJobs === 0,
              muted: site.costedJobs === 0,
              suffix: siteSuffix(site),
            }))}
            /*
              The one case this cannot separate — a site whose only costed job
              was entered at £0.00 — is named in the data-quality row beneath as
              a zero or negative cost, and its own suffix still reads "1 job
              with cost", so the row never claims to have no data.
            */
            format={(value) => (value <= 0 ? "No cost data" : money(value))}
            onSelect={(key) => onToggle("site", key)}
            onDrill={(key) => onDrill({ site: key })}
          />
        </ChartFrame>
        {unassignedSite && (unassignedSite.spendPence > 0 || unassignedSite.jobsInCohort > 0) ? (
          <p className="ova-note">
            {unassignedSite.spendPence > 0
              ? `${exact(unassignedSite.spendPence)} of the headline is recorded against `
              : "No spend is recorded against "}
            {plural(unassignedSite.jobsInCohort, "job")} with no site in the register, so it is not
            ranked above.{" "}
            <button type="button" className="ops-link" onClick={() => onOpenRecords("no_site")}>
              Fix these →
            </button>
          </p>
        ) : null}
      </section>

      {/* ── 5. Where the money goes — §3.5 ─────────────────────────────── */}
      <section className="ova-section">
        <div className="ova-section__head">
          <h3 className="ova-section__title">Where the money goes</h3>
          <p className="ova-section__meta">{BASED_ON}</p>
        </div>
        <div className="ova-money">
          <MoneyBreakdown
            dimension={data.byLabel}
            abbreviate={abbreviate}
            onSelect={(key) => {
              /*
                "Other" is the tail of the ranking summed by the aggregate, not
                a label anybody typed, so there is no filter value it maps to.
                Ignoring it is honest; sending `label=__other__` would filter the
                page to nothing and read as a broken chart.
              */
              if (key.startsWith("__")) return;
              onToggle("label", key);
            }}
          />
        </div>
        <div className="ova-money ova-money--pair">
          <MoneyBreakdown
            dimension={data.byTier}
            abbreviate={abbreviate}
            onSelect={(key) => {
              if (key.startsWith("__")) return;
              onToggle("tier", key);
            }}
          />
          <MoneyBreakdown
            dimension={data.byEngineer}
            abbreviate={abbreviate}
            onSelect={(key) => {
              if (key.startsWith("__")) return;
              onToggle("engineer", key);
            }}
          />
        </div>
        {spendConcentration(data.byLabel) ? (
          <p className="ova-note ova-note--derived">{spendConcentration(data.byLabel)}</p>
        ) : null}
      </section>

      {/* ── 6. Contractor spend — §3.6 ─────────────────────────────────── */}
      <section className="ova-section">
        <div className="ova-section__head">
          <h3 className="ova-section__title">Contractor spend</h3>
        </div>
        <div className="ova-attribution">
          {/*
            §3.6's sentence, with all three figures on screen. "12%" with no
            denominator is what let this problem sit unfixed for a year, and
            §1.4 forbids printing it that way.
          */}
          <p className="ova-attribution__line">
            {exact(data.contractorAttributedPence)} of {exact(data.totalSpendPence)} (
            {attributionShare}%) names a contractor. {exact(data.contractorLinkedPence)} is
            attributed to a contractor record.
          </p>
          <ProgressMeter
            value={data.contractorAttributedPence}
            max={Math.max(1, data.totalSpendPence)}
            tone={tealScale(1)}
            label={`${exact(data.contractorAttributedPence)} of ${exact(data.totalSpendPence)} names a contractor`}
          />
          <div className="ova-actions">
            <button type="button" className="ova-action" onClick={onOpenResolveNames}>
              Resolve names →
            </button>
          </div>
        </div>
        <ChartFrame
          empty={data.contractors.length === 0}
          emptyLabel="No costed job in this period names a contractor."
          minHeight={180}
          table={{
            caption: "Contractor spend in this period",
            head: ["Contractor", "Spend", "Jobs", "Linked to a record"],
            rows: data.contractors.map((row) => [
              row.name,
              formatMoneyPence(row.spendPence, false),
              row.jobs,
              row.linked ? "Linked" : "Not linked",
            ]),
          }}
        >
          <RankedBars
            rows={data.contractors.map((row, index): RankedRow => ({
              key: row.key,
              label: row.name,
              value: row.spendPence,
              share: contractorShares[index],
              colour: tealScale(index),
              /* §3.6 — muted, with no bar fill, so it never reads as verified. */
              muted: !row.linked,
              suffix: (
                <span className="ova-rowstat">
                  <span className="ova-rowstat__facts">
                    {/*
                      BOTH cases carry a chip. One that appeared only on
                      failures would teach the reader that a row without one had
                      never been checked.
                    */}
                    <StatusChip
                      tone={row.linked ? tealScale(1) : NOT_RECORDED_INK}
                      size="small"
                      title={
                        row.linked
                          ? "Attributed to a contractor record"
                          : "Free text on the job, with no contractor record behind it"
                      }
                    >
                      {row.linked ? "Linked" : "Not linked"}
                    </StatusChip>
                    <span>
                      <b>{formatCount(row.jobs, false)}</b> {row.jobs === 1 ? "job" : "jobs"}
                    </span>
                  </span>
                </span>
              ),
            }))}
            format={money}
            onSelect={(key) => onToggle("contractor", key)}
            onDrill={(key) => onDrill({ contractor: key })}
          />
        </ChartFrame>
      </section>

      {/* ── 7. Data quality — §3.7 ─────────────────────────────────────── */}
      <div className="ova-foot">
        <DataQualityRow
          items={[
            {
              key: "completed_without_cost",
              count: data.dataQuality.completedWithoutCost,
              sentence: "completed jobs have no cost recorded.",
              actionLabel: "Fix these →",
              onAction: () => onOpenRecords("completed_without_cost"),
            },
            {
              key: "cost_without_contractor",
              count: data.dataQuality.costWithoutContractor,
              sentence: "jobs have a cost but no contractor named.",
              actionLabel: "Fix these →",
              onAction: () => onOpenRecords("cost_without_contractor"),
            },
            {
              key: "unlinked_names",
              count: data.dataQuality.unlinkedNames,
              sentence: "contractor names have no contractor record behind them.",
              actionLabel: "Resolve names →",
              onAction: onOpenResolveNames,
            },
            {
              key: "zero_or_negative",
              count: data.dataQuality.zeroOrNegative,
              sentence: "jobs have a zero or negative cost.",
              actionLabel: "Fix these →",
              onAction: () => onOpenRecords("zero_or_negative_cost"),
            },
          ]}
        />
        {data.costedJobs === 0 ? (
          <EmptyState>
            No job in this period has a cost recorded, so there is no spend to break down. The
            figures above are zero because nothing was entered, not because nothing was spent.
          </EmptyState>
        ) : null}
      </div>
    </section>
  );
}
