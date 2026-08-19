/**
 * What a person may do, and where that answer comes from.
 *
 * Stage 19 settled *which rows* an actor may read: `tenant-access.ts` resolves
 * an identity to its memberships and hands back the organisations and the role
 * the database grants. It deliberately stopped there. Inside one organisation
 * every actor still had the same powers, so "admin" and "client" were labels on
 * a sidebar rather than a boundary — a client could call the same write routes
 * an admin could, because nothing ever asked whether they were allowed to.
 *
 * This module is the missing half. Tenancy answers *whose data*; capability
 * answers *what may be done to it*. The two are independent: passing the tenancy
 * check and passing the capability check are separate gates, and a route needs
 * both.
 *
 * THE FALLBACK RULE
 * -----------------
 * `role_capabilities` holds *overrides*, not the permission set. A capability
 * with no row falls back to the built-in default for that role. This is the
 * single most important property here, and the reason the table is modelled as
 * a sparse diff rather than as the source of truth:
 *
 *   - An empty table is a working system. A freshly provisioned workspace, or
 *     one whose rows were lost, behaves exactly like the shipped defaults
 *     instead of locking everybody out of every screen.
 *   - Adding a new capability to the catalogue below does not silently grant it
 *     to everyone who happens to have a row, nor deny it to everyone who does
 *     not. It takes the default it was declared with.
 *
 * WHY SUPER ADMIN SHORT-CIRCUITS
 * ------------------------------
 * `can()` returns true for `super_admin` before it ever looks at the overrides.
 * A permission system that can lock out its own administrator is a permission
 * system with no recovery path — the only way back would be a database edit by
 * hand. Keeping the top role unconditional means the roles editor can never
 * produce a workspace nobody can administer, whatever is written to the table.
 * The write side backs this up by refusing to store `super_admin` rows at all,
 * so the table never claims something `can()` would ignore.
 *
 * WHICH ROLES EXIST
 * -----------------
 * Exactly three: `super_admin`, `admin`, `client`. That is not a shortlist — it
 * is the whole set the rest of the system can represent. `WorkspaceRole` in
 * `workspace-actor.ts` names those three, `normaliseRole` in `tenant-access.ts`
 * discards a membership whose role is anything else, and every `memberships`
 * row in the database is one of them. Inventing a `manager` or `contractor`
 * role here would create capability rows that no actor could ever match, and a
 * matrix column that looked editable and did nothing.
 */

import { eq, inArray } from "drizzle-orm";
import type { getDb } from "../../db";
import { roleCapabilities } from "../../db/schema";
import type { WorkspaceRole } from "./workspace-actor";

type Database = Awaited<ReturnType<typeof getDb>>;

/* ------------------------------------------------------------------ */
/* The capability catalogue                                            */
/* ------------------------------------------------------------------ */

export type CapabilityDefinition = {
  key: string;
  label: string;
  group: string;
  /** Written for the person editing the matrix, not for a developer. */
  description: string;
  /**
   * True when no route reads this capability yet.
   *
   * A matrix that shows a switch implies the switch does something. Where the
   * feature it names has not been built, saying so on the row is the only
   * honest option — the alternative is an administrator turning billing off
   * and believing they have withdrawn an ability nobody had.
   *
   * This is a temporary state by construction: `stage-twentythree-capabilities`
   * fails if a capability marked here gains an enforcement site, and fails if
   * one NOT marked here has none. So the flag cannot rot in either direction.
   */
  unenforced?: true;
};

/**
 * Every capability the product enforces, grouped for the matrix UI.
 *
 * Dotted `noun.verb`, matching the `audit_events.action` convention, so a
 * capability and the audit line it produces read as the same vocabulary.
 */
