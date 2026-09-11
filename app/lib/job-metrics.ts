/**
 * WHAT "OPEN" MEANS, AND WHO IS ALLOWED TO SAY SO.
 *
 * One module, imported by the Overview, the Sites list, the Contractors
 * register, the sidebar badge and every `/api/dashboard/*` aggregate. Before it
 * existed the product carried two vocabularies for the same nine-ish statuses
 * and they disagreed on screen:
 *
 *   • `dashboard-meters.ts` partitioned rows with `isOpenRequest` /
 *     `isClosedRequest` — stage `Completed`, or the status "Job Completed".
 *     That partition is correct, it has a SQL twin in `/api/workspace`, and it
 *     is preserved here EXACTLY. It is now expressed as a family rather than
 *     re-derived, which is the only change.
 *
 *   • `jobStatusSegments` in `portal-app.tsx` invented a second taxonomy —
 *     Open / In progress / Awaiting parts / On hold / Scheduled — and drew the
 *     Overview's "Jobs by status" donut from it. Three of those five buckets
 *     could never be non-zero on this estate, and because "Pending Approval"
 *     falls into its approval set, four fifths of the board landed in a segment
 *     labelled "On hold" — jobs nobody had put on hold. That taxonomy is
 *     deleted, not remapped, and this module is what replaced it.
 *
 * ── STATUSES ARE DATA, AND THIS MAP IS A FLOOR, NOT A FENCE ────────────────
 *
 * Statuses came out of monday and the operator adds to them. `job_status_map`
 * (seeded in `db/init.ts`, editable in admin) already owns per-status COLOUR
 * and `counts_as_open`; this module owns the analytic FAMILY, which is a
 * different question — "is this work stuck?" rather than "what colour is the
 * chip?".
 *
 * A status with no entry resolves to `in_progress` and is REPORTED: the
 * client logs it once by name, and every aggregate endpoint returns the
 * unmapped labels it met so the UI can say so. Silence is what let the fake
 * taxonomy survive; an unmapped status must be visible, never swallowed.
 *
 * Nothing here imports React, a hook or a component. It is used from route
 * handlers, from client components and from tests, and the aggregates build
 * their SQL from the same arrays the browser filters on — see
 * `completedStatuses` and `statusLabelsInFamily()`.
 */

/*
 * The `.ts` extension is deliberate and `allowImportingTsExtensions` is already
 * on in tsconfig.
 *
 * With it, Node can load this module directly — `node --test` strips the types
 * natively — so the rules below are asserted by CALLING them rather than by
 * transpiling the file to a `data:` URL, which is what
 * `dashboard-meters.ts` has to do and is exactly why that file may have no
 * runtime imports at all. Importable code is testable code.
 */
import {
  COMPLETED_STAGE,
  completedStatuses,
} from "../(app)/portal/dashboard-meters.ts";
import type { MaintenanceRequest } from "./types";

export { COMPLETED_STAGE, completedStatuses };

/* ── Families ─────────────────────────────────────────────────────────────── */

/**
 * The three families every job belongs to, and the only vocabulary a dashboard
 * card is allowed to group by.
 *
 * Three rather than five because these are the three ANSWERS a facilities
 * manager acts on: it is finished, it is moving, or it is stuck and needs a
 * person. The individual status still renders beside the family everywhere —
 * see the two-level Status meter — so no detail is lost by grouping.
 */
export type JobStatusFamily = "completed" | "in_progress" | "attention";

export const JOB_STATUS_FAMILIES: readonly JobStatusFamily[] = [
  "completed",
  "in_progress",
  "attention",
] as const;

/** The words a family is printed with. Sentence case; never all-caps. */
export const FAMILY_LABEL: Record<JobStatusFamily, string> = {
  completed: "Completed",
  in_progress: "In progress",
  attention: "Needs attention",
};

/**
 * Semantic colours, fixed. These three are never reassigned to anything else on
 * any surface, which is what lets a reader learn them once.
 */
export const FAMILY_COLOUR: Record<JobStatusFamily, string> = {
  completed: "#22C55E",
  in_progress: "#3B82F6",
  attention: "#E5484D",
};

