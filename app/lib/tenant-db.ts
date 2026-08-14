import { getDb } from "../../db";
import { organisations } from "../../db/schema";
import {
  PRIMARY_ORGANISATION_ID,
  demoIdentityAllowed,
  resolveTenantAccess,
  type TenantAccess,
} from "./tenant-access";
import { type WorkspaceActor } from "./workspace-actor";
import {
  type Capability,
  requireCapability,
  resolvePermissions,
} from "./permissions";

export { PRIMARY_ORGANISATION_ID };
export { DEMO_ORGANISATION_ID } from "./tenant-access";

export type ScopedDatabase = {
  actor: WorkspaceActor;
  db: Awaited<ReturnType<typeof getDb>>;
  orgId: string;
  organisation: typeof organisations.$inferSelect;
  siteScope: string[] | null;

  // Stage 19 additions. `orgId` is still the one organisation a route reads and
  // writes, so nothing downstream had to change; these describe the actor's
  // wider reach for the two callers that legitimately need it — the workspace
  // context screen and the super admin's cross-tenant summary.
  identityEmail: string;
  organisationIds: string[];
  activeOrganisations: Array<typeof organisations.$inferSelect>;
  crossOrganisation: boolean;
  unaffiliated: boolean;

  /**
   * Stage 20. Whether the caller proved who they are, or is being taken at
   * their word by the testing role switcher.
   *
   * A route that only reads may not care. One that grants something — an
   * invitation, a role change, another workspace's rows — must, because the
   * switcher is a demo affordance any browser can use. `resolveTenantAccess`
   * already refuses to let a cookie widen a real session's reach; this is how a
   * route tells the two apart rather than assuming.
   */
  authenticated: boolean;
  session: TenantAccess["session"];
};

/**
 * The organisation-scoped database handle every data route resolves.
 *
 * `orgId` is decided by `resolveTenantAccess`: the actor's memberships, not the
 * request's cookies. A route that filters on `orgId` — which is all of them — is
 * therefore filtering on something the caller cannot choose for themselves. See
 * `app/lib/tenant-access.ts` for why that indirection exists.
 */
/**
 * Thrown when a request that proved nothing asks for tenant data.
 *
 * Carried as an error rather than a Response because `scopedDb` returns a
 * database handle, not an HTTP result, and every caller already has a
 * try/catch. `isAnonymousAccess` lets a route turn it into a 401 where it
 * cares to; where it does not, the existing catch turns it into a refusal,
 * which is the correct outcome either way. What matters is that no path
 * returns data.
 */
export class AnonymousAccessError extends Error {
  constructor() {
    super("Sign in to use this workspace.");
    this.name = "AnonymousAccessError";
  }
}

export function isAnonymousAccess(error: unknown) {
  return error instanceof AnonymousAccessError;
}

/**
 * The answer an unauthenticated caller should get, or null if this is a real
 * failure that belongs in the caller's own error path.
 *
 * Every route in this codebase wraps its body in a try/catch that ends in a
 * 503 and a sentence like "the workspace is temporarily unavailable". That is
 * the right answer for a database that is down. It is the wrong answer twice
 * over for a session that has expired: 503 means "retry later", so a browser
 * and a person both wait for a recovery that will never come; and the sentence
 * blames the workspace for something the reader can fix in ten seconds by
 * signing in again.
 *
 * 401 with `signIn: true` instead. The status is what a client can branch on
 * without parsing prose, and the flag is what distinguishes "you are not
 * signed in" from "you are signed in and not allowed", which is a 403 and
 * needs a different screen.
 *
 * Used at the TOP of each catch, before the generic handler, because the
 * generic handler cannot tell these apart — it only ever sees a message.
 */
export function anonymousRefusal(error: unknown): Response | null {
  if (!isAnonymousAccess(error)) return null;
  return Response.json(
    { error: "Your session has ended. Sign in to continue.", signIn: true },
    { status: 401 },
  );
}

/**
 * `allowAnonymous` is for the two surfaces that are genuinely public.
 *
 * The public lead form has no account behind it by definition, and a
 * contractor uploading evidence from a job link proves themselves with that
 * token rather than a session. Both then do their own checking. Everything
 * else must refuse — see `resolveTenantAccess`, where an unauthenticated
 * production request used to be handed the live tenant.
 */
export async function scopedDb(
  request: Request,
  options: { allowAnonymous?: boolean } = {},
): Promise<ScopedDatabase> {
  const db = await getDb();
  const access: TenantAccess = await resolveTenantAccess(db, request);

  if (access.anonymous && !options.allowAnonymous) {
    throw new AnonymousAccessError();
  }

  return {
    actor: access.actor,
    db,
    orgId: access.orgId,
    organisation: access.organisation,
    siteScope: access.siteScope,
    identityEmail: access.identityEmail,
    organisationIds: access.organisationIds,
    activeOrganisations: access.activeOrganisations,
    crossOrganisation: access.crossOrganisation,
    unaffiliated: access.unaffiliated,
    authenticated: access.authenticated,
    session: access.session,
  };
}

/**
 * `scopedDb`, with a capability the caller must hold.
 *
 * `scopedDb` answers "whose data is this" and nothing else. That is tenant
 * isolation, and it is enforced everywhere — but it is not authorisation, and
 * the two were being conflated. Every operational write route resolved a
 * scoped database and then wrote, so a `client` — whose built-in capabilities
 * are `board.view` and `data.export` and nothing more — could create a board
 * group, a column, a site or a unit through the API while the UI hid the
 * buttons. Proven against the running server before this existed: a client
 * identity POSTing /api/board/groups was answered 201 and the group appeared
 * on the board.
 *
 * The admin routes never had this gap: they go through `admin-context.ts`,
 * which resolves permissions. This is the same check, packaged so an
 * operational route needs one line rather than five.
 *
 * Returns either `{ denied }` — a ready 403 in the shape `capabilityDenied`
 * defines, so callers stay indistinguishable from the admin routes — or the
 * scope. Written as a discriminated result rather than a thrown error because
 * every caller here already returns Responses.
 */
export async function scopedDbWithCapability(
  request: Request,
  capability: Capability,
): Promise<{ denied: Response; scope?: never } | { denied?: never; scope: ScopedDatabase }> {
  const scope = await scopedDb(request);

  /*
   * Prove who you are before we ask what you may do.
   *
   * In development the demo identities make `authenticated` false for a caller
   * who is nonetheless deliberately acting as someone; the role switcher is how
   * the dashboard is demoed, and refusing here would break it. In production
   * `demoIdentityAllowed()` is false and there is no such caller — anyone who
   * reaches a write route without a session is a stranger.
   */
  if (!scope.authenticated && !demoIdentityAllowed()) {
    return {
      denied: Response.json(
        { error: "Sign in to make this change." },
        { status: 401 },
      ),
    };
  }

  const subject = await resolvePermissions(scope.db, scope.orgId, scope.actor.role);
  const refusal = requireCapability(subject, capability);
  return refusal ? { denied: refusal } : { scope };
}