export const CAPABILITY_CATALOGUE = [
  {
    key: "board.view",
    label: "View boards",
    group: "Operational data",
    description: "Open the job, site and documentation boards for this workspace.",
  },
  {
    key: "board.edit",
    label: "Edit board rows",
    group: "Operational data",
    description: "Create, update and move rows, columns and groups on a board.",
  },
  {
    key: "sites.edit",
    label: "Edit sites and assets",
    group: "Operational data",
    description: "Change the site register, units and compliance records.",
  },
  {
    key: "data.import",
    label: "Import data",
    group: "Operational data",
    description: "Run a monday or spreadsheet import into this workspace.",
  },
  {
    key: "data.export",
    label: "Export data",
    group: "Operational data",
    description: "Download boards, sites and reports as CSV.",
  },
  {
    key: "data.delete",
    label: "Delete data permanently",
    group: "Operational data",
    description:
      "Remove rows rather than archive them. Destructive and not reversible from the UI.",
  },
  {
    key: "users.view",
    label: "View people",
    group: "People",
    description: "See who belongs to this workspace and what role they hold.",
  },
  {
    key: "users.invite",
    label: "Invite people",
    group: "People",
    description: "Send an invitation to join this workspace.",
  },
  {
    key: "users.edit",
    label: "Edit people",
    group: "People",
    description: "Change someone's profile details or the role they hold here.",
  },
  {
    key: "users.deactivate",
    label: "Deactivate people",
    group: "People",
    description:
      "Suspend someone's access without deleting their account or their history.",
  },
  {
    key: "teams.manage",
    label: "Manage teams",
    group: "People",
    description: "Create teams and decide who belongs to them.",
  },
  {
    key: "roles.edit",
    label: "Edit roles and permissions",
    group: "Administration",
    description: "Change what each role in this workspace is allowed to do.",
  },
  {
    key: "audit.read",
    label: "Read the audit trail",
    group: "Administration",
    description: "See sign-ins, permission changes and deletions.",
  },
  {
    key: "settings.edit",
    label: "Edit workspace settings",
    group: "Administration",
    description: "Change SLAs, alerting and workspace-wide preferences.",
  },
  {
    key: "clients.view_all",
    label: "See every client workspace",
    group: "Owner",
    description:
      "Open the cross-client console listing every workspace on the platform.",
  },
  {
    key: "billing.manage",
    label: "Manage billing and plans",
    group: "Owner",
    description:
      "Change a workspace's plan tier and billing arrangements. No billing screen exists yet, so this grants nothing today.",
    unenforced: true,
  },
] as const satisfies readonly CapabilityDefinition[];

export type Capability = (typeof CAPABILITY_CATALOGUE)[number]["key"];

export const CAPABILITIES: readonly Capability[] = CAPABILITY_CATALOGUE.map(
  (item) => item.key,
);

const CAPABILITY_SET = new Set<string>(CAPABILITIES);

/** Narrows an untrusted string to a capability, so a request cannot invent one. */
export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && CAPABILITY_SET.has(value);
}

/* ------------------------------------------------------------------ */
/* Roles                                                               */
/* ------------------------------------------------------------------ */

/** Every role the system can represent, strongest last. */
export const ROLES: readonly WorkspaceRole[] = ["client", "admin", "super_admin"];

/**
 * Ordering, used for the escalation guard-rail.
 *
 * Deliberately the same shape as `ROLE_RANK` in `tenant-access.ts`. It is not
 * imported from there because that module is owned by the tenancy contract and
 * does not export it; duplicating three integers is cheaper than widening that
 * module's surface, and `rolesAreExhaustive` in the Stage 20 test pins the two
 * lists together so they cannot drift apart unnoticed.
 */
export const ROLE_RANK: Record<WorkspaceRole, number> = {
  client: 0,
  admin: 1,
  super_admin: 2,
};

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  client: "Client",
};

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return value === "super_admin" || value === "admin" || value === "client";
}

/**
 * The role whose capability row may never be written.
 *
 * See the module header: `can()` ignores overrides for a super admin, so a row
 * stored against that role would be a lie the matrix displayed and the enforcer
 * disregarded. Refusing the write keeps the table and the behaviour honest.
 */
