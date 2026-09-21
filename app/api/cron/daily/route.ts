/**
 * `POST|GET /api/cron/daily` — the portal's one daily job runner.
 *
 * ONE declared cron for the daily work, not one per feature: the Hobby plan
 * allows daily schedules only, and a deploy that declares more jobs than the
 * plan permits fails outright. So the daily features share this door, in
 * order, each isolated from the others' failure:
 *
 *   1. §25 planned maintenance — `generatePlannedOccurrences`, the same
 *      generator `/api/cron/planned-maintenance` and "Create due visits now" run;
 *   2. §32 scheduled reports — `deliverScheduledReports`, the same path as
 *      "Send now".
 *
 * AUTHENTICATION as every cron here: `CRON_SECRET`, bearer or `x-cron-secret`,
 * and REFUSED when unset (`authoriseCron` fails closed). A scheduler has no
 * session and no organisation; every write below carries the row's own
 * `organisation_id`. Vercel runs it on PRODUCTION only.
 */
import { getDb } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import { authoriseCron, resolveCronSecret } from "../../../lib/cron-auth";
import { generatePlannedOccurrences } from "../../../lib/planned-generation";
import { publicOrigin } from "../../../lib/public-origin";
import { deliverScheduledReports } from "../../../lib/report-delivery";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const refusal = authoriseCron(request, "daily", await resolveCronSecret());
  if (refusal) return refusal;
  try {
    await ensureDatabase();
    const db = await getDb();
    const planned = await generatePlannedOccurrences(db).catch((error: unknown) => {
      console.error("[/api/cron/daily] planned maintenance", error);
      return null;
    });
    const reports = await deliverScheduledReports(db, { origin: publicOrigin(request) }).catch((error: unknown) => {
      console.error("[/api/cron/daily] scheduled reports", error);
      return null;
    });
    /* Counts and ids only: this lands in platform logs. */
    return Response.json({
      ok: planned !== null && reports !== null,
      planned: planned ? { considered: planned.considered, created: planned.created, failed: planned.failed } : { error: true },
      reports: reports
        ? reports.map(({ scheduleId, organisationId, occurrence, outcome, recipients }) => ({ scheduleId, organisationId, occurrence, outcome, recipients }))
        : { error: true },
      ranAt: new Date().toISOString(),
    }, { status: planned !== null && reports !== null ? 200 : 503 });
  } catch (error) {
    console.error("[/api/cron/daily]", error);
    return Response.json({ error: "The daily run could not complete." }, { status: 503 });
  }
}

/** Vercel Cron issues a GET. */
export async function GET(request: Request) {
  return POST(request);
}
