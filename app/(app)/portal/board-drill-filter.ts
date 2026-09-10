/**
 * THE FILTER A DRILL-THROUGH CARRIES, APPLIED TO THE JOB LIST.
 *
 * ── THE PROBLEM THIS FIXES ────────────────────────────────────────────────
 *
 * Every chart on the Overview drills through to the Jobs list, and the adapter
 * that performs it says so out loud: "The board does not yet read every one of
 * these parameters; what it does read it reads from the URL, and the ones it
 * does not are inert rather than misleading."
 *
 * Measured, the board read NONE of them. `live-board.tsx` touches
 * `searchParams` exactly once, to set `?item=` when a row is opened. So tapping
 * a meter tile — §2.3's "the whole tile is a button → Jobs list filtered to
 * that meter's statuses" — landed on the unfiltered board, and the reader was
 * left to find 65 rows among 981 themselves.
 *
 * ── WHY THE FILTER IS APPLIED HERE AND NOT IN THE BOARD ───────────────────
 *
 * `live-board.tsx` is held under 5,600 lines by
 * `tests/workstream-seven-official-document-ui.test.mjs` and currently sits at
 * 5,593. Seven lines is not room for a URL parser, a predicate and a chip row,
 * and trimming comments to make room is explicitly ruled out.
 *
 * It does not need to be there. The board is HANDED its rows by the shell, so
 * filtering the list on the way in produces exactly the same screen with none
 * of the board's own code touched — its meters, its groups, its views and its
 * search all operate on the rows they are given, which is what makes the
 * filtered board internally consistent rather than a board with a caption.
 *
 * ── WHAT IT UNDERSTANDS ───────────────────────────────────────────────────
 *
 * The Overview's own vocabulary, because that is what the Overview sends: the
 * nine filter dimensions, the cohort axis and its window, and `meter`. Anything
 * else in the query string is ignored rather than guessed at.
 *
 * Every comparison is on a normalised copy, for the reason every other status
 * comparison in this product is: the stored labels have been through a
 * spreadsheet and a form, so "In Progress" and "in  progress" are one status.
 */

import { statusFamily, statusKey } from "../../lib/job-metrics.ts";
import { COMPLETED_STAGE, completedStatuses } from "./dashboard-meters.ts";
import type { MaintenanceRequest } from "../../lib/types";

