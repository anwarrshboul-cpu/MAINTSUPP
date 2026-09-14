"use client";

/**
 * THE OVERVIEW — Job Intelligence, then Spend & Reporting, then Compliance.
 *
 * Three stacked sections on the dark neon system the reference draws, each
 * read from the endpoint that already owns its figures:
 *
 *   · Job Intelligence    `/api/overview/metrics` → `intel` (+ `range`, `portfolio`)
 *   · Spend & Reporting   `/api/reports/metrics`  — the Reports block's payload
 *   · Compliance          `/api/compliance/metrics` — the Compliance block's payload
 *
 * The three are fetched in parallel, keyed on the page's own `portfolio`,
 * `from` and `to`, and each section draws, skeletons or fails on its own — a
 * slow compliance read never holds the job figures back.
 *
 * ── THIS FILE COMPOSES; IT DOES NOT COMPUTE ───────────────────────────────
 *
 * It is never given a job, a cost line or a register row, so it cannot recount
 * one. Every number on screen is a field of a payload. What it adds is
 * presentation — which colour a figure is, how a count is written, a share
 * printed beside two figures already on screen — and the drill queries, which
 * COPY the filter a figure was counted with and nothing else. The one piece of
 * arithmetic of its own is the job-volume average, which divides a payload
 * count by the number of calendar months the payload's own range touches.
 *
 * ── THE DRILLS ARE THE BLOCKS' OWN ────────────────────────────────────────
 *
 * Section 2 sends exactly what the Reports block sends, through the builders
 * `rp-dash.tsx` exports; section 3 applies the payload's own register filters
 * through `cp-dash.tsx`'s `registerQuery`; section 1 speaks the Jobs board's
 * `readDrillFilter` vocabulary exactly as the dashboard block did, through the
 * same `rpJobsQuery`, so the portfolio rides every drill as its sites.
 *
 * ── THE WIRE TYPES ────────────────────────────────────────────────────────
 *
 * The reports, compliance and intel contracts are type-only modules with no
 * imports, and are imported as types. `overview-metrics.ts` reaches drizzle, so
 * the three fields of it this page reads are restated below, as `ov-dash.tsx`
 * restated its own.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import ovDashCss from "./ov-dash.css?url";
import oiDashCss from "./oi-dash.css?url";
import { DashHeader } from "./dash-header";
import { useOpsQuery, useQueryState } from "./ops-url-state";
import {
  AreaTrend,
  Donut,
  RingMeter,
  ovPercent,
  ovPoundsExact,
  ovPoundsShort,
  type OvSlice,
} from "./ov-dash-charts";
import { rpJobs, rpPounds } from "./rp-dash-charts";
import {
  rpJobsQuery,
  rpKpiQuery,
  rpRecurrenceQuery,
  rpRepeatIssueQuery,
  rpRepeatQuery,
  rpRepeatSiteQuery,
  rpSiteBarQuery,
  rpTrendQuery,
} from "./rp-dash";
import { registerQuery } from "./cp-dash";
import {
  OI_COLOUR,
  OiBarList,
  OiCard,
  OiGauge,
  OiGlowDefs,
  OiKpiTile,
  OiLegend,
  OiLink,
  OiTargetBars,
  OiWeekBars,
  oiCount,
  oiSeriesColours,
  oiShare,
  oiToneColour,
  type OiBarRow,
  type OiTone,
} from "./oi-dash-charts";
/* Imports nothing itself, so it cannot drag the query builder into this bundle. */
import { QUALITY_ARC, SLA_TARGET_ARC, qualityTone, rateTone } from "../../../lib/dashboard-policy";
/* Pure `Intl`, no imports. */
import { formatDayMonth, formatShortDate } from "../../../lib/format-date";
import type { OiIntel, OiPriorityKey, OiSlice } from "../../../lib/overview-intel-contract";
import type { RpBand, RpDelta, RpKpi, RpMetrics, RpSpendSlice } from "../../../lib/reports-dash-contract";
import type { CpMetrics, CpRegisterFilter, CpStateKey } from "../../../lib/compliance-dash-contract";

/* ── The wire shape this page reads from `/api/overview/metrics` ──────────── */

type OvOverview = {
  range: { from: string; to: string; label: string };
  /* The chosen portfolio's member sites, so a drill carries the portfolio to a
     board that speaks `site=`. Empty for "All portfolios". */
  portfolio: { id: string; name: string; siteIds: string[] };
  portfolios: { id: string; name: string }[];
  /** Absent from a server that predates it: the section draws its empty state. */
  intel?: OiIntel | null;
};

type Query<T> = { data: T | null; loading: boolean; error: string | null; reload: () => void };

/** One destination: the address a link shows, and the navigation a click runs. */
type Drill = { href: string; go: () => void };

/* ── Configuration ────────────────────────────────────────────────────────── */

/** §5.4: poll while the tab is visible. Sixty seconds, as every block does. */
const REFRESH_INTERVAL_MS = 60_000;

/** The real routes, from `sectionRoutes` in `portal-app.tsx`. */
const ROUTE = {
  jobs: "/dashboard/jobs",
  compliance: "/dashboard/compliance",
  sites: "/dashboard/sites",
} as const;

/** Colour by meaning: a High ring is a warning whatever its size. */
const PRIORITY_COLOUR: Record<OiPriorityKey, string> = {
  urgent: OI_COLOUR.critical,
  medium: OI_COLOUR.amber,
  low: OI_COLOUR.blue,
  not_recorded: OI_COLOUR.muted,
};

/** Tier 1 first — the payload's order is the meaning. "No tier" is muted. */
const TIER_COLOURS: readonly string[] = [
  OI_COLOUR.critical,
  OI_COLOUR.amber,
  OI_COLOUR.primary,
  OI_COLOUR.blue,
  OI_COLOUR.secondary,
  OI_COLOUR.tealLight,
];


/* By the job type's stable CODE, as the Reports block colours them — a renamed
   type keeps its tone. */
const KPI_TONE: Record<RpKpi["key"], OiTone> = {
  total: "primary",
  reactive: "orange",
  planned: "blue",
  project: "secondary",
};

/** Recurrence by urgency: a weekly repeat needs attention, a rare one does not. */
const BAND_COLOUR: Record<RpBand["key"], string> = {
  weekly: OI_COLOUR.critical,
  fortnightly: OI_COLOUR.amber,
  monthly: OI_COLOUR.blue,
  "less-often": OI_COLOUR.tealLight,
};

const STATUS_ORDER: readonly CpStateKey[] = ["compliant", "expiring", "expired", "missing"];

const STATUS_LABEL: Record<CpStateKey, string> = {
  compliant: "Compliant",
  expiring: "Expiring soon",
  expired: "Expired",
  missing: "Missing",
};

const STATUS_COLOUR: Record<CpStateKey, string> = {
  compliant: OI_COLOUR.green,
  expiring: OI_COLOUR.amber,
  expired: OI_COLOUR.critical,
  missing: OI_COLOUR.missing,
};

/** The renewals countdown by urgency — the payload's five buckets. */
const COUNTDOWN_COLOUR: Record<string, string> = {
  expired: OI_COLOUR.critical,
  "band-1": OI_COLOUR.critical,
  "band-2": OI_COLOUR.amber,
  "band-3": OI_COLOUR.blue,
  "no-date": OI_COLOUR.muted,
};

/** The donuts' geometry at natural size; CSS keeps them at 120px or more. */
const DONUT = { box: 140, radius: 58, stroke: 15 } as const;

/* ── Small helpers ────────────────────────────────────────────────────────── */

function plural(value: number, one: string, many: string): string {
  return `${oiCount(value)} ${value === 1 ? one : many}`;
}

function routeHref(route: string, query: string): string {
  return query ? `${route}?${query}` : route;
}

/** The range pill before the server has answered for the range in the address bar. */
function provisionalRangeLabel(from: string, to: string): string {
  const [low, high] = from <= to ? [from, to] : [to, from];
  const sameYear = low.slice(0, 4) === high.slice(0, 4);
  return `${sameYear ? formatDayMonth(low) : formatShortDate(low)} – ${formatShortDate(high)}`;
}

