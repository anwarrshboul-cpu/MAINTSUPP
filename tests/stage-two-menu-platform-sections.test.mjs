/**
 * WORKSTREAM 2 — Menu and Platform Sections.
 *
 * The ten official checks are about a platform structure the owner can change:
 * reorder sections, add one, rename one, hide/archive/remove one, confirm
 * before a permanent removal, give each an icon and a position, have the order
 * survive a refresh and a fresh sign-in, and let only authorised people do any
 * of it.
 *
 * Almost all of that was already built — on the SERVER. What this file guards
 * is the set of defects found closing W2, each of which was invisible to the
 * suite as it stood:
 *
 *   1. The whole section-CRUD API had no caller in the browser. Add, rename,
 *      re-icon, archive, restore and purge were reachable only by hand-written
 *      fetch, so five official checks failed on a missing dialog rather than on
 *      missing behaviour.
 *   2. Back and Forward resolved a URL differently from a reload. The popstate
 *      handler read ONE path segment while two routes contain a slash and
 *      workspace sections live under `s/`, so Back onto Roles rendered Users
 *      and Back onto any added section rendered Overview.
 *   3. "Units" was drawn in the sidebar by a catalogue fallback while two
 *      comments and the server's own list said it was gone — so the browser and
 *      `GET /api/navigation` disagreed about which sections exist.
 *   4. A permanent removal could never succeed, and said it had archived
 *      something while writing nothing.
 *   5. A section drew its own name in one strip that is hidden below 768px, so
 *      on a phone a section called CCTV was never called CCTV anywhere.
 *
 * Behaviour first: the pure modules are imported and exercised. Where a rule
 * lives inside a React component that cannot be mounted here, the source is
 * pinned — and the pin names the behaviour it stands for, so a later move
 * re-points it instead of deleting it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  boardIdentity,
  sectionIdentity,
} from "../app/(app)/portal/board-identity.ts";
import {
  BUILT_IN_ORDER,
  builtInCatalogue,
  resolveNavigation,
  toArrangement,
} from "../app/api/navigation/layout.ts";
import { cleanSectionLabel } from "../app/api/workspace-sections/catalogue.ts";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const ADMIN = "admin@sunnamusk-uk.test.maintsupp.com";
const CLIENT = "client@sunnamusk-uk.test.maintsupp.com";
/* `can()` waves the immutable role through, so this is the only seeded identity
   that may purge. `admin` deliberately has no `data.delete`. */
const SUPER = "super-admin@test.maintsupp.com";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const codeOnly = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ------------------------------------------------------------------ */
/* W02-07 — a section is called by its own name, on every screen size  */
/* ------------------------------------------------------------------ */

test("W02-07 a section's own name replaces the board's, in both places a name appears", () => {
  const board = boardIdentity("maintenance");
  const cctv = sectionIdentity("maintenance", "CCTV");

  assert.equal(board.heading, "Maintenance operations board");
  assert.equal(cctv.heading, "CCTV", "the page heading, which is all there is above 768px");
  assert.equal(
    cctv.shortName,
    "CCTV",
    "and the mobile board bar, which is the ONLY name on screen below 761px",
  );
});

test("W02-07 the description is the workspace's when it gave one, the screen's otherwise", () => {
  const withBoth = sectionIdentity("maintenance", "CCTV", "Every camera, and who last serviced it.");
  assert.equal(withBoth.blurb, "Every camera, and who last serviced it.");

  // A name but no description still describes the grid correctly: the two are
  // independent overrides, not one.
  const nameOnly = sectionIdentity("maintenance", "CCTV");
  assert.equal(nameOnly.blurb, boardIdentity("maintenance").blurb);
  assert.equal(nameOnly.heading, "CCTV");
});

test("W02-07 a built-in section is untouched by the override", () => {
  for (const boardId of ["maintenance", "store-documentation"]) {
    assert.deepEqual(
      sectionIdentity(boardId, null, null),
      boardIdentity(boardId),
      "no label and no description must be exactly the board's own identity",
    );
    assert.deepEqual(sectionIdentity(boardId, "   "), boardIdentity(boardId), "whitespace is not a name");
  }
});

