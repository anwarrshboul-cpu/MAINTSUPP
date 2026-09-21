/**
 * TURNING A DUE PLANNED VISIT INTO A JOB — §25, the owner's decision Q4.
 *
 * The rules — what is due, where the calendar moves next — are the pure
 * functions in `planned-recurrence.ts`. This file does the three writes, in an
 * order that makes a crash or a race harmless:
 *
 *   1. CLAIM the visit: insert `(schedule_id, due_date)` into
 *      `planned_occurrences`, whose unique index lets exactly one run through.
 *      A run that loses the claim creates nothing.
 *   2. CREATE the job through `createSubmission` — the one door every other
 *      job comes through, so the id, placement, canonical priority, status chip
 *      and the `request.created` activity row are the product's, not a copy.
 *   3. ADVANCE the schedule, conditionally on `next_due_at` still being the
 *      visit just generated, so two runs can never step the calendar twice.
 *
 * If step 2 throws, the claim is deleted and the reason is kept on the
 * schedule (`last_generation_error`): the next run tries again, and the screen
 * can say why nothing appeared. If step 3 loses its condition, the job still
 * exists and the claim still blocks a duplicate — the schedule is simply
 * advanced by whichever run got there first.
 *
 * TENANCY. The cron route calls this with no organisation and it walks every
 * workspace's active schedules; every write carries the schedule's OWN
 * `organisation_id`, the same shape `/api/cron/retention` relies on. The
 * in-app "Create due visits now" calls it with the caller's organisation and
 * their site restriction.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  contractors,
  jobTypeConfig,
  maintenanceRequests,
  plannedMaintenance,
  plannedOccurrences,
  sites,
  units,
} from "../../db/schema";
import { DEFAULT_BOARD_KEY } from "./board-registry";
import {
  advanceAfterGeneration,
  planGeneration,
  todayUtc,
  type GenerationPlan,
} from "./planned-recurrence";
import { createSubmission, type SubmissionDatabase } from "./submission-service";

export type GenerationOutcome = {
  scheduleId: string;
  organisationId: string;
  title: string;
  result: "created" | "skipped" | "failed";
  reason?: string;
  dueDate?: string;
  requestId?: string;
  nextDueAt?: string;
};

export type GenerationReport = {
  today: string;
  considered: number;
  created: number;
  failed: number;
  outcomes: GenerationOutcome[];
};

/** Per run. A cron that met a thousand due schedules does the rest tomorrow. */
export const MAX_GENERATED_PER_RUN = 200;

/** A claim with no job after this long belonged to a run that died. */
export const CLAIM_TTL_MS = 15 * 60_000;

async function plannedJobTypeId(db: SubmissionDatabase, organisationId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: jobTypeConfig.id })
    .from(jobTypeConfig)
    .where(
      and(
        eq(jobTypeConfig.organisationId, organisationId),
        eq(jobTypeConfig.code, "planned"),
        isNull(jobTypeConfig.deactivatedAt),
      ),
    )
    .limit(1);
  /* A workspace that retired its Planned type gets Unclassified, which is what
     every other door writes when no type is named — never a retired id. */
  return row?.id ?? null;
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 300);
}

