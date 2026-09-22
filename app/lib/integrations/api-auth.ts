/**
 * §35 — WHO A REQUEST CARRYING AN API TOKEN IS, AND WHAT IT MAY READ.
 *
 * The counterpart of `scopedDbWithCapability` for a machine. It returns the
 * same `{ denied } | { … }` shape, so a `/api/v1` route reads like every other
 * route, and it gives the same guarantees:
 *
 *   · ONLY the `Authorization: Bearer` header is read. Never a cookie, never
 *     the demonstration identity headers `resolveTenantAccess` honours in
 *     development — a browser session cannot reach `/api/v1`, and a token
 *     cannot reach a cookie route.
 *   · The workspace is the one the token was issued in, fixed on its row. The
 *     request cannot name another.
 *   · The creator's access is resolved AGAIN, now: platform admin, owner of the
 *     company, or an active membership — with that membership's site
 *     restriction. A deactivated creator, a removed membership, or a workspace
 *     of MAINTSUPP's internal company answers 403.
 *   · The token's scopes are intersected with the creator's current
 *     permissions (`effectiveTokenScopes`).
 *   · Failed attempts are throttled per address; valid use is rate-limited per
 *     token. Both reuse the sign-in throttle table.
 *
 * Nothing about the token — not even its prefix — is written to a log.
 */

import { and, eq, isNull } from "drizzle-orm";
import { getD1, getDb } from "../../../db";
import { apiTokens, organisations } from "../../../db/schema";
import {
  hashToken,
  publicRetryAfter,
  recordPublicAttempt,
  requestIp,
  tooManyAttempts,
  type PublicThrottle,
} from "../auth-session";
import { loadCompanyAuthority, loadInternalCompanyIds } from "../company-authority";
import { resolvePermissions } from "../permissions";
import type { WorkspaceRole } from "../roles";
import { loadGrants } from "../tenant-grants";
import { API_SCOPES, bearerToken, effectiveTokenScopes, parseToken, readScopes, type ApiScope } from "./api-tokens";

type Database = Awaited<ReturnType<typeof getDb>>;

/** 120 requests a minute per token, then a minute's wait. */
export const API_TOKEN_RATE: PublicThrottle = { name: "api-token", windowMs: 60_000, max: 120, lockoutMs: 60_000 };
/** 20 bad tokens per address in 15 minutes, then a 15-minute wait. */
export const API_AUTH_FAILURES: PublicThrottle = {
  name: "api-auth-failure",
  windowMs: 15 * 60_000,
  max: 20,
  lockoutMs: 15 * 60_000,
};

export type ApiRequestScope = {
  db: Database;
  orgId: string;
  /** The creator's site restriction in this workspace; null means every site. */
  siteScope: string[] | null;
  role: WorkspaceRole;
  tokenId: string;
};

const NO_STORE = { "cache-control": "no-store", vary: "Authorization" };

function unauthorised(message: string) {
  return Response.json(
    { error: message },
    { status: 401, headers: { ...NO_STORE, "www-authenticate": 'Bearer realm="maintsupp"' } },
  );
}

/**
 * The creator's role and site restriction in one workspace, resolved from the
 * rows as they are now — the same three sources `resolveTenantAccess` uses.
 */
export async function creatorAccess(
  db: Database,
  email: string,
  organisationId: string,
): Promise<{ role: WorkspaceRole; siteScope: string[] | null } | null> {
  const identity = email.trim().toLowerCase();
  const [organisation] = await db
    .select({ id: organisations.id, status: organisations.status, clientCompanyId: organisations.clientCompanyId })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .limit(1);
  if (!organisation || organisation.status !== "active") return null;

  const [grantsByEmail, authorityByEmail, internalCompanies] = await Promise.all([
    loadGrants(db, [identity]),
    loadCompanyAuthority(db, [identity]),
    loadInternalCompanyIds(db),
  ]);
  const authority = authorityByEmail.get(identity);
  if (authority?.platformAdmin) return { role: "super_admin", siteScope: null };
  const company = organisation.clientCompanyId ?? null;
  if (company && internalCompanies.has(company)) return null;
  if (company && authority?.ownedCompanyIds.includes(company)) return { role: "owner", siteScope: null };
  const grant = grantsByEmail.get(identity)?.find((item) => item.organisationId === organisationId);
  return grant ? { role: grant.role, siteScope: grant.siteScope } : null;
}

export async function scopedDbWithApiToken(
  request: Request,
  scope: ApiScope,
): Promise<{ denied: Response; api?: never } | { denied?: never; api: ApiRequestScope }> {
  const d1 = await getD1();
  const address = requestIp(request);
  const failureWait = await publicRetryAfter(d1, API_AUTH_FAILURES, address);
  if (failureWait > 0) return { denied: tooManyAttempts(failureWait) };

  const refuse = async (message: string) => {
    await recordPublicAttempt(d1, API_AUTH_FAILURES, address);
    return { denied: unauthorised(message) };
  };

  const presented = bearerToken(request.headers.get("authorization"));
  if (!presented || !parseToken(presented)) {
    return refuse("Send a MAINTSUPP API token as `Authorization: Bearer <token>`.");
  }

  const db = await getDb();
  const [row] = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, await hashToken(presented)), isNull(apiTokens.revokedAt)))
    .limit(1);
  if (!row) return refuse("This API token is not valid. It may have been revoked.");
  if (!(Date.parse(row.expiresAt) > Date.now())) return refuse("This API token has expired.");

  const rateWait = await publicRetryAfter(d1, API_TOKEN_RATE, row.id);
  if (rateWait > 0) return { denied: tooManyAttempts(rateWait) };
  await recordPublicAttempt(d1, API_TOKEN_RATE, row.id);

  const access = await creatorAccess(db, row.createdByEmail, row.organisationId);
  if (!access) {
    return {
      denied: Response.json(
        { error: "The person who issued this token no longer has access to this workspace.", denied: true },
        { status: 403, headers: NO_STORE },
      ),
    };
  }
  const subject = await resolvePermissions(db, row.organisationId, access.role);
  if (!effectiveTokenScopes(readScopes(row.scopes), subject).includes(scope)) {
    return {
      denied: Response.json(
        {
          error: `This token may not ${API_SCOPES[scope].label.toLowerCase()} — it was not issued for it, or its creator no longer may.`,
          scope,
          denied: true,
        },
        { status: 403, headers: NO_STORE },
      ),
    };
  }

  /* At most once a minute, so a busy integration is not a write per request. */
  if (!row.lastUsedAt || Date.now() - Date.parse(row.lastUsedAt) > 60_000) {
    await db
      .update(apiTokens)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(and(eq(apiTokens.id, row.id), eq(apiTokens.organisationId, row.organisationId)))
      .catch(() => {});
  }

  return { api: { db, orgId: row.organisationId, siteScope: access.siteScope, role: access.role, tokenId: row.id } };
}

/** The headers every `/api/v1` answer carries: never cached, varies by token. */
export function apiJson(body: unknown, init: { status?: number } = {}) {
  return Response.json(body, { status: init.status ?? 200, headers: NO_STORE });
}
