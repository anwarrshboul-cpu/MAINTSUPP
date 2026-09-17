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
 * Five roles a person can act with — `super_admin` (platform), `owner` (client
 * company), `admin`, `manager`, `client` (workspace) — defined ONCE in
 * `roles.ts`, which also explains the three levels.
 *
 * This paragraph used to say "exactly three", and warned that inventing a
 * `manager` here would create capability rows no actor could ever match. That
 * warning was the reason `manager` was added to `roles.ts` rather than here:
 * `WorkspaceRole`, the tenancy resolver's `normaliseRole`, the invitation
 * service and this module all read the same list now, so a role this module
 * knows is a role a membership row can actually hold. Adding a fifth means
 * editing `roles.ts` and giving it a default set below — nothing else.
 *
 * RESERVED CAPABILITIES
 * ---------------------
 * A few capabilities are not workspace powers at all; they reach across the
 * platform or change what every role means. `SUPER_ADMIN_ONLY` lists them, and
 * `can()` refuses them to every other role before it reads an override. The
 * matrix cannot grant them either — see `roleCapabilityWriteRefusal`. Without
 * that, "only a Super Admin sees every client" would be one checkbox away from
 * false, and strict workspace isolation would depend on nobody ticking it.
 */

import { eq, inArray } from "drizzle-orm";
import type { getDb } from "../../db";
import { roleCapabilities } from "../../db/schema";
import {
  ROLE_LABELS,
  ROLE_RANK,
  ROLES,
  canAssignRole,
  canManageRole,
  isWorkspaceRole,
  type WorkspaceRole,
} from "./roles";

