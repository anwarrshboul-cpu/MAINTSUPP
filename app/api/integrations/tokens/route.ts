/**
 * `/api/integrations/tokens` — issue, list and revoke this workspace's API
 * tokens (§35). Every method needs `integrations.manage`.
 *
 * GET     the workspace's tokens: name, prefix, scopes, creator, expiry, last
 *         use, revoked or not. NEVER the hash, never the token.
 * POST    `{ name, scopes, days }` → the token, ONCE. Only a signed-in person
 *         may issue one (a demonstration identity is not an account that can
 *         be held responsible for a credential), and only for scopes they
 *         themselves hold.
 * DELETE  `?id=` → revoked (stamped, not deleted, so the trail survives).
 *
 * The audit trail records who issued or revoked which token, by id and prefix —
 * nothing a caller could authenticate with.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { apiTokens } from "../../../../db/schema";
import { auditActor, recordAudit } from "../../../lib/audit";
import { hashToken } from "../../../lib/auth-session";
import { databaseSafeFailure } from "../../../lib/database-failure";
import {
  API_SCOPES,
  API_SCOPE_KEYS,
  MAX_LIVE_TOKENS,
  TOKEN_LIFETIMES,
  mintToken,
  readScopes,
  validateTokenRequest,
} from "../../../lib/integrations/api-tokens";
import { resolvePermissions } from "../../../lib/permissions";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

function failure(error: unknown, fallback: string) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  const safe = databaseSafeFailure(error, fallback, 503);
  return Response.json({ error: safe.message }, { status: safe.status });
}

function expose(row: typeof apiTokens.$inferSelect) {
  const expired = !(Date.parse(row.expiresAt) > Date.now());
  return {
    id: row.id,
    name: row.name,
    prefix: row.tokenPrefix,
    scopes: readScopes(row.scopes),
    createdByEmail: row.createdByEmail,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    state: row.revokedAt ? "revoked" : expired ? "expired" : "live",
  };
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "integrations.manage");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const rows = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.organisationId, orgId))
      .orderBy(desc(apiTokens.createdAt));
    return Response.json({
      tokens: rows.map(expose),
      scopes: API_SCOPE_KEYS.map((key) => ({ key, label: API_SCOPES[key].label })),
      lifetimes: TOKEN_LIFETIMES,
      endpoints: ["/api/v1/jobs", "/api/v1/sites"],
    });
  } catch (error) {
    return failure(error, "API tokens are temporarily unavailable.");
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "integrations.manage");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    if (!scope.authenticated || !scope.session) {
      return Response.json({ error: "Sign in with your own account to issue an API token." }, { status: 401 });
    }
    const subject = await resolvePermissions(scope.db, scope.orgId, scope.actor.role, scope.siteScope);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const checked = validateTokenRequest(body, subject);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });

    const live = (
      await scope.db
        .select({ expiresAt: apiTokens.expiresAt })
        .from(apiTokens)
        .where(and(eq(apiTokens.organisationId, scope.orgId), isNull(apiTokens.revokedAt)))
    ).filter((row) => Date.parse(row.expiresAt) > Date.now());
    if (live.length >= MAX_LIVE_TOKENS) {
      return Response.json(
        { error: `This workspace already has ${MAX_LIVE_TOKENS} live tokens. Revoke one you no longer use first.` },
        { status: 409 },
      );
    }

    const { token, prefix } = mintToken();
    const id = `atk_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + checked.days * 86_400_000).toISOString();
    await scope.db.insert(apiTokens).values({
      id,
      organisationId: scope.orgId,
      name: checked.name,
      tokenPrefix: prefix,
      tokenHash: await hashToken(token),
      scopes: JSON.stringify(checked.scopes),
      createdByUserId: scope.session.user.id,
      createdByEmail: scope.identityEmail,
      expiresAt,
      createdAt: now.toISOString(),
    });
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "integration.token_created",
      entityType: "api_token",
      entityId: id,
      summary: `Issued the API token "${checked.name}".`,
      detail: { prefix, scopes: checked.scopes, expiresAt },
      request,
    });
    const [row] = await scope.db.select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1);
    return Response.json(
      {
        /* The only time the token exists outside the caller's own hands. */
        token,
        shownOnce: true,
        record: row ? expose(row) : null,
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return failure(error, "The API token could not be issued.");
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "integrations.manage");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const id = (new URL(request.url).searchParams.get("id") ?? "").slice(0, 80);
    const [row] = await scope.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.id, id), eq(apiTokens.organisationId, scope.orgId)))
      .limit(1);
    if (!row) return Response.json({ error: "No such token in this workspace." }, { status: 404 });
    if (row.revokedAt) return Response.json({ token: expose(row) });
    const revokedAt = new Date().toISOString();
    await scope.db
      .update(apiTokens)
      .set({ revokedAt, revokedByEmail: scope.identityEmail })
      .where(and(eq(apiTokens.id, id), eq(apiTokens.organisationId, scope.orgId)));
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "integration.token_revoked",
      entityType: "api_token",
      entityId: id,
      summary: `Revoked the API token "${row.name}".`,
      detail: { prefix: row.tokenPrefix },
      request,
    });
    return Response.json({ token: expose({ ...row, revokedAt, revokedByEmail: scope.identityEmail }) });
  } catch (error) {
    return failure(error, "The API token could not be revoked.");
  }
}
