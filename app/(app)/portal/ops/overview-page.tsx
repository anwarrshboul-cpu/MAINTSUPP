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
import { MeterSettings } from "./meter-settings";
import { ResolveNames } from "./resolve-names";
import { BulkSiteAssign } from "./bulk-site-assign";
import {
  PERIOD_PRESETS,
  DEFAULT_PERIOD,
  DEFAULT_MEASURE,
  type CohortMeasure,
} from "../../../lib/dashboard-filters";
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

type FiltersPayload = {
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
  const { params, setParams, search } = useQueryState();

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
  const preferences = useOpsQuery<PreferencesPayload>("/api/dashboard/preferences", "");

  /*
   * THE AXIS: the URL first, the stored preference second, the default last.
   *
   * Derived rather than written back into the address bar. Seeding the URL from
   * a fetch would mean a link copied a second after the page opened carried a
   * parameter the sender never chose, and it would need a setState in an effect
   * to do it — which the React Compiler rejects and which costs a render pass.
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
   * the caller adds. The board does not yet read every one of these parameters;
   * what it does not read is inert rather than misleading — it is visible in
   * the address bar, which is where a reader can see exactly what was asked
   * for.
   */
  const drill = useCallback(
    (extra: Record<string, string>) => {
      const next = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(extra)) {
        if (!value) next.delete(key);
        else next.set(key, value);
      }
      onNavigateToJobs(next.toString());
    },
    [onNavigateToJobs],
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

  const toggleSplit = useCallback(() => {
    const next = !splitByPriority;
    setFilterParams((params_) => params_.set("split", next ? "priority" : "off"));
    savePreference({ split: next ? "on" : "off" });
  }, [savePreference, setFilterParams, splitByPriority]);

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
      periods={PERIOD_PRESETS}
      value={params.get("period") ?? DEFAULT_PERIOD}
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
