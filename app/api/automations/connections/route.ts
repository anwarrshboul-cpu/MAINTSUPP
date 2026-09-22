/**
 * `GET /api/automations/connections` — what this workspace can actually talk to.
 *
 * One entry per integration that genuinely exists in this codebase: email
 * through Resend (`app/lib/notifications.ts`), connected only when
 * `RESEND_API_KEY` is set; SMS, declared with no provider behind it; and (§34)
 * Slack connections and signed webhooks, connected only when THIS workspace has
 * one switched on (`webhook_endpoints`, §35b). Teams, Gmail and Outlook are not
 * listed because nothing here speaks to them — the catalogue shows them greyed
 * out with "Requires a connection" instead.
 */

import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { webhookEndpoints } from "../../../../db/schema";
import { secretBoxStatus } from "../../../lib/secret-box";
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
    const endpoints = await guard.scope.db
      .select({ kind: webhookEndpoints.kind })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.organisationId, guard.scope.orgId), eq(webhookEndpoints.state, "on")));
    const slackOn = endpoints.filter((endpoint) => endpoint.kind === "slack").length;
    const webhooksOn = endpoints.filter((endpoint) => endpoint.kind === "webhook").length;
    const storage = await secretBoxStatus();
    const notYet = (what: string) =>
      storage.configured
        ? `This workspace has no ${what} switched on. Add one under Account → Developers.`
        : `Not available on this deployment: ${storage.reason}`;
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
          key: "slack",
          label: "Slack",
          provider: "Slack incoming webhooks",
          connected: slackOn > 0,
          detail: slackOn > 0 ? `${slackOn} Slack connection${slackOn === 1 ? "" : "s"} on. Rules can post to them.` : notYet("Slack connection"),
        },
        {
          key: "webhooks",
          label: "Signed webhooks",
          provider: null,
          connected: webhooksOn > 0,
          detail: webhooksOn > 0 ? `${webhooksOn} webhook${webhooksOn === 1 ? "" : "s"} on. Rules can send signed events to them.` : notYet("webhook"),
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
