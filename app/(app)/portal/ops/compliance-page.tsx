"use client";

/**
 * THE COMPLIANCE REGISTER — a site-grouped accordion, not a flat list.
 *
 * What this replaces rendered 750 records as one continuous, ungrouped list of
 * six-row label/value cards. Four things were wrong with it and they compounded:
 *
 *   • no grouping, so every site's records ran into the next one's;
 *   • the site name repeated on all 12 records of every store — the most
 *     prominent field on the card, carrying almost no information because it
 *     only changes once every twelve rows;
 *   • the cards visually merged, because the card surface was within a shade of
 *     the page behind it;
 *   • six stacked rows per record, so one certificate took a third of a phone
 *     screen and a store's position took eleven screens of scrolling.
 *
 * It answered "what is record 214?". This answers "which stores are compliant,
 * and what is missing where?" — ten collapsed groups in roughly two phone
 * screens, each carrying its own meter.
 *
 * ── THE COLLAPSED VIEW COSTS ONE REQUEST AND NO RECORDS ───────────────────
 *
 * `/api/compliance/summary` returns the portfolio meter and every group header.
 * Records arrive from `/api/compliance/records` only for groups that are open.
 * Nothing fetches 750 rows to draw 22 headers.
 *
 * ── EXPANSION LIVES IN THE URL ────────────────────────────────────────────
 *
 * `?open=store-aldgate`, repeated. A specific store's register is a link
 * somebody sends, and more than one may be open at once.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Icon } from "../../../components";
import opsCss from "./ops.css?url";
import {
  EmptyState,
  ErrorState,
  HiddenDataTable,
  OpsCard,
  ProgressMeter,
  SegmentedMeter,
  SkeletonRow,
  StatusChip,
  downloadCsv,
  plural,
} from "./ops-primitives";
import { OpsFilterBar, type FilterGroup } from "./ops-filter-bar";
import { useOpsQuery, useQueryState } from "./ops-url-state";
import {
  COMPLIANCE_COLOUR,
  COMPLIANCE_MEANING,
  NO_DUE_DATE,
  complianceBandColour,
  type ComplianceState,
} from "../../../lib/compliance-status";
import { formatDate } from "../../../lib/format-date";

type Completion = {
  satisfied: number;
  applicable: number;
  notRequired: number;
  total: number;
  percent: number;
  scored: boolean;
  counts: Record<ComplianceState, number>;
};

type Group = {
  siteId: string;
  siteName: string;
  completion: Completion;
  outstanding: number;
  noDueDate: number;
  expiringSoon: number;
  expired: number;
  missing: number;
  total: number;
  soonestDue: string | null;
};

type Option = { value: string; label: string; count: number };

type SummaryPayload = {
  portfolio: {
    counts: Record<ComplianceState, number>;
    completion: Completion;
    noDueDate: number;
    sites: number;
    total: number;
  };
  registerTotal: number;
  registerSites: number;
  noDueDateTotal: number;
  groups: Group[];
  sorts: ReadonlyArray<{ key: string; label: string }>;
  dueWindows: ReadonlyArray<{ key: string; label: string }>;
  expiryWindowDays: number;
  options: {
    sites: Option[];
    kinds: Option[];
    responsibilities: Option[];
    states: Option[];
  };
};

type Record_ = {
  id: string;
  siteId: string;
  siteName: string;
  kind: string;
  responsibility: string;
  state: ComplianceState;
  expiry: string | null;
  fileCount: number;
  editable: boolean;
};

type RecordsPayload = {
  group: "site" | "kind";
  total: number;
  records: Record_[];
  noDueDateLabel: string;
};

const FILTER_KEYS = ["site", "state", "kind", "who", "due", "q", "sort", "view", "open"] as const;

const STATE_ORDER: ComplianceState[] = [
  "Compliant",
  "Expiring soon",
  "Expired",
  "Missing",
  "Not required",
];

/** How many records a group shows before `Show all`. */
const FIRST_PAGE = 15;

