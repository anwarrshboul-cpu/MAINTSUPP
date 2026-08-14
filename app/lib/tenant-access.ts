/**
 * Who is asking, and which organisations they are allowed to read.
 *
 * Stage 19. Until now `scopedDb` read a `maintsupp_demo_organisation` cookie and
 * handed back whatever organisation it named, for anybody. That is a tenant leak
 * by construction: a client of one organisation only had to rewrite one cookie
 * to read another organisation's board. Every board query was already scoped —
 * they were just all scoped to an organisation the caller chose for themselves.
 *
 * The fix is to make the database, not the cookie, decide. An actor resolves to
 * an *identity* (an email), that identity resolves to its `memberships` rows,
 * and those rows are the complete set of organisations the actor may read. The
 * organisation cookie is demoted to a *request*: honoured when it names an
 * organisation the actor is a member of, silently ignored when it does not.
 *
 * Role follows the same rule. It comes from the membership row rather than from
 * the role cookie, so "super admin" is something the database says about you and
 * not something the browser claims. The cookie role survives only as the
 * fallback for an identity with no membership at all, which is what keeps a
 * freshly provisioned database usable before anybody has been invited.
 *
 * Stage 20 closed that link. `resolveIdentityCandidates` now asks
 * `getSession` first, and a valid session's email outranks every cookie and
 * header below it — exactly the swap the paragraph that used to sit here
 * predicted, and not one rule underneath it had to change. The testing
 * identity survives *only* as a fallback for a browser with no session, which
 * is what keeps the demo workable; it can no longer be used to reach past a
 * real sign-in, because a real sign-in always answers first.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { memberships, organisations, users } from "../../db/schema";
import { getSession, type AuthenticatedSession } from "./auth-session";
import {
  getWorkspaceActor,
  workspaceCookieValue,
  type WorkspaceActor,
  type WorkspaceRole,
} from "./workspace-actor";

/** Sunnamusk UK — the organisation that owns every imported operational row. */
export const PRIMARY_ORGANISATION_ID = "org_000000000000000000000001";

/**
 * Demo Client Ltd — the empty second tenant.
 *
 * A structural fixture, not a customer: board, columns, groups and option
 * values, and zero rows of operational data. It exists so "each client sees a
 * different view" can be demonstrated rather than asserted, and so the isolation
 * tests have a second side to check against.
 */
export const DEMO_ORGANISATION_ID = "org_000000000000000000000002";

export const ORGANISATION_COOKIE = "maintsupp_demo_organisation";
export const IDENTITY_COOKIE = "maintsupp_demo_identity";

/**
 * Non-production override for the acting identity.
 *
 * Cookies are awkward to drive from a test runner or a `curl` proof, so the same
 * value may arrive as a header. Refused outside development for the obvious
 * reason: in production the identity must come from the session.
 */
export const IDENTITY_HEADER = "x-maintsupp-identity";

/**
 * Whether the public-testing identity is allowed to stand in for a session.
 *
 * The demo affordance is deliberate and documented in `workspace-actor.ts`: with
 * no session, the role cookie decides the actor, and an absent cookie means
 * `super_admin`. That keeps a freshly provisioned database usable before anybody
 * has been invited, and it is exactly right for a public preview.
 *
 * It is also a complete authentication bypass, because `db/init.ts` seeds
 * `super-admin@test.maintsupp.com` as a super admin of *every* organisation. An
 * anonymous request therefore resolves to a real membership in every tenant and
 * `permissions.ts` waves through every capability check. Verified against a
 * running server: `curl /api/maintenance` with no cookies returned 775 rows.
 *
 * So the affordance survives, and is confined to non-production. In production
 * the identity must come from the session or there is no identity at all.
 */
export function demoIdentityAllowed() {
  return process.env.NODE_ENV !== "production";
}

/**
 * Whether an empty workspace may be back-filled with the bundled sample data.
 *
 * `seedMaintenanceIfEmpty`, `seedBoardRequestsIfEmpty` and the workspace seeder
 * all guard on `orgId === PRIMARY_ORGANISATION_ID` — and the primary
 * organisation is the *live client's*, not a demo one. So the guard reads
 * "invent data for production, never for the demo tenant", which is backwards.
 *
 * It is right for a public preview, where an empty board would look broken, and
 * wrong the moment real work is in the table: any event that empties it — a
 * restore, a failed migration, a bulk delete — repopulates the client's board
 * with `mock-data.ts` rows that are indistinguishable from their own jobs.
 *
 * A production workspace stays empty until somebody imports something.
 */
