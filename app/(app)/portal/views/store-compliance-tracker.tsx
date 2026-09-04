"use client";

/**
 * Compliance Tracker — the second tab of the Store Documentation UK board.
 *
 * The board's table answers "what is on this store's row". It does not answer
 * the question the tab exists for, which is "across the estate, what is missing
 * and what has lapsed, and whose telephone call fixes it". Reading that off the
 * table means scanning twenty-four columns per store and holding nine expiry
 * dates in your head, which is how a fire alarm certificate goes three months
 * overdue without anybody noticing.
 *
 * So this is a stores × documents matrix over the twelve slots in
 * `storeDocumentationCertificates`, in monday's column order, with three things
 * the table cannot do:
 *
 *  - MISSING and EXPIRED are told apart. They are different failures — one
 *    document was never obtained, the other was obtained and has lapsed — and
 *    they are chased differently, so they get different words, different
 *    glyphs, different colours and a different border weight.
 *  - Rows are ordered by how much trouble they are in, and the worst individual
 *    documents are lifted out into a short list above the matrix. The point is
 *    that the certificate which expired last week is legible before you scroll
 *    anywhere, vertically or horizontally.
 *  - The three slots monday tracks without an expiry — RAMS, the Fire Risk
 *    Assessment and the store Drawing — say "On file" and show no date. They do
 *    not render an empty date, because an empty date reads as missing data and
 *    there is no data to be missing.
 *
 * Responsibility comes from the board spec rather than from substring-matching
 * the requirement name, which is why the drawing is chased by the projects team
 * here and not by whichever store manager happened to be listed.
 *
 * WHERE THE DATA COMES FROM
 *
 * The `stores` prop, which the Store Documentation shell fills from the board
 * itself — `requests` joined to `cells` and `fileCounts` by
 * `store-documentation-model.ts`.
 *
 * It used to fetch `/api/workspace` unconditionally, and that was the wrong
 * estate. Workspace stores come from the `sites` table, which holds ten seeded
 * demo sites, and their compliance rows come from `compliance_documents`, which
 * holds 10 × 12 records with every `attachment_id` NULL. Against monday's
 * capture that gave ten stores instead of thirty-one, thirty of ninety expiry
 * dates that monday does not hold at all — Touchwood-Solihull's PAT read
 * "Expired 20/07/2026, 20 days overdue" when the board says 06/11/2026 and it
 * is valid — and `fileCount` zero on all 120, so PLI certificates that are
 * attached and downloadable were reported as Missing.
 *
 * The two models do not reconcile by name on their own: sites says "Solihull"
 * where the board says "Touchwood - Solihull", and "Bristol Cabot Circus" where
 * the board says "Cabot Circus - Bristol". So this tab is driven off the board
 * only, and it never guesses which site a board row is.
 *
 * /dashboard/compliance now reads the same board. `/api/workspace` derives its
 * register from the Store Documentation rows and links a board row to a site
 * only through `normaliseSiteName` and `site_aliases` — the same resolver the
 * sites importer uses — so the two screens describe one estate. What is left in
 * `compliance_documents` is the override layer: "Not required", which the board
 * has no column for, and any requirement an admin added outside the twelve
 * slots. Nothing in that table was deleted.
 *
 * The `/api/workspace` fetch below remains as the fallback for a caller that
 * has no board payload to hand. It resolves the organisation from the session
 * through `scopedDb`, and nothing in this file addresses a store by id across
 * that boundary.
 */

import { useEffect, useMemo, useState } from "react";
import { RaiseTicketButton } from "../raise-ticket";
import { Icon } from "../../../components";
import {
  storeDocumentationCertificates,
  type StoreDocumentSlot,
} from "../../../../db/monday-board-spec";
import type { StoreRecord } from "../../../lib/types";
import { EXPIRY_DUE_SOON_DAYS, expiryStatus } from "../../../lib/expiry-status";
import { formatDate } from "./view-model";
import trackerCss from "./store-compliance-tracker.css?url";

