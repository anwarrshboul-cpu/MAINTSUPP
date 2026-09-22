/**
 * Developers and Integrations — what this workspace is actually plugged into.
 *
 * monday's avatar menu has "Developers" (API tokens, webhooks, apps) and "App
 * marketplace". The MAINTSUPP equivalents are Developers and Integrations, and
 * both are answered from the runtime rather than from a brochure: a connector
 * is reported as configured only when the binding or the key is present in this
 * Worker's environment, and token counts come from the table that holds them.
 *
 * Everything the product does not have is returned as `available: false` with a
 * reason, so the screen can be complete without being fictional.
 */

import { and, count, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import {
  attachments,
  jobAccessTokens,
  maintenanceRequests,
  notificationLog,
} from "../../../../db/schema";
import { emailDeliveryStatus, notificationTargets } from "../../../lib/notifications";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";
import { can, resolvePermissions } from "../../../lib/permissions";

/** Reads a Worker environment variable the way `app/lib/notifications.ts` does. */
function environmentValue(key: string) {
  const holder = (globalThis as Record<string, unknown>).process as
    | { env?: Record<string, string | undefined> }
    | undefined;
  return holder?.env?.[key] ?? undefined;
}

/**
 * True when the Worker really has the named binding attached.
 *
 * `cloudflare:workers` is a runtime module with no local type declarations, so
 * `tsc` cannot resolve it — the same unresolved import the file routes carry.
 * Suppressed here rather than added to the project's error count.
 */
async function hasBinding(key: string) {
  try {
    // @ts-expect-error — Workers runtime module, resolved at run time only.
    const { env } = await import("cloudflare:workers");
    return Boolean((env as unknown as Record<string, unknown>)[key]);
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const context = await scopedDb(request);
    const orgId = context.orgId;
    const now = new Date().toISOString();

    /*
     * WHICH HALF OF THIS SCREEN IS THE TENANT'S, AND WHICH IS THE DEPLOYMENT'S.
     *
     * Everything counted below is this workspace's own: how many contractor job
     * links are live, expired or revoked, and how its notifications were
     * delivered. That is operational data and it stays open to any member.
     *
     * Three blocks are not. `support` carries the operator's own inbox
     * addresses; `integrations` says which secrets are configured and whether
     * the storage binding is attached; and `publicEndpoints` is a hand-written
     * map of the two routes that accept an unauthenticated request. None of it
     * is another tenant's data — every query here is `eq(organisationId,
     * orgId)`, and that was checked — but it is a description of the
     * installation, served to any signed-in member from a panel in the avatar
     * menu that has no role gate.
     *
     * `settings.edit` is the boundary, because it is what the sibling
     * operational-configuration routes already use. Narrowed in the payload
     * rather than at the door: `ROLE_CEILINGS` makes `settings.edit`
     * unholdable by `manager`, so gating the route would take the workspace's
     * own token counts away from managers permanently to withhold something
     * that is not about the workspace at all.
     */
    const subject = await resolvePermissions(context.db, orgId, context.actor.role);
    const mayReadPosture = can(subject, "settings.edit");

    const [
      liveTokens,
      revokedTokens,
      expiredTokens,
      usedTokens,
      notificationRows,
      importedRows,
      fileRows,
      bucketBound,
    ] = await Promise.all([
      context.db
        .select({ value: count() })
        .from(jobAccessTokens)
        .where(
          and(
            eq(jobAccessTokens.organisationId, orgId),
            isNull(jobAccessTokens.revokedAt),
            gt(jobAccessTokens.expiresAt, now),
          ),
        ),
      context.db
        .select({ value: count() })
        .from(jobAccessTokens)
        .where(
          and(
            eq(jobAccessTokens.organisationId, orgId),
            isNotNull(jobAccessTokens.revokedAt),
          ),
        ),
      context.db
        .select({ value: count() })
        .from(jobAccessTokens)
        .where(
          and(
            eq(jobAccessTokens.organisationId, orgId),
            isNull(jobAccessTokens.revokedAt),
            sql`${jobAccessTokens.expiresAt} <= ${now}`,
          ),
        ),
      context.db
        .select({ value: count() })
        .from(jobAccessTokens)
        .where(
          and(
            eq(jobAccessTokens.organisationId, orgId),
            isNotNull(jobAccessTokens.firstOpenedAt),
          ),
        ),
      context.db
        .select({
          channel: notificationLog.channel,
          status: notificationLog.status,
          value: count(),
        })
        .from(notificationLog)
        .where(eq(notificationLog.organisationId, orgId))
        .groupBy(notificationLog.channel, notificationLog.status),
      context.db
        .select({ value: count() })
        .from(maintenanceRequests)
        .where(
          and(
            eq(maintenanceRequests.organisationId, orgId),
            isNotNull(maintenanceRequests.externalId),
            isNull(maintenanceRequests.deletedAt),
          ),
        ),
      context.db
        .select({ value: count() })
        .from(attachments)
        .where(eq(attachments.organisationId, orgId)),
      hasBinding("BUCKET"),
    ]);

    const emailKey = Boolean(environmentValue("RESEND_API_KEY"));
    const smsKey = Boolean(environmentValue("SMS_API_KEY"));
    const notifications = notificationRows.map((row) => ({
      channel: row.channel,
      status: row.status,
      count: row.value,
    }));

    const platform = {
        /**
         * Developers. The one credential system that genuinely exists is the
         * scoped job-access token a contractor receives — hashed at rest,
         * expiring, revocable, and counted here from its own table.
         */
        developers: {
          credentials: [
            {
              key: "job_access_tokens",
              name: "Contractor job links",
              available: true,
              summary:
                "Scoped, expiring, revocable tokens that let one contractor act on one job. Only the hash is stored.",
              stats: [
                { label: "Live", value: liveTokens[0]?.value ?? 0 },
                { label: "Expired", value: expiredTokens[0]?.value ?? 0 },
                { label: "Revoked", value: revokedTokens[0]?.value ?? 0 },
                { label: "Opened at least once", value: usedTokens[0]?.value ?? 0 },
              ],
              managedAt: "Any job → Contractor link",
              endpoint: "/api/job-link/{token}",
            },
            {
              key: "personal_api_keys",
              name: "Personal API keys",
              available: false,
              summary:
                "There is no personal API key. Every route authenticates the browser's identity and resolves permissions from the caller's memberships, so there is no credential to issue or rotate.",
            },
          ],
          webhooks: {
            outbound: {
              available: false,
              reason:
                "No webhook registration table exists and nothing in the codebase posts to a subscriber URL. Outbound events are delivered by email and SMS through the notification log.",
            },
            inbound: {
              available: false,
              reason:
                "No route accepts a signed third-party callback. The only externally reachable entry points are the public request form and a contractor's job-link token.",
            },
          },
          /** The two endpoints that are genuinely reachable from outside. */
          publicEndpoints: [
            {
              method: "POST",
              path: "/api/leads",
              description: "Public request form intake. No credential required.",
            },
            {
              method: "GET/POST",
              path: "/api/job-link/{token}",
              description:
                "Contractor job access. Authenticated by the token in the path.",
            },
          ],
          notificationDelivery: notifications,
        },

        /**
         * Integrations — monday's App marketplace slot. Each entry reports what
         * the runtime actually shows, not what the product could support.
         */
        integrations: [
          {
            key: "monday",
            name: "monday.com import",
            category: "Data",
            configured: true,
            detail:
              importedRows[0]?.value
                ? `${importedRows[0].value} jobs in this workspace carry a monday item id.`
                : "No row in this workspace has been imported from monday yet.",
            action: { label: "Open importer", href: "/dashboard?manage=import" },
          },
          {
            key: "r2",
            name: "Cloudflare R2 file storage",
            category: "Storage",
            configured: bucketBound,
            detail: bucketBound
              ? `Bucket binding attached. ${fileRows[0]?.value ?? 0} files stored for this workspace.`
              : "The BUCKET binding is not attached to this Worker, so uploads cannot be stored.",
          },
          {
            key: "d1",
            name: "Cloudflare D1",
            category: "Storage",
            configured: true,
            detail: "The workspace database. Bound as DB.",
          },
          {
            key: "resend",
            name: "Resend email delivery",
            category: "Notifications",
            configured: emailKey,
            /* §33: "delivered" only when it is — a key with EMAIL_MODE at sink
               or log reaches the test inbox or nobody. */
            detail: !emailKey
              ? "RESEND_API_KEY is not set. Notifications are recorded as skipped and can be replayed once a key is configured."
              : (emailDeliveryStatus().reason ?? "RESEND_API_KEY is set and EMAIL_MODE is live; notifications are delivered and logged."),
          },
          {
            key: "sms",
            name: "SMS delivery",
            category: "Notifications",
            configured: smsKey,
            detail: smsKey
              ? "SMS_API_KEY is set; SMS notifications are delivered and logged."
              : "SMS_API_KEY is not set, so SMS notifications are logged as skipped.",
          },
          {
            key: "job_links",
            name: "Contractor job links",
            category: "Field",
            configured: true,
            detail: `${liveTokens[0]?.value ?? 0} live contractor links.`,
            action: { label: "Open the jobs board", href: "/dashboard/jobs" },
          },
          {
            key: "request_form",
            name: "Public request form",
            category: "Field",
            configured: true,
            detail: "Anyone with the link can raise a job without an account.",
            action: { label: "Open the form", href: "/request" },
          },
        ],

        /**
         * Get help. The inboxes are the ones the Worker is actually configured
         * to notify, so the address on the help screen is the address a lead or
         * an alert really goes to — not a placeholder typed into a page.
         */
      support: {
        ...notificationTargets(),
        emailDeliveryConfigured: emailKey,
      },
    };

    if (mayReadPosture) return Response.json({ platform });

    /* The workspace keeps its own figures; the installation's description goes.
       Built by naming what survives rather than by destructuring away what does
       not: an omit-by-rest leaves two bindings nothing reads, and a reader has
       to work out which keys are missing by comparing two places. */
    return Response.json({
      platform: {
        developers: { ...platform.developers, publicEndpoints: [] },
        integrations: [],
        support: null,
        /* Stated, so the screen can say "you do not have permission to see
           this" instead of drawing an empty panel. */
        canReadPosture: false,
      },
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The platform status could not be loaded.",
      },
      { status: 503 },
    );
  }
}