/**
 * THE CLOSURE VOCABULARY IS NOT DECLARED HERE, AND THAT IS THE POINT.
 *
 * `COMPLETED_STAGE` and `completedStatuses` come from
 * `app/(app)/portal/dashboard-meters.ts`, re-exported above so a reader of this
 * module has them to hand without a second import. The dependency points that
 * way rather than the other because that file must have NO runtime imports —
 * seven suites transpile it alone and load it from a `data:` URL, where a
 * relative specifier cannot resolve — and because `/api/workspace`'s SQL
 * predicate is already built by spreading that same array.
 *
 * So there is exactly one place a label can be added to close a job, and adding
 * one there changes the browser predicate, the SQL predicate and the family map
 * below in a single edit. "Completion Invoice Paid" reads like a finished job
 * and is deliberately absent: closure on this board is a board act, and the
 * invoice columns describe money rather than work.
 *
 * Every match is whole-value. Nothing here matches a substring, because "Third
 * Party Delay" contains "part" and that one false positive was once an entire
 * meter.
 */

/**
 * Every status this product has seen, and the family it belongs to.
 *
 * Three sources, merged: monday's 23 Status labels from
 * `db/monday-export/MAINTENANCE-MONDAY-CAPTURE.md`, the labels the seeded
 * estate writes, and the ones an operator has typed since. Keys are normalised
 * on the way in by `statusKey`, so spelling that survived a spreadsheet round
 * trip still lands.
 *
 * `attention` means a human is blocking the work — approval, payment, access,
 * a decision, a third party, a safety hold. `in_progress` means the system is
 * carrying it. The split is what makes "Needs attention" a worklist rather than
 * a synonym for "open".
 */
const OPEN_STATUS_FAMILY: Record<string, JobStatusFamily> = {
  /* ── Moving ───────────────────────────────────────────────────────────── */
  new: "in_progress",
  reported: "in_progress",
  "pending approval": "in_progress",
  "awaiting approval": "in_progress",
  "pending scheduling": "in_progress",
  "job scheduled": "in_progress",
  scheduled: "in_progress",
  booked: "in_progress",
  "job in progress": "in_progress",
  "in progress": "in_progress",
  "major works": "in_progress",
  "quote requested": "in_progress",
  "quote required": "in_progress",
  "quote received (waiting for approval)": "in_progress",
  "quote approved": "in_progress",
  "deposit invoice received": "in_progress",
  "deposit invoice paid": "in_progress",
  "completion invoice received": "in_progress",
  "completion invoice paid": "in_progress",

  /* ── Stuck ────────────────────────────────────────────────────────────── */
  "blocked - awaiting response": "attention",
  "blocked – awaiting response": "attention",
  "awaiting landlord approval": "attention",
  "parked — landlord approval": "attention",
  "parked - landlord approval": "attention",
  "waiting for parts": "attention",
  "awaiting parts": "attention",
  "health and safety hold": "attention",
  "waiting for payment": "attention",
  "waiting for decisions": "attention",
  "awaiting access": "attention",
  "no access": "attention",
  "on hold": "attention",
  escalated: "attention",
  "third party delay": "attention",
  "quote rejected": "attention",
  "awaiting subcontractor quote": "attention",
  "deferred to capex programme": "attention",
};

/**
 * The map the product reads: every open-family label above, plus the closure
 * vocabulary folded in from `completedStatuses`.
 *
 * Folded rather than typed out, so `isClosedJob` here and `isClosedRequest` in
 * `dashboard-meters.ts` cannot come to different answers about the same row —
 * they are reading one array. The closure half is applied LAST so a label that
 * appears in both is closed, which is the safe direction: a status somebody has
 * declared to be a closure is not simultaneously a reason to chase the job.
 */
export const STATUS_FAMILY: Record<string, JobStatusFamily> = {
  ...OPEN_STATUS_FAMILY,
  ...Object.fromEntries(
    completedStatuses.map((label) => [statusKey(label), "completed" as const]),
  ),
};

/**
 * The family a status falls back to when the map has never heard of it.
 *
 * `in_progress` rather than `attention` or `completed`, and the direction is
 * deliberate in both places it could go wrong: calling it completed would drop
 * a live job out of every open count without trace, and calling it attention
 * would put a red flag on work nobody has said is stuck. In progress is the
 * one answer that is visible and accuses nobody.
 */
export const UNMAPPED_STATUS_FAMILY: JobStatusFamily = "in_progress";

/**
 * Case- and whitespace-insensitive, because these labels have been through a
 * spreadsheet, a CSV round trip and a human. "In Progress", "in progress" and
 * "In  progress" are one status; three colours for one status on one screen is
 * the bug this prevents.
 */
