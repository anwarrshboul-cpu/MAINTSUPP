/**
 * RECORDING A JOB'S STAGE AND STATUS TRANSITIONS — §23.
 *
 * One function, called at every door that moves a job, so the history cannot
 * depend on which screen somebody used. It writes one `job_status_history` row
 * per field that genuinely changed, and stamps `status_changed_at` — the column
 * §2.4's "Held for" has read since the Overview shipped and that nothing wrote
 * until now.
 *
 * A FAILED HISTORY WRITE NEVER FAILS THE CHANGE. The job has already moved by
 * the time this runs; turning that into an error would tell the person their
 * edit failed when it did not. The failure is logged loudly instead — the same
 * rule `recordAudit` follows.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { jobStatusHistory } from "../../db/schema";
import type { getDb } from "../../db";

type Database = Awaited<ReturnType<typeof getDb>>;

/** Which of the job's two state columns moved. */
export type TrackedField = "stage" | "status";

export type StatusChange = {
  requestId: string;
  field: TrackedField;
  /** NULL when the job was created in this state. */
  from: string | null;
  to: string | null;
};

const FIELDS: readonly TrackedField[] = ["stage", "status"];

/**
 * The day this history began to be recorded. Shown beside it so nobody reads
 * an empty or short history as "this job never moved" — the owner's rule is
 * that nothing before this day is reconstructed from inference.
 */
export const STATUS_HISTORY_SINCE = "2026-09-22";

function value(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const text = String(input).trim();
  return text ? text : null;
}

/**
 * The transitions between a row before and after a write, stage and status.
 *
 * `before` absent means the job is new: every field it was given is recorded
 * with `from = null`. A field that did not change is not a transition.
 */
export function statusChangesBetween(
  requestId: string,
  before: { stage?: unknown; status?: unknown } | null | undefined,
  after: { stage?: unknown; status?: unknown } | null | undefined,
): StatusChange[] {
  if (!after) return [];
  const changes: StatusChange[] = [];
  for (const field of FIELDS) {
    const to = value(after[field]);
    const from = before ? value(before[field]) : null;
    if (before && from === to) continue;
    if (!before && to === null) continue;
    changes.push({ requestId, field, from, to });
  }
  return changes;
}

export async function recordJobStatusChanges(
  db: Database,
  input: {
    organisationId: string;
    actorEmail: string | null | undefined;
    /** Which door moved it. */
    source: string;
    changes: StatusChange[];
  },
): Promise<number> {
  const changes = input.changes.filter((change) => change.from !== change.to);
  if (!changes.length) return 0;
  const stamp = new Date().toISOString();
  try {
    for (let index = 0; index < changes.length; index += 50) {
      await db.insert(jobStatusHistory).values(
        changes.slice(index, index + 50).map((change) => ({
          id: `jsh_${crypto.randomUUID().replace(/-/g, "")}`,
          organisationId: input.organisationId,
          requestId: change.requestId,
          field: change.field,
          fromValue: change.from,
          toValue: change.to,
          actorEmail: input.actorEmail ?? null,
          source: input.source.slice(0, 60),
          createdAt: stamp,
        })),
      );
    }
    /* "When this job entered the status it is in now" — only for jobs whose
       STATUS moved; a stage change that kept the status leaves it alone. */
    const statusMoved = [...new Set(changes.filter((c) => c.field === "status").map((c) => c.requestId))];
    for (let index = 0; index < statusMoved.length; index += 50) {
      const ids = statusMoved.slice(index, index + 50);
      await db.run(sql`
        update maintenance_requests
           set status_changed_at = ${stamp}
         where organisation_id = ${input.organisationId}
           and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      `);
    }
    return changes.length;
  } catch (error) {
    console.error("[job-status-history] a transition could not be recorded", error);
    return 0;
  }
}

/** One job's transitions, newest first. */
export async function listJobStatusHistory(db: Database, organisationId: string, requestId: string, limit = 100) {
  return db
    .select()
    .from(jobStatusHistory)
    .where(and(eq(jobStatusHistory.organisationId, organisationId), eq(jobStatusHistory.requestId, requestId)))
    .orderBy(desc(jobStatusHistory.createdAt), desc(jobStatusHistory.id))
    .limit(limit);
}
