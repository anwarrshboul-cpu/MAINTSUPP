/**
 * Which portal modules exist for an organisation, and who may reach them.
 *
 * WHAT THIS IS FOR
 *
 * The product ships nineteen portal sections. Until now their existence was a
 * constant in two places — `sectionMeta`/`navPrimary`/`navSecondary` in
 * `app/(app)/portal/portal-app.tsx` and `BUILT_IN_ORDER` in
 * `app/api/navigation/layout.ts` — and nothing could switch one off for a
 * workspace that does not use it. Master Specification §19 asks for exactly
 * that, and asks for it to be real: "if a module is disabled it should disappear
 * from navigation; route access must also be blocked appropriately."
 *
 * WHY A TABLE OF ITS OWN RATHER THAN THREE COLUMNS ON `workspace_sections`
 *
 * That was the audit's first recommendation and it is the wrong shape, for five
 * reasons that only became visible on reading the readers:
 *
 *   1. `sectionsToCatalogue` DROPS any row whose key is not `section:`-prefixed
 *      (`app/api/workspace-sections/catalogue.ts`), so seeded built-in rows
 *      would exist and change nothing.
 *   2. `MAX_SECTIONS` is 40 and counts ROWS, not owner-created ones. Seeding
 *      nineteen built-ins would silently eat half of every workspace's budget.
 *   3. `loadWorkspaceSections` is a bare `.select()` with no namespace filter and
 *      feeds both the section manager and the sidebar — built-in rows would show
 *      as phantom "added sections" and draw every module twice.
 *   4. `repairOrphanedSectionBoards` reads that whole table on EVERY boot, on the
 *      warm path. Nineteen rows per organisation, for ever, for nothing.
 *   5. `workspace_sections` carries an archive/recycle-bin lifecycle that does
 *      not apply to a built-in: a module is switched off, not deleted for thirty
 *      days.
 *
 * So the registry is its own per-organisation overlay on the list below. The
 * code still decides which modules EXIST; a row only decides whether this
 * workspace has one switched off, and which capability it answers to.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not replace the authority rules that already exist. `requiredCapability`
 * is an ADDITIONAL gate, and NULL means "whatever decides today keeps deciding".
 *
 * THREE of the nineteen are NULL on purpose — `team`, `invoice-tracker` and
 * `recycle-bin` — because no single capability describes who may reach them; see
 * each one below for why. A fourth, `reconcile`, names the capability its route
 * enforces but only HALF its rule: the route also refuses outside non-production,
 * and a column cannot hold an environment. The audit that preceded this file
 * counted five, folding in `units`, which is not a module at all.
 */

import { ROLE_RANK, type WorkspaceRole } from "./roles.ts";
import type { Capability } from "./permissions.ts";

export type PortalModule = {
  /** The section key the client and `BUILT_IN_ORDER` already use. */
  key: string;
  /** For a message that names the module rather than its key. */
  label: string;
  /**
   * The capability this module answers to, or null when no single capability is
   * faithful. Null is never "no rule" — it is "the existing rule decides".
   */
  requiredCapability: Capability | null;
  /**
   * Whether an administrator may switch it off.
   *
   * Two are permanently on by owner decision and by construction: Overview is
   * the fallback destination in five separate places, and Settings is where the
   * switches themselves live. A workspace that has switched off its own Settings
   * screen is a support call nobody can resolve from inside the product.
   */
  disableable: boolean;
  /** Why, for the administrator, when it cannot be switched off. */
  permanentReason?: string;
};

/**
 * The nineteen, in `BUILT_IN_ORDER`'s order — the same nineteen keys, in the
 * same sequence, as `app/api/navigation/layout.ts`.
 *
 * `tests/portal-module-registry.test.mjs` compares the two lists position by
 * position. Order has no behavioural effect here — the sidebar takes its order
 * from `navPrimary`, and every reader of `availableModules` treats the result as
 * a set — so the pin is not protecting an ordering. It is protecting MEMBERSHIP:
 * a sequence comparison fails when a module is added to one list and forgotten
 * in the other, which a set comparison would also catch but a human skimming two
 * differently-ordered lists would not.
 *
 * `units` is deliberately absent. It is not a module: it is a second route onto
 * the Assets screen, already excluded from the sidebar by `navExcluded` in
 * `portal-app.tsx`, and giving it its own switch would invent a distinction the
 * product does not have — a workspace could disable "Units" and still reach the
 * identical screen at Assets.
 *
 * EVERY CAPABILITY HERE WAS CHOSEN AGAINST `ROLE_CEILINGS`, NOT AGAINST
 * INTUITION. `can()` consults `isForbiddenForRole` BEFORE it reads any override
 * row, and the write side refuses to store such a row at all — so a capability a
 * role may never hold makes the module permanently unreachable for that role and
 * **no Super Admin can give it back**. Three may never appear below under any
 * circumstance: `billing.manage` (barred for manager AND owner), `data.delete`
 * (barred for owner) and `navigation.edit` (reserved to super_admin).
 * `tests/portal-module-registry.test.mjs` asserts that, and asserts the general
 * rule: a ceiling-barred capability may only be named on a module the barred
 * role already cannot reach.
 */