/** A spend delta as a short line and the tone it reads in. */
function deltaLine(delta: RpDelta): { text: string; tone: OiTone } {
  const magnitude = Math.abs(delta.percent ?? 0);
  switch (delta.direction) {
    case "up":
      return { text: `↑ ${magnitude}% ${delta.comparedWith}`, tone: "amber" };
    case "down":
      return { text: `↓ ${magnitude}% ${delta.comparedWith}`, tone: "primary" };
    case "flat":
      return { text: `No change ${delta.comparedWith}`, tone: "muted" };
    case "new":
      return { text: `New — nothing was spent in the previous period`, tone: "blue" };
    case "none":
    default:
      return { text: "Nothing spent in either period", tone: "muted" };
  }
}

/** Slices as the shared donut draws them, in the colours this page chose. */
function toOvSlices(
  slices: ReadonlyArray<{ key: string; label: string; value: number; labels: string[] }>,
  colours: readonly string[],
): OvSlice[] {
  return slices.map((slice, index) => ({
    key: slice.key,
    label: slice.label,
    value: slice.value,
    colour: colours[index] ?? OI_COLOUR.muted,
    labels: slice.labels,
  }));
}

/** Tier colours: position is meaning; a rolled-up bucket is muted and skips a turn. */
function tierColours(slices: readonly OiSlice[]): string[] {
  const colours: string[] = [];
  for (let index = 0, turn = 0; index < slices.length; index += 1) {
    if (/^__.+__$/.test(slices[index].key)) {
      colours.push(OI_COLOUR.muted);
    } else {
      colours.push(TIER_COLOURS[turn % TIER_COLOURS.length]);
      turn += 1;
    }
  }
  return colours;
}

/* ── The page ─────────────────────────────────────────────────────────────── */

export function OiDash({
  onNavigateToJobs,
  onNavigateToCompliance,
  onNavigateToSites,
  footer,
}: {
  /** The shell's own Jobs navigation: section first, then the filtered address. */
  onNavigateToJobs: (query: string) => void;
  /** The Compliance register, with a register query. */
  onNavigateToCompliance: (query: string) => void;
  /** The Sites list, with a query — `sites=a|b` for the sites-gauge drill. */
  onNavigateToSites: (query: string) => void;
  /** The page's data-fix tools, drawn in the island's own footer row. */
  footer?: ReactNode;
}) {
  const { params, setParams } = useQueryState();

  /*
   * THE THREE PARAMETERS THIS PAGE OWNS: `portfolio`, `from` and `to`, in the
   * address bar so a filtered Overview is a link. The default range is never
   * written there — an untouched page keeps a clean address — but it is always
   * SENT, so all three endpoints count the same explicit window.
   */
  const portfolio = params.get("portfolio") ?? "";
  const fromParam = params.get("from") ?? "";
  const toParam = params.get("to") ?? "";
  /*
   * THE DEFAULT RANGE FOLLOWS THE CALENDAR. Computed at mount, and recomputed
   * by the poll below when the UTC day turns, so a tab left open overnight
   * does not keep counting "completed" up to yesterday while open work moves on.
   */
  const [calendar, setCalendar] = useState(() => {
    const now = new Date();
    return { range: oiDefaultRange(now), presets: oiRangePresets(now) };
  });
  const fallback = calendar.range;
  const presets = calendar.presets;
  /* A real calendar day, not merely the right shape — "2026-13-01" falls back. */
  const from = oiIsCalendarDay(fromParam) ? fromParam : fallback.from;
  const to = oiIsCalendarDay(toParam) ? toParam : fallback.to;

  const search = useMemo(() => {
    const next = new URLSearchParams();
    if (portfolio) next.set("portfolio", portfolio);
    next.set("from", from);
    next.set("to", to);
    return next.toString();
  }, [portfolio, from, to]);

  /* The Reports read: the same window, a six-month trend and the page's range for the sites. */
  const reportsSearch = useMemo(() => {
    const next = new URLSearchParams(search);
    next.set("trendRange", "6m");
    next.set("sitesRange", "page");
    return next.toString();
  }, [search]);

  /* The Compliance read is a snapshot as of today: the portfolio alone. */
  const complianceSearch = useMemo(() => {
    const next = new URLSearchParams();
    if (portfolio) next.set("portfolio", portfolio);
    return next.toString();
  }, [portfolio]);

  /*
   * Three round trips, in parallel. `keepOnError` keeps each section's figures
   * on screen through a failed poll — "no flicker to zero" — and each one
   * answers the topbar's Refresh and `announceDataChanged` on its own.
   */
  const overview = useOpsQuery<OvOverview>("/api/overview/metrics", search, { keepOnError: true });
  const reports = useOpsQuery<RpMetrics>("/api/reports/metrics", reportsSearch, { keepOnError: true });
  const compliance = useOpsQuery<CpMetrics>("/api/compliance/metrics", complianceSearch, { keepOnError: true });

  const reloadOverview = overview.reload;
  const reloadReports = reports.reload;
  const reloadCompliance = compliance.reload;
  const reloadAll = useCallback(() => {
    reloadOverview();
    reloadReports();
    reloadCompliance();
  }, [reloadOverview, reloadReports, reloadCompliance]);

  /*
   * §5.4 — REFETCH ON FOCUS, AND POLL WHILE VISIBLE, as `ov-dash.tsx` does.
   * There is no realtime transport, so freshness is a poll, and every listener
   * checks `document.visibilityState` first so a tab left open overnight
   * issues no requests. `reloadAll` is stable and runs from a listener or a
   * timer, never during the effect.
   */
  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = new Date();
      const today = oiDefaultRange(now);
      setCalendar((current) =>
        current.range.from === today.from && current.range.to === today.to
          ? current
          : { range: today, presets: oiRangePresets(now) },
      );
      reloadAll();
    };
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    const timer = window.setInterval(refreshIfVisible, REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.clearInterval(timer);
    };
  }, [reloadAll]);

  /** Mutate the address bar without disturbing a parameter another surface owns. */
  const setFilter = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(window.location.search);
      mutate(next);
      setParams(next);
    },
    [setParams],
  );

  const portfolios =
    overview.data?.portfolios ?? reports.data?.portfolios ?? compliance.data?.portfolios ?? [];
  const rangeLabel =
    overview.data && overview.data.range.from === from && overview.data.range.to === to
      ? overview.data.range.label
      : provisionalRangeLabel(from, to);
  /* A poll that failed while figures are still on screen: they stay, and Retry sits in the header. */
  const staleError =
    (overview.data ? overview.error : null) ??
    (reports.data ? reports.error : null) ??
    (compliance.data ? compliance.error : null);

  return (
    <>
      <link rel="stylesheet" href={ovDashCss} precedence="default" />
      <link rel="stylesheet" href={oiDashCss} precedence="default" />
      <section
        className="ov-dash oi-dash"
        aria-busy={overview.loading || reports.loading || compliance.loading}
        aria-label="Overview"
      >
        <OiGlowDefs />
        <h1 className="visually-hidden">Operations overview</h1>
        <DashHeader
          title="Overview"
          portfolio={portfolio}
          portfolios={portfolios}
          onPortfolio={(next) =>
            setFilter((query) => {
              if (next) query.set("portfolio", next);
              else query.delete("portfolio");
            })
          }
          range={{ from, to, label: rangeLabel }}
          onRange={(nextFrom, nextTo) =>
            setFilter((query) => {
              if (nextFrom) query.set("from", nextFrom);
              else query.delete("from");
              if (nextTo) query.set("to", nextTo);
              else query.delete("to");
            })
          }
          presets={presets}
          resetLabel="Reset to the last 12 months"
          rangeCaption="Completions, spend and job volume are counted over this range. Open work and compliance are as they stand today."
          /* The Reports block's own server-built export — every job cost line
             under the current filters, and the spend metrics — as a real link. */
          exportHref={`/api/reports/metrics?format=csv&${reportsSearch}`}
          exportDisabled={!reports.data}
          error={staleError}
          onRetry={reloadAll}
        />

        <JobIntelSection query={overview} onJobs={onNavigateToJobs} />
        <SpendSection query={reports} onJobs={onNavigateToJobs} />
        <ComplianceSection
          query={compliance}
          onCompliance={onNavigateToCompliance}
          onSites={onNavigateToSites}
        />

        {footer ? <div className="oi-footer">{footer}</div> : null}
      </section>
    </>
  );
}

