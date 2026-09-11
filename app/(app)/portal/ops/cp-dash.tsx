"use client";

/**
 * COMPLIANCE OVERVIEW — the dashboard block at the top of the Compliance page.
 *
 * The companion to the Overview's block (`ov-dash.tsx`): same design system,
 * same data rules, same linking pattern. A score donut, a grid of segmented
 * rings by requirement type, and a renewals outlook — countdown rings, a
 * "Who's renewing" donut and a sites speedometer — all drawn from ONE call to
 * `/api/compliance/metrics`, which classifies the same register as the page
 * below from one instant and reconciles the brief's identities before it
 * answers. Everything that was already on this page follows the block
 * unchanged; the block only draws the picture, and the register is where the
 * detail lives.
 *
 * ── THIS FILE COMPOSES; IT DOES NOT COMPUTE ───────────────────────────────
 *
 * It is never given a register row, so it cannot recount one. Every number is
 * the payload's; what happens here is presentation — formatting a count,
 * choosing which colour a percentage is by the payload's own thresholds,
 * joining a sentence out of two figures already on screen.
 *
 * ── THE WIRE TYPES ARE IMPORTED — AS TYPES, FROM A MODULE WITH NO IMPORTS ─
 *
 * `ov-dash.tsx` restates its wire shape because `overview-metrics.ts` reaches
 * drizzle. `compliance-dash-contract.ts` was written the other way round: types
 * only, and no imports of any kind, so even a careless value import from it
 * could not drag the query builder into this bundle. It is still `import type`.
 *
 * ── EVERY DRILL LANDS ON THE REGISTER BELOW, NOT ON ANOTHER PAGE ──────────
 *
 * The register is on this page, so a segment, a ring or a legend row rewrites
 * the register's own URL filters in place and scrolls to it. The filter each
 * one applies is the PAYLOAD's (`score.filters`, `ring.filter`,
 * `slice.filter`, …) — the server built it from the same classification that
 * produced the figure, and `scored=1` rides on every one, so the register opens
 * on exactly the rows the figure counted rather than a wider list. Only the
 * sites speedometer leaves the page, for the Sites list narrowed to the sites
 * that are not fully compliant.
 *
 * ── WHAT IT REFUSES TO DO ─────────────────────────────────────────────────
 *
 * No table and no text list: the two crossed-out panels of the reference are
 * replaced by meters. Legend rows are links, as on the Overview.
 */

