/**
 * WHICH BUCKET A JOB IS IN — reconciled with the board, not redefined beside it.
 *
 * ── THE RULE THIS FILE EXISTS TO OBEY ──────────────────────────────────────
 *
 * The board already answers "is this job finished". `isClosedRequest` in
 * `app/(app)/portal/dashboard-meters.ts` is the canonical definition in this
 * product, its header says so, and `completedJobPredicate` in
 * `app/api/workspace/route.ts` is its SQL twin — built from the same two
 * exported constants rather than from a second opinion, so that adding a label
 * to `completedStatuses` changes both in one edit.
 *
 * This module is the THIRD consumer of those two constants and is built the
 * same way. It does not import a second vocabulary, does not sniff substrings,
 * and does not decide for itself what "completed" means. The consequence is the
 * one the owner cares about: the "Completed" group in the Full Job Log holds
 * exactly the jobs the board's Closed meter counts, so a client cannot find a
 * job that is finished on one screen and open on another.
 *
 * The report DOES add one thing the board has no need for: the seven groups of
 * `JOB_LOG_GROUPS`. Those are a presentation of the open jobs, not a new
 * definition of open — every group other than Completed is a subdivision of the
 * board's own open set, and the five of them partition it exactly.
 *
 * ── CANCELLED IS EMPTY, AND THAT IS A FINDING, NOT A GAP ───────────────────
 *
 * `JOB_LOG_GROUPS` includes "Cancelled". Monday's Status column carries 23
 * labels and NOT ONE of them means cancelled — the list is in
 * `maintenanceStatusLabels`, and the closest candidate, "Quote rejected", means
 * a price was refused, which is a decision about a quote and not a decision to
 * abandon the work. Mapping it to Cancelled would file live jobs as dead ones
 * on a document a client reads.
 *
 * So `CANCELLED_STATUSES` is deliberately EMPTY and the Cancelled group is
 * empty by construction. `cancelledJobs` in the executive counts is therefore
 * always 0 until the board gains a label that means it, and the report says so
 * rather than quietly borrowing a label that means something else. Adding the
 * label to this array is the whole change when one exists.
 *
 * ── WHY THE FALLBACK IS THE STAGE ──────────────────────────────────────────
 *
 * A status this build does not know — a label an admin added in monday last
 * week — must still land in exactly one group. It falls back to the row's own
 * lifecycle `stage`, which is a field the row genuinely carries, rather than to
 * a default group chosen here. The unrecognised label is reported as a
 * data-quality finding at the same time, so the gap is visible instead of
 * absorbed.
 */

import {
  COMPLETED_STAGE,
  awaitingApprovalStatuses,
  completedStatuses,
  maintenanceStatusLabels,
} from "../../(app)/portal/dashboard-meters";
import type { JobLogGroup } from "./contract";
import type { ReportJob } from "./inputs";

/**
 * The same normalisation `dashboard-meters.ts` applies before matching a label.
 *
 * Duplicated rather than imported because that module deliberately exports the
 * VOCABULARY and not the matcher — seven test suites transpile it in isolation
 * and it must stay import-free. The rule is three lines and is asserted against
 * the board's own behaviour by `tests/w9-report-engine.test.mjs`, which runs
 * this predicate and `isClosedRequest` over the same matrix of stages and
 * statuses and requires them to agree on every cell.
 */
