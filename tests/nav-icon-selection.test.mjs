/**
 * Phase 6 — the sidebar glyph a workspace chooses.
 *
 * WHY THERE IS NO NEW TABLE, WHICH IS THE DESIGN AND NOT A SHORTCUT.
 *
 * `navigation_layouts.items` already holds per-organisation overrides of a built-in
 * section's presentation. `label` is the precedent and its own comment says what it
 * is: "a user's rename, or null to keep whatever the product calls it". An icon is
 * the same field with a different payload, in the same row, and that row already has
 * the three-layer merge, the `navigation.edit` gate, the audit trail, the transport
 * and an editor.
 *
 * An `icon_tokens` table with a Settings panel mirroring Brand colours would have
 * duplicated all of that, bought a migration and a schema-fingerprint change, and
 * created a second place for the sidebar to disagree with itself — for one line of
 * genuine consumption. The last test in this file asserts the absence of that table,
 * so choosing it later has to be a deliberate act.
 *
 * THE THREE CHECKS, AND WHY NO ONE OF THEM IS THE ONLY ONE.
 *
 * `app/api/navigation/layout.ts` imports NOTHING — its own header explains that both
 * the server and the browser call it, so whatever it imports lands in both bundles.
 * That is why the allowlist is not checked there. Instead:
 *
 *   1. `sanitiseArrangement` checks the name's SHAPE, which is exactly the
 *      philosophy that file already states: "deliberately forgiving about CONTENT
 *      and strict about SHAPE … 'this key is not a real section' is a question only
 *      the catalogue can answer and it must be answered in one place";
 *   2. `PUT /api/navigation` refuses anything outside `isIconName` with 422 — the
 *      SAME predicate `workspace_sections` writes through, not a second copy;
 *   3. the renderer narrows once more, because a row stored before a glyph was
 *      retired would otherwise index a map that no longer holds it, and the renderer
 *      indexes a fixed map — an unknown name draws an empty hole rather than failing.
 *
 * WORKSPACE ONLY, NEVER PERSONAL, AND THAT IS A PRODUCT DECISION.
 *
 * A rename can sensibly be personal. A glyph is what the workspace calls a thing, and
 * two colleagues describing the sidebar to each other should be looking at the same
 * picture. `resolveNavigation` reads icons off the workspace layer alone, and a test
 * below proves a personal arrangement cannot carry one into the result.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ICON_NAMES,
  isIconName,
} from "../app/api/workspace-sections/catalogue.ts";
import {
  resolveNavigation,
  sanitiseArrangement,
  toArrangement,
} from "../app/api/navigation/layout.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const decommented = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "");

const CATALOGUE = [
  { key: "group:operations", label: "Operations", group: "group:operations" },
  { key: "maintenance", label: "Jobs", group: "group:operations" },
  { key: "stores", label: "Sites", group: "group:operations" },
];

const item = (over) => ({
  key: "maintenance",
  kind: "section",
  label: null,
  icon: null,
  hidden: false,
  group: "group:operations",
  position: 0,
  ...over,
});

/* ------------------------------------------------------------------ */
/* Sanitising                                                          */
/* ------------------------------------------------------------------ */

test("a section may carry a glyph and a heading may not", () => {
  const [section] = sanitiseArrangement([{ key: "maintenance", icon: "wrench" }]);
  assert.equal(section.icon, "wrench");

  const [heading] = sanitiseArrangement([{ key: "group:operations", icon: "wrench" }]);
  assert.equal(
    heading.icon,
    null,
    "headings are text in this sidebar — a glyph would make one look like a destination",
  );
});

