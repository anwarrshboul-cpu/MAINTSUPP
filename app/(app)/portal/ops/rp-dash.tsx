"use client";

/**
 * SPEND AND REPORTING — the dashboard block at the top of the Reports page.
 *
 * Four spend KPIs, the spend trend, the top sites by spend and the repeat
 * activity widget, all drawn from ONE call to `/api/reports/metrics`. The
 * endpoint counts the whole block in one pass from one snapshot — every pound is
 * `maintenance_requests.cost` of a COMPLETED job, dated by its completion day,
 * which is the Overview spend trend's basis through the same query — and it
 * reconciles the brief's §5.3 identities before it answers. So the four KPIs,
 * the trend and the site bars cannot disagree with each other, or with the
 * Overview, about what a month cost.
 *
 * ── THIS FILE COMPOSES; IT DOES NOT COMPUTE ───────────────────────────────
 *
 * It is never given a job list and so cannot recount one. Every figure on
 * screen is a field of the payload; what this file adds is presentation — how a
 * number is written, which label an axis carries, which colour an arc is — and
 * the drill queries at the bottom, which only COPY the window and the keys a
 * figure was counted with.
 *
 * ── THE COMPANION OF `ov-dash.tsx` ────────────────────────────────────────
 *
 * The root is `.ov-dash.rp-dash`: `.ov-dash` is the design system's root (see
 * the header of `ov-dash.css`) and supplies every token, card, legend, tooltip,
 * gauge and ring rule; `rp-dash.css` adds only the brief's `--rp-*` accents and
 * this block's own grids. The header row is the shared `DashHeader`, and the
 * trend, speedometer, donuts and ring meters are the Overview's own charts, so
 * the blocks look and behave as one product.
 *
 * ── WHAT IT REFUSES TO DO ─────────────────────────────────────────────────
 *
 * No table and no text list — the crossed-out repeat table is replaced by a
 * gauge, two donuts and four rings. Every figure is a link to the jobs it was
 * counted from, carrying exactly that figure's filter and nothing else: an
 * unread or extra parameter would open a list whose count is not the number the
 * reader tapped, which `board-drill-filter.ts` exists to prevent.
 */

import { useCallback, useEffect, useId, useMemo, type CSSProperties, type ReactNode } from "react";
import ovDashCss from "./ov-dash.css?url";
import rpDashCss from "./rp-dash.css?url";
import { DashHeader } from "./dash-header";
import { useOpsQuery, useQueryState } from "./ops-url-state";
import { AreaTrend, Donut, RingMeter, Speedometer, ovPercent, ovPoundsExact, type OvSlice } from "./ov-dash-charts";
import {
  RpSiteBars,
  RpSparkline,
  rpCount,
  rpJobs,
  rpPounds,
  useRpMediaQuery,
} from "./rp-dash-charts";
/* Imports nothing itself, so it cannot drag the query builder into this bundle. */
import { rateTone } from "../../../lib/dashboard-policy";
/*
 * TYPES ONLY. The contract module has no imports of any kind for exactly this
 * reason — a client component must not reach the query builder — and
 * `import type` is erased entirely, so even that module never ships.
 */
import type {
  RpBand,
  RpDelta,
  RpKpi,
  RpMetrics,
  RpSitesRange,
  RpSpendSlice,
  RpTrendRange,
} from "../../../lib/reports-dash-contract";

/* ── Configuration ────────────────────────────────────────────────────────── */

/** §5.4: poll while the tab is visible. Sixty seconds, as the brief asks. */
const REFRESH_INTERVAL_MS = 60_000;

/** The real routes, from `sectionRoutes` in `portal-app.tsx`. */
const ROUTE = {
  jobs: "/dashboard/jobs",
  sites: "/dashboard/sites",
} as const;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/*
 * THE CARD SELECTORS — each card's own window, in the address bar.
 *
 * The defaults are omitted from the URL rather than written, so an untouched
 * page keeps a clean address; the server applies the same defaults.
 */
const TREND_RANGES: ReadonlyArray<{ value: RpTrendRange; label: string }> = [
  { value: "3m", label: "Last 3 months" },
  { value: "6m", label: "Last 6 months" },
  { value: "12m", label: "Last 12 months" },
  { value: "ytd", label: "This year" },
];
const TREND_DEFAULT: RpTrendRange = "6m";

const SITES_RANGES: ReadonlyArray<{ value: RpSitesRange; label: string }> = [
  { value: "page", label: "Date range" },
  { value: "month", label: "This month" },
  { value: "3m", label: "Last 3 months" },
  { value: "ytd", label: "This year" },
];
const SITES_DEFAULT: RpSitesRange = "page";

/**
 * Each KPI's accent, as the brief's token, BY THE JOB TYPE'S STABLE CODE. The
 * payload does not colour the KPIs — they are not slices — so the card names
 * its token and `rp-dash.css` holds the value. Keyed on the code rather than
 * the label, so renaming "Project" to "Capital works" keeps its green.
 */
