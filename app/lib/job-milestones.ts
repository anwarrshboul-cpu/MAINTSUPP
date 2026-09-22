/**
 * A JOB'S THREE RESPONSE MILESTONES — acknowledged, assigned, attended.
 *
 * The owner's decision N, held here:
 *
 *   - ACKNOWLEDGED is the first explicit human acknowledgement ("Acknowledge"
 *     in the drawer), or the equivalent first meaningful human handling event:
 *     a person editing the job, moving it on the board, changing it in bulk,
 *     posting an update on it, assigning it or recording attendance. An
 *     automated transition is NOT acknowledgement, and neither is the job
 *     being created — raising a request is not answering it.
 *   - ASSIGNED is the first actual assignment of a responsible person
 *     (`assignee` / `assignee_user_id`) or engineer (`contractor` /
 *     `contractor_id`) — the write in which the job goes from having none to
 *     having one, whoever or whatever made it (an automation that assigns a
 *     real person has really assigned them). `engineer` is the TRADE the job
 *     needs ("Engineer Required"), not a person, and never counts.
 *   - ATTENDED is only ever EXPLICIT: "Record attendance" in the drawer. It is
 *     never inferred from a stage or a status name. Nothing in the product
 *     represented attendance before, so this is the smallest action that
 *     does.
 *
 * WRITE-ONCE. Each is stamped by one conditional UPDATE `… WHERE col IS NULL`,
 * so the first occurrence wins even between two concurrent writers, and a
 * later edit, reassignment or second visit never moves it.
 *
 * NOTHING HISTORICAL IS INVENTED. The three columns have existed on
 * `maintenance_requests` since the Overview's SLA work and nothing wrote them.
 * A job raised BEFORE this recording began may well have been handled already,
 * with no record of when — stamping "now" at its next edit would invent a
 * history. So milestones are recorded only for jobs raised on or after the
 * moment recording began (`feature_epochs`, written once by the migration on
 * each database's first boot with this code), and older jobs say so rather
 * than show a misleading time. No row is backfilled.
 *
 * THE EXISTING HISTORY. Every stamp also writes a `job_status_history` row
 * (`field = "milestone"`, `to_value` the milestone, who, and which door) — the
 * §23 record the drawer already shows — and an `audit_events` row. Like
 * `recordJobStatusChanges`, a failure here is logged and never fails the change
 * that caused it: the job has already been edited by then.
 */

import { sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { jobStatusHistory, maintenanceRequests } from "../../db/schema";
import { recordAudit } from "./audit";
import { jobsBoardCondition } from "./dashboard-filters";

type Database = Awaited<ReturnType<typeof getDb>>;

export type Milestone = "acknowledged" | "assigned" | "attended";
export const MILESTONES: readonly Milestone[] = ["acknowledged", "assigned", "attended"];

/** The raw columns (added by `ensureOverviewFoundation`; not declared in `db/schema.ts`). */
const COLUMN: Record<Milestone, string> = {
  acknowledged: "acknowledged_at",
  assigned: "assigned_at",
  attended: "attended_at",
};

export const MILESTONE_LABEL: Record<Milestone, string> = {
  acknowledged: "Acknowledged",
  assigned: "Assigned",
  attended: "Attended",
};

/** The `job_status_history.field` a milestone is written under. */
export const MILESTONE_FIELD = "milestone";

/** The `feature_epochs` key whose `started_at` says when recording began. */
export const MILESTONE_EPOCH_KEY = "job_milestones";

/* ── Pure rules ─────────────────────────────────────────────────────────── */

export type AssignmentFields = {
  assignee?: unknown;
  assigneeUserId?: unknown;
  contractor?: unknown;
  contractorId?: unknown;
};

const present = (value: unknown) => typeof value === "string" ? value.trim().length > 0 : value !== null && value !== undefined;

/** Whether a row names a responsible person or an engineer. */
export function hasAssignment(row: AssignmentFields | null | undefined): boolean {
  if (!row) return false;
  return present(row.assignee) || present(row.assigneeUserId) || present(row.contractor) || present(row.contractorId);
}

export type MilestoneChange = {
  requestId: string;
  /** The row as it was, or null for a job created by this write. */
  before: AssignmentFields | null;
  after: AssignmentFields | null;
  /** Explicit actions taken on this job in this write. */
  explicit?: readonly ("acknowledged" | "attended")[];
};

/**
 * WHICH MILESTONES A WRITE IMPLIES — before the database says which are still
 * open. `human` is whether a person made the write (the door knows; an
 * automation, an import, a form or a scheduled job is not a person), and
 * `handled` whether the write counts as handling the job (every human write
 * does except creating it).
 */
export function impliedMilestones(
  change: MilestoneChange,
  door: { human: boolean; handled: boolean },
): Milestone[] {
  const implied = new Set<Milestone>();
  for (const action of change.explicit ?? []) implied.add(action);
  const assignedNow = hasAssignment(change.after) && !hasAssignment(change.before);
  if (assignedNow) implied.add("assigned");
  /* A person handling the job acknowledges it — by any handling write, which
     includes assigning it, or by an explicit action. Creating a job is not
     handling it (a duplicate that arrives already assigned was copied, not
     assigned by anyone), and an automation never is. */
  if (door.human && (door.handled || (change.explicit?.length ?? 0) > 0)) implied.add("acknowledged");
  return MILESTONES.filter((milestone) => implied.has(milestone));
}

/**
 * An instant from either dialect's text: ISO (`…T…Z`), SQLite's
 * `YYYY-MM-DD HH:MM:SS` (UTC), or Postgres's `YYYY-MM-DD HH:MM:SS.fff+00`.
 * NaN when it is none of them.
 */
export function instantOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" || !value.trim()) return Number.NaN;
  let text = value.trim().replace(" ", "T");
  if (/[+-]\d{2}$/.test(text)) text = `${text}:00`;
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(text)) text = `${text}Z`;
  return Date.parse(text);
}

