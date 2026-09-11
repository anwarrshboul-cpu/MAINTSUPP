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
import { announceDataChanged, useOpsQuery, useQueryState } from "./ops-url-state";
import {
  COMPLIANCE_COLOUR,
  COMPLIANCE_MEANING,
  NO_DUE_DATE,
  complianceBandColour,
  type ComplianceState,
} from "../../../lib/compliance-status";
import { formatDate, formatDayMonth, formatShortDate } from "../../../lib/format-date";
import {
  ConfirmResponsibilitiesQueue,
  ResponsibilityControl,
  ResponsibilityCoverageLine,
  type ResponsibilityCoverage,
} from "./compliance-responsibility";
/*
 * 2B/2C/2D — the register's setup tools, in a file of their own.
 *
 * Reached as `?view=setup`, beside the four reading views, because the work is
 * the same work: somebody looking at a register that does not describe their
 * estate fixes it here. Kept out of this file because this one is already a
 * thousand lines and the three tools have nothing to say to the accordion.
 */
import { ComplianceSetup } from "./compliance-setup";

type Completion = {
  satisfied: number;
  applicable: number;
  notRequired: number;
  total: number;
  percent: number;
  scored: boolean;
  /*
   * Requirements left OUT of the percentage because nobody has confirmed whose
   * obligation they are, or has confirmed they are somebody else's.
   *
   * Declared here because the server has always sent it and this page dropped
   * it: without it "8%" and "3 of 12 HELD" are indistinguishable on screen from
   * "8%" and "3 of 12 CONFIRMED", which are entirely different facts about a
   * store. See `ComplianceCompletion` in compliance-status.ts.
   */
  excluded: number;
  counts: Record<ComplianceState, number>;
};