export function sampleSeedingAllowed() {
  return process.env.NODE_ENV !== "production";
}

const ROLE_RANK: Record<WorkspaceRole, number> = {
  client: 0,
  admin: 1,
  super_admin: 2,
};

/** The seeded demo identity that backs each sidebar test role. */
export function roleIdentityEmail(role: WorkspaceRole) {
  return `${role.replaceAll("_", "-")}@test.maintsupp.com`;
}

/** The seeded per-organisation demo identity for a role, from the org slug. */
export function organisationIdentityEmail(slug: string, role: WorkspaceRole) {
  return `${role.replaceAll("_", "-")}@${slug}.test.maintsupp.com`;
}

function normaliseRole(value: string | null | undefined): WorkspaceRole | null {
  if (value === "super_admin" || value === "admin" || value === "client") {
    return value;
  }
  return null;
}

function parseSiteScope(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.filter((item): item is string => typeof item === "string");
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

export type MembershipGrant = {
  organisationId: string;
  role: WorkspaceRole;
  siteScope: string[] | null;
};

export type TenantAccess = {
  /** The actor, with `role` replaced by the role the database grants. */
  actor: WorkspaceActor;
  /** The email the membership lookup was answered against. */
  identityEmail: string;
  /** The organisation this request reads and writes. */
  organisation: typeof organisations.$inferSelect;
  orgId: string;
  /** Every organisation the actor may read. One entry unless super admin. */
  organisationIds: string[];
  /** Every active organisation, resolved once so callers need not re-query. */
  activeOrganisations: Array<typeof organisations.$inferSelect>;
  /** True only for a super admin: the actor may read across organisations. */
  crossOrganisation: boolean;
  /** Site restriction carried by the membership for `orgId`, if any. */
  siteScope: string[] | null;
  /**
   * True when no membership matched and the cookie role was used instead. The
   * actor is confined to the primary organisation in that case.
   */
  unaffiliated: boolean;
  /**
   * True when the caller proved nothing and belongs to nothing, outside
   * development. `scopedDb` turns this into a refusal; nothing downstream
   * should ever see it as a normal state.
   */
  anonymous: boolean;
  /**
   * Stage 20 — true when this request carried a valid session cookie.
   *
   * The difference between "a person proved who they are" and "a browser is
   * demoing the dashboard". Anything that must not be done on a testing
   * identity should check this rather than inferring it from the role.
   */
  authenticated: boolean;
  /** The session behind `authenticated`, for callers that need the user row. */
  session: AuthenticatedSession | null;
};

type Database = Awaited<ReturnType<typeof getDb>>;

/**
 * The stand-in `getChatGPTUser` returns in development when the dispatcher
 * passes no identity headers. Not a real account, so it must not outrank the
 * testing identity the sidebar selects.
 */
const DEVELOPMENT_PREVIEW_EMAIL = "preview@maintsupp.local";

/**
 * The emails this request may be answered as, best first.
 *
 * Stage 20. `session` is the account proved by an HttpOnly session cookie the
 * server issued and the browser cannot forge or read. It is unconditionally
 * first, and that ordering IS the security property: everything after it is a
 * value the client chose for itself, so once a real session exists no cookie,
 * header or role selector can reach past it. There is no branch below where a
 * testing identity outranks a session — deliberately, because a rule with an
 * exception is a rule somebody will eventually find the exception to.
 *
 * The remaining entries only matter for a browser with *no* session, which is
 * how the dashboard is still demoed: the testing identity (header, then
 * cookie), the dispatcher's own user, and finally the demo account for the
 * cookie role.
 *
 * The list is only a set of *candidates*. Whichever one holds an active
 * membership is the one that decides anything, so naming an identity grants
 * exactly the access that identity already had and nothing more.
 */
function resolveIdentityCandidates(
  request: Request,
  actor: WorkspaceActor,
  session: AuthenticatedSession | null,
) {
  const demo = demoIdentityAllowed();
  const header = demo ? request.headers.get(IDENTITY_HEADER) : null;
  const cookie = demo ? workspaceCookieValue(request, IDENTITY_COOKIE) : null;
  const authenticated =
    actor.email && actor.email !== DEVELOPMENT_PREVIEW_EMAIL
      ? actor.email
      : null;
  /*
   * In production the session is the only candidate that survives.
   *
   * `authenticated`, `actor.email` and `roleIdentityEmail(actor.role)` all
   * derive from `getWorkspaceActor`, which never fails and falls back to
   * `<role>@test.maintsupp.com` — a seeded super admin of *every* organisation.
   * Keeping any of them is what let an anonymous caller resolve to a real
   * membership in every tenant. Outside the preview they are dropped, leaving
   * an unauthenticated request with no candidates and therefore no grants.
   *
   * The session stays first in every environment: a signed-in account must
   * never inherit a testing identity's access.
   */
  const candidates = [
    session?.user.email ?? null,
    demo ? authenticated : null,
    header,
    cookie,
    demo ? actor.email : null,
    demo ? roleIdentityEmail(actor.role) : null,
  ];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const candidate of candidates) {
    const email = candidate?.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    ordered.push(email);
  }
  return ordered;
}