const KPI_ACCENT: Record<RpKpi["key"], string> = {
  total: "var(--rp-total)",
  reactive: "var(--rp-reactive)",
  planned: "var(--rp-planned)",
  project: "var(--rp-projects)",
};

/**
 * THE REPEAT-RATE ARC, FROM THE SHARED POLICY — never a threshold typed here.
 *
 * `rateTone` reads the payload's own `policy.repeatThresholds`, which the
 * server echoes from `REPEAT_RATE_ARC` in `dashboard-policy.ts`. LOWER IS
 * BETTER: teal at or under `good`, amber to `warn`, red above.
 */
const TONE_COLOUR = {
  good: "var(--ov-teal)",
  warn: "var(--rp-fortnightly)",
  poor: "var(--rp-weekly)",
} as const;

/** The brief's repeat donut: ~150px, 18px ring, 2px gaps between segments. */
const REPEAT_DONUT = { box: 150, radius: 66, stroke: 18 } as const;

/* ── Small helpers ────────────────────────────────────────────────────────── */

function pick<T extends string>(
  value: string | null,
  options: ReadonlyArray<{ value: T }>,
  fallback: T,
): T {
  return options.find((option) => option.value === value)?.value ?? fallback;
}

function plural(value: number, one: string, many: string): string {
  return `${rpCount(value)} ${value === 1 ? one : many}`;
}

/** "Aug 2026" from "vs Aug 2026" — for a sentence that already says "than". */
function periodName(comparedWith: string): string {
  return comparedWith.replace(/^vs\s+/i, "");
}

/** The delta as a sentence, for an accessible name. */
function deltaSentence(delta: RpDelta): string {
  const magnitude = Math.abs(delta.percent ?? 0);
  switch (delta.direction) {
    case "up":
      return `up ${magnitude}% ${delta.comparedWith}`;
    case "down":
      return `down ${magnitude}% ${delta.comparedWith}`;
    case "flat":
      return `no change ${delta.comparedWith}`;
    case "new":
      return `new: nothing was spent in ${periodName(delta.comparedWith)}`;
    case "none":
    default:
      return `nothing spent in either period (${periodName(delta.comparedWith)})`;
  }
}

/* ── The block ────────────────────────────────────────────────────────────── */

