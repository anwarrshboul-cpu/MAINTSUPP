"use client";

/**
 * OPERATIONS CENTRE → OVERVIEW.
 *
 * The page is a shell: one filter state, one cohort, and six bands that each
 * read one endpoint. Every figure is counted in Postgres — `/api/dashboard/*`
 * issues one aggregate per card — and the browser receives bucket rows, never
 * job rows. `requests.filter(...)` appears nowhere on this page and cannot: the
 * component is not given a job list.
 *
 * ── THE ORDER, AND WHY IT CHANGED ─────────────────────────────────────────
 *
 * Pulse → At a glance → Financial status → Performance over time → Job
 * breakdown → Sites needing attention.
 *
 * Two moves from the old layout, both from §0 of the brief: Sites needing
 * attention drops BELOW Job breakdown, and Cost and Performance rise ABOVE
 * both. The page now reads as a question sequence — how much work is there,
 * what is it costing, is it getting faster, what kind of work is it, and only
 * then which places need attention.
 *
 * ── ONE STATE, IN THE URL ─────────────────────────────────────────────────
 *
 * Filters, the date range and the cohort axis are one object, parsed by the
 * same `parseFilters` the route handlers use, and encoded in the address bar.
 * A filtered Overview is therefore a link, and the link means the same thing to
 * the person who receives it. Nothing here touches `localStorage`: a preference
 * kept in one browser makes the same operator read two differently-configured
 * pages on a phone and a laptop, and neither is wrong. The two genuine
 * PREFERENCES — the cohort axis and the split-by-priority toggle — are stored
 * per user on the server, and the URL still overrides them.
 */

import { useCallback, useMemo, useState } from "react";
import opsTokensCss from "./ops-tokens.css?url";
import opsCss from "./ops.css?url";
import overviewCss from "./overview.css?url";
import glanceCss from "./overview-glance.css?url";
import analysisCss from "./overview-analysis.css?url";
import portfolioCss from "./overview-portfolio.css?url";
import toolsCss from "./overview-tools.css?url";
import { OpsFilterBar, PeriodControl, type FilterGroup } from "./ops-filter-bar";
import { useOpsQuery, useQueryState } from "./ops-url-state";
import { AtAGlanceCard, PulseRow } from "./overview-glance";
import { FinancialStatusCard } from "./overview-financial";
import { PerformanceCard } from "./overview-performance";
import { JobBreakdownCard } from "./overview-breakdown";
import { SitesAttentionCard } from "./overview-sites";
import { OverviewRecordsPanel } from "./overview-records";
/* The visual dashboard block. It reads `/api/overview/metrics` and owns its own
   three URL parameters; nothing below it moves or changes because of it. */
import { OvDash } from "./ov-dash";
import { MeterSettings } from "./meter-settings";
import { ResolveNames } from "./resolve-names";
import { BulkSiteAssign } from "./bulk-site-assign";
/*
 * FROM `overview-meters.ts`, NEVER FROM `dashboard-filters.ts`.
 *
 * This is a client component. `dashboard-filters.ts` imports drizzle and
 * `db/schema`, so two words taken from it would drag the entire query builder
 * into the browser bundle to render the string "Date completed" —
 * `tests/ops-rebuild-foundations.test.mjs` pins the absence of that import for
 * exactly this reason, and it caught it here.
 *
 * The full period preset list comes off the wire from `/api/dashboard/filters`
 * for the same reason; `FALLBACK_PERIODS` below is what the control shows in
 * the moment before that answers.
 */
import {
  DEFAULT_MEASURE,
  DEFAULT_PERIOD_KEY,
  type CohortMeasure,
} from "../../../lib/overview-meters";
import {
  NATURE_KEYS,
  NATURE_LABEL,
  NATURE_COLOUR,
  type NatureKey,
} from "../../../lib/job-metrics";

/* Kept in the import for the pinned shape below; the nature chips take their
   colour from the severity ramp on this page rather than from this constant. */