/** Whether a job raised at `requestedAt` falls inside the recording. */
export function withinRecording(requestedAt: unknown, epoch: string | null): boolean {
  if (!epoch) return false;
  const raised = instantOf(requestedAt);
  const began = instantOf(epoch);
  return Number.isFinite(raised) && Number.isFinite(began) && raised >= began;
}

/* ── Reading ────────────────────────────────────────────────────────────── */

let epochMemo: Promise<string | null> | null = null;

/** When recording began on this database. Read once per instance; a failure is not cached. */
export function milestoneEpoch(db: Database): Promise<string | null> {
  if (!epochMemo) {
    epochMemo = db
      .all<{ started_at: string | null }>(
        sql`select cast(started_at as text) as started_at from feature_epochs where feature = ${MILESTONE_EPOCH_KEY}`,
      )
      .then((rows) => rows[0]?.started_at ?? null)
      .catch((error) => {
        epochMemo = null;
        console.error("[job-milestones] the recording epoch could not be read", error);
        return null;
      });
  }
  return epochMemo;
}

/** Forget the memo — tests only. */
export function forgetMilestoneEpoch() {
  epochMemo = null;
}

export type MilestoneRow = {
  id: string;
  requestedAt: string | null;
  acknowledgedAt: string | null;
  assignedAt: string | null;
  attendedAt: string | null;
};