export function statusKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Statuses met at runtime that `STATUS_FAMILY` has no entry for. */
const unmappedSeen = new Set<string>();

/**
 * The family of one status label.
 *
 * The warning fires ONCE per distinct label per process rather than per row:
 * a 700-row board with one unmapped status would otherwise write 700 identical
 * lines and teach whoever reads the console to ignore it.
 */
export function statusFamily(
  status: string | null | undefined,
  options: { warn?: boolean } = {},
): JobStatusFamily {
  const key = statusKey(status);
  const family = STATUS_FAMILY[key];
  if (family) return family;
  if (key && options.warn !== false && !unmappedSeen.has(key)) {
    unmappedSeen.add(key);
    console.warn(
      `[job-metrics] Job status "${status}" is not in STATUS_FAMILY. Counting it as "${UNMAPPED_STATUS_FAMILY}". Add it to app/lib/job-metrics.ts.`,
    );
  }
  return UNMAPPED_STATUS_FAMILY;
}

/** Every status label this process has met and could not place. */
export function unmappedStatuses(): string[] {
  return [...unmappedSeen].sort();
}

/** Every status label the map places in one family — the SQL builders' source. */
export function statusLabelsInFamily(family: JobStatusFamily): string[] {
  return Object.entries(STATUS_FAMILY)
    .filter(([, value]) => value === family)
    .map(([key]) => key);
}

/* ── The partition ────────────────────────────────────────────────────────── */

/**
 * The family of a whole job, stage included.
 *
 * The STAGE wins when it says completed. That is not a preference, it is the
 * existing contract: the imported rows sit in monday's "… Recently completed"
 * groups carrying a lifecycle stage and, in some cases, a status the board
 * never updated. `isClosedRequest` has read `stage === "Completed" || status
 * === "Job Completed"` since the day the two screens were reconciled, and this
 * function is that rule with the other two families added underneath it.
 */
export function jobFamily(
  request: Pick<MaintenanceRequest, "stage" | "status">,
  options: { warn?: boolean } = {},
): JobStatusFamily {
  if (request.stage === COMPLETED_STAGE) return "completed";
  return statusFamily(request.status, options);
}

/** Closed. The other half of the partition, and nothing else. */
export function isClosedJob(
  request: Pick<MaintenanceRequest, "stage" | "status">,
): boolean {
  return jobFamily(request, { warn: false }) === "completed";
}

/**
 * Open — every job whose family is not `completed`.
 *
 * Open and closed are a partition of the rows in view, so any two figures built
 * from them sum to the row count. That invariant is what lets the Overview, the
 * sidebar badge, the Sites meters and the Contractors register be checked
 * against each other rather than taken on trust.
 */
export function isOpenJob(
  request: Pick<MaintenanceRequest, "stage" | "status">,
): boolean {
  return !isClosedJob(request);
}

/** Open, and stuck behind a person. A subset of open, never of everything. */
export function needsAttention(
  request: Pick<MaintenanceRequest, "stage" | "status">,
): boolean {
  return jobFamily(request, { warn: false }) === "attention";
}

/** The count the sidebar badge and the Overview's first tile both print. */
export function openJobCount(
  requests: readonly Pick<MaintenanceRequest, "stage" | "status">[],
): number {
  return requests.reduce((total, request) => total + (isOpenJob(request) ? 1 : 0), 0);
}

/** Closed jobs, for the same reason. */
export function closedJobCount(
  requests: readonly Pick<MaintenanceRequest, "stage" | "status">[],
): number {
  return requests.length - openJobCount(requests);
}

/** Open jobs waiting on a person. */
export function attentionJobCount(
  requests: readonly Pick<MaintenanceRequest, "stage" | "status">[],
): number {
  return requests.reduce(
    (total, request) => total + (needsAttention(request) ? 1 : 0),
    0,
  );
}

/* ── Ageing ───────────────────────────────────────────────────────────────── */

export type AgeingBandKey = "fresh" | "ageing" | "overdue" | "critical";

export type AgeingBand = {
  key: AgeingBandKey;
  label: string;
  /** Inclusive lower bound, in whole days open. */
  from: number;
  /** Inclusive upper bound, or null for the open-ended band. */
  to: number | null;
  colour: string;
  /** The range in words — "0–14 days". Colour is never the only carrier. */
  range: string;
};

