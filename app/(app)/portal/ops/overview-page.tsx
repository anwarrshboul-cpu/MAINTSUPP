"use client";

/**
 * THE OVERVIEW — six cards, all of them server-counted.
 *
 * Nine cards became six. The three that went were duplicates of ones that
 * stayed, which is why removing them loses nothing:
 *
 *   • "Jobs by status" drew a donut from a taxonomy no job on this board uses —
 *     Open / In progress / Awaiting parts / On hold / Scheduled — with three
 *     permanent zeros and four fifths of the work in a bucket labelled "On
 *     hold". Deleted, not remapped; the Status dimension of the Job breakdown
 *     shows the real statuses.
 *   • "Units requiring attention" was the same open jobs as "Sites needing
 *     attention", shown as a flat feed. Merged into the site rows, which is
 *     where a job is answerable.
 *   • "Open job ageing" was that same set again. Its distribution bar is now
 *     the header of the attention card and its "waiting longest" list is the
 *     first site row.
 *
 * Card order is deliberate and it is the reading order on a phone: what is on
 * fire, where it is, what the work is made of, how we are doing, what it costs.
 *
 * ── EVERY NUMBER COMES FROM `/api/dashboard/*` ────────────────────────────
 *
 * Not one figure on this page is computed in the browser. The previous version
 * filtered the whole job list plus a 432 KB workspace snapshot on every render,
 * which is why its filters could only narrow what had already been downloaded.
 * Five endpoints, five payloads sized by the card.
 */

import { useCallback, useMemo, useState } from "react";
import { Icon } from "../../../components";
import opsCss from "./ops.css?url";
import {
  CompactJobRow,
  EmptyState,
  ErrorState,
  HiddenDataTable,
  OpsCard,
  ProgressMeter,
  RadialMeter,
  SegmentedMeter,
  SkeletonRow,
  StatusChip,
  money,
  plural,
} from "./ops-primitives";
import { OpsFilterBar, PeriodControl, type FilterGroup } from "./ops-filter-bar";
import { useOpsQuery, useQueryState } from "./ops-url-state";
import {
  AGEING_BANDS,
  FAMILY_COLOUR,
  FAMILY_LABEL,
  NOT_RECORDED_COLOUR,
  PRIORITY_BANDS,
  UNASSIGNED_SITE_ID,
  type AgeingBandKey,
  type JobStatusFamily,
  type PriorityKey,
  NATURE_KEYS,
  NATURE_LABEL,
  NATURE_COLOUR,
  type NatureKey,
} from "../../../lib/job-metrics";
import { complianceBandColour } from "../../../lib/compliance-status";

/* ── Payload shapes, mirroring the endpoints ─────────────────────────────── */

type Period = {
  key: string;
  label: string;
  start: string | null;
  endExclusive: string;
  days: number;
  hasPrevious: boolean;
};

type Totals = {
  inPeriod: number;
  open: number;
  closed: number;
  attention: number;
  urgentOpen: number;
  unassignedOpen: number;
};

type SummaryPayload = {
  period: Period;
  totals: Totals;
  oldestOpenDays: number | null;
  oldestOpenId: string | null;
  previous: Totals | null;
  unmappedStatuses: string[];
};

type AttentionPayload = {
  period: Period;
  ageing: Array<{
    key: AgeingBandKey;
    label: string;
    colour: string;
    range: string;
    count: number;
  }>;
  siteCount: number;
  sites: Array<{
    siteId: string;
    siteName: string;
    unassigned: boolean;
    openCount: number;
    urgentCount: number;
    oldestDays: number;
    oldestBand: AgeingBandKey;
    priorities: PriorityKey[];
    jobs: Array<{
      id: string;
      reference: string | null;
      title: string;
      priority: PriorityKey;
      priorityLabel: string;
      status: string;
      family: JobStatusFamily;
      daysOpen: number;
      band: AgeingBandKey;
    }>;
    compliance: {
      satisfied: number;
      applicable: number;
      notRequired: number;
      total: number;
      percent: number;
      scored: boolean;
    };
  }>;
};

type Bucket = {
  key: string;
  label: string;
  value: number;
  colour: string;
  notRecorded: boolean;
  family?: JobStatusFamily;
};

type BreakdownPayload = {
  period: Period;
  total: number;
  dimensions: Record<string, { recorded: number; total: number; buckets: Bucket[] }>;
};

type PerformancePayload = {
  period: Period;
  sla: {
    closed: number;
    overdueOpen: number;
    measured: number;
    met: number;
    percent: number | null;
    coveragePercent: number;
    targetField: "target_completion_date" | "due_at" | null;
    averageCloseDays: number | null;
    byPriority: Array<{
      key: PriorityKey;
      label: string;
      measured: number;
      met: number;
      percent: number | null;
    }>;
  };
  mix: {
    buckets: Array<{
      label: string;
      start: string;
      endExclusive: string;
      endInclusive: string;
      reactive: number;
      planned: number;
      partial: boolean;
    }>;
    reactivePercent: number | null;
  };
};

type CostPayload = {
  period: Period;
  totalSpend: number;
  costedJobs: number;
  sites: Array<{
    siteId: string;
    siteName: string;
    unassigned: boolean;
    spend: number;
    annualBudget: number | null;
    proRatedBudget: number | null;
    utilisation: number | null;
  }>;
  unattributedSiteSpend: number;
  sitesWithoutBudget: number;
  periodDays: number;
  contractors: Array<{ key: string; name: string; spend: number; jobs: number; linked: boolean }>;
  contractorAttributed: number;
  contractorLinked: number;
};

type FiltersPayload = {
  sites: Array<{ value: string; label: string; count: number }>;
  contractors: Array<{ value: string; label: string; count: number }>;
  statuses: Array<{ value: string; label: string; count: number }>;
  engineers: Array<{ value: string; label: string; count: number }>;
  labels: Array<{ value: string; label: string; count: number }>;
  tiers: Array<{ value: string; label: string; count: number }>;
  periods: ReadonlyArray<{ key: string; label: string }>;
  priorities: ReadonlyArray<{ key: string; label: string; colour: string }>;
  families: ReadonlyArray<{ value: string; label: string; colour: string }>;
};

/**
 * The parameters this page owns.
 *
 * Named so `Clear all` clears exactly these and leaves anything else in the URL
 * alone — the section router, a deep link into a job, a preview token.
 */
