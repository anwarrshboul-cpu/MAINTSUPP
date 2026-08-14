/**
 * Who may see what, and who may do what.
 *
 * THIS FILE IS THE ACCESS CONTROL. Read it before changing any query.
 *
 * On the previous Supabase-native design, Postgres row-level security enforced
 * tenancy: a client_admin's `select * from jobs` returned their organisation's
 * rows because the database filtered them. This architecture puts the API
 * between the browser and the database, and the API connects as one Postgres
 * role — so RLS can no longer distinguish callers, and every policy would
 * evaluate against the same identity.
 *
 * Tenancy is therefore enforced here, in code, and the rule is:
 *
 *   NO route may query `jobs`, `sites`, `quotes`, `job_comments` or
 *   `attachments` without composing its WHERE clause from `scopeFor()`.
 *
 * Route handlers do not write their own tenancy predicates. That is not a
 * style preference — a rule expressed in fifteen handlers is fifteen places to
 * get it wrong, and the one that is wrong is the breach. `tests/access.test.ts`
 * asserts the predicates directly, so the rules are checked without having to
 * exercise every endpoint.
 */

export type Role =
  | "owner"
  | "super_admin"
  | "admin"
  | "client_admin"
  | "client_user"
  | "contractor";

export type Actor = {
  profileId: string;
  email: string;
  role: Role;
  status: "active" | "pending_approval" | "suspended";
  organisationId: string | null;
  contractorId: string | null;
  /** Sites this profile is scoped to. Only meaningful for `client_user`. */
  siteIds: string[];
};

/** The founding account. Never deletable, deactivatable or downgradable. */
export const OWNER_EMAIL = "anwarrshboul@gmail.com";

const STAFF: readonly Role[] = ["owner", "super_admin", "admin"];

/** Staff see every organisation. The brief's owner/super_admin/admin. */
export function isStaff(role: Role): boolean {
  return STAFF.includes(role);
}

/**
 * Seniority, for deciding who may act on whom.
 * client_user and contractor share a rank: neither may administer anyone.
 */
const RANK: Record<Role, number> = {
  owner: 5,
  super_admin: 4,
  admin: 3,
  client_admin: 2,
  client_user: 1,
  contractor: 1,
};

export type Predicate = { sql: string; params: unknown[] };

/** Always false, for a caller who may see nothing. */
const DENY: Predicate = { sql: "false", params: [] };
/** Always true, for staff. */
const ALLOW: Predicate = { sql: "true", params: [] };

/**
 * The WHERE fragment restricting `jobs` to what `actor` may see.
 *
 * `alias` is the table alias in the caller's query, so this composes into
 * joins. Parameters are returned separately and never interpolated — the only
 * text this function puts into SQL is an alias the caller controls and a fixed
 * set of column names.
 *
 * Placeholders are numbered from `offset + 1` so a caller with existing
 * parameters can append these without renumbering by hand.
 */
export function scopeFor(
  actor: Actor,
  alias = "j",
  offset = 0,
): Predicate {
  // A suspended or unapproved account sees nothing at all, whatever its role.
  // Checked first so a suspended owner is still refused.
  if (actor.status !== "active") return DENY;

  if (isStaff(actor.role)) return ALLOW;

  if (actor.role === "client_admin") {
    // Their organisation. A client_admin with no organisation is a
    // half-finished approval; the schema forbids it while active, and this
    // refuses rather than falling through to "see everything".
    if (!actor.organisationId) return DENY;
    return {
      sql: `${alias}.organisation_id = $${offset + 1}`,
      params: [actor.organisationId],
    };
  }

  if (actor.role === "client_user") {
    if (!actor.organisationId || actor.siteIds.length === 0) return DENY;
    /*
     * Organisation AND site. The organisation check is redundant while site
     * ids are globally unique uuids — and it stays, because it is the check
     * that still holds if a site is ever moved between organisations, and
     * because defence that only works under an assumption is not defence.
     */
    return {
      sql: `(${alias}.organisation_id = $${offset + 1} and ${alias}.site_id = any($${offset + 2}::uuid[]))`,
      params: [actor.organisationId, actor.siteIds],
    };
  }

  if (actor.role === "contractor") {
    if (!actor.contractorId) return DENY;
    // Only jobs assigned to them — not their organisation's, not other
    // contractors'. The brief is explicit that a contractor sees no other
    // client's work.
    return {
      sql: `${alias}.contractor_id = $${offset + 1}`,
      params: [actor.contractorId],
    };
  }

  // Unreachable while Role is exhaustive. Deny rather than fall through: a
  // role added later without updating this file must fail closed.
  return DENY;
}