export async function generatePlannedOccurrences(
  db: SubmissionDatabase,
  options: {
    organisationId?: string;
    /** The caller's site restriction; `null` is unrestricted. */
    siteScope?: readonly string[] | null;
    today?: string;
    scheduleIds?: readonly string[];
  } = {},
): Promise<GenerationReport> {
  const today = options.today ?? todayUtc();
  const conditions = [eq(plannedMaintenance.generationState, "active")];
  if (options.organisationId) conditions.push(eq(plannedMaintenance.organisationId, options.organisationId));
  if (options.siteScope && options.siteScope.length) {
    conditions.push(inArray(plannedMaintenance.siteId, [...options.siteScope]));
  }
  if (options.scheduleIds && options.scheduleIds.length) {
    conditions.push(inArray(plannedMaintenance.id, [...options.scheduleIds]));
  }
  const schedules = await db.select().from(plannedMaintenance).where(and(...conditions));

  const report: GenerationReport = { today, considered: schedules.length, created: 0, failed: 0, outcomes: [] };
  const jobTypes = new Map<string, string | null>();

  for (const schedule of schedules) {
    const organisationId = schedule.organisationId;
    const base = { scheduleId: schedule.id, organisationId, title: schedule.title };
    const plan: GenerationPlan = planGeneration(schedule, today);
    if (!plan.generate) {
      report.outcomes.push({
        ...base,
        result: "skipped",
        reason: plan.reason,
        /* Which job the visit already became, so a caller can link to it. */
        ...(plan.reason === "already-generated" && schedule.lastGeneratedRequestId
          ? { requestId: schedule.lastGeneratedRequestId }
          : {}),
      });
      continue;
    }
    if (report.created >= MAX_GENERATED_PER_RUN) {
      report.outcomes.push({ ...base, result: "skipped", reason: "run-limit" });
      continue;
    }
    const dueDate = plan.dueDate;

    /* 1. CLAIM. */
    const claimId = `pocc_${crypto.randomUUID().replace(/-/g, "")}`;
    const [claimed] = await db
      .insert(plannedOccurrences)
      .values({
        id: claimId,
        organisationId,
        scheduleId: schedule.id,
        dueDate,
        status: "claimed",
        /* Written here rather than defaulted, so the staleness test above
           parses one format on both databases. */
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .returning({ id: plannedOccurrences.id });

    if (!claimed) {
      /*
       * The visit already has a claim. Three possibilities, told apart by what
       * actually exists rather than by what the claim row says:
       *
       *   · a job for this visit exists — a run created it and then died before
       *     finishing, or lost step 3. Adopt that job and advance the schedule;
       *   · no job, and the claim is older than CLAIM_TTL_MS — a run died
       *     between claiming and creating. Release the claim so the next run
       *     retries; creating here would race whatever else noticed it;
       *   · no job, a fresh claim — another run is mid-flight. Leave it.
       */
      const [existing] = await db
        .select()
        .from(plannedOccurrences)
        .where(and(eq(plannedOccurrences.scheduleId, schedule.id), eq(plannedOccurrences.dueDate, dueDate)))
        .limit(1);
      const [job] = await db
        .select({ id: maintenanceRequests.id })
        .from(maintenanceRequests)
        .where(
          and(
            eq(maintenanceRequests.organisationId, organisationId),
            eq(maintenanceRequests.plannedMaintenanceId, schedule.id),
            eq(maintenanceRequests.plannedDueDate, dueDate),
          ),
        )
        .limit(1);
      const requestId = existing?.requestId ?? job?.id ?? null;
      if (requestId) {
        if (existing && existing.status !== "created") {
          await db
            .update(plannedOccurrences)
            .set({ requestId, status: "created", updatedAt: new Date().toISOString() })
            .where(eq(plannedOccurrences.id, existing.id));
        }
        const nextDueAt = advanceAfterGeneration(schedule, dueDate, today);
        await db
          .update(plannedMaintenance)
          .set({
            nextDueAt,
            lastGeneratedDueAt: dueDate,
            lastGeneratedRequestId: requestId,
            lastGenerationError: null,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(plannedMaintenance.id, schedule.id),
              eq(plannedMaintenance.organisationId, organisationId),
              eq(plannedMaintenance.nextDueAt, schedule.nextDueAt),
            ),
          );
        report.outcomes.push({ ...base, result: "skipped", reason: "already-generated", dueDate, requestId, nextDueAt });
      } else if (existing && Date.now() - Date.parse(existing.createdAt) > CLAIM_TTL_MS) {
        await db.delete(plannedOccurrences).where(eq(plannedOccurrences.id, existing.id));
        report.outcomes.push({ ...base, result: "skipped", reason: "stale-claim-released", dueDate });
      } else {
        report.outcomes.push({ ...base, result: "skipped", reason: "in-flight", dueDate });
      }
      continue;
    }

    try {
      /* 2. CREATE, through the product's one door for new jobs. */
      if (!jobTypes.has(organisationId)) jobTypes.set(organisationId, await plannedJobTypeId(db, organisationId));
      const [site] = await db
        .select({ name: sites.name })
        .from(sites)
        .where(and(eq(sites.id, schedule.siteId), eq(sites.organisationId, organisationId)))
        .limit(1);
      /* A job carries no unit column, so a linked asset is named in the text. */
      const [unit] = schedule.unitId
        ? await db
            .select({ name: units.name })
            .from(units)
            .where(and(eq(units.id, schedule.unitId), eq(units.organisationId, organisationId)))
            .limit(1)
        : [];
      const [contractor] = schedule.contractorId
        ? await db
            .select({ name: contractors.name })
            .from(contractors)
            .where(and(eq(contractors.id, schedule.contractorId), eq(contractors.organisationId, organisationId)))
            .limit(1)
        : [];
      /*
       * The visit's date is the job's date. `createSubmission` derives `dueAt`
       * from the priority's SLA — hours from NOW — which for a job created
       * fourteen days ahead would mark it overdue before the visit. So the
       * deadline and the next-update prompt are the end of the visit day, and
       * `scheduled_date` is the day itself.
       */
      const endOfVisitDay = `${dueDate}T23:59:59.000Z`;
      const created = await createSubmission(db, {
        organisationId,
        boardId: DEFAULT_BOARD_KEY,
        actor: null,
        source: "Planned maintenance",
        explicitTitle: schedule.title,
        description:
          `Planned maintenance visit due ${dueDate} (${schedule.frequency}). ` +
          (unit?.name ? `Asset: ${unit.name}. ` : "") +
          `Created automatically from the schedule "${schedule.title}".`,
        location: site?.name ?? "",
        requester: "Planned maintenance schedule",
        contact: "",
        category: schedule.category,
        siteId: schedule.siteId,
        overrides: {
          jobTypeId: jobTypes.get(organisationId) ?? null,
          scheduledDate: dueDate,
          dueAt: endOfVisitDay,
          nextUpdateAt: endOfVisitDay,
          ...(schedule.contractorId
            ? { contractorId: schedule.contractorId, contractor: contractor?.name ?? null }
            : {}),
          plannedMaintenanceId: schedule.id,
          plannedDueDate: dueDate,
        },
        activityDetail: { plannedMaintenanceId: schedule.id, plannedDueDate: dueDate },
      });
      const requestId = created.request.id;

      await db
        .update(plannedOccurrences)
        .set({ requestId, status: "created", updatedAt: new Date().toISOString() })
        .where(eq(plannedOccurrences.id, claimId));

      /* 3. ADVANCE, only from the visit this run generated. */
      const nextDueAt = advanceAfterGeneration(schedule, dueDate, today);
      await db
        .update(plannedMaintenance)
        .set({
          nextDueAt,
          lastGeneratedDueAt: dueDate,
          lastGeneratedRequestId: requestId,
          lastGenerationError: null,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(plannedMaintenance.id, schedule.id),
            eq(plannedMaintenance.organisationId, organisationId),
            eq(plannedMaintenance.nextDueAt, schedule.nextDueAt),
          ),
        );

      report.created += 1;
      report.outcomes.push({ ...base, result: "created", dueDate, requestId, nextDueAt });
    } catch (error) {
      /* Release the claim so the next run retries, and say why on the schedule. */
      await db.delete(plannedOccurrences).where(eq(plannedOccurrences.id, claimId)).catch(() => {});
      await db
        .update(plannedMaintenance)
        .set({ lastGenerationError: shortError(error), updatedAt: new Date().toISOString() })
        .where(and(eq(plannedMaintenance.id, schedule.id), eq(plannedMaintenance.organisationId, organisationId)))
        .catch(() => {});
      report.failed += 1;
      report.outcomes.push({ ...base, result: "failed", reason: shortError(error), dueDate });
    }
  }
  return report;
}