/* ── Section chrome ───────────────────────────────────────────────────────── */

function SectionHead({
  id,
  title,
  subtitle,
  pill,
}: {
  id: string;
  title: string;
  subtitle: string;
  pill?: string;
}) {
  return (
    <div className="oi-section__head">
      <div className="oi-section__titles">
        <h2 id={id} className="oi-section__title">
          {title}
        </h2>
        <p className="oi-section__subtitle">{subtitle}</p>
      </div>
      {pill ? <span className="oi-pill oi-pill--primary oi-section__pill">{pill}</span> : null}
    </div>
  );
}

/** The one render where a section has nothing yet: its shape, shimmering. */
function SectionSkeleton({ kpis, cards }: { kpis: number; cards: number }) {
  return (
    <>
      {kpis > 0 ? (
        <div className="oi-kpis">
          {Array.from({ length: kpis }, (_, slot) => (
            <div key={slot} className="oi-kpi ov-skeleton oi-skeleton--kpi" />
          ))}
        </div>
      ) : null}
      <div className="oi-grid">
        {Array.from({ length: cards }, (_, slot) => (
          <div key={slot} className="oi-card ov-skeleton oi-skeleton--card" />
        ))}
      </div>
    </>
  );
}

function SectionError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="oi-card oi-error" role="alert">
      <p className="oi-note">{error}</p>
      <button type="button" className="oi-more" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/* ── Section 1 — Job Intelligence ─────────────────────────────────────────── */