/**
 * The four bands, replacing the old 0–7 / 8–30 / 31–90 / 90+.
 *
 * Exported once and used by every card that shows age, so a job that is amber
 * on the Overview is amber on the site row and amber in the contractor's
 * detail. Two sets of boundaries is how the same job came to be "ageing" on one
 * screen and "fresh" on another.
 */
export const AGEING_BANDS: readonly AgeingBand[] = [
  { key: "fresh", label: "Fresh", from: 0, to: 14, colour: "#4ADE80", range: "0–14 days" },
  { key: "ageing", label: "Ageing", from: 15, to: 30, colour: "#E8A33D", range: "15–30 days" },
  { key: "overdue", label: "Overdue", from: 31, to: 60, colour: "#F97316", range: "31–60 days" },
  { key: "critical", label: "Critical", from: 61, to: null, colour: "#E5484D", range: "60+ days" },
] as const;

/** The band a number of days open falls in. Never returns undefined. */
export function ageingBand(daysOpen: number): AgeingBand {
  const days = Number.isFinite(daysOpen) ? Math.max(0, Math.floor(daysOpen)) : 0;
  for (const band of AGEING_BANDS) {
    if (band.to === null || days <= band.to) return band;
  }
  return AGEING_BANDS[AGEING_BANDS.length - 1];
}

/**
 * Days a job has been open, from a pair of instants.
 *
 * The aggregates compute this in SQL and send the number; this exists for the
 * two places that already hold both dates — a job row rendered from a payload
 * that carries `requestedAt`, and the tests. Device clocks are not trusted for
 * BANDING, which is why the endpoints do the arithmetic and the browser only
 * ever colours what it is given.
 */
export function daysOpenBetween(
  raisedAt: string | null | undefined,
  now: number,
): number | null {
  if (!raisedAt) return null;
  const raised = new Date(raisedAt).getTime();
  if (!Number.isFinite(raised)) return null;
  return Math.max(0, Math.floor((now - raised) / 86_400_000));
}

/* ── Overdue ──────────────────────────────────────────────────────────────── */

/**
 * PAST ITS DUE DATE — the browser half of a two-language rule.
 *
 * Its SQL twin is `overdueOpenSql` in `app/lib/dashboard-aggregates.ts`, and
 * the two answer the same question the same way. This one moved here out of
 * `portal-app.tsx`, where it could only be tested by slicing the function out
 * of the file by its braces and re-evaluating it; importable code is testable
 * code, and four tests already depend on this behaviour.
 *
 * THE DISTINCTION IS THE WHOLE POINT. A due value that is a BARE `YYYY-MM-DD`
 * is a day, and a day is not missed until it is over — treating it as UTC
 * MIDNIGHT marked every job due today as overdue for anyone west of Greenwich.
 * A due value carrying a TIME is an instant, and it is missed the moment it
 * passes. Anything unparseable is never overdue, which is the safe direction:
 * an unreadable date is a data problem, not an accusation.
 *
 * THE DAY IS UTC, AND IT USED TO BE LOCAL. `duePassed` in `portal-app.tsx`
 * measured the end of the READER's day, through `endOfDay(parseStamp(...))`.
 * That is the wrong calendar twice over: it disagrees with every other
 * date-only value in this product — `expiryStatus` and `todayBoardDate()` both
 * define "today" in UTC, so a certificate and a job due on the same date would
 * expire on different days — and it cannot be computed on the server at all,
 * where the count in the Performance card is SQL and a server's local timezone
 * is nobody's. The same job is now late at the same instant for every reader.
 *
 * Written without `period-model.ts` on purpose, so the rule can be imported by
 * a route handler and by a test without dragging a client module in behind it.
 */
export function duePassed(dueAt: string | null | undefined, now: number): boolean {
  const value = (dueAt ?? "").trim();
  if (!value) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    // The last millisecond of that calendar day, in UTC.
    return Date.UTC(year, month - 1, day, 23, 59, 59, 999) < now;
  }
  const stamp = new Date(value).getTime();
  return Number.isFinite(stamp) && stamp < now;
}

/** Overdue is only ever asserted of OPEN work. Finished work cannot be late. */
export function isOverdue(
  request: Pick<MaintenanceRequest, "stage" | "status" | "dueAt">,
  now: number,
): boolean {
  return isOpenJob(request) && duePassed(request.dueAt, now);
}

/* ── Priority ─────────────────────────────────────────────────────────────── */

export type PriorityKey = "urgent" | "medium" | "low" | "not_recorded";

export type PriorityBand = { key: PriorityKey; label: string; colour: string };