/**
 * The slice of a store this view reads.
 *
 * Deliberately a `Pick` of `StoreRecord` rather than a fresh shape, so the
 * workspace snapshot can be passed straight through and a change to the record
 * is a compile error here rather than a silently empty column.
 */
export type ComplianceTrackerStore = Pick<
  StoreRecord,
  "id" | "name" | "manager" | "lifecycle" | "compliance"
>;

/* ── Status vocabulary ───────────────────────────────────────────────────── */

/**
 * What one cell of the matrix says.
 *
 * Seven values rather than four, because "we hold it and it is fine" is not the
 * same sentence for a slot with an expiry as for one without, and "we hold it
 * but nobody recorded when it runs out" is a real state of the register that
 * would otherwise be filed under valid and quietly forgotten.
 */
/*
 * Derived compliance states, NOT board statuses.
 *
 * These are computed from an expiry date and a file count — nobody configures
 * them, so they are a union rather than option_values rows. Named `State` and
 * not `Status` deliberately: `Status` in this codebase means an admin-editable
 * option set, and the repo has a guard that forbids hardcoding those.
 */
type CellState =
  | "expired"
  | "missing"
  | "due"
  | "undated"
  | "valid"
  | "on-file"
  | "not-required";

type StatusPresentation = {
  /** Shown next to the words. Never the only signal, and never load-bearing. */
  glyph: string;
  label: string;
  /** How badly this wants attention. Drives row order and the priority list. */
  rank: number;
};

const STATUS: Record<CellState, StatusPresentation> = {
  expired: { glyph: "!", label: "Expired", rank: 6 },
  missing: { glyph: "✕", label: "Missing", rank: 5 },
  due: { glyph: "▲", label: "Due soon", rank: 4 },
  undated: { glyph: "?", label: "No expiry recorded", rank: 3 },
  valid: { glyph: "✓", label: "In date", rank: 1 },
  "on-file": { glyph: "✓", label: "On file", rank: 1 },
  "not-required": { glyph: "–", label: "Not required", rank: 0 },
};

/** The statuses the summary counts and the priority list care about. */
const ACTIONABLE: CellState[] = ["expired", "missing", "due"];

/* ── Expiry ──────────────────────────────────────────────────────────────── */

/**
 * The expiry verdict, read off the classifier's typed union.
 *
 * WHAT THIS REPLACED, AND WHY IT WAS WRONG IN PRINCIPLE RATHER THAN IN EFFECT.
 *
 * This file used to treat `expiryStatus`'s answer as `unknown` — on the stated
 * grounds that the return shape "belongs to the expiry cell and is not this
 * view's business" — then probe seven candidate field names for something
 * string-shaped (`tokenFrom`), then match that string against four groups of
 * substrings (`verdictFromToken`), with a comment explaining that "expired"
 * had to be tested before "expiring soon" because the two share a prefix. Below
 * that sat `daysUntil` and `verdictFromDays`, a second complete implementation
 * of the same classification, reachable only when the first returned "unknown"
 * — which this file's own note at the time admitted never happened.
 *
 * The premise was false. `expiryStatus` does not belong to the expiry cell: it
 * lives in `app/lib/expiry-status.ts`, which exists precisely so that a route
 * handler, a React view and a test can share one verdict, and it exports
 * `ExpiryState` — a four-member union — as part of its contract. Reading
 * `.state` is not depending on an implementation detail; it is using the API.
 * And it is strictly safer than the prose matching it replaces: a new state
 * becomes a compile error in the switch below instead of falling through the
 * regexes to "unknown" and then to a duplicate that might disagree.
 *
 * The prefix hazard disappears with it. So does the possibility of the two
 * implementations drifting, which is exactly how this file came to print "Due
 * within 30 days" over a tile filled by a 60-day window.
 */
type ExpiryVerdict = "expired" | "due" | "valid" | "unrecorded";

/**
 * One certificate's verdict and how many days are left on it.
 *
 * Both come from the same call. `daysUntil` used to compute the number here
 * with its own UTC-midnight arithmetic while `expiryStatus` computed the same
 * number internally to decide the state — two clocks, one date, and nothing
 * making them agree. `daysRemaining` is on the returned object.
 */
