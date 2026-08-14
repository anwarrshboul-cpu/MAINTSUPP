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
 */
export const completedStatuses = ["Job Completed"] as const;

const isAwaitingParts = statusMatcher(awaitingPartsStatuses);
const isAwaitingApproval = statusMatcher(awaitingApprovalStatuses);
const hasCompletedStatus = statusMatcher(completedStatuses);

export const isClosedRequest = (request: MaintenanceRequest) =>
  request.stage === "Completed" || hasCompletedStatus(request);

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
  sla: "Mean request-to-due window of the jobs raised in each bucket, across the selected period. Empty buckets read zero.",
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
      trend: averageTrend(requests, span),
    },
  };
}