const FILTER_KEYS = [
  "period",
  "from",
  "to",
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

/** Coverage below this is drawn muted rather than as a headline. */
const COVERAGE_CONFIDENCE = 70;

export function OverviewPage({
  onNavigateToJobs,
  onOpenJob,
  onNavigateToCompliance,
  onNavigateToSites,
}: {
  /** Deep-links into the Jobs list with equivalent parameters. */
  onNavigateToJobs: (query: string) => void;
  onOpenJob: (id: string) => void;
  onNavigateToCompliance: () => void;
  onNavigateToSites: (query?: string) => void;
}) {
  const { params, setParams, search } = useQueryState();

  /*
   * The query string the endpoints are called with is the page's own, minus
   * nothing. There is deliberately no client-side massaging: the browser sends
   * what is in the address bar and the server parses it with the SAME parser
   * that serialises it, so a link can never mean one thing to each.
   */
  const summary = useOpsQuery<SummaryPayload>("/api/dashboard/summary", search);
  const attention = useOpsQuery<AttentionPayload>("/api/dashboard/sites-attention", search);
  const breakdown = useOpsQuery<BreakdownPayload>("/api/dashboard/job-breakdown", search);
  const performance = useOpsQuery<PerformancePayload>("/api/dashboard/performance", search);
  const cost = useOpsQuery<CostPayload>("/api/dashboard/cost", search);
  const options = useOpsQuery<FiltersPayload>("/api/dashboard/filters", "");

  const setPeriod = useCallback(
    (next: { period?: string; from?: string; to?: string }) => {
      const updated = new URLSearchParams(window.location.search);
      if (next.period !== undefined) {
        if (next.period === "90") updated.delete("period");
        else updated.set("period", next.period);
        if (next.period !== "custom") {
          updated.delete("from");
          updated.delete("to");
        }
      }
      if (next.from !== undefined) updated.set("from", next.from);
      if (next.to !== undefined) updated.set("to", next.to);
      setParams(updated);
    },
    [setParams],
  );

  const clearAll = useCallback(() => {
    const updated = new URLSearchParams(window.location.search);
    for (const key of FILTER_KEYS) updated.delete(key);
    setParams(updated);
  }, [setParams]);

  /**
   * Add or remove one value of one dimension — what a chart segment does when
   * it is tapped. Tapping the same segment again clears it, which is what makes
   * cross-filtering explorable rather than a one-way door.
   */
  const toggleFilter = useCallback(
    (key: string, value: string) => {
      const updated = new URLSearchParams(window.location.search);
      const existing = updated.getAll(key);
      const next = existing.includes(value)
        ? existing.filter((entry) => entry !== value)
        : [...existing, value];
      updated.delete(key);
      for (const entry of [...new Set(next)].sort()) updated.append(key, entry);
      setParams(updated);
    },
    [setParams],
  );

  const removeFilter = useCallback(
    (key: string, value: string) => toggleFilter(key, value),
    [toggleFilter],
  );

  const groups: FilterGroup[] = useMemo(() => {
    const data = options.data;
    if (!data) return [];
    return [
      { key: "site", label: "Site", options: data.sites, searchable: true },
      {
        key: "priority",
        label: "Priority",
        options: data.priorities.map((band) => ({ value: band.key, label: band.label })),
      },
      {
        key: "family",
        label: "Status family",
        options: data.families.map((family) => ({ value: family.value, label: family.label })),
      },
      { key: "status", label: "Status", options: data.statuses, searchable: true },
      { key: "engineer", label: "Engineer required", options: data.engineers, searchable: true },
      { key: "label", label: "Label", options: data.labels, searchable: true },
      { key: "tier", label: "Tier", options: data.tiers },
      {
        key: "nature",
        label: "Nature",
        options: NATURE_KEYS.map((key) => ({ value: key, label: NATURE_LABEL[key] })),
      },
      { key: "contractor", label: "Contractor", options: data.contractors, searchable: true },
    ];
  }, [options.data]);

  const chips = useMemo(() => {
    const labelFor = (key: string, value: string) => {
      const group = groups.find((entry) => entry.key === key);
      return group?.options.find((option) => option.value === value)?.label ?? value;
    };
    const out: Array<{ key: string; label: string; value: string; onRemove: () => void }> = [];
    for (const key of FILTER_KEYS) {
      if (key === "period" || key === "from" || key === "to") continue;
      for (const value of params.getAll(key)) {
        const group = groups.find((entry) => entry.key === key);
        out.push({
          key,
          label: group?.label ?? key,
          value: labelFor(key, value),
          onRemove: () => removeFilter(key, value),
        });
      }
    }
    return out;
  }, [groups, params, removeFilter]);

  /** Jump to the Jobs list carrying the equivalent parameters. */
  const drill = useCallback(
    (extra: Record<string, string | string[]> = {}) => {
      const query = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(extra)) {
        query.delete(key);
        for (const entry of Array.isArray(value) ? value : [value]) query.append(key, entry);
      }
      onNavigateToJobs(query.toString());
    },
    [onNavigateToJobs],
  );

  const period = summary.data?.period ?? attention.data?.period ?? null;

  return (
    <div className="ops-page">
      <link rel="stylesheet" href={opsCss} precedence="default" />

      <header className="ops-page__head">
        <div>
          <span className="ops-page__eyebrow">Live operations</span>
          <h1>Overview</h1>
        </div>
      </header>

      <OpsFilterBar
        periodControl={
          <PeriodControl
            periods={
              options.data?.periods ?? [
                { key: "7", label: "7 days" },
                { key: "30", label: "30 days" },
                { key: "90", label: "90 days" },
              ]
            }
            value={params.get("period") ?? "90"}
            from={params.get("from") ?? ""}
            to={params.get("to") ?? ""}
            onChange={setPeriod}
          />
        }
        groups={groups}
        onClearAll={clearAll}
        activeChips={chips}
      />

      {summary.data?.unmappedStatuses.length ? (
        /*
         * An unmapped status is SHOWN, never swallowed. Adding a label in monday
         * changes what these charts mean, and a page that absorbed it silently
         * is how the fake taxonomy survived for as long as it did.
         */
        <p className="ops-card__note" role="status">
          {plural(summary.data.unmappedStatuses.length, "job status is", "job statuses are")} not
          mapped to a family and {summary.data.unmappedStatuses.length === 1 ? "is" : "are"} counted
          as in progress: {summary.data.unmappedStatuses.join(", ")}.
        </p>
      ) : null}

      <AtAGlance
        state={summary}
        onDrill={drill}
        onScrollToAttention={() => {
          document.getElementById("ops-attention")?.scrollIntoView({
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
              ? "auto"
              : "smooth",
            block: "start",
          });
        }}
      />

      <SitesNeedingAttention
        state={attention}
        onDrill={drill}
        onOpenJob={onOpenJob}
        onNavigateToSites={onNavigateToSites}
      />

      <div className="ops-grid-2">
        <JobBreakdown
          state={breakdown}
          onToggle={toggleFilter}
          onDrill={(key, value) => drill({ [key]: value })}
        />
        <PerformanceCard
          state={performance}
          period={period}
          onToggle={toggleFilter}
          onDrill={drill}
          onSelectWindow={(from, to) => setPeriod({ period: "custom", from, to })}
        />
        <CostCard
          state={cost}
          onNavigateToSites={onNavigateToSites}
          onNavigateToCompliance={onNavigateToCompliance}
          onToggle={toggleFilter}
          onDrill={drill}
        />
      </div>
    </div>
  );
}

