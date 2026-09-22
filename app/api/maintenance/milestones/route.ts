/**
 * A JOB'S RESPONSE MILESTONES — read them, and record the two explicit ones.
 *
 *   GET  ?id=  — acknowledged / assigned / attended: when, by whom and through
 *                which door, whether this job is inside the recording, and
 *                whether the caller may record. `board.view`, inside the
 *                member's sites — the same answer the job itself gets.
 *   POST { id, milestone: "acknowledged" | "attended" } — the drawer's
 *                "Acknowledge" and "Record attendance". `board.edit`, inside
 *                the member's sites.
 *
 * ASSIGNED IS NEVER POSTED. It is the write that gives the job a responsible
 * person or engineer, recorded by whichever door made it; a button that
 * claimed an assignment without making one would be exactly the invented
 * timestamp the owner ruled out.
 *
 * EACH IS WRITE-ONCE. A second "Acknowledge" is a 409 naming the time already
 * recorded, not a new time. Recording attendance on a job nobody has
 * acknowledged acknowledges it too — attending is handling it.
 *
 * See `app/lib/job-milestones.ts` for what counts, and for why a job raised
 * before recording began carries none.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { jobStatusHistory, maintenanceRequests } from "../../../../db/schema";
import { jobWithinMemberScope } from "../../../lib/job-site-scope";
import {
  MILESTONES,
  MILESTONE_FIELD,
  MILESTONE_LABEL,
  milestoneEpoch,
  readMilestoneRows,
  recordJobMilestones,
  withinRecording,
  type Milestone,
} from "../../../lib/job-milestones";
import { memberSiteCondition } from "../../../lib/member-site-scope";
import { requireCapability, resolvePermissions } from "../../../lib/permissions";
import { anonymousRefusal, scopedDbWithCapability, type ScopedDatabase } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

const EXPLICIT = new Set<Milestone>(["acknowledged", "attended"]);

function unavailable(error: unknown) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  console.error("[/api/maintenance/milestones]", error);
  return Response.json({ error: "The job's milestones are temporarily unavailable." }, { status: 503 });
}

const notFound = () => Response.json({ error: "Request not found." }, { status: 404 });

/** The job, in this workspace, not binned, inside the member's sites — or null. */
async function visibleJob(scope: ScopedDatabase, id: string) {
  const [row] = await scope.db
    .select({ id: maintenanceRequests.id })
    .from(maintenanceRequests)
    .where(
      and(
        eq(maintenanceRequests.id, id),
        eq(maintenanceRequests.organisationId, scope.orgId),
        isNull(maintenanceRequests.deletedAt),
        memberSiteCondition(maintenanceRequests.siteId, scope.siteScope),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** What the drawer is told about one job. */
async function describe(scope: ScopedDatabase, id: string) {
  const [row] = await readMilestoneRows(scope.db, scope.orgId, [id]);
  const epoch = await milestoneEpoch(scope.db);
  const history = await scope.db
    .select()
    .from(jobStatusHistory)
    .where(
      and(
        eq(jobStatusHistory.organisationId, scope.orgId),
        eq(jobStatusHistory.requestId, id),
        eq(jobStatusHistory.field, MILESTONE_FIELD),
      ),
    )
    .orderBy(asc(jobStatusHistory.createdAt))
    .limit(10);
  const subject = await resolvePermissions(scope.db, scope.orgId, scope.actor.role, scope.siteScope);
  const workOrder = Boolean(row);
  const eligible = workOrder && withinRecording(row?.requestedAt ?? null, epoch);
  const milestones = Object.fromEntries(
    MILESTONES.map((milestone) => {
      const at = row
        ? milestone === "acknowledged"
          ? row.acknowledgedAt
          : milestone === "assigned"
            ? row.assignedAt
            : row.attendedAt
        : null;
      const first = history.find((entry) => entry.toValue === milestone);
      return [
        milestone,
        at
          ? { at, label: MILESTONE_LABEL[milestone], actorEmail: first?.actorEmail ?? null, source: first?.source ?? null }
          : null,
      ];
    }),
  );
  return {
    id,
    milestones,
    workOrder,
    eligible,
    since: epoch,
    reason: !workOrder
      ? "Milestones are recorded for jobs on the Jobs board."
      : eligible
        ? null
        : "This job was raised before these milestones began to be recorded, so none are shown — nothing is reconstructed.",
    canRecord: eligible && !requireCapability(subject, "board.edit"),
  };
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const id = (new URL(request.url).searchParams.get("id") ?? "").trim().slice(0, 40);
    if (!id) return Response.json({ error: "A request ID is required." }, { status: 400 });
    if (!(await visibleJob(guard.scope, id))) return notFound();
    return Response.json(await describe(guard.scope, id), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return unavailable(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { scope } = guard;
    const payload = (await request.json().catch(() => null)) as { id?: unknown; milestone?: unknown } | null;
    const id = typeof payload?.id === "string" ? payload.id.trim().slice(0, 40) : "";
    const milestone = payload?.milestone as Milestone;
    if (!id) return Response.json({ error: "A request ID is required." }, { status: 400 });
    if (!EXPLICIT.has(milestone)) {
      return Response.json(
        { error: "Record \"acknowledged\" or \"attended\". An assignment is recorded when a person or engineer is assigned." },
        { status: 400 },
      );
    }
    /* Outside the member's sites is the 404 a missing job gets — asked first. */
    if (!(await jobWithinMemberScope(scope.db, scope.orgId, scope.siteScope, id))) return notFound();
    if (!(await visibleJob(scope, id))) return notFound();

    const before = await describe(scope, id);
    if (!before.workOrder || !before.eligible) {
      return Response.json({ error: before.reason, ...before }, { status: 409 });
    }
    const existing = (before.milestones as Record<Milestone, { at: string } | null>)[milestone];
    if (existing) {
      return Response.json(
        { error: `${MILESTONE_LABEL[milestone]} was already recorded at ${existing.at}. It is recorded once.`, ...before },
        { status: 409 },
      );
    }
    const recorded = await recordJobMilestones(scope.db, {
      organisationId: scope.orgId,
      actorEmail: scope.actor.email,
      source: "job.milestone",
      human: true,
      handled: true,
      changes: [{ requestId: id, before: null, after: null, explicit: [milestone as "acknowledged" | "attended"] }],
      request,
    });
    const after = await describe(scope, id);
    if (!recorded.some((entry) => entry.milestone === milestone)) {
      /* Another writer got there first, or the write failed and was logged. */
      return Response.json(
        { error: `${MILESTONE_LABEL[milestone]} could not be recorded. Reload the job to see its current state.`, ...after },
        { status: 409 },
      );
    }
    return Response.json({ ...after, recorded }, { status: 201 });
  } catch (error) {
    return unavailable(error);
  }
}