export function RpDash({
  onNavigateToJobs,
  onNavigateToSite,
}: {
  /** The shell's own Jobs navigation: section first, then the filtered address. */
  onNavigateToJobs: (query: string) => void;
  /** A site's detail page. */
  onNavigateToSite: (siteId: string) => void;
}) {
  const { params, setParams } = useQueryState();

  /*
   * THE SIX PARAMETERS THIS BLOCK OWNS, AND NOTHING ELSE.
   *
   * The fetch key is rebuilt from these alone rather than from
   * `window.location.search`: the Reports page below keeps its own tab hash and
   * its own controls in the same address bar, this endpoint reads none of them,
   * and including them would refetch the block for a control that cannot change
   * a figure in it. `reportPeriod=month:YYYY-MM` is how the Overview's spend
   * trend drills here; it is passed through untouched and the SERVER resolves it
   * to that month when `from`/`to` are absent.
   */
  const portfolio = params.get("portfolio") ?? "";
  const fromParam = params.get("from") ?? "";
  const toParam = params.get("to") ?? "";
  const reportPeriod = (params.get("reportPeriod") ?? "").trim();
  const trendRange = pick(params.get("trendRange"), TREND_RANGES, TREND_DEFAULT);
  const sitesRange = pick(params.get("sitesRange"), SITES_RANGES, SITES_DEFAULT);

  const search = useMemo(() => {
    const next = new URLSearchParams();
    if (portfolio) next.set("portfolio", portfolio);
    if (DAY_PATTERN.test(fromParam)) next.set("from", fromParam);
    if (DAY_PATTERN.test(toParam)) next.set("to", toParam);
    if (reportPeriod) next.set("reportPeriod", reportPeriod);
    if (trendRange !== TREND_DEFAULT) next.set("trendRange", trendRange);
    if (sitesRange !== SITES_DEFAULT) next.set("sitesRange", sitesRange);
    return next.toString();
  }, [portfolio, fromParam, toParam, reportPeriod, trendRange, sitesRange]);

  /*
   * One round trip for the whole block. `useOpsQuery` keeps the previous
   * payload on screen while the next is in flight and, with `keepOnError`,
   * through a failed poll — §5.4's "keep previous values visible during
   * refetch; no flicker to zero". The skeleton is only for the one render where
   * there is genuinely nothing yet. It also answers the topbar's Refresh.
   */
  const { data, loading, error, reload } = useOpsQuery<RpMetrics>("/api/reports/metrics", search, {
    keepOnError: true,
  });

  /*
   * §5.4 — REFETCH ON FOCUS, AND POLL WHILE VISIBLE.
   *
   * There is no realtime transport in this application, so freshness is a poll,
   * and it is bounded: the interval and both listeners check
   * `document.visibilityState` first, so a tab left open overnight on a second
   * monitor issues no requests at all. `reload` is `useOpsQuery`'s stable
   * callback, called from a listener and a timer and never during the effect.
   */
  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    const timer = window.setInterval(refreshIfVisible, REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.clearInterval(timer);
    };
  }, [reload]);

  /** Mutate the address bar without disturbing a parameter another surface owns. */
  const setFilter = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(window.location.search);
      mutate(next);
      setParams(next);
    },
    [setParams],
  );

  /*
   * THE PORTFOLIO TRAVELS WITH EVERY DRILL, AS THE SITES IT IS MADE OF.
   *
   * A portfolio is a `site_groups` row and the board's filter speaks `site=`,
   * so the payload names the chosen portfolio's member sites and every drill
   * that does not already name a site carries them. Empty for "All
   * portfolios", where there is nothing to narrow.
   */
  const portfolioSites = useMemo(() => data?.portfolio.siteIds ?? [], [data]);

  /*
   * The trend's axis: the brief's "Dec 2024 … May 2025" where six month names
   * fit, the short "Dec" where they cannot. Six long labels need ~270px and a
   * phone's plot is ~250px, and twelve need ~540px, which the desktop half-width
   * card does not have. Presentation only — the tooltip names the full month
   * either way.
   */
  const wide = useRpMediaQuery("(min-width: 768px)");

  const goToJobs = useCallback((query: string) => onNavigateToJobs(query), [onNavigateToJobs]);
  const sparkHelp = useId();

  /* ── The header, usable before the first payload lands ─────────────────── */

  /*
   * THE EXPORT IS THE SERVER'S. `?format=csv` on the same endpoint, under the
   * same six keys, writes every job cost line under the current filters and the
   * block's metrics — §5.5 — so the file can never disagree with the screen it
   * was taken from. A real link, so the browser's own download handles it.
   */
  const exportHref = `/api/reports/metrics?format=csv${search ? `&${search}` : ""}`;

  const header = (
    <DashHeader
      title="Spend and reporting"
      portfolio={portfolio}
      portfolios={data?.portfolios ?? []}
      onPortfolio={(next) =>
        setFilter((query) => {
          if (next) query.set("portfolio", next);
          else query.delete("portfolio");
        })
      }
      /*
        The picker shows the window the figures were COUNTED over — the
        server's resolution of whatever was asked for, including a
        `reportPeriod` month — so editing one bound keeps the other rather than
        silently dropping it.
      */
      range={{
        from: fromParam || data?.range.from || "",
        to: toParam || data?.range.to || "",
        label: data?.range.label ?? "Date range",
      }}
      onRange={(nextFrom, nextTo) =>
        setFilter((query) => {
          if (nextFrom) query.set("from", nextFrom);
          else query.delete("from");
          if (nextTo) query.set("to", nextTo);
          else query.delete("to");
          /* A chosen range replaces a drilled-in month; left behind, the month
             would win again on the next visit without a from/to. */
          query.delete("reportPeriod");
        })
      }
      resetLabel="Reset to this month"
      exportHref={exportHref}
      exportDisabled={!data}
      /* A refetch that failed while figures are on screen: they stay, and the
         reason is one press away. */
      error={data ? error : null}
      onRetry={reload}
    />
  );

  if (!data) {
    return (
      <>
        <link rel="stylesheet" href={ovDashCss} precedence="default" />
        <link rel="stylesheet" href={rpDashCss} precedence="default" />
        <section className="ov-dash rp-dash" aria-busy={loading} aria-label="Spend and reporting">
          {header}
          {error ? (
            <div className="ov-card rp-error" role="alert">
              <p>{error}</p>
              <button type="button" className="ov-card__link" onClick={reload}>
                Try again
              </button>
            </div>
          ) : (
            <>
              <div className="rp-kpis">
                {[0, 1, 2, 3].map((slot) => (
                  <div key={slot} className="rp-kpi ov-skeleton" />
                ))}
              </div>
              <div className="rp-row2">
                <div className="ov-card ov-skeleton rp-skeleton--tall" />
                <div className="ov-card ov-skeleton rp-skeleton--tall" />
              </div>
              <div className="ov-card ov-skeleton rp-skeleton--tall" />
            </>
          )}
        </section>
      </>
    );
  }

  const { kpis, range, repeat, topSites, trend, other, unclassified } = data;
  const scope = { from: range.from, to: range.to };

  /* ── The destinations ─────────────────────────────────────────────────── */

  const jobsHref = (query: string) => (query ? `${ROUTE.jobs}?${query}` : ROUTE.jobs);
  const siteHref = (siteId: string) => `${ROUTE.sites}?site=${encodeURIComponent(siteId)}`;
  const repeatQuery = rpRepeatQuery(scope, portfolioSites);

  /*
   * The breakdown the total card's tooltip and accessible name state: every
   * type card by its CURRENT label, then the two buckets no card claims — so
   * the five figures a reader is shown add up to the one on the card.
   */
  const breakdown = `${kpis
    .filter((kpi) => kpi.key !== "total")
    .map((kpi) => `${kpi.label} ${rpPounds(kpi.pence)}`)
    .join(" · ")}${kpis.length > 1 ? " · " : ""}${other.label} ${rpPounds(other.pence)} · Unclassified ${rpPounds(unclassified.pence)}`;
  /*
   * OTHER AND UNCLASSIFIED, DRILLABLE. Neither has a card — the brief draws
   * four — but neither is dropped: each one with spend in the range gets a link
   * under the KPI row that opens exactly its jobs (`type=__other__` /
   * `type=__unclassified__`), the same way a card does.
   */
  const typeGaps = [unclassified, other].filter((bucket) => bucket.jobs > 0);

  /* ── The spend trend's points, as `AreaTrend` wants them ──────────────── */

  const longAxis = wide && trend.points.length <= 6;
  /* A named local, so the extra fields ride along without excess-property checks. */
  const trendPoints = trend.points.map((point) => ({
    label: longAxis ? point.longLabel : point.label,
    pence: point.pence,
    jobs: point.jobs,
    longLabel: point.longLabel,
  }));
  const trendReadout = trend.points
    .map((point) => `${point.longLabel} ${rpPounds(point.pence)} (${rpJobs(point.jobs)})`)
    .join(", ");

  /* ── Top sites ────────────────────────────────────────────────────────── */

  const siteRows = topSites.rows.map((row) => ({
    key: row.siteId,
    name: row.name,
    pence: row.pence,
    jobs: row.jobs,
    siteHref: siteHref(row.siteId),
    drillHref: jobsHref(rpSiteBarQuery(row.siteId, topSites)),
  }));
  const sitesTotalLabel = `the ${rpPounds(topSites.totalPence)} spent in ${topSites.label}`;
  const reconcileText = `${
    topSites.siteCount === 1
      ? "1 site"
      : topSites.siteCount === 0
        ? "Sites"
        : `All ${rpCount(topSites.siteCount)} sites`
  } ${rpPounds(topSites.sitesPence)} · No site ${rpPounds(topSites.noSite.pence)}`;

  /* ── Repeat activity ──────────────────────────────────────────────────── */

  const repeatTone = rateTone(repeat.percent, data.policy.repeatThresholds);
  const repeatSub = `${plural(repeat.repeatJobs, "repeat job", "repeat jobs")} across ${plural(
    repeat.sitesAffected,
    "site",
    "sites",
  )}`;
  const slicesJobs = (slices: readonly RpSpendSlice[], slice: OvSlice) =>
    slices.find((candidate) => candidate.key === slice.key)?.jobs ?? 0;
  const repeatTip = (slices: readonly RpSpendSlice[]) => (slice: OvSlice, share: number) => [
    ovPoundsExact(slice.value),
    `${Math.round(share * 100)}% of repeat spend`,
    plural(slicesJobs(slices, slice), "repeat job", "repeat jobs"),
  ];
  const bandsReadout = repeat.bands
    .map((band) => `${band.label} ${plural(band.value, "pattern", "patterns")}, ${plural(band.jobs, "repeat job", "repeat jobs")}`)
    .join("; ");

  return (
    <>
      <link rel="stylesheet" href={ovDashCss} precedence="default" />
      <link rel="stylesheet" href={rpDashCss} precedence="default" />
      <section className="ov-dash rp-dash" aria-busy={loading} aria-label="Spend and reporting">
        {header}

        {/* ── Row 1: the four spend figures ─────────────────────────────── */}
        <div className="rp-kpis">
          {kpis.map((kpi) => {
            /* The type's stable id, never its words — a rename keeps the link. */
            const query = rpKpiQuery(kpi.drillType, scope, portfolioSites);
            const isTotal = kpi.key === "total";
            const spendWord = isTotal ? "jobs with completed cost" : `${kpi.label.toLowerCase()} jobs with completed cost`;
            const describedBy = `${sparkHelp}-${kpi.key}`;
            return (
              <RpLink
                key={kpi.key}
                className={`rp-kpi rp-kpi--${kpi.key}`}
                href={jobsHref(query)}
                onActivate={() => goToJobs(query)}
                label={`${kpi.label}: ${rpPounds(kpi.pence)} from ${rpJobs(kpi.jobs)}, ${deltaSentence(kpi.delta)}.${
                  isTotal ? ` ${breakdown}.` : ""
                } Opens the ${spendWord} in ${range.label}.`}
                describedBy={describedBy}
                style={{ "--rp-accent": KPI_ACCENT[kpi.key] } as CSSProperties}
              >
                <span className="rp-kpi__tile" aria-hidden="true">
                  <KpiIcon name={kpi.key} />
                </span>
                <span className="rp-kpi__label">{kpi.label}</span>
                <span className="rp-kpi__value" title={isTotal ? breakdown : ovPoundsExact(kpi.pence)}>
                  {rpPounds(kpi.pence)}
                </span>
                <DeltaText delta={kpi.delta} className="rp-kpi__delta" />
                <div className="rp-kpi__spark" id={describedBy}>
                  <RpSparkline
                    points={kpi.spark}
                    colour={KPI_ACCENT[kpi.key]}
                    totalPence={kpi.pence}
                    ariaLabel={`${kpi.label} by ${data.sparkUnit}: ${
                      kpi.spark.map((point) => `${point.label} ${rpPounds(point.pence)}`).join(", ") || "no data"
                    }`}
                  />
                </div>
              </RpLink>
            );
          })}
        </div>
        {typeGaps.length > 0 ? (
          <p className="rp-kpis__gaps">
            <span className="rp-kpis__gaps-lead">Not on a type card:</span>
            {typeGaps.map((bucket) => {
              const query = rpKpiQuery(bucket.drillType, scope, portfolioSites);
              const what =
                bucket.key === "unclassified"
                  ? "with no job type"
                  : `of other job types${bucket.typeLabels.length ? ` (${bucket.typeLabels.join(", ")})` : ""}`;
              return (
                <RpLink
                  key={bucket.key}
                  className="rp-kpis__gap"
                  href={jobsHref(query)}
                  onActivate={() => goToJobs(query)}
                  label={`${bucket.label}: ${rpPounds(bucket.pence)} from ${rpJobs(bucket.jobs)} ${what}, ${deltaSentence(
                    bucket.delta,
                  )}. Opens those jobs with completed cost in ${range.label}.`}
                >
                  {bucket.label} {rpPounds(bucket.pence)}
                </RpLink>
              );
            })}
          </p>
        ) : null}

        {/* ── Row 2: the spend trend, and the top sites ─────────────────── */}
        <div className="rp-row2">
          <section className="ov-card rp-trend-card">
            <div className="ov-card__head">
              <h3 className="ov-card__title">Spend trend</h3>
              <CardSelect
                label="Spend trend window"
                value={trendRange}
                options={TREND_RANGES}
                onChange={(next) =>
                  setFilter((query) => {
                    if (next === TREND_DEFAULT) query.delete("trendRange");
                    else query.set("trendRange", next);
                  })
                }
              />
            </div>
            <div className="rp-trend__figure">
              <span className="rp-trend__total" title={ovPoundsExact(trend.totalPence)}>
                {rpPounds(trend.totalPence)}
              </span>
              <span className="rp-trend__caption">
                <span className="rp-trend__caption-label">Total spend</span>
                <DeltaText delta={trend.delta} />
              </span>
            </div>
            <div className="rp-trend">
              <AreaTrend
                points={trendPoints}
                lineColour="var(--rp-line)"
                /* The brief's `--rp-area-top` is the turquoise rgb(18 180 168)
                   at 35% — the line is the brighter `--rp-line` over it. */
                areaColour="var(--ov-teal)"
                tipLines={(point, index, share) => {
                  const source = trendPoints[index];
                  return [
                    ...(source && point.label !== source.longLabel ? [source.longLabel] : []),
                    ovPoundsExact(point.pence),
                    `${Math.round(share * 100)}% of total`,
                    rpJobs(source?.jobs ?? 0),
                  ];
                }}
                onSelect={(_point, index) => {
                  const source = trend.points[index];
                  if (source) goToJobs(rpTrendQuery(source, portfolioSites));
                }}
                ariaLabel={`Spend by month, ${trend.label}, ${rpPounds(trend.totalPence)} in total. ${trendReadout}. Selecting a month opens its jobs with completed cost`}
              />
            </div>
          </section>

          <section className="ov-card rp-sites-card">
            <div className="ov-card__head">
              <h3 className="ov-card__title">Top sites by spend</h3>
              <CardSelect
                label="Top sites window"
                value={sitesRange}
                options={SITES_RANGES}
                onChange={(next) =>
                  setFilter((query) => {
                    if (next === SITES_DEFAULT) query.delete("sitesRange");
                    else query.set("sitesRange", next);
                  })
                }
              />
            </div>
            <RpSiteBars
              rows={siteRows}
              totalPence={topSites.totalPence}
              totalLabel={sitesTotalLabel}
              ariaLabel={`Top sites by spend, ${topSites.label}`}
              emptyText={`No site has completed spend in ${topSites.label}.`}
              onSite={(siteId) => onNavigateToSite(siteId)}
              onDrill={(siteId) => goToJobs(rpSiteBarQuery(siteId, topSites))}
            />
            {/* The card's whole range, so the top eight are not taken for the total. */}
            <p className="rp-sites__reconcile">{reconcileText}</p>
          </section>
        </div>

        {/* ── Row 3: repeat activity — the widget that replaces the table ─── */}
        <section className="ov-card rp-repeat">
          <div className="ov-card__head rp-repeat__head">
            <div className="rp-repeat__titles">
              <h3 className="ov-card__title">Repeat activity</h3>
              <p className="rp-card__caption">Issues coming back to the same site</p>
            </div>
            <RpLink
              className="ov-card__link"
              href={jobsHref(repeatQuery)}
              onActivate={() => goToJobs(repeatQuery)}
              label={`View all ${plural(repeat.repeatJobs, "repeat job", "repeat jobs")} raised in ${range.label}`}
            >
              View all repeat jobs ›
            </RpLink>
          </div>

          <div className="rp-repeat__zones">
            {/* Zone 1 — the repeat rate. Lower is better. */}
            <div className="rp-zone rp-zone--rate">
              <h4 className="rp-zone__title visually-hidden">Repeat rate</h4>
              <Speedometer
                percent={repeat.percent}
                caption="Repeat rate"
                sub={repeatSub}
                colour={TONE_COLOUR[repeatTone]}
                onSelect={() => goToJobs(repeatQuery)}
                ariaLabel={`Repeat rate — repeat jobs as a share of the ${rpJobs(repeat.jobsInRange)} raised in ${range.label}; lower is better. Opens the repeat jobs`}
              />
            </div>

            {/* Zone 2 — what is repeating. */}
            <div className="rp-zone">
              <h4 className="rp-zone__title">By issue</h4>
              <Donut
                slices={repeat.byIssue}
                total={repeat.spendPence}
                centreValue={rpPounds(repeat.spendPence)}
                caption="Repeat spend"
                geometry={REPEAT_DONUT}
                gapPx={2}
                formatValue={rpPounds}
                tipLines={repeatTip(repeat.byIssue)}
                onSelect={(slice) => goToJobs(rpRepeatIssueQuery(slice.labels, scope, portfolioSites))}
                ariaLabel="Repeat spend by issue"
              />
              <RepeatLegend
                slices={repeat.byIssue}
                emptyText="No repeat issue in this range."
                queryFor={(slice) => rpRepeatIssueQuery(slice.labels, scope, portfolioSites)}
                describe="Opens the repeat jobs for this issue"
                jobsHref={jobsHref}
                goToJobs={goToJobs}
              />
            </div>

            {/* Zone 3 — where it is repeating. The same total as zone 2. */}
            <div className="rp-zone">
              <h4 className="rp-zone__title">By site</h4>
              <Donut
                slices={repeat.bySite}
                total={repeat.spendPence}
                centreValue={rpPounds(repeat.spendPence)}
                caption="Repeat spend"
                geometry={REPEAT_DONUT}
                gapPx={2}
                formatValue={rpPounds}
                tipLines={repeatTip(repeat.bySite)}
                onSelect={(slice) => goToJobs(rpRepeatSiteQuery(slice.labels, scope))}
                ariaLabel="Repeat spend by site"
              />
              <RepeatLegend
                slices={repeat.bySite}
                emptyText="No site has repeat jobs in this range."
                queryFor={(slice) => rpRepeatSiteQuery(slice.labels, scope)}
                describe="Opens the repeat jobs at this site"
                jobsHref={jobsHref}
                goToJobs={goToJobs}
              />
            </div>

            {/* Zone 4 — how often it recurs. */}
            <div className="rp-zone rp-zone--bands">
              <h4 className="rp-zone__title">Recurrence</h4>
              <div
                className="rp-bands"
                role="group"
                aria-label={`${plural(repeat.patterns, "repeat pattern", "repeat patterns")} by how often they recur: ${bandsReadout}`}
              >
                {repeat.bands.map((band) => (
                  <RecurrenceRing
                    key={band.key}
                    band={band}
                    patterns={repeat.patterns}
                    onSelect={() => goToJobs(rpRecurrenceQuery(band.key, scope, portfolioSites))}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>
      </section>
    </>
  );
}

/* ── Pieces ───────────────────────────────────────────────────────────────── */

/**
 * The delta line — "↑ 8% vs Aug 2026".
 *
 * Up is teal and down is `--rp-down`, the brief's red lifted just far enough to
 * clear 4.5:1 as 11px text on the card (`--ov-red` measures 4.26:1, which the
 * shared palette reserves for fills). "New" replaces a percentage when the
 * previous period was £0 — a rise from nothing has no percentage — and when
 * both periods were £0 the line says so rather than printing a 0% that reads as
 * "flat".
 */
function DeltaText({ delta, className }: { delta: RpDelta; className?: string }) {
  const magnitude = Math.abs(delta.percent ?? 0);
  let change: ReactNode;
  switch (delta.direction) {
    case "up":
      change = <span className="rp-delta__change rp-delta__change--up">↑ {magnitude}%</span>;
      break;
    case "down":
      change = <span className="rp-delta__change rp-delta__change--down">↓ {magnitude}%</span>;
      break;
    case "flat":
      change = <span className="rp-delta__change rp-delta__change--flat">→ 0%</span>;
      break;
    case "new":
      change = <span className="rp-delta__change rp-delta__change--new">New</span>;
      break;
    case "none":
    default:
      change = <span className="rp-delta__change rp-delta__change--none">No change</span>;
      break;
  }
  return (
    <span className={`rp-delta${className ? ` ${className}` : ""}`}>
      {change}
      <span className="rp-delta__vs">{delta.comparedWith}</span>
    </span>
  );
}

/** A card's own window — "Last 6 months ▾". */
function CardSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <label className="rp-select">
      <span className="visually-hidden">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * A repeat donut's legend: swatch, name, pounds — each row a link to the
 * repeat jobs behind it, so every segment is reachable without a pointer.
 */
function RepeatLegend({
  slices,
  emptyText,
  queryFor,
  describe,
  jobsHref,
  goToJobs,
}: {
  slices: readonly RpSpendSlice[];
  emptyText: string;
  queryFor: (slice: RpSpendSlice) => string;
  describe: string;
  jobsHref: (query: string) => string;
  goToJobs: (query: string) => void;
}) {
  if (slices.length === 0) return <p className="rp-zone__empty">{emptyText}</p>;
  return (
    <div className="ov-legend rp-legend">
      {slices.map((slice) => {
        const query = queryFor(slice);
        return (
          <RpLink
            key={slice.key}
            className="ov-legend__row"
            href={jobsHref(query)}
            onActivate={() => goToJobs(query)}
            label={`${slice.label}: ${rpPounds(slice.value)} of repeat spend, ${plural(
              slice.jobs,
              "repeat job",
              "repeat jobs",
            )}. ${describe}.`}
          >
            <span className="ov-legend__swatch" style={{ background: slice.colour }} aria-hidden="true" />
            <span className="ov-legend__label">{slice.label}</span>
            <span className="ov-legend__value">{rpPounds(slice.value)}</span>
          </RpLink>
        );
      })}
    </div>
  );
}

/**
 * One recurrence band. The ring DRAWS patterns — its share of every repeat
 * pattern, with the pattern count in the middle, per the brief — but its drill
 * lists repeat JOBS, so the tooltip and the accessible name state both numbers
 * and the list the reader lands on matches one they were shown.
 */
function RecurrenceRing({
  band,
  patterns,
  onSelect,
}: {
  band: RpBand;
  patterns: number;
  onSelect: () => void;
}) {
  const both = `${plural(band.value, "pattern", "patterns")} · ${plural(band.jobs, "repeat job", "repeat jobs")}`;
  return (
    <RingMeter
      value={band.value}
      total={patterns}
      label={band.label}
      colour={band.colour}
      size={72}
      stroke={8}
      tipLines={[both, `${ovPercent(band.value, patterns)}% of ${plural(patterns, "pattern", "patterns")}`]}
      describe={`${both}. Opens those repeat jobs`}
      onSelect={onSelect}
    />
  );
}

/**
 * A real anchor that navigates through the shell — `OvLink`, with a
 * description slot for the KPI cards' sparkline readout.
 *
 * An `<a href>` so the address shows on hover, copies, opens in a new tab and
 * answers Enter with no key handler of our own. A plain left click is handed to
 * the shell's client-side navigation; a modifier or a middle click falls
 * through to the browser.
 */
function RpLink({
  href,
  className,
  label,
  describedBy,
  onActivate,
  style,
  children,
}: {
  href: string;
  className: string;
  label: string;
  describedBy?: string;
  onActivate: () => void;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <a
      className={className}
      href={href}
      aria-label={label}
      aria-describedby={describedBy}
      style={style}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (event.button !== 0) return;
        event.preventDefault();
        onActivate();
      }}
    >
      {children}
    </a>
  );
}