/** Trim, lower-case, collapse runs of whitespace. The shared normalisation. */
function key(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** `YYYY-MM-DD` from whatever shape a date column arrived in. */
function day(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.slice(0, 10);
}

const URGENT = new Set(["urgent", "critical", "p1"]);
const MEDIUM = new Set(["medium", "normal", "standard"]);
const LOW = new Set(["low"]);

function priorityKey(value: string | null | undefined): string {
  const normalised = key(value);
  if (URGENT.has(normalised)) return "urgent";
  if (MEDIUM.has(normalised)) return "medium";
  if (LOW.has(normalised)) return "low";
  return "not_recorded";
}

/**
 * PLANNED VERSUS REACTIVE — the same inference `plannedCondition` makes in SQL.
 *
 * Duplicated deliberately and narrowly: `dashboard-filters.ts` expresses the
 * rule as a drizzle `sql` fragment, which cannot be evaluated against a plain
 * object, and importing that module here would pull drizzle into the shell's
 * bundle. `tests/overview-drill-filter.test.mjs` pins the two to the same
 * answer so they cannot drift.
 */
function isPlanned(request: MaintenanceRequest): boolean {
  return key(request.category).includes("compliance") || (request.tier ?? 0) >= 4;
}

/**
 * CLOSED, BY THE AGGREGATE'S OWN VOCABULARY.
 *
 * `closedJobSql` is `stage = 'Completed' OR status IN completedStatuses`, and
 * the drill has to agree with it exactly or the list is a different population
 * from the figure that opened it. It cannot simply ask `statusFamily`: that
 * falls back to `in_progress` for a label it does not know, so a job whose
 * STAGE says completed but whose status label is unmapped is closed to the
 * aggregate and open to the drill.
 *
 * Measured before this: the Pulse "urgent open" tile read 15 and the board it
 * opened showed 20.
 */
const CLOSED_STATUS_KEYS = new Set(completedStatuses.map((label) => statusKey(label)));

function isClosed(request: MaintenanceRequest): boolean {
  if ((request.stage ?? "") === COMPLETED_STAGE) return true;
  return CLOSED_STATUS_KEYS.has(statusKey(request.status));
}

/**
 * The rows that count as work at all — `liveWorkOrderCondition`'s three
 * exclusions, as far as a row in the browser can express them.
 *
 * The aggregates drop binned, archived and sub-item rows before counting
 * anything; the drill dropped none of them. Of the 23 urgent non-completed
 * jobs in one measured window, five were archived, which is most of the gap
 * between a tile reading 15 and a board showing 20. The shell has already
 * removed deleted rows by the time it hands the list over, so `archived` and
 * the sub-item test are the two that still matter here.
 */
/**
 * Open, and past the date it was due — `overdueOpenSql` in the browser.
 *
 * Day versus instant is the whole subtlety. `due_at` holds a bare
 * `YYYY-MM-DD` for work booked to a day and a full timestamp for work booked
 * to a time, and the two cannot be compared the same way: treating a bare day
 * as UTC midnight marks everything due today as already late. So a bare date
 * is late only once the day has PASSED, and a timestamp is late once the
 * instant has.
 */
function isOverdue(request: MaintenanceRequest, now: Date): boolean {
  if (isClosed(request)) return false;
  const due = String(request.dueAt ?? "").trim();
  if (!due) return false;
  if (due.length <= 10) return due.slice(0, 10) < isoDay(now);
  const at = Date.parse(due);
  return Number.isFinite(at) && at < now.getTime();
}

function countsAsWork(request: MaintenanceRequest): boolean {
  return request.archived !== true && !request.parentId;
}

export type DrillChip = { key: string; label: string; value: string };

export type DrillFilter = {
  /** True when the URL carried nothing this filter understands. */
  empty: boolean;
  /** One chip per active dimension — §2.3's "one chip named after the meter". */
  chips: DrillChip[];
  matches: (request: MaintenanceRequest) => boolean;
};

const EMPTY: DrillFilter = { empty: true, chips: [], matches: () => true };

/**
 * The window a period token resolves to, as two `YYYY-MM-DD` bounds.
 *
 * The end is TOMORROW rather than today, and exclusive, for the same reason
 * `resolveWindow` in `dashboard-filters.ts` does it: a job raised an hour ago
 * must be inside "the last 7 days". The arithmetic is repeated rather than
 * imported because that module is server-shaped; the two are pinned together.
 */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` for an instant, on the UTC calendar. */
function isoDay(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(
    at.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** A day string moved by whole days. Calendar arithmetic, not 86.4e6 ms. */
function shiftDayString(day: string, by: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + by);
  return isoDay(at);
}

function resolveDays(period: string, from: string, to: string, now: Date) {
  const today = isoDay(now);
  const tomorrow = shiftDayString(today, 1);

  switch (period) {
    case "all":
      /* Unbounded at the start, but still ending TOMORROW: a job dated in the
         future is not part of "all time" on either side of the drill. */
      return { start: null, endExclusive: tomorrow };
    case "month":
      return { start: `${today.slice(0, 7)}-01`, endExclusive: tomorrow };
    case "last-month": {
      const firstOfThis = `${today.slice(0, 7)}-01`;
      return {
        start: `${shiftDayString(firstOfThis, -1).slice(0, 7)}-01`,
        endExclusive: firstOfThis,
      };
    }
    case "ytd":
      return { start: `${today.slice(0, 4)}-01-01`, endExclusive: tomorrow };
    case "custom": {
      const start = DAY_PATTERN.test(from) ? from : shiftDayString(today, -90);
      const rawEnd = DAY_PATTERN.test(to) ? shiftDayString(to, 1) : tomorrow;
      /* A reversed range is a typo, not a query — swapped rather than refused,
         exactly as `resolveWindow` does it. */
      const [lo, hi] = start < rawEnd ? [start, rawEnd] : [rawEnd, start];
      return { start: lo, endExclusive: hi };
    }
    default: {
      const days = Number(period);
      if (!Number.isFinite(days) || days <= 0) return null;
      return { start: shiftDayString(tomorrow, -days), endExclusive: tomorrow };
    }
  }
}

/**
 * Read a drill-through out of a query string.
 *
 * `meter` and `status` travel together: the meter key is what the chip is
 * NAMED after — §2.3 asks for one chip named after the meter, not five status
 * names — and the pipe-joined status list is what actually selects the rows, so
 * the filter does not need this screen to know the meter model.
 */
export function readDrillFilter(
  searchParams: URLSearchParams,
  now: Date = new Date(),
): DrillFilter {
  const list = (name: string) =>
    searchParams
      .getAll(name)
      .flatMap((value) => value.split("|"))
      .map((value) => value.trim())
      .filter(Boolean);

  const statuses = new Set(list("status").map(key));
  const sites = new Set(list("site"));
  const priorities = new Set(list("priority"));
  const tiers = new Set(list("tier"));
  const engineers = new Set(list("engineer").map(key));
  const labels = new Set(list("label").map(key));
  const contractors = new Set(list("contractor").map(key));
  const natures = new Set(list("nature"));
  /*
   * THE STAGE AXIS, WHICH USED TO BE INERT.
   *
   * `family` was in `DRILL_KEYS` — so "Clear" stripped it — but nothing here
   * ever read it, and three call sites send it meaning "open": the Pulse's
   * open figure, the performance card, and §6.3's "Jobs filtered to that site
   * AND OPEN". Unread, every one of those drilled to a list that included
   * completed jobs, so the list was always longer than the number that opened
   * it.
   *
   * `open` is accepted alongside the three real families because it is the
   * thing those callers actually mean, and it is NOT a synonym for
   * `in_progress`: the model is completed / in_progress / attention, so a job
   * needing attention is open too, and filtering to `in_progress` alone would
   * under-report the very figure the reader tapped.
   */
  const families = new Set(list("family").map((value) => value.toLowerCase()));
  /*
   * OVERDUE, WHICH USED TO BE UNSAYABLE.
   *
   * The Overview's Overdue tile and its SLA speedometer both mean "open work
   * that is past its date", and this filter had no due-date dimension at all —
   * so the only honest thing those controls could send was `family=open`, a
   * superset. On the estate they were built against that is a tile reading 73
   * opening a board of 98: the same "list wider than the figure" fault the
   * archived rows caused, arriving from the other direction.
   *
   * The test mirrors `overdueOpenSql`, which is the aggregate's own: a BARE
   * `YYYY-MM-DD` is compared as a day, so a job due today is not yet late,
   * while a full timestamp is compared as an instant. Getting that backwards
   * marks everything due today as overdue for every reader west of Greenwich.
   */
  const overdueOnly = searchParams.get("overdue") === "1";
  const meterLabel = (searchParams.get("meter") ?? "").trim();

  const measure = searchParams.get("measure") === "completed" ? "completed" : "requested";
  const window = resolveDays(
    (searchParams.get("period") ?? "").trim(),
    (searchParams.get("from") ?? "").trim(),
    (searchParams.get("to") ?? "").trim(),
    now,
  );

  const chips: DrillChip[] = [];
  if (meterLabel) chips.push({ key: "meter", label: "Meter", value: meterLabel.replace(/_/g, " ") });
  else if (statuses.size) chips.push({ key: "status", label: "Status", value: `${statuses.size} selected` });
  if (sites.size) chips.push({ key: "site", label: "Site", value: [...sites].join(", ") });
  if (priorities.size) chips.push({ key: "priority", label: "Priority", value: [...priorities].join(", ") });
  if (tiers.size) chips.push({ key: "tier", label: "Tier", value: [...tiers].join(", ") });
  if (engineers.size) chips.push({ key: "engineer", label: "Engineer", value: [...engineers].join(", ") });
  if (labels.size) chips.push({ key: "label", label: "Label", value: [...labels].join(", ") });
  if (contractors.size) chips.push({ key: "contractor", label: "Contractor", value: [...contractors].join(", ") });
  if (natures.size) chips.push({ key: "nature", label: "Nature", value: [...natures].join(", ") });
  if (families.size) {
    chips.push({
      key: "family",
      label: "Stage",
      value: [...families].map((value) => value.replace(/_/g, " ")).join(", "),
    });
  }
  if (overdueOnly) chips.push({ key: "overdue", label: "Overdue", value: "past its date" });
  if (window) {
    chips.push({
      key: "period",
      label: measure === "completed" ? "Completed" : "Requested",
      value: `${window.start ?? "any"} to ${window.endExclusive}`,
    });
  }

  if (chips.length === 0) return EMPTY;

  return {
    empty: false,
    chips,
    matches(request) {
      /* Applied to EVERY drill, not only the stage axis: a figure counted with
         archived and sub-item rows excluded must not open a list that puts
         them back. */
      if (!countsAsWork(request)) return false;
      if (statuses.size && !statuses.has(key(request.status))) return false;
      if (sites.size) {
        /* `__unassigned__` is the Overview's sentinel for a job whose site is
           blank OR points at an id the register does not hold. The shell cannot
           check the register from here, so it treats blank and the known
           placeholder as unassigned — the same two shapes
           `unassignedSiteCondition` catches. */
        const siteId = (request.siteId ?? "").trim();
        const unassigned = !siteId || siteId === "site-unassigned";
        const wanted = sites.has("__unassigned__") && unassigned;
        if (!wanted && !sites.has(siteId)) return false;
      }
      if (priorities.size && !priorities.has(priorityKey(request.priority))) return false;
      if (tiers.size) {
        const tier = request.tier === null || request.tier === undefined ? "" : String(request.tier);
        const notRecorded = tiers.has("__not_recorded__") && !tier;
        if (!notRecorded && !tiers.has(tier)) return false;
      }
      if (engineers.size) {
        const engineer = key(request.engineer);
        const notRecorded = engineers.has(key("__not_recorded__")) && !engineer;
        if (!notRecorded && !engineers.has(engineer)) return false;
      }
      if (labels.size) {
        const label = key(request.category);
        const notRecorded = labels.has(key("__not_recorded__")) && !label;
        if (!notRecorded && !labels.has(label)) return false;
      }
      if (contractors.size) {
        /* Two shapes, exactly as `loadCost` keys them: a contractor id, or
           `name:<lowercased>` when the job carries typed text only. */
        const id = (request.contractorId ?? "").trim();
        const named = `name:${key(request.contractor)}`;
        if (!contractors.has(key(id)) && !contractors.has(named)) return false;
      }
      if (natures.size) {
        const nature = isPlanned(request) ? "planned" : "reactive";
        if (!natures.has(nature)) return false;
      }
      if (overdueOnly && !isOverdue(request, now)) return false;
      if (families.size) {
        /* `warn: false` — an unmapped status is a data condition the Overview
           already reports in its own words; it must not also spray the
           browser console once per row. */
        const family = statusFamily(request.status, { warn: false });
        /* `open` is the AGGREGATE's closure test, not `family !== "completed"`
           — see `isClosed`. The three named families keep the family model,
           which is what they are for. */
        if (!families.has(family) && !(families.has("open") && !isClosed(request))) {
          return false;
        }
      }
      if (window) {
        const axis = day(measure === "completed" ? request.completedAt : request.requestedAt);
        if (!axis) return false;
        if (window.start && axis < window.start) return false;
        if (axis >= window.endExclusive) return false;
      }
      return true;
    },
  };
}

/** The parameters a "Clear" control on the board strips. */
export const DRILL_KEYS = [
  "meter",
  "status",
  "site",
  "priority",
  "tier",
  "engineer",
  "label",
  "contractor",
  "nature",
  "family",
  "overdue",
  "period",
  "from",
  "to",
  "measure",
  "split",
] as const;
