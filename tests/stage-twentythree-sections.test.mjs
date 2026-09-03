/**
 * Stage 23 — sections the workspace owner adds and removes.
 *
 * The owner's words: "to the workspace I should be able to add more or remove
 * sections — for example I might need to add the CCTV section."
 *
 * Three parts, for the three ways this can be wrong.
 *
 * The first exercises the pure catalogue module, because the interesting
 * failures are in what a row is allowed to be and which rows are drawn, and
 * that is a function with no database and no browser. The centrepiece is the
 * property Stage 20 exists to hold and this stage had to avoid breaking: a
 * saved layout is an ARRANGEMENT, never an inventory. A section added today has
 * to appear for somebody who arranged their sidebar a year ago, and archiving
 * one has to remove it from every sidebar without rewriting anybody's
 * arrangement. Both are tested from both directions.
 *
 * The second reads the source and pins the shape: `settings.edit` on every
 * write through `scopedDbWithCapability`, organisation scoping on every query,
 * archive rather than delete, and — the one that matters most — that every
 * surface a section may point at is a screen `portal-app.tsx` actually renders.
 * That is "Add must not invent a destination", checked by machine rather than
 * remembered by a person.
 *
 * The third talks to a running dev server, because a rule only checked in a
 * unit test is a rule about a function rather than about the API. It skips when
 * nothing is listening, so the suite still passes without a server, and it
 * removes everything it creates.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_ICON,
  DEFAULT_SURFACE,
  ICON_NAMES,
  SECTION_PREFIX,
  SECTION_SURFACES,
  builtInSectionBoard,
  cleanSectionLabel,
  isIconName,
  isSurfaceKey,
  isWorkspaceSectionKey,
  sectionKeyFrom,
  sectionsToCatalogue,
  slugFromLabel,
  surfaceDefinition,
} from "../app/api/workspace-sections/catalogue.ts";
import {
  BUILT_IN_GROUPS,
  builtInCatalogue,
  resolveNavigation,
} from "../app/api/navigation/layout.ts";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const ADMIN = "admin@sunnamusk-uk.test.maintsupp.com";
const CLIENT = "client@sunnamusk-uk.test.maintsupp.com";

const GROUP_KEYS = BUILT_IN_GROUPS.map((group) => group.key);
const catalogueOf = (rows) => sectionsToCatalogue(rows, GROUP_KEYS);

const OPERATIONS = BUILT_IN_GROUPS[0].key;
const WORKSPACE = BUILT_IN_GROUPS[1].key;

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

/** A workspace section row, with the boring fields filled in. */
function section(key, extra = {}) {
  return {
    key: `${SECTION_PREFIX}${key}`,
    label: key.toUpperCase(),
    icon: "camera",
    surface: DEFAULT_SURFACE,
    boardKey: "maintenance",
    group: OPERATIONS,
    position: 0,
    archived: false,
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* 1 — what a section may be                                           */
/* ------------------------------------------------------------------ */

test("a key is namespaced, slugged, and derived from the label when absent", () => {
  assert.equal(sectionKeyFrom({ label: "CCTV" }), "section:cctv");
  assert.equal(sectionKeyFrom({ label: "Fire & Safety" }), "section:fire-safety");
  assert.equal(sectionKeyFrom({ label: "  Waste   Management " }), "section:waste-management");
  // An explicit key is re-slugged rather than trusted, so nothing can escape the
  // namespace or carry a character the layout resolver would refuse.
  assert.equal(sectionKeyFrom({ key: "group:operations", label: "x" }), "section:group-operations");
  assert.equal(sectionKeyFrom({ key: "../../etc", label: "x" }), "section:etc");
  assert.equal(sectionKeyFrom({ key: "section:cctv", label: "x" }), "section:cctv");
  // Nothing usable is a refusal, not a generated key nobody can read.
  assert.equal(sectionKeyFrom({ label: "!!!" }), null);
  assert.equal(sectionKeyFrom({}), null);
});

test("the namespace is what stops a workspace key shadowing a built-in one", () => {
  for (const entry of builtInCatalogue()) {
    assert.equal(isWorkspaceSectionKey(entry.key), false, entry.key);
    assert.notEqual(sectionKeyFrom({ label: entry.key }), entry.key);
  }
  for (const group of BUILT_IN_GROUPS) {
    assert.equal(isWorkspaceSectionKey(group.key), false);
  }
});

test("a label is cleaned the same way a sidebar rename is", () => {
  assert.equal(cleanSectionLabel("  CCTV  "), "CCTV");
  // Control characters are removed rather than escaped, exactly as `cleanLabel`
  // in layout.ts does it — one behaviour for one kind of value, so a name that
  // survives being created here also survives being renamed in the sidebar.
  assert.equal(cleanSectionLabel("CC\u0000\u007fTV"), "CCTV");
  assert.equal(cleanSectionLabel("a\nb"), "ab");
  assert.equal(cleanSectionLabel("Fire   Safety"), "Fire Safety");
  assert.equal(cleanSectionLabel(""), null);
  assert.equal(cleanSectionLabel(42), null);
  assert.equal(cleanSectionLabel("x".repeat(200)).length, 60);
  assert.equal(slugFromLabel("x".repeat(200)).length, 48);
});

test("an icon must be one this product ships", () => {
  assert.equal(isIconName("camera"), true);
  assert.equal(isIconName("cctv-camera"), false);
  assert.equal(isIconName(null), false);
  assert.ok(ICON_NAMES.includes(DEFAULT_ICON));
});

test("a surface must be a screen this product renders", () => {
  assert.equal(isSurfaceKey(DEFAULT_SURFACE), true);
  assert.equal(isSurfaceKey("invented"), false);
  assert.equal(isSurfaceKey(undefined), false);
  assert.notEqual(surfaceDefinition(DEFAULT_SURFACE), null);
  assert.equal(surfaceDefinition("invented"), null);
});

test("only board-backed surfaces have views to choose a default from", () => {
  assert.equal(builtInSectionBoard("maintenance"), "maintenance");
  assert.equal(builtInSectionBoard("store-documentation"), "store-documentation");
  // A screen with no tab strip answers "no board" rather than pretending.
  assert.equal(builtInSectionBoard("settings"), null);
  assert.equal(builtInSectionBoard("overview"), null);
  assert.equal(builtInSectionBoard("documents"), null);
});

/* ------------------------------------------------------------------ */
/* 2 — the catalogue                                                   */
/* ------------------------------------------------------------------ */

test("workspace sections become catalogue entries in stored order", () => {
  const catalogue = catalogueOf([
    section("fire", { position: 2, label: "Fire" }),
    section("cctv", { position: 1, label: "CCTV" }),
  ]);
  assert.deepEqual(
    catalogue.map((entry) => entry.key),
    ["section:cctv", "section:fire"],
  );
  assert.deepEqual(catalogue[0], {
    key: "section:cctv",
    label: "CCTV",
    group: OPERATIONS,
  });
});

test("a section that cannot be drawn is dropped rather than drawn", () => {
  const catalogue = catalogueOf([
    section("archived", { archived: true }),
    section("nowhere", { surface: "a-surface-this-build-does-not-have" }),
    { ...section("hand-written"), key: "cctv" },
    section("real"),
  ]);
  assert.deepEqual(
    catalogue.map((entry) => entry.key),
    ["section:real"],
  );
});

test("a section lands under a real heading whatever its row says", () => {
  const [entry] = catalogueOf([section("cctv", { group: "group:invented" })]);
  assert.equal(entry.group, OPERATIONS);
  const [placed] = catalogueOf([section("cctv", { group: WORKSPACE })]);
  assert.equal(placed.group, WORKSPACE);
});

/* ------------------------------------------------------------------ */
/* 3 — the property this stage had to not break                        */
/* ------------------------------------------------------------------ */

const catalogueWith = (...sections) => [
  ...builtInCatalogue(),
  ...catalogueOf(sections),
];

test("a section added today appears for somebody who arranged their sidebar a year ago", () => {
  // An arrangement saved before CCTV existed. It names three keys and nothing
  // else — which is the normal case, not a contrived one.
  const stored = [
    { key: OPERATIONS, kind: "group", label: null, hidden: false, group: null, position: 0 },
    { key: "settings", kind: "section", label: null, hidden: false, group: OPERATIONS, position: 1 },
    { key: "overview", kind: "section", label: null, hidden: false, group: OPERATIONS, position: 2 },
  ];

  const resolved = resolveNavigation({
    catalogue: catalogueWith(section("cctv", { label: "CCTV" })),
    workspaceItems: [],
    userItems: stored,
    locked: [],
  });

  const keys = resolved.flat.map((item) => item.key);
  assert.ok(keys.includes("section:cctv"), "the new section must be drawn");
  const cctv = resolved.flat.find((item) => item.key === "section:cctv");
  assert.equal(cctv.hidden, false, "and it must be visible, not silently off");
  assert.equal(cctv.label, "CCTV");
  assert.equal(cctv.group, OPERATIONS, "at the end of the heading it belongs to");
  // The arrangement's own opinions still hold: it put Settings first.
  assert.equal(keys[0], "settings");
  // And the section is reported as having appeared since the layout was saved.
  assert.ok(resolved.appeared.includes("section:cctv"));
});

test("archiving a section removes it from every sidebar without touching an arrangement", () => {
  // The arrangement DOES name the section — somebody dragged it. This is the
  // case a stored inventory would get wrong in the other direction.
  const arrangement = [
    { key: OPERATIONS, kind: "group", label: null, hidden: false, group: null, position: 0 },
    { key: "section:cctv", kind: "section", label: "Cameras", hidden: false, group: OPERATIONS, position: 1 },
    { key: "overview", kind: "section", label: null, hidden: false, group: OPERATIONS, position: 2 },
  ];

  const live = resolveNavigation({
    catalogue: catalogueWith(section("cctv")),
    workspaceItems: [],
    userItems: arrangement,
    locked: [],
  });
  assert.equal(live.flat[0].key, "section:cctv");
  assert.equal(live.flat[0].label, "Cameras", "their rename still wins");

  const archived = resolveNavigation({
    catalogue: catalogueWith(section("cctv", { archived: true })),
    workspaceItems: [],
    userItems: arrangement,
    locked: [],
  });
  assert.ok(
    !archived.flat.some((item) => item.key === "section:cctv"),
    "an archived section is not drawn, because its destination is not on offer",
  );
  assert.equal(archived.flat[0].key, "overview", "and nothing else moved");

  // Restoring it brings back the rename and the position, because the
  // arrangement was never rewritten.
  const restored = resolveNavigation({
    catalogue: catalogueWith(section("cctv")),
    workspaceItems: [],
    userItems: arrangement,
    locked: [],
  });
  assert.equal(restored.flat[0].label, "Cameras");
});

test("a workspace section can be locked and renamed like any other", () => {
  const resolved = resolveNavigation({
    catalogue: catalogueWith(section("cctv", { label: "CCTV" })),
    workspaceItems: [
      { key: OPERATIONS, kind: "group", label: null, hidden: false, group: null, position: 0 },
      { key: "section:cctv", kind: "section", label: "Cameras", hidden: false, group: OPERATIONS, position: 1 },
    ],
    userItems: [
      { key: OPERATIONS, kind: "group", label: null, hidden: false, group: null, position: 0 },
      { key: "section:cctv", kind: "section", label: "Mine", hidden: true, group: OPERATIONS, position: 1 },
    ],
    locked: ["section:cctv"],
  });
  const cctv = resolved.flat.find((item) => item.key === "section:cctv");
  assert.equal(cctv.hidden, false, "a locked section cannot be hidden");
  assert.equal(cctv.label, "Cameras", "and shows the workspace's name for it");
});

/* ------------------------------------------------------------------ */
/* 4 — the shape of the code                                           */
/* ------------------------------------------------------------------ */

test("every surface is a screen portal-app actually renders", async () => {
  const portal = await source("app/(app)/portal/portal-app.tsx");
  const meta = portal.slice(
    portal.indexOf("const sectionMeta"),
    portal.indexOf("const navPrimary"),
  );
  const routes = portal.slice(
    portal.indexOf("const sectionRoutes"),
    portal.indexOf("const routeSections"),
  );
  assert.ok(meta.length > 100 && routes.length > 100, "portal-app moved; fix this test");

  for (const surface of SECTION_SURFACES) {
    // Both checks, because they are the two halves of the 404 guard the sidebar
    // already documents: a `sectionMeta` entry with no route is a nav item that
    // goes nowhere, and a route with no meta cannot be drawn.
    assert.ok(
      meta.includes(`${surface.key}:`) || meta.includes(`"${surface.key}"`),
      `surface "${surface.key}" has no sectionMeta entry — it would be a label with no screen`,
    );
    assert.ok(
      routes.includes(`${surface.key}:`) || routes.includes(`"${surface.key}"`),
      `surface "${surface.key}" has no route`,
    );
  }
});

test("the icon list agrees with the one the renderer draws from", async () => {
  const components = await source("app/components.tsx");
  const declaration = components.slice(
    components.indexOf("export type IconName"),
    components.indexOf("const paths"),
  );
  const names = [...declaration.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(names.length > 20, "components.tsx moved; fix this test");
  assert.deepEqual(
    [...ICON_NAMES].sort(),
    [...names].sort(),
    "an icon this module accepts but the renderer has no path for draws an empty hole",
  );
});

test("every write is guarded by settings.edit, through the established helper", async () => {
  const route = await source("app/api/workspace-sections/route.ts");
  for (const method of ["export async function POST", "export async function PATCH", "export async function DELETE"]) {
    const start = route.indexOf(method);
    assert.ok(start > 0, `${method} is missing`);
    const body = route.slice(start, start + 800);
    assert.match(
      body,
      /scopedDbWithCapability\(request, "settings\.edit"\)/,
      `${method} must resolve its scope through the capability guard`,
    );
    assert.match(body, /if \(guard\.denied\) return guard\.denied;/, `${method} must return the refusal`);
  }
  // GET is deliberately not guarded: everybody has to be able to draw a sidebar.
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("/** POST"));
  assert.ok(!/if \(guard\.denied\) return guard\.denied;/.test(get));
});

test("your own last view needs no capability; the one everybody lands on does", async () => {
  const route = await source("app/api/workspace-sections/view/route.ts");
  assert.match(
    route,
    /scope === "workspace"\s*\?\s*await \(async \(\) => \{\s*const guard = await scopedDbWithCapability\(request, "settings\.edit"\)/,
    "the workspace default must be gated on settings.edit",
  );
  assert.match(route, /: await scopedDb\(request\)/, "a personal preference must not be");
});

test("every query names the organisation the scope resolved", async () => {
  for (const path of [
    "app/api/workspace-sections/route.ts",
    "app/api/workspace-sections/view/route.ts",
  ]) {
    const route = await source(path);
    const selects = route.split("\n").filter((line) => /\.where\(/.test(line));
    assert.ok(selects.length > 0);
    assert.ok(
      !/organisationId,\s*["']/.test(route),
      `${path} must never compare organisationId against a literal`,
    );
    assert.match(route, /context\.orgId/, `${path} must scope on the resolved organisation`);
  }
});

test("removing a section archives it, and a purge is the deliberate second act", async () => {
  /*
   * RE-POINTED, NOT WEAKENED — W2.
   *
   * This used to assert `references.arrangements > 0 || references.views > 0`
   * and a 409, which pinned a rule that could not be satisfied. `sidebar-nav`
   * builds its payload from the WHOLE resolved layout, so every saved sidebar
   * names every catalogue key; the moment one colleague dragged one item, that
   * condition was true forever and no section could ever be purged again. The
   * 409 it produced also claimed the section "was archived rather than
   * deleted" while writing nothing at all.
   *
   * The precondition it was reaching for — "nobody is using this any more" — is
   * now expressed as the thing that actually means it: the row must ALREADY be
   * archived. The three properties the old assertions were protecting are all
   * still checked below, and two more that the old shape could not express.
   */
  const route = await source("app/api/workspace-sections/route.ts");
  const del = route.slice(route.indexOf("export async function DELETE"));

  // 1. Unchanged: the default verb archives rather than deletes.
  assert.match(del, /archivedAt: new Date\(\)\.toISOString\(\)/, "the default must archive");

  // 2. Unchanged: the hard delete is reachable only behind the explicit flag.
  const purgeAt = del.indexOf("purge");
  const deleteAt = del.indexOf(".delete(workspaceSections)");
  assert.ok(purgeAt > 0 && deleteAt > purgeAt);

  // 3. The refusal survives, on the precondition that can be met.
  assert.match(del, /if \(!row\.archivedAt\)/, "a live section cannot be purged in one step");
  assert.match(del, /status: 409/, "and refusing is how it says so");

  // 4. New: the irreversible verb sits behind the platform's purge permission,
  //    the same rule `/api/trash` and `/api/files/[id]` follow. `settings.edit`
  //    is held by `admin`, which `data.delete` is deliberately withheld from.
  assert.match(del, /mayPurge\(context\)/, "a purge is not an edit");
  assert.match(route, /can\(subject, "data\.delete"\)/, "and data.delete is the capability");

  // 5. New: what blocked the purge is now cleared BY it, so the confirmation
  //    the browser shows — that the section's place in every sidebar goes with
  //    it — is true rather than reassuring.
  assert.match(del, /forgetSection\(context, row\.key\)/);
  const forget = route.slice(route.indexOf("async function forgetSection"), route.indexOf("export async function DELETE"));
  assert.match(forget, /\.delete\(sectionViewPreferences\)/, "its chosen and remembered views");
  assert.match(forget, /\.update\(navigationLayouts\)/, "and its name in every stored arrangement");
});

test("the navigation route treats workspace sections as catalogue, not arrangement", async () => {
  const route = await source("app/api/navigation/route.ts");
  assert.match(route, /sectionsToCatalogue\(\s*workspaceSections,/);
  // The merge is still handed a catalogue and the stored layers are untouched.
  const resolveAt = route.indexOf("resolveNavigation({");
  const catalogueAt = route.indexOf("const catalogue = requestCatalogue(");
  assert.ok(catalogueAt > 0 && resolveAt > catalogueAt);
  assert.ok(
    !/workspaceSections/.test(route.slice(resolveAt, resolveAt + 400)),
    "the resolver must see a catalogue, never the section rows",
  );
});

/* ------------------------------------------------------------------ */
/* 5 — against a running server                                        */
/* ------------------------------------------------------------------ */

function call(path, options = {}, identity = ADMIN) {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-maintsupp-identity": identity,
      ...(options.headers ?? {}),
    },
  });
}

async function serverIsUp() {
  try {
    const response = await call("/api/workspace-sections");
    return response.ok;
  } catch {
    return false;
  }
}

const KEY = "section:cctv-test";

/*
 * A purge now needs `data.delete`, which `admin` is deliberately not given, so
 * the sweep has to run as the seeded super admin — `can()` waves that role
 * through by design. Sweeping as ADMIN left the row archived rather than gone,
 * and the next run's POST answered 409 "restore it instead of adding it
 * again": a teardown that silently poisons the next test is worse than one
 * that fails.
 */
const SUPER = "super-admin@test.maintsupp.com";

async function removeFixture() {
  await call(`/api/workspace-sections/view?section=${KEY}&scope=workspace`, { method: "DELETE" });
  for (const identity of [ADMIN, CLIENT]) {
    await call(`/api/workspace-sections/view?section=${KEY}`, { method: "DELETE" }, identity);
  }
  // Archive first: the purge refuses a live section, which is the point of it.
  await call(`/api/workspace-sections?key=${KEY}`, { method: "DELETE" });
  await call(`/api/workspace-sections?key=${KEY}&purge=1`, { method: "DELETE" }, SUPER);
}

test("the API adds, shows, renames, reorders and removes a section", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  await removeFixture();
  const before = await (await call("/api/workspace-sections")).json();
  const navBefore = await (await call("/api/navigation")).json();
  const countBefore = navBefore.layout.groups.flatMap((group) => group.items).length;

  try {
    const created = await call("/api/workspace-sections", {
      method: "POST",
      body: JSON.stringify({ label: "CCTV test", key: KEY, icon: "camera", surface: "maintenance" }),
    });
    assert.equal(created.status, 201);
    const { section: made } = await created.json();
    assert.equal(made.key, KEY);
    assert.equal(made.icon, "camera");
    assert.equal(made.boardKey, "maintenance");

    const nav = await (await call("/api/navigation")).json();
    const item = nav.layout.groups
      .flatMap((group) => group.items)
      .find((entry) => entry.key === KEY);
    assert.ok(item, "the section must appear in the resolved sidebar");
    assert.equal(item.label, "CCTV test");
    assert.equal(item.hidden, false);
    assert.ok(nav.sections.some((entry) => entry.key === KEY));

    const renamed = await call("/api/workspace-sections", {
      method: "PATCH",
      body: JSON.stringify({ key: KEY, label: "Cameras" }),
    });
    assert.equal(renamed.status, 200);
    const after = await (await call("/api/navigation")).json();
    assert.equal(
      after.layout.groups.flatMap((group) => group.items).find((entry) => entry.key === KEY).label,
      "Cameras",
    );

    const reordered = await call("/api/workspace-sections", {
      method: "PATCH",
      body: JSON.stringify({ order: [KEY] }),
    });
    assert.equal(reordered.status, 200);
    const listed = await (await call("/api/workspace-sections")).json();
    assert.equal(listed.sections.find((entry) => entry.key === KEY).position, 0);

    // Archive: gone from the sidebar, still in the table.
    const archived = await call(`/api/workspace-sections?key=${KEY}`, { method: "DELETE" });
    assert.equal(archived.status, 200);
    assert.equal((await archived.json()).archived, true);
    const without = await (await call("/api/navigation")).json();
    assert.ok(
      !without.layout.groups.flatMap((group) => group.items).some((entry) => entry.key === KEY),
    );
    const stillThere = await (await call("/api/workspace-sections")).json();
    assert.equal(stillThere.sections.find((entry) => entry.key === KEY).archived, true);
  } finally {
    await removeFixture();
  }

  const rows = await (await call("/api/workspace-sections")).json();
  assert.equal(rows.sections.length, before.sections.length, "the fixture must be gone");
  const navAfter = await (await call("/api/navigation")).json();
  assert.equal(
    navAfter.layout.groups.flatMap((group) => group.items).length,
    countBefore,
    "and the sidebar back to the count it started at",
  );
});

test("a client may read the sections and is refused every write, by name", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  await removeFixture();
  const created = await call("/api/workspace-sections", {
    method: "POST",
    body: JSON.stringify({ label: "CCTV test", key: KEY, surface: "maintenance" }),
  });
  assert.equal(created.status, 201);

  try {
    const writes = [
      ["POST", "/api/workspace-sections", { label: "Client section" }],
      ["PATCH", "/api/workspace-sections", { key: KEY, label: "Hijacked" }],
      ["PATCH", "/api/workspace-sections", { order: [KEY] }],
      ["DELETE", `/api/workspace-sections?key=${KEY}`, null],
      ["DELETE", `/api/workspace-sections?key=${KEY}&purge=1`, null],
      ["PUT", "/api/workspace-sections/view", { section: KEY, view: "main", scope: "workspace" }],
      ["DELETE", `/api/workspace-sections/view?section=${KEY}&scope=workspace`, null],
    ];
    for (const [method, path, body] of writes) {
      const response = await call(
        path,
        { method, ...(body ? { body: JSON.stringify(body) } : {}) },
        CLIENT,
      );
      assert.equal(response.status, 403, `${method} ${path}`);
      const payload = await response.json();
      assert.equal(payload.capability, "settings.edit", `${method} ${path} must name the capability`);
      assert.equal(payload.denied, true);
    }

    const read = await call("/api/workspace-sections", {}, CLIENT);
    assert.equal(read.status, 200, "a client still has to be able to draw a sidebar");
    assert.equal((await read.json()).canEdit, false);

    // Their own last view is their screen, and grants nothing.
    const mine = await call(
      "/api/workspace-sections/view",
      { method: "PUT", body: JSON.stringify({ section: KEY, view: "main" }) },
      CLIENT,
    );
    assert.equal(mine.status, 200);

    const unchanged = await (await call("/api/workspace-sections")).json();
    assert.equal(unchanged.sections.find((entry) => entry.key === KEY).label, "CCTV test");
  } finally {
    await removeFixture();
  }
});

test("the section opens on the view the owner chose, until you choose your own", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  await removeFixture();
  await call("/api/workspace-sections", {
    method: "POST",
    body: JSON.stringify({ label: "CCTV test", key: KEY, surface: "maintenance" }),
  });

  try {
    const initial = await (await call(`/api/workspace-sections/view?section=${KEY}`)).json();
    assert.ok(initial.views.length > 1, "the job board has views to choose between");
    assert.equal(initial.source, "board", "with nothing set, the board's own default answers");
    const boardDefault = initial.view;
    const other = initial.views.find((view) => view.key !== boardDefault).key;

    const set = await call("/api/workspace-sections/view", {
      method: "PUT",
      body: JSON.stringify({ section: KEY, view: other, scope: "workspace" }),
    });
    assert.equal(set.status, 200);

    for (const identity of [ADMIN, CLIENT]) {
      const landed = await (
        await call(`/api/workspace-sections/view?section=${KEY}`, {}, identity)
      ).json();
      assert.equal(landed.view, other, `${identity} must land on the owner's choice`);
      assert.equal(landed.source, "workspace");
    }

    const mine = initial.views.find(
      (view) => view.key !== boardDefault && view.key !== other,
    ).key;
    await call(
      "/api/workspace-sections/view",
      { method: "PUT", body: JSON.stringify({ section: KEY, view: mine }) },
      CLIENT,
    );
    const clientNow = await (
      await call(`/api/workspace-sections/view?section=${KEY}`, {}, CLIENT)
    ).json();
    assert.equal(clientNow.view, mine, "their own last view wins for them");
    assert.equal(clientNow.source, "user");
    assert.equal(clientNow.workspaceDefault, other, "and the default is still reported");

    const adminNow = await (await call(`/api/workspace-sections/view?section=${KEY}`)).json();
    assert.equal(adminNow.view, other, "and for nobody else");

    // A view that does not exist is refused rather than stored, because a
    // preference that can never resolve is a setting that silently does nothing.
    const bogus = await call("/api/workspace-sections/view", {
      method: "PUT",
      body: JSON.stringify({ section: KEY, view: "not-a-view", scope: "workspace" }),
    });
    assert.equal(bogus.status, 400);

    // Forgetting drops the layer so the one beneath answers again.
    await call(`/api/workspace-sections/view?section=${KEY}`, { method: "DELETE" }, CLIENT);
    const forgotten = await (
      await call(`/api/workspace-sections/view?section=${KEY}`, {}, CLIENT)
    ).json();
    assert.equal(forgotten.view, other);
    assert.equal(forgotten.source, "workspace");
  } finally {
    await removeFixture();
  }
});

test("a screen with no tab strip is told it has no default view", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const settings = await (await call("/api/workspace-sections/view?section=settings")).json();
  assert.equal(settings.boardKey, null);
  assert.deepEqual(settings.views, []);
  assert.equal(settings.source, "none");

  const refused = await call("/api/workspace-sections/view", {
    method: "PUT",
    body: JSON.stringify({ section: "settings", view: "main", scope: "workspace" }),
  });
  assert.equal(refused.status, 409);

  const missing = await call("/api/workspace-sections/view?section=not-a-section");
  assert.equal(missing.status, 404);
});