/**
 * The four outline glyphs the reference shows, by the job type's stable code.
 * Decorative — every card states its figure.
 */
function KpiIcon({ name }: { name: RpKpi["key"] }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    focusable: "false" as const,
  };
  switch (name) {
    case "total":
      /* Wallet. */
      return (
        <svg {...common}>
          <path d="M5 7.5V6.8A2.3 2.3 0 0 1 7.3 4.5h9.2a1 1 0 0 1 1 1v2" />
          <rect x="3.5" y="7.5" width="17" height="12" rx="2.4" />
          <path d="M20.5 11.2h-3.6a2.3 2.3 0 0 0 0 4.6h3.6" />
          <path d="M16.9 13.5h.1" />
        </svg>
      );
    case "reactive":
      /* Warning triangle. */
      return (
        <svg {...common}>
          <path d="M12 4 2.8 20h18.4L12 4Z" />
          <path d="M12 10v4.5M12 17.4v.2" />
        </svg>
      );
    case "planned":
      /* Calendar. */
      return (
        <svg {...common}>
          <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
          <path d="M3.5 10h17M8 3v4M16 3v4M8 14h3" />
        </svg>
      );
    case "project":
    default:
      /* Clipboard. */
      return (
        <svg {...common}>
          <rect x="5" y="5" width="14" height="16" rx="2" />
          <path d="M9 3.5h6V7H9zM8.5 11.5h7M8.5 15h7M8.5 18.2h4" />
        </svg>
      );
  }
}