import { useCallback, useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import ovDashCss from "./ov-dash.css?url";
import cpDashCss from "./cp-dash.css?url";
import { DashHeader } from "./dash-header";
import { useOpsQuery, useQueryState } from "./ops-url-state";
import { Donut, RingMeter, Speedometer, ovPercent, type OvSlice } from "./ov-dash-charts";
import { CpTypeGrid, type CpTypeTile } from "./cp-dash-charts";
/* Imports nothing itself, so it cannot drag the query builder into this bundle. */
import { qualityTone, type ArcTone } from "../../../lib/dashboard-policy";
/* Pure `Intl`, no imports — the register below already uses it client-side. */
import { formatDayMonth, formatShortDate } from "../../../lib/format-date";
import type {
  CpMetrics,
  CpRegisterFilter,
  CpStateKey,
} from "../../../lib/compliance-dash-contract";

/* ── Configuration ────────────────────────────────────────────────────────── */

/** §5.4: poll while the tab is visible. Sixty seconds, as the brief asks. */
const REFRESH_INTERVAL_MS = 60_000;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The route the shell serves this page on — the drill links' address. */
const ROUTE_COMPLIANCE = "/dashboard/compliance";

/** `compliance-page.tsx` puts this id on the register's filter bar. */
const REGISTER_ANCHOR = "compliance-register";

/**
 * THE REGISTER'S KEYS — every one is dropped before a drill writes its own.
 *
 * A drill REPLACES the register's filters rather than adding to them: a reader
 * who had narrowed the register to one store and then taps "Expired 4" must see
 * the four, not the one of them at that store under a figure reading four.
 * `view` goes too, because "Set up" and "Confirm responsibilities" draw no
 * records at all. The block's own `portfolio` stays — it is the header's
 * state — and so does `sort`, which orders groups and counts nothing. The
 * header's `from`/`to` stay only on the plain "View register" link; a figure's
 * drill drops them (see `registerQuery`).
 */
const REGISTER_KEYS = ["site", "state", "kind", "who", "due", "q", "scored", "open", "view"] as const;

/** The four states inside the score, in the order every ring draws them. */
const STATUS_ORDER: readonly CpStateKey[] = ["compliant", "expiring", "expired", "missing"];

const STATUS_LABEL: Record<CpStateKey, string> = {
  compliant: "Compliant",
  expiring: "Expiring soon",
  expired: "Expired",
  missing: "Missing",
};

/** The brief's status tokens, declared in `cp-dash.css`. Fills only — never text. */
const STATUS_COLOUR: Record<CpStateKey, string> = {
  compliant: "var(--cp-compliant)",
  expiring: "var(--cp-expiring)",
  expired: "var(--cp-expired)",
  missing: "var(--cp-missing)",
};

/**
 * THE SITES GAUGE'S COLOUR, FROM THE PAYLOAD'S OWN THRESHOLDS.
 *
 * `qualityTone` decides good / warn / poor against `policy.thresholds` — the
 * server's echo of `QUALITY_ARC` in `dashboard-policy.ts` — and this maps the
 * tone to the brief's status colours. No threshold is typed in this file.
 */
const TONE_COLOUR: Record<ArcTone, string> = {
  good: "var(--cp-compliant)",
  warn: "var(--cp-expiring)",
  poor: "var(--cp-expired)",
};

/**
 * The score donut's geometry, measured off the reference rather than inherited
 * from the Overview's status donut (176px box, 160px ring): the reference's ring
 * is ~190px across with a ~24px stroke — about 19% larger. The centre stays at
 * the brief's 26px because the hole is wide enough for `ovCentreSize` to allow it.
 */
const SCORE_GEOMETRY = { box: 192, radius: 84, stroke: 24 } as const;

/** The Donut's geometry for "Who's renewing" — the brief's ~150px, 18px ring. */
const RENEWALS_GEOMETRY = { box: 150, radius: 66, stroke: 18 } as const;

/* ── Small helpers ────────────────────────────────────────────────────────── */

function countText(value: number): string {
  return (Number.isFinite(value) ? value : 0).toLocaleString("en-GB");
}

/** "1 requirement", "4 requirements" — for the accessible names. */
function countOf(value: number, one: string, many: string): string {
  return `${countText(value)} ${value === 1 ? one : many}`;
}

/**
 * THE RANGE PILL WHILE THE SERVER HAS NOT YET ANSWERED FOR THE NEW RANGE.
 *
 * The pill prints `range.label`, the server's words for the window it applied.
 * But the previous payload stays on screen during a refetch — deliberately — so
 * after a date change the pill went on naming the OLD range for the 0.7–2s the
 * endpoint takes (measured), and after "Any due date" it named a range that had
 * just been cleared. Until the payload's bounds match the address bar, the pill
 * prints the same sentence the server will, from the address bar's own days:
 * "From 12 May 2026", "Until 31 Dec 2026", "12 May – 31 Dec 2026", a year on
 * both sides across a new year, a reversed pair swapped as the server swaps
 * it. Formatting only — `format-date` reads a bare day in UTC, so no timezone
 * can move it — and never arithmetic on a date.
 */
function provisionalRangeLabel(from: string, to: string): string {
  const start = DAY_PATTERN.test(from) ? from : "";
  const end = DAY_PATTERN.test(to) ? to : "";
  if (start && end) {
    const [low, high] = start <= end ? [start, end] : [end, start];
    const sameYear = low.slice(0, 4) === high.slice(0, 4);
    return `${sameYear ? formatDayMonth(low) : formatShortDate(low)} – ${formatShortDate(high)}`;
  }
  if (start) return `From ${formatShortDate(start)}`;
  if (end) return `Until ${formatShortDate(end)}`;
  return "Any due date";
}

/** Whether the payload's range is the one in the address bar (either order). */
function sameRange(
  range: { from: string | null; to: string | null },
  from: string,
  to: string,
): boolean {
  const want = [DAY_PATTERN.test(from) ? from : null, DAY_PATTERN.test(to) ? to : null];
  return (
    (range.from === want[0] && range.to === want[1]) ||
    (range.from === want[1] && range.to === want[0])
  );
}

/**
 * THE REGISTER'S ADDRESS AFTER A DRILL — one function for the link's `href`
 * and for the click, so what a reader copies is what a click applies.
 *
 * The portfolio travels as the SITES it is made of: the register filters on
 * `site=` and has never read a portfolio id, so sending the id would narrow
 * nothing. The list is empty for "All portfolios", where there is nothing to
 * narrow.
 */
function registerQuery(
  current: string | URLSearchParams,
  filter: CpRegisterFilter,
  siteIds: readonly string[],
  extra: Readonly<Record<string, string>> = {},
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of REGISTER_KEYS) next.delete(key);
  /*
   * A FIGURE'S DRILL DROPS THE HEADER'S DUE-DATE RANGE; "View register" keeps it.
   *
   * The figures are today's snapshot and ignore the range (the header's
   * caption says so), but the register applies it — so a range left in place
   * under a figure's filter listed fewer rows than the figure counted, and the
   * "No due date" ring opened EMPTY under any range at all, a row with no due
   * date being outside every one. The plain register link counts nothing, so
   * the reader's range stays with it.
   */
  if (Object.keys(filter).length > 0) {
    next.delete("from");
    next.delete("to");
  }
  for (const key of Object.keys(filter)) next.delete(key);
  for (const [key, values] of Object.entries(filter)) {
    for (const value of values) if (value) next.append(key, value);
  }
  for (const [key, value] of Object.entries(extra)) next.set(key, value);
  for (const id of siteIds) if (id) next.append("site", id);
  return next;
}

