/**
 * Phase 2 — the portal module registry (Master Specification §19).
 *
 * WHAT THIS FILE IS ACTUALLY GUARDING
 *
 * A per-organisation switch that removes a module from the navigation AND stops
 * its route answering. The navigation half is easy to get right and easy to
 * verify. The other two halves are not, and they are what most of this file is
 * about:
 *
 *   1. AN IRRECOVERABLE PERMISSION LOCKOUT. Every module names the capability it
 *      answers to. `app/lib/permissions.ts` defines `ROLE_CEILINGS` —
 *      capabilities a role may NEVER hold — and `can()` consults
 *      `isForbiddenForRole` BEFORE it reads any override row, while the write
 *      side refuses to store such a row at all. So naming a ceiling-barred
 *      capability on a module makes that module permanently unreachable for that
 *      role, and **no Super Admin can give it back through the product**. The
 *      recovery is a code change and a deploy. The tests from
 *      "the registry may never name a capability..." onward exist for that one
 *      failure, and they are the reason this file is longer than the feature.
 *
 *   2. A GATE THAT IS ONLY A CURTAIN. Hiding a sidebar item is not
 *      authorisation. FOUR route entries have to enforce the same answer the
 *      sidebar draws, and only one of them is the obvious one. The catch-all
 *      serves eighteen of the nineteen modules; `/dashboard/teams` is a static
 *      segment that wins over it; `/admin/reconcile` forwards into it; and
 *      `/dashboard/account/trash` renders the SAME component as the Recycle Bin
 *      module behind a second URL. Those four pins are the difference between
 *      §19 and a cosmetic filter.
 *
 * WHY THE PERMISSION RULES ARE PARSED OUT OF SOURCE RATHER THAN IMPORTED
 *
 * `app/lib/permissions.ts` imports `../../db/schema` without a file extension,
 * which Node's ESM resolver cannot follow, so `node --test` cannot import it.
 * `ROLE_CEILINGS`, `SUPER_ADMIN_ONLY` and `BUILT_IN_DEFAULTS` are therefore read
 * out of the file's text and `can()` is re-derived below.
 *
 * That is not a workaround with a hidden cost — it is the stronger test. An
 * imported `can()` would make the ceiling assertions tautological: they would
 * pass because both sides call the same function. Re-deriving the rule means the
 * assertion fails if `permissions.ts` changes what a role may hold, which is
 * exactly the change that could silently lock a role out of a module.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PORTAL_MODULES,
  PORTAL_MODULE_KEYS,
  MODULE_ALIASES,
  availableModules,
  governingModule,
  isDisableableModule,
  portalModule,
  resolveModuleAccess,
} from "../app/lib/portal-modules.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const ROLES = ["client", "manager", "admin", "owner", "super_admin"];

/** Comments removed, so a key named in prose is not mistaken for a member. */
const decommented = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "");