function normaliseStatus(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

const COMPLETED_SET = new Set(completedStatuses.map(normaliseStatus));
const KNOWN_LABELS = new Set(maintenanceStatusLabels.map(normaliseStatus));

/**
 * No board status means cancelled. See the header before adding one.
 */
export const CANCELLED_STATUSES: readonly string[] = [];

const CANCELLED_SET = new Set(CANCELLED_STATUSES.map(normaliseStatus));

/**
 * Finished, by the board's definition and no other.
 *
 * `stage = Completed` OR the status is one of `completedStatuses` — the union
 * `isClosedRequest` applies and `completedJobPredicate` translates into SQL.
 */
export function isCompletedJob(job: Pick<ReportJob, "stage" | "status">): boolean {
  return job.stage === COMPLETED_STAGE || COMPLETED_SET.has(normaliseStatus(job.status));
}

/** Cancelled, which today is never. Kept as a function so callers do not care. */
export function isCancelledJob(job: Pick<ReportJob, "status">): boolean {
  return CANCELLED_SET.has(normaliseStatus(job.status));
}

/** Everything the board has not filed as finished, less anything cancelled. */
export function isOpenJob(job: Pick<ReportJob, "stage" | "status">): boolean {
  return !isCompletedJob(job) && !isCancelledJob(job);
}

/**
 * Critical, by the board's rule: an OPEN job that is Urgent on the Priority
 * column or Tier 1 on the Tier Level dropdown.
 *
 * The union of two monday columns, exactly as `isCriticalRequest` in
 * `dashboard-meters.ts` defines it and for the reason its header gives — this
 * board uses Priority for how fast and Tier for how severe, and either at its
 * top value is work the owner wants surfaced.
 */
export function isCriticalJob(job: Pick<ReportJob, "stage" | "status" | "priority" | "tier">): boolean {
  return isOpenJob(job) && (job.priority === "Urgent" || job.tier === 1);
}

/** Whether the row's status is a label this build knows. */
export function isKnownStatus(status: string | null | undefined): boolean {
  return KNOWN_LABELS.has(normaliseStatus(status));
}

/**
 * The 23 labels, each to one of the seven groups.
 *
 * Written out rather than derived, because the derivation would be a substring
 * match and this codebase has already paid for one of those: matching "part"
 * also matched "Third Party Delay" and made the whole Awaiting-parts meter read
 * 1 when nothing was waiting for a part.
 *
 * Three of the entries are borrowed from the board rather than chosen here —
 * the three in `awaitingApprovalStatuses` — so "parked on somebody's signature"
 * means the same thing on the report as it does on the meter above the board.
 */
const STATUS_GROUPS: Record<string, JobLogGroup> = {
  "pending approval": "Awaiting Approval",
  "pending scheduling": "New",
  "job scheduled": "Assigned",
  "job in progress": "In Progress",
  "job completed": "Completed",
  "blocked - awaiting response": "On Hold",
  "awaiting landlord approval": "Awaiting Approval",
  "waiting for parts": "On Hold",
  "health and safety hold": "On Hold",
  "waiting for payment": "On Hold",
  "waiting for decisions": "On Hold",
  "awaiting access": "On Hold",
  escalated: "In Progress",
  "major works": "In Progress",
  "third party delay": "On Hold",
  "quote requested": "New",
  "quote received (waiting for approval)": "Awaiting Approval",
  "quote approved": "Assigned",
  /* A refused price stops the work until somebody decides what to do next,
     which is what every other On Hold label describes. It is NOT Cancelled —
     see the header. */
  "quote rejected": "On Hold",
  "deposit invoice received": "In Progress",
  "deposit invoice paid": "In Progress",
  "completion invoice received": "In Progress",
  "completion invoice paid": "In Progress",
};

/*
 * The three "parked on somebody's signature" labels come FROM the board, not
 * from the literals above, and this loop is what makes that true rather than a
 * comment. `awaitingApprovalStatuses` is the meter's own list; adding a label
 * to it moves the job into this group in the same edit, so the card above the
 * board and the section of the log a reader scrolls to can never disagree.
 * The literals stay, so that all 23 labels are visible in one place and the
 * test that asserts every one of them is mapped still has something to read.
 */
for (const label of awaitingApprovalStatuses) {
  STATUS_GROUPS[normaliseStatus(label)] = "Awaiting Approval";
}

/** The row's own lifecycle stage, used when the status label is unrecognised. */
const STAGE_GROUPS: Record<string, JobLogGroup> = {
  Incoming: "New",
  Booked: "Assigned",
  Attention: "On Hold",
  Completed: "Completed",
};

/**
 * The one group a job belongs to. Every job lands in exactly one.
 *
 * Completed and Cancelled are decided FIRST, by the predicates above, because
 * those two answers belong to the board and to the executive counts. Only the
 * remaining open jobs are subdivided by label.
 */
export function jobLogGroup(
  job: Pick<ReportJob, "stage" | "status" | "priority" | "tier">,
): JobLogGroup {
  if (isCompletedJob(job)) return "Completed";
  if (isCancelledJob(job)) return "Cancelled";
  const byStatus = STATUS_GROUPS[normaliseStatus(job.status)];
  if (byStatus && byStatus !== "Completed" && byStatus !== "Cancelled") return byStatus;
  return STAGE_GROUPS[job.stage] ?? "New";
}

/**
 * Whether a job is a "special project" rather than routine maintenance.
 *
 * "Major works" is monday's own label for it, and it is the only signal on this
 * board that says a job is a programme with its own dates rather than a
 * reactive repair. A project is measured to an agreed programme, so it is
 * EXCLUDED from SLA (`sla.ts` records the reason) and reported in its own
 * section, which the contract omits entirely when it is empty.
 */
export const PROJECT_STATUSES = ["Major works"] as const;

const PROJECT_SET = new Set(PROJECT_STATUSES.map(normaliseStatus));

export function isProjectJob(job: Pick<ReportJob, "status" | "jobType">): boolean {
  if (PROJECT_SET.has(normaliseStatus(job.status))) return true;
  const type = normaliseStatus(job.jobType);
  return type === "project" || type === "special project" || type === "major works";
}

/**
 * Routine, planned work — the fifth of the five separately-labelled spend
 * figures. Anything a job's own type calls planned, routine or PPM.
 *
 * Deliberately narrow. Nothing infers "routine" from a category or a
 * contractor; a job that does not say it is planned is counted as reactive,
 * which is the safer error on a spend breakdown a client reads.
 */
export function isRoutineJob(job: Pick<ReportJob, "jobType">): boolean {
  const type = normaliseStatus(job.jobType);
  return type === "planned" || type === "routine" || type === "ppm" || type === "planned maintenance";
}