/* ── THE DRILL QUERIES ────────────────────────────────────────────────────────
 *
 * What every figure on the block sends to the Jobs board, in the vocabulary
 * `readDrillFilter` (`board-drill-filter.ts`) reads:
 *
 *   spend      hasCost=1 & measure=completed & period=custom & from & to
 *              — a SPEND LINE (cost and a completion date) completed inside the
 *              window, which is exactly what every £ here counts
 *   type       the job type's STABLE token, as the payload names it
 *              (`drillType`): a type's id, `__other__` or `__unclassified__` —
 *              never its label, so renaming a type cannot break a link. The
 *              board still reads an old `reactive|planned|projects` link
 *   repeat     repeat=1 & period=custom & from & to — a repeat job RAISED inside
 *              the window, judged over the whole population
 *   issue      label=<the raw categories behind the slice>, pipe-joined
 *   site       site=<ids>, pipe-joined; `__unassigned__` for "No site"
 *   recurrence recurrence=<band> — repeat jobs whose pattern is in that band
 *
 * Nothing else is sent. The chosen portfolio rides along as its member sites
 * unless the figure already names a site of its own.
 *
 * PURE AND IMPORT-FREE ON PURPOSE: `tests/rp-dash-ui.test.mjs` slices this
 * section out of the file, transpiles it on its own and checks against the live
 * endpoint that each query selects exactly the jobs — and the pounds — its
 * figure counted. Nothing below this line may reach anything above it.
 */

