/**
 * The board's vocabulary: 23 statuses, the 7 stages they group into, and the
 * 5 queues the coordinators actually work in.
 *
 * `packages/db/migrations/0001` holds the authority — `jobs.stage` is a stored
 * generated column computed by `job_stage_for(status)` in Postgres, and the API
 * returns it on every row. This copy exists so the UI can build a status picker
 * and label a group without a round trip. It never overrides what the API says:
 * a job is filed under the stage the server sent, and this map is only consulted
 * when grouping a status the caller is about to write.
 */

export type JobStatus =
  | "Pending Approval"
  | "Pending Scheduling"
  | "Job Scheduled"
  | "Awaiting Access"
  | "Job In Progress"
  | "Major works"
  | "Waiting for parts"
  | "Quote requested"
  | "Quote Received (waiting for Approval)"
  | "Quote approved"
  | "Quote rejected"
  | "Blocked - Awaiting Response"
  | "Awaiting Landlord Approval"
  | "Health And Safety Hold"
  | "Waiting for decisions"
  | "Third Party Delay"
  | "Escalated"
  | "Waiting for payment"
  | "Deposit Invoice Received"
  | "Deposit Invoice Paid"
  | "Completion Invoice Received"
  | "Completion Invoice Paid"
  | "Job Completed";

export type JobStage =
  | "New"
  | "Scheduling"
  | "In Progress"
  | "Quotes"
  | "On Hold"
  | "Payment"
  | "Done";

export type JobPriority = "Urgent" | "Medium" | "Low";

export const STAGE_STATUSES: Record<JobStage, readonly JobStatus[]> = {
  New: ["Pending Approval"],
  Scheduling: ["Pending Scheduling", "Job Scheduled", "Awaiting Access"],
  "In Progress": ["Job In Progress", "Major works", "Waiting for parts"],
  Quotes: [
    "Quote requested",
    "Quote Received (waiting for Approval)",
    "Quote approved",
    "Quote rejected",
  ],
  "On Hold": [
    "Blocked - Awaiting Response",
    "Awaiting Landlord Approval",
    "Health And Safety Hold",
    "Waiting for decisions",
    "Third Party Delay",
    "Escalated",
  ],
  Payment: [
    "Waiting for payment",
    "Deposit Invoice Received",
    "Deposit Invoice Paid",
    "Completion Invoice Received",
    "Completion Invoice Paid",
  ],
  Done: ["Job Completed"],
};

/** Stage order as the board draws it, left to right. */
export const STAGE_ORDER: readonly JobStage[] = [
  "New",
  "Scheduling",
  "In Progress",
  "Quotes",
  "On Hold",
  "Payment",
  "Done",
];

export type QueueName =
  | "Incoming Requests"
  | "Jobs Booked"
  | "Needs Attention"
  | "On Hold"
  | "Completed";

export const QUEUE_ORDER: readonly QueueName[] = [
  "Incoming Requests",
  "Jobs Booked",
  "Needs Attention",
  "On Hold",
  "Completed",
];

/**
 * Which stages each queue tab draws.
 *
 * `GET /jobs` filters on one stage at a time, so a multi-stage queue is one
 * request per stage — which is also exactly how the stage-grouped board is laid
 * out, so nothing is fetched that is not shown.
 *
 * Needs Attention is the odd one: it is not a stage but a cross-cut, so it
 * sweeps every stage that is not finished and filters client-side.
 */
export const QUEUE_STAGES: Record<QueueName, readonly JobStage[]> = {
  "Incoming Requests": ["New"],
  "Jobs Booked": ["Scheduling", "In Progress", "Quotes", "Payment"],
  "Needs Attention": ["New", "Scheduling", "In Progress", "Quotes", "On Hold", "Payment"],
  "On Hold": ["On Hold"],
  Completed: ["Done"],
};

/**
 * Needs Attention is an overlay, not a bucket.
 *
 * A job flagged here still belongs to its stage queue and is still counted
 * there. The alternative — moving it out — would make every other tab's count
 * disagree with `GET /jobs/summary`, which counts by stage and knows nothing
 * about urgency. A number that cannot be reconciled with the server is a number
 * nobody trusts.
 */
const ATTENTION_STATUSES: readonly JobStatus[] = [
  "Escalated",
  "Health And Safety Hold",
  "Blocked - Awaiting Response",
  "Third Party Delay",
];

export function needsAttention(job: {
  status: string;
  priority: string | null;
  stage: string | null;
}): boolean {
  if (job.stage === "Done") return false;
  if (ATTENTION_STATUSES.includes(job.status as JobStatus)) return true;
  return job.priority === "Urgent";
}

export const ALL_STATUSES: readonly JobStatus[] = STAGE_ORDER.flatMap(
  (stage) => STAGE_STATUSES[stage],
);
