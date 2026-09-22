/**
 * `/api/integrations/webhooks` — a workspace's outbound webhooks and Slack
 * connections (§35b). Every method needs `integrations.manage`.
 *
 * GET     endpoints (host and a hint only — never the stored address or secret),
 *         the events on offer, and whether this deployment can store them.
 * POST    `{ kind, name, url, events }`. Refused with 409 `notConfigured` when
 *         `MAINTSUPP_SECRETS_KEY` is not set (owner decision Q2: nothing is
 *         stored in the clear, so without the key nothing is stored at all).
 *         Only a signed-in account, and only one whose access is not restricted
 *         to some sites: a webhook carries events from the whole workspace.
 *         A webhook's signing secret is returned ONCE; a Slack hook has none.
 * PATCH   `{ id, action: "pause" | "resume" | "roll_secret" }`.
 * DELETE  `?id=` → marked deleted and its stored credentials wiped.
 *
 * The audit trail names the endpoint and its host — never the address or secret.
 */

import { and, count, eq, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { webhookEndpoints } from "../../../../db/schema";
import { auditActor, recordAudit } from "../../../lib/audit";
import { databaseSafeFailure } from "../../../lib/database-failure";
import { checkOutboundUrl, describeUrl, type EndpointKind } from "../../../lib/integrations/outbound-url";
import { newSigningSecret } from "../../../lib/integrations/webhook-signature";
import {
  ENDPOINT_COLUMNS,
  RETRY_POLICY,
  WEBHOOK_EVENTS,
  isWebhookEvent,
  listEndpoints,
  readEvents,
} from "../../../lib/integrations/webhooks";
import { sealSecret, secretBoxStatus, secretHint } from "../../../lib/secret-box";
import { anonymousRefusal, scopedDbWithCapability, type ScopedDatabase } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

const MAX_ENDPOINTS = 10;

function failure(error: unknown, fallback: string) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  const safe = databaseSafeFailure(error, fallback, 503);
  return Response.json({ error: safe.message }, { status: safe.status });
}

async function findEndpoint(scope: ScopedDatabase, id: string) {
  const [row] = await scope.db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, id.slice(0, 80)),
        eq(webhookEndpoints.organisationId, scope.orgId),
        sql`${webhookEndpoints.state} <> 'deleted'`,
      ),
    )
    .limit(1);
  return row ?? null;
}