/**
 * Priority in the fixed order it is always drawn in, most severe first.
 *
 * "Not recorded" is one of the four, not an absence. On this estate the blank
 * is a real and actionable population — a job nobody has triaged — and a chart
 * that omits it reports a cleaner board than exists.
 */
export const PRIORITY_BANDS: readonly PriorityBand[] = [
  { key: "urgent", label: "Urgent", colour: "#E5484D" },
  { key: "medium", label: "Medium", colour: "#E8A33D" },
  { key: "low", label: "Low", colour: "#4ADE80" },
  { key: "not_recorded", label: "Not recorded", colour: "#64748B" },
] as const;

/**
 * The colour of anything nobody has filled in, anywhere on these four pages.
 *
 * One value, because "not recorded" has to be learnable as a colour across
 * five different charts on the Overview alone.
 */
export const NOT_RECORDED_COLOUR = "#64748B";
export const NOT_RECORDED_LABEL = "Not recorded";

/**
 * A stored priority to one of four keys.
 *
 * The legacy importer stringified monday's blank cells, so rows carry the
 * literal sixteen characters "[object Object]" where a priority should be.
 * Those are not a priority and they are not a fifth band; they are missing
 * data, and they land in `not_recorded` with everything else that is blank.
 */
export function normalisePriority(value: string | null | undefined): PriorityKey {
  const key = statusKey(value);
  if (!key || key === "[object object]") return "not_recorded";
  if (key === "urgent" || key === "critical" || key === "p1") return "urgent";
  if (key === "medium" || key === "normal" || key === "standard") return "medium";
  if (key === "low") return "low";
  return "not_recorded";
}

/** Whether a job is urgent, by the one rule every surface uses. */
export function isUrgent(request: Pick<MaintenanceRequest, "priority">): boolean {
  return normalisePriority(request.priority) === "urgent";
}

/* ── Sites ────────────────────────────────────────────────────────────────── */

/**
 * The bucket a job with no site lands in, and why it is a value rather than a
 * blank.
 *
 * "Sites needing attention" used to render a row with an empty name holding
 * the single largest cluster of open work on the board. It was not hidden by a
 * filter — it was simply unlabelled, so the biggest problem on the page looked
 * like a rendering fault and was scrolled past. A null site is now a named
 * bucket with its own id, so it can be sorted, filtered, linked to and counted
 * like any other.
 */
/**
 * PLANNED VERSUS REACTIVE — the two words, and nothing else.
 *
 * The rule that decides which a job is cannot live here, because it is SQL
 * against columns this module deliberately does not import. It lives in
 * `dashboard-filters.plannedCondition`. What lives here is the vocabulary the
 * browser needs to draw a legend and name a filter chip, so the client never
 * has to import the query builder to render two words.
 */
export const NATURE_KEYS = ["reactive", "planned"] as const;
export type NatureKey = (typeof NATURE_KEYS)[number];

export const NATURE_LABEL: Record<NatureKey, string> = {
  reactive: "Reactive",
  planned: "Planned",
};

export const NATURE_COLOUR: Record<NatureKey, string> = {
  reactive: "#E8A33D",
  planned: "#3B82F6",
};

export const UNASSIGNED_SITE_ID = "__unassigned__";
export const UNASSIGNED_SITE_LABEL = "Unassigned site";

/** The site key a job groups under, never null. */
export function siteKeyOf(
  request: Pick<MaintenanceRequest, "siteId">,
): string {
  const id = (request.siteId ?? "").trim();
  return id || UNASSIGNED_SITE_ID;
}

/* ── Dimension keys ───────────────────────────────────────────────────────── */

/** The five dimensions the Job breakdown card splits by. */
export const BREAKDOWN_DIMENSIONS = [
  "tier",
  "engineer",
  "priority",
  "label",
  "status",
] as const;

export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

export const DIMENSION_LABEL: Record<BreakdownDimension, string> = {
  tier: "Tier level",
  engineer: "Engineer required",
  priority: "Priority",
  label: "Label",
  status: "Status",
};

/**
 * The categorical ramp, assigned BY BUCKET KEY rather than by position.
 *
 * A label keeps its colour when the period changes and the ordering moves,
 * which is the whole point: a reader who learns that amber is "Plumbing" must
 * not have that unlearned by picking 30 days instead of 90.
 */
