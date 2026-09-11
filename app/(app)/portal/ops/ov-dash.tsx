"use client";

/**
 * DASHBOARD OVERVIEW — the visual block that opens the Operations Overview.
 *
 * Six KPI cards, a priority-and-SLA widget, a status donut, a spend trend, a
 * compliance gauge and a category ring, all drawn from ONE call to
 * `/api/overview/metrics`. The endpoint computes the whole block in a single
 * pass from a single `new Date()` and reconciles §5.3's six identities before
 * it answers, so no two widgets on this screen can disagree about what time it
 * is or how many jobs are open.
 *
 * ── THIS FILE COMPOSES; IT DOES NOT COMPUTE ───────────────────────────────
 *
 * There is no arithmetic over job rows here and there cannot be: the component
 * is never given a job list. The only numbers it derives are the ones a reader
 * asked for by pressing a control — which twelve of the returned spend months
 * to draw — and that is a filter over data already on the page, not a
 * recount.
 *
 * ── THE WIRE TYPES ARE RESTATED, NOT IMPORTED ─────────────────────────────
 *
 * `app/lib/overview-metrics.ts` owns the payload and exports these types, but
 * it imports drizzle and `db/schema`. `overview-page.tsx` carries the note
 * that made this rule — two words taken from `dashboard-filters.ts` would drag
 * the whole query builder into the browser bundle — and the safe half of it,
 * `import type`, is one careless edit away from the unsafe half. So the wire
 * shape is declared here, the way `overview-contract.ts` declares it for the
 * cards below, and the endpoint's own tests hold the server to it.
 *
 * ── WHAT IT REFUSES TO DO ─────────────────────────────────────────────────
 *
 * No table and no text list. Every figure is a widget, and every widget is a
 * link. Where a destination cannot express the filter the figure was counted
 * with, the link sends NOTHING rather than a parameter nothing reads — an
 * unread parameter draws a chip claiming a narrowing that never happened, and
 * `board-drill-filter.ts`'s header records what that cost the last time. The
 * three places that applies are named in the comments beside them.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import ovDashCss from "./ov-dash.css?url";
import { useOpsQuery, useQueryState } from "./ops-url-state";
import {
  AreaTrend,
  Donut,
  Horseshoe,
  RadialRings,
  RingMeter,
  Sparkline,
  Speedometer,
} from "./ov-dash-charts";
/*
 * THE CSV NEUTRALISER, FROM THE MODULE THAT ALREADY OWNS THE RULE.
 *
 * `csvCell` quotes every field and prefixes `=`, `+`, `@`, a tab, a carriage
 * return and a leading minus that is NOT a plain number with an apostrophe.
 * `ops-primitives.tsx` also has a `downloadCsv`, and it is deliberately not
 * used here: it quotes but neutralises nothing, and that file is not this
 * agent's to fix. `finance/exports.ts` imports only `./model`, which imports
 * nothing at all, so none of it reaches drizzle.
 */
import { csvCell, poundsText, safeFilename } from "../../../lib/finance/exports";

/* ── The wire shape ───────────────────────────────────────────────────────── */

type OvSlice = {
  key: string;
  label: string;
  value: number;
  colour: string;
  /**
   * The values the slice STANDS FOR, which is not its display label: "Other"
   * is a dozen folded categories and "High" is the `PriorityKey` `urgent`.
   * Every drill below joins this with a pipe, which is the list form
   * `readDrillFilter` splits on.
   */
  labels: string[];
};

type OvSparkPoint = { day: string; value: number };

type OvKpiKey =
  | "activeUnits"
  | "attention"
  | "openJobs"
  | "overdue"
  | "completed"
  | "compliance";

type OvKpi = {
  key: OvKpiKey;
  label: string;
  value: number;
  isPercent: boolean;
  /**
   * NULL WHERE NO HISTORY EXISTS. Active units, Requiring attention and
   * Compliance carry `null` because nothing records what any of them was on a
   * past date and there is no snapshot table. A flat line drawn from today's
   * figure would be an invention, so those cards draw no sparkline at all.
   */
  spark: OvSparkPoint[] | null;
};

type OvMetrics = {
  range: { from: string; to: string; label: string };
  /* `siteIds` is the portfolio's member sites, so a drill can carry the
     portfolio across to a board that speaks `site=` rather than group ids.
     Empty for "All portfolios", where there is nothing to narrow. */
  portfolio: { id: string; name: string; siteIds: string[] };
  portfolios: { id: string; name: string }[];
  kpis: OvKpi[];
  jobsByStatus: OvSlice[];
  sla: { percent: number; open: number; overdue: number; withinSla: number };
  priority: OvSlice[];
  categories: OvSlice[];
  compliance: {
    percent: number;
    satisfied: number;
    applicable: number;
    notRequired: number;
    scored: boolean;
  };
  spend: { month: string; label: string; pence: number }[];
  openJobs: number;
  /* The sites behind "Requiring attention", so its tile opens exactly them. */
  attentionSiteIds: string[];
  /** Empty when every §5.3 identity held. Carried into the export, below. */
  reconciliation: string[];
};

/** One point as every chart in `ov-dash-charts` might want it — see `TREND` below. */
type TrendPoint = {
  month: string;
  day: string;
  label: string;
  value: number;
  pence: number;
};

/* ── Configuration ────────────────────────────────────────────────────────── */

/**
 * The block's palette, restated from `OV_COLOURS` in `app/lib/overview-metrics.ts`
 * for the same reason the types are: that module reaches drizzle. A slice's own
 * colour always wins — these are only for the six KPI cards, which the payload
 * does not colour because they are not slices.
 */