void NATURE_COLOUR;
import type {
  BreakdownPayload,
  CostPayload,
  MetersPayload,
  PerformancePayload,
  RecordsQuery,
  SitesAttentionPayload,
  StuckPayload,
} from "./overview-contract";

/**
 * The parameters this page owns. `clearAll` deletes exactly these and nothing
 * else, so a deep-link parameter another screen put in the URL survives a
 * "Clear all" it was never part of.
 *
 * `measure` is here so that clearing filters also returns the axis to its
 * default — a reader who has cleared everything expects to be looking at the
 * page as it opens.
 */
const FILTER_KEYS = [
  "period",
  "from",
  "to",
  "measure",
  "site",
  "priority",
  "family",
  "status",
  "engineer",
  "label",
  "tier",
  "nature",
  "contractor",
] as const;

/**
 * The three the control shows before `/api/dashboard/filters` answers.
 *
 * Deliberately the short list rather than a copy of all eight: a fallback that
 * looks complete is one nobody notices has gone stale, and these three cover
 * every default the page can open with.
 */
const FALLBACK_PERIODS = [
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
] as const;

type FiltersPayload = {
  periods?: ReadonlyArray<{ key: string; label: string }>;
  sites: Array<{ value: string; label: string; count: number }>;
  contractors: Array<{ value: string; label: string; count: number }>;
  statuses: Array<{ value: string; label: string; count: number }>;
  engineers: Array<{ value: string; label: string; count: number }>;
  labels: Array<{ value: string; label: string; count: number }>;
  tiers: Array<{ value: string; label: string; count: number }>;
  families: Array<{ value: string; label: string; count: number }>;
  priorities: Array<{ value: string; label: string; count: number }>;
};

type PreferencesPayload = { measure: string; split: string };

/** The five destinations of the sticky jump bar — §1.8. */
const SECTIONS = [
  { id: "ovw-glance-title", label: "At a glance" },
  { id: "ovw-money-title", label: "Cost" },
  { id: "ovw-performance-title", label: "Performance" },
  { id: "ovw-breakdown-title", label: "Jobs" },
  { id: "ovw-sites-title", label: "Sites" },
] as const;

