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

import { asc, eq } from "drizzle-orm";
import type { getDb } from "../../db";
import { organisations } from "../../db/schema";
import { getSession, type AuthenticatedSession } from "./auth-session";
import { loadCompanyAuthority, loadInternalCompanyIds } from "./company-authority";
import { loadGrants, type MembershipGrant } from "./tenant-grants";
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

/*
 * `ROLE_RANK` and `normaliseRole` used to be private copies here. Both come from
 * `roles.ts` now, which is the one list of roles a membership may hold — a
 * membership naming anything else is still discarded by `loadGrants`, exactly
 * as before.
 */

/** The seeded demo identity that backs each sidebar test role. */
export function roleIdentityEmail(role: WorkspaceRole) {
  return `${role.replaceAll("_", "-")}@test.maintsupp.com`;
}

/** The seeded per-organisation demo identity for a role, from the org slug. */
export function organisationIdentityEmail(slug: string, role: WorkspaceRole) {
  return `${role.replaceAll("_", "-")}@${slug}.test.maintsupp.com`;
}

/* The membership reader and its types live in `tenant-grants.ts`. */
export type { MembershipGrant } from "./tenant-grants";

export type TenantAccess = {
  /**
   * The actor, with `role` replaced by the role this person acts with IN THE
   * SELECTED WORKSPACE (`orgId`): `super_admin` for a Platform Super Admin,
   * `owner` for an Owner of the workspace's company, otherwise the membership's
   * role. See the note where `role` is computed.
   */
  actor: WorkspaceActor;
  /**
   * Every active workspace membership the identity holds, one per workspace.
   * Company ownership and platform authority are NOT here — see
   * `ownedCompanyIds` and `platformAdmin`.
   */
  grants: MembershipGrant[];
  /** The email the access lookup was answered against. */
  identityEmail: string;
  /** The workspace this request reads and writes. */
  organisation: typeof organisations.$inferSelect;
  orgId: string;
  /** The client company `orgId` belongs to, if it has one. */
  clientCompanyId: string | null;
  /**
   * Every workspace the actor may read, oldest first: all of them for a
   * Platform Super Admin; otherwise the workspaces of the companies they own
   * plus the ones their memberships name.
   */
  organisationIds: string[];
  /** Every active workspace, resolved once so callers need not re-query. */
  activeOrganisations: Array<typeof organisations.$inferSelect>;
  /** True only for a Platform Super Admin. Kept under its original name. */
  crossOrganisation: boolean;
  /** True only for a Platform Super Admin (`platform_admins`). */
  platformAdmin: boolean;
  /** Active client companies this person owns. */
  ownedCompanyIds: string[];
  /** Internal (demonstration) companies, which only the platform reaches. */
  internalCompanyIds: string[];
  /** Site restriction carried by the membership for `orgId`, if any. */
  siteScope: string[] | null;
  /**
   * True when a development request with no session matched no access at all
   * and the role cookie was used instead. Confined to the primary workspace.
   * Never true for a signed-in request.
   */
  unaffiliated: boolean;
  /**
   * True when the caller proved nothing and belongs to nothing, outside
   * development. `scopedDb` turns this into a refusal; nothing downstream
   * should ever see it as a normal state.
   */
  anonymous: boolean;
  /**
   * True when a SIGNED-IN person has no workspace access at all — no platform
   * authority, no company, no membership. `scopedDb` refuses. This used to put
   * them in the primary workspace as a Client, which is another customer's
   * data now that there is more than one customer.
   */
  noAccess: boolean;
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
 * The list is only a set of *candidates*. Whichever one holds access is the one
 * that decides anything, so naming an identity grants exactly the access that
 * identity already had and nothing more.
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
   * `<role>@test.maintsupp.com` — a seeded Platform Super Admin. Keeping any of
   * them is what let an anonymous caller resolve to real access in every
   * tenant. Outside the preview they are dropped, leaving an unauthenticated
   * request with no candidates and therefore no access.
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

/**
 * Resolves the actor, their role and the workspaces they may read.
 *
 * The single place tenancy is decided. `scopedDb` is a thin wrapper over this,
 * and every data route goes through `scopedDb`, so a change here reaches all of
 * them at once — which is the point: a rule that has to be restated per route is
 * a rule that will eventually be missed in one.
 *
 * THREE SOURCES OF ACCESS, and nothing else:
 *
 *   1. Platform Super Admin (`platform_admins`)  → every active workspace.
 *   2. Owner of a client company                  → every active workspace of
 *      that company, including ones created after they became Owner.
 *   3. Workspace membership (admin/manager/client) → exactly that workspace.
 *
 * Access never flows downwards: an Admin, Manager or Client of one company
 * workspace gains nothing in that company's other workspaces, and a new
 * workspace is visible only to the Platform Super Admins and that company's
 * Owners until somebody is explicitly given a membership.
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
    .orderBy(asc(organisations.createdAt), asc(organisations.id));

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
  const [grantsByEmail, authorityByEmail, internalCompanies] = await Promise.all([
    loadGrants(db, candidates),
    loadCompanyAuthority(db, candidates),
    loadInternalCompanyIds(db),
  ]);
  /*
   * An INTERNAL company's workspaces (MAINTSUPP's demonstration company) are
   * the platform's alone. A membership row there grants a customer account
   * nothing, so it is dropped before anything below counts it.
   */
  const internalOrganisationIds = new Set(
    activeOrganisations
      .filter((item) => item.clientCompanyId && internalCompanies.has(item.clientCompanyId))
      .map((item) => item.id),
  );
  for (const [email, list] of grantsByEmail) {
    grantsByEmail.set(
      email,
      list.filter((grant) => !internalOrganisationIds.has(grant.organisationId)),
    );
  }
  const holdsAccess = (email: string) => {
    const authority = authorityByEmail.get(email);
    return Boolean(
      grantsByEmail.get(email)?.length ||
        authority?.platformAdmin ||
        authority?.ownedCompanyIds.length,
    );
  };

  /*
   * With a session, the identity is the session's account. Full stop.
   *
   * The `find` below would otherwise walk past a signed-in user who happens to
   * hold no access and settle on a *testing* identity that does — handing a
   * real account somebody else's access because it was the first candidate
   * with a row. Signing in must never be able to give you more than signing in
   * gives you, so the search is skipped entirely when a session decided.
   */
  const identityEmail = session
    ? session.user.email.trim().toLowerCase()
    : (candidates.find(holdsAccess) ?? candidates[0] ?? actor.email);

  const activeIds = new Set(activeOrganisations.map((item) => item.id));
  const grants = (grantsByEmail.get(identityEmail) ?? []).filter((grant) =>
    activeIds.has(grant.organisationId),
  );
  const authority = authorityByEmail.get(identityEmail);
  const platformAdmin = authority?.platformAdmin ?? false;
  const ownedCompanyIds = authority?.ownedCompanyIds ?? [];
  const owned = new Set(ownedCompanyIds);
  const ownsWorkspace = (organisation: (typeof activeOrganisations)[number]) =>
    Boolean(organisation.clientCompanyId && owned.has(organisation.clientCompanyId));

  const primary =
    activeOrganisations.find((item) => item.id === PRIMARY_ORGANISATION_ID) ??
    activeOrganisations[0];

  let organisationIds: string[];
  let unaffiliated = false;
  /** No session, no access, not a development environment. Refuse. */
  let anonymous = false;
  /** A signed-in person with no access anywhere. Refuse. */
  let noAccess = false;
  if (platformAdmin) {
    organisationIds = activeOrganisations.map((item) => item.id);
  } else {
    organisationIds = reachableOrganisationIds({
      activeOrganisations,
      grants,
      ownedCompanyIds,
      internalCompanyIds: internalCompanies,
    });
    if (!organisationIds.length) {
      /*
       * NO ACCESS ANYWHERE.
       *
       * This used to confine the caller to the PRIMARY workspace rather than
       * fail. In production that was, first, the whole security model failing
       * open for anonymous requests (closed in Stage 20), and then — for a
       * SIGNED-IN account with no membership — a quiet grant of another
       * customer's workspace as a Client. With more than one client company
       * that is a cross-company leak by construction, so a session with no
       * access now resolves to nothing and `scopedDb` refuses.
       *
       * The fallback survives only for the development demo, where no session
       * exists and the role cookie is the point.
       */
      if (session) {
        organisationIds = [];
        noAccess = true;
      } else if (demoIdentityAllowed()) {
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
   * WHICH WORKSPACE TO STAND IN — deterministic, and never wider than above.
   *
   *   1. The last workspace this browser selected (the cookie the switcher
   *      writes) — if still allowed.
   *   2. An Owner with no valid last selection lands on their company's
   *      designated default workspace.
   *   3. The workspace the session was opened in (the account's home, where
   *      its invitation landed) — if still allowed. After the company default
   *      for an Owner, because for them the home is only where the link
   *      happened to point, and the default is the company's own choice.
   *   4. A Platform Super Admin lands on the primary workspace.
   *   5. Otherwise the oldest allowed workspace.
   *
   * Every candidate is filtered through `allowed`, so a forged cookie or a
   * stale session value can choose among the workspaces this person already
   * has and never adds one.
   */
  const allowed = new Set(organisationIds);
  const isAllowed = (id: string | null | undefined): id is string => Boolean(id && allowed.has(id));
  const cookieChoice = workspaceCookieValue(request, ORGANISATION_COOKIE);
  let selectedId: string | undefined = isAllowed(cookieChoice) ? cookieChoice : undefined;
  if (!selectedId && !platformAdmin) {
    selectedId = (authority?.ownedCompanies ?? [])
      .map((company) => company.defaultOrganisationId)
      .find(isAllowed);
  }
  if (!selectedId && isAllowed(session?.organisationId)) selectedId = session?.organisationId ?? undefined;
  if (!selectedId && platformAdmin && allowed.has(primary.id)) selectedId = primary.id;
  selectedId ??= organisationIds[0];
  const organisation =
    activeOrganisations.find((item) => item.id === selectedId) ?? primary;

  const grantHere = grants.find((grant) => grant.organisationId === organisation.id);
  const ownerHere = !platformAdmin && ownsWorkspace(organisation);
  const siteScope = ownerHere ? null : (grantHere?.siteScope ?? null);

  /*
   * THE ROLE IS THE ONE HELD IN THE SELECTED WORKSPACE.
   *
   * Platform Super Admin everywhere; Owner in their own company's workspaces;
   * otherwise the membership here. It used to be the strongest role held
   * ANYWHERE, which let an Admin of one workspace act as an Admin in another
   * where they were only a Client — see the users-access-rbac tests.
   *
   * With no access here the answer is the weakest role (and `scopedDb`
   * refuses a `noAccess` request before any route sees it). The unaffiliated
   * development fallback keeps the role cookie it was resolved with.
   */
  const role: WorkspaceRole = platformAdmin
    ? "super_admin"
    : ownerHere
      ? "owner"
      : (grantHere?.role ?? (unaffiliated ? actor.role : "client"));

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
    grants,
    identityEmail,
    organisation,
    orgId: organisation.id,
    clientCompanyId: organisation.clientCompanyId ?? null,
    organisationIds,
    activeOrganisations,
    crossOrganisation: platformAdmin,
    platformAdmin,
    ownedCompanyIds,
    internalCompanyIds: [...internalCompanies].sort(),
    siteScope,
    unaffiliated,
    anonymous,
    noAccess,
    authenticated: !!session,
    session,
  };
}

/*
 * `roleInOrganisation`, `companyOfOrganisation` and `administersCompany` — the
 * per-workspace questions every route asks of a resolved access — live in
 * `access-scope.ts`, which imports nothing that needs a request, so the unit
 * tests can load them. They are re-exported here, where callers look.
 */
export { administersCompany, companyOfOrganisation, roleInOrganisation } from "./access-scope";
import { reachableOrganisationIds } from "./access-scope";

/** True when `organisationId` is one this access grant may read. */
export function canReadOrganisation(
  access: Pick<TenantAccess, "organisationIds">,
  organisationId: string,
) {
  return access.organisationIds.includes(organisationId);
}