// Re-exported so the admin routes keep importing the role vocabulary from the
// module that decides permissions. The definitions themselves live in roles.ts.
export { ROLE_LABELS, ROLE_RANK, ROLES, canAssignRole, canManageRole, isWorkspaceRole };

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
    description:
      "Change what each role in this workspace is allowed to do. Reserved for Super Admin.",
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
      "Open the cross-client console listing every workspace on the platform. Reserved for Super Admin.",
  },
  {
    key: "navigation.edit",
    label: "Customise the sidebar",
    group: "Owner",
    /*
     * The sidebar is the product's menu. Rearranging it, locking items, and
     * adding or archiving a workspace section change what everybody sees, so
     * this used to ride on `settings.edit` — which every admin holds. The owner
     * asked for menu administration to be a Super Admin act, and a capability
     * of its own is what lets the three routes that write the menu
     * (`/api/navigation`, `/api/workspace-sections`) say so in one word.
     */
    description:
      "Rearrange, lock, add and archive the sidebar's sections for everyone. Reserved for Super Admin.",
  },
  {
    key: "navigation.personalise",
    label: "Arrange your own sidebar",
    group: "Personal",
    /*
     * The other half of the owner's sidebar decision: the workspace's menu is
     * Super Admin's, but a person may still arrange their OWN sidebar. That is
     * a separate row (`navigation_layouts.user_id` = them), it can never touch
     * the workspace default or its locks, and locked items stay locked in it.
     * A capability rather than "anyone signed in" so a Super Admin can close it
     * for a role in one workspace without a deploy.
     */
    description:
      "Reorder, rename and hide items in your own sidebar only. Never changes what anybody else sees, and cannot unlock a locked item.",
  },
  {
    key: "billing.manage",
    label: "Manage billing and bank details",
    group: "Owner",
    /*
     * ENFORCED NOW, and the flag is cleared in the same edit that gave it
     * something to guard.
     *
     * Module 5 §16: "Bank details appear only in settings, never in code."
     * `/api/finance/settings` reads this capability twice — once to decide
     * whether a sort code and an account number come back in full or masked to
     * their last four digits, and once to refuse a write of either. It is the
     * narrowest door the product has, which is the right one for the detail
     * that moves money: `contractors` deliberately carries no account number at
     * all because this repository is public, and these are the workspace's own
     * accounts, typed into a form by an owner.
     */
    description:
      "See and change the workspace's bank details, and its plan tier. Without it the finance settings screen masks every account number to its last four digits and refuses a change.",
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

/*
 * `ROLES`, `ROLE_RANK`, `ROLE_LABELS` and `isWorkspaceRole` used to be defined
 * here, with a comment explaining why the rank table was a deliberate duplicate
 * of the one in `tenant-access.ts`. Both now come from `roles.ts` (imported and
 * re-exported above), so there is no second copy left to drift.
 */

/**
 * Capabilities no role below Super Admin may hold, whatever the matrix says.
 *
 * - `clients.view_all` — the cross-client console. Strict workspace isolation
 *   means nobody but a Super Admin can discover another client exists.
 * - `roles.edit` — the matrix itself. Changing what "Admin" or "Manager" means
 *   is role administration, which the owner reserved for Super Admin. It used
 *   to be in the admin defaults; an admin who could edit the matrix could also
 *   hand `manager` any power admin held.
 * - `navigation.edit` — the sidebar, which is the product's menu.
 */
export const SUPER_ADMIN_ONLY: ReadonlySet<Capability> = new Set<Capability>([
  "clients.view_all",
  "roles.edit",
  "navigation.edit",
]);

export function isReservedCapability(capability: Capability) {
  return SUPER_ADMIN_ONLY.has(capability);
}

/**
 * Capabilities a role can NEVER hold, on top of the Super Admin reservations.
 *
 * The owner's Manager decision, as a hard ceiling rather than a default: a
 * Manager does operational work and has no user, role, workspace, import,
 * team, audit or billing administration. A default alone would let a Super
 * Admin tick any of these on for `manager` in one workspace, and the decision
 * says a Manager must not have them — so `can()` refuses them whatever a row
 * says, and the matrix refuses to store them.
 *
 * `client` has no ceiling beyond the reservations: the product has always let
 * a Super Admin widen a client per workspace (the Stage 20 tests do exactly
 * that with `users.view`), and nothing in the decision withdrew it. A client
 * still cannot assign any role — that is `canAssignRole`'s table.
 */
const ROLE_CEILINGS: Partial<Record<WorkspaceRole, ReadonlySet<Capability>>> = {
  manager: new Set<Capability>([
    "users.view",
    "users.invite",
    "users.edit",
    "users.deactivate",
    "teams.manage",
    "settings.edit",
    "data.import",
    "audit.read",
    "billing.manage",
  ]),
};

/** True when `role` may never hold `capability`, whatever the matrix says. */
export function isForbiddenForRole(role: WorkspaceRole, capability: Capability) {
  if (role === IMMUTABLE_ROLE) return false;
  return isReservedCapability(capability) || (ROLE_CEILINGS[role]?.has(capability) ?? false);
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
 * `admin` runs the workspaces they are a member of but does not reach across
 * the platform: no `clients.view_all`, no `billing.manage`, and — since the
 * roles-and-access batch — no `roles.edit` and no `navigation.edit`, which are
 * reserved (see `SUPER_ADMIN_ONLY`). `data.delete` is withheld too — archiving
 * is reversible and deletion is not, so the destructive verb starts closed and
 * an owner can open it per workspace rather than everyone having it by default.
 *
 * `manager` does the operational work inside their workspaces — boards, sites,
 * assets, exports — and holds no People or Administration capability at all.
 * The set is deliberately the least that "use the operational product" needs;
 * `data.import`, `teams.manage` and `settings.edit` were each arguable and each
 * left closed, so a Super Admin opens them per workspace if a manager needs
 * them rather than every manager holding them by default.
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
    "audit.read",
    "settings.edit",
    "navigation.personalise",
  ],
  /*
   * `owner` holds everything an Admin holds, in every workspace of their own
   * company. The company-level acts that make an Owner more than an Admin —
   * seeing every company workspace, creating new ones, appointing Admins — are
   * decided by company ownership in `tenant-access.ts` and
   * `lib/client-companies.ts`, not by a capability, because a capability is a
   * per-workspace switch and those acts are not about one workspace.
   * `billing.manage` and `data.delete` stay closed by default, exactly as for
   * an Admin; a Super Admin can open them per workspace.
   */
  owner: [
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
    "audit.read",
    "settings.edit",
    "navigation.personalise",
  ],
  manager: ["board.view", "board.edit", "sites.edit", "data.export", "navigation.personalise"],
  /*
   * `navigation.personalise` for clients too: arranging your OWN sidebar was
   * open to every signed-in person before the roles-and-access batch, it is
   * self-scoped and lock-bound, and the owner's decision keeps an existing safe
   * personal-preference path. A Super Admin can close it per workspace.
   */
  client: ["board.view", "data.export", "navigation.personalise"],
};

const DEFAULT_SETS: Record<WorkspaceRole, ReadonlySet<Capability>> = {
  super_admin: new Set(BUILT_IN_DEFAULTS.super_admin),
  owner: new Set(BUILT_IN_DEFAULTS.owner),
  admin: new Set(BUILT_IN_DEFAULTS.admin),
  manager: new Set(BUILT_IN_DEFAULTS.manager),
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
  return { super_admin: {}, owner: {}, admin: {}, manager: {}, client: {} };
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

  // Reserved or above this role's ceiling, whatever an override row says. A
  // row granting one of these — written before the rule, or by hand — is
  // ignored here, which is what makes the rule a boundary rather than a default.
  if (isForbiddenForRole(actor.role, capability)) return false;

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

  /*
   * A reserved capability cannot be stored against any other role, granted or
   * denied: `can()` refuses it regardless, so a row would be a claim the
   * enforcer ignores. `null` is still accepted — it DELETES a row, which is how
   * a stale grant written before the reservation is cleaned out of the table.
   */
  if (isReservedCapability(capability) && allowed !== null) {
    return `"${capability}" is reserved for Super Admin and cannot be given to any other role.`;
  }
  if (isForbiddenForRole(targetRole, capability) && allowed !== null) {
    return `The ${ROLE_LABELS[targetRole]} role can never hold "${capability}".`;
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

/*
 * `canAssignRole` — whether `actorRole` may hand out `targetRole` — lives in
 * `roles.ts` beside the rank it compares, so the browser's role pickers use the
 * same rule. Re-exported at the top of this file.
 */