/** Active memberships held by any of `emails`, keyed back to the email. */
async function loadGrants(db: Database, emails: string[]) {
  if (!emails.length) return new Map<string, MembershipGrant[]>();
  const rows = await db
    .select({
      email: sql<string>`lower(${users.email})`,
      organisationId: memberships.organisationId,
      role: memberships.role,
      siteScope: memberships.siteScope,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.status, "active"),
        eq(users.active, true),
        sql`lower(${users.email}) in (${sql.join(
          emails.map((email) => sql`${email}`),
          sql`, `,
        )})`,
      ),
    );

  const grants = new Map<string, MembershipGrant[]>();
  for (const row of rows) {
    const role = normaliseRole(row.role);
    if (!role) continue;
    const list = grants.get(row.email) ?? [];
    list.push({
      organisationId: row.organisationId,
      role,
      siteScope: parseSiteScope(row.siteScope),
    });
    grants.set(row.email, list);
  }
  return grants;
}

/**
 * Resolves the actor, their role and the organisations they may read.
 *
 * The single place tenancy is decided. `scopedDb` is a thin wrapper over this,
 * and every data route goes through `scopedDb`, so a change here reaches all of
 * them at once — which is the point: a rule that has to be restated per route is
 * a rule that will eventually be missed in one.
 */