export function OverviewPage({
  onNavigateToJobs,
  onOpenJob,
  onNavigateToCompliance,
  onNavigateToSites,
}: {
  onNavigateToJobs: (query: string) => void;
  onOpenJob: (id: string) => void;
  onNavigateToCompliance: () => void;
  onNavigateToSites: (query: string) => void;
}) {
  const { params, setParams, search: urlSearch } = useQueryState();
  const preferences = useOpsQuery<PreferencesPayload>("/api/dashboard/preferences", "");

  /*
   * THE SEARCH THE AGGREGATES ACTUALLY GET — the URL, plus the stored axis
   * when the URL is silent about it.
   *
   * Every `/api/dashboard/*` route resolves the axis through `parseFilters`,
   * which reads the QUERY STRING and has no route to a per-user preference. So
   * a saved axis of `completed` reached the CONTROL and never reached a single
   * aggregate: the select read "Date completed" while all six cards counted on
   * `requested_at`. Making each card state what its own payload measured
   * stopped them asserting something false — but it left the control
   * contradicting the page it controls, which is a smaller lie rather than
   * none.
   *
   * Merging it into the search the FETCHES use is what makes a stored
   * preference behave the way `app/api/dashboard/preferences/route.ts`
   * documents it: "a stored preference SEEDS the page". The URL still wins
   * whenever it says anything, so a shared link means the same thing to
   * everyone who opens it — which is the property the note that used to stand
   * here was protecting when it refused to write the preference INTO the
   * address bar. Nothing is written to the address bar now either.
   *
   * The cost is one refetch for a reader whose saved axis is not the default:
   * the preference arrives from its own request, so the first render fetches
   * on the URL alone. Nobody who has never changed the setting pays it.
   */
  const search = useMemo(() => {
    const stored = preferences.data;
    if (!stored) return urlSearch;
    const next = new URLSearchParams(urlSearch);
    if (!next.has("measure") && stored.measure) next.set("measure", stored.measure);
    if (!next.has("split") && stored.split) next.set("split", stored.split);
    const merged = next.toString();
    /* Returned unchanged when nothing was added, so the six queries below keep
       the same key and do not refetch for a reader on the defaults. */
    return merged === urlSearch ? urlSearch : merged;
  }, [urlSearch, preferences.data]);

  /*
   * ONE ROUND TRIP PER CARD — §1.6. Seven cards, seven aggregates, and the
   * options list, which is deliberately unfiltered so a reader can WIDEN a
   * filter rather than only narrow one.
   */
  const meters = useOpsQuery<MetersPayload>("/api/dashboard/meters", search);
  const stuck = useOpsQuery<StuckPayload>("/api/dashboard/stuck", search);
  const cost = useOpsQuery<CostPayload>("/api/dashboard/cost", search);
  const performance = useOpsQuery<PerformancePayload>("/api/dashboard/performance", search);
  const breakdown = useOpsQuery<BreakdownPayload>("/api/dashboard/job-breakdown", search);
  const attention = useOpsQuery<SitesAttentionPayload>("/api/dashboard/sites-attention", search);
  const options = useOpsQuery<FiltersPayload>("/api/dashboard/filters", "");

  /*
   * THE AXIS: the URL first, the stored preference second, the default last.
   *
   * Derived rather than written back into the address bar. Seeding the URL from
   * a fetch would mean a link copied a second after the page opened carried a
   * parameter the sender never chose, and it would need a setState in an effect
   * to do it — which the React Compiler rejects and which costs a render pass.
   *
   * ── THIS IS AN INTENT. IT IS NOT A MEASUREMENT. ───────────────────────────
   *
   * Every `/api/dashboard/*` route resolves the axis through `parseFilters`,
   * which reads the QUERY STRING and has no route to a stored per-user
   * preference. So the middle arm of this expression — the preference — reaches
   * the CONTROL below and never reaches the aggregate: a reader whose saved
   * axis is `completed`, arriving at a bare `/dashboard`, gets a cohort the
   * server cut on `requested_at`.
   *
   * Printing `cohortWording(measure, total)` over that was a wrong statement of
   * fact about the data, in the largest sentence on every card. Each card now
   * takes its wording from the `measure` field ITS OWN payload returned, and
   * none of them draws a cohort sentence before that payload exists. This value
   * is what the reader has asked for and what the next fetch will carry once it
   * reaches the URL; it no longer describes a figure anywhere.
   *
   * The remaining seam is visible rather than hidden: with a saved preference
   * and a bare URL the control below reads "Date completed" while the cards
   * read "requested". Closing it means making the preference reach the server —
   * either by sending it with the fetch or by seeding the URL from it — and
   * both are written up in the report rather than decided here.
   */
  const measure: CohortMeasure =
    params.get("measure") === "completed"
      ? "completed"
      : params.get("measure") === "requested"
        ? "requested"
        : preferences.data?.measure === "completed"
          ? "completed"
          : DEFAULT_MEASURE;

  const splitByPriority =
    params.get("split") === "priority"
      ? true
      : params.get("split") === "off"
        ? false
        : preferences.data?.split === "on";

  const [records, setRecords] = useState<RecordsQuery | null>(null);
  const [tool, setTool] = useState<"meters" | "contractors" | "sites" | null>(null);

  const setFilterParams = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(window.location.search);
      mutate(next);
      setParams(next);
    },
    [setParams],
  );

  const clearAll = useCallback(() => {
    setFilterParams((next) => {
      for (const key of FILTER_KEYS) next.delete(key);
      next.delete("split");
    });
  }, [setFilterParams]);

  /**
   * Cross-filter: tapping a segment adds a chip, tapping it again removes one.
   * Values are sorted on the way in so two identical filter states serialise
   * identically and cannot put duplicate entries in the back stack.
   */
  const toggleFilter = useCallback(
    (key: string, value: string) => {
      setFilterParams((next) => {
        const existing = next.getAll(key);
        next.delete(key);
        const updated = existing.includes(value)
          ? existing.filter((entry) => entry !== value)
          : [...existing, value];
        for (const entry of updated.sort()) next.append(key, entry);
      });
    },
    [setFilterParams],
  );

  /**
   * Through to the Jobs list, carrying this page's whole state plus whatever
   * the caller adds.
   *
   * "What the board does not read is inert rather than misleading" used to
   * stand here as the licence for sending anything. It was wrong twice over.
   * `readDrillFilter` draws its CHIPS from the same parameters it filters on,
   * so an unread parameter that happens to be `meter` names a chip over an
   * unfiltered board — the reader is shown evidence that a narrowing happened
   * when none did. And a parameter outside `DRILL_KEYS` — `group`, `sort` —
   * survives the board's own Clear, so it is not even inert in the address bar.
   *
   * Every caller on this page now sends parameters the filter actually reads,
   * or sends none and means the whole cohort. An empty value is still deleted
   * rather than set, which is why `status: ""` silently produced an unfiltered
   * board from the Pulse row until it was corrected.
   */
  const drill = useCallback(
    (extra: Record<string, string>) => {
      /* The EFFECTIVE search, not `window.location.search`: a drill has to
         carry the axis the figures were counted on, and that is not always in
         the address bar — see the `search` memo above. */
      const next = new URLSearchParams(search);
      for (const [key, value] of Object.entries(extra)) {
        if (!value) next.delete(key);
        else next.set(key, value);
      }
      /*
       * THE DEFAULT PERIOD HAS TO BE MADE EXPLICIT ON THE WAY OUT.
       *
       * `PeriodControl` reads `params.get("period") ?? DEFAULT_PERIOD_KEY`, and
       * the default is deliberately never written into this page's address bar
       * because a URL full of parameters nobody chose teaches people to stop
       * copying it. A drill-through is not this page's URL though — it is a
       * FILTER — and `resolveDays("")` in `board-drill-filter.ts` produces no
       * window at all from an absent period, so a drill from an untouched
       * Overview handed the board the whole history beneath a figure that had
       * been counted over ninety days. Measured on this estate: "P1 / Urgent
       * open" reads 15 and the board opened 20 rows.
       *
       * AFTER the loop, so a caller that sets its own window wins: the spend
       * trend drills with `period: "custom"` and two dates, and defaulting
       * before the loop would have been overwritten anyway while defaulting a
       * caller-supplied empty period would not. Anything the reader chose is
       * already in `next` and is left exactly as it is.
       */
      if (!next.get("period")) next.set("period", DEFAULT_PERIOD_KEY);
      onNavigateToJobs(next.toString());
    },
    [onNavigateToJobs, search],
  );

  /** Persisted per user, and reflected in the URL so the current view is linkable. */
  const savePreference = useCallback((body: Record<string, string>) => {
    void fetch("/api/dashboard/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  }, []);

  const setMeasure = useCallback(
    (next: CohortMeasure) => {
      setFilterParams((params_) => params_.set("measure", next));
      savePreference({ measure: next });
    },
    [savePreference, setFilterParams],
  );

  /*
   * THE TOGGLE FLIPS WHAT IS ON SCREEN, WHICH IS WHAT THE URL SAYS.
   *
   * It used to flip `splitByPriority` — the preference-resolved intent — while
   * the cards drew, and now report, the split the SERVER performed, which comes
   * from the query string alone. With a saved preference of `on` and a bare
   * URL the two disagreed, so the first tap computed `!true` and wrote
   * `split=off` over a page that was already unsplit: a control that visibly
   * did nothing until it was pressed twice.
   *
   * Reading the parameter here is the same expression the routes evaluate, so
   * the flip is always against the state the reader can see.
   */
  const toggleSplit = useCallback(() => {
    const next = new URLSearchParams(window.location.search).get("split") !== "priority";
    setFilterParams((params_) => params_.set("split", next ? "priority" : "off"));
    savePreference({ split: next ? "on" : "off" });
  }, [savePreference, setFilterParams]);

  /* ── The filter bar ────────────────────────────────────────────────────── */

  const data = options.data;
  const groups: FilterGroup[] = useMemo(
    () => [
      { key: "site", label: "Site", options: data?.sites ?? [], searchable: true },
      { key: "priority", label: "Priority", options: data?.priorities ?? [] },
      { key: "family", label: "Status family", options: data?.families ?? [] },
      { key: "status", label: "Status", options: data?.statuses ?? [], searchable: true },
      {
        key: "engineer",
        label: "Engineer required",
        options: data?.engineers ?? [],
        searchable: true,
      },
      { key: "label", label: "Label", options: data?.labels ?? [], searchable: true },
      { key: "tier", label: "Tier", options: data?.tiers ?? [] },
      {
        key: "nature",
        label: "Nature",
        /* Nature is derived, not stored, so it has no option list to count —
           see `plannedCondition` in dashboard-filters.ts for the rule. */
        options: NATURE_KEYS.map((key: NatureKey) => ({
          value: key,
          label: NATURE_LABEL[key],
        })),
      },
      { key: "contractor", label: "Contractor", options: data?.contractors ?? [], searchable: true },
    ],
    [data],
  );

  const activeChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; value: string; onRemove: () => void }> = [];
    for (const group of groups) {
      for (const value of params.getAll(group.key)) {
        const option = group.options.find((entry) => entry.value === value);
        chips.push({
          key: group.key,
          label: group.label,
          value: option?.label ?? value,
          onRemove: () => toggleFilter(group.key, value),
        });
      }
    }
    return chips;
  }, [groups, params, toggleFilter]);

  /** What every card header appends — §1.2's `· Filtered: Site = Aldgate`. */
  const filterChips = useMemo(
    () =>
      activeChips.map((chip, index) => ({
        key: `${chip.key}:${chip.value}:${index}`,
        label: `${chip.label} = ${chip.value}`,
        onRemove: chip.onRemove,
      })),
    [activeChips],
  );

  const periodControl = (
    <PeriodControl
      periods={options.data?.periods ?? FALLBACK_PERIODS}
      value={params.get("period") ?? DEFAULT_PERIOD_KEY}
      from={params.get("from") ?? ""}
      to={params.get("to") ?? ""}
      onChange={(next) =>
        setFilterParams((params_) => {
          if (next.period !== undefined) params_.set("period", next.period);
          if (next.from !== undefined) params_.set("from", next.from);
          if (next.to !== undefined) params_.set("to", next.to);
        })
      }
    />
  );

  const measureControl = (
    <label className="ovw-measure">
      <span className="ovw-measure__label">Measure by</span>
      <select
        value={measure}
        onChange={(event) => setMeasure(event.target.value as CohortMeasure)}
      >
        <option value="requested">Date requested</option>
        <option value="completed">Date completed</option>
      </select>
    </label>
  );

  const jump = (id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
  };

  return (
    <>
      {/* Tokens first: a rule cannot read a custom property that is not there yet. */}
      <link rel="stylesheet" href={opsTokensCss} precedence="default" />
      <link rel="stylesheet" href={opsCss} precedence="default" />
      <link rel="stylesheet" href={overviewCss} precedence="default" />
      <link rel="stylesheet" href={glanceCss} precedence="default" />
      <link rel="stylesheet" href={analysisCss} precedence="default" />
      <link rel="stylesheet" href={portfolioCss} precedence="default" />
      <link rel="stylesheet" href={toolsCss} precedence="default" />

      <section className="ops-page">
        <OvDash
          onNavigateToJobs={onNavigateToJobs}
          onNavigateToCompliance={onNavigateToCompliance}
        />

        <header className="ops-page__head">
          <p className="ops-page__eyebrow">Live operations</p>
          <h1>Overview</h1>
        </header>

        <OpsFilterBar
          periodControl={periodControl}
          groups={groups}
          extra={measureControl}
          /* §1.8: the date range and the axis live at the top of the same sheet. */
          sheetLead={
            <>
              <div className="ops-sheet__period">{periodControl}</div>
              {measureControl}
            </>
          }
          onClearAll={clearAll}
          activeChips={activeChips}
        />

        {/*
          The jump bar. Five destinations, sticky under the filter bar, because
          this page is long and the alternative on a phone is a thumb.
        */}
        <nav className="ovw-jump" aria-label="Jump to a section">
          <ul>
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <button type="button" onClick={() => jump(section.id)}>
                  {section.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <PulseRow state={meters} onDrill={drill} onOpenRecords={(query) => setRecords(query as RecordsQuery)} />

        <AtAGlanceCard
          meters={meters}
          stuck={stuck}
          measure={measure}
          filterChips={filterChips}
          onToggle={toggleFilter}
          onDrill={drill}
          onOpenRecords={(query) => setRecords(query as RecordsQuery)}
          onOpenJob={onOpenJob}
        />

        <FinancialStatusCard
          state={cost}
          measure={measure}
          filterChips={filterChips}
          onToggle={toggleFilter}
          onDrill={drill}
          onOpenRecords={(query) => setRecords(query as RecordsQuery)}
          onOpenResolveNames={() => setTool("contractors")}
          onOpenJob={onOpenJob}
        />

        <PerformanceCard
          state={performance}
          measure={measure}
          filterChips={filterChips}
          onToggle={toggleFilter}
          onDrill={drill}
          onSelectWindow={(from, toInclusive) =>
            setFilterParams((params_) => {
              params_.set("period", "custom");
              params_.set("from", from);
              params_.set("to", toInclusive);
            })
          }
          splitByPriority={splitByPriority}
          onToggleSplit={toggleSplit}
        />

        <JobBreakdownCard
          state={breakdown}
          measure={measure}
          filterChips={filterChips}
          splitByPriority={splitByPriority}
          onToggleSplit={toggleSplit}
          onToggle={toggleFilter}
          onDrill={drill}
          onOpenRecords={(query) => setRecords(query as RecordsQuery)}
        />

        <SitesAttentionCard
          state={attention}
          measure={measure}
          filterChips={filterChips}
          onToggle={toggleFilter}
          onDrill={drill}
          onOpenRecords={(query) => setRecords(query as RecordsQuery)}
          onOpenBulkAssign={() => setTool("sites")}
          onNavigateToSites={onNavigateToSites}
          onNavigateToCompliance={onNavigateToCompliance}
        />

        {/*
          The three write-side tools, opened from the cards that name the
          problem they solve. §8: nothing on this page changes a job record
          except these, and each states what it will do before it does it.
        */}
        <div className="ovw-tools">
          <button type="button" className="ops-link" onClick={() => setTool("meters")}>
            Settings → Dashboard meters
          </button>
        </div>

        {tool === "meters" ? (
          <OverviewTool title="Dashboard meters" onClose={() => setTool(null)}>
            <MeterSettings onSaved={() => meters.reload()} />
          </OverviewTool>
        ) : null}
        {tool === "contractors" ? (
          <OverviewTool title="Resolve contractor names" onClose={() => setTool(null)}>
            <ResolveNames onChanged={() => cost.reload()} />
          </OverviewTool>
        ) : null}
        {tool === "sites" ? (
          <OverviewTool title="Assign jobs to a site" onClose={() => setTool(null)}>
            <BulkSiteAssign
              onAssigned={() => {
                attention.reload();
                meters.reload();
              }}
            />
          </OverviewTool>
        ) : null}

        {records ? (
          <OverviewRecordsPanel
            query={records}
            search={search}
            onClose={() => setRecords(null)}
            onOpenJob={onOpenJob}
          />
        ) : null}
      </section>
    </>
  );
}

/**
 * One dialog shell for the three tools.
 *
 * A dialog rather than a route because each is opened from the sentence that
 * names the problem it fixes, and sending the reader to another screen loses
 * that context — which is most of why "31 jobs point at no site" went unfixed
 * for as long as it did.
 */
function OverviewTool({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="ops-sheet ovw-tool"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ops-sheet__panel ovw-tool__panel">
        <div className="ops-sheet__head">
          <h2>{title}</h2>
          <button type="button" className="ops-menu__button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