function readExpiry(
  iso: string | null,
  today: Date,
): { verdict: ExpiryVerdict; daysAway: number | null } {
  const status = expiryStatus(iso, today);
  const verdict: ExpiryVerdict =
    status.state === "expired"
      ? "expired"
      : status.state === "due-soon"
        ? "due"
        : status.state === "valid"
          ? "valid"
          : "unrecorded";
  return { verdict, daysAway: status.daysRemaining };
}

/* ── The matrix ──────────────────────────────────────────────────────────── */

type Cell = {
  status: CellState;
  /** Only ever set for a slot that tracks one. Undated slots keep it null. */
  expiry: string | null;
  daysAway: number | null;
};

type MatrixRow = {
  store: ComplianceTrackerStore;
  cells: Cell[];
  counts: Record<CellState, number>;
  /** The most overdue day-count on the row, for ordering within equal counts. */
  worstDays: number | null;
};

function emptyCounts(): Record<CellState, number> {
  return {
    expired: 0,
    missing: 0,
    due: 0,
    undated: 0,
    valid: 0,
    "on-file": 0,
    "not-required": 0,
  };
}

/**
 * One store's answer for one document slot.
 *
 * The register's `state` is trusted for "we do not have this" and "this does
 * not apply here"; the date is trusted for everything about expiry, because a
 * status string goes stale the day after it is written and a date does not.
 */
function cellFor(
  slot: StoreDocumentSlot,
  record: StoreRecord["compliance"][number] | undefined,
  today: Date,
): Cell {
  if (!record) return { status: "missing", expiry: null, daysAway: null };
  if (record.state === "Not required") {
    return { status: "not-required", expiry: null, daysAway: null };
  }

  const held = record.fileCount > 0 || record.state !== "Missing";
  if (!held) return { status: "missing", expiry: null, daysAway: null };

  // RAMS, the Fire Risk Assessment and the Drawing. Monday holds no expiry for
  // these, so none is asked for and none is shown.
  if (slot.expiryColumn === null) {
    return { status: "on-file", expiry: null, daysAway: null };
  }

  if (!record.expiry) {
    return {
      status: record.state === "Expired" ? "expired" : "undated",
      expiry: null,
      daysAway: null,
    };
  }

  const { verdict, daysAway } = readExpiry(record.expiry, today);
  const status: CellState =
    verdict === "expired"
      ? "expired"
      : verdict === "due"
        ? "due"
        : verdict === "unrecorded"
          ? "undated"
          : "valid";
  return { status, expiry: record.expiry, daysAway };
}

function buildRow(
  store: ComplianceTrackerStore,
  slots: StoreDocumentSlot[],
  today: Date,
): MatrixRow {
  const byKind = new Map(store.compliance.map((item) => [item.kind, item]));
  const counts = emptyCounts();
  let worstDays: number | null = null;

  const cells = slots.map((slot) => {
    const cell = cellFor(slot, byKind.get(slot.label), today);
    counts[cell.status] += 1;
    if (cell.daysAway !== null && (worstDays === null || cell.daysAway < worstDays)) {
      worstDays = cell.daysAway;
    }
    return cell;
  });

  return { store, cells, counts, worstDays };
}

/**
 * Worst first.
 *
 * Expired outranks missing outranks due, and a store with two expired
 * certificates sits above a store with one. Ties break on how long the worst
 * one has been overdue, so "expired last week" beats "expires in a fortnight"
 * without either of them being counted twice.
 */
function byUrgency(left: MatrixRow, right: MatrixRow): number {
  for (const status of ACTIONABLE) {
    const difference = right.counts[status] - left.counts[status];
    if (difference !== 0) return difference;
  }
  if (left.worstDays !== right.worstDays) {
    if (left.worstDays === null) return 1;
    if (right.worstDays === null) return -1;
    return left.worstDays - right.worstDays;
  }
  return left.store.name.localeCompare(right.store.name, "en-GB");
}

/* ── Lifecycle ───────────────────────────────────────────────────────────── */