export const IMMUTABLE_ROLE: WorkspaceRole = "super_admin";

/* ------------------------------------------------------------------ */
/* Built-in defaults                                                   */
/* ------------------------------------------------------------------ */

/**
 * What each role may do when `role_capabilities` says nothing.
 *
 * `super_admin` is listed for completeness and for the matrix to render; `can()`
 * never consults it.
 *
 * `admin` runs one workspace end to end but does not reach across the platform:
 * no `clients.view_all`, no `billing.manage`. `data.delete` is withheld too —
 * archiving is reversible and deletion is not, so the destructive verb starts
 * closed and an owner can open it per workspace rather than everyone having it
 * by default.
 *
 * `client` is an external contact reading their own operational data. They can
 * see and export their boards and nothing else; every People and Administration
 * capability starts closed, which is what makes `/api/admin/users` answer 403
 * to a client rather than merely hiding a button.
 */
const BUILT_IN_DEFAULTS: Record<WorkspaceRole, readonly Capability[]> = {
  super_admin: CAPABILITIES,
  admin: [
    "board.view",
    "board.edit",
    "sites.edit",
    "data.import",
    "data.export",
    "users.view",
    "users.invite",
    "users.edit",
    "users.deactivate",
    "teams.manage",
    "roles.edit",
    "audit.read",
    "settings.edit",
  ],
  client: ["board.view", "data.export"],
};

const DEFAULT_SETS: Record<WorkspaceRole, ReadonlySet<Capability>> = {
  super_admin: new Set(BUILT_IN_DEFAULTS.super_admin),
  admin: new Set(BUILT_IN_DEFAULTS.admin),
  client: new Set(BUILT_IN_DEFAULTS.client),
};

/** The shipped answer for one role and capability, before any override. */
export function defaultAllows(role: WorkspaceRole, capability: Capability) {
  return DEFAULT_SETS[role].has(capability);
}

/* ------------------------------------------------------------------ */
/* Overrides                                                           */
/* ------------------------------------------------------------------ */

/** A sparse diff against the defaults. Absent key means "use the default". */
export type CapabilityOverrides = Partial<Record<Capability, boolean>>;

export type RoleOverrides = Record<WorkspaceRole, CapabilityOverrides>;

export function emptyRoleOverrides(): RoleOverrides {
  return { super_admin: {}, admin: {}, client: {} };
}

/**
 * The stored overrides for one workspace.
 *
 * Rows naming a role or capability this build does not know are skipped rather
 * than surfaced: a capability retired in a later release leaves its rows behind,
 * and they must not reappear in the matrix as an unlabelled toggle.
 */
export async function loadRoleOverrides(
  db: Database,
  organisationId: string,
): Promise<RoleOverrides> {
  const rows = await db
    .select({
      role: roleCapabilities.role,
      capability: roleCapabilities.capability,
      allowed: roleCapabilities.allowed,
    })
    .from(roleCapabilities)
    .where(eq(roleCapabilities.organisationId, organisationId));

  const overrides = emptyRoleOverrides();
  for (const row of rows) {
    if (!isWorkspaceRole(row.role) || !isCapability(row.capability)) continue;
    overrides[row.role][row.capability] = Boolean(row.allowed);
  }
  return overrides;
}

/** The same, for several workspaces at once. Used by the owner console. */
export async function loadRoleOverridesForOrganisations(
  db: Database,
  organisationIds: string[],
): Promise<Map<string, RoleOverrides>> {
  const byOrganisation = new Map<string, RoleOverrides>();
  if (!organisationIds.length) return byOrganisation;

  const rows = await db
    .select({
      organisationId: roleCapabilities.organisationId,
      role: roleCapabilities.role,
      capability: roleCapabilities.capability,
      allowed: roleCapabilities.allowed,
    })
    .from(roleCapabilities)
    .where(inArray(roleCapabilities.organisationId, organisationIds));

  for (const row of rows) {
    if (!isWorkspaceRole(row.role) || !isCapability(row.capability)) continue;
    const existing = byOrganisation.get(row.organisationId) ?? emptyRoleOverrides();
    existing[row.role][row.capability] = Boolean(row.allowed);
    byOrganisation.set(row.organisationId, existing);
  }
  return byOrganisation;
}

