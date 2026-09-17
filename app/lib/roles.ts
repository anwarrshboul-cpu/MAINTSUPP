/**
 * The roles a workspace membership can hold, and the one ordering between them.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The role set used to be written out by hand in four places — `workspace-actor.ts`
 * named the type, `tenant-access.ts` and `invitation-tokens.ts` each carried a
 * private `normaliseRole` and `ROLE_RANK`, and `permissions.ts` carried a third
 * rank table "deliberately the same shape", kept level by a test. That was
 * tolerable for three roles that never changed. Adding a fourth meant finding
 * every copy, and a copy that was missed does not fail loudly: a
 * `normaliseRole` that has never heard of `manager` silently discards the
 * membership, and a rank table without it compares `undefined`.
 *
 * So the set lives here, once, and every other module imports it. It is plain
 * data with no database or server import, so the browser bundles can use the
 * same answers the server enforces — a role dropdown built from
 * `assignableRoles` cannot offer something `canAssignRole` would refuse.
 *
 * THE HIERARCHY
 * -------------
 *
 *     super_admin   every workspace, every capability, always (`can()` short-circuits)
 *         ↓
 *     admin         runs the workspaces they are a member of, and only those
 *         ↓
 *     manager       operational work inside their workspaces, no administration
 *         ↓
 *     client        reads and exports their own workspace's operational data
 *
 * Who may grant or act on which role is the table in `canAssignRole`, not a
 * rank comparison. Rank orders the roles for display and answers the few
 * "internal staff only" questions (the finance module). What a role may DO is
 * decided by capabilities in `permissions.ts`.
 */

export type WorkspaceRole = "super_admin" | "admin" | "manager" | "client";

/** Every role the system can represent, weakest first. */
export const ROLES: readonly WorkspaceRole[] = ["client", "manager", "admin", "super_admin"];

/** The ordering the escalation guard-rails compare. */
export const ROLE_RANK: Record<WorkspaceRole, number> = {
  client: 0,
  manager: 1,
  admin: 2,
  super_admin: 3,
};

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  manager: "Manager",
  client: "Client",
};

const ROLE_SET = new Set<string>(ROLES);

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && ROLE_SET.has(value);
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

/** How a stored role reads to a person. Unknown values read as the weakest role. */
export function roleLabel(value: unknown): string {
  return ROLE_LABELS[normaliseRole(value) ?? "client"];
}

/**
 * Who may hand out which role — the owner's decision, written as a table.
 *
 *   Super Admin → Admin, Manager, Client (and Super Admin, which the decision
 *                 did not withdraw and the product has always allowed)
 *   Admin       → Manager, Client. Never Admin, never Super Admin.
 *   Manager     → nothing
 *   Client      → nothing
 *
 * This used to be a rank comparison allowing EQUAL rank, so an admin could
 * appoint another admin. It is a table now because the rule is no longer a
 * single inequality: an admin grants strictly below themselves, and a manager
 * grants nothing even though a client ranks below them. Listed weakest first,
 * which is the order a role picker shows them in.
 */
const ASSIGNABLE: Record<WorkspaceRole, readonly WorkspaceRole[]> = {
  super_admin: ["client", "manager", "admin", "super_admin"],
  admin: ["client", "manager"],
  manager: [],
  client: [],
};

/** Whether `actorRole` may hand out `targetRole` — by invitation or by a role change. */
export function canAssignRole(actorRole: WorkspaceRole, targetRole: WorkspaceRole) {
  return ASSIGNABLE[actorRole].includes(targetRole);
}

/**
 * Whether `actorRole` may act on an account currently holding `targetRole` —
 * change its role, reset its password, deactivate it, edit its profile.
 *
 * The same table as `canAssignRole`, for the same reason: an admin who cannot
 * make somebody an Admin must not be able to demote, lock out or take over an
 * Admin either. A Super Admin may act on everyone; the last-Super-Admin and
 * "not yourself" guard-rails still apply on top.
 */
export function canManageRole(actorRole: WorkspaceRole, targetRole: WorkspaceRole) {
  return canAssignRole(actorRole, targetRole);
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
