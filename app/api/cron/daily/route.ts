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
 *      "Send now";
 *   3. §35b webhook retries — `retryWebhookDeliveries`, the same claim-and-send
 *      the Retry button and the next event use, within a 20-second budget; it
 *      also prunes delivered rows older than 30 days. Never throws.
 *   4. abandoned uploads — `expireUploadSessions`: every direct-upload session
 *      past its expiry is aborted in storage (its parts are discarded) and
 *      marked `expired`. No document row ever existed for one.
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
import { retryWebhookDeliveries } from "../../../lib/integrations/webhooks";
import { expireUploadSessions } from "../../../lib/upload-sessions";

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
    const webhooks = await retryWebhookDeliveries(db, { limit: 200, budgetMs: 20_000 });
    const uploads = await expireUploadSessions(db, async (objectKey, uploadId, target) => {
      const { env } = await import("cloudflare:workers");
      /* The bucket the upload was going into: a website upload (decision K) is
         aborted in the website's bucket, never looked for among the documents. */
      const bucket = target === "cms-media" ? env.CMS_BUCKET : env.BUCKET;
      if (!bucket) throw new Error("File storage is unavailable.");
      await bucket.resumeMultipartUpload(objectKey, uploadId).abort();
    }).catch((error: unknown) => {
      console.error("[/api/cron/daily] upload sessions", error);
      return null;
    });
    /* Counts and ids only: this lands in platform logs. */
    return Response.json({
      ok: planned !== null && reports !== null,
      planned: planned ? { considered: planned.considered, created: planned.created, failed: planned.failed } : { error: true },
      reports: reports
        ? reports.map(({ scheduleId, organisationId, occurrence, outcome, recipients }) => ({ scheduleId, organisationId, occurrence, outcome, recipients }))
        : { error: true },
      webhooks,
      uploads: uploads ?? { error: true },
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