export const PORTAL_MODULES: readonly PortalModule[] = [
  {
    key: "overview",
    label: "Overview",
    requiredCapability: "board.view",
    disableable: false,
    permanentReason:
      "Overview is where the portal lands, and what every unknown route falls back to.",
  },
  { key: "maintenance", label: "Jobs", requiredCapability: "board.view", disableable: true },
  {
    key: "store-documentation",
    label: "Store Documentation",
    requiredCapability: "board.view",
    disableable: true,
  },
  { key: "compliance", label: "Compliance", requiredCapability: "board.view", disableable: true },
  { key: "calendar", label: "Planned", requiredCapability: "board.view", disableable: true },
  { key: "stores", label: "Sites", requiredCapability: "board.view", disableable: true },
  { key: "assets", label: "Assets", requiredCapability: "board.view", disableable: true },
  { key: "contractors", label: "Contractors", requiredCapability: "board.view", disableable: true },
  { key: "documents", label: "Documents", requiredCapability: "board.view", disableable: true },
  {
    key: "invoice-tracker",
    label: "Invoice Tracker",
    /*
     * NULL — the authority is a ROLE RANK, not a capability.
     *
     * `app/lib/finance/access.ts` refuses rank below admin after the capability
     * passes, because every internal role that should read the ledger holds
     * `board.view` and nothing narrower fits. `board.view` here would open the
     * payables ledger to clients and managers; `settings.edit` would bar
     * managers for ever. The rank rule keeps deciding.
     */
    requiredCapability: null,
    disableable: true,
  },
  { key: "reports", label: "Reports", requiredCapability: "board.view", disableable: true },
  {
    key: "settings",
    label: "Settings",
    /*
     * `board.view`, NOT `settings.edit` — and this is the single line this phase
     * was most likely to get wrong.
     *
     * The Settings entry is open to every role today (the capability chain falls
     * through to `return true`) and `GET /api/workspace` reads at `board.view`.
     * `settings.edit` is in `manager`'s ceiling, so naming it here would remove
     * the Settings screen from every Manager for ever, with no way back. The
     * WRITES on that screen are already `settings.edit` where they should be;
     * reading it is not a write.
     */
    requiredCapability: "board.view",
    disableable: false,
    permanentReason:
      "Settings is where these switches live. Disabling it would remove the only way to re-enable anything.",
  },
  {
    key: "team",
    label: "Team",
    /*
     * NULL — no capability governs this module.
     *
     * `GET /api/teams` is deliberately open: a client is meant to see who
     * maintains their sites. `teams.manage` only redacts the `people` list
     * inside the payload. Naming `teams.manage` here would take the rota from
     * every client AND permanently from every manager, which that route's own
     * comment warns about in as many words.
     */
    requiredCapability: null,
    disableable: true,
  },
  { key: "admin-users", label: "Users & Access", requiredCapability: "users.view", disableable: true },
  { key: "admin-roles", label: "Roles", requiredCapability: "roles.edit", disableable: true },
  {
    key: "admin-clients",
    label: "Clients",
    requiredCapability: "clients.view_all",
    disableable: true,
  },
  { key: "audit", label: "Audit", requiredCapability: "audit.read", disableable: true },
  {
    key: "reconcile",
    label: "Reconcile",
    /*
     * `settings.edit` matches the route, but the route ALSO refuses outside
     * non-production. A column cannot hold the environment half, so the route
     * keeps its own check — this is the additional gate, not the whole one.
     */
    requiredCapability: "settings.edit",
    disableable: true,
  },
  {
    key: "recycle-bin",
    label: "Recycle Bin",
    /*
     * NULL — the navigation and the route disagree ON PURPOSE.
     *
     * The sidebar entry is offered on `board.edit`, because it is listed for
     * whoever can restore; `GET /api/trash` answers at `board.view` and tells a
     * client `canRestore: false`. `board.edit` here would revoke a read the
     * product deliberately allows, and `board.view` would add a nav entry the
     * product deliberately withholds. Neither is faithful, so the existing pair
     * of rules stands.
     */
    requiredCapability: null,
    disableable: true,
  },
] as const;