/* ------------------------------------------------------------------ */
/* The decision                                                        */
/* ------------------------------------------------------------------ */

/**
 * An actor, reduced to what a permission decision needs.
 *
 * `capabilities` are the overrides for *this actor's role in the workspace being
 * acted on*. Resolving that is the caller's job, because "the workspace being
 * acted on" is a routing question — the owner console legitimately asks about a
 * workspace other than the one the actor's cookie selected.
 */
export type PermissionSubject = {
  role: WorkspaceRole;
  capabilities: CapabilityOverrides;
};

/**
 * May this actor do this?
 *
 * The only function that answers the question. Every route calls it; nothing
 * re-derives the rule from `role === "admin"` locally, because a rule restated
 * per route is a rule that will eventually be restated wrongly in one.
 */
export function can(actor: PermissionSubject, capability: Capability): boolean {
  // No recovery path without this. See the module header.
  if (actor.role === IMMUTABLE_ROLE) return true;

  const override = actor.capabilities[capability];
  if (typeof override === "boolean") return override;
  return defaultAllows(actor.role, capability);
}

/** The full answer for one role, defaults merged with overrides. */
export function effectiveCapabilities(
  role: WorkspaceRole,
  overrides: CapabilityOverrides,
): Record<Capability, boolean> {
  const result = {} as Record<Capability, boolean>;
  for (const capability of CAPABILITIES) {
    result[capability] = can({ role, capabilities: overrides }, capability);
  }
  return result;
}

/** Resolves the subject for `role` in `organisationId` in one round trip. */
export async function resolvePermissions(
  db: Database,
  organisationId: string,
  role: WorkspaceRole,
): Promise<PermissionSubject> {
  const overrides = await loadRoleOverrides(db, organisationId);
  return { role, capabilities: overrides[role] };
}

/**
 * The 403 body every admin route returns when a capability is missing.
 *
 * One shape, so a caller (and the Stage 20 test) can tell "you may not do this"
 * apart from "that record does not exist" without parsing prose.
 */
export function capabilityDenied(capability: Capability, role: WorkspaceRole) {
  return Response.json(
    {
      error: `Your role (${ROLE_LABELS[role]}) does not have the "${capability}" permission in this workspace.`,
      capability,
      role,
      denied: true,
    },
    { status: 403 },
  );
}

/** `null` when allowed, a ready-to-return 403 when not. */
export function requireCapability(
  actor: PermissionSubject,
  capability: Capability,
): Response | null {
  return can(actor, capability) ? null : capabilityDenied(capability, actor.role);
}

/* ------------------------------------------------------------------ */
/* Guard-rails                                                         */
/* ------------------------------------------------------------------ */

/**
 * The reason a capability cell may not be written, or `null` if it may.
 *
 * Two rules, both about not being able to shut the door from the inside.
 *
 * 1. The `super_admin` row is not writable at all. `can()` ignores overrides for
 *    that role, so storing one would put a claim in the table that the enforcer
 *    disregards — a matrix that shows a denial which is not real is worse than
 *    no matrix.
 *
 * 2. Nobody may clear `roles.edit` on the role they themselves hold. An admin
 *    who unticks their own "Edit roles and permissions" cannot tick it back on;
 *    the only route out is a super admin or a hand-written database row. The
 *    check is on the *actor's* role rather than on their identity because
 *    capabilities are granted per role: taking it from `admin` takes it from
 *    this admin too, no matter whose name is on the change.
 *
 * Both are enforced here, on the server, and the matrix merely renders the
 * result — a disabled checkbox is a courtesy, not the rule.
 */
