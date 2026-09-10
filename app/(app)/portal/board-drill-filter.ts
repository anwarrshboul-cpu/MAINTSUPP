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
function resolveDays(period: string, from: string, to: string, now: Date) {
  const iso = (at: Date) =>
    `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(
      at.getUTCDate(),
    ).padStart(2, "0")}`;
  const tomorrow = iso(new Date(now.getTime() + 86_400_000));
  if (period === "custom") {
    if (!from && !to) return null;
    const start = from || null;
    const endExclusive = to
      ? iso(new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000))
      : tomorrow;
    return { start, endExclusive };
  }
  if (period === "all") return null;
  const days = Number(period);
  if (!Number.isFinite(days) || days <= 0) return null;
  return { start: iso(new Date(now.getTime() - days * 86_400_000)), endExclusive: tomorrow };
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
  "period",
  "from",
  "to",
  "measure",
  "split",
] as const;
