/**
 * `GET /api/automations/connections` — what this workspace can actually talk to.
 *
 * One entry per integration that genuinely exists in this codebase. Today
 * that is email through Resend (`app/lib/notifications.ts`), reported as
 * connected only when `RESEND_API_KEY` is set; SMS is declared in the same
 * module and has no provider behind it, and is listed as such. Slack, Teams,
 * Gmail and Outlook are not listed because nothing here speaks to them —
 * the catalogue shows them greyed out with "Requires a connection" instead.
 */

import { ensureDatabase } from "../../../../db/init";
import { catalogEnvironment } from "../../../lib/automations/store";
import { emailDeliveryStatus } from "../../../lib/notifications";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const { emailConfigured } = catalogEnvironment();
    /* §33: a key is not delivery. With `EMAIL_MODE` at sink or log, the rule's
       email reaches the test inbox or nobody, and the detail says so. */
    const delivery = emailDeliveryStatus();
    return Response.json({
      connections: [
        {
          key: "email",
          label: "Email",
          provider: "Resend",
          connected: emailConfigured,
          detail: !emailConfigured
            ? "No RESEND_API_KEY is configured. Email actions are logged as skipped until one is."
            : delivery.deliverable
              ? "Messages are sent through the workspace's mail provider and logged in the notification log."
              : `${delivery.reason} Email actions are logged as not delivered.`,
        },
        {
          key: "sms",
          label: "SMS",
          provider: null,
          connected: false,
          detail: "Declared in the notification module with no provider behind it. Not usable by a rule.",
        },
      ],
      note: "Only integrations that exist in this product are listed. Nothing else is connected, and nothing else is pretended.",
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: "Connections are temporarily unavailable." }, { status: 503 });
  }
}
