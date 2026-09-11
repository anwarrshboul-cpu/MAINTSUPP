"use client";

/**
 * THE CONTRACTOR REGISTER — one row per contractor, and the link flow.
 *
 * What this replaces was a nine-row label/value card per contractor —
 * Contractor, Contact details, Assigned, Completed, Completion rate, Open
 * urgent, Documents, Spend, Availability — with a 31-column table configurator
 * sitting above it on a phone. Five things were wrong:
 *
 *   • the cards merged, same as Sites and Compliance;
 *   • nine stacked rows meant one contractor per phone screen;
 *   • six of the nine values were zero on every row;
 *   • `Register columns — 9 shown, 22 hidden` was the first thing on a phone
 *     and is desktop table furniture;
 *   • there was no way to add a contractor, no way to filter by area, and no
 *     compact route into a contractor's detail.
 *
 * ── THE ZEROS WERE THE REAL DEFECT ────────────────────────────────────────
 *
 * `Assigned 0` asserts that this contractor has done no work. The register and
 * the job feed were two disconnected sets of identities — free-text names typed
 * onto jobs, and records here — with nothing joining them, so the assertion was
 * false for anybody whose jobs carried a name rather than an id. A zero is
 * therefore only printed where the record is LINKED; where it is not, the row
 * says `Not linked` and offers the mapping flow. That is a statement about the
 * data rather than about the contractor.
 */

import { useCallback, useMemo, useState } from "react";
import { Icon } from "../../../components";
import opsCss from "./ops.css?url";
import {
  EmptyState,
  ErrorState,
  OpsCard,
  ProgressMeter,
  SegmentedMeter,
  SkeletonRow,
  StatusChip,
  money,
  plural,
} from "./ops-primitives";
import { OpsFilterBar, type FilterGroup } from "./ops-filter-bar";
import { useOpsQuery, useQueryState } from "./ops-url-state";
import { NOT_RECORDED_COLOUR } from "../../../lib/job-metrics";

export type ContractorRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  contactName: string | null;
  availability: string;
  active: boolean;
  serviceCategories: string[];
  coverageAreas: string[];
  assignedJobs: number;
  completedJobs: number;
  urgentJobs: number;
  spend: number;
  documentCount?: number;
  insuranceState?: string;
  insuranceStatusLabel?: string;
  /** Whether anything joins this record to work. See the module header. */
  linked?: boolean;
  aliases?: string[];
  contactUnreachable?: boolean;
};

type UnlinkedPayload = {
  names: Array<{
    name: string;
    key: string;
    jobs: number;
    spend: number;
    candidates: Array<{ id: string; name: string }>;
    reason: "none" | "ambiguous";
  }>;
  totalSpend: number;
  unlinkedSpend: number;
  linkedSpend: number;
  distinctUnlinked: number;
};

const FILTER_KEYS = [
  "q",
  "area",
  "trade",
  "avail",
  "openJobs",
  "docs",
  "link",
  "sort",
  "cview",
] as const;

const SORTS = [
  { key: "open", label: "Most open jobs" },
  { key: "spend", label: "Highest spend" },
  { key: "completion", label: "Best completion rate" },
  { key: "name", label: "Name (A–Z)" },
] as const;

const AVAILABILITY_COLOUR: Record<string, string> = {
  Available: "var(--status-green)",
  Busy: "var(--status-yellow)",
  Unavailable: NOT_RECORDED_COLOUR,
};

/** The bucket a contractor with no coverage area falls in. Named, never blank. */
const AREA_NOT_SET = "Area not set";