/** The same restriction expressed against `sites`. */
export function siteScopeFor(
  actor: Actor,
  alias = "s",
  offset = 0,
): Predicate {
  if (actor.status !== "active") return DENY;
  if (isStaff(actor.role)) return ALLOW;

  if (actor.role === "client_admin") {
    if (!actor.organisationId) return DENY;
    return {
      sql: `${alias}.organisation_id = $${offset + 1}`,
      params: [actor.organisationId],
    };
  }
  if (actor.role === "client_user") {
    if (!actor.organisationId || actor.siteIds.length === 0) return DENY;
    /*
     * Organisation AND site — the same pairing `scopeFor` uses, and for the
     * same reason stated there: defence that only works under an assumption is
     * not defence.
     *
     * This branch checked the site list alone, which was safe only while every
     * `profile_sites` row was guaranteed to belong to the profile's own
     * organisation — and nothing guaranteed it. `POST /members/:id/approve`
     * accepted any site id, so a mis-scoped approval handed a store manager the
     * site register, the compliance register and the expiry calendar of another
     * client. `scopeFor` caught the same mistake and returned no jobs, so one
     * predicate held and the other did not; the endpoints built on this one
     * leaked. Approve now validates the pairing too — both fixes are needed,
     * because either alone leaves the other assumption unchecked.
     */
    return {
      sql: `(${alias}.organisation_id = $${offset + 1} and ${alias}.id = any($${offset + 2}::uuid[]))`,
      params: [actor.organisationId, actor.siteIds],
    };
  }
  // A contractor has no business browsing a site register.
  return DENY;
}

/**
 * The same restriction for a row that belongs to an ORGANISATION and to no site
 * — an invoice raised against the account rather than against one store.
 *
 * The interesting case is `client_user`, which is DENY here while `scopeFor`
 * would have let them through on a site match. A client_user is scoped to a
 * list of stores; a row with no site is by definition about the whole account,
 * so there is no site match to make and "their organisation" is not their
 * scope. Falling back to the organisation would quietly widen a store manager
 * to everything the account owns, which is the exact widening `scopeFor` spends
 * two predicates preventing.
 */
export function organisationScopeFor(
  actor: Actor,
  alias = "i",
  offset = 0,
): Predicate {
  if (actor.status !== "active") return DENY;
  if (isStaff(actor.role)) return ALLOW;

  if (actor.role === "client_admin") {
    if (!actor.organisationId) return DENY;
    return {
      sql: `${alias}.organisation_id = $${offset + 1}`,
      params: [actor.organisationId],
    };
  }
  // client_user: site-scoped, see above. contractor: never.
  return DENY;
}

/* ------------------------------------------------------------ capabilities -- */

/** Money: cost of works, quotes, invoices. Contractors never see pricing. */
export function canSeeMoney(actor: Actor): boolean {
  return actor.status === "active" && actor.role !== "contractor";
}

/** Approving or rejecting a quote. The client decides; staff may act for them. */
export function canDecideQuotes(actor: Actor): boolean {
  return (
    actor.status === "active" &&
    (isStaff(actor.role) || actor.role === "client_admin")
  );
}

/**
 * Recording an invoice, marking one paid, attaching its PDF.
 *
 * Staff only, and narrower than `canSeeMoney` on purpose: a client_admin READS
 * their own organisation's invoices — that is the point of showing them — but
 * the ledger is MAINTSUPP's bookkeeping, and a client marking their own invoice
 * paid is not a record anybody could rely on afterwards.
 */