function JobIntelSection({ query, onJobs }: { query: Query<OvOverview>; onJobs: (query: string) => void }) {
  const { data, error, reload } = query;
  const intel = data?.intel ?? null;
  const titleId = "oi-section-jobs";
  const subtitle = data
    ? `Open work as it stands now, and what closed in ${data.range.label} — read straight from the live Jobs board.`
    : "Open work as it stands now, and what closed in the range — read straight from the live Jobs board.";
  const head = <SectionHead id={titleId} title="Job Intelligence" subtitle={subtitle} pill="Live · Jobs board" />;

  if (!data || !intel) {
    return (
      <section className="oi-section" aria-labelledby={titleId}>
        {head}
        {!data && error ? (
          <SectionError error={error} onRetry={reload} />
        ) : data ? (
          /* A server that predates the section: say so rather than shimmer forever. */
          <div className="oi-card oi-empty">
            <p className="oi-note">
              This server does not send job intelligence yet, so this section has nothing to draw.
            </p>
          </div>
        ) : (
          <SectionSkeleton kpis={4} cards={3} />
        )}
      </section>
    );
  }

  const { range } = data;
  const sites = data.portfolio.siteIds;
  /* Every drill is a pair list from the pure section at the foot, with the
     portfolio appended as its sites by the Reports block's own `rpJobsQuery`. */
  const drill = (pairs: readonly OiPair[]): Drill => {
    const jobsQuery = rpJobsQuery(pairs, sites);
    return { href: routeHref(ROUTE.jobs, jobsQuery), go: () => onJobs(jobsQuery) };
  };
  const openDrill = drill(OI_OPEN);
  const overdueDrill = drill(OI_OVERDUE);
  const completedDrill = drill(oiCompletedPairs(range));
  const statusDrill = (slice: OiSlice) => drill(oiStatusPairs(slice));
  const priorityDrill = (labels: readonly string[]) => drill(oiOpenByPairs("priority", labels));
  const tierDrill = (slice: OiSlice) => drill(oiOpenByPairs("tier", slice.labels));
  const engineerDrill = (slice: OiSlice) => drill(oiOpenByPairs("engineer", slice.labels));
  const labelDrill = (slice: OiSlice) => drill(oiOpenByPairs("label", slice.labels));

  const { sla, aging, breachRisk, timeToClose } = intel;
  const agingPairs = oiAgingPairs(aging);
  const slaTone: OiTone =
    /* The SLA target's thresholds — the same ones the per-priority bars use,
       so one percentage is never teal on the gauge and amber on a bar. */
    sla.percent === null ? "muted" : toneName(qualityTone(sla.percent, SLA_TARGET_ARC));
  const completionTone: OiTone =
    intel.completionRate === null ? "muted" : toneName(qualityTone(intel.completionRate, QUALITY_ARC));

  /* ── The slices, coloured ──────────────────────────────────────────────── */

  const statusSlices = toOvSlices(intel.status, oiSeriesColours(intel.status.map((slice) => slice.key)));
  const tierSlices = toOvSlices(intel.tiers, tierColours(intel.tiers));
  const labelSlices = toOvSlices(intel.labels, oiSeriesColours(intel.labels.map((slice) => slice.key)));
  const engineerColours = oiSeriesColours(intel.engineers.map((slice) => slice.key));
  const completionSlices: OvSlice[] = [
    { key: "completed", label: "Completed", value: intel.completed, colour: OI_COLOUR.green, labels: [] },
    { key: "open", label: "Still open", value: intel.open, colour: OI_COLOUR.muted, labels: [] },
  ];
  const bySlice = <T extends { key: string }>(list: readonly T[], key: string) =>
    list.find((entry) => entry.key === key);

  const engineerRows: OiBarRow[] = intel.engineers.map((slice, index) => {
    const target = engineerDrill(slice);
    return {
      key: slice.key,
      label: slice.label,
      value: slice.value,
      valueText: oiCount(slice.value),
      colour: engineerColours[index],
      href: target.href,
      onActivate: target.go,
      ariaLabel: `${slice.label}: ${oiShare(slice.value, intel.open)} of open jobs. Opens them on the jobs board.`,
    };
  });

  /* ── Time to close ─────────────────────────────────────────────────────── */

  const days = (value: number) => `${value.toFixed(1)} days`;
  const ttcValue = timeToClose.averageDays === null ? "—" : timeToClose.averageDays.toFixed(1);
  const ttcDelta = timeToClose.deltaDays;
  const ttcLine: { text: string; tone: OiTone } =
    timeToClose.averageDays === null
      ? { text: `No job closed in ${range.label}`, tone: "muted" }
      : ttcDelta === null
        ? { text: "No previous period to compare", tone: "muted" }
        : ttcDelta < 0
          ? { text: `↓ ${Math.abs(ttcDelta).toFixed(1)} days faster than the previous period`, tone: "primary" }
          : ttcDelta > 0
            ? { text: `↑ ${ttcDelta.toFixed(1)} days slower than the previous period`, tone: "critical" }
            : { text: "The same as the previous period", tone: "muted" };

  /* ── SLA by priority ───────────────────────────────────────────────────── */

  const target = intel.slaTargetPercent;
  const slaRows = intel.slaByPriority.map((row) => {
    const labels = bySlice(intel.priority, row.key)?.labels ?? [row.key];
    const destination = priorityDrill(labels);
    const colour =
      row.percent === null
        ? OI_COLOUR.muted
        : row.percent >= target
          ? OI_COLOUR.primary
          : row.percent >= SLA_TARGET_ARC.warn
            ? OI_COLOUR.amber
            : OI_COLOUR.critical;
    return {
      key: row.key,
      label: row.label,
      jobs: row.jobs,
      percent: row.percent,
      colour,
      href: destination.href,
      onActivate: destination.go,
      ariaLabel:
        row.percent === null
          ? `${row.label} priority: no open jobs. Opens the jobs board filtered to this priority.`
          : `${row.label} priority: ${row.percent}% of ${plural(row.jobs, "open job", "open jobs")} within SLA, against a ${target}% target. Opens these jobs.`,
    };
  });

  return (
    <section className="oi-section" aria-labelledby={titleId}>
      {head}

      <div className="oi-kpis">
        <OiKpiTile
          label="Open jobs"
          value={oiCount(intel.open)}
          caption="active work orders"
          tone="blue"
          href={openDrill.href}
          onActivate={openDrill.go}
          ariaLabel={`Open jobs: ${oiCount(intel.open)}. Opens the open jobs on the jobs board.`}
        />
        <OiKpiTile
          label="Completed jobs"
          value={oiCount(intel.completed)}
          caption={`closed in ${range.label}`}
          tone="primary"
          href={completedDrill.href}
          onActivate={completedDrill.go}
          ariaLabel={`Completed jobs: ${oiCount(intel.completed)} closed in ${range.label}. Opens those jobs.`}
        />
        <OiKpiTile
          label="Completion rate"
          value={intel.completionRate === null ? "—" : `${intel.completionRate}%`}
          caption="completed vs still open"
          tone={completionTone}
          ariaLabel="Completion rate"
        />
        <OiKpiTile
          label="SLA met"
          value={sla.percent === null ? "—" : `${sla.percent}%`}
          caption={sla.percent === null ? "no open jobs to measure" : `${oiCount(sla.withinSla)} of ${oiCount(sla.open)} within target`}
          tone={slaTone}
          href={overdueDrill.href}
          onActivate={overdueDrill.go}
          ariaLabel={`SLA met: ${sla.percent === null ? "not measured, no open jobs" : `${sla.percent}%, ${oiCount(sla.withinSla)} of ${oiCount(sla.open)} open jobs within SLA`}. Opens the ${plural(sla.overdue, "overdue job", "overdue jobs")}.`}
        />
      </div>

      <div className="oi-grid">
        {/* 1 — Priority & SLA */}
        <OiCard title="Priority & SLA" pill="Priority · Due date" className="oi-priority">
          <OiGauge
            fraction={sla.percent === null ? null : sla.percent / 100}
            value={sla.percent === null ? "—" : `${sla.percent}%`}
            caption="within SLA"
            sub={sla.percent === null ? "No open jobs" : `${plural(sla.overdue, "job", "jobs")} past due of ${oiCount(sla.open)} open`}
            colour={OI_COLOUR[slaTone]}
            onSelect={overdueDrill.go}
            ariaLabel="SLA — open jobs not yet past their due date (opens the overdue jobs)"
          />
          <div className="oi-rings oi-rings--priority">
            {intel.priority.map((slice) => {
              const destination = priorityDrill(slice.labels);
              return (
                <RingMeter
                  key={slice.key}
                  value={slice.value}
                  total={intel.open}
                  label={slice.label}
                  colour={PRIORITY_COLOUR[slice.key] ?? OI_COLOUR.muted}
                  size={64}
                  stroke={7}
                  onSelect={destination.go}
                  describe="Opens these open jobs on the jobs board."
                />
              );
            })}
          </div>
          <OiLink
            className="oi-card__link"
            href={openDrill.href}
            onActivate={openDrill.go}
            label={`View all ${plural(intel.open, "open job", "open jobs")}`}
          >
            View open jobs ›
          </OiLink>
        </OiCard>

        {/* 2 — Jobs by status */}
        <OiCard title="Jobs by Status" pill="Field · Status">
          {intel.open === 0 ? (
            <p className="oi-note oi-empty-note">No open job to split by status.</p>
          ) : (
            <div className="oi-donut">
              <Donut
                slices={statusSlices}
                total={intel.open}
                caption="open jobs"
                centreValue={oiCount(intel.open)}
                geometry={DONUT}
                formatValue={oiCount}
                onSelect={(slice) => {
                  const found = bySlice(intel.status, slice.key);
                  if (found) statusDrill(found).go();
                }}
                ariaLabel="Open jobs by status"
              />
              <OiLegend
                rows={intel.status.map((slice, index) => {
                  const destination = statusDrill(slice);
                  return {
                    key: slice.key,
                    label: slice.label,
                    valueText: oiCount(slice.value),
                    colour: statusSlices[index].colour,
                    href: destination.href,
                    onActivate: destination.go,
                    ariaLabel: `${slice.label}: ${plural(slice.value, "open job", "open jobs")}. Opens the jobs board filtered to this status.`,
                  };
                })}
              />
            </div>
          )}
        </OiCard>

        {/* 3 — Job completion */}
        <OiCard title="Job Completion" pill="Completed vs open">
          {intel.completed + intel.open === 0 ? (
            <p className="oi-note oi-empty-note">{`No job is open, and none closed in ${range.label}.`}</p>
          ) : (
            <div className="oi-donut">
              <Donut
                slices={completionSlices}
                total={intel.completed + intel.open}
                caption="completed"
                centreValue={intel.completionRate === null ? "—" : `${intel.completionRate}%`}
                geometry={DONUT}
                formatValue={oiCount}
                onSelect={(slice) => (slice.key === "completed" ? completedDrill.go() : openDrill.go())}
                ariaLabel="Job completion"
              />
              <OiLegend
                rows={[
                  {
                    key: "completed",
                    label: "Completed",
                    valueText: oiCount(intel.completed),
                    colour: OI_COLOUR.green,
                    href: completedDrill.href,
                    onActivate: completedDrill.go,
                    ariaLabel: `Completed: ${plural(intel.completed, "job", "jobs")} closed in ${range.label}. Opens those jobs.`,
                  },
                  {
                    key: "open",
                    label: "Still open",
                    valueText: oiCount(intel.open),
                    colour: OI_COLOUR.muted,
                    href: openDrill.href,
                    onActivate: openDrill.go,
                    ariaLabel: `Still open: ${plural(intel.open, "job", "jobs")}. Opens the open jobs.`,
                  },
                ]}
              />
            </div>
          )}
          <p className="oi-note">Jobs completed in {range.label}, against the jobs still open on the board today.</p>
        </OiCard>

        {/* 4 — Tier level */}
        <OiCard title="Jobs by Tier Level" pill="Field · Tier Level">
          {intel.open === 0 ? (
            <p className="oi-note oi-empty-note">No open job to split by tier.</p>
          ) : (
            <div className="oi-donut">
              <Donut
                slices={tierSlices}
                total={intel.open}
                caption="open jobs"
                centreValue={oiCount(intel.open)}
                geometry={DONUT}
                formatValue={oiCount}
                onSelect={(slice) => {
                  const found = bySlice(intel.tiers, slice.key);
                  if (found) tierDrill(found).go();
                }}
                ariaLabel="Open jobs by tier level"
              />
              <OiLegend
                rows={intel.tiers.map((slice, index) => {
                  const destination = tierDrill(slice);
                  return {
                    key: slice.key,
                    label: slice.label,
                    valueText: oiCount(slice.value),
                    colour: tierSlices[index].colour,
                    href: destination.href,
                    onActivate: destination.go,
                    ariaLabel: `${slice.label}: ${plural(slice.value, "open job", "open jobs")}. Opens them on the jobs board.`,
                  };
                })}
              />
            </div>
          )}
        </OiCard>

        {/* 5 — Engineer required */}
        <OiCard title="Jobs by Engineer Required" pill="Field · Engineer Required">
          <OiBarList
            rows={engineerRows}
            visible={6}
            noun="engineer types"
            ariaLabel="Open jobs by engineer required"
            emptyText="No open job to split by engineer."
          />
        </OiCard>

        {/* 6 — Label */}
        <OiCard title="Jobs by Label" pill="Field · Label">
          {intel.open === 0 ? (
            <p className="oi-note oi-empty-note">No open job to split by label.</p>
          ) : (
            <div className="oi-donut">
              <Donut
                slices={labelSlices}
                total={intel.open}
                caption="open jobs"
                centreValue={oiCount(intel.open)}
                geometry={DONUT}
                formatValue={oiCount}
                onSelect={(slice) => {
                  const found = bySlice(intel.labels, slice.key);
                  if (found) labelDrill(found).go();
                }}
                ariaLabel="Open jobs by label"
              />
              <OiLegend
                rows={intel.labels.map((slice, index) => {
                  const destination = labelDrill(slice);
                  return {
                    key: slice.key,
                    label: slice.label,
                    valueText: oiCount(slice.value),
                    colour: labelSlices[index].colour,
                    href: destination.href,
                    onActivate: destination.go,
                    ariaLabel: `${slice.label}: ${plural(slice.value, "open job", "open jobs")}. Opens them on the jobs board.`,
                  };
                })}
              />
            </div>
          )}
        </OiCard>

        {/* 7 — Aging backlog */}
        <OiCard title="Aging Backlog" pill="Status + Date Requested" pillTone="amber">
          <OiGauge
            fraction={aging.percent === null ? null : aging.percent / 100}
            value={oiCount(aging.count)}
            unit={aging.count === 1 ? "job" : "jobs"}
            caption={`open > ${aging.thresholdDays} days`}
            sub={aging.percent === null ? "No open jobs" : `${aging.percent}% of open backlog`}
            colour={aging.count > 0 ? OI_COLOUR.amber : OI_COLOUR.primary}
            onSelect={agingPairs ? drill(agingPairs).go : undefined}
            ariaLabel={`Aging backlog — open jobs requested more than ${aging.thresholdDays} days ago${agingPairs ? " (opens them)" : ""}`}
          />
        </OiCard>

        {/* 8 — SLA breach risk */}
        <OiCard title="SLA Breach Risk" pill="Priority + Tier + Due date" pillTone="critical">
          <OiGauge
            fraction={breachRisk.percent === null ? null : breachRisk.percent / 100}
            value={oiCount(breachRisk.count)}
            unit={breachRisk.count === 1 ? "job" : "jobs"}
            caption={`due within ${breachRisk.windowHours}h`}
            sub={`High priority or Tier 1, still open · ${oiCount(breachRisk.pool)} in all`}
            colour={breachRisk.count > 0 ? OI_COLOUR.critical : OI_COLOUR.primary}
            onSelect={drill(OI_BREACH).go}
            ariaLabel={`SLA breach risk — open High priority or Tier 1 jobs, not yet overdue, due within ${breachRisk.windowHours} hours (opens them)`}
          />
        </OiCard>

        {/* 9 — Average time to close */}
        <OiCard title="Avg. Time to Close" pill="Requested → Completed" className="oi-ttc oi-span-md">
          <OiLink
            className="oi-ttc__figure"
            href={completedDrill.href}
            onActivate={completedDrill.go}
            label={`Average time to close: ${timeToClose.averageDays === null ? "no job closed" : days(timeToClose.averageDays)} over ${plural(timeToClose.jobs, "job", "jobs")} completed in ${range.label}. ${ttcLine.text}. Opens those jobs.`}
          >
            <span className="oi-ttc__value">
              {ttcValue}
              {timeToClose.averageDays === null ? null : <span className="oi-ttc__unit"> days</span>}
            </span>
            <span className={`oi-ttc__delta oi-tone--${ttcLine.tone}`}>{ttcLine.text}</span>
          </OiLink>
          <OiWeekBars
            weeks={timeToClose.weeks.map((week) => ({
              key: week.from,
              label: week.label,
              value: week.averageDays,
              jobs: week.jobs,
            }))}
            format={days}
            ariaLabel="Average days to close, by week, for the seven weeks to the end of the range"
            /* A week opens the jobs completed in it — the same completion-day
               window the Completed tile uses, seven days wide. */
            onSelect={(index) => {
              const week = timeToClose.weeks[index];
              if (week) drill(oiCompletedPairs({ from: week.from, to: week.to })).go();
            }}
          />
        </OiCard>

        {/* Wide — SLA compliance by priority */}
        <OiCard
          title="SLA Compliance by Priority Tier"
          pill={`Priority × SLA target ${target}%`}
          wide
        >
          <OiTargetBars
            rows={slaRows}
            target={target}
            ariaLabel={`Open jobs within SLA by priority, against a ${target}% target`}
          />
        </OiCard>
      </div>
    </section>
  );
}