/** The `key: "…"` sequence inside one array literal, in order. */
function keysOf(source, marker, terminator) {
  const start = source.indexOf(marker);
  assert.ok(start > 0, `could not find ${marker}`);
  const end = source.indexOf(terminator, start);
  assert.ok(end > start, `could not find the end of ${marker}`);
  return [...decommented(source.slice(start, end)).matchAll(/key:\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
}

/* ------------------------------------------------------------------ */
/* The permission model, re-derived from `permissions.ts`              */
/* ------------------------------------------------------------------ */

/** Every `"capability"` string inside the named `new Set<Capability>([…])`. */
function setMembers(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start > 0, `could not find ${marker}`);
  const open = source.indexOf("[", start);
  const close = source.indexOf("]", open);
  return [...decommented(source.slice(open, close)).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

async function permissionModel() {
  const source = await read("app/lib/permissions.ts");

  /* Sliced from the DECLARATION, not from the first mention of the name — the
     header prose names `SUPER_ADMIN_ONLY` a hundred lines above the catalogue,
     and slicing on that produced an empty list that read as "no capabilities
     exist" rather than as a broken test. */
  const capabilities = [
    ...decommented(
      source.slice(
        source.indexOf("export const CAPABILITY_CATALOGUE = ["),
        source.indexOf("export const SUPER_ADMIN_ONLY"),
      ),
    ).matchAll(/key:\s*"([^"]+)"/g),
  ].map((m) => m[1]);
  assert.ok(
    capabilities.length >= 18,
    `the capability catalogue should have been found; got ${capabilities.length}`,
  );

  const reserved = new Set(
    setMembers(source, "export const SUPER_ADMIN_ONLY: ReadonlySet<Capability>"),
  );
  assert.ok(reserved.has("navigation.edit"), "the reservations should have been found");

  /* `ROLE_CEILINGS` is an object of sets, so each role's block is sliced out by
     name rather than by one regex over the whole literal. */
  const ceilingsBlock = source.slice(
    source.indexOf("const ROLE_CEILINGS"),
    source.indexOf("/** True when `role` may never hold"),
  );
  const ceilings = {};
  for (const match of decommented(ceilingsBlock).matchAll(
    /(\w+):\s*new Set<Capability>\(\[([\s\S]*?)\]\)/g,
  )) {
    ceilings[match[1]] = new Set([...match[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  }
  assert.ok(ceilings.manager, "the manager ceiling should have been found");
  assert.ok(ceilings.owner, "the owner ceiling should have been found");

  const defaultsBlock = decommented(
    source.slice(
      source.indexOf("const BUILT_IN_DEFAULTS"),
      source.indexOf("const DEFAULT_SETS"),
    ),
  );
  const defaults = {};
  for (const role of ROLES) {
    if (role === "super_admin") continue;
    const at = defaultsBlock.indexOf(`${role}: [`);
    assert.ok(at > 0, `the ${role} defaults should have been found`);
    const close = defaultsBlock.indexOf("]", at);
    defaults[role] = new Set(
      [...defaultsBlock.slice(at, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    );
  }
  assert.match(
    defaultsBlock,
    /super_admin: CAPABILITIES,/,
    "super_admin's defaults are the whole catalogue; the derivation below assumes it",
  );
  defaults.super_admin = new Set(capabilities);

  /** `isForbiddenForRole`, re-derived. The super-admin exemption is in `can()`. */
  const forbidden = (role, capability) =>
    role !== "super_admin" &&
    (reserved.has(capability) || (ceilings[role]?.has(capability) ?? false));

  /** `can()` with no override rows — the shipped answer. */
  const allows = (role, capability) => {
    if (role === "super_admin") return true;
    if (forbidden(role, capability)) return false;
    return defaults[role].has(capability);
  };

  const effective = (role) =>
    Object.fromEntries(capabilities.map((capability) => [capability, allows(role, capability)]));

  return { capabilities, reserved, ceilings, defaults, forbidden, allows, effective };
}

/* ------------------------------------------------------------------ */
/* The catalogue                                                       */
/* ------------------------------------------------------------------ */

test("the registry lists exactly the navigation's built-in modules, in its order", async () => {
  /*
   * `BUILT_IN_ORDER` in `app/api/navigation/layout.ts` is what
   * `GET /api/navigation` answers with when there is no browser to ask, so it is
   * the existing statement of which modules the product has. The registry must
   * not be a second, quietly divergent list.
   *
   * Compared as a SEQUENCE, not as a set — see the note on `PORTAL_MODULES`. The
   * order has no behaviour attached to it; comparing it catches a module added to
   * one list and forgotten in the other, which is the mistake this pin is for.
   */
  const layout = await read("app/api/navigation/layout.ts");
  const builtIn = keysOf(layout, "BUILT_IN_ORDER: ReadonlyArray", "];");

  assert.deepStrictEqual(
    [...PORTAL_MODULE_KEYS],
    builtIn,
    "PORTAL_MODULES and BUILT_IN_ORDER must hold the same keys in the same order",
  );
  assert.equal(PORTAL_MODULE_KEYS.length, 19);
  assert.equal(
    new Set(PORTAL_MODULE_KEYS).size,
    PORTAL_MODULE_KEYS.length,
    "a duplicate key would give one module two rows and two switches",
  );
});

test("`units` is deliberately not a module", async () => {
  /*
   * It is a second route onto the Assets screen, already kept out of the sidebar
   * by `navExcluded` in `portal-app.tsx`. A switch of its own would invent a
   * distinction the product does not have: a workspace could switch off "Units"
   * and still reach the identical screen at Assets, which is worse than having no
   * switch at all.
   */
  assert.equal(portalModule("units"), null);

  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(
    portal,
    /const navExcluded: ReadonlySet<string> = new Set<string>\(\["units"\]\);/,
    "units must still be excluded from the sidebar by navExcluded, which is the " +
      "rule the registry is deferring to here",
  );
});

test("every capability a module names is a real capability", async () => {
  const { capabilities } = await permissionModel();
  for (const definition of PORTAL_MODULES) {
    if (definition.requiredCapability === null) continue;
    assert.ok(
      capabilities.includes(definition.requiredCapability),
      `${definition.key} names ${definition.requiredCapability}, which is not in CAPABILITIES`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* The irrecoverable lockout                                           */
/* ------------------------------------------------------------------ */

test("the registry may never name a capability a role can never hold back", async () => {
  /*
   * THE GENERAL RULE, and the one that has to hold for capabilities nobody has
   * thought about yet:
   *
   *   a module may name a ceiling-barred capability ONLY where the barred role
   *   already has no access to that module.
   *
   * "Already" is the table in the next test, transcribed from the rules that
   * shipped before this branch. Here the weaker, unconditional half: for every
   * module and every role, if the role is barred from the module's capability by
   * a ceiling or a reservation, then the role must not have been reaching that
   * module today either — otherwise this branch takes something away that cannot
   * be given back.
   */
  const { forbidden } = await permissionModel();
  const reachableToday = await todaysAudience();

  for (const definition of PORTAL_MODULES) {
    if (definition.requiredCapability === null) continue;
    for (const role of ROLES) {
      if (!forbidden(role, definition.requiredCapability)) continue;
      assert.ok(
        !reachableToday[definition.key].includes(role),
        `${definition.key} names ${definition.requiredCapability}, which ${role} may NEVER ` +
          `hold — and ${role} can reach ${definition.key} today. can() checks the ` +
          "ceiling before any override and the write side refuses to store one, " +
          "so this would be a lockout no Super Admin could undo. Use the " +
          "capability the module's own route already enforces, or null.",
      );
    }
  }
});

test("three capabilities are never named on any module, whatever the reason", async () => {
  /*
   * The general rule above is the one that matters, but these three are worth
   * refusing by name because each has bitten somebody's design already and the
   * consequence is silent:
   *
   *   `billing.manage`   barred for manager AND owner — no remedy for either.
   *   `data.delete`      barred for owner. An Owner can open the Recycle Bin
   *                      today; naming it would end that permanently.
   *   `navigation.edit`  reserved to super_admin, so naming it on any module
   *                      hides that module from Admin and Owner for ever.
   */
  const never = ["billing.manage", "data.delete", "navigation.edit"];
  for (const definition of PORTAL_MODULES) {
    assert.ok(
      !never.includes(definition.requiredCapability),
      `${definition.key} must not require ${definition.requiredCapability}`,
    );
  }

  /* And the migration must not seed one either — a row cannot set the capability
     at all, which is the structural version of this rule. */
  const init = await read("db/init.ts");
  const stage = init.slice(
    init.indexOf("async function ensurePortalModuleSettings"),
    init.indexOf("async function ensurePortalModuleSettings") + 3000,
  );
  for (const capability of never) {
    assert.ok(
      !stage.includes(capability),
      `the migration must never seed ${capability} into required_capability`,
    );
  }
});

/**
 * Who can reach each module TODAY — that is, under the rules that shipped before
 * this branch, with no registry involved.
 *
 * Transcribed by hand from the rule that decides each one, and the rule is named
 * for every entry. This is the reference the "must not narrow" tests compare
 * against, so a derivation from `PORTAL_MODULES` would make them vacuous.
 */
async function todaysAudience() {
  const { allows } = await permissionModel();
  const rolesWhere = (predicate) => ROLES.filter(predicate);
  const withCapability = (capability) => rolesWhere((role) => allows(role, capability));
  const RANK = { client: 0, manager: 1, admin: 2, owner: 3, super_admin: 4 };

  return {
    /* The eleven operational screens. The sidebar's capability chain falls
       through to `return true` for all of these, and each screen's own API reads
       at `board.view` — which every role holds by default. */
    overview: withCapability("board.view"),
    maintenance: withCapability("board.view"),
    "store-documentation": withCapability("board.view"),
    compliance: withCapability("board.view"),
    calendar: withCapability("board.view"),
    stores: withCapability("board.view"),
    assets: withCapability("board.view"),
    contractors: withCapability("board.view"),
    documents: withCapability("board.view"),
    reports: withCapability("board.view"),
    /* Settings: the nav chain does NOT gate it — it reaches `return true` — and
       `GET /api/workspace` reads at `board.view`. The WRITES on that screen are
       `settings.edit`; reading it is not a write. */
    settings: withCapability("board.view"),
    /* Team: `GET /api/teams` is deliberately open, and `teams.manage` only
       redacts the `people` list inside the payload. No capability governs it. */
    team: [...ROLES],
    /* Invoice tracker: `app/lib/finance/access.ts` refuses rank below admin. */
    "invoice-tracker": rolesWhere((role) => RANK[role] >= RANK.admin),
    "admin-users": withCapability("users.view"),
    "admin-roles": withCapability("roles.edit"),
    "admin-clients": withCapability("clients.view_all"),
    audit: withCapability("audit.read"),
    reconcile: withCapability("settings.edit"),
    /* Recycle Bin: the nav entry is offered on `board.edit` and `GET /api/trash`
       answers at `board.view`, telling a client `canRestore: false`. The two
       disagree on purpose, so the module names no capability and both rules keep
       deciding — which means everyone who could read it still can. */
    "recycle-bin": [...ROLES],
  };
}

test("the registry does not narrow any role's reach", async () => {
  /*
   * The whole point of the phase is a switch an administrator MOVES. It is not a
   * permission change, and a permission change smuggled in beside it would be
   * invisible: nobody looks at a module registry to find out why a Manager lost
   * the Settings screen.
   *
   * So: with no switches thrown, the set of roles the registry permits must equal
   * the set the pre-existing rule already permitted, module by module.
   */
  const { effective } = await permissionModel();
  const today = await todaysAudience();
  const capabilitiesFor = Object.fromEntries(ROLES.map((role) => [role, effective(role)]));

  for (const definition of PORTAL_MODULES) {
    const permitted = ROLES.filter(
      (role) => resolveModuleAccess(definition.key, {}, capabilitiesFor[role], role).permitted,
    );
    assert.deepStrictEqual(
      permitted,
      today[definition.key],
      `${definition.key}: the registry permits [${permitted}] but the rules that ` +
        `shipped before this branch permit [${today[definition.key]}]`,
    );
  }
});

test("a Manager keeps the Settings screen — the trap this phase was warned about", async () => {
  /*
   * Named on its own rather than left to the table above, because it is the one
   * line this phase was most likely to get wrong and the consequence is
   * permanent.
   *
   * `settings.edit` is in `manager`'s ceiling. The obvious reading of "the
   * Settings module" is that it requires `settings.edit`, and that single choice
   * would remove the Settings screen from every Manager in every workspace, for
   * ever, with no way back through the product.
   */
  const settings = portalModule("settings");
  assert.equal(
    settings.requiredCapability,
    "board.view",
    "Settings must answer to board.view, NOT settings.edit — settings.edit is in " +
      "manager's ROLE_CEILINGS, so naming it here removes the Settings screen " +
      "from every Manager permanently",
  );

  const { ceilings, effective } = await permissionModel();
  assert.ok(
    ceilings.manager.has("settings.edit"),
    "this test is only meaningful while settings.edit is barred for manager; if " +
      "that changed, re-read the reasoning rather than deleting the assertion",
  );
  assert.equal(
    resolveModuleAccess("settings", {}, effective("manager"), "manager").permitted,
    true,
  );
});

/* ------------------------------------------------------------------ */
/* Permanence, and the four modules no capability describes            */
/* ------------------------------------------------------------------ */

test("only Overview and Settings are permanent, and each says why", () => {
  const permanent = PORTAL_MODULES.filter((module) => !module.disableable).map((m) => m.key);
  assert.deepStrictEqual(permanent, ["overview", "settings"]);

  for (const key of permanent) {
    assert.ok(
      (portalModule(key).permanentReason ?? "").length > 20,
      `${key} cannot be switched off, so the screen has to say why — the panel ` +
        "shows this sentence rather than inventing one",
    );
    assert.equal(isDisableableModule(key), false);
  }
  for (const definition of PORTAL_MODULES) {
    if (!definition.disableable) continue;
    assert.equal(
      definition.permanentReason,
      undefined,
      `${definition.key} can be switched off, so it must not carry a reason it cannot`,
    );
  }
});

test("Overview is permanent because the product falls back to it", async () => {
  /*
   * Not a matter of taste. Overview is what an unknown route resolves to, what an
   * unresolvable section key resolves to, and where `requireModuleAccess` sends a
   * request for a module that is off. A switch that could remove it would turn
   * every one of those fallbacks into a loop or a blank screen.
   */
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const page = await read("app/(app)/dashboard/[[...section]]/page.tsx");
  const guard = await read("app/lib/page-guard.ts");

  assert.ok(
    (portal.match(/"overview"/g) ?? []).length >= 3,
    "portal-app.tsx falls back to overview in several places",
  );
  assert.match(page, /"overview"/, "the catch-all resolves an unknown slug to overview");
  assert.match(
    guard,
    /MODULE_FALLBACK_PATH = "\/dashboard"/,
    "the guard's fallback is the dashboard root, which renders overview",
  );
});

test("three modules name no capability, and each records why in the source", () => {
  /*
   * A null here is never "no rule" — it is "the rule that already exists keeps
   * deciding". Four of the nineteen cannot be expressed as one capability, and in
   * each case the wrong single value would either over-grant or produce the
   * irrecoverable lockout above. The reason has to be written where the null is,
   * because the null on its own looks like an omission.
   */
  const unspecified = PORTAL_MODULES.filter((m) => m.requiredCapability === null).map(
    (m) => m.key,
  );
  /* Catalogue order — invoice-tracker sits between Documents and Reports, where
     BUILT_IN_ORDER puts it. */
  assert.deepStrictEqual(unspecified, ["invoice-tracker", "team", "recycle-bin"]);
});

test("the three reasons are written down beside the nulls", async () => {
  const source = await read("app/lib/portal-modules.ts");
  for (const [key, needle] of [
    ["team", /`teams\.manage` only redacts the `people` list/],
    ["invoice-tracker", /the authority is a ROLE RANK, not a capability/],
    ["recycle-bin", /the navigation and the route disagree ON PURPOSE/],
  ]) {
    assert.match(
      source,
      needle,
      `the reason ${key} names no capability must stay in the source — a bare ` +
        "null reads as an oversight and invites somebody to fill it in",
    );
  }
});

test("the invoice tracker's rank rule matches the finance layer it restates", async () => {
  /*
   * `resolveModuleAccess` restates the rank rule rather than importing
   * `lib/finance/access.ts`, to keep this module free of a dependency on the
   * finance layer. Restating it means the two can drift, so they are pinned
   * together here.
   */
  const access = await read("app/lib/finance/access.ts");
  assert.match(
    access,
    /ROLE_RANK\[guard\.scope\.actor\.role\] < ROLE_RANK\.admin/,
    "the finance layer must still refuse rank below admin",
  );
  const modules = await read("app/lib/portal-modules.ts");
  assert.match(
    modules,
    /ROLE_RANK\[role\] >= ROLE_RANK\.admin/,
    "and the registry must still apply the same rank rule",
  );

  const open = { "board.view": true };
  assert.equal(resolveModuleAccess("invoice-tracker", {}, open, "manager").permitted, false);
  assert.equal(resolveModuleAccess("invoice-tracker", {}, open, "client").permitted, false);
  assert.equal(resolveModuleAccess("invoice-tracker", {}, open, "admin").permitted, true);
  assert.equal(resolveModuleAccess("invoice-tracker", {}, open, "owner").permitted, true);
});

/* ------------------------------------------------------------------ */
/* Resolution semantics                                                */
/* ------------------------------------------------------------------ */

test("no row means enabled, which is what makes an empty table the shipped product", () => {
  const open = { "board.view": true };
  for (const definition of PORTAL_MODULES) {
    assert.equal(
      resolveModuleAccess(definition.key, {}, open, "super_admin").enabled,
      true,
      `${definition.key} must be enabled when this workspace has no opinion`,
    );
  }
});

test("only `false` disables, and only where the module may be disabled", () => {
  const open = { "board.view": true };

  assert.equal(resolveModuleAccess("reports", { reports: false }, open, "admin").enabled, false);
  assert.equal(resolveModuleAccess("reports", { reports: true }, open, "admin").enabled, true);

  /* A stored row against a permanent module is INERT rather than obeyed. The API
     refuses to write one and so does the repository, but if one arrives by hand
     the resolver must not honour it — that is the state nobody could recover
     from inside the product. */
  assert.equal(
    resolveModuleAccess("overview", { overview: false }, open, "admin").enabled,
    true,
    "a hand-written row must not be able to switch off Overview",
  );
  assert.equal(
    resolveModuleAccess("settings", { settings: false }, open, "admin").enabled,
    true,
    "nor Settings — that is the row that removes the only way back",
  );
});

test("an unknown key resolves to unavailable rather than throwing", () => {
  assert.deepStrictEqual(resolveModuleAccess("not-a-module", {}, {}, "super_admin"), {
    enabled: false,
    permitted: false,
    available: false,
  });
});

test("`available` is both halves, and a switch beats a capability", () => {
  const open = { "board.view": true };
  const off = resolveModuleAccess("reports", { reports: false }, open, "super_admin");
  assert.deepStrictEqual(off, { enabled: false, permitted: true, available: false });

  const barred = resolveModuleAccess("audit", {}, { "audit.read": false }, "client");
  assert.deepStrictEqual(barred, { enabled: true, permitted: false, available: false });
});

test("availableModules keeps the catalogue's order and drops only what is off", () => {
  const open = Object.fromEntries(
    ["board.view", "users.view", "roles.edit", "clients.view_all", "audit.read", "settings.edit"].map(
      (c) => [c, true],
    ),
  );
  const all = availableModules({}, open, "super_admin");
  assert.deepStrictEqual(all, [...PORTAL_MODULE_KEYS]);

  const some = availableModules({ reports: false, audit: false }, open, "super_admin");
  assert.deepStrictEqual(
    some,
    PORTAL_MODULE_KEYS.filter((key) => key !== "reports" && key !== "audit"),
  );
});

/* ------------------------------------------------------------------ */
/* The migration and the two dialects                                  */
/* ------------------------------------------------------------------ */

test("the migration creates the table and its unique index, and seeds nothing", async () => {
  const init = await read("db/init.ts");
  assert.match(init, /CREATE TABLE IF NOT EXISTS portal_module_settings/);
  assert.match(
    init,
    /CREATE UNIQUE INDEX IF NOT EXISTS portal_module_settings_key_idx ON portal_module_settings\(organisation_id, module_key\)/,
    "one row per module per organisation, enforced by the database rather than by " +
      "the writer's care",
  );
  assert.match(init, /await ensurePortalModuleSettings\(d1\);/);

  /*
   * NO SEED, and that is the design rather than an omission. The absence of a row
   * means enabled, so nineteen seeded rows per organisation would be nineteen
   * rows that say what their absence already said — and the one thing they could
   * add is a stored `required_capability`, which is exactly the irrecoverable
   * lockout the tests above are about.
   */
  const stage = init.slice(
    init.indexOf("async function ensurePortalModuleSettings"),
    init.indexOf("async function ensurePortalModuleSettings") + 4000,
  );
  assert.ok(
    !/INSERT\s+(OR\s+IGNORE\s+)?INTO\s+portal_module_settings/i.test(stage),
    "the migration must not seed portal_module_settings — absence of a row IS " +
      "enabled, and a seeded row could carry a capability nobody can withdraw",
  );
});

test("`enabled` stays a plain integer on both dialects", async () => {
  /*
   * THE `BOOLEAN_COLUMNS` TRAP, and the reason this column is NOT declared as a
   * boolean.
   *
   * `db/sqlite-to-postgres.ts` rewrites SQLite `0/1` into Postgres booleans for
   * the columns named in `BOOLEAN_COLUMNS`, and it matches by BARE COLUMN NAME
   * across the whole schema. `board_automations.enabled` is `TEXT NOT NULL
   * DEFAULT 'on'`, so the name `enabled` cannot be added to that list without
   * breaking it — and `tests/node-pg-d1.test.mjs` asserts exactly that no
   * non-boolean column shares a name with a boolean one.
   *
   * Keeping this column an integer on both sides means there is nothing to
   * translate: 0 and 1 are the values in SQLite and in Postgres alike.
   */
  const shim = await read("db/sqlite-to-postgres.ts");
  const list = shim.slice(shim.indexOf("BOOLEAN_COLUMNS"), shim.indexOf("]", shim.indexOf("BOOLEAN_COLUMNS")) + 1);
  assert.ok(
    !/"enabled"|'enabled'/.test(list),
    "`enabled` must never be in BOOLEAN_COLUMNS: the list matches by bare column " +
      "name and board_automations.enabled is TEXT DEFAULT 'on'",
  );

  const init = await read("db/init.ts");
  assert.match(
    init,
    /enabled INTEGER NOT NULL DEFAULT 1/,
    "the column is an integer in the DDL",
  );
  const schema = await read("db/schema.ts");
  const table = schema.slice(schema.indexOf("export const portalModuleSettings"));
  assert.match(
    table.slice(0, 1200),
    /enabled: integer\("enabled"\)\.notNull\(\)\.default\(1\)/,
    "and a plain integer in drizzle — NOT { mode: \"boolean\" }, which would ask " +
      "the shim to translate a column it must not translate",
  );
});

test("the repository holds no cache, and enabling deletes the row", async () => {
  /*
   * Phase 1 shipped a thirty-second per-isolate cache in `theme-repository.ts`
   * and authenticated QA against the deployed Preview proved it wrong: a value
   * was changed, the database showed the new state, and the API kept answering
   * with the old one, because the write invalidated the cache on one serverless
   * instance while the read landed on another. There is no cross-instance channel
   * in this product.
   *
   * It matters more here than it did for a colour: a stale answer decides whether
   * a module is reachable, so an administrator would switch one off, watch it stay
   * open, and reasonably conclude the switch does nothing.
   */
  const repository = await read("app/lib/portal-module-repository.ts");
  assert.ok(
    !/setTimeout|Date\.now\(\)\s*[-<>]|CACHE_MS|cache\s*=/.test(repository),
    "portal-module-repository.ts must not cache — see the Phase 1 incident in its header",
  );
  assert.match(
    repository,
    /\.delete\(portalModuleSettings\)/,
    "enabling deletes the row rather than writing 1: the absence of a row IS " +
      "enabled, so a workspace that switches a module back on returns to the " +
      "shipped state instead of pinning itself to today's value",
  );
  assert.match(
    repository,
    /return \{\};/,
    "a failed read must answer with the shipped product — everything on — rather " +
      "than locking every member out of every module at the worst moment",
  );
});

/* ------------------------------------------------------------------ */
/* Enforcement: the half that is not a curtain                         */
/* ------------------------------------------------------------------ */

test("the resolved set is published once, by the server, for both halves", async () => {
  /*
   * One answer, consumed by the sidebar and by the guard, so a control the
   * browser hides and a route that refuses cannot disagree. `/api/context`'s own
   * comment already claims that property for `capabilities`; this is the same
   * rule applied to modules.
   */
  const context = await read("app/api/context/route.ts");
  assert.match(context, /modules: availableModules\(/);
  assert.match(context, /readModuleOverrides\(context\.db, context\.orgId\)/);
});

test("all four route entries enforce the registry server-side", async () => {
  /*
   * §19 asks for route access to be blocked, and a sidebar filter is not that. The
   * catch-all serves eighteen of the nineteen modules; the other three entries are
   * each a SECOND door onto a module that the catch-all never sees.
   */
  const entries = [
    [
      "app/(app)/dashboard/[[...section]]/page.tsx",
      /await requireModuleAccess\(\s*initialSection,/,
      "the catch-all, which serves every built-in section except team",
    ],
    [
      "app/(app)/dashboard/teams/page.tsx",
      /await requireModuleAccess\("team", "\/dashboard\/teams"\);/,
      "a static segment that wins over the catch-all, so it never passes that guard",
    ],
    [
      "app/(app)/admin/reconcile/page.tsx",
      /await requireModuleAccess\("reconcile", "\/dashboard\/reconcile"\);/,
      "checked before the forward, so a workspace without Reconcile is not sent to " +
        "a URL whose only job is to bounce it back",
    ],
    [
      "app/(app)/dashboard/account/[[...panel]]/page.tsx",
      /requireModuleAccess\("recycle-bin", "\/dashboard\/account\/trash"\)/,
      "the account trash panel renders the SAME AccountTrashPanel as the " +
        "recycle-bin section; gating the section alone would be cosmetic",
    ],
  ];

  for (const [file, pattern, why] of entries) {
    const source = await read(file);
    assert.match(source, pattern, `${file} must enforce the registry — ${why}`);
    assert.match(
      source,
      /requirePageSession\(/,
      `${file} must still establish the session first — the module guard assumes it`,
    );
  }
});

test("the guard fails open, and never redirects a page to itself", async () => {
  const guard = await read("app/lib/page-guard.ts");
  const block = guard.slice(guard.indexOf("export async function requireModuleAccess"));

  assert.match(
    block,
    /} catch \{[\s\S]*?return;/,
    "a database hiccup must not close a door the workspace has open: the request " +
      "already passed requirePageSession and every API behind the page enforces " +
      "its own capabilities regardless",
  );
  assert.match(
    block,
    /if \(pathname === MODULE_FALLBACK_PATH\) return;/,
    "nothing can reach this today — the fallback is /dashboard and overview " +
      "cannot be switched off — but the cost of being wrong is a redirect loop " +
      "the browser has to stop, and one comparison is cheaper",
  );
  assert.match(
    block,
    /if \(!available\) redirect\(MODULE_FALLBACK_PATH\);/,
    "a disabled module redirects rather than 404ing: the product's existing " +
      "answer for a section it cannot draw is Overview, and notFound() would " +
      "also disclose that the section exists but is off",
  );
});

test("the sidebar composes the registry with the capability chain, not over it", async () => {
  /*
   * Every capability rule in `navCatalogue` had a reason and several are pinned as
   * source text by other test files. The registry is an extra predicate in front
   * of them that can only ever REMOVE an entry, so no existing rule can be
   * widened by accident and no existing pin has to be re-pointed.
   */
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /if \(moduleAvailable && !moduleAvailable\(entry\.key\)\) return false;/);

  /* Still there, all of them. */
  for (const rule of [
    /entry\.key === "recycle-bin"[\s\S]*?capabilities\?\.\["board\.edit"\] === true/,
    /entry\.key === "admin-users"[\s\S]*?capabilities\?\.\["users\.view"\] === true/,
    /entry\.key === "admin-roles"[\s\S]*?capabilities\?\.\["roles\.edit"\] === true/,
    /entry\.key === "admin-clients"[\s\S]*?capabilities\?\.\["clients\.view_all"\] === true/,
    /entry\.key === "reconcile"[\s\S]*?capabilities\?\.\["settings\.edit"\] === true/,
    /capabilities\?\.\["audit\.read"\] === true/,
  ]) {
    assert.match(portal, rule, "the pre-existing capability chain must be intact");
  }
});

test("an unanswered context leaves the sidebar exactly as it was", async () => {
  /*
   * `null`, not "none". A browser holding a payload from before this field
   * existed, or a context read still in flight, must not empty the sidebar — the
   * failure mode would be every member of every workspace seeing no navigation
   * for as long as the read took.
   */
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /if \(!Array\.isArray\(listed\)\) return null;/);
  assert.match(
    portal,
    /const governing = governingModule\(key\);\s*return !governing \|\| available\.has\(governing\);/,
    "a key the registry does not govern is not the registry's to refuse. " +
      "Re-pointed from a direct `PORTAL_MODULE_KEYS.includes` check: that version " +
      "treated `units` as ungoverned, which left the whole Assets register open at " +
      "/dashboard/units after Assets was switched off. `governingModule` follows " +
      "the aliases, so the pin is now on the resolver rather than on the list.",
  );
});

test("a card cannot open a module the workspace has switched off", async () => {
  /*
   * The sidebar no longer offers one, but `openSectionWithQuery` reaches
   * `setSection` from an Overview counter, a site row and a compliance chip. The
   * page guard catches a document request for the same address and never sees
   * this.
   */
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(
    portal,
    /const section = moduleAvailable && !moduleAvailable\(requested\) \? "overview" : requested;/,
  );
});

/* ------------------------------------------------------------------ */
/* Second and third doors                                             */
/* ------------------------------------------------------------------ */

test("`units` answers for Assets, because it draws the Assets screen", async () => {
  /*
   * THE HOLE THE FIRST DRAFT LEFT, AND THE DIRECTION IT GOT WRONG.
   *
   * `units` is deliberately not a module: giving it a switch would let a workspace
   * switch off "Units" and still reach the identical screen at Assets. That
   * reasoning is sound and it is also only half the picture — the exposure runs the
   * other way. `/dashboard/units` renders the Assets screen, so leaving the key
   * UNGOVERNED meant switching ASSETS off left the whole register open at a second
   * URL, server-side and client-side both.
   *
   * Omitting it from the catalogue is still right. Treating it as ungoverned was
   * not.
   */
  assert.equal(portalModule("units"), null, "still not a module of its own");
  assert.equal(governingModule("units"), "assets", "but it answers for Assets");
  assert.equal(MODULE_ALIASES.units, "assets");

  /* And the renderer that makes it true is still the renderer. */
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(
    portal,
    /activeSurface === "assets" \|\| activeSurface === "units"/,
    "if this stops being a second door onto Assets, the alias is wrong rather " +
      "than merely unnecessary",
  );

  /* No alias may point at a key that is not a module, or the guard resolves to
     null and silently lets the page through. */
  for (const [from, to] of Object.entries(MODULE_ALIASES)) {
    assert.ok(portalModule(to), `${from} aliases ${to}, which is not a module`);
    assert.equal(portalModule(from), null, `${from} must not also be a module`);
  }
});

test("governingModule refuses nothing it does not govern", () => {
  /* Silence, not denial — the rule every layer of this system follows. */
  assert.equal(governingModule("section:cctv"), null);
  assert.equal(governingModule("profile"), null);
  assert.equal(governingModule(""), null);
  /* And a real module is itself. */
  assert.equal(governingModule("reports"), "reports");
});

test("a workspace section cannot be a third door onto a disabled module", async () => {
  /*
   * `SECTION_SURFACES` offers eight surfaces and every one of them is a BUILT-IN
   * MODULE KEY. A section named "Site reports" on the `reports` surface therefore
   * draws the whole Reports screen — and its own key is `section:<slug>`, which the
   * registry rightly has no opinion about. Without a surface check the section went
   * on serving Reports to every member after Reports was switched off.
   *
   * Only a Super Admin can create such a section. That limits how it arises, not
   * who it exposes the screen to.
   */
  const catalogue = await read("app/api/workspace-sections/catalogue.ts");
  const surfaces = new Set(
    [
      ...decommented(
        catalogue.slice(
          catalogue.indexOf("SECTION_SURFACES"),
          catalogue.indexOf("SECTION_TEMPLATES"),
        ),
      /* `key:` — in SECTION_SURFACES the key IS the surface. `surface:` appears
         further down, in SECTION_TEMPLATES, which maps a template to one of
         these and is outside this slice. */
      ).matchAll(/key:\s*"([^"]+)"/g),
    ].map((m) => m[1]),
  );
  assert.ok(surfaces.size >= 4, `the surface list should have been found; got ${surfaces.size}`);
  assert.equal(surfaces.size, 8, "eight surfaces, every one of them a module key");
  for (const surface of surfaces) {
    assert.ok(
      governingModule(surface),
      `the ${surface} surface is not a module, so the guard cannot resolve it. ` +
        "Every offered surface has always been a built-in module key; if one " +
        "stops being, it needs an entry in MODULE_ALIASES or the check below " +
        "silently lets the section through. The column's own default is `board`, " +
        "which is NOT offered here and correctly governs nothing.",
    );
  }

  /* The server half: one indexed read, only for a `section:` key. */
  const guard = await read("app/lib/page-guard.ts");
  assert.match(guard, /const isWorkspaceSection = sectionKey\.startsWith\("section:"\);/);
  assert.match(
    guard,
    /readSectionSurface\(scope\.db, scope\.orgId, sectionKey\)/,
    "and it resolves the surface through the registry",
  );
  const repository = await read("app/lib/portal-module-repository.ts");
  assert.match(repository, /export async function readSectionSurface\(/);
  assert.match(
    repository,
    /\.limit\(1\)/,
    "one row, by the indexed (organisation_id, key) pair — this is on the boot " +
      "path of a document request",
  );

  /* The client half, which the guard never sees. */
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(
    portal,
    /const surfaceWithheld =\s*!!activeCustom && moduleAvailable !== null && !moduleAvailable\(rawSurface\);/,
  );
  assert.match(portal, /surfaceWithheld\s*\? "overview"/);
});

test("Back and Forward get the same module check as a click", async () => {
  /*
   * `syncSectionFromHistory` calls `setActiveSection` directly rather than
   * `setSection`, deliberately — responding to a popstate by pushing history would
   * fight the Back button. That also routed around the registry: a history entry
   * made before a module was switched off re-rendered the disabled surface with no
   * document request for any guard to see.
   */
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(
    portal,
    /const allowed = moduleAvailableRef\.current;\s*setActiveSection\(allowed && !allowed\(resolved\) \? "overview" : resolved\);/,
  );
  assert.match(
    portal,
    /const moduleAvailableRef = useRef<\(\(key: string\) => boolean\) \| null>\(null\);/,
    "a ref, because the popstate listener mounts once and must not be re-added " +
      "every time the context settles",
  );
  assert.match(
    portal,
    /moduleAvailableRef\.current = moduleAvailable;/,
    "kept current in an effect rather than during render",
  );
});

test("the avatar menu and the account rail drop a module that is off", async () => {
  /*
   * §19 says a disabled module disappears from navigation, and these are
   * navigation. Three avatar-menu items and two rail links are second doors:
   * Trash IS the Recycle Bin, Administration opens Users & Access, Teams opens the
   * Team screen. Unfiltered they would offer destinations that bounce to Overview,
   * which reads as the product being broken rather than configured.
   */
  const menu = await read("app/(app)/portal/account-menu.tsx");
  assert.match(menu, /useModuleAvailable\("recycle-bin"\)/);
  assert.match(menu, /useModuleAvailable\("admin-users"\)/);
  assert.match(menu, /useModuleAvailable\("team"\)/);
  assert.match(menu, /\.filter\(\(item\) => moduleAllows\(item\.key\)\)/);
  assert.match(
    menu,
    /MODULE_ITEMS\[key\] !== false/,
    "an UNANSWERED module question keeps the item: a workspace that has switched " +
      "nothing off is every workspace today, so flashing three items away on each " +
      "page load would be the more visible fault, and the guards refuse regardless",
  );

  const shell = await read("app/(app)/portal/views/account-shell.tsx");
  assert.match(shell, /entry\.key !== "trash" \|\| trashModule !== false/);
  assert.match(shell, /module: "admin-users"/);
  assert.match(shell, /module: "team"/);
  assert.match(
    shell,
    /module: null/,
    "and Import data names none — it is a query parameter on the dashboard, not " +
      "a module, and nothing in the registry governs it",
  );

  /* One read of `/api/context`, shared. A second direct fetch is what
     `tests/shared-context-and-navigation-reads.test.mjs` forbids, and the reason
     `useModuleAvailable` lives beside `useCapability`. */
  const hook = await read("app/lib/client-capabilities.ts");
  assert.match(hook, /export function useModuleAvailable\(sectionKey: string\)/);
  assert.match(hook, /fetchRuntimeContext\(\)/);
  assert.ok(
    !/fetch\("\/api\/context"/.test(hook),
    "it must go through the shared memo, never fetch the endpoint itself",
  );
});

test("there is no stored capability column, and that is deliberate", async () => {
  /*
   * A `required_capability` column sat in the first draft of this table,
   * "reserved" for a per-workspace override. It was never read and never written,
   * and it was removed before the branch merged — because a reserved column is an
   * invitation, and this invitation is the irrecoverable lockout above.
   *
   * `can()` consults the ceiling before any override row, and the write side
   * refuses to store one, so a stored capability naming something a role may never
   * hold makes the module permanently unreachable for that role with no way back
   * through the product.
   */
  const init = await read("db/init.ts");
  const stage = init.slice(
    init.indexOf("async function ensurePortalModuleSettings"),
    init.indexOf("async function ensureThemeTokens"),
  );
  assert.ok(
    !/required_capability/.test(stage),
    "the DDL must not create a column for the capability — it is a code constant",
  );

  const schema = await read("db/schema.ts");
  const table = schema.slice(
    schema.indexOf("export const portalModuleSettings"),
    schema.indexOf("export const portalModuleSettings") + 1500,
  );
  assert.ok(
    !/requiredCapability/.test(table),
    "nor may drizzle declare one, or the next person will write to it",
  );
  assert.match(
    schema.slice(0, schema.indexOf("export const portalModuleSettings")),
    /THERE IS NO `required_capability` COLUMN, AND THAT IS THE POINT/,
    "and the reason stays where somebody adding it would read it",
  );
});

test("the guard's fail-open reasoning does not claim a protection it lacks", async () => {
  /*
   * An earlier version of this comment said the APIs behind the page "enforce
   * their own capabilities regardless", which reads as a safety net under the
   * whole guard. Half of it is true: every module's route does hold its
   * capability. The other half is not — NO operational route consults the
   * registry, so a request that fails open renders a switched-off module with
   * working data behind it.
   *
   * Fail-open is still the right choice, because a switch is product
   * configuration rather than an authorisation boundary and failing closed would
   * send every page to Overview for the length of a pooler-capacity event. But
   * the reason has to be the true one, or the next person weakens something else
   * on the strength of a net that is not there.
   */
  const guard = await read("app/lib/page-guard.ts");
  const block = guard.slice(guard.indexOf("export async function requireModuleAccess"));
  assert.match(block, /NOT TRUE for the switch: NO operational route consults the registry/);
  assert.match(block, /a switch is product configuration/);

  /* And the claim is checkable: only these three read the registry. */
  for (const file of [
    "app/api/context/route.ts",
    "app/api/portal-modules/route.ts",
    "app/lib/page-guard.ts",
  ]) {
    const source = await read(file);
    assert.match(
      source,
      /readModuleOverrides|availableModules|resolveModuleAccess/,
      `${file} is named as a registry reader and must be one`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* The write path                                                      */
/* ------------------------------------------------------------------ */

test("both verbs of the registry route are reserved to Super Admin", async () => {
  /*
   * Owner decision D1. `navigation.edit` is in `SUPER_ADMIN_ONLY`, so this is the
   * capability that says "platform staff" rather than "whoever administers this
   * workspace".
   *
   * GET is gated too, which is NARROWER than `/api/theme`'s GET on purpose: every
   * member already learns their own answer from `/api/context`, and this route's
   * answer is the whole catalogue including the modules that were switched off and
   * the ones out of the reader's reach. That is not a client's business.
   */
  const route = await read("app/api/portal-modules/route.ts");
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PUT"));
  const put = route.slice(route.indexOf("export async function PUT"));

  for (const [verb, block] of [["GET", get], ["PUT", put]]) {
    assert.match(
      block,
      /requireCapability\(subject, "navigation\.edit"\)/,
      `${verb} must require navigation.edit`,
    );
    assert.match(block, /if \(refusal\) return refusal;/, `${verb} must return the refusal`);
  }
  assert.match(
    put,
    /if \(!scope\.authenticated\)/,
    "PUT restates the authentication check because it resolves permissions by " +
      "hand rather than through scopedDbWithCapability",
  );
});

test("the route refuses a permanent module, an unknown key and a non-boolean", async () => {
  const route = await read("app/api/portal-modules/route.ts");
  assert.match(route, /Unknown portal module: \$\{key\}/);
  assert.match(route, /must be true or false/);
  assert.match(route, /if \(!raw && !definition\.disableable\)/);
  assert.match(
    route,
    /cannot be switched off/,
    "and says so with the module's own sentence rather than a generic refusal",
  );

  /* The repository checks it again. Two checks, because the route is not the only
     caller a later batch might add. */
  const repository = await read("app/lib/portal-module-repository.ts");
  assert.match(repository, /if \(!enabled && !isDisableableModule\(moduleKey\)\)/);
});

test("every change is audited, and an unchanged switch is not a change", async () => {
  const route = await read("app/api/portal-modules/route.ts");
  assert.match(route, /action: write\.enabled \? "module\.enabled" : "module\.disabled"/);
  assert.match(route, /entityType: "portal_module"/);
  assert.match(
    route,
    /if \(current === write\.enabled\) continue;/,
    "the audit log is a history of decisions, not of saves — re-opening the panel " +
      "and pressing Save must not manufacture an event",
  );
});

test("nothing is written until everything validates", async () => {
  /*
   * A partial save leaves an administrator looking at a set of switches that is
   * neither what they had nor what they asked for, with no way to tell which half
   * landed. `/api/theme` gives the same reason for the same shape.
   */
  const route = await read("app/api/portal-modules/route.ts");
  const put = route.slice(route.indexOf("export async function PUT"));
  const firstWrite = put.indexOf("writeModuleEnabled(");
  const loopEnd = put.indexOf("writes.push({ key, enabled: raw });");
  assert.ok(loopEnd > 0 && firstWrite > loopEnd, "validation must complete before any write");
});

test("the panel treats a refusal as an answer, not an outage", async () => {
  /*
   * `navigation.edit` is Super Admin only, so GET answers 403 for every other
   * role. A 403 renders NOTHING — a card reading "could not load the portal
   * modules" would send an Owner to support to report a bug that is the product
   * working correctly. Every other failure still shows its message, because "the
   * server is unwell" and "this is not for you" are different things.
   */
  const panel = await read("app/(app)/portal/views/portal-modules-panel.tsx");
  assert.match(panel, /if \(response\.status === 403\) \{[\s\S]*?setWithheld\(true\);/);
  assert.match(panel, /if \(withheld\) return null;/);
  assert.match(
    panel,
    /Nothing is deleted\./,
    "and the screen says what a switch does not do — the records behind a module " +
      "stay exactly as they are and come back with it",
  );
});

test("the panel's stylesheet spends no colour literal and no breakpoint", async () => {
  /*
   * Tokens only, so a workspace that has recoloured the product finds this card
   * recoloured with it. And no media query: the CSS stage tests restrict widths to
   * 640/767/768/1024/1280, and a settings card whose rows are a wrapping flex
   * layout does not need one of those five.
   */
  const css = await read("app/(app)/portal/views/portal-modules-panel.css");
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(body), "no hex literal may appear");
  assert.ok(!/\b(rgb|rgba|hsl|hsla)\(/.test(body), "no colour function either");
  assert.ok(!/@media/.test(body), "no media query — see the header");
});
