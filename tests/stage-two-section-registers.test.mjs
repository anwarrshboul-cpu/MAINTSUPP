/**
 * W02-06 — a new platform section gets its OWN register.
 *
 * The owner's decision, and it reverses what this endpoint originally did: a
 * section used to name one of eight EXISTING screens, so "CCTV" and "Jobs" drew
 * the same board and showed the same rows. "Automatically generate the same
 * default page structure used by the existing sections" is not met by pointing
 * at somebody else's page.
 *
 * Three defects had to be fixed before independence was even observable, and
 * each of them failed SILENTLY — which is why they are pinned here rather than
 * left to the fact that the feature works today:
 *
 *   1. `boardIdFrom` in the board route was an allow-list of two. Every other
 *      key was answered with the JOB BOARD — its columns, its groups and all of
 *      its rows — under whatever key was asked for. A register created for a
 *      section therefore drew maintenance, and a row created "on" it was filed
 *      into a maintenance group.
 *   2. The browser never read `workspace_sections.surface_ref`. The board was
 *      mounted with no `boardId` at all, so it defaulted to "maintenance"
 *      whatever the section was bound to.
 *   3. `ensureBoardState` would have furnished any board it was given with the
 *      26 maintenance columns and `seedRequestsIfEmpty`'s sample jobs.
 *
 * The live half creates two sections and proves the two registers cannot see
 * each other. It skips cleanly with no server and removes what it makes.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GENERIC_BOARD_COLUMNS,
  GENERIC_BOARD_GROUPS,
  GENERIC_STATUS_CHOICES,
} from "../app/lib/generic-board-template.ts";
import { boardIdentity } from "../app/(app)/portal/board-identity.ts";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const ADMIN = "admin@sunnamusk-uk.test.maintsupp.com";
const CLIENT = "client@sunnamusk-uk.test.maintsupp.com";
const SUPER = "super-admin@test.maintsupp.com";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const codeOnly = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ------------------------------------------------------------------ */
/* The template is generic, deterministic and renderable              */
/* ------------------------------------------------------------------ */

test("W02-06 the default register is generic — no domain column reaches it", () => {
  const keys = GENERIC_BOARD_COLUMNS.map((column) => column.key);
  const titles = GENERIC_BOARD_COLUMNS.map((column) => column.title);

  assert.ok(keys.includes("name"), "a register needs the row's own title");
  assert.ok(GENERIC_BOARD_COLUMNS.length >= 5 && GENERIC_BOARD_COLUMNS.length <= 8,
    `expected a small starter set, found ${GENERIC_BOARD_COLUMNS.length}`);

  /*
   * The checklist says the register must be generic. These are the names that
   * would mean the Maintenance or Store Documentation spec had been copied in —
   * a data model for work nobody described.
   */
  const domain = /tier|engineer|contractor|priority|site|store|invoice|approved|pat|insurance|expiry|compliance/i;
  for (const name of [...keys, ...titles]) {
    assert.doesNotMatch(name, domain, `"${name}" is a domain field, not a generic one`);
  }
});

test("W02-06 every default column is a type the GRID renders", () => {
  /*
   * The product has two column vocabularies and they do not map: `POST
   * /api/board/columns` validates against `column-types.ts` (`single_select`,
   * `person`, `file`) while `columnPayload` in the board route serialises
   * anything outside `BOARD_COLUMN_TYPES` as plain `text`. The first cut of the
   * template used the first vocabulary, and every column came back to the
   * browser as a text box — rendering, but not the column it claimed to be.
   */
  const rendered = new Set([
    "status", "dropdown", "text", "long_text", "date", "people", "number",
    "files", "timeline", "checkbox", "email", "phone", "link", "subitems",
  ]);
  for (const column of GENERIC_BOARD_COLUMNS) {
    assert.ok(rendered.has(column.type), `"${column.type}" is not a type the grid draws`);
  }
});

test("W02-06 only the row's own title is request-backed", () => {
  /*
   * `systemCell` in live-board.tsx has a case for the 26 maintenance keys and
   * for nothing else, so a generic column marked `system` would render blank
   * for ever with no cell behind it. Name is the exception on every board in
   * this product — Store Documentation is cell-backed for all twelve of its
   * columns and still takes Name off the request.
   */
  const system = GENERIC_BOARD_COLUMNS.filter((column) => column.system === true);
  assert.deepEqual(system.map((column) => column.key), ["name"]);
});

