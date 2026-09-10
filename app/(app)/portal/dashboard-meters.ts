/**
 * The maths behind the six meters that sit above the maintenance board.
 *
 * WHY THIS IS ITS OWN FILE
 *
 * These six numbers are the board's headline claim about itself, so they have
 * to be checkable without rendering React. Nothing here imports a component or
 * calls a hook; live-board only wraps it in a `useMemo`. That also means a test
 * can feed it rows and assert the number, which is the only way a meter stays
 * honest once the 744-row monday export lands on top of today's sample.
 *
 * WHY STATUS LABELS ARE NAMED, NEVER SNIFFED
 *
 * Monday's Status column carries 23 labels, listed verbatim below from
 * db/monday-export/MAINTENANCE-MONDAY-CAPTURE.md. The meters used to match
 * them with `status.toLowerCase().includes("part")`, which also matches
 * "Third Party Delay" — par-t-y. On the live board that single false positive
 * *was* the whole "Awaiting parts" meter: it read 1 when no job on the board
 * was waiting for a part. Substring matching cannot be made safe, because the
 * next label the owner adds in monday decides what a meter means. So every
 * meter names the labels it counts and matches them whole.
 *
 * WHAT THE SPARKLINES ARE, AND ARE NOT
 *
 * They are not the meter's value over time. Nothing in this system records
 * what a job's status was last week: `item_activity` is an edit log (empty on
 * this workspace) and no snapshot of the board is kept, so "open jobs on 14
 * July" is not recoverable and inventing one would be a lie.
 *
 * What they do plot is real. Each bucket is the count of rows that match the
 * meter's predicate *now*, placed by the date that row carries — when it was
 * raised, or when it was closed for the closures meter. Read it as "when was
 * the work behind this number raised", not "how has this number moved". Each
 * card carries that sentence as the sparkline's accessible label, so the shape
 * cannot be mistaken for a history it is not.
 */

import type { MaintenanceRequest } from "../../lib/types";

/**
 * Monday's Status column — all 23 labels, in monday's index order, spelled as
 * monday spells them. This is the vocabulary a meter is allowed to match
 * against; anything a meter names must appear here, which the meter tests
 * assert.
 */
export const maintenanceStatusLabels = [
  "Pending Approval",
  "Pending Scheduling",
  "Job Scheduled",
  "Job In Progress",
  "Job Completed",
  "Blocked - Awaiting Response",
  "Awaiting Landlord Approval",
  "Waiting for parts",
  "Health And Safety Hold",
  "Waiting for payment",
  "Waiting for decisions",
  "Awaiting Access",
  "Escalated",
  "Major works",
  "Third Party Delay",
  "Quote requested",
  "Quote Received (waiting for Approval)",
  "Quote approved",
  "Quote rejected",
  "Deposit Invoice Received",
  "Deposit Invoice Paid",
  "Completion Invoice Received",
  "Completion Invoice Paid",
] as const;

/**
 * Monday round-trips labels through CSV and forms, so a stray double space or
 * a lower-cased first letter is a data accident, not a different status.
 * Comparing on a normalised copy keeps the meter right without ever guessing
 * at a partial word.
 */
