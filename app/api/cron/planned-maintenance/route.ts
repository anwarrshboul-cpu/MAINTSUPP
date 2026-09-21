/**
 * `POST|GET /api/cron/planned-maintenance` — §25, once a day.
 *
 * Turns every ACTIVE schedule's next visit into a job when its lead window has
 * opened (next due − lead days), then steps the schedule to the following
 * visit. All the rules are in `app/lib/planned-recurrence.ts`; all the writes
 * are in `app/lib/planned-generation.ts`. This file is only the timer's door.
 *
 * WHY AN UNSCOPED HANDLE IS SAFE HERE — the argument `/api/cron/retention`
 * makes, and it holds for the same reason: a scheduler has no caller and no
 * membership, so it cannot name an organisation. The generator reads each
 * schedule and writes only under that schedule's OWN `organisation_id`.
 *
 * AUTHENTICATION. Bearer `CRON_SECRET` (Vercel Cron) or `x-cron-secret`, and
 * REFUSED when the variable is unset — `authoriseCron` fails closed. This door
 * creates jobs on customers' boards; it must never be callable by anyone who
 * finds the URL.
 *
 * DAILY IS ENOUGH, and that matters on the Hobby plan, which refuses anything
 * more often: lead times are whole days, so a visit whose window opens today
 * is created by today's run. Vercel runs crons on PRODUCTION only; on a
 * Preview the in-app "Create due visits now" (`/api/planned-maintenance/
 * generate`) drives the same generator for one workspace.
 */
import { getDb } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import { authoriseCron, resolveCronSecret } from "../../../lib/cron-auth";
import { generatePlannedOccurrences } from "../../../lib/planned-generation";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const refusal = authoriseCron(request, "planned-maintenance", await resolveCronSecret());
  if (refusal) return refusal;

  try {
    await ensureDatabase();
    const report = await generatePlannedOccurrences(await getDb());
    /* Counts and ids only: this response lands in platform logs, and a
       schedule's title is a customer's words. */
    return Response.json({
      ok: true,
      today: report.today,
      considered: report.considered,
      created: report.created,
      failed: report.failed,
      outcomes: report.outcomes.map(({ scheduleId, organisationId, result, reason, dueDate, requestId, nextDueAt }) => ({
        scheduleId,
        organisationId,
        result,
        reason,
        dueDate,
        requestId,
        nextDueAt,
      })),
      ranAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[/api/cron/planned-maintenance]", error);
    /* A failed run must not look like an empty one. Nothing was half-written
       that the next run cannot finish: see the claim rules in the generator. */
    return Response.json({ error: "Planned maintenance generation could not complete." }, { status: 503 });
  }
}

/** Vercel Cron issues a GET. Same work, same authentication. */
export async function GET(request: Request) {
  return POST(request);
}