async function exposeOne(scope: ScopedDatabase, id: string) {
  const [row] = await scope.db
    .select(ENDPOINT_COLUMNS)
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.organisationId, scope.orgId)))
    .limit(1);
  return row ? { ...row, events: readEvents(row.events) } : null;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "integrations.manage");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const storage = await secretBoxStatus();
    return Response.json({
      configured: storage.configured,
      reason: storage.reason,
      endpoints: await listEndpoints(db, orgId),
      events: Object.entries(WEBHOOK_EVENTS).map(([key, label]) => ({ key, label })),
      retryPolicy: RETRY_POLICY,
      signatureHeader: "Maintsupp-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + \".\" + body)>",
    });
  } catch (error) {
    return failure(error, "Webhooks are temporarily unavailable.");
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "integrations.manage");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const storage = await secretBoxStatus();
    if (!storage.configured) {
      return Response.json(
        { error: `Webhooks cannot be added on this deployment: ${storage.reason}`, notConfigured: true },
        { status: 409 },
      );
    }
    if (!scope.authenticated || !scope.session) {
      return Response.json({ error: "Sign in with your own account to add a webhook." }, { status: 401 });
    }
    if (scope.siteScope) {
      return Response.json(
        { error: "Your access is limited to some sites, and a webhook sends events from the whole workspace." },
        { status: 403 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const kind: EndpointKind = body.kind === "slack" ? "slack" : "webhook";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    if (name.length < 2) return Response.json({ error: "Give it a name you will recognise." }, { status: 400 });
    const checked = checkOutboundUrl(body.url, kind);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    const requested = Array.isArray(body.events) ? body.events : [];
    if (!requested.length || !requested.every(isWebhookEvent)) {
      return Response.json({ error: "Choose at least one of the listed events." }, { status: 400 });
    }
    const [existing] = await scope.db
      .select({ value: count() })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.organisationId, scope.orgId), sql`${webhookEndpoints.state} <> 'deleted'`));
    if ((existing?.value ?? 0) >= MAX_ENDPOINTS) {
      return Response.json({ error: `A workspace can have ${MAX_ENDPOINTS} endpoints. Remove one first.` }, { status: 409 });
    }

    const id = `whk_${crypto.randomUUID().replace(/-/g, "")}`;
    const url = checked.url.toString();
    const shown = describeUrl(checked.url);
    const signingSecret = kind === "webhook" ? newSigningSecret() : null;
    const now = new Date().toISOString();
    await scope.db.insert(webhookEndpoints).values({
      id,
      organisationId: scope.orgId,
      kind,
      name,
      urlHost: shown.host,
      urlHint: shown.hint,
      urlSealed: await sealSecret(url, { purpose: "webhook.url", organisationId: scope.orgId, recordId: id }),
      secretSealed: signingSecret
        ? await sealSecret(signingSecret, { purpose: "webhook.secret", organisationId: scope.orgId, recordId: id })
        : null,
      secretHint: signingSecret ? secretHint(signingSecret) : null,
      events: JSON.stringify([...new Set(requested)]),
      state: "on",
      consecutiveFailures: 0,
      createdByUserId: scope.session.user.id,
      createdByEmail: scope.identityEmail,
      createdAt: now,
      updatedAt: now,
    });
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "integration.webhook_created",
      entityType: "webhook_endpoint",
      entityId: id,
      summary: `Added the ${kind === "slack" ? "Slack connection" : "webhook"} "${name}" (${shown.host}).`,
      detail: { kind, host: shown.host, events: requested },
      request,
    });
    return Response.json(
      { endpoint: await exposeOne(scope, id), signingSecret, shownOnce: Boolean(signingSecret) },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return failure(error, "The webhook could not be added.");
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "integrations.manage");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const endpoint = await findEndpoint(scope, typeof body.id === "string" ? body.id : "");
    if (!endpoint) return Response.json({ error: "No such webhook in this workspace." }, { status: 404 });
    const now = new Date().toISOString();
    const where = and(eq(webhookEndpoints.id, endpoint.id), eq(webhookEndpoints.organisationId, scope.orgId));
    let signingSecret: string | null = null;

    if (body.action === "pause") {
      await scope.db.update(webhookEndpoints).set({ state: "paused", stateReason: "Paused by hand.", updatedAt: now }).where(where);
    } else if (body.action === "resume") {
      await scope.db
        .update(webhookEndpoints)
        .set({ state: "on", stateReason: null, consecutiveFailures: 0, updatedAt: now })
        .where(where);
    } else if (body.action === "roll_secret") {
      if (endpoint.kind !== "webhook") return Response.json({ error: "A Slack connection has no signing secret." }, { status: 400 });
      const storage = await secretBoxStatus();
      if (!storage.configured) {
        return Response.json({ error: `The secret cannot be replaced here: ${storage.reason}`, notConfigured: true }, { status: 409 });
      }
      signingSecret = newSigningSecret();
      await scope.db
        .update(webhookEndpoints)
        .set({
          secretSealed: await sealSecret(signingSecret, { purpose: "webhook.secret", organisationId: scope.orgId, recordId: endpoint.id }),
          secretHint: secretHint(signingSecret),
          updatedAt: now,
        })
        .where(where);
    } else {
      return Response.json({ error: "Say pause, resume or roll_secret." }, { status: 400 });
    }
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: `integration.webhook_${String(body.action)}`,
      entityType: "webhook_endpoint",
      entityId: endpoint.id,
      summary: `${body.action === "roll_secret" ? "Replaced the signing secret of" : body.action === "pause" ? "Paused" : "Resumed"} "${endpoint.name}".`,
      detail: { host: endpoint.urlHost },
      request,
    });
    return Response.json(
      { endpoint: await exposeOne(scope, endpoint.id), signingSecret, shownOnce: Boolean(signingSecret) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return failure(error, "The webhook could not be changed.");
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "integrations.manage");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const endpoint = await findEndpoint(scope, new URL(request.url).searchParams.get("id") ?? "");
    if (!endpoint) return Response.json({ error: "No such webhook in this workspace." }, { status: 404 });
    /* Kept as a row so the delivery log and the audit trail still resolve;
       the credential itself is wiped, not merely hidden. */
    await scope.db
      .update(webhookEndpoints)
      .set({ state: "deleted", stateReason: "Removed.", urlSealed: "", secretSealed: null, updatedAt: new Date().toISOString() })
      .where(and(eq(webhookEndpoints.id, endpoint.id), eq(webhookEndpoints.organisationId, scope.orgId)));
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "integration.webhook_deleted",
      entityType: "webhook_endpoint",
      entityId: endpoint.id,
      summary: `Removed "${endpoint.name}" (${endpoint.urlHost}).`,
      detail: { host: endpoint.urlHost, kind: endpoint.kind },
      request,
    });
    return Response.json({ deleted: true });
  } catch (error) {
    return failure(error, "The webhook could not be removed.");
  }
}