const iso = (value: unknown): string | null => {
  const at = instantOf(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};

/**
 * The three stamps (and when the job was raised) for these jobs, in this
 * workspace — WORK ORDERS ONLY: a live, top-level job on the Jobs board (or on
 * no board yet). A Store Documentation register row, a section's row or a
 * subitem is a `maintenance_requests` row too, and has no response cycle to
 * measure; the same exclusions every job count in the product applies
 * (`jobsBoardCondition`). An id that is not a work order is simply absent.
 */
export async function readMilestoneRows(
  db: Database,
  organisationId: string,
  ids: readonly string[],
): Promise<MilestoneRow[]> {
  const unique = [...new Set(ids)].filter(Boolean);
  const rows: MilestoneRow[] = [];
  for (let index = 0; index < unique.length; index += 50) {
    const slice = unique.slice(index, index + 50);
    const found = await db.all<Record<string, unknown>>(sql`
      select ${maintenanceRequests.id} as id,
             cast(${maintenanceRequests.requestedAt} as text) as requested_at,
             cast(${sql.raw('"maintenance_requests"."acknowledged_at"')} as text) as acknowledged_at,
             cast(${sql.raw('"maintenance_requests"."assigned_at"')} as text) as assigned_at,
             cast(${sql.raw('"maintenance_requests"."attended_at"')} as text) as attended_at
        from ${maintenanceRequests}
       where ${maintenanceRequests.organisationId} = ${organisationId}
         and ${maintenanceRequests.id} in (${sql.join(slice.map((id) => sql`${id}`), sql`, `)})
         and ${maintenanceRequests.deletedAt} is null
         and ${maintenanceRequests.parentId} is null
         and ${jobsBoardCondition()}
    `);
    for (const row of found) {
      rows.push({
        id: String(row.id),
        requestedAt: iso(row.requested_at),
        acknowledgedAt: iso(row.acknowledged_at),
        assignedAt: iso(row.assigned_at),
        attendedAt: iso(row.attended_at),
      });
    }
  }
  return rows;
}

const stampOf = (row: MilestoneRow, milestone: Milestone) =>
  milestone === "acknowledged" ? row.acknowledgedAt : milestone === "assigned" ? row.assignedAt : row.attendedAt;

/* ── Writing ────────────────────────────────────────────────────────────── */

export type RecordedMilestone = { requestId: string; milestone: Milestone; at: string };

/**
 * STAMP WHAT A WRITE IMPLIES, ONCE — the one function every door calls.
 *
 * Returns what was newly recorded. Never throws.
 */
export async function recordJobMilestones(
  db: Database,
  input: {
    organisationId: string;
    actorEmail: string | null | undefined;
    /** Which door — the same vocabulary `recordJobStatusChanges` uses. */
    source: string;
    human: boolean;
    handled: boolean;
    changes: readonly MilestoneChange[];
    request?: Request | null;
  },
): Promise<RecordedMilestone[]> {
  try {
    const wanted = new Map<string, Milestone[]>();
    for (const change of input.changes) {
      const implied = impliedMilestones(change, { human: input.human, handled: input.handled });
      if (implied.length) wanted.set(change.requestId, [...new Set([...(wanted.get(change.requestId) ?? []), ...implied])]);
    }
    if (!wanted.size) return [];
    const epoch = await milestoneEpoch(db);
    if (!epoch) return [];
    const rows = await readMilestoneRows(db, input.organisationId, [...wanted.keys()]);
    const stamp = new Date().toISOString();
    const recorded: RecordedMilestone[] = [];
    for (const milestone of MILESTONES) {
      const candidates = rows
        .filter((row) => (wanted.get(row.id) ?? []).includes(milestone))
        .filter((row) => withinRecording(row.requestedAt, epoch) && !stampOf(row, milestone))
        .map((row) => row.id);
      for (let index = 0; index < candidates.length; index += 50) {
        const slice = candidates.slice(index, index + 50);
        /* Write-once: the first writer to see the column empty is the only one
           whose UPDATE matches, so a race records one time, not two. */
        const won = await db.all<{ id: string }>(sql`
          update maintenance_requests
             set ${sql.raw(COLUMN[milestone])} = ${stamp}
           where organisation_id = ${input.organisationId}
             and id in (${sql.join(slice.map((id) => sql`${id}`), sql`, `)})
             and ${sql.raw(COLUMN[milestone])} is null
          returning id
        `);
        for (const row of won) recorded.push({ requestId: String(row.id), milestone, at: stamp });
      }
    }
    if (!recorded.length) return [];

    for (let index = 0; index < recorded.length; index += 50) {
      await db.insert(jobStatusHistory).values(
        recorded.slice(index, index + 50).map((entry) => ({
          id: `jsh_${crypto.randomUUID().replace(/-/g, "")}`,
          organisationId: input.organisationId,
          requestId: entry.requestId,
          field: MILESTONE_FIELD,
          fromValue: null,
          toValue: entry.milestone,
          actorEmail: input.actorEmail ?? null,
          source: input.source.slice(0, 60),
          createdAt: stamp,
        })),
      );
    }
    for (const entry of recorded) {
      await recordAudit({
        db,
        organisationId: input.organisationId,
        actor: { email: input.actorEmail ?? null },
        action: `job.${entry.milestone}`,
        entityType: "maintenance_request",
        entityId: entry.requestId,
        summary: `${MILESTONE_LABEL[entry.milestone]} recorded for ${entry.requestId} (${input.source}${input.actorEmail ? `, by ${input.actorEmail}` : ""}).`,
        detail: { milestone: entry.milestone, at: entry.at, source: input.source, human: input.human },
        request: input.request ?? null,
      });
    }
    return recorded;
  } catch (error) {
    console.error("[job-milestones] a milestone could not be recorded", error);
    return [];
  }
}