export const CATEGORICAL_COLOURS = [
  "#E8A33D",
  "#4ADE80",
  "#3B82F6",
  "#F5D547",
  "#A78BFA",
  "#EC4899",
  "#22D3EE",
  "#C4B04A",
] as const;

/** A stable colour for a bucket key. Same key, same colour, every session. */
export function categoricalColour(key: string): string {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return CATEGORICAL_COLOURS[hash % CATEGORICAL_COLOURS.length];
}

/* ── The Jobs board population ────────────────────────────────────────────── */

/**
 * THE BOARD A JOB LIVES ON, AND THE ONLY ONE THE JOBS FIGURES MAY COUNT.
 *
 * `maintenance_requests` holds every row on every board, not only jobs. A Store
 * Documentation register row ("New store", 12 certificate slots) is a request
 * row placed on the `store-documentation` board, and a workspace section's rows
 * are request rows placed on a `sec-…` board. The Jobs board draws only the
 * rows placed on `maintenance` — `live-board.tsx` narrows the shell's list to
 * its own placements, and its comment records why: without that "every meter
 * counted stores as work orders".
 *
 * The aggregates did not make the same cut, and that was the defect behind "the
 * Overview says 98 open jobs and the board draws 82": the 16 were Store
 * Documentation rows — status "Pending Approval", `site-unassigned` — that the
 * aggregate counted as open jobs and the board, correctly, did not draw. So a
 * job is a live row that is NOT placed on any board other than this one. An
 * UNPLACED row counts, because the board files it into its own stage group the
 * first time it is read (`ensureBoardState`), so it is drawn.
 *
 * Twinned with `jobsBoardCondition` in `dashboard-filters.ts`, which is the same
 * test in SQL; `tests/jobs-board-population.test.mjs` pins the two together.
 * The value is `DEFAULT_BOARD_KEY` in `board-registry.ts`, restated rather than
 * imported because that module reaches the database.
 */
export const JOBS_BOARD_KEY = "maintenance";

/** Whether a row belongs to the Jobs board's population. `boardId` is the row's placement. */
export function isOnJobsBoard(request: { boardId?: string | null }): boolean {
  const board = (request.boardId ?? "").trim();
  return !board || board === JOBS_BOARD_KEY;
}

/* ── Spend ────────────────────────────────────────────────────────────────── */

/**
 * THE THREE SPEND TYPES — Reactive, Planned, Projects.
 *
 * This schema has no job-type column. The split the Reports page has always
 * shown is the one `classifySpend` in `dashboard-insights.tsx` computed, and it
 * moves HERE so the server's metrics, the Jobs page's `type=` filter and that
 * page all read one rule rather than three copies:
 *
 *   · Planned  — the category mentions compliance, or the job is tier 4 or
 *                above (the same inference `plannedCondition` makes in SQL);
 *   · Projects — otherwise, a job costing £1,000 or more ("higher-value works");
 *   · Reactive — everything else.
 *
 * Tested in that ORDER, which matters: a £5,000 compliance job is Planned, not
 * Projects. Every job lands in exactly one type, which is why the Reports
 * block's "Unclassified" bucket reads £0 under this rule — the bucket is still
 * computed and reconciled, so a future rule that can leave a job untyped is
 * caught rather than silently dropped.
 */
export const SPEND_TYPES = ["reactive", "planned", "projects"] as const;
export type SpendType = (typeof SPEND_TYPES)[number];

export const SPEND_TYPE_LABEL: Record<SpendType, string> = {
  reactive: "Reactive",
  planned: "Planned",
  projects: "Projects",
};

/** "Higher-value works" — the Projects threshold, in POUNDS like the column it reads. */
export const PROJECT_COST_THRESHOLD_POUNDS = 1000;

export function spendTypeOf(job: {
  category?: string | null;
  tier?: number | string | null;
  cost?: number | null;
}): SpendType {
  const category = String(job.category ?? "").toLowerCase();
  const tier = Number(job.tier ?? 0);
  if (category.includes("compliance") || (Number.isFinite(tier) && tier >= 4)) return "planned";
  if (Number(job.cost ?? 0) >= PROJECT_COST_THRESHOLD_POUNDS) return "projects";
  return "reactive";
}