export function roleCapabilityWriteRefusal(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
  capability: Capability,
  allowed: boolean | null,
  /**
   * What the actor's role EFFECTIVELY holds right now — defaults merged with
   * this workspace's overrides.
   *
   * THIS PARAMETER EXISTS TO CLOSE A SELF-RESTORE HOLE, and the hole is worth
   * describing because the rule below reads correct without it.
   *
   * "You cannot hand out a power you do not have" was measured against
   * `defaultAllows(actorRole, …)` — the SHIPPED default — never against what
   * the role actually holds. So every narrowing of `admin` was self-reversible:
   * a super admin revoking `users.deactivate` from `admin` writes an override
   * row, and any admin could then PUT that same cell back to `allowed: true`.
   * `grantingUpward` was true, but `defaultAllows("admin", "users.deactivate")`
   * was ALSO true, so no refusal fired and the row was rewritten. The only
   * narrowing that stuck was removing `roles.edit` itself, which locks the
   * editor rather than limiting anything.
   *
   * Passing the effective set makes the sentence mean what it says. Omitting it
   * falls back to the defaults, which is the old behaviour — so callers that
   * only need the shape (and cannot see the overrides) still work, but both
   * real call sites pass it.
   */
  actorHolds?: Record<Capability, boolean>,
): string | null {
  /*
   * A super admin holds everything by definition (`can()` short-circuits), so
   * the upward check can never refuse the role that is meant to hold the lot.
   */
  const actorHasCapability = (name: Capability) =>
    actorRole === IMMUTABLE_ROLE
      ? true
      : actorHolds
        ? actorHolds[name] === true
        : defaultAllows(actorRole, name);

  if (targetRole === IMMUTABLE_ROLE) {
    return "The Super Admin role always holds every permission; it cannot be narrowed. This is what stops a workspace being locked out of its own permission editor.";
  }

  // `allowed === null` reverts the cell to its built-in default, so it is only
  // a lockout if the default itself is a denial.
  const wouldDeny =
    allowed === null ? !defaultAllows(targetRole, capability) : !allowed;

  if (capability === "roles.edit" && targetRole === actorRole && wouldDeny) {
    return "You cannot remove your own role's ability to edit roles and permissions — you would not be able to grant it back.";
  }

  /*
   * You cannot hand out a power you do not have.
   *
   * `canAssignRole` already stops an admin PROMOTING someone to super admin,
   * on the reasoning that granting powers you do not hold makes every other
   * limit on `admin` decorative. That reasoning applies exactly as well to a
   * capability, and this function did not apply it — so the boundary the
   * catalogue states, "admin runs one workspace but does not reach across the
   * platform: no clients.view_all, no billing.manage", was self-service.
   *
   * Proven before this change. A plain admin sent one request granting `admin`
   * both `clients.view_all` and `billing.manage`, was answered 200, and then
   * read the cross-client console listing every workspace on the platform.
   * The same route lets an admin grant `client` any capability, so a client
   * account holding owner powers could be built the same way.
   *
   * A super admin is unaffected: `can()` returns true for every capability, so
   * this can never refuse the role that is meant to hold everything.
   */
  const grantingUpward = allowed === null
    ? defaultAllows(targetRole, capability) && !actorHasCapability(capability)
    : allowed === true;

  if (grantingUpward && !actorHasCapability(capability)) {
    return `Your role does not hold "${capability}", so you cannot grant it. Ask someone who does.`;
  }

  return null;
}

/**
 * Whether `actorRole` may hand out `targetRole`.
 *
 * Escalation guard: an admin inviting or promoting somebody to super admin would
 * be granting powers they do not hold, which makes every other limit on `admin`
 * decorative. Equal rank is allowed — an admin may appoint another admin.
 */
export function canAssignRole(actorRole: WorkspaceRole, targetRole: WorkspaceRole) {
  return ROLE_RANK[actorRole] >= ROLE_RANK[targetRole];
}