const OV_COLOURS = {
  teal: "#46A2AD",
  amber: "#E3A140",
  blue: "#5A7293",
  green: "#5E946E",
  red: "#D34E49",
} as const;

const KPI_COLOUR: Record<OvKpiKey, string> = {
  activeUnits: OV_COLOURS.teal,
  attention: OV_COLOURS.amber,
  openJobs: OV_COLOURS.blue,
  overdue: OV_COLOURS.red,
  completed: OV_COLOURS.green,
  compliance: OV_COLOURS.teal,
};

/**
 * THE ARC THRESHOLDS, NAMED RATHER THAN INLINE.
 *
 * A percentage arc is teal at or above `good`, amber from `warn` up to it, and
 * red below. Named because these are a policy — the number at which somebody
 * decides service is acceptable — and a policy written as `>= 90` inside a JSX
 * expression is one nobody can find when it changes.
 *
 * They colour the two arcs that ARE a quality percentage: the SLA speedometer
 * and the compliance horseshoe. The priority rings take `slice.colour` from the
 * payload instead, because a priority ring's share of open work is not a score
 * — a small High-priority ring is good news, and painting it red for being
 * under 75 would say the opposite.
 */
const ARC_THRESHOLDS = { good: 90, warn: 75 } as const;

function arcColour(percent: number): string {
  if (percent >= ARC_THRESHOLDS.good) return OV_COLOURS.teal;
  if (percent >= ARC_THRESHOLDS.warn) return OV_COLOURS.amber;
  return OV_COLOURS.red;
}

/** §5.4: poll while the tab is visible. Sixty seconds, as the brief asks. */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * The real routes, from `sectionRoutes` in `portal-app.tsx`.
 *
 * Jobs and Compliance are reached through the props, which go through the
 * shell's own client-side navigation. Units and Reports have no such prop, so
 * they are reached by their address — see `goToShell`.
 */