/* ── 1. At a glance ───────────────────────────────────────────────────────── */

type QueryState<T> = { data: T | null; loading: boolean; error: string | null; reload: () => void };

function AtAGlance({
  state,
  onDrill,
  onScrollToAttention,
}: {
  state: QueryState<SummaryPayload>;
  onDrill: (extra?: Record<string, string | string[]>) => void;
  onScrollToAttention: () => void;
}) {
  if (state.error) {
    return (
      <OpsCard title="At a glance">
        <ErrorState what={state.error} onRetry={state.reload} />
      </OpsCard>
    );
  }
  if (!state.data) {
    return (
      <OpsCard title="At a glance">
        <SkeletonRow lines={4} height={110} />
      </OpsCard>
    );
  }

  const { totals, previous, oldestOpenDays } = state.data;
  const oldestBand = AGEING_BANDS.find(
    (band) => band.to === null || (oldestOpenDays ?? 0) <= band.to,
  )!;

  const tiles = [
    {
      key: "open",
      value: totals.open,
      label: "Open jobs",
      delta: previous ? totals.open - previous.open : null,
      meter: (
        <RadialMeter
          value={totals.open}
          max={Math.max(totals.inPeriod, 1)}
          tone={FAMILY_COLOUR.in_progress}
          centre={`${totals.open}`}
          caption={`of ${totals.inPeriod}`}
          label={`${totals.open} open of ${totals.inPeriod} jobs raised in this period`}
          size={78}
        />
      ),
      onClick: () => onDrill({ family: ["in_progress", "attention"] }),
    },
    {
      key: "attention",
      value: totals.attention,
      label: "Needs attention",
      delta: previous ? totals.attention - previous.attention : null,
      meter: (
        <ProgressMeter
          value={totals.attention}
          max={Math.max(totals.open, 1)}
          tone={FAMILY_COLOUR.attention}
          label={`${totals.attention} of ${totals.open} open jobs need attention`}
        />
      ),
      onClick: onScrollToAttention,
    },
    {
      key: "oldest",
      value: oldestOpenDays ?? 0,
      unit: "days",
      label: "Oldest open",
      delta: null,
      meter: (
        <ProgressMeter
          value={Math.min(oldestOpenDays ?? 0, 120)}
          max={120}
          tone={oldestBand.colour}
          label={`Oldest open job is ${oldestOpenDays ?? 0} days old — ${oldestBand.label}, ${oldestBand.range}`}
        />
      ),
      onClick: () => onDrill({ sort: "age" }),
    },
    {
      key: "urgent",
      value: totals.urgentOpen,
      label: "Urgent open",
      delta: previous ? totals.urgentOpen - previous.urgentOpen : null,
      meter: (
        <ProgressMeter
          value={totals.urgentOpen}
          max={Math.max(totals.open, 1)}
          tone="#E5484D"
          label={`${totals.urgentOpen} of ${totals.open} open jobs are urgent`}
        />
      ),
      onClick: () => onDrill({ priority: "urgent", family: ["in_progress", "attention"] }),
    },
    {
      key: "unassigned",
      value: totals.unassignedOpen,
      label: "Unassigned site",
      delta: previous ? totals.unassignedOpen - previous.unassignedOpen : null,
      meter: (
        <ProgressMeter
          value={totals.unassignedOpen}
          max={Math.max(totals.open, 1)}
          tone={totals.unassignedOpen > 0 ? "#E5484D" : NOT_RECORDED_COLOUR}
          label={`${totals.unassignedOpen} of ${totals.open} open jobs have no site`}
        />
      ),
      onClick: () => onDrill({ site: UNASSIGNED_SITE_ID }),
    },
  ];

  return (
    <OpsCard title="At a glance" subtitle={state.data.period.label}>
      <div className="ops-tiles">
        {tiles.map((tile) => (
          <button key={tile.key} type="button" className="ops-tile" onClick={tile.onClick}>
            <span className="ops-tile__value">
              {tile.value}
              {tile.unit ? <span className="ops-tile__unit">{tile.unit}</span> : null}
            </span>
            <span className="ops-tile__label">{tile.label}</span>
            {tile.meter}
            {/*
              The delta is OMITTED when there is nothing to compare against,
              rather than printed as a zero. "No change" over a period that does
              not exist is a claim the data cannot support.
            */}
            {tile.delta === null ? null : (
              <span className="ops-tile__delta">
                {tile.delta === 0
                  ? "No change on previous period"
                  : `${tile.delta > 0 ? "▲" : "▼"} ${Math.abs(tile.delta)} on previous period`}
              </span>
            )}
          </button>
        ))}
      </div>
      <HiddenDataTable
        caption="At a glance"
        columns={["Measure", "Value", "Change on previous period"]}
        rows={tiles.map((tile) => [
          tile.label,
          `${tile.value}${tile.unit ? ` ${tile.unit}` : ""}`,
          tile.delta === null ? "Not comparable" : String(tile.delta),
        ])}
      />
    </OpsCard>
  );
}

/* ── 2. Sites needing attention ───────────────────────────────────────────── */