export type RpDrillWindow = { from: string; to: string };

/** Pairs, in order, into a query string — empty values dropped, portfolio appended. */
export function rpJobsQuery(
  pairs: ReadonlyArray<readonly [string, string]>,
  portfolioSites: readonly string[] = [],
): string {
  const next = new URLSearchParams();
  for (const [key, value] of pairs) if (value) next.set(key, value);
  const sites = portfolioSites.filter(Boolean).join("|");
  if (sites && !next.has("site")) next.set("site", sites);
  return next.toString();
}

function rpSpendPairs(span: RpDrillWindow): Array<[string, string]> {
  return [
    ["hasCost", "1"],
    ["measure", "completed"],
    ["period", "custom"],
    ["from", span.from],
    ["to", span.to],
  ];
}

function rpRepeatPairs(span: RpDrillWindow): Array<[string, string]> {
  return [
    ["repeat", "1"],
    ["period", "custom"],
    ["from", span.from],
    ["to", span.to],
  ];
}

/**
 * A KPI card, or an Other / Unclassified link: the range's spend, and its job
 * type's stable token — `null` for the total, which names no type at all.
 */
export function rpKpiQuery(
  type: string | null,
  span: RpDrillWindow,
  portfolioSites: readonly string[] = [],
): string {
  return rpJobsQuery(
    [...rpSpendPairs(span), ...(type ? ([["type", type]] as Array<[string, string]>) : [])],
    portfolioSites,
  );
}