test("sanitising checks the SHAPE and leaves membership to the door", async () => {
  /*
   * The file's own philosophy, applied. An unknown-but-well-shaped name survives here
   * and is refused by the write route; a malformed one never travels at all.
   */
  for (const bad of [
    "a",
    "x".repeat(25),
    "wrench; }",
    "url(evil)",
    "wrench wrench",
    "wrench-2",
    42,
    null,
    {},
  ]) {
    const [row] = sanitiseArrangement([{ key: "maintenance", icon: bad }]);
    assert.equal(row.icon, null, `${JSON.stringify(bad)} must not survive sanitising`);
  }
  /* Well-shaped but not a real glyph: survives here, refused at the door. */
  const [survived] = sanitiseArrangement([{ key: "maintenance", icon: "notAGlyph" }]);
  assert.equal(survived.icon, "notAGlyph");
  assert.equal(isIconName("notAGlyph"), false);

  /*
   * camelCase survives the SHAPE check, and must, because the renderer's union does
   * contain camelCase names. But the allowlist does NOT contain the three sort
   * glyphs — `sortAsc`, `sortDesc`, `sortNone` — so they are refused at the door.
   *
   * Measured, not assumed: `ICON_NAMES` is 48 names against a 51-member union, and
   * those three are exactly the difference. That is right for a section glyph — a
   * sort arrow is an affordance with a fixed meaning everywhere else in the product,
   * and `section-manager.tsx` excludes the same class of glyph from its own picker
   * for the same reason. It is also a coincidence the suite depends on:
   * `stage-twentythree-sections` holds the two lists level with a lowercase-only
   * regex, so those three are invisible to it on both sides. Adding a LOWERCASE
   * glyph to one list only would turn that pin red.
   */
  const [camel] = sanitiseArrangement([{ key: "maintenance", icon: "sortAsc" }]);
  assert.equal(camel.icon, "sortAsc", "camelCase passes the shape check");
  for (const affordance of ["sortAsc", "sortDesc", "sortNone"]) {
    assert.equal(
      isIconName(affordance),
      false,
      `${affordance} is a sort affordance, not a section glyph — refused at the door`,
    );
  }
  assert.equal(isIconName("wrench"), true, "and a real section glyph is accepted");
});