/**
 * ONE JOB'S SPEND, ON THE BASIS EVERY SPEND FIGURE USES.
 *
 * `maintenance_requests.cost` in POUNDS, counted once the job is COMPLETED and
 * dated by its completion day — the basis the Overview's spend trend has used
 * since it shipped (`overview-metrics.ts`), and the one the Reports block reuses
 * so the two pages cannot disagree about a month. Null when the job has no cost
 * or no completion date: an open job has not been spent yet, whatever a quote
 * says.
 *
 * `day` is the first ten characters of the stored completion value, which is
 * what `substr(dateText(completed_at), 1, 10)` yields in SQL on both dialects.
 * Pence are rounded once, here, and never handled as a float again.
 */
export function spendLineOf(job: {
  cost?: number | null;
  completedAt?: string | null;
}): { pence: number; day: string } | null {
  if (job.cost === null || job.cost === undefined) return null;
  const pounds = Number(job.cost);
  if (!Number.isFinite(pounds)) return null;
  const day = String(job.completedAt ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return { pence: Math.round(pounds * 100), day };
}

/* ── Repeat jobs ──────────────────────────────────────────────────────────── */

/**
 * THE REPEAT WINDOW: how close two jobs must be to be the same problem back.
 *
 * Ninety days, the Reports brief's default. A policy number like
 * `EXPIRY_DUE_SOON_DAYS`, kept here so the Reports metrics and the Jobs page's
 * `repeat=` filter read one value.
 */
export const REPEAT_WINDOW_DAYS = 90;

export type RecurrenceBandKey = "weekly" | "fortnightly" | "monthly" | "less-often";

/**
 * How often a repeat pattern recurs, by the MEDIAN days between its consecutive
 * occurrences: ≤ 10 weekly, 11–21 fortnightly, 22–45 monthly, > 45 less often.
 * The brief's boundaries, as data rather than as comparisons in a component.
 */
export const RECURRENCE_BANDS: ReadonlyArray<{
  key: RecurrenceBandKey;
  label: string;
  /** Inclusive upper bound in days, or null for the open-ended band. */
  maxDays: number | null;
}> = [
  { key: "weekly", label: "Weekly", maxDays: 10 },
  { key: "fortnightly", label: "Fortnightly", maxDays: 21 },
  { key: "monthly", label: "Monthly", maxDays: 45 },
  { key: "less-often", label: "Less often", maxDays: null },
];

export function recurrenceBandOf(medianDays: number): RecurrenceBandKey {
  const days = Number.isFinite(medianDays) ? medianDays : 0;
  for (const band of RECURRENCE_BANDS) {
    if (band.maxDays === null || days <= band.maxDays) return band.key;
  }
  return "less-often";
}

export function isRecurrenceBand(value: string): value is RecurrenceBandKey {
  return RECURRENCE_BANDS.some((band) => band.key === value);
}

/** The middle value; the mean of the middle two for an even count; 0 for none. */
export function medianOf(values: readonly number[]): number {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The site a repeat is counted against, or null when there is none.
 *
 * "Issues coming back to the SAME SITE" needs a site: two jobs filed with no
 * site are not the same place, so neither can repeat the other. Blank and the
 * `site-unassigned` placeholder are the two shapes an unassigned job wears in
 * the browser — the same two `readDrillFilter`'s `__unassigned__` catches.
 */
export function repeatSiteKey(siteId: string | null | undefined): string | null {
  const id = (siteId ?? "").trim();
  return !id || id === "site-unassigned" ? null : id;
}

/**
 * The issue a repeat is counted against, or null when none is recorded.
 * Normalised like every other label comparison here; the legacy importer's
 * "[object Object]" is missing data, not an issue.
 */
export function repeatIssueKey(category: string | null | undefined): string | null {
  const key = statusKey(category);
  return !key || key === "[object object]" ? null : key;
}

export type RepeatJobInput = {
  id: string;
  siteId?: string | null;
  category?: string | null;
  requestedAt?: string | null;
};

export type RepeatVerdict = {
  /** A later job at the same site with the same issue, inside the window. */
  repeat: boolean;
  /** The occurrence it repeats, when it does. */
  previousId: string | null;
  /** Whole days since that occurrence, when it repeats. */
  gapDays: number | null;
  /** Site and issue joined, or null for a job that cannot repeat anything. */
  patternKey: string | null;
  /** The `YYYY-MM-DD` the job was raised. */
  day: string;
};

export type RepeatPattern = {
  key: string;
  siteId: string;
  /** The issue as first written, for display. */
  issue: string;
  /** Repeat jobs of this pattern raised inside the range. */
  repeatIds: string[];
  /** Days from each of those to the occurrence before it. */
  gaps: number[];
  medianDays: number;
  band: RecurrenceBandKey;
};

export type RepeatAnalysis = {
  verdicts: Map<string, RepeatVerdict>;
  /** Only patterns with at least one repeat job raised in the range. */
  patterns: Map<string, RepeatPattern>;
  /** Ids of the repeat jobs raised in the range. */
  inRange: Set<string>;
};

function dayIndexOf(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date) / 86_400_000;
}

/**
 * THE REPEAT RULE — one definition, used by the Reports metrics AND the Jobs
 * page's `repeat=` and `recurrence=` filters.
 *
 * A job is a REPEAT when an earlier job at the same site, for the same issue,
 * was raised no more than `windowDays` before it. Jobs are chained per site and
 * issue in the order they were raised; each job is compared with the one
 * immediately before it in its chain, so the first job in a chain is never a
 * repeat, and a job whose predecessor is older than the window starts the chain
 * again rather than repeating it.
 *
 * `from` / `toExclusive` bound which repeats are REPORTED — "a job in the range"
 * — but the comparison looks back past `from`, because the job being repeated
 * may have been raised before the range began. That is why the caller hands over
 * every job it has, not only the ones in range.
 *
 * Ordering is by raised day, then by the stored timestamp, then by id, so two
 * jobs raised on the same day are ordered the same way on the server and in the
 * browser, which receive the same stored values.
 *
 * Pure: no clock, no database, no React. `node --test` calls it directly.
 */
export function analyseRepeats(
  jobs: readonly RepeatJobInput[],
  options: { from: string; toExclusive: string; windowDays?: number },
): RepeatAnalysis {
  const windowDays = options.windowDays ?? REPEAT_WINDOW_DAYS;
  const verdicts = new Map<string, RepeatVerdict>();
  const chains = new Map<string, { job: RepeatJobInput; day: string; stamp: string; issue: string; siteId: string }[]>();

  for (const job of jobs) {
    /* `requested_at` holds `2026-09-04 15:27:14` (SQLite) beside ISO
       `2026-06-25T09:00:00.000Z` (the importer). A space sorts before a `T`, so
       the separator is normalised before two stamps from one day are ordered. */
    const stamp = String(job.requestedAt ?? "").trim().replace(" ", "T");
    const day = stamp.slice(0, 10);
    const siteId = repeatSiteKey(job.siteId);
    const issue = repeatIssueKey(job.category);
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(day);
    const patternKey = valid && siteId && issue ? `${siteId}\u001f${issue}` : null;
    verdicts.set(job.id, { repeat: false, previousId: null, gapDays: null, patternKey, day });
    if (!patternKey || !siteId) continue;
    const chain = chains.get(patternKey) ?? [];
    chain.push({ job, day, stamp, issue: String(job.category ?? "").trim(), siteId });
    chains.set(patternKey, chain);
  }

  const patterns = new Map<string, RepeatPattern>();
  const inRange = new Set<string>();
  for (const [patternKey, chain] of chains) {
    chain.sort(
      (left, right) =>
        (left.day < right.day ? -1 : left.day > right.day ? 1 : 0) ||
        (left.stamp < right.stamp ? -1 : left.stamp > right.stamp ? 1 : 0) ||
        (left.job.id < right.job.id ? -1 : left.job.id > right.job.id ? 1 : 0),
    );
    for (let index = 1; index < chain.length; index += 1) {
      const current = chain[index];
      const previous = chain[index - 1];
      const gap = dayIndexOf(current.day) - dayIndexOf(previous.day);
      if (gap < 0 || gap > windowDays) continue;
      verdicts.set(current.job.id, {
        repeat: true,
        previousId: previous.job.id,
        gapDays: gap,
        patternKey,
        day: current.day,
      });
      if (current.day < options.from || current.day >= options.toExclusive) continue;
      inRange.add(current.job.id);
      const pattern = patterns.get(patternKey) ?? {
        key: patternKey,
        siteId: current.siteId,
        issue: chain[0].issue,
        repeatIds: [],
        gaps: [],
        medianDays: 0,
        band: "less-often" as RecurrenceBandKey,
      };
      pattern.repeatIds.push(current.job.id);
      pattern.gaps.push(gap);
      patterns.set(patternKey, pattern);
    }
  }
  for (const pattern of patterns.values()) {
    pattern.medianDays = medianOf(pattern.gaps);
    pattern.band = recurrenceBandOf(pattern.medianDays);
  }
  return { verdicts, patterns, inRange };
}