function normaliseStatus(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function statusMatcher(labels: readonly string[]) {
  const wanted = new Set(labels.map(normaliseStatus));
  return (request: MaintenanceRequest) =>
    wanted.has(normaliseStatus(request.status ?? ""));
}

/**
 * "Awaiting parts" — exactly one of monday's 23 labels is about a part.
 * "Replacement parts" is a *Label* column value (the category of work), not a
 * status, so it must not reach this meter: a finished lock replacement is not
 * a job waiting on a supplier.
 */
export const awaitingPartsStatuses = ["Waiting for parts"] as const;

/**
 * "Awaiting approval" — three labels mean the same operational thing: the work
 * is stopped until a human signs something off, and nobody on site can move it.
 *
 * "Quote Received (waiting for Approval)" is included deliberately. The
 * question the meter answers is "how many jobs are parked on somebody's
 * signature", and a received quote awaiting approval is parked on exactly that
 * — its own text says so. Leaving it out would under-report the queue the
 * owner is chasing.
 *
 * Excluded, also deliberately:
 *   • "Quote requested" — waiting on the contractor to send a price, not on us.
 *   • "Waiting for decisions" — a scope decision is not a sign-off, and it has
 *     its own label; folding it in would put two different blockages behind one
 *     word. The card's detail line therefore reads "Sign-off required" rather
 *     than the old "Decision required", which promised this label and did not
 *     count it.
 *   • "Quote approved" / "Quote rejected" — already decided.
 */
export const awaitingApprovalStatuses = [
  "Pending Approval",
  "Awaiting Landlord Approval",
  "Quote Received (waiting for Approval)",
] as const;

/**
 * Finished. Monday flags exactly one Status label as done — "Job Completed
 * #00c875 (is_done)" — and that flag is the board's own answer to whether a job
 * is over.
 *
 * The meters read *either* signal, because the two disagree on live data. The
 * imported rows sit in monday's "… Recently completed" groups, which carry no
 * lifecycle stage in this app, so `stage` on all of them is "Incoming": a
 * stage-only test reported 28 jobs whose own status says "Job Completed" as
 * open work, and "Open" read 40 where the board holds 12 live jobs. When the
 * importer does set a stage the two signals agree and the union changes
 * nothing, so this is safe in both directions.
 *
 * THE SERVER READS THIS ARRAY AND THE CONSTANT BELOW IT, and that is why they
 * are exported from here rather than kept private.
 *
 * `readWorkspace` in `app/api/workspace/route.ts` counted `stage = 'Completed'`
 * and nothing else, so a job whose own status says "Job Completed" was reported
 * completed HERE and open THERE for the same contractor — the manage drawer and
 * the Contractors table printing two different numbers for one person.
 * `completedJobPredicate` in that route is now BUILT from these two values:
 * `eq(stage, COMPLETED_STAGE) or inArray(status, [...completedStatuses])`.
 * Adding a label here changes what the database counts, in the same edit.
 *
 * WHY THE DEPENDENCY POINTS THAT WAY — a route reaching into `portal/` — rather
 * than both sides importing a neutral module in `app/lib`. This file must have
 * NO runtime imports: seven test suites transpile it on its own and load it from
 * a `data:` URL, where a relative specifier cannot resolve at all
 * (`ERR_INVALID_URL`), and their headers say so out loud ("no React in it,
 * exactly as dashboard-meters.ts is, so it transpiles"). Moving the list into
 * `app/lib/stage-status.ts` and importing it back was tried and broke every one
 * of them. The vocabulary therefore lives where it is already checkable in
 * isolation, and the SQL comes to it.
 */
export const mondayCompletedStatuses = ["Job Completed"] as const;

/**
 * The labels that close a job on an estate monday never touched.
 *
 * Two estates exist and they do not share a vocabulary. The client's board came
 * from monday and says "Job Completed"; the seeded workspace — the one a Preview
 * deployment and every fresh Postgres actually shows — writes "Completed" and
 * "Cancelled", neither of which is a monday label and neither of which
 * `completedStatuses` used to contain. So twenty-two finished jobs counted as
 * OPEN on the demo estate, on every screen at once, and the SLA card measured
 * closures it did not believe had closed.
 *
 * They are declared separately rather than appended to the monday list because
 * the monday list has a checkable property that these two must not weaken:
 * every label in it appears verbatim in
 * `db/monday-export/MAINTENANCE-MONDAY-CAPTURE.md`. Keeping the two lists
 * apart lets `tests/stage-nineteen-meter-accuracy.test.mjs` go on asserting
 * that property of the monday half while the union is what the product counts.
 *
 * CANCELLED IS CLOSED, NOT COMPLETED. It is in this list because open and
 * closed are a partition of work somebody can still act on, and nobody can act
 * on a cancelled job. Nothing here claims it was done — the status is still
 * printed verbatim wherever a job's status is shown, and the family map in
 * `app/lib/job-metrics.ts` is what a card reads when it wants to say more than
 * open-or-closed.
 */
export const seededCompletedStatuses = ["Completed", "Cancelled"] as const;

/**
 * The union, and the list every predicate and every SQL `IN` is built from.
 *
 * `mondayCompletedStatuses` stays FIRST because `statusForStage` in
 * `app/lib/stage-status.ts` maps the completed stage onto `completedStatuses[0]`
 * and the board writes that string back onto the row.
 */
export const completedStatuses = [
  ...mondayCompletedStatuses,
  ...seededCompletedStatuses,
] as const;

/**
 * The lifecycle stage that means finished, named rather than typed out.
 *
 * `isClosedRequest` below and `completedJobPredicate` in
 * `app/api/workspace/route.ts` both compare against it. `statusForStage` in
 * `app/lib/stage-status.ts` maps this stage onto `completedStatuses[0]`, which
 * is why the two signals agree whenever a stage has been set at all.
 */
export const COMPLETED_STAGE = "Completed" as const;

const isAwaitingParts = statusMatcher(awaitingPartsStatuses);
const isAwaitingApproval = statusMatcher(awaitingApprovalStatuses);
const hasCompletedStatus = statusMatcher(completedStatuses);

/**
 * The union, and the canonical definition of "completed" in this product.
 *
 * Its SQL twin is `completedJobPredicate` in `app/api/workspace/route.ts`. The
 * two are built from the same two constants; if you change one, you have
 * already changed the other.
 */
export const isClosedRequest = (request: MaintenanceRequest) =>
  request.stage === COMPLETED_STAGE || hasCompletedStatus(request);

/**
 * Everything the board has not filed as finished. Open and closed are a
 * partition of the rows in view, so the two meters always sum to the row count
 * printed under the table — an invariant the meter test asserts.
 */
export const isOpenRequest = (request: MaintenanceRequest) =>
  !isClosedRequest(request);

/**
 * "P1 critical" counts an open job that is Urgent on monday's Priority column
 * *or* Tier 1 on its Tier Level dropdown.
 *
 * These are two separate monday columns and the union is the deliberate
 * choice: this board uses Priority for how fast a job must be answered and
 * Tier Level for how severe it is, and either one at its top value is work the
 * owner wants surfaced today. Because that is a union of two vocabularies and
 * not the single "P1" field the label implies, the card's detail line spells
 * it out — "Urgent or Tier 1" — instead of the old "Urgent response", which
 * described only half of what was being counted.
 */
export const isCriticalRequest = (request: MaintenanceRequest) =>
  isOpenRequest(request) && (request.priority === "Urgent" || request.tier === 1);

/** A blocked job that has already been filed as finished is not blocked. */
export const isAwaitingPartsRequest = (request: MaintenanceRequest) =>
  isOpenRequest(request) && isAwaitingParts(request);

export const isAwaitingApprovalRequest = (request: MaintenanceRequest) =>
  isOpenRequest(request) && isAwaitingApproval(request);

/**
 * The board's own target for a job: the hours between when it was raised and
 * the due date on the row.
 *
 * The previous version of this meter averaged a hard-coded table
 * (`{ Urgent: 4, High: 24, Medium: 72, Low: 120 }`) that was not derived from
 * anything on the board — monday's Priority column has only Urgent, Medium and
 * Low, so the "High" row could never match, and every unrecognised priority
 * silently became 72. It reported 36.0 hrs while the due dates the board
 * actually carries averaged 243.9. A meter must read the data, not a constant.
 *
 * Returns `null` when the row has no due date, so those rows are left out of
 * the mean instead of being counted as a zero-hour target.
 */
export function slaTargetHours(request: MaintenanceRequest) {
  if (!request.dueAt) return null;
  const raised = new Date(request.requestedAt).getTime();
  const due = new Date(request.dueAt).getTime();
  if (!Number.isFinite(raised) || !Number.isFinite(due)) return null;
  return (due - raised) / 3_600_000;
}

/**
 * DID THIS JOB MEET ITS TARGET — the question `slaTargetHours` does not answer.
 *
 * The dashboard brief §4.4 puts it bluntly: the Jobs page meter "Avg SLA target
 * 64.8 hrs" is "an average of the targets themselves and measures nothing about
 * performance". A portfolio whose every job is three months late reports the
 * same 64.8 as one where every job closed on time. The number was honest about
 * what it measured and useless for what a reader wanted from it.
 *
 * So this is the performance question instead: of the jobs that CLOSED and
 * carried a due date, how many closed on or before it.
 *
 * Three decisions, each of which changes the figure:
 *
 *   · only CLOSED jobs count. An open job has not missed its target, it has not
 *     met it either, and counting it as a miss would make the figure fall every
 *     day nobody did anything — including the day the work was booked;
 *   · a job with no due date is EXCLUDED rather than counted as met. There is
 *     nothing to have met. The sample is returned beside the percentage so a
 *     reader can see how thin it is — on the monday export it was 1 due date
 *     across 745 rows;
 *   · a BARE `YYYY-MM-DD` due date is met if the job closed on that DAY, not by
 *     midnight at its start. This is the same rule `duePassed` encodes in
 *     `app/lib/job-metrics.ts` and the same one `overdueOpenSql` encodes in
 *     SQL: treating a bare date as UTC midnight marks work delivered on the due
 *     day as late for everyone west of Greenwich.
 *
 * `null` for a job that cannot be judged, so the caller filters rather than
 * having a boolean stand in for "unknown".
 *
 * THE OVERVIEW COMPUTES THE SAME RULE IN SQL, and this file is the definition
 * of record because it cannot import: seven suites transpile it alone and load
 * it from a `data:` URL, so it has no runtime imports and nothing here can be
 * shared by reference. `tests/stage-nineteen-meter-accuracy` holds the two
 * together.
 */
export function slaMet(request: MaintenanceRequest): boolean | null {
  if (!isClosedRequest(request)) return null;
  /*
   * THE PROMISE IS THE TARGET DATE FIRST, THE BOARD'S DEADLINE SECOND.
   *
   * This read `request.dueAt` alone, while the Overview's SQL has always
   * measured against `coalesce(target_completion_date, due_at)`. Two
   * consequences, both wrong in the same direction: a job carrying an explicit
   * target was judged against the board's deadline instead of the commitment
   * somebody actually made, and a job with a target and NO due date was
   * dropped from the denominator entirely — so the Jobs meter quietly measured
   * a smaller, easier population than the card §4.4 asked it to agree with.
   *
   * `target_completion_date` is the explicit commitment; `due_at` is the
   * board's deadline. First one present wins, per row, exactly as the SQL
   * does it.
   */
  const promised = String(request.targetCompletionDate ?? "").trim()
    || String(request.dueAt ?? "").trim();
  if (!promised || !request.completedAt) return null;
  const due = promised;
  const closed = String(request.completedAt).trim();
  if (!due || !closed) return null;
  /* Ten characters or fewer is a DAY: compare days, so closing on the due day
     counts as met. Longer is an instant: compare instants. */
  if (due.length <= 10) return closed.slice(0, 10) <= due.slice(0, 10);
  const dueAt = new Date(due).getTime();
  const closedAt = new Date(closed).getTime();
  if (!Number.isFinite(dueAt) || !Number.isFinite(closedAt)) return null;
  return closedAt <= dueAt;
}

/**
 * The window the period selector describes, as a pair of timestamps.
 *
 * The one-day grace on the end exists because a request can carry a due or
 * requested date a few hours into the future (monday's form writes local
 * dates); without it the newest row on the board drops out of its own period.
 * `withinAnalyticsPeriod` is this same window, kept in one place so the meters
 * and the rows can never disagree about where the period ends.
 */
export function analyticsWindow(period: string, now: number) {
  const end = now + 86_400_000;
  const days = Number(period);
  if (period === "all" || !Number.isFinite(days)) {
    return { start: Number.NEGATIVE_INFINITY, end };
  }
  return { start: now - days * 86_400_000, end };
}

/** Twelve buckets, spanning the selected period — see `trendSpan`. */
export const meterTrendBuckets = 12;

/**
 * The trend covers the period the meters describe, not a fixed twelve weeks.
 *
 * The old buckets were always 12 × 7 days. On "Last 30 days" that left eight
 * buckets that were empty by construction, so every sparkline drew the same
 * flat-then-cliff shape — an artefact of the period filter being read as a
 * surge in work. On "This year" or "All records" it did the opposite and hid
 * everything older than 84 days. Sizing the buckets to the window means the
 * sparkline always plots the same rows the number above it counts.
 */
function trendSpan(stamps: number[], period: string, now: number) {
  const { start, end } = analyticsWindow(period, now);
  const earliest = stamps.length ? Math.min(...stamps) : end - 84 * 86_400_000;
  const from = Number.isFinite(start) ? start : earliest;
  // Guard only against a zero-width span, which would divide by zero below.
  return { start: Math.min(from, end - meterTrendBuckets), end };
}

function bucketIndex(stamp: number, span: { start: number; end: number }) {
  const size = (span.end - span.start) / meterTrendBuckets;
  const index = Math.floor((stamp - span.start) / size);
  return Math.min(meterTrendBuckets - 1, Math.max(0, index));
}

/**
 * When a row belongs on the timeline.
 *
 * The closures meter is placed by `completedAt`, because a sparkline under
 * "Closed" that buckets by the date the job was *raised* answers a question
 * nobody asked. A row filed as Completed with no completion date can only be
 * placed by when it was raised, and is.
 */
function requestStamp(request: MaintenanceRequest, useCompletion: boolean) {
  const raw = useCompletion
    ? request.completedAt ?? request.requestedAt
    : request.requestedAt;
  return new Date(raw).getTime();
}

function countTrend(
  requests: MaintenanceRequest[],
  predicate: (request: MaintenanceRequest) => boolean,
  span: { start: number; end: number },
  useCompletion = false,
) {
  const counts = new Array<number>(meterTrendBuckets).fill(0);
  for (const request of requests) {
    if (!predicate(request)) continue;
    const stamp = requestStamp(request, useCompletion);
    if (!Number.isFinite(stamp)) continue;
    counts[bucketIndex(stamp, span)] += 1;
  }
  return counts;
}

/**
 * The SLA sparkline plots the mean target window of the rows raised in each
 * bucket. Buckets with no rows are 0 rather than a carried-forward value: a
 * gap in the data is a gap, and drawing through it would invent a target for a
 * week in which nothing was raised.
 */
function averageTrend(
  requests: MaintenanceRequest[],
  span: { start: number; end: number },
) {
  const totals = new Array<number>(meterTrendBuckets).fill(0);
  const counts = new Array<number>(meterTrendBuckets).fill(0);
  for (const request of requests) {
    const hours = slaTargetHours(request);
    if (hours === null) continue;
    const stamp = requestStamp(request, false);
    if (!Number.isFinite(stamp)) continue;
    const index = bucketIndex(stamp, span);
    totals[index] += hours;
    counts[index] += 1;
  }
  return totals.map((total, index) =>
    counts[index] ? Number((total / counts[index]).toFixed(1)) : 0,
  );
}

/**
 * The SLA-met percentage per bucket, so the sparkline plots what the number
 * above it says.
 *
 * Bucketed by COMPLETION rather than by request date, unlike every other trend
 * here, and the difference is the point: a job raised in March and closed in
 * September was met or missed in September. Bucketing it in March would move
 * this quarter's performance into last quarter's column.
 *
 * A bucket with nothing to judge reads zero rather than being dropped, which is
 * the same convention `averageTrend` uses and the same caveat its label
 * carries: these lines are what is TRUE OF THE ROWS IN VIEW, sliced by date.
 * They are not a history, because nothing records what a job's state was last
 * week.
 */
function metTrend(
  requests: MaintenanceRequest[],
  span: { start: number; end: number },
) {
  const met = new Array<number>(meterTrendBuckets).fill(0);
  const judged = new Array<number>(meterTrendBuckets).fill(0);
  for (const request of requests) {
    const outcome = slaMet(request);
    if (outcome === null) continue;
    const stamp = requestStamp(request, true);
    if (!Number.isFinite(stamp)) continue;
    const index = bucketIndex(stamp, span);
    judged[index] += 1;
    if (outcome) met[index] += 1;
  }
  return met.map((count, index) =>
    judged[index] ? Math.round((count / judged[index]) * 100) : 0,
  );
}

/**
 * What each sparkline actually plots, in the card's own words.
 *
 * Every one of them ends by saying it is not a history, because that is the
 * reading a line under a live number invites and the one thing this data
 * cannot support.
 */
export const jobMeterTrendLabels = {
  open: "Open work orders by the week they were raised, across the selected period. Not a history of the open count — no status history is recorded.",
  critical:
    "Urgent or Tier 1 work orders by the week they were raised, across the selected period. Not a history of the critical count.",
  parts:
    "Jobs waiting for parts by the week they were raised, across the selected period. Not a history of the waiting count.",
  approval:
    "Jobs awaiting sign-off by the week they were raised, across the selected period. Not a history of the awaiting count.",
  closed:
    "Completions by the week the job was closed, across the selected period.",
  sla: "Share of the jobs CLOSED in each bucket that closed on or before their due date, across the selected period. Buckets with nothing to judge read zero.",
} as const;

export interface JobMeter {
  /** Rows behind the number, so a caller can drill in rather than re-filter. */
  rows: MaintenanceRequest[];
  count: number;
  trend: number[];
}

export interface JobMeters {
  open: JobMeter;
  critical: JobMeter;
  parts: JobMeter;
  approval: JobMeter;
  closed: JobMeter;
  sla: {
    /** `null` when no row in view carries a due date — the card shows a dash. */
    averageHours: number | null;
    /**
     * How many rows the mean is built from. The card prints it next to the
     * number, because a mean is only as good as its sample and this one's is
     * thin: the monday export arrived with 1 due date across 745 rows, so a
     * bare "72.0 hrs" would read as a portfolio-wide fact instead of one row.
     */
    sample: number;
    trend: number[];
    /**
     * THE PERFORMANCE FIGURE — the share of closed, due-dated jobs that closed
     * on or before their due date. See `slaMet`.
     *
     * `null` when nothing in view can be judged, which is a different fact from
     * 0%: it means no closed job carried a due date, not that none of them met
     * it. The card must print a dash for one and a number for the other.
     */
    metPercent: number | null;
    /** How many jobs the percentage is built from. Always printed beside it. */
    metSample: number;
  };
}

/**
 * `requests` must be the rows the board is actually drawing — search, filters
 * and all — not the wider period scope. A meter sitting directly above a table
 * has to agree with the table; the old code read the unfiltered scope, so
 * picking an assignee moved every row on screen and left all six numbers
 * unchanged.
 */
export function computeJobMeters(
  requests: MaintenanceRequest[],
  period: string,
  now: number,
): JobMeters {
  const stamps = requests
    .map((request) => new Date(request.requestedAt).getTime())
    .filter((stamp) => Number.isFinite(stamp));
  const span = trendSpan(stamps, period, now);

  const meter = (
    predicate: (request: MaintenanceRequest) => boolean,
    useCompletion = false,
  ): JobMeter => {
    const rows = requests.filter(predicate);
    return {
      rows,
      count: rows.length,
      // The trend is built from the same predicate as the number above it, so
      // the two cannot drift. They had: the value counted open rows only while
      // the sparkline counted closed ones too.
      trend: countTrend(requests, predicate, span, useCompletion),
    };
  };

  const slaHours = requests
    .map(slaTargetHours)
    .filter((hours): hours is number => hours !== null);

  /* The performance question, beside the target one. See `slaMet`. */
  const judged = requests
    .map(slaMet)
    .filter((met): met is boolean => met !== null);
  const metCount = judged.filter(Boolean).length;

  return {
    open: meter(isOpenRequest),
    critical: meter(isCriticalRequest),
    parts: meter(isAwaitingPartsRequest),
    approval: meter(isAwaitingApprovalRequest),
    closed: meter(isClosedRequest, true),
    sla: {
      averageHours: slaHours.length
        ? slaHours.reduce((sum, hours) => sum + hours, 0) / slaHours.length
        : null,
      sample: slaHours.length,
      trend: metTrend(requests, span),
      /* `null` rather than 0 when nothing can be judged: no closed job carried
         a due date, which is not the same fact as "none of them met it". */
      metPercent: judged.length ? Math.round((metCount / judged.length) * 100) : null,
      metSample: judged.length,
    },
  };
}