export const PORTAL_MODULE_KEYS: readonly string[] = PORTAL_MODULES.map((m) => m.key);

/**
 * SECTION KEYS THAT ARE A SECOND DOOR ONTO ANOTHER MODULE'S SCREEN.
 *
 * `units` is not a module — the note on `PORTAL_MODULES` explains why giving it
 * its own switch would invent a distinction the product does not have. What that
 * note got WRONG is the direction of the risk. It reasoned that a workspace must
 * not be able to switch off Units and still reach Assets. The actual exposure is
 * the mirror image: `/dashboard/units` renders the Assets screen
 * (`activeSurface === "assets" || activeSurface === "units"` in
 * `portal-app.tsx`), so switching ASSETS off and leaving `units` ungoverned
 * leaves the whole register open at a second URL.
 *
 * Omitting it from the catalogue is still right. Treating it as ungoverned was
 * not. So a key here answers to the module it draws, which is exactly the rule
 * the account `trash` panel and `/dashboard/teams` already follow.
 */
export const MODULE_ALIASES: Readonly<Record<string, string>> = {
  units: "assets",
};

/**
 * Which module governs a section key, or null when none does.
 *
 * Follows `MODULE_ALIASES`, so a second door answers to the room. Returns null
 * for a key the registry has no opinion about — a `section:` key, an account
 * panel — because silence is not denial anywhere else in this system either.
 */
export function governingModule(sectionKey: string): string | null {
  const key = MODULE_ALIASES[sectionKey] ?? sectionKey;
  return portalModule(key) ? key : null;
}

export function portalModule(key: string): PortalModule | null {
  return PORTAL_MODULES.find((module) => module.key === key) ?? null;
}

/** Whether an administrator may switch this module off at all. */
export function isDisableableModule(key: string): boolean {
  return portalModule(key)?.disableable === true;
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

/** `module key -> enabled`. Only the modules an organisation has an opinion on. */
export type ModuleOverrides = Readonly<Record<string, boolean>>;

export type ModuleAccess = {
  /** Switched on for this workspace. */
  enabled: boolean;
  /** This actor clears the module's capability, where it has one. */
  permitted: boolean;
  /** Both. What the sidebar should draw and the route should admit. */
  available: boolean;
};

/**
 * Whether one module is on for this workspace and reachable by this actor.
 *
 * A module with no row is ENABLED. The absence of a row is the shipped state,
 * exactly as it is for `role_capabilities` and `theme_tokens` — an empty table
 * is a working system, and a workspace that has never opened the editor behaves
 * as the product ships.
 *
 * `invoice-tracker` carries its rank rule here as well as in
 * `lib/finance/access.ts`, because the sidebar has always applied it too and
 * dropping it would start advertising the payables ledger to every manager. It
 * is restated rather than imported to keep this module free of a dependency on
 * the finance layer; `tests/portal-module-registry.test.mjs` pins the two
 * together so they cannot drift.
 */
export function resolveModuleAccess(
  key: string,
  overrides: ModuleOverrides,
  capabilities: Readonly<Record<string, boolean>>,
  role: WorkspaceRole,
): ModuleAccess {
  /* `definition`, not `module` — `@next/next/no-assign-module-variable` refuses
     the obvious name across this codebase, and shadowing CommonJS's `module` is
     worth refusing. The same rename is in `page-guard.ts` and
     `app/api/portal-modules/route.ts` for the same reason. */
  /* Aliases are resolved by the CALLER, through `governingModule`. Doing it here
     instead would make `availableModules` list `units` as a module, which is the
     one thing the catalogue's omission is for. */
  const definition = portalModule(key);
  if (!definition) return { enabled: false, permitted: false, available: false };

  const enabled = definition.disableable ? overrides[key] !== false : true;

  let permitted = true;
  if (definition.requiredCapability) {
    permitted = capabilities[definition.requiredCapability] === true;
  }
  if (key === "invoice-tracker") {
    permitted = ROLE_RANK[role] >= ROLE_RANK.admin;
  }

  return { enabled, permitted, available: enabled && permitted };
}

/** Every module this actor may see, in shipped order. */
export function availableModules(
  overrides: ModuleOverrides,
  capabilities: Readonly<Record<string, boolean>>,
  role: WorkspaceRole,
): string[] {
  return PORTAL_MODULES.filter(
    (module) => resolveModuleAccess(module.key, overrides, capabilities, role).available,
  ).map((module) => module.key);
}