/**
 * WHICH STORES ARE STILL TRADING.
 *
 * `lifecycle` is the board GROUP a row sits in, and the captured monday board
 * names its four groups "Current stores", "Europe", "Closed" and "Other" — see
 * `storeDocumentationGroups` in db/monday-board-spec.ts. `buildComplianceStores`
 * has always computed it and this view has always thrown it away, which is the
 * defect: a closed unit's lapsed certificates were indistinguishable from a
 * trading store's, counted in the same tiles, and ordered by the same rule.
 *
 * On the audit fixture — two closed units among six stores — five of the six
 * entries in "Needs chasing first" were certificates belonging to CLOSED
 * stores, and the trading store whose electrical certificate had genuinely
 * lapsed was last. Nobody is going to renew the fire alarm certificate for a
 * unit that has shut, so those five lines were work that does not exist,
 * printed above work that does.
 *
 * The word is matched literally and nothing is inferred from it. Rename the
 * group on the board and this simply stops telling closed stores apart — the
 * behaviour it had before — rather than mis-filing a store as shut. Nothing is
 * ever HIDDEN: every store keeps its row, its cells and its counts, and the
 * lifecycle is printed on the row and offered as a filter so the reader decides.
 */
const CLOSED_LIFECYCLE = "closed";

function isClosed(store: ComplianceTrackerStore): boolean {
  return store.lifecycle.trim().toLowerCase() === CLOSED_LIFECYCLE;
}

/* ── Filters ─────────────────────────────────────────────────────────────── */

type ComplianceFilter = "all" | CellState;

const COMPLIANCE_FILTERS: Array<{ value: ComplianceFilter; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "expired", label: "Expired" },
  { value: "missing", label: "Missing" },
  { value: "due", label: "Due soon" },
  { value: "valid", label: "In date" },
  { value: "undated", label: "No expiry recorded" },
  { value: "not-required", label: "Not required" },
];

/** "In date" covers both the dated slots that are current and the undated slots
 *  that are simply held, because to whoever is chasing they are the same news. */
function matchesStatus(filter: ComplianceFilter, status: CellState): boolean {
  if (filter === "all") return true;
  if (filter === "valid") return status === "valid" || status === "on-file";
  return status === filter;
}

/* ── The view ────────────────────────────────────────────────────────────── */

