/**
 * The roles a person can act with, the level each belongs to, and who may
 * hand out which.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The role set used to be written out by hand in four places — `workspace-actor.ts`
 * named the type, `tenant-access.ts` and `invitation-tokens.ts` each carried a
 * private `normaliseRole` and `ROLE_RANK`, and `permissions.ts` carried a third
 * rank table "deliberately the same shape", kept level by a test. A copy that
 * was missed does not fail loudly: a normaliser that has never heard of a role
 * silently discards the membership. So the set lives here, once. It is plain
 * data with no server import, so a browser role picker built from
 * `assignableRoles` cannot offer something `canAssignRole` would refuse.
 *
 * THREE LEVELS, NOT ONE LADDER
 * ----------------------------
 *
 *   PLATFORM          super_admin   MAINTSUPP staff. Every company, every
 *                                   workspace. A property of the PERSON
 *                                   (`platform_admins`), never a membership.
 *
 *   CLIENT COMPANY    owner         The customer's owner. Every workspace of
 *                                   the companies they own, including ones
 *                                   created later (`client_company_members`).
 *
 *   WORKSPACE         admin         Runs the workspaces they are a member of.
 *                     manager       Operational work in their workspaces.
 *                     client        Reads their own workspace's data.
 *                                   (`memberships`, one row per workspace)
 *
 * `WorkspaceRole` is the role a person ACTS WITH inside one workspace, which is
 * why it includes the two higher levels: a Platform Super Admin standing in a
 * workspace acts as `super_admin`, an Owner standing in one of their company's
 * workspaces acts as `owner`. Only the three workspace roles can be stored on a
 * membership row — `MEMBERSHIP_ROLES`.
 *
 * Who may grant or act on which role is the table in `canAssignRole`, not a
 * rank comparison: authority depends on the level and the scope as well as on
 * the order. Rank orders roles for display and answers the few "internal staff
 * only" questions (the finance module).
 */

export type WorkspaceRole = "super_admin" | "owner" | "admin" | "manager" | "client";

/** The roles a `memberships` row may hold — the workspace level. */
export type MembershipRole = "admin" | "manager" | "client";

/** Every role a person can act with, weakest first. */
export const ROLES: readonly WorkspaceRole[] = ["client", "manager", "admin", "owner", "super_admin"];

/** The workspace-level roles, weakest first. */
export const MEMBERSHIP_ROLES: readonly MembershipRole[] = ["client", "manager", "admin"];

/** The order roles are displayed and compared in. */
export const ROLE_RANK: Record<WorkspaceRole, number> = {
  client: 0,
  manager: 1,
  admin: 2,
  owner: 3,
  super_admin: 4,
};

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  super_admin: "Super Admin",
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  client: "Client",
};

/** Which level of the product a role belongs to. */
export const ROLE_LEVEL: Record<WorkspaceRole, "platform" | "company" | "workspace"> = {
  super_admin: "platform",
  owner: "company",
  admin: "workspace",
  manager: "workspace",
  client: "workspace",
};

const ROLE_SET = new Set<string>(ROLES);
const MEMBERSHIP_ROLE_SET = new Set<string>(MEMBERSHIP_ROLES);

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && ROLE_SET.has(value);
}

/** True only for a role a membership row may hold. */
export function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === "string" && MEMBERSHIP_ROLE_SET.has(value);
}

/**
 * A stored or requested role, or `null` when it is not one the system knows.
 *
 * `null` rather than a default, because the right fallback differs by caller:
 * the tenancy resolver discards an unknown membership outright, while a display
 * label falls back to the least privileged wording.
 */
export function normaliseRole(value: unknown): WorkspaceRole | null {
  return isWorkspaceRole(value) ? value : null;
}

/** A membership row's role, or `null` for anything a membership may not hold. */
export function normaliseMembershipRole(value: unknown): MembershipRole | null {
  return isMembershipRole(value) ? value : null;
}

/** How a stored role reads to a person. Unknown values read as the weakest role. */
export function roleLabel(value: unknown): string {
  return ROLE_LABELS[normaliseRole(value) ?? "client"];
}

/**
 * Who may hand out which role — the owner's decisions, written as a table.
 *
 *   Super Admin → Owner, Admin, Manager, Client. Not Super Admin: platform
 *                 authority is not a company or workspace role, and appointing
 *                 MAINTSUPP staff is not something these screens do.
 *   Owner       → Admin, Manager, Client — inside their own company only.
 *                 Not Owner (no co-owners unless that is decided later).
 *   Admin       → Manager, Client — inside workspaces they administer only.
 *   Manager     → nothing
 *   Client      → nothing
 *
 * The SCOPE half of each rule ("inside their own company", "inside workspaces
 * they administer") is enforced by the routes, which only ever evaluate this
 * with the role the actor holds in the workspace or company being acted on.
 */
const ASSIGNABLE: Record<WorkspaceRole, readonly WorkspaceRole[]> = {
  super_admin: ["client", "manager", "admin", "owner"],
  owner: ["client", "manager", "admin"],
  admin: ["client", "manager"],
  manager: [],
  client: [],
};

/**
 * Whose ACCOUNT an actor may act on — change a role, reset a password,
 * deactivate, edit a profile.
 *
 * The assignment table, plus one addition: a Super Admin may act on another
 * Super Admin's account (deactivate, reset), with the last-platform-admin
 * guard-rail on top. Nobody else may act on anyone at or above their own
 * level: an Owner cannot act on another Owner, an Admin on another Admin.
 */
const MANAGEABLE: Record<WorkspaceRole, readonly WorkspaceRole[]> = {
  super_admin: ["client", "manager", "admin", "owner", "super_admin"],
  owner: ["client", "manager", "admin"],
  admin: ["client", "manager"],
  manager: [],
  client: [],
};

/** Whether `actorRole` may hand out `targetRole` — by invitation or by a role change. */
export function canAssignRole(actorRole: WorkspaceRole, targetRole: WorkspaceRole) {
  return ASSIGNABLE[actorRole].includes(targetRole);
}

/** Whether `actorRole` may act on an account currently holding `targetRole`. */
export function canManageRole(actorRole: WorkspaceRole, targetRole: WorkspaceRole) {
  return MANAGEABLE[actorRole].includes(targetRole);
}

/** The roles `actorRole` may grant, weakest first — what a role picker offers. */
export function assignableRoles(actorRole: unknown): WorkspaceRole[] {
  const actor = normaliseRole(actorRole);
  if (!actor) return [];
  return [...ASSIGNABLE[actor]];
}

/** "an Admin", "a Manager" — for refusal sentences. */
export function withArticle(role: WorkspaceRole) {
  const label = ROLE_LABELS[role];
  return `${/^[AEIOU]/i.test(label) ? "an" : "a"} ${label}`;
}

/** The stronger of two roles. */
export function strongerRole(left: WorkspaceRole, right: WorkspaceRole): WorkspaceRole {
  return ROLE_RANK[right] > ROLE_RANK[left] ? right : left;
}