export function CompliancePage({
  onOpenStoreDocumentation,
  onManageRecord,
  raiseAction,
}: {
  onOpenStoreDocumentation: () => void;
  onManageRecord: (id: string | null) => void;
  /** Raise a job against a lapsed certificate, from the screen that reports it. */
  raiseAction?: ReactNode;
}) {
  const { params, setParams, search } = useQueryState();
  const view = params.get("view") ?? "site";
  const sort = params.get("sort") ?? "outstanding";
  const open = params.getAll("open");

  const summary = useOpsQuery<SummaryPayload>("/api/compliance/summary", search);

  const setValue = useCallback(
    (key: string, value: string, fallback: string) => {
      const next = new URLSearchParams(window.location.search);
      if (!value || value === fallback) next.delete(key);
      else next.set(key, value);
      setParams(next);
    },
    [setParams],
  );

  const toggleOpen = useCallback(
    (key: string) => {
      const next = new URLSearchParams(window.location.search);
      const existing = next.getAll("open");
      const updated = existing.includes(key)
        ? existing.filter((entry) => entry !== key)
        : [...existing, key];
      next.delete("open");
      for (const entry of updated) next.append("open", entry);
      setParams(next);
    },
    [setParams],
  );

  const clearAll = useCallback(() => {
    const next = new URLSearchParams(window.location.search);
    for (const key of FILTER_KEYS) next.delete(key);
    setParams(next);
  }, [setParams]);

  /**
   * The two questions actually asked of this page, as one tap each.
   *
   * `Missing only` and `Due in 30 days` are presets over the same filter state,
   * so they show up as chips like anything else and can be taken off the same
   * way. A quick action that set hidden state would be a filter the reader
   * cannot see or undo.
   */
  const applyPreset = useCallback(
    (preset: "missing" | "due") => {
      const next = new URLSearchParams(window.location.search);
      next.delete("state");
      next.delete("due");
      if (preset === "missing") next.append("state", "Missing");
      else {
        next.append("due", "overdue");
        next.append("due", "30");
      }
      setParams(next);
    },
    [setParams],
  );

  const groups: FilterGroup[] = useMemo(() => {
    const data = summary.data;
    if (!data) return [];
    return [
      { key: "state", label: "Status", options: data.options.states },
      { key: "site", label: "Site", options: data.options.sites, searchable: true },
      { key: "kind", label: "Requirement", options: data.options.kinds, searchable: true },
      {
        key: "who",
        label: "Responsibility",
        options: data.options.responsibilities,
        searchable: true,
      },
      {
        key: "due",
        label: "Due window",
        options: data.dueWindows.map((window) => ({ value: window.key, label: window.label })),
      },
    ];
  }, [summary.data]);

  const chips = useMemo(() => {
    const out: Array<{ key: string; label: string; value: string; onRemove: () => void }> = [];
    for (const group of groups) {
      for (const value of params.getAll(group.key)) {
        out.push({
          key: group.key,
          label: group.label,
          value: group.options.find((option) => option.value === value)?.label ?? value,
          onRemove: () => {
            const next = new URLSearchParams(window.location.search);
            const rest = next.getAll(group.key).filter((entry) => entry !== value);
            next.delete(group.key);
            for (const entry of rest) next.append(group.key, entry);
            setParams(next);
          },
        });
      }
    }
    const query = params.get("q");
    if (query) {
      out.push({
        key: "q",
        label: "Search",
        value: query,
        onRemove: () => setValue("q", "", ""),
      });
    }
    return out;
  }, [groups, params, setParams, setValue]);

  return (
    <div className="ops-page">
      <link rel="stylesheet" href={opsCss} precedence="default" />

      <header className="ops-page__head">
        <div>
          <span className="ops-page__eyebrow">Portfolio assurance</span>
          <h1>Compliance</h1>
        </div>
        <div className="ops-actions">
          {raiseAction}
          <ExportButton search={search} />
          {(
            [
              ["site", "By site"],
              ["kind", "By requirement"],
              ["all", "All records"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="ops-option"
              aria-pressed={view === key}
              onClick={() => setValue("view", key, "site")}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <PortfolioBand state={summary} />

      <OpsFilterBar
        periodControl={
          <>
            <label>
              <span className="visually-hidden">Sort site groups</span>
              <select value={sort} onChange={(event) => setValue("sort", event.target.value, "outstanding")}>
                {(summary.data?.sorts ?? [{ key: "outstanding", label: "Most outstanding" }]).map(
                  (entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.label}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label className="ops-field" style={{ flex: "1 1 160px", minWidth: 0 }}>
              <span className="visually-hidden">Search the register</span>
              <input
                type="search"
                placeholder="Search requirement or site"
                defaultValue={params.get("q") ?? ""}
                onChange={(event) => setValue("q", event.target.value.trim(), "")}
              />
            </label>
          </>
        }
        groups={groups}
        extra={
          <>
            <button type="button" className="ops-option" onClick={() => applyPreset("missing")}>
              Missing only
            </button>
            <button type="button" className="ops-option" onClick={() => applyPreset("due")}>
              Due in 30 days
            </button>
          </>
        }
        onClearAll={clearAll}
        activeChips={chips}
      />

      {summary.error ? (
        <OpsCard title="Certificate register">
          <ErrorState what={summary.error} onRetry={summary.reload} />
        </OpsCard>
      ) : !summary.data ? (
        <div className="ops-rows">
          <SkeletonRow lines={3} height={96} />
          <SkeletonRow lines={3} height={96} />
          <SkeletonRow lines={3} height={96} />
        </div>
      ) : summary.data.registerTotal === 0 ? (
        <OpsCard title="Certificate register">
          <EmptyState>
            No compliance requirements are set up yet.{" "}
            <button type="button" className="ops-link" onClick={onOpenStoreDocumentation}>
              Open Store Documentation to add them
            </button>
          </EmptyState>
        </OpsCard>
      ) : summary.data.groups.length === 0 ? (
        <OpsCard title="Certificate register">
          <EmptyState>No records match these filters.</EmptyState>
          <button type="button" className="ops-link" onClick={clearAll}>
            Clear all
          </button>
        </OpsCard>
      ) : view === "kind" ? (
        <ByRequirement summary={summary.data} search={search} open={open} onToggle={toggleOpen} />
      ) : view === "all" ? (
        <AllRecords search={search} onManageRecord={onManageRecord} />
      ) : (
        <div className="ops-rows">
          {summary.data.groups.map((group) => (
            <SiteGroup
              key={group.siteId}
              group={group}
              expanded={open.includes(group.siteId)}
              onToggle={() => toggleOpen(group.siteId)}
              search={search}
              expiryWindowDays={summary.data!.expiryWindowDays}
              onManageRecord={onManageRecord}
              onOpenStoreDocumentation={onOpenStoreDocumentation}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Portfolio band ───────────────────────────────────────────────────────── */

function PortfolioBand({
  state,
}: {
  state: { data: SummaryPayload | null; loading: boolean; error: string | null; reload: () => void };
}) {
  if (state.error || !state.data) {
    return (
      <OpsCard title="Portfolio">
        {state.error ? (
          <ErrorState what={state.error} onRetry={state.reload} />
        ) : (
          <SkeletonRow lines={2} height={70} />
        )}
      </OpsCard>
    );
  }

  const { portfolio, registerTotal, registerSites, noDueDateTotal } = state.data;
  const filtered = portfolio.total !== registerTotal;

  return (
    <OpsCard
      title="Portfolio"
      subtitle={
        filtered
          ? `${portfolio.total} of ${plural(registerTotal, "record")} shown`
          : `${plural(registerSites, "site")} · ${plural(registerTotal, "requirement")}`
      }
    >
      <SegmentedMeter
        segments={STATE_ORDER.map((state_) => ({
          key: state_,
          label: state_,
          value: portfolio.counts[state_] ?? 0,
          colour: COMPLIANCE_COLOUR[state_],
        }))}
        height={14}
        label="Compliance records by status"
      />
      <ul className="ops-legend">
        {STATE_ORDER.map((state_) => (
          <li key={state_}>
            <span
              className="ops-swatch"
              style={{ background: COMPLIANCE_COLOUR[state_] }}
              aria-hidden="true"
            />
            {state_} <strong>{portfolio.counts[state_] ?? 0}</strong>
          </li>
        ))}
      </ul>
      <div className="ops-row__meters">
        <div className="ops-row__meter">
          <span className="ops-row__meter-label">
            Sites <strong>{portfolio.sites}</strong>
          </span>
        </div>
        <div className="ops-row__meter">
          <span className="ops-row__meter-label">
            Requirements <strong>{portfolio.total}</strong>
          </span>
        </div>
        <div className="ops-row__meter">
          <span className="ops-row__meter-label">
            Complete{" "}
            <strong>
              {portfolio.completion.scored ? `${portfolio.completion.percent}%` : "—"}
            </strong>
          </span>
          <ProgressMeter
            value={portfolio.completion.satisfied}
            max={Math.max(portfolio.completion.applicable, 1)}
            tone={complianceBandColour(portfolio.completion.percent)}
            label={`${portfolio.completion.satisfied} of ${portfolio.completion.applicable} applicable requirements met`}
          />
        </div>
      </div>
      {/*
        The no-due-date figure, in the header rather than left to distort the
        status column silently. On this estate it is the single biggest fact
        about the register.
      */}
      {noDueDateTotal > 0 ? (
        <p className="ops-card__note">
          {noDueDateTotal} of {plural(registerTotal, "record")} have no due date, so the
          valid / expiring / expired distinction cannot be computed for them.
        </p>
      ) : null}
      {portfolio.completion.notRequired > 0 ? (
        <p className="ops-card__note">
          {portfolio.completion.notRequired} marked not required, and outside the percentage on
          both sides.
        </p>
      ) : null}
      <HiddenDataTable
        caption="Compliance records by status"
        columns={["Status", "Records"]}
        rows={STATE_ORDER.map((state_) => [state_, portfolio.counts[state_] ?? 0])}
      />
    </OpsCard>
  );
}

/* ── One site group ───────────────────────────────────────────────────────── */

function SiteGroup({
  group,
  expanded,
  onToggle,
  search,
  expiryWindowDays,
  onManageRecord,
  onOpenStoreDocumentation,
}: {
  group: Group;
  expanded: boolean;
  onToggle: () => void;
  search: string;
  expiryWindowDays: number;
  onManageRecord: (id: string | null) => void;
  onOpenStoreDocumentation: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const records = useOpsQuery<RecordsPayload>(
    `/api/compliance/records?group=site&key=${encodeURIComponent(group.siteId)}`,
    search,
    { enabled: expanded },
  );

  /*
   * The action line names only the states that need action, and omits a zero.
   * "0 expired" beside "11 missing" reads as two problems; it is one.
   */
  const actions = [
    group.missing ? `${group.missing} missing` : null,
    group.expired ? `${group.expired} expired` : null,
    group.expiringSoon ? `${group.expiringSoon} expiring within ${expiryWindowDays} days` : null,
    group.noDueDate ? `${group.noDueDate} with no due date` : null,
  ].filter(Boolean);

  const tone = complianceBandColour(group.completion.percent);
  const visible = records.data
    ? showAll
      ? records.data.records
      : records.data.records.slice(0, FIRST_PAGE)
    : [];

  return (
    <section className="ops-group" style={{ ["--ops-edge" as string]: tone }}>
      {/*
        `<h3><button></button></h3>`, the disclosure pattern.
        A heading INSIDE a button is invalid — a button takes phrasing content —
        and it also costs the register its heading outline, which is how a
        screen-reader user jumps between stores without reading every record.
        The heading wraps the control instead, so the store name is both a
        landmark and the thing that opens the group.
      */}
      <h3 className="ops-group__heading">
      <button
        type="button"
        className="ops-group__head"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="ops-group__title">
          <span className="ops-group__name">{group.siteName}</span>
          <span className="ops-group__count">
            {group.completion.satisfied} of {group.completion.applicable}
          </span>
          <Icon name="chevron" size={16} />
        </span>
        <ProgressMeter
          value={group.completion.satisfied}
          max={Math.max(group.completion.applicable, 1)}
          tone={tone}
          label={`${group.siteName}: ${group.completion.satisfied} of ${group.completion.applicable} applicable requirements met, ${group.completion.percent}%`}
        />
        <span className="ops-record__meta">
          {group.completion.scored ? `${group.completion.percent}% complete` : "No requirements set"}
          {actions.length ? ` · ${actions.join(" · ")}` : ""}
        </span>
      </button>
      </h3>

      {expanded ? (
        <div className="ops-group__body">
          {records.error ? (
            <ErrorState what={records.error} onRetry={records.reload} />
          ) : !records.data ? (
            <SkeletonRow lines={4} height={120} />
          ) : records.data.records.length === 0 ? (
            <EmptyState>
              No requirements set for this site.{" "}
              <button type="button" className="ops-link" onClick={onOpenStoreDocumentation}>
                Add them on Store Documentation
              </button>
            </EmptyState>
          ) : (
            <>
              {visible.map((record) => (
                <RecordRow
                  key={record.id}
                  record={record}
                  onManage={onManageRecord}
                  onOpenBoard={onOpenStoreDocumentation}
                />
              ))}
              {records.data.records.length > visible.length ? (
                <button type="button" className="ops-link" onClick={() => setShowAll(true)}>
                  Show all {records.data.records.length} <Icon name="chevron" size={14} />
                </button>
              ) : null}
              <HiddenDataTable
                caption={`${group.siteName} compliance records`}
                columns={["Requirement", "Responsibility", "Due date", "Status"]}
                rows={records.data.records.map((record) => [
                  record.kind,
                  record.responsibility,
                  record.expiry ? formatDate(record.expiry) : NO_DUE_DATE,
                  record.state,
                ])}
              />
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * One record: a name, a chip, and one muted line. Never six stacked rows.
 *
 * The SITE is not on it. It is the group header, and repeating it twelve times
 * per store is what bloated the record in the first place.
 */
function RecordRow({
  record,
  onManage,
  onOpenBoard,
}: {
  record: Record_;
  onManage: (id: string | null) => void;
  onOpenBoard: () => void;
}) {
  return (
    <button
      type="button"
      className="ops-record"
      onClick={() => (record.editable ? onManage(record.id) : onOpenBoard())}
    >
      {/*
        FOUR PARTS, and at ≥768px they become the four columns the brief asks
        for: requirement, responsibility, due date, status. On a phone they
        stack into a name line and one muted line, which is the whole point of
        the rebuild — one certificate used to take six stacked rows and a third
        of the screen.

        Each part is its own element rather than one joined string, because a
        joined string cannot become a column: `display: contents` over bare text
        nodes turns the separator itself into a grid cell.
      */}
      <span className="ops-record__top">
        <span className="ops-record__name">{record.kind}</span>
        {/*
          Read-only is a PERMISSION STATE, not an action. It used to sit in the
          actions row as though it were a button somebody could press. A muted
          lock says the same thing without offering to do anything.
        */}
        {record.editable ? null : (
          <span className="ops-record__lock" title="Read from the Store Documentation board">
            <Icon name="shield" size={14} />
            <span className="visually-hidden">Read-only, held on the Store Documentation board</span>
          </span>
        )}
      </span>
      <span className="ops-record__who">{record.responsibility}</span>
      <span className="ops-record__due">
        {/* "No due date", never an em dash — a dash reads as a rendering fault. */}
        {record.expiry ? formatDate(record.expiry) : NO_DUE_DATE}
      </span>
      <span className="ops-record__state">
        <StatusChip
          tone={COMPLIANCE_COLOUR[record.state]}
          size="small"
          title={COMPLIANCE_MEANING[record.state]}
        >
          {record.state}
        </StatusChip>
        <Icon name="chevron" size={14} />
      </span>
    </button>
  );
}

/* ── By requirement ───────────────────────────────────────────────────────── */

/**
 * The inversion: a requirement as the header, the sites as the rows.
 *
 * This is the question the flat list could not answer at all — "which stores
 * are missing their emergency lighting certificate?" needed a reader to scan
 * 750 records for one word.
 */
function ByRequirement({
  summary,
  search,
  open,
  onToggle,
}: {
  summary: SummaryPayload;
  search: string;
  open: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <div className="ops-rows">
      {summary.options.kinds.map((kind) => (
        <RequirementGroup
          key={kind.value}
          kind={kind}
          expanded={open.includes(kind.value)}
          onToggle={() => onToggle(kind.value)}
          search={search}
        />
      ))}
    </div>
  );
}

function RequirementGroup({
  kind,
  expanded,
  onToggle,
  search,
}: {
  kind: Option;
  expanded: boolean;
  onToggle: () => void;
  search: string;
}) {
  const records = useOpsQuery<RecordsPayload>(
    `/api/compliance/records?group=kind&key=${encodeURIComponent(kind.value)}`,
    search,
    { enabled: expanded },
  );

  return (
    <section className="ops-group">
      <h3 className="ops-group__heading">
        <button type="button" className="ops-group__head" aria-expanded={expanded} onClick={onToggle}>
          <span className="ops-group__title">
            <span className="ops-group__name">{kind.label}</span>
            <span className="ops-group__count">{plural(kind.count, "site")}</span>
            <Icon name="chevron" size={16} />
          </span>
        </button>
      </h3>
      {expanded ? (
        <div className="ops-group__body">
          {records.error ? (
            <ErrorState what={records.error} onRetry={records.reload} />
          ) : !records.data ? (
            <SkeletonRow lines={3} height={90} />
          ) : (
            records.data.records.map((record) => (
              <div key={record.id} className="ops-record">
                <span className="ops-record__top">
                  <span className="ops-record__name">{record.siteName}</span>
                  <StatusChip
                    tone={COMPLIANCE_COLOUR[record.state]}
                    size="small"
                    title={COMPLIANCE_MEANING[record.state]}
                  >
                    {record.state}
                  </StatusChip>
                </span>
                <span className="ops-record__meta">
                  {record.responsibility}
                  {" · "}
                  {record.expiry ? formatDate(record.expiry) : NO_DUE_DATE}
                </span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}

/* ── All records ──────────────────────────────────────────────────────────── */

/**
 * The flat table, for export and bulk work.
 *
 * Desktop only. `.ops-table-wrap` is `display: none` below 1024px and the
 * fallback note takes its place, because a 750-row six-column table on a phone
 * is the thing this rebuild exists to remove.
 */
function AllRecords({
  search,
  onManageRecord,
}: {
  search: string;
  onManageRecord: (id: string | null) => void;
}) {
  const records = useOpsQuery<RecordsPayload>(
    "/api/compliance/records?group=site&limit=1000",
    search,
  );

  return (
    <OpsCard title="All records" subtitle={records.data ? plural(records.data.total, "record") : undefined}>
      <p className="ops-card__note ops-hide-desktop">
        The full table needs a wider screen. Switch to By site on a phone.
      </p>
      <div className="ops-table-wrap">
        {records.error ? (
          <ErrorState what={records.error} onRetry={records.reload} />
        ) : !records.data ? (
          <SkeletonRow lines={6} height={200} />
        ) : (
          <table className="analytics-table">
            <caption className="visually-hidden">Every compliance record</caption>
            <thead>
              <tr>
                <th scope="col">Site</th>
                <th scope="col">Requirement</th>
                <th scope="col">Responsibility</th>
                <th scope="col">Due date</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {records.data.records.map((record) => (
                <tr
                  key={record.id}
                  onClick={() => (record.editable ? onManageRecord(record.id) : undefined)}
                >
                  <td>{record.siteName}</td>
                  <td>{record.kind}</td>
                  <td>{record.responsibility}</td>
                  <td>{record.expiry ? formatDate(record.expiry) : NO_DUE_DATE}</td>
                  <td>
                    <StatusChip tone={COMPLIANCE_COLOUR[record.state]} size="small">
                      {record.state}
                    </StatusChip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </OpsCard>
  );
}

/**
 * Export what is on screen.
 *
 * It asks the records endpoint for the CURRENT filter state rather than
 * exporting the whole register, so the file and the page agree. That is the one
 * property an export has to have: a reader who filters to "missing at Aldgate"
 * and presses Export must not receive 750 rows.
 */
function ExportButton({ search }: { search: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="ops-option"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const query = search.replace(/^\?/, "");
          const response = await fetch(
            `/api/compliance/records?group=site&limit=1000${query ? `&${query}` : ""}`,
            { headers: { Accept: "application/json" } },
          );
          const payload = (await response.json()) as RecordsPayload;
          downloadCsv(
            "maintsupp-compliance",
            ["Site", "Requirement", "Responsibility", "Due date", "Status"],
            (payload.records ?? []).map((record) => [
              record.siteName,
              record.kind,
              record.responsibility,
              record.expiry ? formatDate(record.expiry) : NO_DUE_DATE,
              record.state,
            ]),
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="download" size={14} /> {busy ? "Preparing…" : "Export"}
    </button>
  );
}