test("W02-06 the status column does not borrow the maintenance option path", () => {
  /*
   * `optionColumns` in the board route treats the KEY `status` as one of the
   * five request-backed maintenance columns whose choices come from
   * `maintenance_board_options`. A generated register has no rows in that
   * table, so a column keyed `status` would draw an empty vocabulary. It is
   * keyed `state` and carries its choices in its own settings.
   */
  const status = GENERIC_BOARD_COLUMNS.find((column) => column.title === "Status");
  assert.ok(status, "the template should offer a status column");
  assert.notEqual(status.key, "status", "that key is claimed by the maintenance board");
  assert.deepEqual(status.settings?.choices, GENERIC_STATUS_CHOICES);
  assert.ok(GENERIC_STATUS_CHOICES.length >= 3);
  for (const choice of GENERIC_STATUS_CHOICES) {
    assert.match(choice.color, /^#[0-9a-f]{6}$/i);
  }
});

test("W02-06 the template is deterministic, not a copy of a live board", async () => {
  /* A live board is mutable: deleting a column on Maintenance would otherwise
     change what every future section is born with. */
  const template = await source("app/lib/generic-board-template.ts");
  assert.doesNotMatch(template, /\bselect\(|\bfrom\(|db\./, "the template must not read the database");
  assert.doesNotMatch(
    codeOnly(template),
    /monday-board-spec|maintenanceColumns|storeDocumentationColumns/,
    "the template must not import the domain specs",
  );
  assert.ok(GENERIC_BOARD_GROUPS.length >= 2, "a register needs somewhere to file a row");
});

/* ------------------------------------------------------------------ */
/* The three silent failures                                          */
/* ------------------------------------------------------------------ */

test("W02-06 the board route resolves a board from the database, not an allow-list", async () => {
  const route = codeOnly(await source("app/api/board/route.ts"));
  const from = route.indexOf("async function boardIdFrom");
  assert.notEqual(from, -1, "boardIdFrom must still exist");
  const fn = route.slice(from, from + 700);

  assert.match(fn, /resolveBoard\(db, orgId, raw\)/, "the database decides which boards exist");
  assert.doesNotMatch(
    fn,
    /\?\s*\(raw as BoardId\)\s*:\s*DEFAULT_BOARD_ID/,
    "the silent fallback to the job board is the defect; it must not come back",
  );
  /* And an unknown board is a 404 rather than the 503 the generic handler gives. */
  assert.match(route, /isBoardNotFound\(error\)/);
  assert.match(route, /status: 404/);
});

test("W02-06 a generated register is not given the maintenance spec", async () => {
  const route = codeOnly(await source("app/api/board/route.ts"));
  const from = route.indexOf("async function ensureBoardState");
  const fn = route.slice(from, from + 1600);
  const guard = fn.indexOf("isGeneratedRegister(boardId)");
  const seed = fn.indexOf("seedRequestsIfEmpty");
  assert.ok(guard > 0, "ensureBoardState must recognise a generated register");
  assert.ok(
    seed > guard,
    "it must return before seeding maintenance columns and sample jobs into it",
  );
});

test("W02-06 the browser draws the board the section names", async () => {
  /*
   * RE-POINTED, AND THE CONTRACT GOT STRONGER.
   *
   * This pinned `boardId={activeCustom?.boardKey ?? "maintenance"}`, which was
   * right about the thing it was written for — `surface_ref` was stored and
   * returned for a year and never read — and wrong about the fallback. A
   * section detached from its register has a NULL `boardKey`, and `?? "maintenance"`
   * made it render the canonical job board: 74 rows of somebody else's work
   * under the section's own name. That is the substitution this workstream
   * exists to remove, and it was still in the mount.
   *
   * The section still draws the board it names. A section that names none now
   * says so instead of borrowing one.
   */
  const portal = await source("app/(app)/portal/portal-app.tsx");
  assert.match(
    portal,
    /boardId=\{activeCustom \? activeCustom\.boardKey \?\? "" : "maintenance"\}/,
    "an instance draws its own register; a built-in section draws the default board",
  );
  assert.match(portal, /boardKey\?: string \| null;/, "and the entry type has to carry it");
  assert.match(
    portal,
    /const sectionDetached =/,
    "a section with no register must be recognised, not defaulted",
  );
  assert.match(
    portal,
    /\{activeSurface === "maintenance" && !sectionDetached && \(/,
    "and it must keep the board out of the tree rather than draw the canonical one",
  );
});

test("W02-06 an unknown board does not describe itself as the job board", () => {
  const generic = boardIdentity("a-board-created-at-runtime");
  const maintenance = boardIdentity("maintenance");
  assert.notEqual(generic.eyebrow, maintenance.eyebrow);
  assert.doesNotMatch(generic.eyebrow, /maintenance/i);
  assert.doesNotMatch(generic.itemNoun, /job|maintenance/i);
});

test("W02-06 a failed placement does not strand a row on the job board", async () => {
  /*
   * `maintenance_requests` carries no board id — placement decides — and the
   * board route files an UNPLACED row into the default board's first group. So
   * a placement that throws after the request row is committed does not lose
   * the row; it puts it on the JOB BOARD, belonging to nobody. Six appeared
   * that way while this was being built.
   */
  const mutations = codeOnly(await source("app/lib/board-mutations.ts"));
  const from = mutations.indexOf("insert(maintenanceGroupItems)");
  const block = mutations.slice(from - 300, from + 900);
  assert.match(block, /catch \(error\)/, "the placement must be attempted, not assumed");
  assert.match(block, /\.delete\(maintenanceRequests\)/, "and its failure must undo the row");
  assert.match(block, /throw error/, "while still surfacing the real failure");
});

/* ------------------------------------------------------------------ */
/* Destruction protects the work                                      */
/* ------------------------------------------------------------------ */

test("W02-06 purging a section removes configuration, never items", async () => {
  const registry = codeOnly(await source("app/lib/board-registry.ts"));
  const from = registry.indexOf("export async function deleteBoardStructure");
  const fn = registry.slice(from, registry.indexOf("export async function boardItemCount"));

  assert.match(fn, /\.delete\(maintenanceBoardColumns\)/, "its columns");
  assert.match(fn, /\.delete\(maintenanceGroups\)/, "its groups");
  assert.match(fn, /\.delete\(boardViews\)/, "its views");
  assert.match(fn, /\.delete\(boards\)/, "and the board row");

  /* THE RULE. Nothing that exists independently of this board may be deleted
     because a menu entry was removed. */
  for (const table of [
    "maintenanceRequests", "attachments", "sites", "contractors",
    "maintenanceBoardCells", "itemUpdates",
  ]) {
    assert.doesNotMatch(
      fn,
      new RegExp(`\\.delete\\(${table}\\)`),
      `${table} holds records this board does not own`,
    );
  }
});

test("W02-06 an occupied register refuses to be destroyed", async () => {
  const route = codeOnly(await source("app/api/workspace-sections/route.ts"));
  const del = route.slice(route.indexOf("export async function DELETE"));
  assert.match(del, /boardItemCount\(context\.db, context\.orgId, ownedBoard\)/);
  assert.match(del, /if \(items > 0\)/, "an occupied register must be refused");
  assert.match(del, /status: 409/);
  /* A board another section still uses is shared in fact, whoever made it. */
  assert.match(del, /section\.boardKey === ownedBoard/, "a shared register must survive");
  /* And the product's own screens can never be taken by a section. */
  assert.match(route, /BUILT_IN_BOARD_KEYS/);
  assert.match(
    route,
    /SECTION_SURFACES\.flatMap/,
    "the built-in set is derived from the surfaces, not written out",
  );
});

test("W02-06 creating a section is board-first so a failure leaves nothing navigable", async () => {
  const route = codeOnly(await source("app/api/workspace-sections/route.ts"));
  const post = route.slice(
    route.indexOf("export async function POST"),
    route.indexOf("export async function PATCH"),
  );
  const board = post.indexOf("createBoard(context.db");
  const section = post.indexOf("insert(workspaceSections)");
  assert.ok(board > 0 && section > board, "the register is created before the section");
  assert.match(post, /deleteBoardStructure\(context\.orgId|deleteBoardStructure\(context\.db/,
    "and a failed section insert removes the board it made");
});

/* ------------------------------------------------------------------ */
/* Against a running server — the independence proof                  */
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

const A = "section:w0206t-alpha";
const B = "section:w0206t-beta";

async function sweep() {
  for (const key of [A, B]) {
    await call(`/api/workspace-sections?key=${key}`, { method: "DELETE" });
    await call(`/api/workspace-sections?key=${key}&purge=1`, { method: "DELETE" }, SUPER);
  }
}

test("live: two sections get two registers that cannot see each other", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  await sweep();
  try {
    const alpha = await (
      await call("/api/workspace-sections", {
        method: "POST",
        body: JSON.stringify({ key: A, label: "W0206T Alpha" }),
      })
    ).json();
    const beta = await (
      await call("/api/workspace-sections", {
        method: "POST",
        body: JSON.stringify({ key: B, label: "W0206T Beta" }),
      })
    ).json();

    assert.equal(alpha.section?.ownsBoard, true, "a new section owns its register");
    assert.notEqual(alpha.section.boardKey, "maintenance", "and it is not the job board");
    assert.notEqual(
      alpha.section.boardKey,
      beta.section.boardKey,
      "two sections must not share one register",
    );

    /*
     * RE-POINTED, AND THE CONTRACT MOVED WITH THE PRODUCT.
     *
     * This asserted the generic six-column register, which was right for what
     * `POST` did when it was written: every section got `GENERIC_BOARD_COLUMNS`
     * whatever the owner had chosen. The owner rejected exactly that — a
     * section created from "Jobs" is supposed to be "the original section, with
     * all its functionality and configuration, but empty and independent", and
     * a six-column board named Item / Status / Owner / Date / Notes / Files is
     * not the Jobs register.
     *
     * A section created without naming a template is a `DEFAULT_TEMPLATE`
     * instance, and that is Jobs, so the structure to expect here is the job
     * board's own. What this test is FOR is unchanged and is still checked
     * below: the register is the section's own, and nothing leaks between it
     * and the board it was shaped from.
     *
     * The generic template has not gone anywhere — it is what a stored row
     * naming an unknown template still yields, which the pure tests above pin
     * through `GENERIC_BOARD_COLUMNS` and `GENERIC_BOARD_GROUPS` directly.
     * `tests/w2-template-parity.test.mjs` holds the parity half.
     */
    const boardA = await (await call(`/api/board?board=${alpha.section.boardKey}`)).json();
    const canonicalNow = await (await call("/api/board?board=maintenance")).json();
    assert.deepEqual(
      boardA.columns.map((column) => column.key).sort(),
      canonicalNow.columns.map((column) => column.key).sort(),
      "a section created without a template is a Jobs instance, and carries its columns",
    );
    assert.ok(
      boardA.groups.length > 0 && boardA.groups.length < canonicalNow.groups.length,
      "with the template's operational lanes rather than the estate's whole filing",
    );
    assert.equal((boardA.requests ?? []).length, 0, "and it starts empty");

    /* CONFIGURATION ISOLATION — the property the whole decision rests on. */
    const added = await call("/api/board/columns", {
      method: "POST",
      body: JSON.stringify({ board: alpha.section.boardKey, title: "Alpha Only", type: "text" }),
    });
    assert.ok(added.ok, `adding a column to A failed: ${added.status}`);

    const [afterA, afterB, afterMaint] = await Promise.all([
      (await call(`/api/board?board=${alpha.section.boardKey}`)).json(),
      (await call(`/api/board?board=${beta.section.boardKey}`)).json(),
      (await call("/api/board?board=maintenance")).json(),
    ]);
    const titles = (board) => board.columns.map((column) => column.title);
    assert.ok(titles(afterA).includes("Alpha Only"));
    assert.ok(!titles(afterB).includes("Alpha Only"), "B must not see A's column");
    assert.ok(!titles(afterMaint).includes("Alpha Only"), "nor may the job board");

    /* And the job board kept its own structure throughout. */
    assert.ok(
      titles(afterMaint).length >= 20,
      `the job board should still carry its own columns, found ${titles(afterMaint).length}`,
    );
  } finally {
    await sweep();
  }
});

test("live: an unknown board is refused rather than answered with the job board", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const response = await call("/api/board?board=no-such-register-anywhere");
  assert.equal(response.status, 404, "the silent substitution was the defect");
  const maintenance = await (await call("/api/board?board=maintenance")).json();
  assert.ok(maintenance.columns.length >= 20, "while the real board still answers");
});

test("live: a client cannot create a section, and so cannot create a board", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const before = await (await call("/api/board/items?board=maintenance&limit=1")).json().catch(() => ({}));
  const refused = await call(
    "/api/workspace-sections",
    { method: "POST", body: JSON.stringify({ key: "section:w0206t-client", label: "W0206T Client" }) },
    CLIENT,
  );
  assert.equal(refused.status, 403, "no board may be created before the permission check passes");
  const listed = await (await call("/api/workspace-sections", {}, CLIENT)).json();
  assert.ok(
    !(listed.sections ?? []).some((section) => section.key === "section:w0206t-client"),
    "and nothing was written",
  );
  assert.ok(before !== undefined);
});