const ROUTE = {
  jobs: "/dashboard/jobs",
  units: "/dashboard/units",
  sites: "/dashboard/sites",
  compliance: "/dashboard/compliance",
  reports: "/dashboard/reports",
} as const;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * WHAT AN "OPEN JOBS" DRILL CARRIES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * `family=open` is `readDrillFilter`'s own closure test — `!isClosed`, which
 * mirrors `closedJobSql` exactly — and it is the same population `openScope`
 * counts in `loadOverviewMetrics`.
 *
 * NO PERIOD. Open jobs, overdue, the status donut, the priority rings and the
 * category rings are all point-in-time counts: `openScope` carries no date
 * bound at all. Attaching the block's date range to them would open a shorter
 * list than the figure that was tapped, which is precisely the defect
 * `board-drill-filter.ts` was written to end ("the tile read 15 and the board
 * opened 20"). An absent `period` makes `resolveDays` return no window, so the
 * board filters on the dimension alone.
 */
const OPEN_ONLY: Readonly<Record<string, string>> = { family: "open" };

/**
 * OVERDUE, WHICH IS NOW A REAL DIMENSION.
 *
 * The Overdue KPI and the SLA speedometer both mean "open work past its date",
 * and until `board-drill-filter.ts` learned `overdue`, the only honest thing
 * either could send was `family=open` — a superset that opened 98 rows under a
 * tile reading 73. The filter mirrors `overdueOpenSql`, including its
 * day-versus-instant rule, so the list is now exactly the figure.
 */
const OVERDUE_ONLY: Readonly<Record<string, string>> = { family: "open", overdue: "1" };

/* ── Small helpers ────────────────────────────────────────────────────────── */

function pipe(labels: readonly string[]): string {
  return labels.filter(Boolean).join("|");
}

/**
 * The slice a chart just reported, whatever shape it reported it in.
 *
 * `ov-dash-charts.tsx` is written concurrently with this file and its `onSelect`
 * could hand back the slice, its key or its index. All three are resolved here
 * rather than guessed at once, and the handler takes `unknown` so it stays
 * assignable to any of those signatures. The legend rows beside every chart are
 * ordinary links built from the same slice, so a reader can reach every segment
 * even if a chart hands back something none of these three arms recognise.
 */
function sliceFrom(argument: unknown, slices: readonly OvSlice[]): OvSlice | null {
  if (typeof argument === "number") return slices[argument] ?? null;
  if (typeof argument === "string") {
    return slices.find((slice) => slice.key === argument || slice.label === argument) ?? null;
  }
  if (argument && typeof argument === "object") {
    const candidate = argument as Partial<OvSlice>;
    if (typeof candidate.key === "string") {
      const found = slices.find((slice) => slice.key === candidate.key);
      if (found) return found;
    }
    if (typeof candidate.label === "string") {
      const found = slices.find((slice) => slice.label === candidate.label);
      if (found) return found;
    }
  }
  return null;
}

/** The same tolerance, for the one chart whose points are months rather than slices. */
function pointFrom(argument: unknown, points: readonly TrendPoint[]): TrendPoint | null {
  if (typeof argument === "number") return points[argument] ?? null;
  if (typeof argument === "string") {
    return points.find((point) => point.month === argument || point.label === argument) ?? null;
  }
  if (argument && typeof argument === "object") {
    const candidate = argument as Partial<TrendPoint>;
    if (typeof candidate.month === "string") {
      return points.find((point) => point.month === candidate.month) ?? null;
    }
  }
  return null;
}

function countText(value: number): string {
  return value.toLocaleString("en-GB");
}

/**
 * A sparkline series under every field name a sparkline might want it under.
 *
 * The same reason `TrendPoint` carries five: the chart module is being written
 * alongside this file, and a named local rather than an inline literal means
 * TypeScript checks assignability without excess-property checking, so the
 * series satisfies `{day, value}`, `{label, value}` or any subset of them.
 */
function sparkPoints(spark: readonly OvSparkPoint[]): Array<{
  day: string;
  label: string;
  value: number;
}> {
  return spark.map((point) => ({ day: point.day, label: point.day, value: point.value }));
}

/* ── The block ────────────────────────────────────────────────────────────── */

export function OvDash({
  onNavigateToJobs,
  onNavigateToCompliance,
}: {
  /** The page's own `goToJobs`. Navigates the shell first, then replaces the
      history entry with the filtered address — the order is load-bearing and
      its reasoning lives at the call site in `portal-app.tsx`. */
  onNavigateToJobs: (query: string) => void;
  onNavigateToCompliance: () => void;
}) {
  const { params, setParams } = useQueryState();

  /*
   * THE THREE PARAMETERS THIS BLOCK OWNS, AND NOTHING ELSE.
   *
   * `portfolio`, `from` and `to` are read out of the address bar so a filtered
   * dashboard is a link, exactly as `ops-url-state.ts` requires of every
   * surface here. The fetch key is rebuilt from those three ALONE rather than
   * from `window.location.search`: the Overview below owns nine more filter
   * dimensions in the same query string, this endpoint reads none of them, and
   * including them would refetch the whole block every time somebody touched a
   * chip that cannot change a single figure in it.
   *
   * `from`/`to` are shared with the page below on purpose. That page resolves
   * its window from `period` and only consults `from`/`to` when `period` is
   * `custom`, so writing them here changes nothing beneath by default, and when
   * a reader HAS chosen a custom window the two agree rather than contradict.
   * This control never writes `period`, so it cannot silently re-cut the cards
   * below.
   */
  const portfolio = params.get("portfolio") ?? "";
  const fromParam = params.get("from") ?? "";
  const toParam = params.get("to") ?? "";

  const search = useMemo(() => {
    const next = new URLSearchParams();
    if (portfolio) next.set("portfolio", portfolio);
    if (DAY_PATTERN.test(fromParam)) next.set("from", fromParam);
    if (DAY_PATTERN.test(toParam)) next.set("to", toParam);
    return next.toString();
  }, [portfolio, fromParam, toParam]);

  /*
   * One round trip for the whole block. `useOpsQuery` keeps the previous
   * payload on screen while the next one is in flight — the reason the cards
   * below stopped flickering to empty on every filter tap — so §5.5's "keep
   * previous values visible during a refetch" comes for free, and `.ov-skeleton`
   * is reserved for the one render where there is genuinely nothing yet.
   *
   * It also answers the topbar's Refresh, which broadcasts `OPS_REFRESH`.
   */
  const { data, loading, error, reload } = useOpsQuery<OvMetrics>(
    "/api/overview/metrics",
    search,
  );

  /*
   * §5.4 — REFETCH ON FOCUS, AND POLL WHILE VISIBLE.
   *
   * THIS APPLICATION HAS NO REALTIME TRANSPORT. There is no WebSocket, no SSE
   * endpoint and no subscription client anywhere in `app/` — every surface in
   * the portal reads by fetch and re-reads when something tells it to. So the
   * freshness contract has to be polling, and it is bounded: the interval and
   * both listeners check `document.visibilityState` first, so a tab left open
   * on a second monitor overnight issues no requests at all.
   *
   * `reload` rather than a `setState` in the effect body: it is the stable
   * `useCallback` `useOpsQuery` returns, and it is called from a listener and a
   * timer, never during the effect — which is what `react-hooks/set-state-in-effect`
   * is about.
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
   * NAVIGATION TO A SECTION THE PAGE HAS NO CALLBACK FOR.
   *
   * The shell re-derives its active section from `location.pathname`, but only
   * inside its `popstate` handler — `pushState` and `replaceState` fire
   * nothing. `OverviewPage` is handed callbacks for Jobs, Compliance and Sites
   * and for nothing else, and adding one for Units or Reports means editing
   * `portal-app.tsx`, which this change does not own.
   *
   * So the address is pushed and the shell's OWN handler is asked to run. The
   * elements that use this are real `<a href>` anchors, so Enter, middle-click
   * and "open in new tab" all behave; the click handler only intercepts a plain
   * left click, and anything else falls through to the browser's navigation.
   */
  const goToShell = useCallback((href: string) => {
    window.history.pushState({}, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  /*
   * A SHELL ROUTE WITH ITS FILTER ON IT.
   *
   * §6: "Links always carry the current portfolio and date range." The date
   * range is deliberately absent from the point-in-time destinations below —
   * Sites and Units both show what is true NOW, and neither reads a window, so
   * attaching one would be a parameter nothing reads sitting in a shared link.
   * What does travel is the narrowing: the portfolio's sites for the unit
   * register, and the exact attention set for the site register.
   *
   * An empty value is omitted rather than written, so a workspace with no
   * portfolio chosen gets a clean address rather than `?site=`.
   */
  const shellHref = useCallback((route: string, extra: Record<string, string>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(extra)) if (value) next.set(key, value);
    const query = next.toString();
    return query ? `${route}?${query}` : route;
  }, []);

  /*
   * A DRILL CARRIES WHAT THE FIGURE WAS COUNTED WITH, AND NOTHING MORE.
   *
   * Built here rather than through the page's own `drill()` helper, and that is
   * a deliberate divergence. `drill()` merges the ENTIRE effective search — the
   * Overview's nine filter dimensions, its cohort axis and its period — into
   * every link. None of those participated in counting anything in this block:
   * `/api/overview/metrics` reads `portfolio`, `from` and `to` and ignores the
   * rest. A reader who had narrowed the page below to one site would tap a
   * donut segment reading 12 and open a board showing four, under a chip that
   * says the site filter was intended. That is the same class of failure
   * `board-drill-filter.ts` exists to have ended.
   *
   * The MECHANISM is still the page's: `onNavigateToJobs` is `goToJobs`, with
   * its section-then-history ordering intact.
   */
  /*
   * THE PORTFOLIO TRAVELS WITH EVERY DRILL, AS THE SITES IT IS MADE OF.
   *
   * §6: "Links always carry the current portfolio and date range." A portfolio
   * is a `site_groups` row and the board's filter speaks `site=`, so sending
   * the group id would narrow nothing — the reader taps a figure counted over
   * two stores and opens a board showing the whole estate, which is the same
   * "list wider than the figure" fault everything else here is careful about.
   *
   * `/api/overview/metrics` returns the chosen portfolio's member site ids for
   * exactly this, and the list is empty for "All portfolios", where there is
   * nothing to narrow and the parameter is therefore omitted rather than sent
   * empty.
   */
  const portfolioSites = useMemo(() => pipe(data?.portfolio.siteIds ?? []), [data]);

  const jobsQuery = useCallback(
    (extra: Record<string, string>) => {
      const next = new URLSearchParams();
      for (const [key, value] of Object.entries(extra)) if (value) next.set(key, value);
      if (portfolioSites) next.set("site", portfolioSites);
      return next.toString();
    },
    [portfolioSites],
  );

  const jobsHref = useCallback(
    (extra: Record<string, string>) => {
      const query = jobsQuery(extra);
      return query ? `${ROUTE.jobs}?${query}` : ROUTE.jobs;
    },
    [jobsQuery],
  );

  const goToJobs = useCallback(
    (extra: Record<string, string>) => onNavigateToJobs(jobsQuery(extra)),
    [jobsQuery, onNavigateToJobs],
  );

  /*
   * The one drill that IS windowed. `completed` is the only KPI counted over
   * the range — `completedAt IS NOT NULL AND day >= from AND day < from+1` —
   * and `measure=completed` plus `period=custom` is the exact same test in the
   * board's vocabulary, including its refusal of a row with no completion date.
   * No `family`: the aggregate tests the DATE, not the status word, and
   * `statusFamily` falls back to `in_progress` for a label it does not know.
   */
  const completedExtra = useMemo(
    () => ({
      measure: "completed",
      period: "custom",
      from: data?.range.from ?? "",
      to: data?.range.to ?? "",
    }),
    [data],
  );

  /* ── Spend, filtered rather than refetched ──────────────────────────────── */

  /*
   * A VIEW OVER THE TWELVE MONTHS ALREADY RETURNED, NOT A SECOND QUERY.
   *
   * The payload always carries twelve months ending at the range's own month,
   * so "This year" and "This quarter" are a filter over data on the page. The
   * arithmetic is on the month STRING — `2026-09` — and never on a `Date`,
   * which is what keeps the one piece of date maths this codebase centralises
   * on the server and out of the reader's timezone.
   *
   * Held in component state rather than the URL, unlike the three filters
   * above. It changes no figure, and every key this page adds to the query
   * string is copied by the page's `drill()` into the board's address — where
   * nothing reads it and the board's own "Clear" cannot strip it, because
   * `DRILL_KEYS` does not list it.
   */
  const [spendView, setSpendView] = useState<"12m" | "year" | "quarter">("12m");

  const trend = useMemo<TrendPoint[]>(() => {
    const rows = data?.spend ?? [];
    const anchorYear = (data?.range.to ?? "").slice(0, 4);
    const anchorMonth = Number((data?.range.to ?? "").slice(5, 7));
    const anchorQuarter = anchorMonth > 0 ? Math.ceil(anchorMonth / 3) : 0;
    const chosen = rows.filter((row) => {
      if (spendView === "12m") return true;
      if (row.month.slice(0, 4) !== anchorYear) return false;
      if (spendView === "year") return true;
      const month = Number(row.month.slice(5, 7));
      return anchorQuarter > 0 && month > 0 && Math.ceil(month / 3) === anchorQuarter;
    });
    /*
     * Every plausible field name for the same point.
     *
     * `ov-dash-charts.tsx` declares what `AreaTrend`'s `points` are and is being
     * written alongside this file. Mapping into a named local first — rather
     * than passing an object literal at the call site — means TypeScript checks
     * assignability without excess-property checking, so a point carrying
     * `label`, `value`, `month`, `day` and `pence` satisfies any subset of them
     * the component turns out to ask for.
     */
    return chosen.map((row) => ({
      month: row.month,
      day: row.month,
      label: row.label,
      value: row.pence,
      pence: row.pence,
    }));
  }, [data, spendView]);

  /* ── Export ─────────────────────────────────────────────────────────────── */

  /*
   * §5.5 — every metric on screen, under the filters that produced it.
   *
   * Written from the payload the reader is looking at rather than re-fetched,
   * which is the one failure an export must not have: a file that disagrees
   * with the screen it was taken from. The filter values and a timestamp are
   * the first rows, so a file found on a desktop three weeks later still says
   * what it is, and the reconciliation line travels with it — if a subtotal
   * drifted, the export says so rather than being quietly wrong.
   */
  const exportCsv = useCallback(() => {
    if (!data) return;
    const lines: string[] = [];
    const row = (...cells: unknown[]) => lines.push(cells.map(csvCell).join(","));

    row("MAINTSUPP — Dashboard Overview");
    row("Generated", new Date().toISOString());
    row("Portfolio", data.portfolio.name);
    row("Date range", data.range.label);
    row("From", data.range.from);
    row("To", data.range.to);
    row(
      "Reconciliation",
      data.reconciliation.length > 0
        ? data.reconciliation.join("; ")
        : "Every §5.3 identity held",
    );
    row("");

    row("Section", "Item", "Value", "Unit");
    for (const kpi of data.kpis) {
      const unscored = kpi.key === "compliance" && !data.compliance.scored;
      row("Key figures", kpi.label, unscored ? "" : kpi.value, unscored ? "not scored" : kpi.isPercent ? "percent" : "count");
    }
    row("Priority & SLA", "Within SLA", data.sla.percent, "percent");
    row("Priority & SLA", "Open jobs", data.sla.open, "count");
    row("Priority & SLA", "Within SLA", data.sla.withinSla, "count");
    row("Priority & SLA", "Overdue", data.sla.overdue, "count");
    for (const slice of data.priority) row("Priority", slice.label, slice.value, "open jobs");
    for (const slice of data.jobsByStatus) row("Jobs by status", slice.label, slice.value, "open jobs");
    for (const slice of data.categories) row("Jobs by category", slice.label, slice.value, "open jobs");
    row(
      "Compliance",
      "Score",
      data.compliance.scored ? data.compliance.percent : "",
      data.compliance.scored ? "percent" : "not scored",
    );
    row("Compliance", "Requirements on track", data.compliance.satisfied, "count");
    row("Compliance", "Requirements applicable", data.compliance.applicable, "count");
    row("Compliance", "Requirements not required", data.compliance.notRequired, "count");
    for (const point of data.spend) {
      row("Spend trend", `${point.label} ${point.month}`, poundsText(point.pence), "GBP");
    }

    /* CRLF and a BOM, matching `csvDocument` — the audience is Excel, and a
       bare UTF-8 CSV opens as the system codepage with every pound sign in a
       site name turned to mojibake. */
    const blob = new Blob([`﻿${lines.join("\r\n")}\r\n`], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safeFilename(`dashboard-overview-${data.range.from}-to-${data.range.to}.csv`);
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [data]);

  /* ── The header, which is usable before the first payload lands ─────────── */

  const header = (
    <div className="ov-dash__head">
      <h2 className="ov-dash__title">Dashboard Overview</h2>
      <div className="ov-dash__controls">
        <label className="ov-dash__control">
          <span className="visually-hidden">Portfolio</span>
          <select
            value={portfolio}
            onChange={(event) => {
              const next = event.target.value;
              setFilter((query) => {
                if (next) query.set("portfolio", next);
                else query.delete("portfolio");
              });
            }}
          >
            <option value="">All portfolios</option>
            {(data?.portfolios ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>

        {/*
          THE DATE RANGE — TWO BOUNDS AND A RESET, AND NO PRESET THAT NEEDS
          DAY ARITHMETIC.

          "Last 7 days" would have to be computed here, in the reader's
          timezone, against a `to` that is inclusive while every window in this
          product ends exclusive — the one piece of date maths this codebase
          keeps on the server precisely so the two cannot drift. So the control
          collects two days and the SERVER resolves, defaults and labels the
          window; the pill always shows `range.label`, which is the window the
          figures were actually counted over rather than the one that was asked
          for. Clearing both returns to the endpoint's own default of thirty
          days.
        */}
        <details className="ov-dash__control ov-dash__range" style={{ position: "relative" }}>
          <summary aria-label={`Date range: ${data?.range.label ?? "loading"}`}>
            <CalendarIcon /> <span>{data?.range.label ?? "Date range"}</span>
          </summary>
          <div
            className="ov-dash__range-panel"
            style={{
              position: "absolute",
              insetInlineEnd: 0,
              insetBlockStart: "calc(100% + 6px)",
              zIndex: 30,
              display: "grid",
              gap: "8px",
              padding: "12px",
              minInlineSize: "220px",
              borderRadius: "10px",
              background: "var(--ops-surface, Canvas)",
              border: "1px solid var(--ops-border, CanvasText)",
              boxShadow: "0 12px 32px rgb(0 0 0 / 28%)",
            }}
          >
            <label>
              From{" "}
              <input
                type="date"
                value={fromParam}
                onChange={(event) => {
                  const next = event.target.value;
                  setFilter((query) => {
                    if (next) query.set("from", next);
                    else query.delete("from");
                  });
                }}
              />
            </label>
            <label>
              To{" "}
              <input
                type="date"
                value={toParam}
                onChange={(event) => {
                  const next = event.target.value;
                  setFilter((query) => {
                    if (next) query.set("to", next);
                    else query.delete("to");
                  });
                }}
              />
            </label>
            <button
              type="button"
              onClick={() =>
                setFilter((query) => {
                  query.delete("from");
                  query.delete("to");
                })
              }
            >
              Reset to the last 30 days
            </button>
          </div>
        </details>

        <button
          type="button"
          className="ov-dash__control"
          onClick={exportCsv}
          disabled={!data}
        >
          Export
        </button>

        {/* A refetch that failed while a payload is still on screen: the
            figures stay, and the reason is one press away rather than a
            silently stale page. */}
        {error ? (
          <button type="button" className="ov-dash__control" onClick={reload} title={error}>
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );

  if (!data) {
    return (
      <>
        <link rel="stylesheet" href={ovDashCss} precedence="default" />
        <section className="ov-dash" aria-busy={loading} aria-label="Dashboard overview">
          {header}
          {error ? (
            <p className="ov-card">{error}</p>
          ) : (
            <>
              <div className="ov-kpis">
                {[0, 1, 2, 3, 4, 5].map((slot) => (
                  <div key={slot} className="ov-kpi ov-skeleton" />
                ))}
              </div>
              <div className="ov-row2">
                <div className="ov-card ov-skeleton" />
                <div className="ov-card ov-skeleton" />
              </div>
              <div className="ov-row3">
                <div className="ov-card ov-skeleton" />
                <div className="ov-card ov-skeleton" />
                <div className="ov-card ov-skeleton" />
              </div>
            </>
          )}
        </section>
      </>
    );
  }

  const { compliance, jobsByStatus, categories, openJobs, priority, sla } = data;
  const complianceCaption = compliance.scored
    ? `${countText(compliance.satisfied)} of ${countText(compliance.applicable)} requirements on track`
    : "No requirement on this portfolio is scored yet";

  /* ── The destinations ───────────────────────────────────────────────────
   *
   * Below the guard, so `data` is known to exist and every one of them can
   * state its figure in the accessible name of the link that opens it.
   */

  /**
   * A status segment or legend row.
   *
   * `meter` names the chip after the segment the reader tapped; `status`
   * carries the raw labels that segment folded — two source statuses can share
   * one display label, and `readDrillFilter` splits on the pipe. Without
   * `meter` the chip would read "Status: 2 selected", which names nothing.
   */
  const goToStatus = (slice: OvSlice) =>
    goToJobs({ ...OPEN_ONLY, meter: slice.label, status: pipe(slice.labels) });

  /** A category ring or legend row. `label` is the board's word for `category`. */
  const goToCategory = (slice: OvSlice) =>
    goToJobs({ ...OPEN_ONLY, label: pipe(slice.labels) });

  const kpiTarget = (key: OvKpiKey): { href: string; go: () => void; describe: string } => {
    switch (key) {
      /*
       * ACTIVE UNITS opens the unit register, narrowed to the portfolio when
       * one is chosen. `units-manager.tsx` now reads `site=` from the address
       * bar, so the register shows the same estate the figure was counted over
       * instead of every unit in the workspace.
       */
      case "activeUnits": {
        /*
         * ONE site or none. `units-manager.tsx` reads `site=` and its control
         * is a single-site select, so a portfolio of several stores cannot be
         * expressed there — and sending a pipe-joined list would be a
         * parameter that screen deliberately ignores. A portfolio of exactly
         * one store narrows it; anything else opens the full register.
         */
        const chosen = data?.portfolio.siteIds ?? [];
        const only: Record<string, string> = chosen.length === 1 ? { site: chosen[0] } : {};
        const href = shellHref(ROUTE.units, only);
        return { href, go: () => goToShell(href), describe: "Opens the unit register." };
      }
      /*
       * REQUIRING ATTENTION OPENS SITES, NOT UNITS — and the owner chose that
       * destination for the reason the figure itself gives.
       *
       * §5.2 defines it as "distinct UNITS with at least one open job that is
       * high or medium priority, or overdue". This estate does not file work
       * against units; it files it against SITES, and the aggregate counts
       * `site_id` accordingly — the endpoint says so where it counts them. So
       * the truthful destination is the site register, and the truthful filter
       * is the exact set of sites the figure counted, which the payload now
       * carries as `attentionSiteIds`.
       *
       * `sites=` rather than `site=`: the latter is already taken by the site
       * DETAIL deep link, and handing it a pipe-joined list would ask for a
       * site whose id is "a|b|c" and open nothing.
       */
      case "attention":
        return {
          href: shellHref(ROUTE.sites, { sites: pipe(data?.attentionSiteIds ?? []) }),
          go: () => goToShell(shellHref(ROUTE.sites, { sites: pipe(data?.attentionSiteIds ?? []) })),
          describe: "Opens the sites with work needing attention.",
        };
      case "openJobs":
        return {
          href: jobsHref(OPEN_ONLY),
          go: () => goToJobs(OPEN_ONLY),
          describe: "Opens the open jobs list.",
        };
      /*
       * OVERDUE OPENS EXACTLY THE OVERDUE LIST.
       *
       * This used to open the open list — the honest superset — because
       * `board-drill-filter.ts` had no due-date dimension and a parameter it
       * could not read would have drawn a chip claiming a filter that never
       * happened. It has one now, mirroring `overdueOpenSql` including its
       * day-versus-instant rule, so the list is the figure rather than a
       * superset of it.
       */
      case "overdue":
        return {
          href: jobsHref(OVERDUE_ONLY),
          go: () => goToJobs(OVERDUE_ONLY),
          describe: "Opens the overdue jobs.",
        };
      case "completed":
        return {
          href: jobsHref(completedExtra),
          go: () => goToJobs(completedExtra),
          describe: "Opens the jobs completed in this range.",
        };
      case "compliance":
      default:
        return {
          href: ROUTE.compliance,
          go: onNavigateToCompliance,
          describe: "Opens the compliance register.",
        };
    }
  };

  return (
    <>
      <link rel="stylesheet" href={ovDashCss} precedence="default" />
      <section className="ov-dash" aria-busy={loading} aria-label="Dashboard overview">
        {header}

        {/* ── Row 1: the six figures ─────────────────────────────────────── */}
        <div className="ov-kpis">
          {data.kpis.map((kpi) => {
            const colour = KPI_COLOUR[kpi.key];
            const unscored = kpi.key === "compliance" && !compliance.scored;
            const target = kpiTarget(kpi.key);
            return (
              <OvLink
                key={kpi.key}
                className="ov-kpi"
                href={target.href}
                onActivate={target.go}
                label={`${kpi.label}: ${unscored ? "not scored" : kpi.isPercent ? `${kpi.value}%` : countText(kpi.value)}. ${target.describe}`}
                style={{ "--ov-kpi-colour": colour } as CSSProperties}
              >
                <span className="ov-kpi__tile" style={{ color: colour }} aria-hidden="true">
                  <KpiIcon name={kpi.key} />
                </span>
                <span className="ov-kpi__label">{kpi.label}</span>
                <span className="ov-kpi__value">
                  {unscored ? "—" : kpi.isPercent ? `${kpi.value}%` : countText(kpi.value)}
                </span>
                {kpi.spark && kpi.spark.length > 0 ? (
                  <span className="ov-kpi__spark">
                    <Sparkline
                      points={sparkPoints(kpi.spark)}
                      colour={colour}
                      ariaLabel={`${kpi.label} over the days leading to ${data.range.to}`}
                    />
                  </span>
                ) : null}
              </OvLink>
            );
          })}
        </div>

        {/* ── Row 2: Priority & SLA, and Jobs by status ──────────────────── */}
        <div className="ov-row2">
          <section className="ov-card ov-widget-a">
            <div className="ov-card__head">
              <h3 className="ov-card__title">Priority &amp; SLA</h3>
              <OvLink
                className="ov-card__link"
                href={jobsHref(OPEN_ONLY)}
                onActivate={() => goToJobs(OPEN_ONLY)}
                label="View every open job"
              >
                View jobs ›
              </OvLink>
            </div>
            <div className="ov-widget-a__gauge">
              <Speedometer
                percent={sla.percent}
                caption="Within SLA"
                colour={arcColour(sla.percent)}
                /* §6: "SLA speedometer → Jobs, overdue only". The gauge's
                   subject is the overdue side of the ratio, and that is now a
                   dimension the board reads, so this opens precisely the jobs
                   the missing quarter of the arc stands for. */
                onSelect={() => goToJobs(OVERDUE_ONLY)}
                ariaLabel={`${sla.percent}% of ${countText(sla.open)} open jobs are within SLA; ${countText(sla.overdue)} are overdue. Opens the overdue jobs.`}
              />
            </div>
            <div className="ov-widget-a__rings">
              {priority.map((slice) => (
                <RingMeter
                  key={slice.key}
                  value={slice.value}
                  total={openJobs}
                  label={slice.label}
                  colour={slice.colour}
                  onSelect={() => goToJobs({ ...OPEN_ONLY, priority: pipe(slice.labels) })}
                />
              ))}
            </div>
          </section>

          <section className="ov-card">
            <div className="ov-card__head">
              <h3 className="ov-card__title">Jobs by status</h3>
              <OvLink
                className="ov-card__link"
                href={jobsHref(OPEN_ONLY)}
                onActivate={() => goToJobs(OPEN_ONLY)}
                label="View every open job"
              >
                View jobs ›
              </OvLink>
            </div>
            <Donut
              slices={jobsByStatus}
              total={openJobs}
              caption="Open jobs"
              onSelect={(argument: unknown) => {
                const slice = sliceFrom(argument, jobsByStatus);
                if (slice) goToStatus(slice);
              }}
              ariaLabel={`${countText(openJobs)} open jobs by status. Each segment opens that status on the jobs board.`}
            />
            <div className="ov-legend">
              {jobsByStatus.map((slice) => (
                <OvLink
                  key={slice.key}
                  className="ov-legend__row"
                  href={jobsHref({ ...OPEN_ONLY, meter: slice.label, status: pipe(slice.labels) })}
                  onActivate={() => goToStatus(slice)}
                  label={`${slice.label}: ${countText(slice.value)} open jobs. Opens the jobs board filtered to this status.`}
                >
                  <span className="ov-legend__swatch" style={{ background: slice.colour }} aria-hidden="true" />
                  <span className="ov-legend__label">{slice.label}</span>
                  <span className="ov-legend__value">{countText(slice.value)}</span>
                </OvLink>
              ))}
            </div>
          </section>
        </div>

        {/* ── Row 3: spend, compliance, categories ───────────────────────── */}
        <div className="ov-row3">
          <section className="ov-card">
            <div className="ov-card__head">
              <h3 className="ov-card__title">Spend trend</h3>
              <label className="ov-card__link">
                <span className="visually-hidden">Spend window</span>
                <select
                  value={spendView}
                  onChange={(event) =>
                    setSpendView(event.target.value as "12m" | "year" | "quarter")
                  }
                >
                  <option value="year">This year</option>
                  <option value="12m">Last 12 months</option>
                  <option value="quarter">This quarter</option>
                </select>
              </label>
            </div>
            <AreaTrend
              points={trend}
              /*
                §6: a point opens Reports FOR THAT MONTH.
                `useStoredPeriod` now reads `reportPeriod` from the address bar
                and prefers it over the reader's stored range, so the Spend
                Overview opens on the month that was tapped rather than on
                whatever window they last used. `month:YYYY-MM` is the period
                model's own token — see `periodShape` — so this sends the
                vocabulary Reports already speaks rather than inventing one.
                The `#overview` hash is how that screen addresses its tabs.
              */
              onSelect={(argument: unknown) => {
                const point = pointFrom(argument, trend);
                if (!point) return;
                const month = String(point.month ?? "").slice(0, 7);
                goToShell(
                  month
                    ? `${ROUTE.reports}?reportPeriod=month:${month}#overview`
                    : ROUTE.reports,
                );
              }}
              ariaLabel="Spend by month. Selecting a month opens the spend report for it."
            />
          </section>

          <section className="ov-card">
            <div className="ov-card__head">
              <h3 className="ov-card__title">Compliance score</h3>
              <OvLink
                className="ov-card__link"
                href={ROUTE.compliance}
                onActivate={onNavigateToCompliance}
                label="View compliance"
              >
                View compliance ›
              </OvLink>
            </div>
            {/*
              THE PERCENTAGE IS THE PRODUCT'S OWN `complianceScore`, WHICH
              EXCLUDES "Not required" FROM THE DENOMINATOR — the same figure the
              Compliance page and the nightly digest print. It reads far lower
              than a naive share of the register and that is correct; the
              caption states the two counts it came from so nobody has to guess.
              When nothing is scored the gauge is not drawn at all, because a
              0% arc is a claim about a measurement that was never made.
            */}
            {compliance.scored ? (
              <Horseshoe
                percent={compliance.percent}
                caption="On track"
                sub={complianceCaption}
                colour={arcColour(compliance.percent)}
                onSelect={onNavigateToCompliance}
                ariaLabel={`Compliance score ${compliance.percent}%. ${complianceCaption}. Opens the compliance register.`}
              />
            ) : (
              <p>{complianceCaption}</p>
            )}
          </section>

          <section className="ov-card">
            <div className="ov-card__head">
              {/*
                "Jobs by category", not "Jobs by trade". There is no trade field
                on this schema; the ring counts `maintenance_requests.category`,
                and naming it after a column the product does not have would be
                a caption that cannot be verified.
              */}
              <h3 className="ov-card__title">Jobs by category</h3>
              <OvLink
                className="ov-card__link"
                href={jobsHref(OPEN_ONLY)}
                onActivate={() => goToJobs(OPEN_ONLY)}
                label="View every open job"
              >
                View jobs ›
              </OvLink>
            </div>
            <RadialRings
              slices={categories}
              total={openJobs}
              caption="Open jobs"
              onSelect={(argument: unknown) => {
                const slice = sliceFrom(argument, categories);
                if (slice) goToCategory(slice);
              }}
              ariaLabel={`${countText(openJobs)} open jobs by category. Each ring opens that category on the jobs board.`}
            />
            <div className="ov-legend">
              {categories.map((slice) => (
                <OvLink
                  key={slice.key}
                  className="ov-legend__row"
                  href={jobsHref({ ...OPEN_ONLY, label: pipe(slice.labels) })}
                  onActivate={() => goToCategory(slice)}
                  label={`${slice.label}: ${countText(slice.value)} open jobs. Opens the jobs board filtered to this category.`}
                >
                  <span className="ov-legend__swatch" style={{ background: slice.colour }} aria-hidden="true" />
                  <span className="ov-legend__label">{slice.label}</span>
                  <span className="ov-legend__value">{countText(slice.value)}</span>
                </OvLink>
              ))}
            </div>
          </section>
        </div>
      </section>
    </>
  );
}

/* ── Primitives ───────────────────────────────────────────────────────────── */

/**
 * A real anchor that navigates through the shell.
 *
 * An `<a href>` rather than a `<button>` so the address is visible on hover,
 * copyable, openable in a new tab, and reachable by Enter with no key handler
 * of our own. A plain left click is intercepted and handed to the shell's
 * client-side navigation; anything with a modifier, or a middle click, falls
 * through to the browser so "open in new tab" still works.
 */
function OvLink({
  href,
  className,
  label,
  onActivate,
  style,
  children,
}: {
  href: string;
  className: string;
  label: string;
  onActivate: () => void;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <a
      className={className}
      href={href}
      aria-label={label}
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

function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="16" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

/** One 24px glyph per figure. Decorative — every card states its figure in text. */
function KpiIcon({ name }: { name: OvKpiKey }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "activeUnits":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="10" height="16" rx="1.5" />
          <path d="M13 9h6a1.5 1.5 0 0 1 1.5 1.5V20" />
          <path d="M6.5 8h3M6.5 12h3M6.5 16h3M16 13h2" />
        </svg>
      );
    case "attention":
      return (
        <svg {...common}>
          <path d="M12 4 2.8 20h18.4L12 4Z" />
          <path d="M12 10v4.5M12 17.4v.2" />
        </svg>
      );
    case "openJobs":
      return (
        <svg {...common}>
          <rect x="5" y="5" width="14" height="16" rx="2" />
          <path d="M9 3.5h6V7H9zM8.5 12h7M8.5 16h4.5" />
        </svg>
      );
    case "overdue":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.2" />
          <path d="M12 7.2V12l3.4 2" />
        </svg>
      );
    case "completed":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.2" />
          <path d="m8.4 12.2 2.5 2.5 4.7-5.2" />
        </svg>
      );
    case "compliance":
    default:
      return (
        <svg {...common}>
          <path d="M12 3.2 5 6.1v5.7c0 4 2.9 7.3 7 9.1 4.1-1.8 7-5.1 7-9.1V6.1l-7-2.9Z" />
          <path d="m9.2 12.2 2 2 3.6-4" />
        </svg>
      );
  }
}