test("W02-07 the eyebrow, the noun and the blurb still describe the GRID", () => {
  /*
   * A CCTV section drawing the job board still holds jobs. Renaming the screen
   * must not rename what is in it — "0 cameras" over a list of maintenance
   * tickets would be an invention, which `board-identity.ts` rules out.
   */
  const cctv = sectionIdentity("maintenance", "CCTV");
  assert.equal(cctv.itemNoun, boardIdentity("maintenance").itemNoun);
  assert.equal(cctv.eyebrow, boardIdentity("maintenance").eyebrow);
});

/* ------------------------------------------------------------------ */
/* W02-03 — a description is cleaned the way a label is                */
/* ------------------------------------------------------------------ */

test("W02-03 a description gets more room than a label but the same cleaning", () => {
  assert.equal(cleanSectionLabel("  CCTV   cameras  "), "CCTV cameras", "whitespace collapses");
  // Escapes, not the raw bytes: a literal NUL in the source makes git treat
  // this file as binary, which hides every future diff of it.
  assert.equal(cleanSectionLabel("\u0000\u0007"), null, "control characters are not text");

  const long = "x".repeat(300);
  assert.equal(cleanSectionLabel(long).length, 60, "a nav label still fits the rail");
  assert.equal(
    cleanSectionLabel(long, 240).length,
    240,
    "a description is prose and is capped at its own length, not the label's",
  );
});

/* ------------------------------------------------------------------ */
/* W02-01 / W02-09 — order is an arrangement, and it survives          */
/* ------------------------------------------------------------------ */

test("W02-09 a saved order is reproduced exactly on the next read", () => {
  const catalogue = builtInCatalogue();
  const first = resolveNavigation({ catalogue, workspaceItems: [], userItems: null, locked: [] });

  // Move the last item of Operations to the front — a reorder, as the sidebar
  // would produce one — then round-trip it through the stored shape.
  const operations = first.groups[0];
  const reordered = [
    operations.items[operations.items.length - 1],
    ...operations.items.slice(0, -1),
  ];
  const stored = toArrangement([
    { ...operations, items: reordered },
    ...first.groups.slice(1),
  ]);

  const second = resolveNavigation({
    catalogue,
    workspaceItems: [],
    userItems: stored,
    locked: [],
  });
  assert.deepEqual(
    second.groups[0].items.map((item) => item.key),
    reordered.map((item) => item.key),
    "the order read back must be the order saved — this is the whole of W02-09",
  );
});