export function ContractorsList({
  contractors,
  loading,
  error,
  onRetry,
  onOpenDetail,
  onManage,
  onAdd,
  tableView,
  periodControl,
  periodNote,
}: {
  contractors: ContractorRow[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpenDetail: (id: string) => void;
  onManage: (id: string | null) => void;
  onAdd: () => void;
  /** The 31-column configurable register. Desktop only — see the module note. */
  tableView: React.ReactNode;
  /**
   * The window Assigned, Completed and Spend are measured over.
   *
   * It sits ON the filter bar rather than above the page, because it is the one
   * control that changes what the numbers MEAN rather than which rows are
   * shown, and a reader who cannot see it beside the figures reads them as
   * all-time.
   */
  periodControl?: React.ReactNode;
  periodNote?: string;
}) {
  const { params, setParams } = useQueryState();
  const view = params.get("cview") ?? "list";
  const sort = params.get("sort") ?? "open";
  const query = (params.get("q") ?? "").trim().toLowerCase();

  const unlinked = useOpsQuery<UnlinkedPayload>("/api/contractors/unlinked-names", "");

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

  const areas = params.getAll("area");
  const trades = params.getAll("trade");
  const availability = params.getAll("avail");
  const openJobs = params.get("openJobs");
  const docs = params.get("docs");
  const link = params.get("link");

  const options = useMemo(() => {
    const tally = (pick: (row: ContractorRow) => string[]) => {
      const counts = new Map<string, number>();
      for (const row of contractors) {
        const values = pick(row);
        for (const value of values.length ? values : [AREA_NOT_SET]) {
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
      }
      return [...counts]
        .map(([value, count]) => ({ value, label: value, count }))
        .sort((left, right) => left.label.localeCompare(right.label, "en-GB"));
    };
    return {
      areas: tally((row) => row.coverageAreas),
      trades: tally((row) => row.serviceCategories),
      availability: [...new Set(contractors.map((row) => row.availability))].map((value) => ({
        value,
        label: value,
        count: contractors.filter((row) => row.availability === value).length,
      })),
    };
  }, [contractors]);

  const visible = useMemo(() => {
    const filtered = contractors.filter((row) => {
      const rowAreas = row.coverageAreas.length ? row.coverageAreas : [AREA_NOT_SET];
      if (areas.length && !rowAreas.some((area) => areas.includes(area))) return false;
      if (trades.length && !row.serviceCategories.some((trade) => trades.includes(trade))) {
        return false;
      }
      if (availability.length && !availability.includes(row.availability)) return false;
      const open = row.assignedJobs - row.completedJobs;
      if (openJobs === "yes" && open <= 0) return false;
      if (openJobs === "no" && open > 0) return false;
      if (docs === "missing" && (row.documentCount ?? 0) > 0) return false;
      if (docs === "expired" && row.insuranceState !== "expired") return false;
      if (docs === "expiring" && row.insuranceState !== "due-soon") return false;
      if (link === "linked" && row.linked === false) return false;
      if (link === "unlinked" && row.linked !== false) return false;
      if (query) {
        const haystack = [
          row.name,
          row.contactName,
          row.email,
          ...row.serviceCategories,
          ...row.coverageAreas,
          ...(row.aliases ?? []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    const byName = (left: ContractorRow, right: ContractorRow) =>
      left.name.localeCompare(right.name, "en-GB");
    const rate = (row: ContractorRow) =>
      row.assignedJobs > 0 ? row.completedJobs / row.assignedJobs : -1;
    return [...filtered].sort((left, right) => {
      switch (sort) {
        case "spend":
          return right.spend - left.spend || byName(left, right);
        case "completion":
          return rate(right) - rate(left) || byName(left, right);
        case "name":
          return byName(left, right);
        default:
          return (
            right.assignedJobs - right.completedJobs - (left.assignedJobs - left.completedJobs) ||
            byName(left, right)
          );
      }
    });
  }, [areas, availability, contractors, docs, link, openJobs, query, sort, trades]);

  const groups: FilterGroup[] = useMemo(
    () => [
      { key: "area", label: "Area", options: options.areas, searchable: true },
      { key: "trade", label: "Trade", options: options.trades, searchable: true },
      { key: "avail", label: "Availability", options: options.availability },
    ],
    [options],
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
          value,
          onRemove: removeFrom(group.key, value),
        });
      }
    }
    for (const [key, label, value] of [
      ["openJobs", "Open jobs", openJobs],
      ["docs", "Documents", docs],
      ["link", "Linked", link],
      ["q", "Search", query],
    ] as const) {
      if (value) {
        out.push({
          key,
          label,
          value,
          onRemove: () => setValue(key, "", ""),
        });
      }
    }
    return out;
  }, [docs, groups, link, openJobs, params, query, setParams, setValue]);

  /**
   * The availability bar, and why it carries a fourth segment.
   *
   * Three named states plus everything else. A bar drawn from the three alone
   * summed to 65 over a register of 105 on this estate — forty contractors
   * silently absent from a meter that claimed to describe the register. Any
   * value the product does not name lands in `Not recorded`, so the segments
   * always add up to the row count and a value nobody has seen before shows up
   * rather than disappearing.
   */
  const availabilityCounts = useMemo(() => {
    const named = ["Available", "Busy", "Unavailable"];
    const counts = named.map((state) => ({
      key: state,
      label: state,
      value: contractors.filter((row) => row.availability === state).length,
      colour: AVAILABILITY_COLOUR[state] ?? NOT_RECORDED_COLOUR,
    }));
    const other = contractors.filter((row) => !named.includes(row.availability)).length;
    return other > 0
      ? [
          ...counts,
          { key: "other", label: "Not recorded", value: other, colour: NOT_RECORDED_COLOUR },
        ]
      : counts;
  }, [contractors]);

  return (
    <div className="ops-page">
      <link rel="stylesheet" href={opsCss} precedence="default" />

      <header className="ops-page__head">
        <div>
          <span className="ops-page__eyebrow">Supply chain</span>
          <h1>Contractors</h1>
        </div>
        <div className="ops-actions">
          {(
            [
              ["list", "List"],
              ["area", "By area"],
              ["table", "All columns"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="ops-option"
              aria-pressed={view === key}
              onClick={() => setValue("cview", key, "list")}
            >
              {label}
            </button>
          ))}
          <button type="button" className="primary-button" onClick={onAdd}>
            Add contractor
          </button>
        </div>
      </header>

      <OpsCard title="Register" subtitle={`${plural(contractors.length, "contractor")}`}>
        <SegmentedMeter
          segments={availabilityCounts}
          height={12}
          label="Contractors by availability"
        />
        <ul className="ops-legend">
          {availabilityCounts.map((entry) => (
            <li key={entry.key}>
              <span className="ops-swatch" style={{ background: entry.colour }} aria-hidden="true" />
              {entry.label} <strong>{entry.value}</strong>
            </li>
          ))}
        </ul>
        {unlinked.data ? (
          <p className="ops-card__note">
            {money(unlinked.data.linkedSpend)} of {money(unlinked.data.totalSpend)} recorded cost
            resolves to a contractor record.{" "}
            {unlinked.data.distinctUnlinked > 0 ? (
              <button
                type="button"
                className="ops-link"
                onClick={() => setValue("cview", "link", "list")}
              >
                {money(unlinked.data.unlinkedSpend)} across{" "}
                {plural(unlinked.data.distinctUnlinked, "unmatched name")} — link them
              </button>
            ) : (
              "Every job-side contractor name resolves to a record."
            )}
          </p>
        ) : null}
      </OpsCard>

      <OpsFilterBar
        periodControl={
          <>
            {periodControl}
            <label>
              <span className="visually-hidden">Sort contractors</span>
              <select value={sort} onChange={(event) => setValue("sort", event.target.value, "open")}>
                {SORTS.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="ops-field" style={{ flex: "1 1 150px", minWidth: 0 }}>
              <span className="visually-hidden">Search contractors</span>
              <input
                type="search"
                placeholder="Search name, trade, area or contact"
                defaultValue={params.get("q") ?? ""}
                onChange={(event) => setValue("q", event.target.value.trim(), "")}
              />
            </label>
            {periodNote ? <span className="ops-card__note">{periodNote}</span> : null}
          </>
        }
        groups={groups}
        extra={
          <>
            <button
              type="button"
              className="ops-option"
              aria-pressed={openJobs === "yes"}
              onClick={() => setValue("openJobs", openJobs === "yes" ? "" : "yes", "")}
            >
              Has open jobs
            </button>
            <button
              type="button"
              className="ops-option"
              aria-pressed={docs === "expired"}
              onClick={() => setValue("docs", docs === "expired" ? "" : "expired", "")}
            >
              Expired documents
            </button>
            <button
              type="button"
              className="ops-option"
              aria-pressed={link === "unlinked"}
              onClick={() => setValue("link", link === "unlinked" ? "" : "unlinked", "")}
            >
              Not linked
            </button>
          </>
        }
        onClearAll={clearAll}
        activeChips={chips}
      />

      {view === "link" ? (
        <LinkContractorPanel
          state={unlinked}
          contractors={contractors}
          onDone={() => {
            unlinked.reload();
            onRetry();
          }}
          onBack={() => setValue("cview", "list", "list")}
        />
      ) : error ? (
        <OpsCard title="Contractors">
          <ErrorState what={error} onRetry={onRetry} />
        </OpsCard>
      ) : loading ? (
        <div className="ops-rows">
          <SkeletonRow lines={3} height={100} />
          <SkeletonRow lines={3} height={100} />
          <SkeletonRow lines={3} height={100} />
        </div>
      ) : view === "table" ? (
        <OpsCard title="All columns">
          {/* Column configuration is desktop table furniture. On a phone it was
              the first thing on screen and never the thing anybody came for. */}
          <p className="ops-card__note ops-hide-desktop">
            The full register needs a wider screen. Switch to List on a phone.
          </p>
          <div className="ops-table-wrap">{tableView}</div>
        </OpsCard>
      ) : visible.length === 0 ? (
        <OpsCard title="Contractors">
          {contractors.length === 0 ? (
            <EmptyState>
              No contractors yet.{" "}
              <button type="button" className="ops-link" onClick={onAdd}>
                Add the first one
              </button>
            </EmptyState>
          ) : (
            <>
              <EmptyState>No contractors match these filters.</EmptyState>
              <button type="button" className="ops-link" onClick={clearAll}>
                Clear all
              </button>
            </>
          )}
        </OpsCard>
      ) : view === "area" ? (
        <ByArea rows={visible} onOpenDetail={onOpenDetail} onManage={onManage} />
      ) : (
        <div className="ops-rows">
          {visible.map((row) => (
            <ContractorRowView
              key={row.id}
              row={row}
              onOpenDetail={() => onOpenDetail(row.id)}
              onManage={() => onManage(row.id)}
              onLink={() => setValue("cview", "link", "list")}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── One contractor ───────────────────────────────────────────────────────── */

function ContractorRowView({
  row,
  onOpenDetail,
  onManage,
  onLink,
}: {
  row: ContractorRow;
  onOpenDetail: () => void;
  onManage: () => void;
  onLink: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const open = Math.max(0, row.assignedJobs - row.completedJobs);
  const completion =
    row.assignedJobs > 0 ? Math.round((row.completedJobs / row.assignedJobs) * 100) : null;
  const expired = row.insuranceState === "expired";

  /* Trade, then coverage areas. Unset fields are OMITTED, never rendered as a
     dash — the same rule the site row follows and for the same reason. */
  const secondary = [
    row.serviceCategories.join(", "),
    row.coverageAreas.join(", "),
  ].filter((part) => part.trim());

  return (
    <div
      className="ops-row"
      style={{
        ["--ops-edge" as string]: expired
          ? "var(--status-red)"
          : AVAILABILITY_COLOUR[row.availability] ?? NOT_RECORDED_COLOUR,
      }}
    >
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
          onClick={onOpenDetail}
        >
          {row.name}
        </button>
        {row.active ? null : (
          <StatusChip tone={NOT_RECORDED_COLOUR} size="small" title="Off the register">
            Archived
          </StatusChip>
        )}
        <StatusChip
          tone={AVAILABILITY_COLOUR[row.availability] ?? NOT_RECORDED_COLOUR}
          size="small"
        >
          {row.availability}
        </StatusChip>
        <span className="ops-menu">
          <button
            type="button"
            className="ops-menu__button"
            aria-label={`Actions for ${row.name}`}
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
                  onManage();
                }}
              >
                Edit details
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onLink();
                }}
              >
                Link job names
              </button>
            </span>
          ) : null}
        </span>
      </div>

      <p className="ops-row__secondary">
        {secondary.length ? secondary.join(" · ") : "No trade or coverage area recorded"}
        {/*
          `.example` and the other reserved TLDs cannot receive mail. The
          address is not shown as though it worked; the row says what is
          actually true and offers the edit that fixes it.
        */}
        {row.contactUnreachable ? (
          <>
            {" · "}
            <button type="button" className="ops-link ops-row__missing" onClick={onManage}>
              No contact set
            </button>
          </>
        ) : null}
        {expired ? (
          <>
            {" · "}
            <span className="ops-row__missing">
              {row.insuranceStatusLabel ?? "Insurance expired"}
            </span>
          </>
        ) : null}
      </p>

      {/*
        THE METRICS LINE, and the Details button on it.

        Text with one inline meter, not three meter blocks. The brief asks for
        "open jobs, completion rate, spend, shown as text with small inline
        meters where a proportion is meaningful", and the reason is the row
        height: three stacked meters took this row to 180px, so six contractors
        no longer fit on a phone screen — which is the measurement the layout is
        chosen against. Completion is the only one of the three that IS a
        proportion; a count and a sum are figures.
      */}
      {row.linked === false ? (
        /*
         * NOT A ZERO. Nothing joins this record to any work, so every
         * operational figure would be an assertion the data cannot support.
         */
        <div className="ops-row__metrics">
          <StatusChip tone={NOT_RECORDED_COLOUR} size="small" title="No job resolves to this record">
            Not linked
          </StatusChip>
          <button type="button" className="ops-link" onClick={onLink}>
            Map the job names
          </button>
          <button
            type="button"
            className="ops-details-button"
            onClick={onOpenDetail}
            aria-label={`Details for ${row.name}`}
          >
            Details <Icon name="chevron" size={13} />
          </button>
        </div>
      ) : (
        <div className="ops-row__metrics">
          {/*
            "2 open", not "2 open jobs · 1 urgent".
            The line has to hold four things and a button at 390px, and the
            urgency is already carried twice over — by the red left edge and by
            the meter's own accessible sentence — so spending a third of the
            width restating it pushed the line onto a second row and the row
            past the height six contractors need to fit on a screen.
          */}
          <span title={row.urgentJobs > 0 ? `${row.urgentJobs} urgent` : undefined}>
            {open} open
            {row.urgentJobs > 0 ? <strong> ({row.urgentJobs} urgent)</strong> : null}
          </span>
          <div className="ops-row__metrics-meter">
            <ProgressMeter
              value={row.completedJobs}
              max={Math.max(row.assignedJobs, 1)}
              tone="var(--status-green)"
              height={6}
              label={`${row.name}: ${row.completedJobs} of ${row.assignedJobs} jobs completed`}
            />
            <span>{completion === null ? "—" : `${completion}%`}</span>
          </div>
          <span>{money(row.spend)}</span>
          {/* A real button with the contractor's name in its accessible name,
              not a bare chevron — the explicit affordance beside a row that is
              also tappable in full. */}
          <button
            type="button"
            className="ops-details-button"
            onClick={onOpenDetail}
            aria-label={`Details for ${row.name}`}
          >
            Details <Icon name="chevron" size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

/* ── By area ──────────────────────────────────────────────────────────────── */

/**
 * Grouped under coverage area, so "who covers Cardiff?" is one look.
 *
 * Contractors with no area set group under a NAMED bucket rather than
 * disappearing, and the count on that group is the thing an operator has to
 * fix — it is the reason the area filter is thin on this estate.
 */
function ByArea({
  rows,
  onOpenDetail,
  onManage,
}: {
  rows: ContractorRow[];
  onOpenDetail: (id: string) => void;
  onManage: (id: string | null) => void;
}) {
  const { params, setParams } = useQueryState();
  const open = params.getAll("open");

  const grouped = useMemo(() => {
    const map = new Map<string, ContractorRow[]>();
    for (const row of rows) {
      for (const area of row.coverageAreas.length ? row.coverageAreas : [AREA_NOT_SET]) {
        const list = map.get(area);
        if (list) list.push(row);
        else map.set(area, [row]);
      }
    }
    return [...map].sort(([left], [right]) => {
      if (left === AREA_NOT_SET) return 1;
      if (right === AREA_NOT_SET) return -1;
      return left.localeCompare(right, "en-GB");
    });
  }, [rows]);

  const toggle = (area: string) => {
    const next = new URLSearchParams(window.location.search);
    const existing = next.getAll("open");
    const updated = existing.includes(area)
      ? existing.filter((entry) => entry !== area)
      : [...existing, area];
    next.delete("open");
    for (const entry of updated) next.append("open", entry);
    setParams(next);
  };

  return (
    <div className="ops-rows">
      {grouped.map(([area, members]) => (
        <section key={area} className="ops-group">
          {/* `<h3><button></button></h3>` — see the note on the compliance
              register's group header for why the heading wraps the control. */}
          <h3 className="ops-group__heading">
            <button
              type="button"
              className="ops-group__head"
              aria-expanded={open.includes(area)}
              onClick={() => toggle(area)}
            >
              <span className="ops-group__title">
                <span className="ops-group__name">{area}</span>
                <span className="ops-group__count">{plural(members.length, "contractor")}</span>
                <Icon name="chevron" size={16} />
              </span>
            </button>
          </h3>
          {open.includes(area) ? (
            <div className="ops-group__body">
              {members.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="ops-record"
                  onClick={() => onOpenDetail(row.id)}
                >
                  <span className="ops-record__top">
                    <span className="ops-record__name">{row.name}</span>
                    <StatusChip
                      tone={AVAILABILITY_COLOUR[row.availability] ?? NOT_RECORDED_COLOUR}
                      size="small"
                    >
                      {row.availability}
                    </StatusChip>
                  </span>
                  <span className="ops-record__meta">
                    {row.serviceCategories.join(", ") || "No trade recorded"}
                    {row.linked === false ? " · Not linked" : ` · ${money(row.spend)}`}
                  </span>
                </button>
              ))}
              {area === AREA_NOT_SET ? (
                <p className="ops-card__note">
                  These contractors have no coverage area recorded, so the area filter cannot
                  find them.{" "}
                  <button type="button" className="ops-link" onClick={() => onManage(null)}>
                    Set their areas
                  </button>
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

/* ── Link contractor ──────────────────────────────────────────────────────── */

/**
 * The mapping flow — the fix for the register's zero columns.
 *
 * Each unmatched job-side string is shown with the work and the money behind it,
 * and a picker that writes an alias row. `ambiguous` is called out separately
 * because it is a different problem: two register records share that name, so
 * the attribution rule refuses it on purpose rather than double-counting the
 * money, and the operator has to say which record is meant.
 */
function LinkContractorPanel({
  state,
  contractors,
  onDone,
  onBack,
}: {
  state: { data: UnlinkedPayload | null; loading: boolean; error: string | null; reload: () => void };
  contractors: ContractorRow[];
  onDone: () => void;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const link = async (alias: string, contractorId: string) => {
    if (!contractorId) return;
    setBusy(alias);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/contractors/${encodeURIComponent(contractorId)}/aliases`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ alias }),
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!response.ok || !payload?.ok) {
        setMessage(payload?.error ?? "The mapping could not be saved.");
        return;
      }
      setMessage(`"${alias}" is now linked.`);
      onDone();
    } finally {
      setBusy(null);
    }
  };

  return (
    <OpsCard
      title="Link job names to contractors"
      subtitle="Every name typed onto a job that resolves to no single record"
      action={
        <button type="button" className="ops-link" onClick={onBack}>
          Back to the register
        </button>
      }
    >
      {state.error ? (
        <ErrorState what={state.error} onRetry={state.reload} />
      ) : !state.data ? (
        <SkeletonRow lines={4} height={140} />
      ) : state.data.names.length === 0 ? (
        <EmptyState>
          Every contractor name on a job resolves to a record. Nothing to link.
        </EmptyState>
      ) : (
        <>
          <p className="ops-card__note">
            {money(state.data.unlinkedSpend)} of {money(state.data.totalSpend)} recorded cost sits
            behind {plural(state.data.names.length, "unmatched name")}. Until a name is mapped, the
            register shows those contractors as not linked rather than as having done no work.
          </p>
          {message ? (
            <p className="ops-card__note" role="status">
              {message}
            </p>
          ) : null}
          {state.data.names.map((entry) => (
            <LinkRow
              key={entry.key}
              entry={entry}
              contractors={contractors}
              busy={busy === entry.name}
              onLink={(contractorId) => void link(entry.name, contractorId)}
            />
          ))}
        </>
      )}
    </OpsCard>
  );
}

function LinkRow({
  entry,
  contractors,
  busy,
  onLink,
}: {
  entry: UnlinkedPayload["names"][number];
  contractors: ContractorRow[];
  busy: boolean;
  onLink: (contractorId: string) => void;
}) {
  /*
   * The candidates first, then everybody else.
   *
   * Where the register already holds rows of this exact name, those are what
   * the operator almost certainly means; putting them at the top of the picker
   * turns a scroll through 112 records into one tap. The rest are still there,
   * because an operator renaming a firm needs to reach a record that no longer
   * shares the string.
   */
  const [choice, setChoice] = useState(entry.candidates[0]?.id ?? "");
  const rest = contractors.filter(
    (row) => !entry.candidates.some((candidate) => candidate.id === row.id),
  );

  return (
    <div className="ops-record">
      <span className="ops-record__top">
        <span className="ops-record__name">{entry.name}</span>
        <StatusChip
          tone={entry.reason === "ambiguous" ? "var(--status-yellow)" : NOT_RECORDED_COLOUR}
          size="small"
          title={
            entry.reason === "ambiguous"
              ? "More than one register record answers to this name, so it is attributed to neither"
              : "No register record answers to this name"
          }
        >
          {entry.reason === "ambiguous" ? "Ambiguous" : "No record"}
        </StatusChip>
      </span>
      <span className="ops-record__meta">
        {plural(entry.jobs, "job")} · {money(entry.spend)}
        {entry.reason === "ambiguous"
          ? ` · ${plural(entry.candidates.length, "record")} share this name`
          : ""}
      </span>
      <span className="ops-actions">
        <label className="ops-field" style={{ flex: "1 1 200px", minWidth: 0 }}>
          <span className="visually-hidden">Contractor for {entry.name}</span>
          <select value={choice} onChange={(event) => setChoice(event.target.value)}>
            <option value="">Choose a contractor…</option>
            {entry.candidates.length ? (
              <optgroup label="Same name on the register">
                {entry.candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} ({candidate.id.slice(-8)})
                  </option>
                ))}
              </optgroup>
            ) : null}
            <optgroup label="Every contractor">
              {rest.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !choice}
          onClick={() => onLink(choice)}
        >
          {busy ? "Linking…" : "Link"}
        </button>
      </span>
    </div>
  );
}