type Group = {
  siteId: string;
  siteName: string;
  completion: Completion;
  /* How many of this store's responsibilities have been answered for — a count,
     never a percentage. It rides on the GROUP HEADER because the header is drawn
     while the group is still collapsed. */
  coverage: ResponsibilityCoverage;
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
    coverage: ResponsibilityCoverage;
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
  /**
   * WHO CHASES THIS CERTIFICATE — the `?who=` filter's axis.
   *
   * Not `dutyHolder`. The two are printed a few pixels apart on this row and
   * the confusion is easy, so they are named apart everywhere: a fire alarm
   * service can be chased by the fire safety partner and still be the
   * landlord's obligation in a mall unit.
   */
  responsibility: string;
  /**
   * WHOSE OBLIGATION IT IS — client / landlord / centre / not_applicable, or
   * "unconfirmed", or null if nobody has ever been asked.
   *
   * The API has always sent it; this type did not declare it, so the value was
   * dropped on the floor and the register could not show or set it.
   */
  dutyHolder: string | null;
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

/*
 * `scored`, `from` and `to` are written by the Compliance overview block above
 * the register (`cp-dash.tsx`): its figures count only the requirements inside
 * the score, and its date range narrows the register by due date. They are the
 * register's filters once they are in the address bar, so "Clear all" takes
 * them off too. `portfolio` is deliberately NOT here — it is the block's own
 * header control, and this page does not read it.
 */
const FILTER_KEYS = [
  "site",
  "state",
  "kind",
  "who",
  "due",
  "q",
  "sort",
  "view",
  "open",
  "scored",
  "from",
  "to",
] as const;

/**
 * THE BLOCK'S NARROWINGS, IN WORDS, FOR THE CHIPS.
 *
 * A countdown ring sends its window as `due=band:0-20` — thirds of the amber
 * window, so not one of the fixed `DUE_WINDOWS` keys — and the header's picker
 * sends `from`/`to`. A chip reading "band:0-20" or "2026-05-12" would be a
 * filter the reader cannot read, so each becomes the sentence it stands for.
 * The server's parser (`parseComplianceFilters`) swaps a reversed range, and so
 * does this, so the chip describes the range actually applied.
 */
const DUE_BAND = /^band:(\d{1,4})-(\d{1,4})$/;
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function dueBandText(value: string): string | null {
  const match = DUE_BAND.exec(value.trim());
  if (!match) return null;
  const [low, high] = [Number(match[1]), Number(match[2])].sort((left, right) => left - right);
  return `Due in ${low}–${high} days`;
}

function dueRangeText(from: string, to: string): string | null {
  const start = DAY_ONLY.test(from) ? from : "";
  const end = DAY_ONLY.test(to) ? to : "";
  if (start && end) {
    const [low, high] = start <= end ? [start, end] : [end, start];
    const sameYear = low.slice(0, 4) === high.slice(0, 4);
    return `Due between ${sameYear ? formatDayMonth(low) : formatShortDate(low)} – ${formatShortDate(high)}`;
  }
  if (start) return `Due from ${formatShortDate(start)}`;
  if (end) return `Due until ${formatShortDate(end)}`;
  return null;
}

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
      const values = params.getAll(group.key);
      /* A dashboard figure can hand the register dozens of values at once —
         "Other types" is every requirement outside the top five, a portfolio
         is every member store — and one chip per value buried the register
         under a wall of them. Past three they are one chip, which comes off
         as one, since they went on as one. */
      if (values.length > 3) {
        out.push({
          key: group.key,
          label: group.label,
          value: `${values.length} selected`,
          onRemove: () => {
            const next = new URLSearchParams(window.location.search);
            next.delete(group.key);
            setParams(next);
          },
        });
        continue;
      }
      for (const value of values) {
        out.push({
          key: group.key,
          label: group.label,
          value:
            group.options.find((option) => option.value === value)?.label ??
            (group.key === "due" ? dueBandText(value) : null) ??
            /* The block's "Unassigned" renewal segment: nobody named at all. */
            (group.key === "who" && value === "__none__" ? "Unassigned" : null) ??
            value,
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
    /* The Compliance block's narrowings — see `FILTER_KEYS`. Each comes off
       like any other chip; the range comes off as one, since it went on as one. */
    if (params.get("scored") === "1") {
      out.push({
        key: "scored",
        label: "Scope",
        value: "In the score",
        onRemove: () => setValue("scored", "", ""),
      });
    }
    const range = dueRangeText(params.get("from") ?? "", params.get("to") ?? "");
    if (range) {
      out.push({
        key: "range",
        label: "Due date",
        value: range,
        onRemove: () => {
          const next = new URLSearchParams(window.location.search);
          next.delete("from");
          next.delete("to");
          setParams(next);
        },
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
              /* The backlog as its own view rather than a separate page: it is
                 the same register read by one more question, and it shares the
                 filter bar, the chips and the URL state with the other three. */
              ["confirm", "Confirm responsibilities"],
              /* Last, because it is the least often wanted and the only one
                 that writes. */
              ["setup", "Set up"],
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

      {/*
        THE REGISTER'S SCROLL ANCHOR — where the Compliance block above lands a
        reader after a drill ("View register ›", a segment, a ring).

        It wraps the filter bar AND everything below it, not the bar alone. The
        bar is `position: sticky`, and a sticky box can only travel inside its
        parent: a wrapper exactly its own height would pin it in place and it
        would stop sticking. `gap: inherit` keeps the page's own spacing at
        every width, and `scroll-margin-top` clears the sticky topbar (71px, 64
        on a phone) so the bar is not scrolled underneath it.
      */}
      <section
        id="compliance-register"
        aria-label="Compliance register"
        style={{ display: "flex", flexDirection: "column", gap: "inherit", scrollMarginTop: 84 }}
      >
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
      ) : view === "setup" ? (
        /*
          BEFORE the empty-state guards below, and this is the case that proves
          why they have to be. "No compliance requirements are set up yet" is
          precisely the state somebody comes here to fix, so letting that guard
          short-circuit would make the fix unreachable from the screen that
          reports the problem.
        */
        <ComplianceSetup onChanged={summary.reload} />
      ) : view === "confirm" ? (
        /*
          BEFORE the two empty-state guards below, deliberately. Those describe
          the RECORD list — "no requirements match these filters" — and letting
          them short-circuit would make the queue unreachable from a filtered
          register, which is exactly the state somebody is in when they narrow to
          one store and then go to confirm its responsibilities.
        */
        /* A confirmed duty holder moves a requirement into the score, so the
           dashboard block above is stale too; `announceDataChanged` re-reads
           every figure on the page, the summary included. */
        <ConfirmResponsibilitiesQueue search={search} onSaved={announceDataChanged} />
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
              /* A responsibility set on a record moves it into or out of the
                 percentage, so the header above it — and the dashboard block,
                 which scores the same register — has to be re-read. */
              onSaved={announceDataChanged}
            />
          ))}
        </div>
      )}
      </section>
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
        HOW MUCH OF THE REGISTER HAS BEEN ANSWERED FOR — beside the percentage,
        never inside it.

        "Complete 8%" on its own is read as a claim about certificates. It is
        also a claim about a DENOMINATOR, and on a register where 144 of 204
        requirements are waiting on somebody to say whose they are, the
        denominator is the more surprising half. The two sentences sit together
        so neither can be read without the other, and this one is a count: it
        does not, and cannot, print a percent sign.
      */}
      <p className="ops-card__note">
        <ResponsibilityCoverageLine coverage={portfolio.coverage} tone="strong" />
      </p>
      {portfolio.completion.excluded > 0 ? (
        <p className="ops-card__note">
          {portfolio.completion.excluded} of {plural(portfolio.total, "requirement")} are outside
          the percentage because their responsibility is unconfirmed, or belongs to a landlord or
          shopping centre.
        </p>
      ) : null}
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
  onSaved,
}: {
  group: Group;
  expanded: boolean;
  onToggle: () => void;
  search: string;
  expiryWindowDays: number;
  onManageRecord: (id: string | null) => void;
  onOpenStoreDocumentation: () => void;
  /** Re-read the summary after a responsibility changes on one of these rows. */
  onSaved: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const records = useOpsQuery<RecordsPayload>(
    `/api/compliance/records?group=site&key=${encodeURIComponent(group.siteId)}`,
    search,
    { enabled: expanded },
  );

  /*
   * BOTH QUERIES, OR THE CONTROL SNAPS BACK.
   *
   * The select is controlled by `record.dutyHolder`, which comes from THIS
   * group's records query — not from the summary. Reloading only the summary
   * left the row's own payload stale, so a saved answer reverted on the next
   * render and looked like a failed write. The header has to be re-read as well
   * because a confirmed requirement moves into or out of the percentage.
   */
  const handleSaved = useCallback(() => {
    records.reload();
    onSaved();
  }, [onSaved, records]);

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
          {/*
            "0 of 0" IS NOT A FACT ABOUT A STORE WITH TWELVE REQUIREMENTS.
            The fraction is the compliance score's, and its denominator is only
            the requirements confirmed as ours. A store whose twelve are all
            still unconfirmed has an applicable count of zero, so the fraction
            read "0 of 0" beside a header that then said "No requirements set" —
            two sentences, both saying the store is empty, about a store with a
            full register. When there is nothing to score, the honest number is
            how many requirements there are.
          */}
          <span className="ops-group__count">
            {group.completion.scored
              ? `${group.completion.satisfied} of ${group.completion.applicable}`
              : plural(group.total, "requirement")}
          </span>
          <Icon name="chevron" size={16} />
        </span>
        {/*
          No meter when there is nothing to score. An empty bar is read as a
          failing store, which is the same lie as "0%" drawn a different way.
        */}
        {group.completion.scored ? (
          <ProgressMeter
            value={group.completion.satisfied}
            max={Math.max(group.completion.applicable, 1)}
            tone={tone}
            label={`${group.siteName}: ${group.completion.satisfied} of ${group.completion.applicable} applicable requirements met, ${group.completion.percent}%`}
          />
        ) : null}
        <span className="ops-record__meta">
          {group.completion.scored
            ? `${group.completion.percent}% complete`
            : /*
                NEVER "0%", and never "No requirements set" for a store that has
                twelve of them. `coverage.label` is the one place that sentence
                is decided — "Not yet confirmed", or "3 of 12 requirements
                confirmed" — so this header, the portfolio band and the queue
                cannot phrase it three ways.
              */
              group.total === 0
              ? "No requirements set"
              : group.coverage.label}
          {actions.length ? ` · ${actions.join(" · ")}` : ""}
        </span>
      </button>
      </h3>
      {/*
        The coverage sentence sits under the header whether the group is open or
        shut, because the store whose responsibilities nobody has answered for is
        exactly the one nobody expands.
      */}
      {group.completion.scored && group.coverage.total > 0 ? (
        <p className="resp-group__coverage">
          <ResponsibilityCoverageLine coverage={group.coverage} />
        </p>
      ) : null}

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
                  onSaved={handleSaved}
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
  onSaved,
}: {
  record: Record_;
  onManage: (id: string | null) => void;
  onOpenBoard: () => void;
  /** Re-read the meters after this row's responsibility changes. */
  onSaved: () => void;
}) {
  return (
    /*
      THE CONTROL IS A SIBLING OF THE ROW, NOT A CHILD OF IT.

      `.ops-record` is a `<button>`, and a `<select>` inside a button is invalid
      — a button takes phrasing content, and browsers that render it anyway
      swallow the select's own clicks into the button's. So the row and its
      control sit side by side in a wrapper, and `.resp-record` moves the row
      separator onto that wrapper at the width where they share a line.
    */
    <div className="resp-record">
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
    {/*
      OFFERED ON A LOCKED ROW TOO, and that is not an oversight. The lock says
      the CERTIFICATE is held on the Store Documentation board and cannot be
      edited from here. Whose obligation the requirement is has never been a
      board column at all — it is an annotation — so it is answerable on a
      board-derived row exactly as it is on a register-only one, which is the
      whole reason this write addresses a requirement by site × name rather
      than by a `compliance_documents` id half the register does not have.
    */}
    <ResponsibilityControl record={record} onSaved={onSaved} compact />
    </div>
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