function SitesNeedingAttention({
  state,
  onDrill,
  onOpenJob,
  onNavigateToSites,
}: {
  state: QueryState<AttentionPayload>;
  onDrill: (extra?: Record<string, string | string[]>) => void;
  onOpenJob: (id: string) => void;
  onNavigateToSites: (query?: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  if (state.error) {
    return (
      <OpsCard title="Sites needing attention" id="ops-attention">
        <ErrorState what={state.error} onRetry={state.reload} />
      </OpsCard>
    );
  }
  if (!state.data) {
    return (
      <OpsCard title="Sites needing attention" id="ops-attention">
        <SkeletonRow lines={5} height={200} />
      </OpsCard>
    );
  }

  const { ageing, sites, siteCount } = state.data;
  const totalOpen = ageing.reduce((sum, band) => sum + band.count, 0);

  if (!sites.length) {
    return (
      <OpsCard title="Sites needing attention" id="ops-attention">
        <EmptyState>Every job in this period is completed or scheduled.</EmptyState>
      </OpsCard>
    );
  }

  const maxOpen = Math.max(...sites.map((site) => site.openCount), 1);
  const maxDays = Math.max(...sites.map((site) => site.oldestDays), 1);
  /*
   * Sites with no open work and complete compliance are behind the toggle. A
   * card called "needing attention" that lists ten stores where nine need
   * nothing has taught the reader to scroll past it.
   */
  const quiet = sites.filter(
    (site) => site.openCount === 0 && site.compliance.scored && site.compliance.percent === 100,
  );
  const visible = showAll ? sites : sites.filter((site) => !quiet.includes(site));

  return (
    <OpsCard
      title="Sites needing attention"
      id="ops-attention"
      subtitle={`${plural(totalOpen, "open job")} across ${plural(siteCount, "site")}`}
      action={
        <button type="button" className="ops-link" onClick={() => onDrill({ family: ["attention"] })}>
          View all <Icon name="chevron" size={14} />
        </button>
      }
    >
      <div>
        <p className="ops-section-title">Age of open work</p>
        <SegmentedMeter
          segments={ageing.map((band) => ({
            key: band.key,
            label: `${band.label} (${band.range})`,
            value: band.count,
            colour: band.colour,
          }))}
          height={12}
          label="Open jobs by age"
        />
        <ul className="ops-legend" style={{ marginTop: 6 }}>
          {ageing.map((band) => (
            <li key={band.key}>
              <span className="ops-swatch" style={{ background: band.colour }} aria-hidden="true" />
              {band.label} <strong>{band.count}</strong> <span>({band.range})</span>
            </li>
          ))}
        </ul>
        <HiddenDataTable
          caption="Open jobs by age band"
          columns={["Band", "Days open", "Jobs"]}
          rows={ageing.map((band) => [band.label, band.range, band.count])}
        />
      </div>

      <div className="ops-rows">
        {visible.map((site) => {
          const band = AGEING_BANDS.find((entry) => entry.key === site.oldestBand)!;
          const isOpen = expanded === site.siteId;
          return (
            <div
              key={site.siteId}
              className={`ops-row${site.unassigned ? " ops-row--unassigned" : ""}`}
              style={{ ["--ops-edge" as string]: site.urgentCount > 0 ? "#E5484D" : band.colour }}
            >
              <div className="ops-row__top">
                <button
                  type="button"
                  className="ops-row__name"
                  style={{ background: "transparent", border: 0, color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer", padding: 0 }}
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : site.siteId)}
                >
                  {site.siteName}
                </button>
                <span className="ops-group__count">{plural(site.openCount, "job")}</span>
                <Icon name="chevron" size={15} />
              </div>

              <div className="ops-row__secondary">
                <span className="ops-dots">
                  {site.priorities.slice(0, 10).map((priority, index) => (
                    <span
                      key={index}
                      style={{
                        background:
                          PRIORITY_BANDS.find((entry) => entry.key === priority)?.colour ??
                          NOT_RECORDED_COLOUR,
                      }}
                    />
                  ))}
                  {site.priorities.length > 10 ? <small>+{site.priorities.length - 10}</small> : null}
                  <small>
                    {site.urgentCount > 0 ? `${site.urgentCount} urgent` : "None urgent"}
                  </small>
                </span>
              </div>

              <div className="ops-row__meters">
                <div className="ops-row__meter">
                  <span className="ops-row__meter-label">
                    Oldest <strong>{site.oldestDays} days</strong>
                  </span>
                  <ProgressMeter
                    value={site.oldestDays}
                    max={maxDays}
                    tone={band.colour}
                    label={`Oldest open job at ${site.siteName}: ${site.oldestDays} days, ${band.label}`}
                  />
                </div>
                <div className="ops-row__meter">
                  <span className="ops-row__meter-label">
                    Share of open <strong>{site.openCount}</strong>
                  </span>
                  <ProgressMeter
                    value={site.openCount}
                    max={maxOpen}
                    tone={FAMILY_COLOUR.in_progress}
                    label={`${site.openCount} open jobs at ${site.siteName}`}
                  />
                </div>
                <div className="ops-row__meter">
                  <span className="ops-row__meter-label">
                    Compliance{" "}
                    <strong>
                      {site.compliance.scored
                        ? `${site.compliance.satisfied} of ${site.compliance.applicable}`
                        : "Not set up"}
                    </strong>
                  </span>
                  <ProgressMeter
                    value={site.compliance.satisfied}
                    max={Math.max(site.compliance.applicable, 1)}
                    tone={
                      site.compliance.scored
                        ? complianceBandColour(site.compliance.percent)
                        : NOT_RECORDED_COLOUR
                    }
                    label={
                      site.compliance.scored
                        ? `Compliance at ${site.siteName}: ${site.compliance.satisfied} of ${site.compliance.applicable} applicable requirements met, ${site.compliance.percent}%${
                            site.compliance.notRequired
                              ? `, ${site.compliance.notRequired} not required`
                              : ""
                          }`
                        : `No compliance requirements set up for ${site.siteName}`
                    }
                  />
                </div>
              </div>

              {site.unassigned ? (
                <div className="ops-actions">
                  <button
                    type="button"
                    className="ops-link"
                    onClick={() => onDrill({ site: UNASSIGNED_SITE_ID })}
                  >
                    Fix these <Icon name="chevron" size={14} />
                  </button>
                  <span className="ops-card__note">
                    These jobs point at no site in the register.
                  </span>
                </div>
              ) : null}

              {isOpen ? (
                <div className="ops-job-rows">
                  {site.jobs.map((job) => (
                    <CompactJobRow
                      key={job.id}
                      title={job.title}
                      reference={job.reference}
                      priorityLabel={job.priorityLabel}
                      priorityColour={
                        PRIORITY_BANDS.find((entry) => entry.key === job.priority)?.colour ??
                        NOT_RECORDED_COLOUR
                      }
                      status={job.status}
                      statusColour={FAMILY_COLOUR[job.family]}
                      daysOpen={job.daysOpen}
                      bandColour={AGEING_BANDS.find((entry) => entry.key === job.band)!.colour}
                      onOpen={() => onOpenJob(job.id)}
                    />
                  ))}
                  {site.openCount > site.jobs.length ? (
                    <button
                      type="button"
                      className="ops-link"
                      onClick={() =>
                        site.unassigned
                          ? onDrill({ site: UNASSIGNED_SITE_ID })
                          : onDrill({ site: site.siteId })
                      }
                    >
                      View all {site.openCount} at this site <Icon name="chevron" size={14} />
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {quiet.length ? (
        <button type="button" className="ops-link" onClick={() => setShowAll((value) => !value)}>
          {showAll ? "Hide sites needing nothing" : `Show all ${sites.length} sites`}
        </button>
      ) : null}

      <button type="button" className="ops-link" onClick={() => onNavigateToSites()}>
        Open the sites register <Icon name="chevron" size={14} />
      </button>
    </OpsCard>
  );
}

/* ── 3. Job breakdown ─────────────────────────────────────────────────────── */

const DIMENSION_META: Array<{
  key: string;
  title: string;
  /** The query key a bucket cross-filters on. */
  param: string;
  shape: "radial" | "donut" | "stacked" | "bars" | "status";
}> = [
  { key: "tier", title: "Tier level", param: "tier", shape: "radial" },
  { key: "engineer", title: "Engineer required", param: "engineer", shape: "donut" },
  { key: "priority", title: "Priority", param: "priority", shape: "stacked" },
  { key: "label", title: "Label", param: "label", shape: "bars" },
  { key: "status", title: "Status", param: "status", shape: "status" },
];

function JobBreakdown({
  state,
  onToggle,
  onDrill,
}: {
  state: QueryState<BreakdownPayload>;
  onToggle: (key: string, value: string) => void;
  onDrill: (key: string, value: string) => void;
}) {
  if (state.error) {
    return (
      <OpsCard title="Job breakdown" className="ops-span-2">
        <ErrorState what={state.error} onRetry={state.reload} />
      </OpsCard>
    );
  }
  if (!state.data) {
    return (
      <OpsCard title="Job breakdown" className="ops-span-2">
        <SkeletonRow lines={6} height={260} />
      </OpsCard>
    );
  }
  if (state.data.total === 0) {
    return (
      <OpsCard title="Job breakdown" className="ops-span-2">
        <EmptyState>No jobs in this period. Widen the period to see more.</EmptyState>
      </OpsCard>
    );
  }

  return (
    <OpsCard
      title="Job breakdown"
      className="ops-span-2"
      subtitle={`${plural(state.data.total, "job")} in this period`}
    >
      {DIMENSION_META.map((meta) => {
        const dimension = state.data!.dimensions[meta.key];
        if (!dimension) return null;
        return (
          <div key={meta.key}>
            <div className="ops-card__head">
              <p className="ops-section-title">{meta.title}</p>
              <span className="ops-card__note">
                {dimension.recorded} of {dimension.total} recorded
              </span>
            </div>
            <DimensionBody
              shape={meta.shape}
              param={meta.param}
              dimension={dimension}
              onToggle={onToggle}
              onDrill={onDrill}
            />
            <HiddenDataTable
              caption={`${meta.title}, jobs in this period`}
              columns={[meta.title, "Jobs", "Share"]}
              rows={dimension.buckets.map((bucket) => [
                bucket.label,
                bucket.value,
                `${Math.round((bucket.value / Math.max(dimension.total, 1)) * 100)}%`,
              ])}
            />
          </div>
        );
      })}
    </OpsCard>
  );
}

function DimensionBody({
  shape,
  param,
  dimension,
  onToggle,
  onDrill,
}: {
  shape: "radial" | "donut" | "stacked" | "bars" | "status";
  param: string;
  dimension: { recorded: number; total: number; buckets: Bucket[] };
  onToggle: (key: string, value: string) => void;
  onDrill: (key: string, value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (shape === "radial" || shape === "donut") {
    const dominant = [...dimension.buckets]
      .filter((bucket) => !bucket.notRecorded)
      .sort((left, right) => right.value - left.value)[0];
    return (
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <RadialMeter
          value={dominant?.value ?? 0}
          max={Math.max(dimension.total, 1)}
          tone={dominant?.colour ?? NOT_RECORDED_COLOUR}
          centre={String(shape === "donut" ? dimension.total : dominant?.value ?? 0)}
          caption={shape === "donut" ? "jobs" : dominant?.label}
          label={`${dominant?.label ?? "Nothing recorded"}: ${dominant?.value ?? 0} of ${dimension.total}`}
        />
        <ul className="ops-legend" style={{ flex: "1 1 160px" }}>
          {dimension.buckets.map((bucket) => (
            <li key={bucket.key}>
              <span className="ops-swatch" style={{ background: bucket.colour }} aria-hidden="true" />
              <button
                type="button"
                className="ops-link"
                onClick={() => onToggle(param, bucket.key)}
                title={`Filter this page to ${bucket.label}`}
              >
                {bucket.label}
              </button>
              <strong>{bucket.value}</strong>
              <span>{Math.round((bucket.value / Math.max(dimension.total, 1)) * 100)}%</span>
              <button
                type="button"
                className="ops-bar__drill"
                onClick={() => onDrill(param, bucket.key)}
                aria-label={`View the ${bucket.value} ${bucket.label} jobs`}
                title={`View ${bucket.label} jobs`}
              >
                <Icon name="chevron" size={13} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (shape === "stacked") {
    return (
      <>
        <SegmentedMeter
          segments={dimension.buckets.map((bucket) => ({
            key: bucket.key,
            label: bucket.label,
            value: bucket.value,
            colour: bucket.colour,
          }))}
          height={20}
          label="Jobs by priority"
          onSelect={(segment) => onToggle(param, segment.key)}
        />
        <ul className="ops-legend" style={{ marginTop: 6 }}>
          {dimension.buckets.map((bucket) => (
            <li key={bucket.key}>
              <span className="ops-swatch" style={{ background: bucket.colour }} aria-hidden="true" />
              {bucket.label} <strong>{bucket.value}</strong>
              <button
                type="button"
                className="ops-bar__drill"
                onClick={() => onDrill(param, bucket.key)}
                aria-label={`View the ${bucket.value} ${bucket.label} jobs`}
                title={`View ${bucket.label} jobs`}
              >
                <Icon name="chevron" size={13} />
              </button>
            </li>
          ))}
        </ul>
      </>
    );
  }

  if (shape === "status") {
    /*
     * Two levels. Nine statuses with a long tail would waste the whole width on
     * one green block, so the family bar goes on top and the individual
     * statuses beneath it, grouped by family and never rolled up: a status with
     * a count of one is often the one that matters.
     */
    const families: JobStatusFamily[] = ["completed", "in_progress", "attention"];
    const totals = families.map((family) => ({
      key: family,
      label: FAMILY_LABEL[family],
      value: dimension.buckets
        .filter((bucket) => bucket.family === family)
        .reduce((sum, bucket) => sum + bucket.value, 0),
      colour: FAMILY_COLOUR[family],
    }));
    return (
      <>
        <SegmentedMeter
          segments={totals}
          height={18}
          label="Jobs by status family"
          onSelect={(segment) => onToggle("family", segment.key)}
        />
        <ul className="ops-legend" style={{ margin: "6px 0 10px" }}>
          {totals.map((family) => (
            <li key={family.key}>
              <span className="ops-swatch" style={{ background: family.colour }} aria-hidden="true" />
              {family.label} <strong>{family.value}</strong>
              <span>{Math.round((family.value / Math.max(dimension.total, 1)) * 100)}%</span>
            </li>
          ))}
        </ul>
        <div className="ops-bars">
          {dimension.buckets.map((bucket) => (
            <BarRow
              key={bucket.key}
              bucket={bucket}
              max={Math.max(...dimension.buckets.map((entry) => entry.value), 1)}
              onClick={() => onToggle(bucket.notRecorded ? param : "status", bucket.key)}
              onDrill={() => onDrill(bucket.notRecorded ? param : "status", bucket.key)}
            />
          ))}
        </div>
      </>
    );
  }

  /* bars — horizontal only. These are word labels, and rotated axis text is
     unreadable on a phone. */
  const ranked = dimension.buckets.filter((bucket) => !bucket.notRecorded);
  const missing = dimension.buckets.filter((bucket) => bucket.notRecorded);
  const top = expanded ? ranked : ranked.slice(0, 8);
  const rest = ranked.length - top.length;
  const max = Math.max(...dimension.buckets.map((bucket) => bucket.value), 1);
  return (
    <div className="ops-bars">
      {top.map((bucket) => (
        <BarRow
          key={bucket.key}
          bucket={bucket}
          max={max}
          onClick={() => onToggle(param, bucket.key)}
          onDrill={() => onDrill(param, bucket.key)}
        />
      ))}
      {rest > 0 ? (
        <button type="button" className="ops-link" onClick={() => setExpanded(true)}>
          +{rest} more
        </button>
      ) : null}
      {expanded && ranked.length > 8 ? (
        <button type="button" className="ops-link" onClick={() => setExpanded(false)}>
          Show fewer
        </button>
      ) : null}
      {/* Not recorded sits at the bottom, outside the ranking — it is a
          coverage figure, not a category competing for a place in the top 8. */}
      {missing.map((bucket) => (
        <BarRow
          key={bucket.key}
          bucket={bucket}
          max={max}
          onClick={() => onToggle(param, bucket.key)}
          onDrill={() => onDrill(param, bucket.key)}
        />
      ))}
    </div>
  );
}

/**
 * One bar, and the two things a reader can do with it.
 *
 * CROSS-FILTER is the primary action: tapping the bar adds this bucket to the
 * filter bar as a chip and every card on the page recomputes. Tapping it again
 * clears it, which is what makes exploring reversible.
 *
 * DRILL THROUGH is the second, and it is a real button rather than a hover
 * affordance — a hover cannot be reached on a touchscreen, which is where this
 * page is mostly read. It carries the bucket's name and its count in its
 * accessible name and navigates to the jobs list with the same parameters, so
 * the link is shareable and survives a refresh.
 */
function BarRow({
  bucket,
  max,
  onClick,
  onDrill,
}: {
  bucket: Bucket;
  max: number;
  onClick: () => void;
  onDrill?: () => void;
}) {
  return (
    <div className="ops-bar-row">
      <button
        type="button"
        className="ops-bar"
        onClick={onClick}
        title={`Filter this page to ${bucket.label}`}
      >
        <span className="ops-bar__label">{bucket.label}</span>
        <ProgressMeter
          value={bucket.value}
          max={max}
          tone={bucket.colour}
          label={`${bucket.label}: ${bucket.value}`}
          height={9}
        />
        <span className="ops-bar__value">{bucket.value}</span>
      </button>
      {onDrill ? (
        <button
          type="button"
          className="ops-bar__drill"
          onClick={onDrill}
          aria-label={`View the ${bucket.value} ${bucket.label} jobs`}
          title={`View ${bucket.label} jobs`}
        >
          <Icon name="chevron" size={14} />
        </button>
      ) : null}
    </div>
  );
}

/* ── 4. Performance over time ─────────────────────────────────────────────── */

function PerformanceCard({
  state,
  period,
  onToggle,
  onDrill,
  onSelectWindow,
}: {
  state: QueryState<PerformancePayload>;
  period: Period | null;
  onToggle: (key: string, value: string) => void;
  onDrill: (extra: Record<string, string | string[]>) => void;
  /** Cross-filters the whole page to one trend bucket's days. */
  onSelectWindow: (from: string, to: string) => void;
}) {
  if (state.error) {
    return (
      <OpsCard title="Performance over time">
        <ErrorState what={state.error} onRetry={state.reload} />
      </OpsCard>
    );
  }
  if (!state.data) {
    return (
      <OpsCard title="Performance over time">
        <SkeletonRow lines={5} height={200} />
      </OpsCard>
    );
  }

  const { sla, mix } = state.data;
  const unearned = sla.coveragePercent < COVERAGE_CONFIDENCE;
  const maxBucket = Math.max(
    ...mix.buckets.map((bucket) => bucket.reactive + bucket.planned),
    1,
  );

  return (
    <OpsCard title="Performance over time" subtitle={period?.label}>
      <div>
        <p className="ops-section-title">Past target date</p>
        {/*
          The figure the old Overview carried as an "Overdue" tile. It is here
          rather than in the tile strip because a count of work that has already
          missed its promise belongs beside the percentage that says how often
          promises are kept — and because nothing on this page may lose a number
          the previous one printed.
        */}
        <p className={`ops-headline${sla.overdueOpen === 0 ? " ops-headline--unearned" : ""}`}>
          {sla.overdueOpen}
        </p>
        <p className="ops-coverage__text">
          {sla.overdueOpen === 0
            ? "No open job is past its due date."
            : `${plural(sla.overdueOpen, "open job is", "open jobs are")} past the due date on the job.`}
        </p>
      </div>

      <div>
        <p className="ops-section-title">SLA performance</p>
        {sla.measured === 0 ? (
          <EmptyState>
            None of the {plural(sla.closed, "closed job")} in this period carries both a target
            date and a completion date, so nothing can be measured. Set target dates to make this
            meaningful.
          </EmptyState>
        ) : (
          <>
            <p className={`ops-headline${unearned ? " ops-headline--unearned" : ""}`}>
              {sla.percent}% of {sla.measured} measured
            </p>
            <p className="ops-coverage__text">
              {sla.closed - sla.measured} of {plural(sla.closed, "closed job")} had no target date.
            </p>
            <div className="ops-coverage">
              <ProgressMeter
                value={sla.met}
                max={Math.max(sla.measured, 1)}
                tone={unearned ? NOT_RECORDED_COLOUR : FAMILY_COLOUR.completed}
                label={`${sla.met} of ${sla.measured} measured jobs met their target`}
              />
              <ProgressMeter
                value={sla.measured}
                max={Math.max(sla.closed, 1)}
                tone={NOT_RECORDED_COLOUR}
                height={6}
                label={`Coverage: ${sla.measured} of ${sla.closed} closed jobs measured`}
              />
              <span className="ops-coverage__text">
                Coverage {sla.measured} of {sla.closed} closed jobs ({sla.coveragePercent}%)
                {sla.targetField === "due_at"
                  ? " · measured against the job's due date, because no target completion date is recorded"
                  : ""}
              </span>
              {unearned ? (
                <span className="ops-coverage__text">Set target dates to make this meaningful.</span>
              ) : null}
            </div>
            <div className="ops-bars" style={{ marginTop: 10 }}>
              {sla.byPriority
                .filter((row) => row.measured > 0)
                .map((row) => (
                  <div key={row.key} className="ops-bar-row">
                    <button
                      type="button"
                      className="ops-bar"
                      onClick={() => onToggle("priority", row.key)}
                      title={`Filter this page to ${row.label}`}
                    >
                      <span className="ops-bar__label">{row.label}</span>
                      <ProgressMeter
                        value={row.met}
                        max={Math.max(row.measured, 1)}
                        tone={FAMILY_COLOUR.completed}
                        label={`${row.label}: ${row.met} of ${row.measured} met target`}
                        height={9}
                      />
                      {/* A percentage without its denominator is not a metric. */}
                      <span className="ops-bar__value">
                        {row.percent}% · {row.measured} measured
                      </span>
                    </button>
                    {/*
                      Drills to the CLOSED jobs of this priority, not to all of
                      them: the bar measures work that finished, so a link that
                      returned the open ones too would not add up to the number
                      the reader tapped.
                    */}
                    <button
                      type="button"
                      className="ops-bar__drill"
                      onClick={() => onDrill({ priority: row.key, family: "completed" })}
                      aria-label={`View the ${row.measured} closed ${row.label} jobs`}
                      title={`View closed ${row.label} jobs`}
                    >
                      <Icon name="chevron" size={14} />
                    </button>
                  </div>
                ))}
            </div>
            {sla.averageCloseDays !== null ? (
              <p className="ops-card__note">
                Average time to close {sla.averageCloseDays} days over {plural(sla.measured, "job")}.
              </p>
            ) : null}
          </>
        )}
        <HiddenDataTable
          caption="SLA performance by priority"
          columns={["Priority", "Measured", "Met target", "Percentage"]}
          rows={sla.byPriority.map((row) => [
            row.label,
            row.measured,
            row.met,
            row.percent === null ? "Not measured" : `${row.percent}%`,
          ])}
        />
      </div>

      <div>
        <p className="ops-section-title">Reactive vs planned</p>
        <p className="ops-card__note">
          {mix.reactivePercent === null
            ? "No jobs were raised in this period."
            : `${mix.reactivePercent}% of the work raised in this period is reactive.`}
        </p>
        {/*
          THE THREE THINGS A BUCKET DOES, and why they are three.

          A stacked bar carries two questions at once — "when?" and "what kind
          of work?" — so one tap target cannot answer both. The segments
          cross-filter the KIND (`nature`), the label under the bar
          cross-filters the WHEN (a custom range over the bucket's own days),
          and the chevron drills the pair through to the jobs list.

          A segment is only rendered when its count is non-zero, and it carries
          a floor height so that a bucket of 1 beside a bucket of 300 is still
          a target a finger can hit. A zero has no segment because there is
          nothing to filter to — an invisible button that silently returns
          nothing is worse than an honest gap.
        */}
        <div className="ops-series">
          {mix.buckets.map((bucket) => {
            const total = bucket.reactive + bucket.planned;
            const height = (value: number) => `${(value / maxBucket) * 100}%`;
            const part = (nature: NatureKey, value: number) =>
              value === 0 ? null : (
                <button
                  type="button"
                  className={`ops-series__part${bucket.partial ? " is-hatched" : ""}`}
                  style={{ height: height(value), background: NATURE_COLOUR[nature] }}
                  onClick={() => onToggle("nature", nature)}
                  aria-label={`${value} ${NATURE_LABEL[nature].toLowerCase()} in ${
                    bucket.label
                  } — filter this page to ${NATURE_LABEL[nature].toLowerCase()} work`}
                  title={`Filter to ${NATURE_LABEL[nature].toLowerCase()} work`}
                />
              );
            return (
              <div key={bucket.start} className="ops-series__bucket">
                <span className="ops-series__total">
                  {total}
                  {bucket.partial ? <small> in progress</small> : null}
                </span>
                <div className="ops-series__stack">
                  {part("reactive", bucket.reactive)}
                  {part("planned", bucket.planned)}
                </div>
                <div className="ops-series__foot">
                  <button
                    type="button"
                    className="ops-series__label"
                    onClick={() => onSelectWindow(bucket.start, bucket.endInclusive)}
                    aria-label={`Filter this page to ${bucket.label}: ${bucket.reactive} reactive, ${
                      bucket.planned
                    } planned${bucket.partial ? ", period still in progress" : ""}`}
                    title={`Filter this page to ${bucket.label}`}
                  >
                    {bucket.label}
                  </button>
                  <button
                    type="button"
                    className="ops-bar__drill"
                    onClick={() =>
                      onDrill({ period: "custom", from: bucket.start, to: bucket.endInclusive })
                    }
                    aria-label={`View the ${plural(total, "job")} raised in ${bucket.label}`}
                    title={`View jobs raised in ${bucket.label}`}
                  >
                    <Icon name="chevron" size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {/* The legend is the second route to the same cross-filter, and on a
            phone it is the reliable one: a full-width row rather than a slice
            of a 74px column. */}
        <ul className="ops-legend">
          {NATURE_KEYS.map((nature) => (
            <li key={nature}>
              <span
                className="ops-swatch"
                style={{ background: NATURE_COLOUR[nature] }}
                aria-hidden="true"
              />
              <button
                type="button"
                className="ops-link"
                onClick={() => onToggle("nature", nature)}
                title={`Filter this page to ${NATURE_LABEL[nature].toLowerCase()} work`}
              >
                {NATURE_LABEL[nature]}
              </button>
            </li>
          ))}
        </ul>
        <HiddenDataTable
          caption="Reactive and planned work by period"
          columns={["Period", "Reactive", "Planned", "Status"]}
          rows={mix.buckets.map((bucket) => [
            bucket.label,
            bucket.reactive,
            bucket.planned,
            bucket.partial ? "In progress" : "Complete",
          ])}
        />
      </div>
    </OpsCard>
  );
}

/* ── 5. Cost ──────────────────────────────────────────────────────────────── */

function CostCard({
  state,
  onNavigateToSites,
  onNavigateToCompliance,
  onToggle,
  onDrill,
}: {
  state: QueryState<CostPayload>;
  onNavigateToSites: (query?: string) => void;
  onNavigateToCompliance: () => void;
  onToggle: (key: string, value: string) => void;
  onDrill: (extra: Record<string, string | string[]>) => void;
}) {
  const [basis, setBasis] = useState<"period" | "annual">("period");

  if (state.error) {
    return (
      <OpsCard title="Cost">
        <ErrorState what={state.error} onRetry={state.reload} />
      </OpsCard>
    );
  }
  if (!state.data) {
    return (
      <OpsCard title="Cost">
        <SkeletonRow lines={5} height={200} />
      </OpsCard>
    );
  }

  const data = state.data;
  const budgeted = data.sites.filter((site) => site.annualBudget !== null);
  const attributionPercent = data.totalSpend
    ? Math.round((data.contractorAttributed / data.totalSpend) * 100)
    : 0;
  const maxContractor = Math.max(...data.contractors.map((row) => row.spend), 1);

  return (
    <OpsCard
      title="Cost"
      subtitle={`${money(data.totalSpend)} recorded across ${plural(data.costedJobs, "job")}`}
      action={
        <div className="ops-actions">
          <button
            type="button"
            className="ops-option"
            aria-pressed={basis === "period"}
            onClick={() => setBasis("period")}
          >
            Period
          </button>
          <button
            type="button"
            className="ops-option"
            aria-pressed={basis === "annual"}
            onClick={() => setBasis("annual")}
          >
            Annual
          </button>
        </div>
      }
    >
      <div>
        <p className="ops-section-title">Spend against budget</p>
        {budgeted.length === 0 ? (
          <EmptyState>
            No site has an annual budget set, so spend cannot be compared with one.{" "}
            <button type="button" className="ops-link" onClick={() => onNavigateToSites()}>
              Set budgets in the sites register
            </button>
          </EmptyState>
        ) : (
          <div className="ops-bars">
            {budgeted.map((site) => {
              const budget = basis === "period" ? site.proRatedBudget : site.annualBudget;
              const utilisation = budget && budget > 0 ? Math.round((site.spend / budget) * 100) : null;
              const tone =
                utilisation === null
                  ? NOT_RECORDED_COLOUR
                  : utilisation > 100
                    ? "#E5484D"
                    : utilisation >= 80
                      ? "#E8A33D"
                      : "#22C55E";
              return (
                <div key={site.siteId} className="ops-bar-row">
                  <button
                    type="button"
                    className="ops-bar"
                    onClick={() => onToggle("site", site.siteId)}
                    title={`Filter this page to ${site.siteName}`}
                  >
                    <span className="ops-bar__label">{site.siteName}</span>
                    <ProgressMeter
                      value={Math.min(utilisation ?? 0, 100)}
                      max={100}
                      tone={tone}
                      label={`${site.siteName}: ${money(site.spend)} against ${money(budget ?? 0)} ${
                        basis === "period" ? "pro-rated" : "annual"
                      }`}
                      height={9}
                    />
                    <span className="ops-bar__value">
                      {utilisation === null ? "No budget" : `${utilisation}%`}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="ops-bar__drill"
                    onClick={() => onDrill({ site: site.siteId })}
                    aria-label={`View the jobs at ${site.siteName}`}
                    title={`View ${site.siteName} jobs`}
                  >
                    <Icon name="chevron" size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {/*
          The like-for-like sentence, spelled out. The card this replaces put
          "Spend is Last 90 days; budgets are annual" in its subtitle and left
          the arithmetic wrong underneath it.
        */}
        <p className="ops-card__note">
          {basis === "period"
            ? `Budgets pro-rated to ${plural(data.periodDays, "day")} — annual budget × ${data.periodDays} ÷ 365.`
            : "Annual budgets shown in full. Spend is for the selected period only, so these are not like for like."}
        </p>
        {data.sitesWithoutBudget > 0 ? (
          <button
            type="button"
            className="ops-link"
            onClick={() => onNavigateToSites("budget=none")}
          >
            {plural(data.sitesWithoutBudget, "site has", "sites have")} no budget set{" "}
            <Icon name="chevron" size={14} />
          </button>
        ) : null}
        {data.unattributedSiteSpend > 0 ? (
          <p className="ops-card__note">
            {money(data.unattributedSiteSpend)} is recorded against jobs with no site in the
            register, and is shown as unattributed rather than assigned to a store.
          </p>
        ) : null}
      </div>

      <div>
        <p className="ops-section-title">Contractor spend</p>
        {/* Coverage first. 87% of cost naming no contractor is the finding; a
            bar chart of the attributed slice alone hides it. */}
        <div className="ops-coverage">
          <p className="ops-headline">
            {money(data.contractorAttributed)} of {money(data.totalSpend)}
          </p>
          <ProgressMeter
            value={data.contractorAttributed}
            max={Math.max(data.totalSpend, 1)}
            tone="#2DD4BF"
            label={`${money(data.contractorAttributed)} of ${money(data.totalSpend)} attributed to a contractor`}
          />
          <span className="ops-coverage__text">
            {attributionPercent}% of recorded cost names a contractor.{" "}
            {money(data.contractorLinked)} of that resolves to a contractor record.
          </span>
        </div>
        <div className="ops-bars" style={{ marginTop: 10 }}>
          {data.contractors.slice(0, 8).map((row) => (
            <div key={row.key} className="ops-bar-row">
              <button
                type="button"
                className="ops-bar"
                onClick={() => onToggle("contractor", row.key)}
                title={`Filter this page to ${row.name}`}
              >
                {/* Names wrap to two lines rather than truncating mid-word. */}
                <span className="ops-bar__label" title={row.name} style={{ whiteSpace: "normal" }}>
                  {row.name}
                  {row.linked ? null : (
                    <StatusChip tone={NOT_RECORDED_COLOUR} size="small" title="No contractor record">
                      Not linked
                    </StatusChip>
                  )}
                </span>
                <ProgressMeter
                  value={row.spend}
                  max={maxContractor}
                  tone="#2DD4BF"
                  label={`${row.name}: ${money(row.spend)} across ${plural(row.jobs, "job")}`}
                  height={9}
                />
                <span className="ops-bar__value">{money(row.spend)}</span>
              </button>
              {/*
                An unlinked contractor filters by the NAME it was typed as, and
                the value carries a `name:` prefix so it cannot collide with a
                contractor id. That is the same key `loadCost` grouped by, so
                the bar and the filtered page count the same jobs.
              */}
              <button
                type="button"
                className="ops-bar__drill"
                onClick={() => onDrill({ contractor: row.key })}
                aria-label={`View the ${plural(row.jobs, "job")} costed to ${row.name}`}
                title={`View ${row.name} jobs`}
              >
                <Icon name="chevron" size={14} />
              </button>
            </div>
          ))}
          {data.contractors.length === 0 ? (
            <EmptyState>No costed job in this period names a contractor.</EmptyState>
          ) : null}
        </div>
        <p className="ops-card__note">
          Spend is the cost recorded on each job, not an invoiced amount. A job with no cost
          recorded contributes nothing.
        </p>
        <HiddenDataTable
          caption="Contractor spend in this period"
          columns={["Contractor", "Spend", "Jobs", "Linked to a record"]}
          rows={data.contractors.map((row) => [
            row.name,
            money(row.spend),
            row.jobs,
            row.linked ? "Yes" : "No",
          ])}
        />
      </div>

      <button type="button" className="ops-link" onClick={onNavigateToCompliance}>
        Open the compliance register <Icon name="chevron" size={14} />
      </button>
    </OpsCard>
  );
}