/** `qualityTone`'s three words as the palette's names. */
function toneName(tone: "good" | "warn" | "poor"): OiTone {
  // Good is the approved green (on target, healthy, SLA met); turquoise stays
  // the brand and the default series, not a verdict.
  return tone === "good" ? "green" : tone === "warn" ? "amber" : "critical";
}

/* ── Section 2 — Spend & Reporting ────────────────────────────────────────── */

function SpendSection({ query, onJobs }: { query: Query<RpMetrics>; onJobs: (query: string) => void }) {
  const { data, error, reload } = query;
  const titleId = "oi-section-spend";
  const subtitle =
    "Completed spend from the Reports page — split by job type, where it goes, and the issues that keep coming back.";

  if (!data) {
    return (
      <section className="oi-section" aria-labelledby={titleId}>
        <SectionHead id={titleId} title="Spend & Reporting" subtitle={subtitle} />
        {error ? <SectionError error={error} onRetry={reload} /> : <SectionSkeleton kpis={4} cards={3} />}
      </section>
    );
  }

  const { kpis, range, repeat, topSites, trend, policy } = data;
  const scope = { from: range.from, to: range.to };
  const sites = data.portfolio.siteIds;
  const drillTo = (jobsQuery: string): Drill => ({
    href: routeHref(ROUTE.jobs, jobsQuery),
    go: () => onJobs(jobsQuery),
  });
  const totalPence = kpis.find((kpi) => kpi.key === "total")?.pence ?? 0;
  /* The total tile's hover names all five buckets, as the Reports block's does:
     the type tiles by their current labels, then Other and Unclassified, which
     have no tile of their own and are never dropped from the sum. */
  const typeBreakdown = [
    ...kpis.filter((kpi) => kpi.key !== "total").map((kpi) => `${kpi.label} ${ovPoundsExact(kpi.pence)}`),
    `${data.other.label} ${ovPoundsExact(data.other.pence)}`,
    `${data.unclassified.label} ${ovPoundsExact(data.unclassified.pence)}`,
  ].join(" · ");

  /* ── The trend ─────────────────────────────────────────────────────────── */

  const trendPoints = trend.points.map((point) => ({
    label: point.label,
    pence: point.pence,
    jobs: point.jobs,
    longLabel: point.longLabel,
  }));
  const trendDelta = deltaLine(trend.delta);

  /* ── Top sites — five, then "View all" with the rest and "No site" ─────── */

  const siteRows: OiBarRow[] = topSites.rows.map((row) => {
    const destination = drillTo(rpSiteBarQuery(row.siteId, topSites));
    return {
      key: row.siteId,
      label: row.name,
      value: row.pence,
      valueText: rpPounds(row.pence),
      colour: OI_COLOUR.primary,
      href: destination.href,
      onActivate: destination.go,
      ariaLabel: `${row.name}: ${ovPoundsExact(row.pence)}, ${ovPercent(row.pence, topSites.totalPence)}% of the ${rpPounds(topSites.totalPence)} spent in ${topSites.label}, ${rpJobs(row.jobs)}. Opens those jobs.`,
    };
  });
  if (topSites.noSite.pence > 0) {
    const destination = drillTo(rpSiteBarQuery("__unassigned__", topSites));
    siteRows.push({
      key: "__unassigned__",
      label: "No site",
      value: topSites.noSite.pence,
      valueText: rpPounds(topSites.noSite.pence),
      colour: OI_COLOUR.muted,
      href: destination.href,
      onActivate: destination.go,
      ariaLabel: `No site: ${ovPoundsExact(topSites.noSite.pence)} on ${rpJobs(topSites.noSite.jobs)} with no site recorded. Opens those jobs.`,
    });
  }
  const sitesFoot = `${
    topSites.siteCount === 1 ? "1 site" : `${oiCount(topSites.siteCount)} sites`
  } ${rpPounds(topSites.sitesPence)} · No site ${rpPounds(topSites.noSite.pence)}`;

  /* ── Repeat activity ───────────────────────────────────────────────────── */

  const repeatTone = rateTone(repeat.percent, policy.repeatThresholds);
  const repeatDrill = drillTo(rpRepeatQuery(scope, sites));
  const issueSlices = toOvSlices(repeat.byIssue, oiSeriesColours(repeat.byIssue.map((slice) => slice.key)));
  const siteSlices = toOvSlices(repeat.bySite, oiSeriesColours(repeat.bySite.map((slice) => slice.key)));
  const repeatTip = (slices: readonly RpSpendSlice[]) => (slice: OvSlice, share: number) => [
    ovPoundsExact(slice.value),
    `${Math.round(share * 100)}% of repeat spend`,
    plural(slices.find((entry) => entry.key === slice.key)?.jobs ?? 0, "repeat job", "repeat jobs"),
  ];
  const repeatLegend = (
    slices: readonly RpSpendSlice[],
    colours: readonly OvSlice[],
    queryFor: (slice: RpSpendSlice) => string,
    describe: string,
  ) =>
    slices.map((slice, index) => {
      const destination = drillTo(queryFor(slice));
      return {
        key: slice.key,
        label: slice.label,
        valueText: rpPounds(slice.value),
        colour: colours[index]?.colour ?? OI_COLOUR.muted,
        href: destination.href,
        onActivate: destination.go,
        ariaLabel: `${slice.label}: ${rpPounds(slice.value)} of repeat spend, ${plural(slice.jobs, "repeat job", "repeat jobs")}. ${describe}.`,
      };
    });
  const oneSite = repeat.bySite.length === 1 && repeat.spendPence > 0;

  /* ── Job volume ────────────────────────────────────────────────────────── */

  const months = oiMonthsSpanned(range.from, range.to);
  const perMonth = Math.round(repeat.jobsInRange / months);
  const volumeDrill = drillTo(rpJobsQuery(oiVolumePairs(range), sites));

  return (
    <section className="oi-section" aria-labelledby={titleId}>
      <SectionHead
        id={titleId}
        title="Spend & Reporting"
        subtitle={subtitle}
        pill={`Live figures — ${range.label}`}
      />

      <div className="oi-kpis">
        {kpis.map((kpi) => {
          /* The Reports block's own drill: the type's stable id, never its words. */
          const destination = drillTo(rpKpiQuery(kpi.drillType, scope, sites));
          const caption =
            kpi.key === "total"
              ? range.label
              : totalPence > 0 && kpi.pence > 0
                ? `${ovPercent(kpi.pence, totalPence)}% of total spend`
                : `No ${kpi.label.toLowerCase()} spend in range`;
          return (
            <OiKpiTile
              key={kpi.key}
              label={kpi.label}
              value={rpPounds(kpi.pence)}
              title={kpi.key === "total" ? `${ovPoundsExact(kpi.pence)} — ${typeBreakdown}` : ovPoundsExact(kpi.pence)}
              caption={caption}
              tone={KPI_TONE[kpi.key]}
              href={destination.href}
              onActivate={destination.go}
              ariaLabel={`${kpi.label}: ${rpPounds(kpi.pence)} from ${rpJobs(kpi.jobs)} in ${range.label}.${
                kpi.key === "total" ? ` ${typeBreakdown}.` : ""
              } Opens the jobs with completed cost behind it.`}
            />
          );
        })}
      </div>

      <div className="oi-grid">
        {/* 1 — Spend trend */}
        <OiCard title="Spend Trend" pill={trend.label} className="oi-trend-card">
          <div className="oi-figure">
            <span className="oi-figure__value" title={ovPoundsExact(trend.totalPence)}>
              {rpPounds(trend.totalPence)}
            </span>
            <span className={`oi-figure__caption oi-tone--${trendDelta.tone}`}>{trendDelta.text}</span>
          </div>
          <div className="oi-trend">
            <AreaTrend
              points={trendPoints}
              lineColour={OI_COLOUR.primary}
              areaColour={OI_COLOUR.primary}
              tipLines={(point, index, share) => [
                trendPoints[index]?.longLabel ?? point.label,
                ovPoundsExact(point.pence),
                `${Math.round(share * 100)}% of the period`,
                rpJobs(trendPoints[index]?.jobs ?? 0),
              ]}
              onSelect={(_point, index) => {
                const source = trend.points[index];
                if (source) onJobs(rpTrendQuery(source, sites));
              }}
              ariaLabel={`Spend by month, ${trend.label}, ${rpPounds(trend.totalPence)} in total. Selecting a month opens its jobs with completed cost`}
            />
          </div>
        </OiCard>

        {/* 2 — Top sites */}
        <OiCard title="Top Sites by Spend" pill="Field · Site">
          <OiBarList
            rows={siteRows}
            visible={5}
            noun="sites"
            ariaLabel={`Top sites by spend, ${topSites.label}`}
            emptyText={`No site has completed spend in ${topSites.label}.`}
          />
          <p className="oi-note oi-note--foot">{sitesFoot}</p>
        </OiCard>

        {/* 3 — Repeat rate */}
        <OiCard title="Repeat Rate" pill="Same site, same issue" pillTone={repeatTone === "good" ? "primary" : repeatTone === "warn" ? "amber" : "critical"}>
          <OiGauge
            fraction={repeat.percent / 100}
            value={`${repeat.percent}%`}
            caption="repeat rate"
            sub={`${plural(repeat.repeatJobs, "repeat job", "repeat jobs")} across ${plural(repeat.sitesAffected, "site", "sites")}`}
            colour={oiToneColour(repeatTone)}
            onSelect={repeatDrill.go}
            ariaLabel={`Repeat rate — repeat jobs as a share of the ${rpJobs(repeat.jobsInRange)} raised in ${range.label}; lower is better (opens the repeat jobs)`}
          />
        </OiCard>

        {/* 4 — Repeat spend by issue */}
        <OiCard title="Repeat Spend by Issue" pill="Field · Issue" pillTone="secondary">
          {repeat.byIssue.length > 0 ? (
            <div className="oi-donut">
              <Donut
                slices={issueSlices}
                total={repeat.spendPence}
                centreValue={ovPoundsShort(repeat.spendPence)}
                caption="repeat spend"
                geometry={DONUT}
                gapPx={2}
                formatValue={rpPounds}
                tipLines={repeatTip(repeat.byIssue)}
                onSelect={(slice) => onJobs(rpRepeatIssueQuery(slice.labels, scope, sites))}
                ariaLabel="Repeat spend by issue"
              />
              <OiLegend
                rows={repeatLegend(
                  repeat.byIssue,
                  issueSlices,
                  (slice) => rpRepeatIssueQuery(slice.labels, scope, sites),
                  "Opens the repeat jobs for this issue",
                )}
              />
            </div>
          ) : (
            <p className="oi-note oi-empty-note">No repeat issue in this range.</p>
          )}
        </OiCard>

        {/* 5 — Repeat spend by site */}
        <OiCard title="Repeat Spend by Site" pill="Field · Site">
          {repeat.bySite.length > 0 ? (
            <>
              <div className={`oi-donut${oneSite ? " oi-donut--solo" : ""}`}>
                <Donut
                  slices={siteSlices}
                  total={repeat.spendPence}
                  centreValue={ovPoundsShort(repeat.spendPence)}
                  caption={oneSite ? repeat.bySite[0].label : "repeat spend"}
                  geometry={DONUT}
                  gapPx={2}
                  formatValue={rpPounds}
                  tipLines={repeatTip(repeat.bySite)}
                  onSelect={(slice) => onJobs(rpRepeatSiteQuery(slice.labels, scope))}
                  ariaLabel="Repeat spend by site"
                />
                {oneSite ? null : (
                  <OiLegend
                    rows={repeatLegend(
                      repeat.bySite,
                      siteSlices,
                      (slice) => rpRepeatSiteQuery(slice.labels, scope),
                      "Opens the repeat jobs at this site",
                    )}
                  />
                )}
              </div>
              {oneSite ? <p className="oi-note oi-note--centre">100% of repeat spend sits at one site.</p> : null}
            </>
          ) : (
            <p className="oi-note oi-empty-note">No site has repeat jobs in this range.</p>
          )}
        </OiCard>

        {/* 6 — Recurrence */}
        <OiCard title="Recurrence" pill="Repeat cadence">
          <div
            className="oi-rings oi-rings--bands"
            role="group"
            aria-label={`${plural(repeat.patterns, "repeat pattern", "repeat patterns")} by how often they recur`}
          >
            {repeat.bands.map((band) => {
              const both = `${plural(band.value, "pattern", "patterns")} · ${plural(band.jobs, "repeat job", "repeat jobs")}`;
              return (
                <RingMeter
                  key={band.key}
                  value={band.value}
                  total={repeat.patterns}
                  label={band.label}
                  colour={BAND_COLOUR[band.key] ?? OI_COLOUR.muted}
                  size={68}
                  stroke={7}
                  tipLines={[both, `${ovPercent(band.value, repeat.patterns)}% of ${plural(repeat.patterns, "pattern", "patterns")}`]}
                  describe={`${both}. Opens those repeat jobs`}
                  onSelect={() => onJobs(rpRecurrenceQuery(band.key, scope, sites))}
                />
              );
            })}
          </div>
        </OiCard>

        {/* Wide — job volume */}
        <OiCard title="Job Volume" pill="Field · Date Requested" wide className="oi-volume">
          <OiLink
            className="oi-volume__figure"
            href={volumeDrill.href}
            onActivate={volumeDrill.go}
            label={`Job volume: ${plural(repeat.jobsInRange, "job", "jobs")} raised in ${range.label}, about ${plural(perMonth, "job", "jobs")} a month over ${plural(months, "month", "months")}. Opens them on the jobs board.`}
          >
            <span className="oi-volume__value">{oiCount(repeat.jobsInRange)}</span>
            <span className="oi-volume__unit">{repeat.jobsInRange === 1 ? "job raised" : "jobs raised"}</span>
          </OiLink>
          <p className="oi-note">
            {range.label} · ≈ {oiCount(perMonth)} {perMonth === 1 ? "job" : "jobs"} / month average over{" "}
            {plural(months, "month", "months")}
          </p>
        </OiCard>
      </div>
    </section>
  );
}