/** How long a drill keeps the register aligned while it redraws under the new filter. */
const SETTLE_MS = 3000;

/** The previous drill's alignment, released when the next drill starts. */
let releaseSettle: (() => void) | null = null;

/**
 * Scroll the register into view — smoothly, or instantly for a reader who has
 * asked for less movement. `scroll-margin-top` on the anchor keeps the sticky
 * topbar from covering it.
 *
 * ── AND KEEP IT THERE WHILE THE PAGE ABOVE IT REDRAWS ─────────────────────
 *
 * The register's Portfolio band sits ABOVE the anchor and its notes depend on
 * the filter — "960 are outside the percentage…" vanishes under `scored=1` —
 * so the band changes height when the new summary lands, which is usually in
 * the middle of the scroll. Measured before this: the register landed anywhere
 * from 22px to 223px from the top instead of 84, sometimes with its chips under
 * the topbar. So for a few seconds a resize of the page around the anchor
 * re-aims the scroll, and the first wheel, touch or key press from the reader
 * hands the page back to them — this must never fight somebody scrolling.
 */
function scrollToRegister() {
  if (typeof document === "undefined") return;
  const target = document.getElementById(REGISTER_ANCHOR);
  if (!target) return;
  const reduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const align = () =>
    target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  releaseSettle?.();
  align();

  const page = target.parentElement;
  if (!page || typeof ResizeObserver === "undefined") return;
  let done = false;
  let timer = 0;
  const observer = new ResizeObserver(() => {
    if (!done) align();
  });
  const release = () => {
    if (done) return;
    done = true;
    if (releaseSettle === release) releaseSettle = null;
    observer.disconnect();
    window.clearTimeout(timer);
    window.removeEventListener("wheel", release);
    window.removeEventListener("touchstart", release);
    window.removeEventListener("keydown", release);
  };
  releaseSettle = release;
  timer = window.setTimeout(release, SETTLE_MS);
  observer.observe(page);
  window.addEventListener("wheel", release, { passive: true });
  window.addEventListener("touchstart", release, { passive: true });
  window.addEventListener("keydown", release);
}