test("W02-09 the pending save is flushed rather than dropped when the page goes away", async () => {
  /*
   * The order is written 400ms after it stops changing. The unmount cleanup
   * used to clear that timer and nothing else, so navigating away inside 400ms
   * silently lost the last change — the sidebar looked rearranged until the
   * next reload put it back, which is exactly the complaint W02-09 exists to
   * prevent and the hardest kind for a user to report.
   */
  const nav = codeOnly(await source("app/(app)/portal/sidebar-nav.tsx"));
  assert.match(nav, /window\.addEventListener\("pagehide"/, "a closed tab is not an unmount");
  assert.match(nav, /keepalive: true/, "and a save started as the page unloads must still leave");
  const cleanup = nav.slice(nav.indexOf('addEventListener("pagehide"'));
  assert.match(
    cleanup.slice(0, 400),
    /flushRef\.current\(\)/,
    "the cleanup must flush the pending write, not merely cancel its timer",
  );
});

/* ------------------------------------------------------------------ */
/* The menu's source of truth                                          */
/* ------------------------------------------------------------------ */

test("every section the browser can draw is one the server also knows about", async () => {
  /*
   * THE ASSERTION WHOSE ABSENCE LET "UNITS" DRIFT.
   *
   * `stage-twenty-navigation.test.mjs` pins `BUILT_IN_ORDER` ⊇ navPrimary +
   * navSecondary, and pins that every `BUILT_IN_ORDER` key has a route. Neither
   * covers the other direction, and the browser's catalogue does not come from
   * `navPrimary` at all — it comes from `Object.keys(sectionMeta)`, so a key in
   * `sectionMeta` that nobody placed was swept in anyway. "units" was, under
   * the wrong heading, with the server answering a lower-case label for a key
   * it had never heard of.
   *
   * So: every key the browser may draw is either in the server's list or named
   * in `navExcluded` as deliberately withheld. Nothing may be in neither.
   */
  const portal = await source("app/(app)/portal/portal-app.tsx");

  const metaBlock = portal.slice(
    portal.indexOf("const sectionMeta: Record<"),
    portal.indexOf("const navPrimary"),
  );
  const metaKeys = [...metaBlock.matchAll(/^ {2}"?([a-z-]+)"?: \{$/gm)].map((m) => m[1]);
  assert.ok(metaKeys.length >= 15, `expected the section map, found ${metaKeys.length} keys`);

  const excludedBlock = portal.slice(portal.indexOf("const navExcluded"));
  const excluded = new Set(
    [...excludedBlock.slice(0, 200).matchAll(/"([a-z-]+)"/g)].map((m) => m[1]),
  );
  const known = new Set(BUILT_IN_ORDER.map((entry) => entry.key));

  for (const key of metaKeys) {
    assert.ok(
      known.has(key) || excluded.has(key),
      `"${key}" can be drawn in the sidebar but the server's BUILT_IN_ORDER does not list it. ` +
        "Add it there, or add it to navExcluded to withhold it deliberately.",
    );
  }

  // And the exclusion has to be real: nothing may be in both lists.
  for (const key of excluded) {
    assert.ok(!known.has(key), `"${key}" is both excluded and listed in BUILT_IN_ORDER`);
  }
});

test("Units is withheld from the sidebar, and its route still answers", async () => {
  const portal = await source("app/(app)/portal/portal-app.tsx");
  assert.match(
    portal,
    /const navExcluded: ReadonlySet<string> = new Set<string>\(\["units"\]\)/,
    "the owner asked for one door to the estate, not two",
  );
  // The section is kept, not deleted — a bookmark must keep working.
  assert.match(portal, /units: "units"/, "the route stays");
  assert.match(portal, /^ {2}units: \{$/m, "and so does the screen");

  const page = await source("app/(app)/dashboard/[[...section]]/page.tsx");
  assert.match(page, /units: "units"/, "and the server still resolves the URL");
});

/* ------------------------------------------------------------------ */
/* Deep links, Back and Forward                                        */
/* ------------------------------------------------------------------ */

test("Back and Forward resolve a URL the same way a reload does", async () => {
  /*
   * The client read `pathname.split("/")[1]` — one segment — while
   * `sectionRoutes` holds "admin/roles" and "admin/clients", and a workspace
   * section lives at "s/<slug>". So a reload and a Back button on the same
   * address landed in different places: Back onto Roles rendered Users, and
   * Back onto any added section rendered Overview.
   *
   * Both files must resolve in the same three steps, in the same order.
   */
  const portal = codeOnly(await source("app/(app)/portal/portal-app.tsx"));
  const handler = portal.slice(
    portal.indexOf("const syncSectionFromHistory"),
    portal.indexOf('window.addEventListener("popstate"'),
  );
  assert.ok(handler.length > 0, "the popstate handler must still exist");

  assert.match(handler, /\.slice\(1\)/, "every segment after /dashboard, not just the first");
  assert.match(handler, /segments\.join\("\/"\)/, "a nested route has to match whole");
  assert.match(
    handler,
    /segments\[0\] === "s" && segments\[1\]/,
    "and a workspace section is resolved before either",
  );
  assert.doesNotMatch(
    handler,
    /split\("\/"\)\.filter\(Boolean\)\[1\]/,
    "the single-segment lookup is the defect; it must not come back",
  );

  // The server's resolution, which this now mirrors.
  const page = codeOnly(await source("app/(app)/dashboard/[[...section]]/page.tsx"));
  assert.match(page, /section\?\.join\("\/"\)/);
  assert.match(page, /section\?\.\[0\] === "s" && section\[1\]/);
});

/* ------------------------------------------------------------------ */
/* W02-02 … W02-05, W02-08 — the controls exist and are reachable      */
/* ------------------------------------------------------------------ */

test("W02-02 the Add New Section button exists and calls the endpoint that creates one", async () => {
  const manager = await source("app/(app)/portal/section-manager.tsx");
  assert.match(manager, /Add new section/, "the button the checklist names");
  assert.match(manager, /method: target \? "PATCH" : "POST"/, "add creates, edit changes");
  assert.match(manager, /"\/api\/workspace-sections"/);

  // And it is reachable from the sidebar, which is the only place it makes
  // sense to add a sidebar entry from.
  const nav = await source("app/(app)/portal/sidebar-nav.tsx");
  assert.match(nav, /data-nav-sections/);
  assert.match(nav, /New section/);
  assert.match(nav, /onManageSections/);

  // The dialog has to be mounted, or the button opens nothing.
  const portal = await source("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /<SectionManager/);
  assert.match(
    portal,
    /onChanged=\{\(\) => \{\s*void reloadWorkspaceSections\(\);/,
    "a section added in the dialog must be in the sidebar behind it",
  );
});

test("W02-05 a permanent removal is confirmed by a dialog, not by window.confirm", async () => {
  const manager = await source("app/(app)/portal/section-manager.tsx");
  assert.match(manager, /role="alertdialog"/, "a confirmation has to be announced as one");
  // Comments stripped: this file's own header discusses `window.confirm` by
  // name, and an unstripped search finds the prose rather than a call.
  assert.doesNotMatch(
    codeOnly(manager),
    /window\.confirm|[^.\w]confirm\(/,
    "a native confirm is unstyled, unlabelled and untestable — W07-06 is still PARTIAL for it",
  );
  // It must say what is lost, not ask whether you are sure.
  assert.match(manager, /cannot be undone/);
  assert.match(manager, /purge=1/, "and only the explicit flag destroys anything");
  // Cancelling has to actually cancel.
  assert.match(manager, /onClick=\{\(\) => setPurging\(null\)\}/);
});

test("W02-08 the icon picker offers only icons the server will accept", async () => {
  const manager = await source("app/(app)/portal/section-manager.tsx");
  const block = manager.slice(
    manager.indexOf("const PICKABLE_ICONS"),
    manager.indexOf("async function readJson"),
  );
  const offered = [...block.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(offered.length >= 20, `expected a real picker, found ${offered.length}`);

  const { ICON_NAMES } = await import("../app/api/workspace-sections/catalogue.ts");
  const accepted = new Set(ICON_NAMES);
  for (const name of offered) {
    assert.ok(accepted.has(name), `the picker offers "${name}", which the API would refuse`);
  }

  // Native radios, so the arrow keys and the group semantics are not re-invented.
  assert.match(manager, /type="radio"/);
  assert.match(manager, /name="section-icon"/);
});

test("W02-01 / W02-04 the row controls are reachable without a hover", async () => {
  /*
   * Reorder, rename and hide revealed on `:hover`/`:focus-within` only, and
   * reordering otherwise needed HTML5 drag-and-drop (no touch events) or
   * Alt+arrow (no keyboard on a phone). The whole sidebar editor was
   * desktop-only without saying so, and the buttons were 21px.
   */
  const css = await source("app/(app)/portal/sidebar-nav.css");
  assert.match(css, /@media \(hover: none\)/, "the condition is 'cannot hover', not a width");
  const touch = css.slice(css.indexOf("@media (hover: none)"));
  assert.match(touch, /pointer-events: auto/);
  assert.match(touch, /min-height: 44px !important/, "and they have to be big enough to hit");
});

test("the rename field fits the column it is in", async () => {
  // `width:100%` plus a 37px left margin overflowed by exactly 37px at every
  // width, and the rail scrolls, so the caret went off the edge while typing.
  const css = codeOnly(await source("app/(app)/portal/sidebar-nav.css"));
  const from = css.indexOf(".nav-rename--item");
  const rename = css.slice(from, css.indexOf("}", from));
  assert.match(rename, /width: calc\(100% - 37px\)/);
  assert.match(rename, /margin-left: 37px/, "the two must stay in step");
});

test("the section manager keeps to the agreed breakpoints", async () => {
  const css = await source("app/(app)/portal/section-manager.css");
  const widths = [...css.matchAll(/@media[^{]*?\(\s*(?:max|min)-width:\s*(\d+)px/g)].map(
    (m) => Number(m[1]),
  );
  assert.ok(widths.length > 0, "expected at least one media query");
  for (const width of widths) {
    assert.ok(
      [640, 767, 768, 1024, 1280].includes(width),
      `${width}px is not one of the agreed breakpoints`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* W02-10 — only authorised people change the structure               */
/* ------------------------------------------------------------------ */

test("W02-10 every structural write is gated on a capability, never on a role name", async () => {
  const route = codeOnly(await source("app/api/workspace-sections/route.ts"));
  for (const verb of ["POST", "PATCH", "DELETE"]) {
    const from = route.indexOf(`export async function ${verb}`);
    assert.ok(from > 0, `${verb} must exist`);
    const next = route.indexOf("export async function", from + 1);
    const handler = next === -1 ? route.slice(from) : route.slice(from, next);
    assert.match(
      handler,
      /scopedDbWithCapability\(request, "settings\.edit"\)/,
      `${verb} must be gated on the capability`,
    );
    const guardAt = handler.indexOf("scopedDbWithCapability");
    for (const write of [".insert(", ".update(", ".delete("]) {
      const writeAt = handler.indexOf(write);
      if (writeAt === -1) continue;
      assert.ok(writeAt > guardAt, `${verb} reaches ${write} before its capability check`);
    }
  }
  assert.doesNotMatch(
    route,
    /role === "(admin|super_admin)"/,
    "a role whose settings.edit was revoked in Roles is still called Admin",
  );
});

test("W02-10 an expired session is told to sign in, not told it made a bad request", async () => {
  // The GETs answered 401 {signIn:true} and the writes answered 400, and the
  // browser's guard bounces to /login only on the 401 — so a save made just
  // after a session lapsed failed silently.
  for (const path of [
    "app/api/workspace-sections/route.ts",
    "app/api/navigation/route.ts",
    "app/api/workspace-sections/view/route.ts",
  ]) {
    const text = codeOnly(await source(path));
    const catches = text.split("} catch (error) {").length - 1;
    const refusals = text.split("anonymousRefusal(error)").length - 1;
    assert.equal(
      refusals,
      catches,
      `${path}: ${catches} catch blocks but ${refusals} call anonymousRefusal`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Against a running server                                            */
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
    return (await call("/api/workspace-sections")).ok;
  } catch {
    return false;
  }
}

/* Its own key, so this file and `stage-twentythree-sections` can never sweep
   each other's fixture — the failure mode that has repeatedly produced wrong
   conclusions on this shared dev database. */
const KEY = "section:w2-regression";

async function sweep() {
  await call(`/api/workspace-sections?key=${KEY}`, { method: "DELETE" });
  await call(`/api/workspace-sections?key=${KEY}&purge=1`, { method: "DELETE" }, SUPER);
}

test("live: a description survives the round trip", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  await sweep();
  try {
    const created = await call("/api/workspace-sections", {
      method: "POST",
      body: JSON.stringify({
        key: KEY,
        label: "W2 Regression",
        description: "  Every camera,  and who last serviced it. ",
        icon: "camera",
        surface: "maintenance",
      }),
    });
    /* Read ONCE. `await created.text()` inside the assertion message consumed
       the body eagerly, so the `.json()` below threw "Body is unusable" and the
       test failed on its own plumbing rather than on the product. */
    const createdBody = await created.text();
    assert.equal(created.status, 201, createdBody);
    const { section } = JSON.parse(createdBody);
    assert.equal(
      section.description,
      "Every camera, and who last serviced it.",
      "cleaned on the way in, and returned",
    );

    const listed = await (await call("/api/workspace-sections")).json();
    const back = listed.sections.find((entry) => entry.key === KEY);
    assert.equal(back.description, "Every camera, and who last serviced it.");

    // Clearable, and an empty description is absent rather than "".
    const cleared = await call("/api/workspace-sections", {
      method: "PATCH",
      body: JSON.stringify({ key: KEY, description: "" }),
    });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).section.description, null);
  } finally {
    await sweep();
  }
});

test("live: a purge refuses a live section, and needs data.delete", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  await sweep();
  try {
    const created = await call("/api/workspace-sections", {
      method: "POST",
      body: JSON.stringify({ key: KEY, label: "W2 Regression", surface: "maintenance" }),
    });
    assert.equal(created.status, 201, await created.text());


    // A live section cannot be destroyed in one step, whoever asks.
    const early = await call(`/api/workspace-sections?key=${KEY}&purge=1`, { method: "DELETE" }, SUPER);
    assert.equal(early.status, 409, "a live section must be archived first");
    assert.match((await early.json()).error, /Remove it first/);

    // It is still there — the old code said "archived" here and wrote nothing.
    const midway = await (await call("/api/workspace-sections")).json();
    const row = midway.sections.find((entry) => entry.key === KEY);
    assert.ok(row && row.archived === false, "the refusal must not have changed anything");

    // Archive it. Now an admin may not purge it, because admin has no data.delete.
    assert.equal((await call(`/api/workspace-sections?key=${KEY}`, { method: "DELETE" })).status, 200);
    const asAdmin = await call(`/api/workspace-sections?key=${KEY}&purge=1`, { method: "DELETE" });
    assert.equal(asAdmin.status, 403, "settings.edit must not be able to destroy a section");
    assert.match((await asAdmin.json()).error, /data\.delete/);

    // And the refusal offers the reversible route rather than only saying no.
    const stillThere = await (await call("/api/workspace-sections")).json();
    assert.ok(stillThere.sections.some((entry) => entry.key === KEY && entry.archived));

    // A role that may purge, may.
    const purged = await call(`/api/workspace-sections?key=${KEY}&purge=1`, { method: "DELETE" }, SUPER);
    assert.equal(purged.status, 200, await purged.text());
    const after = await (await call("/api/workspace-sections")).json();
    assert.ok(!after.sections.some((entry) => entry.key === KEY), "and then it is gone");
  } finally {
    await sweep();
  }
});

test("live: a client may read the sections and change none of them", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const read = await call("/api/workspace-sections", {}, CLIENT);
  assert.equal(read.status, 200, "the sidebar has to be drawable by everybody");
  assert.equal((await read.json()).canEdit, false, "and it must say so rather than be discovered");

  for (const [method, path, body] of [
    ["POST", "/api/workspace-sections", { label: "W2 Client Attempt" }],
    ["PATCH", "/api/workspace-sections", { key: KEY, label: "renamed" }],
    ["DELETE", `/api/workspace-sections?key=${KEY}`, null],
    ["DELETE", `/api/workspace-sections?key=${KEY}&purge=1`, null],
  ]) {
    const response = await call(
      path,
      { method, ...(body ? { body: JSON.stringify(body) } : {}) },
      CLIENT,
    );
    assert.equal(response.status, 403, `${method} ${path} must be refused for a client`);
  }
});