/** A spend-trend point: that month's spend. */
export function rpTrendQuery(point: RpDrillWindow, portfolioSites: readonly string[] = []): string {
  return rpJobsQuery(rpSpendPairs(point), portfolioSites);
}

/** A top-sites bar: that site's spend over the CARD's window, not the page's. */
export function rpSiteBarQuery(siteId: string, span: RpDrillWindow): string {
  return rpJobsQuery([...rpSpendPairs(span), ["site", siteId]]);
}

/** The repeat-rate gauge and "View all repeat jobs": every repeat raised in range. */
export function rpRepeatQuery(span: RpDrillWindow, portfolioSites: readonly string[] = []): string {
  return rpJobsQuery(rpRepeatPairs(span), portfolioSites);
}

/** An issue segment or legend row: the repeat jobs in those categories. */
export function rpRepeatIssueQuery(
  labels: readonly string[],
  span: RpDrillWindow,
  portfolioSites: readonly string[] = [],
): string {
  return rpJobsQuery([...rpRepeatPairs(span), ["label", labels.filter(Boolean).join("|")]], portfolioSites);
}

/** A site segment or legend row: the repeat jobs at those sites. */
export function rpRepeatSiteQuery(labels: readonly string[], span: RpDrillWindow): string {
  return rpJobsQuery([...rpRepeatPairs(span), ["site", labels.filter(Boolean).join("|")]]);
}

/** A recurrence ring: the repeat jobs whose pattern falls in that band. */
export function rpRecurrenceQuery(
  band: string,
  span: RpDrillWindow,
  portfolioSites: readonly string[] = [],
): string {
  return rpJobsQuery(
    [
      ["recurrence", band],
      ["period", "custom"],
      ["from", span.from],
      ["to", span.to],
    ],
    portfolioSites,
  );
}

/* ── End of the drill queries ─────────────────────────────────────────────── */