/* ── The block ────────────────────────────────────────────────────────────── */

export function CpDash({
  onNavigateToSites,
}: {
  /** Open the Sites list with a query — `sites=a|b` for the sites-gauge drill. */
  onNavigateToSites: (query: string) => void;
}) {
  const { params, setParams } = useQueryState();

  /*
   * THE THREE PARAMETERS THIS BLOCK OWNS, AND NOTHING ELSE.
   *
   * The fetch key is rebuilt from `portfolio`, `from` and `to` alone. The
   * register below owns a dozen more keys in the same query string, and this
   * endpoint reads none of them — including them would refetch the whole block
   * every time somebody touched a chip that cannot change a figure in it.
   *
   * `from`/`to` are shared with the register on purpose: the header's range
   * filters the REGISTER and the EXPORT by due date, per the brief, while the
   * block's own figures stay a snapshot as of today.
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
   * payload on screen while the next is in flight, and `keepOnError` keeps it
   * through a failed poll — the "no flicker to zero" half of §5.4. The skeleton
   * is reserved for the one render where there is genuinely nothing yet.
   */
  const { data, loading, error, reload } = useOpsQuery<CpMetrics>(
    "/api/compliance/metrics",
    search,
    { keepOnError: true },
  );

  /*
   * §5.4 — REFETCH ON FOCUS, AND POLL WHILE VISIBLE.
   *
   * The same effect as `ov-dash.tsx`, for the same reason: this application
   * has no realtime transport, so freshness is polling, and every listener
   * checks `document.visibilityState` first so a tab left open overnight
   * issues no requests at all. `reload` is the stable callback `useOpsQuery`
   * returns, called from a listener and a timer, never during the effect.
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
   * The sites of the portfolio the figures on screen were counted over — the
   * payload's own list, so a drill taken from a stale payload during a refetch
   * still opens the rows that payload counted.
   */
  const portfolioSiteIds = useMemo(() => data?.portfolio.siteIds ?? [], [data]);

  /**
   * APPLY A FIGURE'S FILTER TO THE REGISTER BELOW, AND GO THERE.
   *
   * Read from `window.location.search` at the moment of the click rather than
   * from the render's `params`, so a filter the register wrote a moment ago is
   * replaced rather than resurrected.
   */
  const applyRegisterFilter = useCallback(
    (filter: CpRegisterFilter, extra?: Readonly<Record<string, string>>) => {
      setParams(registerQuery(window.location.search, filter, portfolioSiteIds, extra));
      scrollToRegister();
    },
    [portfolioSiteIds, setParams],
  );

  /** The same address as a real link, so it can be copied or opened in a tab. */
  const registerHref = useCallback(
    (filter: CpRegisterFilter, extra?: Readonly<Record<string, string>>) => {
      const query = registerQuery(params, filter, portfolioSiteIds, extra).toString();
      return query ? `${ROUTE_COMPLIANCE}?${query}` : ROUTE_COMPLIANCE;
    },
    [params, portfolioSiteIds],
  );

  /* ── The header, which is usable before the first payload lands ─────────── */

  const exportHref = search
    ? `/api/compliance/metrics?format=csv&${search}`
    : "/api/compliance/metrics?format=csv";

  const header = (
    <DashHeader
      title="Compliance overview"
      portfolio={portfolio}
      portfolios={data?.portfolios ?? []}
      onPortfolio={(next) =>
        setFilter((query) => {
          if (next) query.set("portfolio", next);
          else query.delete("portfolio");
          /*
           * THE OLD PORTFOLIO'S SITES GO WITH IT.
           *
           * A drill writes the portfolio onto the register as its `site=`
           * list, because the register has never read a portfolio id. Changing
           * the portfolio here left that list behind — measured: back on "All
           * portfolios", the register still showed ten Site chips from the
           * portfolio that had been left. So when the register's sites are
           * EXACTLY the old portfolio's, they are the block's own narrowing and
           * are taken off with it; a site selection the reader made in the
           * register is anything else, and is left alone.
           */
          const applied = new Set(query.getAll("site"));
          const previous = data?.portfolio.siteIds ?? [];
          if (
            previous.length > 0 &&
            applied.size === previous.length &&
            previous.every((id) => applied.has(id))
          ) {
            query.delete("site");
          }
        })
      }
      /* Empty bounds mean any due date; the label is the server's once the
         payload answers for the range in the address bar — see
         `provisionalRangeLabel` for the moment before it does. */
      range={{
        from: fromParam,
        to: toParam,
        label:
          data && sameRange(data.range, fromParam, toParam)
            ? data.range.label
            : provisionalRangeLabel(fromParam, toParam),
      }}
      onRange={(nextFrom, nextTo) =>
        setFilter((query) => {
          if (nextFrom) query.set("from", nextFrom);
          else query.delete("from");
          if (nextTo) query.set("to", nextTo);
          else query.delete("to");
        })
      }
      resetLabel="Any due date"
      rangeCaption="Filters the register below and the export by due date. The figures above are today's snapshot."
      /* Built by the server from the same snapshot — every requirement under
         the current filters plus every metric on the block — so a real link
         and the browser's own download handle it. */
      exportHref={exportHref}
      /* A refetch that failed while a payload is still on screen: the figures
         stay, and the reason is one press away. */
      error={data ? error : null}
      onRetry={reload}
    />
  );

  if (!data) {
    return (
      <>
        <link rel="stylesheet" href={ovDashCss} precedence="default" />
        <link rel="stylesheet" href={cpDashCss} precedence="default" />
        <section className="ov-dash cp-dash" aria-busy={loading} aria-label="Compliance overview">
          {header}
          {error ? (
            <p className="ov-card cp-dash__error">
              {error}{" "}
              <button type="button" className="ov-card__link" onClick={reload}>
                Try again
              </button>
            </p>
          ) : (
            <>
              <div className="cp-row1">
                <div className="ov-card ov-skeleton cp-skeleton cp-skeleton--score" />
                <div className="ov-card ov-skeleton cp-skeleton cp-skeleton--types" />
              </div>
              <div className="ov-card ov-skeleton cp-skeleton cp-skeleton--renewals" />
            </>
          )}
        </section>
      </>
    );
  }

  const { score, types, countdown, renewals, sites, policy } = data;

  /* ── Compliance score ──────────────────────────────────────────────────── */

  const scoreSlices: OvSlice[] = STATUS_ORDER.map((key) => ({
    key,
    label: STATUS_LABEL[key],
    value: score.counts[key],
    colour: STATUS_COLOUR[key],
    labels: [],
  }));
  const scoreCaption = score.scored
    ? `${countText(score.satisfied)} of ${countText(score.applicable)} requirements on track`
    : "No requirement on this portfolio is scored yet";
  /*
   * WHAT IS OUTSIDE THE SCORE, SAID ONCE AND SHORTLY.
   *
   * The percentage divides by the requirements that are the client's and are
   * required. On this estate that is a fifth of the register, and a reader who
   * does not know it reads "357" against a register of 1,858 and suspects a
   * bug. Both counts are the payload's; a zero is left out rather than printed.
   */
  const outside = [
    score.notRequired > 0 ? `${countText(score.notRequired)} not required` : null,
    /* "Unconfirmed or not the client's", not only "unconfirmed": `excluded`
       also counts requirements confirmed as a landlord's or a centre's. */
    score.excluded > 0
      ? `${countText(score.excluded)} unconfirmed or not the client's`
      : null,
  ].filter(Boolean);
  const goToStatus = (key: string) => {
    if (key in score.filters) applyRegisterFilter(score.filters[key as CpStateKey]);
  };

  /* ── Compliance by type ────────────────────────────────────────────────── */

  const typeTiles: CpTypeTile[] = types.map((ring) => {
    const { compliant, expiring, expired, missing } = ring.counts;
    /* A share printed beside a count in a tooltip — presentation of two
       figures already on screen, through the block's one zero-safe division. */
    const share = (value: number) => ovPercent(value, ring.total);
    return {
      key: ring.key,
      label: ring.label,
      centre: `${ring.percent}%`,
      count: `${countText(compliant)}/${countText(ring.total)}`,
      segments: STATUS_ORDER.map((key) => ({
        key,
        value: ring.counts[key],
        colour: STATUS_COLOUR[key],
      })),
      flagged: expired > 0,
      ringName:
        `${ring.label}: ${ring.percent}% compliant, ${countText(compliant)} of ${countText(ring.total)}; ` +
        `${countText(expiring)} expiring soon, ${countText(expired)} expired, ${countText(missing)} missing. ` +
        "Opens the register filtered to this requirement.",
      flagName: `${ring.label}: ${countText(expired)} expired. Opens the register filtered to this requirement's expired records.`,
      tipLines: [
        /* The compliant share is the payload's own percent, so the tooltip
           and the centre of the ring cannot round differently. */
        `Compliant ${countText(compliant)} · ${ring.percent}%`,
        `Expiring soon ${countText(expiring)} · ${share(expiring)}%`,
        `Expired ${countText(expired)} · ${share(expired)}%`,
        `Missing ${countText(missing)} · ${share(missing)}%`,
      ],
    };
  });
  const typesLabel = `Compliance by type: ${
    types
      .map(
        (ring) =>
          `${ring.label} ${ring.percent}%, ${countText(ring.counts.expiring)} expiring, ${countText(ring.counts.expired)} expired, ${countText(ring.counts.missing)} missing`,
      )
      .join("; ") || "no requirement type is in the score"
  }`;
  const typeByKey = new Map(types.map((ring) => [ring.key, ring]));

  /* ── Renewals outlook ──────────────────────────────────────────────────── */

  const countdownLabel = `Renewals countdown, ${countText(countdown.total)} in all: ${countdown.rings
    .map((ring) => `${ring.label} ${countText(ring.value)}`)
    .join(", ")}`;
  const renewalByKey = new Map(renewals.slices.map((slice) => [slice.key, slice]));
  const unlinkedNote =
    renewals.unlinked > 0
      ? `${countText(renewals.unlinked)} of ${countText(renewals.total)} name a responsibility, not a contractor record`
      : null;
  /*
   * NO SITE IN THE SCORE IS NOT A FAILING 0%. With no active site holding a
   * scored requirement the ratio has no denominator, and a red "0%" read as
   * every store failing — the score donut prints "—" for exactly this. And
   * with every considered site compliant there is nothing to open, so the
   * gauge is not a control: a drill with no sites opened the whole list.
   */
  const sitesScored = sites.considered > 0;
  const sitesTone = sitesScored ? TONE_COLOUR[qualityTone(sites.percent, policy.thresholds)] : "var(--ov-text-muted)";
  const sitesSub = sitesScored
    ? `${countText(sites.fullyCompliant)} of ${countText(sites.considered)} sites fully compliant`
    : "No site has a requirement in the score yet";
  const sitesFailing = sites.notFullyCompliantIds.length > 0;
  const goToSites = () =>
    onNavigateToSites(new URLSearchParams({ sites: sites.notFullyCompliantIds.join("|") }).toString());

  return (
    <>
      <link rel="stylesheet" href={ovDashCss} precedence="default" />
      <link rel="stylesheet" href={cpDashCss} precedence="default" />
      <section className="ov-dash cp-dash" aria-busy={loading} aria-label="Compliance overview">
        {header}

        {/* ── Row 1: the score, and the rings by type ─────────────────────── */}
        <div className="cp-row1">
          <section className="ov-card cp-score">
            <div className="ov-card__head">
              <h3 className="ov-card__title">Compliance score</h3>
              {/* "View register", not "View compliance": the register is on
                  this page. It clears the register's filters — no filter —
                  and scrolls to it. */}
              <OvLink
                className="ov-card__link"
                href={registerHref({})}
                onActivate={() => applyRegisterFilter({})}
                label="View the whole register below"
              >
                View register ›
              </OvLink>
            </div>
            <div className="cp-score__body">
              <Donut
                slices={scoreSlices}
                total={score.applicable}
                /* "On track" labels a percentage; over a dash it would claim one. */
                caption={score.scored ? "On track" : "Not scored"}
                centreValue={score.scored ? `${score.percent}%` : "—"}
                geometry={SCORE_GEOMETRY}
                formatValue={countText}
                onSelect={(slice) => goToStatus(slice.key)}
                ariaLabel="Compliance score"
              />
              <div className="ov-legend cp-score__legend">
                {scoreSlices.map((slice) => (
                  <OvLink
                    key={slice.key}
                    className="ov-legend__row"
                    href={registerHref(score.filters[slice.key as CpStateKey])}
                    onActivate={() => goToStatus(slice.key)}
                    label={`${slice.label}: ${countOf(slice.value, "requirement", "requirements")}. Opens the register filtered to this status.`}
                  >
                    <span className="ov-legend__swatch" style={{ background: slice.colour }} aria-hidden="true" />
                    <span className="ov-legend__label">{slice.label}</span>
                    <span className="ov-legend__value">{countText(slice.value)}</span>
                  </OvLink>
                ))}
              </div>
            </div>
            <p className="cp-score__caption">{scoreCaption}</p>
            {outside.length > 0 ? (
              <p className="cp-note">{`${outside.join(" · ")} — outside the score`}</p>
            ) : null}
          </section>

          <section className="ov-card cp-bytype">
            <div className="ov-card__head">
              <h3 className="ov-card__title">Compliance by type</h3>
              <OvLink
                className="ov-card__link"
                href={registerHref({})}
                onActivate={() => applyRegisterFilter({})}
                label="View the whole register below"
              >
                View register ›
              </OvLink>
            </div>
            {typeTiles.length > 0 ? (
              <CpTypeGrid
                tiles={typeTiles}
                ariaLabel={typesLabel}
                onSelect={(key) => {
                  const ring = typeByKey.get(key);
                  if (ring) applyRegisterFilter(ring.filter);
                }}
                onSelectFlag={(key) => {
                  const ring = typeByKey.get(key);
                  if (ring) applyRegisterFilter(ring.expiredFilter);
                }}
              />
            ) : (
              <p className="cp-note cp-empty">No requirement type is in the score yet.</p>
            )}
          </section>
        </div>

        {/* ── Row 2: renewals outlook ─────────────────────────────────────── */}
        <section className="ov-card cp-renewals">
          <div className="ov-card__head cp-renewals__head">
            <div className="cp-renewals__heading">
              <h3 className="ov-card__title">Renewals outlook</h3>
              <p className="cp-card__caption">
                Expired now and due in the next {policy.warningWindowDays} days
              </p>
            </div>
            <OvLink
              className="ov-card__link"
              href={registerHref(renewals.allFilter, { sort: "soonest" })}
              onActivate={() => applyRegisterFilter(renewals.allFilter, { sort: "soonest" })}
              label="View every renewal in the register, soonest due first"
            >
              View all renewals ›
            </OvLink>
          </div>

          <div className="cp-zones">
            {/* Zone 1 — where the renewal pressure sits. Each ring fills against
                the payload's own denominator, Expired plus every Expiring soon
                record, so the rings together read as one whole. */}
            <div className="cp-zone cp-zone--countdown">
              <h4 className="cp-zone__title">Countdown</h4>
              <div className="cp-countdown" role="group" aria-label={countdownLabel}>
                {countdown.rings.map((ring) => (
                  <RingMeter
                    key={ring.key}
                    value={ring.value}
                    total={countdown.total}
                    label={ring.label}
                    colour={ring.colour}
                    size={88}
                    stroke={9}
                    onSelect={() => applyRegisterFilter(ring.filter)}
                    describe="Opens the register filtered to this window."
                  />
                ))}
              </div>
            </div>

            {/* Zone 2 — who the renewals fall to. */}
            <div className="cp-zone cp-zone--who">
              <h4 className="cp-zone__title">Who&apos;s renewing</h4>
              <div className="cp-who">
                <Donut
                  slices={renewals.slices}
                  total={renewals.total}
                  caption="Renewals"
                  centreValue={countText(renewals.total)}
                  geometry={RENEWALS_GEOMETRY}
                  gapPx={2}
                  formatValue={countText}
                  onSelect={(slice) => {
                    const found = renewalByKey.get(slice.key);
                    if (found) applyRegisterFilter(found.filter);
                  }}
                  ariaLabel="Who's renewing"
                />
                {renewals.slices.length > 0 ? (
                  <div className="ov-legend cp-who__legend">
                    {renewals.slices.map((slice) => (
                      <OvLink
                        key={slice.key}
                        className="ov-legend__row"
                        href={registerHref(slice.filter)}
                        onActivate={() => applyRegisterFilter(slice.filter)}
                        label={`${slice.label}: ${countOf(slice.value, "renewal", "renewals")}. Opens the register filtered to them.`}
                      >
                        <span className="ov-legend__swatch" style={{ background: slice.colour }} aria-hidden="true" />
                        <span className="ov-legend__label">{slice.label}</span>
                        <span className="ov-legend__value">{countText(slice.value)}</span>
                      </OvLink>
                    ))}
                  </div>
                ) : (
                  <p className="cp-note">
                    Nothing expired or due in the next {policy.warningWindowDays} days.
                  </p>
                )}
              </div>
              {/* The brief's instruction was "do not silently drop them". A
                  responsibility held as free text is still a renewal somebody
                  owns — it is counted above under its name, and said here. */}
              {unlinkedNote ? <p className="cp-note">{unlinkedNote}</p> : null}
            </div>

            {/* Zone 3 — sites with nothing Expired or Missing. */}
            <div className="cp-zone cp-zone--sites">
              <h4 className="cp-zone__title">Sites fully compliant</h4>
              <Speedometer
                percent={sites.percent}
                readout={sitesScored ? undefined : "—"}
                caption="Fully compliant"
                colour={sitesTone}
                sub={sitesSub}
                onSelect={sitesFailing ? goToSites : undefined}
                ariaLabel={sitesFailing ? "Sites fully compliant (opens the sites that are not)" : "Sites fully compliant"}
              />
            </div>
          </div>
        </section>
      </section>
    </>
  );
}

/* ── Primitives ───────────────────────────────────────────────────────────── */

/**
 * A real anchor that navigates in place — copied from `ov-dash.tsx`.
 *
 * An `<a href>` rather than a `<button>` so the address is visible on hover,
 * copyable, openable in a new tab, and reachable by Enter with no key handler
 * of our own. A plain left click is intercepted and handed to the block's own
 * drill; anything with a modifier, or a middle click, falls through to the
 * browser so "open in new tab" still works.
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