test("layout.ts still imports nothing, which is why the check is split", async () => {
  /*
   * Load-bearing. Both the server and the browser call this module, so an import here
   * lands in both bundles — its header says so. It is also why `NavArrangementItem.icon`
   * is typed `string` rather than an icon union.
   */
  const source = await read("app/api/navigation/layout.ts");
  assert.ok(
    !/^import\s/m.test(source),
    "app/api/navigation/layout.ts must stay import-free — see its header",
  );
  assert.match(source, /function cleanIcon\(value: unknown\): string \| null \{/);
  assert.match(source, /icon: string \| null;/);
});

/* ------------------------------------------------------------------ */
/* Resolving                                                           */
/* ------------------------------------------------------------------ */

test("the workspace's glyph is reported, and null means the built-in one", () => {
  const withIcon = resolveNavigation({
    catalogue: CATALOGUE,
    workspaceItems: [item({ icon: "shield" })],
    userItems: null,
    locked: [],
  });
  const jobs = withIcon.flat.find((row) => row.key === "maintenance");
  assert.equal(jobs.icon, "shield");

  const without = resolveNavigation({
    catalogue: CATALOGUE,
    workspaceItems: [],
    userItems: null,
    locked: [],
  });
  assert.equal(
    without.flat.find((row) => row.key === "maintenance").icon,
    null,
    "null rather than a resolved name: the CATALOGUE owns the built-in glyph, and the " +
      "catalogue lives in the browser. The server has never had an opinion about a " +
      "built-in section's icon and this does not give it one.",
  );
});

test("A PERSONAL ARRANGEMENT CANNOT CARRY A GLYPH", () => {
  /*
   * The product decision, enforced. A rename can sensibly be personal; a glyph is
   * what the workspace calls a thing. `resolveNavigation` reads icons off the
   * workspace layer alone, so even a crafted personal payload cannot reach the result.
   */
  const resolved = resolveNavigation({
    catalogue: CATALOGUE,
    workspaceItems: [],
    userItems: [item({ icon: "shield" })],
    locked: [],
  });
  assert.equal(
    resolved.flat.find((row) => row.key === "maintenance").icon,
    null,
    "a personal layer must not set a glyph",
  );

  /* And the workspace's choice survives a personal arrangement sitting on top. */
  const both = resolveNavigation({
    catalogue: CATALOGUE,
    workspaceItems: [item({ icon: "shield" })],
    userItems: [item({ label: "My jobs" })],
    locked: [],
  });
  const row = both.flat.find((entry) => entry.key === "maintenance");
  assert.equal(row.icon, "shield", "the workspace glyph survives a personal rename");
  assert.equal(row.label, "My jobs", "and the personal rename still applies");
});

test("a glyph survives a re-flatten — the regression a drag would have caused", () => {
  /*
   * `toArrangement` serialises a resolved layout back into the arrangement that
   * produced it, and the sidebar re-flattens on every edit. If it dropped `icon`, the
   * first time anybody dragged a row every chosen glyph in the workspace would be
   * silently cleared, and the save would look like it had worked.
   */
  const resolved = resolveNavigation({
    catalogue: CATALOGUE,
    workspaceItems: [item({ icon: "shield" }), item({ key: "stores", icon: "store", position: 1 })],
    userItems: null,
    locked: [],
  });
  const flattened = toArrangement(resolved.groups);
  assert.equal(flattened.find((row) => row.key === "maintenance").icon, "shield");
  assert.equal(flattened.find((row) => row.key === "stores").icon, "store");
  for (const heading of flattened.filter((row) => row.kind === "group")) {
    assert.equal(heading.icon, null, "a heading still carries none");
  }

  /*
   * And a second pass keeps every glyph, which is what makes repeated edits safe.
   *
   * Compared on the SECTIONS only, deliberately. The heading list is not identical
   * between passes and that is pre-existing and harmless: this fixture's workspace
   * layer carries section rows and no heading rows, so `applyLayer` invents a heading
   * and then appends the base's own, leaving `group:operations` listed twice on the
   * first pass. `sanitiseArrangement` de-duplicates by key on the way in — its `seen`
   * set — so a STORED arrangement never carries a duplicate, and the second pass is
   * already clean. Asserting the whole list here would pin an artefact of the fixture
   * rather than the behaviour this test is about.
   */
  const again = toArrangement(
    resolveNavigation({
      catalogue: CATALOGUE,
      workspaceItems: flattened,
      userItems: null,
      locked: [],
    }).groups,
  );
  const sections = (rows) =>
    rows.filter((row) => row.kind === "section").map((row) => [row.key, row.icon]);
  assert.deepStrictEqual(
    sections(again),
    sections(flattened),
    "every chosen glyph must survive a second flatten",
  );
});

/* ------------------------------------------------------------------ */
/* The door                                                            */
/* ------------------------------------------------------------------ */

test("the write route refuses a glyph this product does not ship", async () => {
  const route = await read("app/api/navigation/route.ts");
  assert.match(
    route,
    /import \{ isIconName \} from "\.\.\/workspace-sections\/catalogue";/,
    "the SAME predicate workspace_sections writes through, not a second copy",
  );
  assert.match(route, /items\.find\(\(item\) => item\.icon && !isIconName\(item\.icon\)\)/);
  assert.match(route, /"That is not an icon this product ships\."/);
  assert.match(
    route,
    /status: 422/,
    "a refusal rather than a silent coercion, matching PATCH /api/workspace-sections",
  );
});

test("the allowlist is the one that already existed", () => {
  /*
   * Deliberately NOT extracted, normalised or re-derived. `ICON_NAMES` is a 48-name
   * copy of a 51-name union and the test that holds them level
   * (`stage-twentythree-sections`) extracts the union with a lowercase-only regex, so
   * the three camelCase names are invisible to it on both sides. Tidying either list
   * turns a green pin red in a way nobody expects.
   */
  assert.ok(ICON_NAMES.length >= 40, `expected the full allowlist, got ${ICON_NAMES.length}`);
  assert.equal(isIconName("wrench"), true);
  assert.equal(isIconName("not-a-glyph"), false);
  assert.equal(isIconName(null), false);
});

/* ------------------------------------------------------------------ */
/* The renderer                                                        */
/* ------------------------------------------------------------------ */

test("the sidebar draws the chosen glyph, then the catalogue's, then grid", async () => {
  const nav = await read("app/(app)/portal/sidebar-nav.tsx");
  assert.match(
    nav,
    /\(isIconName\(item\.icon\) \? item\.icon : null\) \?\?\s*\n?\s*iconFor\.get\(item\.key\) \?\?\s*\n?\s*"grid"/,
    "three levels, in that order",
  );
  assert.match(nav, /import \{ isIconName \} from "\.\.\/\.\.\/api\/workspace-sections\/catalogue";/);
  /* The catalogue fallback must still be built from the prop, not invented here. */
  assert.match(nav, /for \(const entry of catalogue\) map\.set\(entry\.key, entry\.icon\);/);
});

test("unsafe SVG injection stays structurally impossible", async () => {
  /*
   * A configurable glyph introduces no new class of risk, and this is why: the name
   * only ever INDEXES a fixed map of literal JSX. Nothing concatenates, parses or
   * interpolates path data, so there is no escaping to get wrong — the residual risk
   * of a bad name is a blank square, which the three checks above already prevent.
   */
  const components = await read("app/components.tsx");
  assert.match(components, /\{paths\[name\]\}/, "the glyph is a map lookup");
  assert.ok(
    !/dangerouslySetInnerHTML/.test(components),
    "app/components.tsx must never inject markup",
  );
  const nav = await read("app/(app)/portal/sidebar-nav.tsx");
  assert.ok(
    !/dangerouslySetInnerHTML/.test(nav),
    "nor may the sidebar",
  );
});

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

test("the panel is Super Admin only, and a refusal renders nothing", async () => {
  const panel = await read("app/(app)/portal/views/nav-icons-panel.tsx");
  assert.match(panel, /if \(payload\.canEditDefault !== true\) \{/);
  assert.match(panel, /setWithheld\(true\);/);
  assert.match(panel, /if \(withheld\) return null;/);
});

test("the panel offers the SERVER's list and previews each glyph", async () => {
  const panel = await read("app/(app)/portal/views/nav-icons-panel.tsx");
  assert.match(panel, /\{ICON_NAMES\.map\(\(name\) => \(/, "the allowlist comes from the server");
  assert.match(panel, /<option value="">Product default<\/option>/);
  /* A name in a select is not a preview — somebody choosing between `tool` and
     `wrench` is choosing between two pictures. */
  assert.match(panel, /nav-icon-row__glyph/);
  assert.match(panel, /<Icon name=\{drawn\} size=\{18\} \/>/);
});

test("the panel reads /api/navigation through the shared store", async () => {
  /*
   * `tests/shared-context-and-navigation-reads.test.mjs` allows exactly one module to
   * fetch that endpoint. Two readers of one endpoint measured 1,278ms and 1,178ms for
   * the same bytes once already.
   */
  const panel = await read("app/(app)/portal/views/nav-icons-panel.tsx");
  assert.match(panel, /import \{ fetchNavigation, forgetNavigation \} from "\.\.\/navigation-store";/);
  assert.ok(
    !/fetch\("\/api\/navigation"[^)]*\)\s*;?\s*$/m.test(decommented(panel).replace(/method: "PUT"[\s\S]*?\}\);/g, "")),
    "it must not GET the endpoint directly",
  );
  /* A write is a different matter — and it invalidates the cached read, which is
     the store's own documented rule. */
  assert.match(panel, /method: "PUT"/);
  assert.match(panel, /forgetNavigation\(\);/);
});

test("the panel says that saving also fixes the order", async () => {
  /*
   * A real consequence, not hidden. A stored arrangement is a whole layer — a partial
   * one would reorder the sidebar — so writing a glyph writes the arrangement the
   * workspace is already seeing. Dragging one row in the sidebar editor already does
   * exactly this; somebody changing a glyph would not expect it.
   */
  const panel = await read("app/(app)/portal/views/nav-icons-panel.tsx");
  assert.match(panel, /Saving also records the sidebar’s current order/);
  assert.match(panel, /Product default” for every entry/);
});

test("the panel takes the catalogue as a prop, so sectionMeta never moves", async () => {
  /*
   * THE MOST EXPENSIVE EDIT IN THIS AREA, AVOIDED. `sectionMeta` in `portal-app.tsx`
   * is the single source for a built-in section's glyph, and FOUR test files slice
   * that declaration by source position — two of them by its exact two-space
   * `key: {` line shape. Several are protecting a real drift bug and the 404 guard.
   * So the panel is handed the resolved catalogue and the declaration stays put.
   */
  const panel = await read("app/(app)/portal/views/nav-icons-panel.tsx");
  assert.match(panel, /\{ catalogue \}: \{ catalogue: SidebarNavEntry\[\] \}/);
  assert.ok(!/sectionMeta/.test(panel), "the panel must not reach for sectionMeta");

  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /<NavIconsPanel catalogue=\{navCatalogue\} \/>/);
  /* And the declaration is still where the four slices expect it. */
  assert.match(portal, /const sectionMeta: Record</);
  const slice = portal.slice(
    portal.indexOf("const sectionMeta: Record<"),
    portal.indexOf("const navPrimary"),
  );
  assert.ok(
    slice.length > 100,
    "sectionMeta must still precede navPrimary — four tests slice between them",
  );
  assert.ok(
    /\n {2}"?[a-z-]+"?: \{\n/.test(slice),
    "and keep its two-space `key: {` line shape, which two of those tests match on",
  );
});

/* ------------------------------------------------------------------ */
/* What this phase did NOT add                                         */
/* ------------------------------------------------------------------ */

test("no table, no column, no migration, no fingerprint change", async () => {
  /*
   * The whole reason this rides `navigation_layouts.items`. A new table would have
   * bought a migration and a fingerprint bump for one line of consumption — and
   * `tests/schema-fingerprint.test.mjs` would have had to be re-pointed, which is the
   * signal that a schema change happened at all.
   */
  const init = await read("db/init.ts");
  const schema = await read("db/schema.ts");
  for (const forbidden of ["icon_tokens", "nav_icons", "navigation_icons"]) {
    assert.ok(!init.includes(forbidden), `db/init.ts must not create ${forbidden}`);
    assert.ok(!schema.includes(forbidden), `db/schema.ts must not declare ${forbidden}`);
  }
  /* `navigation_layouts` keeps the columns it had — the icon lives inside `items`. */
  const table = init.slice(
    init.indexOf("CREATE TABLE IF NOT EXISTS navigation_layouts"),
    init.indexOf("CREATE TABLE IF NOT EXISTS navigation_layouts") + 900,
  );
  assert.ok(
    !/\bicon\b/.test(table),
    "navigation_layouts must gain no icon COLUMN — the override belongs in items",
  );
});

test("PortalModule still carries no icon, and the platform console is untouched", async () => {
  /*
   * Two surfaces deliberately left alone.
   *
   * `portal-modules.ts` decides EXISTENCE and AUTHORITY and is read by server route
   * guards; an icon there would be a fourth copy of built-in presentation with
   * nothing reading it that the catalogue does not already serve, and no test holding
   * the two level.
   *
   * `PLATFORM_SECTIONS` is the vendor's cross-organisation console. A per-workspace
   * override has no tenant to apply to.
   */
  const modules = await read("app/lib/portal-modules.ts");
  assert.ok(!/\bicon\b/i.test(modules), "PortalModule must carry no icon");

  const platform = await read("app/lib/platform-sections.ts");
  assert.match(platform, /icon: "home"/, "the console keeps its fixed glyphs");
  assert.ok(
    !/isIconName|workspaceIcons/.test(platform),
    "and takes no per-workspace override",
  );
});