export function StoreComplianceTracker({
  stores,
  today,
  onOpenStore,
}: {
  /**
   * The stores to matrix, already scoped to the caller's organisation.
   *
   * On the Store Documentation board this is the board's own rows, joined from
   * one `/api/board` payload. Omit it and the view falls back to loading
   * `/api/workspace` — the `sites` register, a different and much smaller
   * estate — which is right for a caller that has no board to read and wrong
   * for this tab, which is why the shell now passes it.
   */
  stores?: ComplianceTrackerStore[];
  /** Reference date. Injectable so the matrix can be tested against a fixture. */
  today?: Date;
  onOpenStore?: (storeId: string) => void;
}) {
  const [loaded, setLoaded] = useState<ComplianceTrackerStore[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<ComplianceFilter>("all");
  const [responsibility, setResponsibility] = useState("");
  /** Empty means every lifecycle, which is what the tab has always shown. */
  const [lifecycle, setLifecycle] = useState("");
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<"urgency" | "name">("urgency");

  // Frozen at mount, the way `useCurrentTime` does it elsewhere in the portal:
  // a matrix that reshuffles under the cursor because a minute ticked over is
  // worse than one that is a minute stale.
  const [reference] = useState(() => today ?? new Date());
  const now = today ?? reference;

  useEffect(() => {
    if (stores) return undefined;
    let active = true;
    fetch("/api/workspace", { headers: { Accept: "application/json" } })
      .then(async (response) => {
        const payload = (await response.json()) as {
          workspace?: { stores?: ComplianceTrackerStore[] };
          error?: string;
        };
        if (!response.ok || !payload.workspace) {
          throw new Error(payload.error || "The compliance register is unavailable.");
        }
        if (active) setLoaded(payload.workspace.stores ?? []);
      })
      .catch((caught: unknown) => {
        if (active) {
          setLoadError(
            caught instanceof Error
              ? caught.message
              : "The compliance register is unavailable.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [stores]);

  const allStores = stores ?? loaded;

  /*
   * The lifecycles actually on the board, in the board's own words.
   *
   * Derived from the rows rather than from `storeDocumentationGroups`, because
   * a group an admin renamed has to appear here under its new name, and a
   * group with no stores in it should not offer a filter that empties the
   * matrix. A board with one lifecycle offers no control at all — see below.
   */
  const lifecycles = useMemo(
    () =>
      [...new Set((allStores ?? []).map((store) => store.lifecycle).filter(Boolean))].sort(
        (left, right) => left.localeCompare(right, "en-GB"),
      ),
    [allStores],
  );

  const responsibilities = useMemo(
    () =>
      [...new Set(storeDocumentationCertificates.map((slot) => slot.responsibility))].sort(
        (left, right) => left.localeCompare(right, "en-GB"),
      ),
    [],
  );

  /** Responsibility narrows the columns — you chase your own certificates. */
  const slots = useMemo(
    () =>
      storeDocumentationCertificates.filter(
        (slot) => !responsibility || slot.responsibility === responsibility,
      ),
    [responsibility],
  );

  const rows = useMemo(() => {
    if (!allStores) return [];
    const needle = query.trim().toLowerCase();
    return allStores
      .filter((store) => !lifecycle || store.lifecycle === lifecycle)
      .filter(
        (store) =>
          !needle ||
          `${store.name} ${store.manager}`.toLowerCase().includes(needle),
      )
      .map((store) => buildRow(store, slots, now));
  }, [allStores, lifecycle, query, slots, now]);

  /** Counts describe everything in scope, so they do not move as the status
   *  filter moves — the filter is a lens on these numbers, not a redefinition. */
  const totals = useMemo(() => {
    const counts = emptyCounts();
    for (const row of rows) {
      for (const key of Object.keys(counts) as CellState[]) {
        counts[key] += row.counts[key];
      }
    }
    return counts;
  }, [rows]);

  const visible = useMemo(() => {
    const matching =
      status === "all"
        ? rows
        : rows.filter((row) => row.cells.some((cell) => matchesStatus(status, cell.status)));
    return [...matching].sort(
      order === "name"
        ? (left, right) => left.store.name.localeCompare(right.store.name, "en-GB")
        : byUrgency,
    );
  }, [rows, status, order]);

  /** The short list above the matrix — the individual documents in the worst
   *  trouble, so the fire alarm certificate that lapsed last week is readable
   *  before anybody scrolls in either direction. */
  const priority = useMemo(() => {
    const flat = visible.flatMap((row) =>
      row.cells
        .map((cell, index) => ({ row, cell, slot: slots[index] }))
        .filter(
          (entry) =>
            entry.slot !== undefined && ACTIONABLE.includes(entry.cell.status),
        ),
    );
    return flat
      .sort((left, right) => {
        /*
         * TRADING BEFORE CLOSED, ahead of the status rank.
         *
         * This is a CHASE list — six lines, at the top of the tab, headed
         * "Needs chasing first". A certificate on a store that has shut is not
         * chased at all, so a closed unit's expired PAT must not push a
         * trading store's expiring one off the list. Status rank still decides
         * everything within each of the two groups, and nothing is removed:
         * the closed store keeps its row, its cells and its counts in the
         * matrix below, and appears here once the trading estate is clear.
         */
        const trading = Number(isClosed(left.row.store)) - Number(isClosed(right.row.store));
        if (trading !== 0) return trading;
        const rank = STATUS[right.cell.status].rank - STATUS[left.cell.status].rank;
        if (rank !== 0) return rank;
        if (left.cell.daysAway !== right.cell.daysAway) {
          if (left.cell.daysAway === null) return 1;
          if (right.cell.daysAway === null) return -1;
          return left.cell.daysAway - right.cell.daysAway;
        }
        return left.row.store.name.localeCompare(right.row.store.name, "en-GB");
      })
      .slice(0, 6);
  }, [visible, slots]);

  // The portal's stylesheets are linked by the app layout, which this view is
  // not allowed to touch, so it brings its own. `precedence` is what makes
  // React 19 hoist and de-duplicate the tag rather than leaving one copy per
  // render of the tab.
  const stylesheet = <link rel="stylesheet" href={trackerCss} precedence="default" />;

  if (loadError) {
    return (
      <>
        {stylesheet}
        <p className="view-empty">{loadError}</p>
      </>
    );
  }

  if (!allStores) {
    return (
      <>
        {stylesheet}
        <p className="view-empty">Loading the compliance register…</p>
      </>
    );
  }

  const recordCount = allStores.reduce((total, store) => total + store.compliance.length, 0);

  if (!allStores.length || recordCount === 0) {
    return (
      <>
        {stylesheet}
        <ComplianceTrackerEmpty storeCount={allStores.length} />
      </>
    );
  }

  return (
    <div className="store-compliance">
      {stylesheet}

      <header className="store-compliance__head">
        <div>
          <h3>Compliance Tracker</h3>
          <p>
            Every store against the {storeDocumentationCertificates.length} documents the
            Store Documentation board tracks. Worst first.
          </p>
        </div>
      </header>

      <ul className="store-compliance__totals">
        {(
          [
            ["expired", "Expired", "Held once, lapsed now"],
            ["missing", "Missing", "Never obtained"],
            ["due", `Due within ${EXPIRY_DUE_SOON_DAYS} days`, "Still valid, renew now"],
            ["valid", "In date", "Nothing to do"],
          ] as const
        ).map(([key, label, note]) => (
          <li key={key} className={`store-compliance__total is-${key}`}>
            <strong>
              {key === "valid" ? totals.valid + totals["on-file"] : totals[key]}
            </strong>
            <span>{label}</span>
            <em>{note}</em>
          </li>
        ))}
      </ul>

      <div className="store-compliance__filters">
        <label className="store-compliance__search">
          <Icon name="search" size={17} />
          <input
            type="search"
            value={query}
            placeholder="Search stores…"
            aria-label="Search stores by name or manager"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <label className="store-compliance__filter">
          <Icon name="shield" size={16} />
          <select
            value={status}
            aria-label="Filter documents by status"
            onChange={(event) => setStatus(event.target.value as ComplianceFilter)}
          >
            {COMPLIANCE_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="store-compliance__filter">
          <Icon name="users" size={16} />
          <select
            value={responsibility}
            aria-label="Filter documents by who chases them"
            onChange={(event) => setResponsibility(event.target.value)}
          >
            <option value="">Everyone&apos;s documents</option>
            {responsibilities.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>

        {/*
          Only where there is something to choose between. A board whose stores
          all sit in one group would get a select with a single option, which is
          a control that cannot do anything.
        */}
        {lifecycles.length > 1 && (
          <label className="store-compliance__filter">
            <Icon name="store" size={16} />
            <select
              value={lifecycle}
              aria-label="Filter stores by lifecycle"
              onChange={(event) => setLifecycle(event.target.value)}
            >
              <option value="">Every lifecycle</option>
              {lifecycles.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="store-compliance__filter">
          <Icon name="list" size={16} />
          <select
            value={order}
            aria-label="Sort stores"
            onChange={(event) => setOrder(event.target.value as "urgency" | "name")}
          >
            <option value="urgency">Action needed first</option>
            <option value="name">Store name (A–Z)</option>
          </select>
        </label>
      </div>

      {status !== "all" && (
        <p className="store-compliance__lens">
          Showing stores with at least one document that is{" "}
          <strong>{COMPLIANCE_FILTERS.find((entry) => entry.value === status)?.label}</strong>.
          Other documents stay on the row, faded, so the store is still read in full.
        </p>
      )}

      {priority.length > 0 && (
        <section className="store-compliance__priority" aria-labelledby="store-compliance-priority">
          <h4 id="store-compliance-priority">
            <Icon name="alert" size={16} />
            Needs chasing first
          </h4>
          <ul>
            {priority.map((entry) => (
              <li
                key={`${entry.row.store.id}-${entry.slot.key}`}
                className={`is-${entry.cell.status}`}
              >
                <span className="store-compliance__glyph" aria-hidden="true">
                  {STATUS[entry.cell.status].glyph}
                </span>
                <span className="store-compliance__priority-text">
                  <strong>
                    {entry.slot.label} — {entry.row.store.name}
                  </strong>
                  <span>
                    {STATUS[entry.cell.status].label}
                    {entry.cell.expiry ? ` ${formatDate(entry.cell.expiry)}` : ""}
                    {entry.cell.daysAway !== null ? ` · ${overdueText(entry.cell.daysAway)}` : ""}
                    {" · chased by "}
                    {entry.slot.responsibility}
                    {/* A closed unit only reaches this list once the trading
                        estate is clear, and when it does it says so. */}
                    {entry.row.store.lifecycle ? ` · ${entry.row.store.lifecycle}` : ""}
                  </span>
                </span>
                {/*
                  Chasing an expired certificate is work, and work is a job.
                  Raised from the line that reports the problem, carrying the
                  store and the document, so nobody has to retype either into
                  the board and get one of them wrong.
                */}
                <RaiseTicketButton
                  context={{
                    siteName: entry.row.store.name,
                    complianceKind: entry.slot.label,
                    section: "Compliance",
                    note: `${STATUS[entry.cell.status].label}${
                      entry.cell.expiry ? ` ${formatDate(entry.cell.expiry)}` : ""
                    }. Chased by ${entry.slot.responsibility}.`,
                  }}
                  label="Raise a ticket"
                  // Same reason as the sites table: this control carries a
                  // label, and "quiet" is the icon-only square.
                  variant="secondary"
                  className="store-compliance__raise"
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {visible.length === 0 ? (
        <p className="view-empty">No store has a document matching these filters.</p>
      ) : (
        <div
          className="store-compliance__scroll"
          role="region"
          aria-label="Store compliance matrix, scrollable"
          tabIndex={0}
        >
          <table className="store-compliance__matrix">
            <caption className="visually-hidden">
              Stores down the side, required documents across the top. Each cell gives the
              document&apos;s status and, where one is tracked, its expiry date.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="store-compliance__corner">
                  Store
                </th>
                {slots.map((slot) => (
                  <th key={slot.key} scope="col">
                    <span className="store-compliance__col-label">{slot.label}</span>
                    <span className="store-compliance__col-note">
                      {slot.expiryColumn === null ? "No expiry tracked" : "Expiry tracked"}
                    </span>
                    <span className="store-compliance__col-note">
                      {slot.responsibility}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.store.id}>
                  <th scope="row" className="store-compliance__store">
                    {onOpenStore ? (
                      <button type="button" onClick={() => onOpenStore(row.store.id)}>
                        {row.store.name}
                      </button>
                    ) : (
                      <span>{row.store.name}</span>
                    )}
                    <small>
                      {row.counts.expired > 0 && `${row.counts.expired} expired`}
                      {row.counts.expired > 0 && row.counts.missing > 0 && " · "}
                      {row.counts.missing > 0 && `${row.counts.missing} missing`}
                      {row.counts.expired === 0 &&
                        row.counts.missing === 0 &&
                        (row.counts.due > 0 ? `${row.counts.due} due soon` : "Nothing outstanding")}
                    </small>
                    {/*
                      The board's own word for where this store is in its life.
                      Printed on every row that has one, not only the closed
                      ones: "Closed" only means something next to rows that say
                      "Current stores", and a reader who cannot see the
                      difference cannot judge the counts above.
                    */}
                    {row.store.lifecycle && (
                      <span
                        className={`store-compliance__lifecycle${
                          isClosed(row.store) ? " is-closed" : ""
                        }`}
                      >
                        {row.store.lifecycle}
                      </span>
                    )}
                  </th>

                  {row.cells.map((cell, index) => {
                    const slot = slots[index];
                    if (!slot) return null;
                    const dimmed = status !== "all" && !matchesStatus(status, cell.status);
                    return (
                      <td
                        key={slot.key}
                        className={`store-compliance__cell is-${cell.status}${dimmed ? " is-dimmed" : ""}`}
                      >
                        {/*
                          The scope attributes already associate the row and
                          column headers. This repeats them inside the cell so
                          the announced name identifies the store and the
                          document even where a reader is walked cell by cell
                          with header announcement turned off.
                        */}
                        <span className="visually-hidden">
                          {row.store.name}, {slot.label}:{" "}
                        </span>
                        <span className="store-compliance__glyph" aria-hidden="true">
                          {STATUS[cell.status].glyph}
                        </span>
                        <span className="store-compliance__cell-label">
                          {STATUS[cell.status].label}
                        </span>
                        {cell.expiry && (
                          <span className="store-compliance__cell-date">
                            {formatDate(cell.expiry)}
                            {cell.daysAway !== null && (
                              <>
                                {" "}
                                <span className="visually-hidden">— </span>
                                {overdueText(cell.daysAway)}
                              </>
                            )}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="store-compliance__footnote">
        Showing {visible.length} of {rows.length} stores and {slots.length} of{" "}
        {storeDocumentationCertificates.length} documents
        {lifecycle ? ` in ${lifecycle}` : ""}.{" "}
        {slots.some((slot) => slot.expiryColumn === null) &&
          "RAMS, the Fire Risk Assessment and the Drawing carry no expiry date on the board, so none is shown for them."}
      </p>
    </div>
  );
}

/** "12 days overdue" / "in 9 days" / "today". Plain words, no colour needed. */
function overdueText(days: number): string {
  if (days < 0) {
    const overdue = Math.abs(days);
    return `${overdue} day${overdue === 1 ? "" : "s"} overdue`;
  }
  if (days === 0) return "expires today";
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/* ── Empty state ─────────────────────────────────────────────────────────── */

/**
 * What this tab looks like before the monday export lands.
 *
 * A stores × documents matrix with no stores is a blank grid, and a blank grid
 * reads as a broken page rather than as an empty register. So the empty state
 * says what the tracker will show, and lists the twelve documents it will show
 * it for together with who chases each — which is the one piece of the tracker
 * that is useful before any data exists at all.
 */
function ComplianceTrackerEmpty({ storeCount }: { storeCount: number }) {
  return (
    <section className="store-compliance-empty">
      <span className="store-compliance-empty__mark" aria-hidden="true">
        <Icon name="shield" size={26} />
      </span>
      <h3>
        {storeCount === 0
          ? "No stores have been imported yet"
          : "No documents have been recorded yet"}
      </h3>
      <p>
        {storeCount === 0
          ? "The Compliance Tracker fills in from the Store Documentation UK board. Import the store list, or add stores in the register, and every store will appear here as a row."
          : `${storeCount} store${storeCount === 1 ? " is" : "s are"} on the board, but no certificate has been recorded against ${storeCount === 1 ? "it" : "them"} yet. As documents are attached and expiry dates entered, each one takes its place in the grid below.`}
      </p>
      <p>
        Each store will get one row, each document one column, and each cell will say
        whether the document is held, whether it has lapsed, or whether it was never
        obtained at all — with the expiry date where the board tracks one.
      </p>

      <h4>The {storeDocumentationCertificates.length} documents tracked</h4>
      <div className="store-compliance-empty__scroll">
        <table className="store-compliance-empty__table">
          <caption className="visually-hidden">
            The documents the Compliance Tracker will show, who chases each, and whether an
            expiry date is tracked for it.
          </caption>
          <thead>
            <tr>
              <th scope="col">Document</th>
              <th scope="col">Chased by</th>
              <th scope="col">Expiry</th>
            </tr>
          </thead>
          <tbody>
            {storeDocumentationCertificates.map((slot) => (
              <tr key={slot.key}>
                <th scope="row">{slot.label}</th>
                <td>{slot.responsibility}</td>
                <td>
                  {slot.expiryColumn === null ? "Not tracked on the board" : "Tracked"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