/* ── Section 3 — Compliance ───────────────────────────────────────────────── */

function ComplianceSection({
  query,
  onCompliance,
  onSites,
}: {
  query: Query<CpMetrics>;
  onCompliance: (query: string) => void;
  onSites: (query: string) => void;
}) {
  const { data, error, reload } = query;
  const titleId = "oi-section-compliance";
  const subtitle =
    "Straight from the Compliance tracker — portfolio status, every requirement type, renewals and site readiness, as of today.";

  if (!data) {
    return (
      <section className="oi-section" aria-labelledby={titleId}>
        <SectionHead id={titleId} title="Compliance" subtitle={subtitle} />
        {error ? <SectionError error={error} onRetry={reload} /> : <SectionSkeleton kpis={0} cards={3} />}
      </section>
    );
  }

  const { score, types, countdown, renewals, sites, policy } = data;
  const siteIds = data.portfolio.siteIds;
  /* The payload's own register filter, as the Compliance block applies it. */
  const register = (filter: CpRegisterFilter): Drill => {
    /* The portfolio travels too, so the Compliance page opens on the same
       portfolio its block shows, and its own "old portfolio's sites" rule can
       take the `site=` narrowing off with it when the reader changes it. */
    const base = data.portfolio.id && data.portfolio.id !== "all" ? new URLSearchParams({ portfolio: data.portfolio.id }) : "";
    const registerSearch = registerQuery(base, filter, siteIds).toString();
    return {
      href: routeHref(ROUTE.compliance, registerSearch),
      go: () => onCompliance(registerSearch),
    };
  };

  /* ── Portfolio compliance ──────────────────────────────────────────────── */

  const scoreSlices: OvSlice[] = STATUS_ORDER.map((key) => ({
    key,
    label: STATUS_LABEL[key],
    value: score.counts[key],
    colour: STATUS_COLOUR[key],
    labels: [],
  }));
  const scoreCaption = score.scored
    ? `${oiCount(score.satisfied)} of ${oiCount(score.applicable)} requirements on track`
    : "No requirement on this portfolio is scored yet";
  const outside = [
    score.notRequired > 0 ? `${oiCount(score.notRequired)} not required` : null,
    score.excluded > 0 ? `${oiCount(score.excluded)} unconfirmed or not the client's` : null,
  ].filter(Boolean);

  /* ── Sites fully compliant ─────────────────────────────────────────────── */

  const sitesScored = sites.considered > 0;
  const sitesColour = sitesScored
    ? oiToneColour(qualityTone(sites.percent, policy.thresholds))
    : OI_COLOUR.muted;
  const sitesFailing = sites.notFullyCompliantIds.length > 0;

  /* ── Who's renewing ────────────────────────────────────────────────────── */

  const renewalColours = oiSeriesColours(renewals.slices.map((slice) => slice.key));
  const renewalSlices = toOvSlices(renewals.slices, renewalColours);

  return (
    <section className="oi-section" aria-labelledby={titleId}>
      <SectionHead
        id={titleId}
        title="Compliance"
        subtitle={subtitle}
        pill={`Live figures — ${plural(sites.considered, "site", "sites")} · ${plural(score.applicable, "requirement", "requirements")}`}
      />

      <div className="oi-grid">
        {/* 1 — Portfolio compliance */}
        <OiCard title="Portfolio Compliance" pill="Compliance status" pillTone="critical" className="oi-score">
          <div className="oi-donut">
            <Donut
              slices={scoreSlices}
              total={score.applicable}
              caption={score.scored ? "on track" : "not scored"}
              centreValue={score.scored ? `${score.percent}%` : "—"}
              geometry={DONUT}
              formatValue={oiCount}
              onSelect={(slice) => {
                const filter = score.filters[slice.key as CpStateKey];
                if (filter) register(filter).go();
              }}
              ariaLabel="Portfolio compliance"
            />
            <OiLegend
              rows={scoreSlices.map((slice) => {
                const destination = register(score.filters[slice.key as CpStateKey]);
                return {
                  key: slice.key,
                  label: slice.label,
                  valueText: oiCount(slice.value),
                  colour: slice.colour,
                  href: destination.href,
                  onActivate: destination.go,
                  ariaLabel: `${slice.label}: ${plural(slice.value, "requirement", "requirements")}. Opens the register filtered to this status.`,
                };
              })}
            />
          </div>
          <p className="oi-note">{scoreCaption}</p>
          {outside.length > 0 ? <p className="oi-note">{`${outside.join(" · ")} — outside the score`}</p> : null}
        </OiCard>

        {/* 2 — Sites fully compliant */}
        <OiCard title="Sites Fully Compliant" pill="Field · Site" pillTone="critical">
          <OiGauge
            fraction={sitesScored ? sites.percent / 100 : null}
            value={sitesScored ? `${sites.percent}%` : "—"}
            caption="fully compliant"
            sub={
              sitesScored
                ? `${oiCount(sites.fullyCompliant)} of ${plural(sites.considered, "site", "sites")} fully compliant`
                : "No site has a requirement in the score yet"
            }
            colour={sitesColour}
            onSelect={
              sitesFailing
                ? () => onSites(new URLSearchParams({ sites: sites.notFullyCompliantIds.join("|") }).toString())
                : undefined
            }
            ariaLabel={sitesFailing ? "Sites fully compliant (opens the sites that are not)" : "Sites fully compliant"}
          />
        </OiCard>

        {/* 3 — Who's renewing */}
        <OiCard title="Who's Renewing" pill="Field · Responsibility" pillTone="secondary" className="oi-span-md">
          {renewals.slices.length > 0 ? (
            <div className="oi-donut">
              <Donut
                slices={renewalSlices}
                total={renewals.total}
                caption="renewals due"
                centreValue={oiCount(renewals.total)}
                geometry={DONUT}
                gapPx={2}
                formatValue={oiCount}
                onSelect={(slice) => {
                  const found = renewals.slices.find((entry) => entry.key === slice.key);
                  if (found) register(found.filter).go();
                }}
                ariaLabel="Who's renewing"
              />
              <OiLegend
                rows={renewals.slices.map((slice, index) => {
                  const destination = register(slice.filter);
                  return {
                    key: slice.key,
                    label: slice.label,
                    valueText: oiCount(slice.value),
                    colour: renewalColours[index],
                    href: destination.href,
                    onActivate: destination.go,
                    ariaLabel: `${slice.label}: ${plural(slice.value, "renewal", "renewals")}. Opens the register filtered to them.`,
                  };
                })}
              />
            </div>
          ) : (
            <p className="oi-note oi-empty-note">
              Nothing expired or due in the next {policy.warningWindowDays} days.
            </p>
          )}
          {renewals.unlinked > 0 ? (
            <p className="oi-note">
              {oiCount(renewals.unlinked)} of {oiCount(renewals.total)} name a responsibility, not a contractor record
            </p>
          ) : null}
        </OiCard>

        {/* Wide — compliance by requirement type */}
        <OiCard title="Compliance by Requirement Type" pill="Field · Requirement" wide>
          {types.length > 0 ? (
            <div className="oi-types" role="group" aria-label="Compliance by requirement type">
              {types.map((ring) => {
                const destination = register(ring.filter);
                const { compliant, expiring, expired, missing } = ring.counts;
                return (
                  <div className="oi-type" key={ring.key}>
                    <RingMeter
                      value={compliant}
                      total={ring.total}
                      label={ring.label}
                      colour={oiToneColour(qualityTone(ring.percent, policy.thresholds))}
                      size={64}
                      stroke={7}
                      centreText={`${ring.percent}%`}
                      tipLines={[
                        `Compliant ${oiCount(compliant)} of ${oiCount(ring.total)} · ${ring.percent}%`,
                        `Expiring ${oiCount(expiring)} · Expired ${oiCount(expired)} · Missing ${oiCount(missing)}`,
                      ]}
                      describe="Opens the register filtered to this requirement."
                      onSelect={destination.go}
                    />
                    <span className="oi-type__count" aria-hidden="true">
                      {oiCount(compliant)}/{oiCount(ring.total)}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="oi-note oi-empty-note">No requirement type is in the score yet.</p>
          )}
        </OiCard>

        {/* Wide — renewals outlook */}
        <OiCard
          title="Renewals Outlook"
          pill={`Expired now and due in the next ${policy.warningWindowDays} days`}
          wide
        >
          <div
            className="oi-rings oi-rings--countdown"
            role="group"
            aria-label={`Renewals outlook, ${plural(countdown.total, "renewal", "renewals")} in all`}
          >
            {countdown.rings.map((ring) => (
              <RingMeter
                key={ring.key}
                value={ring.value}
                total={countdown.total}
                label={ring.label}
                colour={COUNTDOWN_COLOUR[ring.key] ?? OI_COLOUR.muted}
                size={72}
                stroke={8}
                onSelect={register(ring.filter).go}
                describe="Opens the register filtered to this window."
              />
            ))}
          </div>
        </OiCard>
      </div>
    </section>
  );
}

/* ── THE JOB DRILLS AND THE RANGE ARITHMETIC ─────────────────────────────────
 *
 * What section 1 sends to the Jobs board, in the vocabulary `readDrillFilter`
 * (`board-drill-filter.ts`) reads, as pair lists — the page appends the
 * portfolio's sites through `rpJobsQuery`, exactly as the Reports block does:
 *
 *   open        family=open — the board's closure test, the rule `closedJobSql`
 *               counts with; NO period, because open work is counted NOW, and a
 *               window would open a shorter list than the figure
 *   overdue     family=open & overdue=1 — `overdueOpenSql`, the jobs failing SLA
 *   breach      family=open & risk=breach — the board's copy of the breach test
 *   completed   measure=completed & period=custom & from & to — completed
 *               inside the range, by completion day; no family, because the
 *               figure tests the DATE, not the status word
 *   a slice     family=open & <dimension>=<the raw values behind it>, piped
 *   aging       family=open & measure=requested & period=custom, from the
 *               oldest aged day to the cutoff — exactly the aged jobs
 *   volume      period=custom & from & to — every job RAISED in the range
 *
 * PURE AND IMPORT-FREE ON PURPOSE: `tests/oi-dash-ui.test.mjs` slices this
 * section out, transpiles it on its own and runs every drill through the
 * board's `readDrillFilter` over the live job list, checking the list it opens
 * against the figure that sends it. Nothing below this line may reach anything
 * above it.
 */

export type OiPair = readonly [string, string];

const OI_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const OI_OPEN: readonly OiPair[] = [["family", "open"]];
export const OI_OVERDUE: readonly OiPair[] = [["family", "open"], ["overdue", "1"]];
export const OI_BREACH: readonly OiPair[] = [["family", "open"], ["risk", "breach"]];

/** The pipe-joined list the board's filter splits on; blanks dropped. */
function oiPipe(labels: readonly string[]): string {
  return labels.filter(Boolean).join("|");
}

/** Completed inside the range, by completion day. */
export function oiCompletedPairs(range: { from: string; to: string }): OiPair[] {
  return [
    ["measure", "completed"],
    ["period", "custom"],
    ["from", range.from],
    ["to", range.to],
  ];
}

/**
 * A status segment or legend row. `meter` names the chip after the segment
 * tapped; `status` carries the raw labels it folded, so "Other statuses" opens
 * every status inside it rather than one called "Other".
 */
export function oiStatusPairs(slice: { label: string; labels: readonly string[] }): OiPair[] {
  return [...OI_OPEN, ["meter", slice.label], ["status", oiPipe(slice.labels)]];
}

/** Open jobs in one slice of a dimension — `priority`, `tier`, `engineer` or `label`. */
export function oiOpenByPairs(
  dimension: "priority" | "tier" | "engineer" | "label",
  labels: readonly string[],
): OiPair[] {
  return [...OI_OPEN, [dimension, oiPipe(labels)]];
}

/**
 * The aged open jobs: requested from the oldest aged day to the cutoff, both
 * inclusive. Null when nothing is aged — there is no window to send, and a
 * drill with none would open every open job under a figure of nought.
 */
export function oiAgingPairs(aging: { oldestDay: string | null; cutoff: string }): OiPair[] | null {
  if (!aging.oldestDay || !OI_DAY.test(aging.oldestDay) || !OI_DAY.test(aging.cutoff)) return null;
  return [
    ...OI_OPEN,
    ["measure", "requested"],
    ["period", "custom"],
    ["from", aging.oldestDay],
    ["to", aging.cutoff],
  ];
}

/** Every job raised in the range — the board windows on the requested day by default. */
export function oiVolumePairs(range: { from: string; to: string }): OiPair[] {
  return [
    ["period", "custom"],
    ["from", range.from],
    ["to", range.to],
  ];
}

/**
 * THE DEFAULT RANGE: the last twelve months, month-aligned — the first day of
 * the month eleven months before this one, to today. UTC days, so no timezone
 * can move either bound; the server labels the window it actually counted.
 */
/** A real calendar day in `YYYY-MM-DD` — "2026-02-30" is not one. */
export function oiIsCalendarDay(day: string): boolean {
  if (!OI_DAY.test(day)) return false;
  const at = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === day;
}

export function oiDefaultRange(now: Date): { from: string; to: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  return { from: start.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
}

/**
 * THE NAMED SPANS the range picker offers — the Overview's presets, as the
 * old period control offered them, plus the default twelve months. UTC days,
 * like the default, and the server still labels what it counted.
 */
export function oiRangePresets(now: Date): Array<{ key: string; label: string; from: string; to: string }> {
  const day = (at: Date) => at.toISOString().slice(0, 10);
  const today = day(now);
  const back = (days: number) => day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days)));
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return [
    { key: "7", label: "Last 7 days", from: back(6), to: today },
    { key: "30", label: "Last 30 days", from: back(29), to: today },
    { key: "90", label: "Last 90 days", from: back(89), to: today },
    { key: "month", label: "This month", from: day(new Date(Date.UTC(year, month, 1))), to: today },
    {
      key: "last-month",
      label: "Last month",
      from: day(new Date(Date.UTC(year, month - 1, 1))),
      to: day(new Date(Date.UTC(year, month, 0))),
    },
    { key: "ytd", label: "Year to date", from: `${year}-01-01`, to: today },
    { key: "12m", label: "Last 12 months", ...oiDefaultRange(now) },
  ];
}

/**
 * The calendar months a range touches, inclusive — 1 Oct 2025 to 11 Sept 2026
 * is twelve. Arithmetic on the day STRINGS, never on a `Date`, and never less
 * than one, so the job-volume average cannot divide by nothing.
 */
export function oiMonthsSpanned(from: string, to: string): number {
  if (!OI_DAY.test(from) || !OI_DAY.test(to)) return 1;
  const [low, high] = from <= to ? [from, to] : [to, from];
  const months =
    (Number(high.slice(0, 4)) - Number(low.slice(0, 4))) * 12 +
    (Number(high.slice(5, 7)) - Number(low.slice(5, 7))) +
    1;
  return Math.max(1, months);
}

/* ── End of the job drills ────────────────────────────────────────────────── */