export function canRecordInvoices(actor: Actor): boolean {
  return actor.status === "active" && isStaff(actor.role);
}

/**
 * Uploading a certificate, setting its expiry, declaring a requirement not
 * applicable.
 *
 * Wider than staff, because the certificates are the client's own paperwork —
 * their PLI, their PAT test — and a portal that makes them email a PDF to a
 * coordinator to get it on file is a portal they stop using. `client_user` is
 * deliberately excluded: it is a site-scoped viewer, and `not_required` removes
 * a row from the compliance denominator, which is a policy decision about the
 * estate rather than an observation about one store.
 */
export function canManageCompliance(actor: Actor): boolean {
  return (
    actor.status === "active" &&
    (isStaff(actor.role) || actor.role === "client_admin")
  );
}

/** Triage: converting an intake request into a job, or rejecting it. */
export function canTriage(actor: Actor): boolean {
  return actor.status === "active" && isStaff(actor.role);
}

/** The Members page: invite, approve, change role, deactivate. */
export function canManageMembers(actor: Actor): boolean {
  return actor.status === "active" && isStaff(actor.role);
}

/** Issuing, revoking or rotating a job's share link. */
export function canManageShareLinks(actor: Actor): boolean {
  return actor.status === "active" && isStaff(actor.role);
}

/**
 * Account-level settings: reading them, changing them, and their audit trail.
 *
 * The owner alone, not staff. These switches change what OTHER people are
 * shown — the first one decides whether a share link carries money — so they
 * belong to the one account that cannot be deleted, deactivated or downgraded.
 * A super_admin who needs one changed asks the owner, which is a conversation;
 * the alternative is a privilege that lets an admin quietly widen or narrow
 * what every client and contractor sees.
 *
 * Read is gated as tightly as write on purpose: the settings screen shows the
 * environment's value alongside the stored one, and that is deployment
 * configuration rather than product data.
 */
export function canManageSettings(actor: Actor): boolean {
  return actor.status === "active" && actor.role === "owner";
}

/**
 * Whether `actor` may modify `target`.
 *
 * Two rules. The owner account is untouchable from the API, by anyone,
 * including itself — that is the brief's "can never be deleted, deactivated or
 * downgraded", and making it absolute means there is no sequence of requests
 * that locks everybody out of the product.
 *
 * Otherwise you may only act on someone strictly below your own rank, so an
 * admin cannot demote a super_admin, and two admins cannot deactivate each
 * other.
 */
export function canActOnMember(
  actor: Actor,
  target: { email: string; role: Role },
): { allowed: boolean; reason?: string } {
  if (!canManageMembers(actor)) {
    return { allowed: false, reason: "Not permitted to manage members." };
  }
  if (target.email.trim().toLowerCase() === OWNER_EMAIL) {
    return { allowed: false, reason: "The owner account cannot be modified." };
  }
  if (RANK[actor.role] <= RANK[target.role]) {
    return {
      allowed: false,
      reason: "You cannot modify an account at or above your own level.",
    };
  }
  return { allowed: true };
}

/**
 * Whether `actor` may grant `role`.
 *
 * You cannot create an account more powerful than yourself; without this an
 * admin invites a super_admin and has escalated by proxy. `owner` is never
 * grantable — there is one, declared in `role_bootstrap`.
 */
export function canGrantRole(actor: Actor, role: Role): boolean {
  if (!canManageMembers(actor)) return false;
  if (role === "owner") return false;
  return RANK[actor.role] > RANK[role];
}

/** Composes a scope into a WHERE clause, keeping parameter order correct. */
export function withScope(
  base: string,
  baseParams: unknown[],
  predicate: Predicate,
): { sql: string; params: unknown[] } {
  if (predicate.sql === "true") return { sql: base, params: baseParams };
  const joiner = /\swhere\s/i.test(base) ? "and" : "where";
  return {
    sql: `${base} ${joiner} ${predicate.sql}`,
    params: [...baseParams, ...predicate.params],
  };
}
