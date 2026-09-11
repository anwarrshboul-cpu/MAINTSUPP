"use client";

/**
 * THE SITES LIST — one row per store, operational first.
 *
 * What this replaces was a seven-row label/value card per site: Site, Code,
 * Type, Status, Town, Manager, Actions. Four things were wrong with it and they
 * compounded:
 *
 *   • the cards merged into each other, because the card surface was within a
 *     shade of the page and the gap between them was small;
 *   • seven stacked rows meant one store filled most of a phone screen, so the
 *     portfolio took ten screens to read;
 *   • empty fields still got a full row, rendered as an em dash — and on this
 *     estate Code is empty on 32 of 74 sites, Town on 33 and Postcode on 65, so
 *     most of the height carried nothing;
 *   • it showed REGISTRY data. Type, Code and Town rarely change and are rarely
 *     what anybody opens this page for. Nothing on it said which store had ten
 *     open jobs or which was 25% compliant, both of which the product knows.
 *
 * It answered "what is on Aldgate's record?". This answers "how are my stores
 * doing, and which one needs me?" — a name, one muted line, and the two meters
 * that are the operational payload.
 *
 * ── PLACEHOLDER MANAGERS ARE TREATED AS UNSET ─────────────────────────────
 *
 * `Sample Manager F` is seed data that reached production. It is not printed as
 * a name: `managerDisplay` comes back null for it and the row counts it among
 * the missing details, because somebody phoning a manager who does not exist is
 * worse served than somebody looking at a blank that prompts them to fill it in.
 */

import { useCallback, useMemo, useState } from "react";
import { Icon } from "../../../components";
import opsCss from "./ops.css?url";
import {
  EmptyState,
  OpsCard,
  ProgressMeter,
  SegmentedMeter,
  SkeletonRow,
  StatusChip,
  money,
  plural,
} from "./ops-primitives";
import { OpsFilterBar, type FilterGroup } from "./ops-filter-bar";
import { useQueryState } from "./ops-url-state";
/* 2F — the shared predicate's filter half. The PREDICATE itself is not imported:
   the server sends `demo` on every row, and recomputing it here would be a
   second answer to the question. */
import { parseDemoFilter } from "../../../lib/demo-sites";
import { complianceBandColour } from "../../../lib/compliance-status";
import { NOT_RECORDED_COLOUR } from "../../../lib/job-metrics";
import type { ComplianceState } from "../../../lib/types";

export type SiteMetricsPayload = {
  openJobs: number;
  urgentOpen: number;
  totalJobs: number;
  spend: number;
  compliance: {
    satisfied: number;
    applicable: number;
    notRequired: number;
    total: number;
    percent: number;
    scored: boolean;
    counts: Record<ComplianceState, number>;
  };
};

export type SiteListRow = {
  id: string;
  name: string;
  code: string | null;
  city: string | null;
  postcode: string | null;
  status: string;
  type: string;
  siteTypeValue: string | null;
  latitude: number | null;
  longitude: number | null;
  annualBudgetPence: number | null;
  updatedAt?: string | null;
  metrics?: SiteMetricsPayload | null;
  completeness?: { missing: string[]; complete: boolean };
  managerDisplay?: string | null;
  managerPlaceholder?: boolean;
  /**
   * Every OTHER spelling this site has answered to.
   *
   * Searched alongside the name, because a rename is exactly when somebody
   * cannot find a store: "Cardiff St Davids" is a name this business used, and
   * the alias table exists to make it still find "Grand Arcade - Cardiff".
   * Optional, so a payload without it simply searches nothing extra.
   */
  aliases?: string[];
  mondayMaintenanceName?: string | null;
  mondayComplianceName?: string | null;
  /**
   * 2F — a demonstration store rather than a real one.
   *
   * Sent by the server from `isDemoSite`, never recomputed here. Optional so a
   * payload without it simply has no demo sites, which is the honest reading
   * for a caller that predates the field.
   */
  demo?: boolean;
};

export type SiteCoverage = {
  total: number;
  incomplete: number;
  /** 2F — how many of `total` are demonstration stores. */
  demo?: number;
  placeholderManagers: number;
  withCoordinates: number;
  withTown: number;
  withPostcode: number;
  withCode: number;
  withBudget: number;
};