export async function resolveTenantAccess(
  db: Database,
  request: Request,
): Promise<TenantAccess> {
  const actor = await getWorkspaceActor(request);

  const activeOrganisations = await db
    .select()
    .from(organisations)
    .where(eq(organisations.status, "active"))
    .orderBy(asc(organisations.createdAt));

  if (!activeOrganisations.length) {
    throw new Error("No active organisation is configured for this workspace.");
  }

  /*
   * Stage 20 — the signed-in account, if there is one.
   *
   * `getSession` never throws: an unreadable cookie, a revoked session or a
   * database that will not answer all resolve to null, which lands here as
   * "not signed in" and falls through to the testing behaviour below. Failing
   * closed in this direction is the whole point — the alternative is an error
   * path that leaves somebody holding whatever access the previous request had.
   */
  const session = await getSession(request);

  const candidates = resolveIdentityCandidates(request, actor, session);
  const grantsByEmail = await loadGrants(db, candidates);

  /*
   * With a session, the identity is the session's account. Full stop.
   *
   * The `find` below would otherwise walk past a signed-in user who happens to
   * hold no memberships and settle on a *testing* identity that does — handing
   * a real account somebody else's access because it was the first candidate
   * with a membership row. Signing in must never be able to give you more than
   * signing in gives you, so the search is skipped entirely when a session
   * decided the question.
   */
  const identityEmail = session
    ? session.user.email.trim().toLowerCase()
    : (candidates.find((email) => grantsByEmail.get(email)?.length) ??
      candidates[0] ??
      actor.email);
  const grants = grantsByEmail.get(identityEmail) ?? [];

  /*
   * The strongest role held anywhere, so a super admin of one organisation is a
   * super admin everywhere.
   *
   * The no-membership fallback is where the two worlds part. Without a session
   * the cookie role stands in, which is what keeps a freshly provisioned
   * database usable before anybody has been invited. WITH a session it must
   * not: `workspaceRoleFromRequest` defaults to `super_admin` when the role
   * cookie is absent, so honouring it here would promote every signed-in
   * account that had not yet been given a membership straight to super admin.
   * A real account with no grants gets the least privilege there is.
   */
  const role: WorkspaceRole = grants.length
    ? grants.reduce<WorkspaceRole>(
        (best, grant) => (ROLE_RANK[grant.role] > ROLE_RANK[best] ? grant.role : best),
        "client",
      )
    : session
      ? "client"
      : actor.role;

  const activeIds = new Set(activeOrganisations.map((item) => item.id));
  const primary =
    activeOrganisations.find((item) => item.id === PRIMARY_ORGANISATION_ID) ??
    activeOrganisations[0];

  // A super admin reads every organisation. Everyone else reads exactly the ones
  // their memberships name — never the one the cookie asked for.
  let organisationIds: string[];
  let unaffiliated = false;
  /** No session, no membership, not a development environment. Refuse. */
  let anonymous = false;
  if (role === "super_admin") {
    organisationIds = activeOrganisations.map((item) => item.id);
  } else {
    organisationIds = grants
      .map((grant) => grant.organisationId)
      .filter((id) => activeIds.has(id));
    if (!organisationIds.length) {
      /*
       * No membership anywhere.
       *
       * This used to confine the caller to the PRIMARY organisation rather than
       * fail — so that a database seeded before invitations existed still
       * rendered. In development that is a convenience. In production it was
       * the whole security model failing open: an anonymous request has no
       * session, so `resolveIdentityCandidates` drops every candidate, so there
       * are no grants, so it landed here and was handed the live client's
       * tenant as a `client`. A stranger with curl could read every job, every
       * site's access notes and out-of-hours contacts, every team member's
       * email, and the file bytes.
       *
       * The fallback is kept ONLY where it was actually meant to help: a
       * request that has proved who it is (a real account not yet given a
       * membership), or a development environment where the demo identities
       * are allowed. Anything else resolves to no organisation at all, and
       * `scopedDb` refuses.
       */
      if (session || demoIdentityAllowed()) {
        organisationIds = [primary.id];
        unaffiliated = true;
      } else {
        organisationIds = [];
        unaffiliated = true;
        anonymous = true;
      }
    }
  }

  /*
   * Which organisation to stand in.
   *
   * The cookie is asked first because it is what the sidebar switcher writes,
   * and the session's own `organisation_id` is the fallback so a fresh sign-in
   * lands where the account belongs rather than always in the primary tenant.
   * Both are *requests*, not grants: whichever wins is still filtered through
   * `allowed` on the next line, so neither can select a tenant the memberships
   * above did not already permit.
   */
  const requestedId =
    workspaceCookieValue(request, ORGANISATION_COOKIE) ??
    session?.organisationId ??
    null;
  const allowed = new Set(organisationIds);
  const selectedId =
    requestedId && allowed.has(requestedId)
      ? requestedId
      : allowed.has(primary.id)
        ? primary.id
        : organisationIds[0];
  const organisation =
    activeOrganisations.find((item) => item.id === selectedId) ?? primary;

  const siteScope =
    grants.find((grant) => grant.organisationId === organisation.id)?.siteScope ??
    null;

  return {
    /*
     * Stage 20 — a signed-in request reports the account that signed in.
     *
     * Before this, `actor.email` and `actor.displayName` came from the ChatGPT
     * dispatcher headers or from the demo role's label, so the topbar could
     * cheerfully greet a real signed-in user as "Super Admin". `role` is still
     * the one the database granted, never the one anybody claimed.
     */
    actor: session
      ? {
          ...actor,
          email: session.user.email,
          displayName: session.user.displayName,
          role,
        }
      : { ...actor, role },
    identityEmail,
    organisation,
    orgId: organisation.id,
    organisationIds,
    activeOrganisations,
    crossOrganisation: role === "super_admin",
    siteScope,
    unaffiliated,
    anonymous,
    authenticated: !!session,
    session,
  };
}

/** True when `organisationId` is one this access grant may read. */
export function canReadOrganisation(
  access: Pick<TenantAccess, "organisationIds">,
  organisationId: string,
) {
  return access.organisationIds.includes(organisationId);
}