/** The parameters this list owns. `Clear all` clears exactly these. */
const FILTER_KEYS = [
  "q",
  "status",
  "type",
  "hasJobs",
  "compliance",
  "budget",
  /*
   * 2G — `?details=incomplete`. The header already SAID how many sites had
   * incomplete details and there was no way to see WHICH: a count somebody
   * cannot act on is a count that stays the same for a year. In the URL with
   * every other filter, so "the seven stores with no postcode" is a link
   * somebody sends rather than a thing they re-find.
   */
  "details",
  /* 2F — `?demo=hide|only`. Absent means SHOWN; see `parseDemoFilter`. */
  "demo",
  "sort",
  "layout",
] as const;

const SORTS = [
  { key: "open", label: "Most open jobs" },
  { key: "compliance", label: "Least compliant" },
  { key: "name", label: "Site name (A–Z)" },
  { key: "updated", label: "Recently updated" },
] as const;

export function SitesList({
  sites,
  coverage,
  portfolioCompliance = null,
  loading,
  statuses,
  types,
  statusLabel,
  onOpenSite,
  onEditSite,
  onCloseSite,
  onAddSite,
  headerActions,
  registerView = false,
  renderRegister,
}: {
  sites: SiteListRow[];
  coverage: SiteCoverage | null;
  /**
   * The product's compliance score for the whole register, when the payload
   * carries it — the figure the Overview and the Compliance page print. The
   * tile falls back to summing the per-site meters only when it is absent.
   */
  portfolioCompliance?: { percent: number; satisfied: number; applicable: number; scored: boolean } | null;
  loading: boolean;
  statuses: Array<{ value: string; label: string }>;
  types: Array<{ value: string; label: string }>;
  statusLabel: (value: string) => string;
  onOpenSite: (id: string) => void;
  onEditSite: (site: SiteListRow) => void;
  onCloseSite: (site: SiteListRow) => void;
  onAddSite: () => void;
  headerActions?: React.ReactNode;
  /**
   * Whether the configurable register is the view rather than the row list.
   *
   * Not in the URL, deliberately, and the reasoning is the register's own:
   * `?site=` addresses the DETAIL screen because a site profile is somewhere
   * you send somebody, while which of two renderings of the list you last
   * looked at is not — and the column layout itself, the part worth keeping,
   * already persists server-side in `register_columns`.
   */
  registerView?: boolean;
  /**
   * The register grid, handed the SAME filtered rows the list draws.
   *
   * A render prop rather than a sibling, because the contract is that both
   * views read one filtered set: a register that ignored the search box and
   * the three filters above it would be a second, subtly different answer to
   * the same question. Passing `data.sites` instead would be exactly that.
   */
  renderRegister?: (rows: SiteListRow[]) => React.ReactNode;
}) {
  const { params, setParams } = useQueryState();
  const sort = params.get("sort") ?? "open";
  const layout = params.get("layout") ?? "list";
  const query = (params.get("q") ?? "").trim().toLowerCase();

  const setValue = useCallback(
    (key: string, value: string, fallback: string) => {
      const next = new URLSearchParams(window.location.search);
      if (!value || value === fallback) next.delete(key);
      else next.set(key, value);
      setParams(next);
    },
    [setParams],
  );

  const clearAll = useCallback(() => {
    const next = new URLSearchParams(window.location.search);
    for (const key of FILTER_KEYS) next.delete(key);
    setParams(next);
  }, [setParams]);

  const selectedStatus = params.getAll("status");
  const selectedType = params.getAll("type");
  const hasJobs = params.get("hasJobs");
  const complianceBelow = params.get("compliance");
  const budget = params.get("budget");
  const details = params.get("details");
  const demo = parseDemoFilter(params.get("demo"));

  /*
   * A NAMED SET OF SITES, ARRIVING FROM SOMEWHERE ELSE — §6 of the dashboard
   * brief: "If a destination page does not yet read these filters from the
   * URL, add that filtering to that page so the numbers it shows match the
   * number clicked."
   *
   * The Overview block's "Requiring attention" tile counts DISTINCT SITES with
   * at least one open job that is high or medium priority, or overdue. Nothing
   * on this page could express that, so the tile had nowhere truthful to go: a
   * link to the unfiltered register shows 31 rows under a figure of 7, which is
   * the "list wider than the figure" fault the rest of that block is careful to
   * avoid.
   *
   * `sites` — PLURAL — is deliberately not `site`. That one is already taken:
   * `sites-manager.tsx` reads it to open a single site's DETAIL screen, and a
   * pipe-joined list handed to that would ask for a site whose id is
   * "a|b|c" and open nothing. A separate parameter leaves the deep link that
   * already works exactly as it was.
   */
  const onlySites = useMemo(() => {
    const raw = params.getAll("sites").flatMap((value) => value.split("|"));
    return new Set(raw.map((value) => value.trim()).filter(Boolean));
  }, [params]);

  const visible = useMemo(() => {
    const filtered = sites.filter((site) => {
      if (onlySites.size && !onlySites.has(site.id)) return false;
      if (selectedStatus.length && !selectedStatus.includes(site.status)) return false;
      if (selectedType.length && !selectedType.includes(site.siteTypeValue ?? site.type)) {
        return false;
      }
      const open = site.metrics?.openJobs ?? 0;
      if (hasJobs === "yes" && open === 0) return false;
      if (hasJobs === "no" && open > 0) return false;
      if (complianceBelow) {
        const threshold = Number(complianceBelow);
        const percent = site.metrics?.compliance.scored
          ? site.metrics.compliance.percent
          : 0;
        if (Number.isFinite(threshold) && percent >= threshold) return false;
      }
      if (budget === "none" && site.annualBudgetPence !== null) return false;
      if (budget === "set" && site.annualBudgetPence === null) return false;
      /*
       * 2G. `completeness` absent is treated as COMPLETE rather than as
       * incomplete: a payload that does not carry the field is not evidence
       * that anything is missing, and guessing the other way would fill this
       * list with every site the moment the field was dropped.
       */
      if (details === "incomplete" && (site.completeness?.missing.length ?? 0) === 0) {
        return false;
      }
      if (details === "complete" && (site.completeness?.missing.length ?? 0) > 0) return false;
      /* 2F — one predicate, applied where every other filter is applied. */
      if (demo === "hide" && site.demo) return false;
      if (demo === "only" && !site.demo) return false;
      if (query) {
        const haystack = [
          site.name,
          site.code,
          site.city,
          site.postcode,
          site.managerDisplay,
          site.mondayMaintenanceName,
          site.mondayComplianceName,
          ...(site.aliases ?? []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    const byName = (left: SiteListRow, right: SiteListRow) =>
      left.name.localeCompare(right.name, "en-GB");
    return [...filtered].sort((left, right) => {
      switch (sort) {
        case "compliance": {
          const a = left.metrics?.compliance.scored ? left.metrics.compliance.percent : 101;
          const b = right.metrics?.compliance.scored ? right.metrics.compliance.percent : 101;
          return a - b || byName(left, right);
        }
        case "name":
          return byName(left, right);
        case "updated":
          return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) ||
            byName(left, right);
        default:
          return (
            (right.metrics?.openJobs ?? 0) - (left.metrics?.openJobs ?? 0) || byName(left, right)
          );
      }
    });
  }, [
    budget,
    complianceBelow,
    onlySites,
    demo,
    details,
    hasJobs,
    query,
    selectedStatus,
    selectedType,
    sites,
    sort,
  ]);

  const groups: FilterGroup[] = useMemo(
    () => [
      { key: "status", label: "Status", options: statuses },
      { key: "type", label: "Type", options: types, searchable: true },
    ],
    [statuses, types],
  );

  const chips = useMemo(() => {
    const out: Array<{ key: string; label: string; value: string; onRemove: () => void }> = [];
    const removeFrom = (key: string, value: string) => () => {
      const next = new URLSearchParams(window.location.search);
      const rest = next.getAll(key).filter((entry) => entry !== value);
      next.delete(key);
      for (const entry of rest) next.append(key, entry);
      setParams(next);
    };
    for (const group of groups) {
      for (const value of params.getAll(group.key)) {
        out.push({
          key: group.key,
          label: group.label,
          value: group.options.find((option) => option.value === value)?.label ?? value,
          onRemove: removeFrom(group.key, value),
        });
      }
    }
    if (onlySites.size) {
      out.push({
        key: "sites",
        label: "Sites",
        value: `${onlySites.size} selected`,
        /* Clearing it drops the whole list rather than one id: it arrived as
           one decision from one figure, so it comes off as one. */
        onRemove: () => {
          const next = new URLSearchParams(window.location.search);
          next.delete("sites");
          setParams(next);
        },
      });
    }
    if (hasJobs) {
      out.push({
        key: "hasJobs",
        label: "Open jobs",
        value: hasJobs === "yes" ? "Has open jobs" : "None open",
        onRemove: () => setValue("hasJobs", "", ""),
      });
    }
    if (complianceBelow) {
      out.push({
        key: "compliance",
        label: "Compliance",
        value: `Below ${complianceBelow}%`,
        onRemove: () => setValue("compliance", "", ""),
      });
    }
    if (budget) {
      out.push({
        key: "budget",
        label: "Budget",
        value: budget === "none" ? "No budget set" : "Budget set",
        onRemove: () => setValue("budget", "", ""),
      });
    }
    if (details) {
      out.push({
        key: "details",
        label: "Details",
        value: details === "incomplete" ? "Incomplete" : "Complete",
        onRemove: () => setValue("details", "", ""),
      });
    }
    if (demo !== "all") {
      out.push({
        key: "demo",
        label: "Demo sites",
        value: demo === "hide" ? "Hidden" : "Only demo sites",
        onRemove: () => setValue("demo", "", ""),
      });
    }
    if (query) {
      out.push({
        key: "q",
        label: "Search",
        value: query,
        onRemove: () => setValue("q", "", ""),
      });
    }
    return out;
  }, [
    budget,
    complianceBelow,
    onlySites,
    demo,
    details,
    groups,
    hasJobs,
    params,
    query,
    setParams,
    setValue,
  ]);

  const totals = useMemo(() => {
    const active = sites.filter((site) => site.status !== "closed").length;
    const openJobs = sites.reduce((sum, site) => sum + (site.metrics?.openJobs ?? 0), 0);
    const satisfied = sites.reduce(
      (sum, site) => sum + (site.metrics?.compliance.satisfied ?? 0),
      0,
    );
    const applicable = sites.reduce(
      (sum, site) => sum + (site.metrics?.compliance.applicable ?? 0),
      0,
    );
    return {
      active,
      inactive: sites.length - active,
      openJobs,
      outstanding: sites.filter((site) => (site.metrics?.openJobs ?? 0) > 0).length,
      /* ONE compliance score across the product: the payload's, which is
         `complianceCompletion` over the whole register. Summing the per-site
         meters counted only rows linked to a site and read 45% where the
         Overview and the Compliance page read 23%. */
      compliancePercent: portfolioCompliance
        ? portfolioCompliance.percent
        : applicable
          ? Math.round((satisfied / applicable) * 100)
          : 0,
      complianceScored: portfolioCompliance ? portfolioCompliance.scored : applicable > 0,
    };
  }, [portfolioCompliance, sites]);

  const maxOpen = Math.max(...sites.map((site) => site.metrics?.openJobs ?? 0), 1);

  return (
    <div className="ops-page">
      <link rel="stylesheet" href={opsCss} precedence="default" />

      <header className="ops-page__head">
        <div>
          <span className="ops-page__eyebrow">Property register</span>
          <h1>Sites</h1>
        </div>
        <div className="ops-actions">
          {headerActions}
          <button type="button" className="primary-button" onClick={onAddSite}>
            Add site
          </button>
        </div>
      </header>

      <OpsCard
        title="Portfolio"
        subtitle={`${plural(sites.length, "site")} · ${totals.active} active`}
      >
        <SegmentedMeter
          segments={[
            { key: "active", label: "Active", value: totals.active, colour: "var(--status-green)" },
            { key: "inactive", label: "Inactive", value: totals.inactive, colour: NOT_RECORDED_COLOUR },
          ]}
          height={12}
          label="Sites by status"
        />
        <div className="ops-row__meters">
          {/* Each figure filters the list below, which is what makes the band a
              control rather than decoration. */}
          <button
            type="button"
            className="ops-row__meter ops-tile"
            onClick={() => setValue("hasJobs", "yes", "")}
          >
            <span className="ops-tile__value">{totals.openJobs}</span>
            <span className="ops-tile__label">Open jobs</span>
          </button>
          <div className="ops-row__meter">
            <span className="ops-tile__value">
              {totals.complianceScored ? `${totals.compliancePercent}%` : "—"}
            </span>
            <span className="ops-tile__label">Portfolio compliance</span>
          </div>
          <button
            type="button"
            className="ops-row__meter ops-tile"
            onClick={() => setValue("hasJobs", "yes", "")}
          >
            <span className="ops-tile__value">{totals.outstanding}</span>
            <span className="ops-tile__label">Sites with open work</span>
          </button>
        </div>
        {coverage && coverage.incomplete > 0 ? (
          /*
           * 2G — THE SENTENCE IS NOW THE WAY IN.
           *
           * This said "22 of 74 sites have incomplete details" and stopped
           * there, which told somebody there was work without telling them
           * where it was. The count is a button now: it filters the list to
           * exactly those sites and writes `?details=incomplete`, so the
           * answer is a link rather than a re-derivation.
           *
           * A BUTTON INSIDE THE PARAGRAPH, not a paragraph inside a button —
           * the rest of the sentence is not clickable and must not read as if
           * it were.
           */
          <p className="ops-card__note">
            <button
              type="button"
              className="ops-link"
              aria-pressed={details === "incomplete"}
              onClick={() =>
                setValue("details", details === "incomplete" ? "" : "incomplete", "")
              }
            >
              {coverage.incomplete} of {plural(coverage.total, "site")} have incomplete
              details
            </button>
            {coverage.placeholderManagers > 0
              ? `, and ${coverage.placeholderManagers} carry a placeholder manager name that is treated as unset`
              : ""}
            .
          </p>
        ) : null}
        {coverage && (coverage.demo ?? 0) > 0 ? (
          /*
           * 2F — demo stores are SHOWN by default and offered for hiding, never
           * hidden by default. A list that silently omits rows while the meters
           * above it still count them is a page contradicting itself, and the
           * contradiction is the part nobody notices.
           */
          <p className="ops-card__note">
            {plural(coverage.demo ?? 0, "site")} in this workspace{" "}
            {(coverage.demo ?? 0) === 1 ? "is a demonstration store" : "are demonstration stores"}.{" "}
            <button
              type="button"
              className="ops-link"
              aria-pressed={demo === "hide"}
              onClick={() => setValue("demo", demo === "hide" ? "" : "hide", "")}
            >
              {demo === "hide" ? "Show them" : "Hide them"}
            </button>
          </p>
        ) : null}
        {coverage ? (
          /*
           * MAP VIEW IS DEFERRED, AND THIS IS THE COVERAGE THAT DEFERS IT.
           *
           * Ten UK retail sites plot well and would answer "what is near the
           * engineer today", which no other view can. They cannot be plotted
           * from data that does not exist: on this estate 7 of 74 sites carry
           * coordinates and 9 carry a postcode, so a map would render sixty-five
           * stores in the sea or nowhere at all. The figure is printed rather
           * than the view being quietly absent.
           */
          <p className="ops-card__note">
            Map view is unavailable: {coverage.withCoordinates} of {coverage.total} sites have
            coordinates and {coverage.withPostcode} have a postcode. Add locations to enable it.
          </p>
        ) : null}
      </OpsCard>

      <OpsFilterBar
        periodControl={
          <>
            <label>
              <span className="visually-hidden">Sort sites</span>
              <select value={sort} onChange={(event) => setValue("sort", event.target.value, "open")}>
                {SORTS.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="ops-field" style={{ flex: "1 1 150px", minWidth: 0 }}>
              <span className="visually-hidden">Search sites</span>
              <input
                type="search"
                placeholder={
                  sites.some((site) => (site.aliases?.length ?? 0) > 0)
                    ? "Search name, former name, code, town or manager"
                    : "Search name, code, town or manager"
                }
                defaultValue={params.get("q") ?? ""}
                onChange={(event) => setValue("q", event.target.value.trim(), "")}
              />
            </label>
          </>
        }
        groups={groups}
        extra={
          <>
            <button
              type="button"
              className="ops-option"
              aria-pressed={hasJobs === "yes"}
              onClick={() => setValue("hasJobs", hasJobs === "yes" ? "" : "yes", "")}
            >
              Has open jobs
            </button>
            <button
              type="button"
              className="ops-option"
              aria-pressed={complianceBelow === "80"}
              onClick={() => setValue("compliance", complianceBelow === "80" ? "" : "80", "")}
            >
              Compliance below 80%
            </button>
            <button
              type="button"
              className="ops-option"
              aria-pressed={budget === "none"}
              onClick={() => setValue("budget", budget === "none" ? "" : "none", "")}
            >
              No budget set
            </button>
            <button
              type="button"
              className="ops-option"
              aria-pressed={layout === "grid"}
              onClick={() => setValue("layout", layout === "grid" ? "" : "grid", "list")}
            >
              Grid
            </button>
          </>
        }
        onClearAll={clearAll}
        activeChips={chips}
      />

      {loading ? (
        <div className="ops-rows">
          <SkeletonRow lines={3} height={104} />
          <SkeletonRow lines={3} height={104} />
          <SkeletonRow lines={3} height={104} />
        </div>
      ) : registerView && renderRegister ? (
        /* The configurable register, over the rows the filters left. */
        renderRegister(visible)
      ) : visible.length === 0 ? (
        <OpsCard title="Sites">
          {sites.length === 0 ? (
            <EmptyState>
              No sites yet.{" "}
              <button type="button" className="ops-link" onClick={onAddSite}>
                Add the first one
              </button>
            </EmptyState>
          ) : (
            <>
              <EmptyState>No sites match these filters.</EmptyState>
              <button type="button" className="ops-link" onClick={clearAll}>
                Clear all
              </button>
            </>
          )}
        </OpsCard>
      ) : (
        <div className={layout === "grid" ? "ops-rows ops-grid-3" : "ops-rows"}>
          {visible.map((site) => (
            <SiteRow
              key={site.id}
              site={site}
              maxOpen={maxOpen}
              statusLabel={statusLabel}
              onOpen={() => onOpenSite(site.id)}
              onEdit={() => onEditSite(site)}
              onClose={() => onCloseSite(site)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One site: a name line, a secondary line, and two meters.
 *
 * `Edit` and `Close` are NOT on the row. Ten sites meant twenty buttons
 * competing with the data, and `Close` sitting beside `Edit` at the same visual
 * weight put a state change next to a routine one. Both live in the overflow
 * menu now, and closing asks first.
 */
function SiteRow({
  site,
  maxOpen,
  statusLabel,
  onOpen,
  onEdit,
  onClose,
}: {
  site: SiteListRow;
  maxOpen: number;
  statusLabel: (value: string) => string;
  onOpen: () => void;
  onEdit: () => void;
  onClose: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const metrics = site.metrics;
  const compliance = metrics?.compliance;
  const active = site.status !== "closed";

  /*
   * The secondary line OMITS what is not set. It never prints a dash: an em
   * dash in a value reads as a rendering fault, and three of them in a row read
   * as a broken screen rather than as an unfilled form.
   */
  const parts = [site.siteTypeValue || site.type, site.city, site.managerDisplay].filter(
    (part): part is string => Boolean(part && String(part).trim()),
  );
  const missing = site.completeness?.missing ?? [];

  /*
   * The left edge ranks the row as well as separating it: red for urgent open
   * work or lapsed compliance, amber where compliance is short, neutral
   * otherwise. It is always reinforced by the chip and the meter values, so
   * colour is never carrying the meaning alone.
   */
  const edge =
    (metrics?.urgentOpen ?? 0) > 0 || (compliance?.counts.Expired ?? 0) > 0
      ? "var(--status-red)"
      : compliance?.scored && compliance.percent < 80
        ? "var(--status-yellow)"
        : "var(--line)";

  return (
    <div className="ops-row" style={{ ["--ops-edge" as string]: edge }}>
      <div className="ops-row__top">
        <button
          type="button"
          className="ops-row__name"
          style={{
            background: "transparent",
            border: 0,
            color: "inherit",
            font: "inherit",
            textAlign: "left",
            cursor: "pointer",
            padding: 0,
          }}
          onClick={onOpen}
        >
          {site.name}
        </button>
        <StatusChip
          tone={active ? "var(--status-green)" : NOT_RECORDED_COLOUR}
          size="small"
          title={statusLabel(site.status)}
        >
          {statusLabel(site.status)}
        </StatusChip>
        {site.demo ? (
          /*
           * 2F — LABELLED RATHER THAN HIDDEN.
           *
           * A demonstration store contributes to every meter on this page like
           * any other site, and it should: it has jobs and a compliance profile
           * and quietly excluding it would make the totals disagree with the
           * rows. What it must never do is be mistaken for a real one, so it
           * carries a word. `title` repeats the word rather than abbreviating
           * it, because the chip is small and a tooltip that only restates a
           * truncation helps nobody.
           */
          <StatusChip tone="var(--status-blue)" size="small" title="A demonstration store, not a real one">
            Demo
          </StatusChip>
        ) : null}
        <span className="ops-menu">
          <button
            type="button"
            className="ops-menu__button"
            aria-label={`Actions for ${site.name}`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <Icon name="more" size={16} />
          </button>
          {menuOpen ? (
            <span className="ops-menu__list" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpen();
                }}
              >
                Open site
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onEdit();
                }}
              >
                Edit details
              </button>
              {active ? (
                /*
                 * "Close site", not "Close". The bare word reads as "close this
                 * card", which is what it was mistaken for. It is not renamed to
                 * "Deactivate" because the product's own vocabulary for this
                 * state is CLOSED — `status='closed'`, `lifecycle='Closed'`, the
                 * option table and the Manage-data drawer all say so — and a
                 * button whose word disagrees with the status it writes is a
                 * second name for one state.
                 */
                <button
                  type="button"
                  role="menuitem"
                  className="is-destructive"
                  onClick={() => {
                    setMenuOpen(false);
                    onClose();
                  }}
                >
                  Close site
                </button>
              ) : null}
            </span>
          ) : null}
        </span>
      </div>

      {/*
        ONE muted line, and everything that is not set is absent from it.
        Type, town, manager, then the spend if there is any — joined by a
        separator, never padded with a dash. Three of the six registry fields
        are empty on most of this estate, and an em dash in each of them reads
        as a rendering fault rather than as an unfilled form.
      */}
      <p className="ops-row__secondary">
        {parts.length ? parts.join(" · ") : "No details recorded"}
        {metrics && metrics.spend > 0 ? ` · ${money(metrics.spend)} spent` : ""}
        {missing.length ? (
          <>
            {" · "}
            <button
              type="button"
              className="ops-link ops-row__missing"
              onClick={onEdit}
            >
              {plural(missing.length, "detail")} missing
            </button>
          </>
        ) : null}
      </p>

      <div className="ops-row__meters">
        <div className="ops-row__meter">
          <span className="ops-row__meter-label">
            Open jobs <strong>{metrics ? metrics.openJobs : "—"}</strong>
          </span>
          <ProgressMeter
            value={metrics?.openJobs ?? 0}
            max={maxOpen}
            tone={(metrics?.urgentOpen ?? 0) > 0 ? "var(--status-red)" : "var(--status-blue)"}
            label={
              metrics
                ? `${site.name}: ${plural(metrics.openJobs, "open job")}${
                    metrics.urgentOpen ? `, ${metrics.urgentOpen} urgent` : ""
                  }`
                : `${site.name}: job counts unavailable`
            }
          />
          {metrics && metrics.openJobs === 0 ? (
            <span className="ops-row__meter-label">No jobs</span>
          ) : null}
        </div>
        <div className="ops-row__meter">
          <span className="ops-row__meter-label">
            Compliance{" "}
            <strong>
              {compliance?.scored ? `${compliance.percent}%` : "—"}
            </strong>
          </span>
          <ProgressMeter
            value={compliance?.satisfied ?? 0}
            max={Math.max(compliance?.applicable ?? 0, 1)}
            tone={
              compliance?.scored
                ? complianceBandColour(compliance.percent)
                : NOT_RECORDED_COLOUR
            }
            label={
              compliance?.scored
                ? `${site.name}: ${compliance.satisfied} of ${compliance.applicable} applicable requirements met`
                : `${site.name}: no compliance requirements set`
            }
          />
          {/*
            An unconfigured site is labelled, not scored. It used to look
            identical to a healthy one, which is the more dangerous of the two.
          */}
          {compliance && !compliance.scored ? (
            <span className="ops-row__meter-label">No requirements set</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
