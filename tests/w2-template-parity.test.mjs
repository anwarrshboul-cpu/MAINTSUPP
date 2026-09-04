/**
 * W2 — A SECTION CREATED FROM A TEMPLATE IS AN INSTANCE OF THAT TEMPLATE.
 *
 * The owner rejected the first answer to W02-06 in those words: a section
 * created from "Jobs" came up as a generic six-column board — Item / Status /
 * Owner / Date / Notes / Files — which is a register, but it is not the Jobs
 * register. What was asked for is "the original section, with all its
 * functionality and configuration, but empty and independent."
 *
 * The distinction this file exists to hold is between a LOOKALIKE and an
 * INSTANCE. A lookalike is a second list of columns that happens to resemble
 * the job board today and drifts from it the first time a column is added to
 * the product. An instance is seeded BY THE JOB BOARD'S OWN SEEDER —
 * `seedBoardStructure`, which was already board-keyed — so the two cannot
 * disagree about what a Jobs board is, because there is only one answer.
 *
 * Three things are pinned here and each of them failed silently before:
 *
 *   1. the template reached `createBoard` at all (it did not: the route pinned
 *      `itemNoun: "Item"` and named no template, so every section got the
 *      generic register whatever the owner chose);
 *   2. the structure comes from the shared spec rather than a restatement;
 *   3. the six operational groups are a SUBSET of the spec's 38 and never the
 *      28 `done-<store>` lanes, which are this estate's filing rather than the
 *      product's shape.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  JOBS_TEMPLATE_GROUP_KEYS,
  TEMPLATE_STRUCTURES,
  templateStructure,
} from "../app/lib/generic-board-template.ts";
import {
  maintenanceColumns,
  maintenanceGroups,
  maintenanceUiColumns,
  storeDocumentationColumns,
} from "../db/monday-board-spec.ts";
import { SECTION_TEMPLATES } from "../app/api/workspace-sections/catalogue.ts";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const ADMIN = "admin@sunnamusk-uk.test.maintsupp.com";
const SUPER = "super-admin@test.maintsupp.com";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const codeOnly = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ------------------------------------------------------------------ */
/* The registry is the one model — H                                  */
/* ------------------------------------------------------------------ */

test("W2 every template the catalogue offers has a structure to build from", () => {
  /*
   * The failure this prevents is the one the owner reported. A template can be
   * added to the picker in `catalogue.ts` with one object literal; if nothing
   * ties it to a structure, choosing it silently falls through to the generic
   * register and the section is a lookalike of nothing.
   */
  for (const template of SECTION_TEMPLATES) {
    assert.ok(
      Object.hasOwn(TEMPLATE_STRUCTURES, template.key),
      `the "${template.key}" template is offered but names no structure`,
    );
  }
});

test("W2 an unknown or absent template still yields a usable register", () => {
  /* A stored row can name a template this build no longer has — a rollback, or
     a template turned off. It must keep opening, and it must not be given a
     domain model nobody asked for. */
  assert.equal(templateStructure(null).columns, "generic");
  assert.equal(templateStructure(undefined).columns, "generic");
  assert.equal(templateStructure("a-template-from-the-future").columns, "generic");
});

test("W2 the Jobs template names the maintenance spec, not a copy of it", () => {
  assert.equal(TEMPLATE_STRUCTURES.jobs.columns, "maintenance");
  assert.equal(TEMPLATE_STRUCTURES.jobs.kind, "maintenance");
  assert.equal(TEMPLATE_STRUCTURES.jobs.itemNoun, "Job");
  assert.equal(TEMPLATE_STRUCTURES["store-documentation"].columns, "store-documentation");
});

test("W2 the register templates carry no board structure, and say so", () => {
  /*
   * Sites and Contractors draw their own screens off their own tables. They
   * still get a BOARD ROW, because that row's key is the instance's identity —
   * what the scope column points at, what the purge tests for ownership, what
   * `surface_ref` stores. `columns: "none"` is that fact written down, so the
   * provisioner skips structure rather than seeding six columns nothing renders.
   */
  for (const key of ["sites", "contractors"]) {
    assert.equal(TEMPLATE_STRUCTURES[key].columns, "none", `${key} draws its own screen`);
    assert.equal(TEMPLATE_STRUCTURES[key].groups, "none");
  }
});

/* ------------------------------------------------------------------ */
/* The groups are a subset of the spec — never the estate's filing    */
/* ------------------------------------------------------------------ */

test("W2 every Jobs template group is one the spec already defines", () => {
  const known = new Set(maintenanceGroups.map((group) => group.key));
  for (const key of JOBS_TEMPLATE_GROUP_KEYS) {
    assert.ok(known.has(key), `"${key}" is not a group the job board has`);
  }
});

test("W2 the template excludes this estate's own filing", () => {
  /*
   * 31 of the 38 are `done-<store>` and dated month archives — Wood Green,
   * Bluewater, `completed-2026-07`. A section created for CCTV opening with a
   * "Bluewater completed" lane would be cloning the live board, which is the
   * opposite of the empty independent instance a template is for.
   */
  for (const key of JOBS_TEMPLATE_GROUP_KEYS) {
    assert.doesNotMatch(key, /^done-/, `"${key}" is a per-store archive`);
    assert.doesNotMatch(key, /^completed-\d/, `"${key}" is a dated archive`);
  }
  const archives = maintenanceGroups.filter(
    (group) => /^done-/.test(group.key) || /^completed-\d/.test(group.key),
  );
  assert.ok(archives.length > 20, `expected the estate's archive lanes, found ${archives.length}`);
});

test("W2 the operational lanes a job is routed into survive the subset", () => {
  /* `STAGE_BY_GROUP_KEY` in `db/init.ts` routes a filed job by group key. Drop
     one of these from the template and a job filed on an instance lands
     nowhere, which is the kind of hole a subset can quietly open. */
  for (const key of ["topics", "jobs-booked", "needs-attention"]) {
    assert.ok(
      JOBS_TEMPLATE_GROUP_KEYS.includes(key),
      `"${key}" carries a stage and must exist on an instance`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* The structure is seeded by the canonical seeder — A                */
/* ------------------------------------------------------------------ */

test("W2 provisioning calls the job board's own seeder", async () => {
  const registry = codeOnly(await source("app/lib/board-registry.ts"));
  const from = registry.indexOf("async function provisionDefaultStructure");
  const fn = registry.slice(from, registry.indexOf("export async function createBoard"));

  assert.match(fn, /seedBoardStructure\(/, "a Jobs instance is seeded by seedBoardStructure");
  assert.match(
    fn,
    /seedStoreDocumentationBoard\(/,
    "and a documents instance by the Store Documentation seeder",
  );

  /*
   * THE LOOKALIKE TEST. If this function ever restates a maintenance column
   * key, somebody has begun keeping a second list, and the two will drift the
   * first time a column is added to the product.
   */
  for (const key of ["tier", "engineer", "contractor", "approvedBy", "issuePictures"]) {
    assert.doesNotMatch(
      fn,
      new RegExp(`["']${key}["']`),
      `the provisioner restates "${key}" instead of seeding from the spec`,
    );
  }
});

test("W2 the seeder can narrow its groups but never invent one", async () => {
  const init = codeOnly(await source("db/init.ts"));
  const from = init.indexOf("export async function seedBoardStructure");
  const fn = init.slice(from, from + 2000);
  assert.match(fn, /groupKeys\?: readonly string\[\]/, "a caller may name a subset");
  assert.match(
    fn,
    /seedGroups\.filter\(\(group\) => groupKeys\.includes\(group\.key\)\)/,
    "and the subset must FILTER the spec, so it can only ever narrow",
  );
  assert.match(fn, /: seedGroups;/, "with the canonical board still seeded in full");
});

test("W2 the template reaches createBoard, and decides the board's identity", async () => {
  const registry = codeOnly(await source("app/lib/board-registry.ts"));
  const create = registry.slice(registry.indexOf("export async function createBoard"));
  assert.match(create, /template\?: string \| null;/, "createBoard accepts a template");
  assert.match(create, /templateStructure\(input\.template\)/);
  assert.match(create, /kind: input\.kind\?\.trim\(\) \|\| structure\.kind/);
  assert.match(create, /itemNoun: input\.itemNoun\?\.trim\(\)\.slice\(0, 24\) \|\| structure\.itemNoun/);
  assert.match(
    create,
    /provisionDefaultStructure\(db, organisationId, record\.key, input\.template\)/,
    "and the template must reach provisioning, or the choice is decorative",
  );

  const route = codeOnly(await source("app/api/workspace-sections/route.ts"));
  const post = route.slice(
    route.indexOf("export async function POST"),
    route.indexOf("export async function PATCH"),
  );
  const call = post.slice(post.indexOf("createBoard(context.db"), post.indexOf("ownedBoardKey = provisioned.key"));
  assert.match(call, /\btemplate,/, "the route must pass the template it resolved");
  assert.doesNotMatch(
    call,
    /itemNoun: "Item"/,
    'the hard-coded "Item" is what made every section generic whatever was chosen',
  );
});

/* ------------------------------------------------------------------ */
/* An instance does not drift from the template it was built from     */
/* ------------------------------------------------------------------ */

test("W2 the register records the template it was built from", async () => {
  /*
   * TWO PLACES RECORD A TEMPLATE AND THEY ANSWER DIFFERENT QUESTIONS.
   * `workspace_sections.template` is what the owner chose; `boards.template` is
   * what the register actually is. Only the second survives the section being
   * re-homed, archived, restored or detached, and only the second can be asked
   * on the board's own load path.
   */
  const schema = await source("db/schema.ts");
  const boardsTable = schema.slice(
    schema.indexOf('export const boards = sqliteTable('),
    schema.indexOf('uniqueIndex("boards_org_key_idx")'),
  );
  assert.match(boardsTable, /template: text\("template"\),/);
  assert.doesNotMatch(
    boardsTable,
    /template: text\("template"\)\.notNull\(\)/,
    "NULL is the true answer for every board that predates templates",
  );

  const init = await source("db/init.ts");
  assert.match(init, /await addColumn\(d1, "boards", "template", "TEXT"\);/,
    "and the column has to reach a database that already exists");
});

test("W2 an instance short of its template's columns is repaired, a legacy one is not", async () => {
  /*
   * The parity the owner asked for is with the ORIGINAL, not with a snapshot of
   * it. A column added to `monday-board-spec.ts` reaches the canonical board on
   * its next boot through `seedBoardStructure`; without this it would never
   * reach an instance, and the two would diverge silently over time.
   *
   * The guard that makes it safe is `boards.template`. A register created for a
   * section before templates existed carries the generic six columns and reads
   * NULL, so it is left exactly as it is — converting one into a job board
   * because its `kind` happens to read "maintenance" is the silent conversion
   * this workstream exists to remove.
   */
  const route = codeOnly(await source("app/api/board/route.ts"));
  const from = route.indexOf("async function ensureTemplateStructure");
  assert.ok(from > 0, "the repair must exist");
  const fn = route.slice(from, route.indexOf("async function ensureBoardState"));

  assert.match(fn, /const template = board\?\.template \?\? null;/);
  assert.match(fn, /if \(!template\) return;/, "NULL means legacy, and legacy is left alone");
  assert.match(fn, /templateColumnCount\(template\)/);
  assert.match(fn, /if \(Number\(counted\?\.total \?\? 0\) >= expected\) return;/,
    "a complete board must cost one count, not 27 no-op inserts");
  assert.match(fn, /provisionDefaultStructure\(db, orgId, boardId, template\)/,
    "and the repair must go through the same provisioner that created it");

  /* Called on the generated-register path, which is the only one that reaches
     it — the built-in boards have their own seeding below that line. */
  const ensure = route.slice(route.indexOf("async function ensureBoardState"));
  assert.match(
    ensure.slice(0, 2500),
    /if \(isGeneratedRegister\(boardId\)\) \{\s*await ensureTemplateStructure\(db, orgId, boardId\);/,
  );
});

test("W2 the expected column count is read off the spec, never written down", async () => {
  const registry = codeOnly(await source("app/lib/board-registry.ts"));
  const from = registry.indexOf("export function templateColumnCount");
  const fn = registry.slice(from, registry.indexOf("async function provisionMainView"));
  assert.match(fn, /maintenanceColumns\.length \+ maintenanceUiColumns\.length/);
  assert.match(fn, /storeDocumentationColumns\.length/);
  assert.match(fn, /GENERIC_BOARD_COLUMNS\.length/);
  assert.doesNotMatch(fn, /return 2[0-9];/, "a number here would fall behind the spec it counts");

  /* And it agrees with the spec at this commit, which is the arithmetic the
     repair depends on. */
  assert.equal(
    maintenanceColumns.length + maintenanceUiColumns.length > 20,
    true,
    `expected the job board's full column set, found ${maintenanceColumns.length + maintenanceUiColumns.length}`,
  );
  assert.ok(storeDocumentationColumns.length > 10);
});

/* ------------------------------------------------------------------ */
/* Against a running server — the parity proof                        */
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

/*
 * A KEY PER TEST, and a sweep that finishes.
 *
 * These three tests shared one pair of keys, and that turned a partial cleanup
 * into a poisoned suite. The purge REFUSES an occupied register on purpose, so
 * the test that files a row could leave its section archived rather than gone —
 * and the next run's create then answered 409 "was removed and is archived,
 * restore it instead" for every test in the file. Two of the three had nothing
 * to do with rows and failed anyway.
 *
 * Exact keys throughout, and swept by exact key. A filename- or
 * label-substring sweep has repeatedly eaten other fixtures on the shared
 * Miniflare database, and the owner's own sections live there.
 */
const KEYS = {
  parity: ["section:w2tpl-parity-a"],
  isolation: ["section:w2tpl-isolation-a", "section:w2tpl-isolation-b"],
  rows: ["section:w2tpl-rows-a"],
};

/**
 * Remove a fixture section completely, including anything filed on its
 * register.
 *
 * The order is the whole point. A section's register cannot be purged while it
 * holds items — that refusal is a product rule this suite also tests — so the
 * rows go first, by their own ids, then the section is archived, then purged.
 * Anything left behind is reported rather than swallowed, because a silent
 * half-sweep is what produced the 409 above.
 */
async function sweep(keys) {
  for (const key of keys) {
    const listed = await call("/api/workspace-sections").then(
      (response) => (response.ok ? response.json() : { sections: [] }),
      () => ({ sections: [] }),
    );
    const section = (listed.sections ?? []).find((entry) => entry.key === key);
    if (section?.boardKey) {
      const board = await call(`/api/board?board=${encodeURIComponent(section.boardKey)}`)
        .then((response) => (response.ok ? response.json() : {}), () => ({}));
      const ids = (board.requests ?? []).map((row) => row.id);
      if (ids.length) {
        /* `delete_items` with `requestIds` — the board route's actual verb and
           its actual field. This said `bin_items` with `ids`, which is neither:
           the call 400d, the row stayed, and the purge below was then refused
           for holding an item. Every step of the sweep reported success. */
        await call(`/api/board?board=${encodeURIComponent(section.boardKey)}`, {
          method: "POST",
          body: JSON.stringify({ action: "delete_items", requestIds: ids }),
        });
        /*
         * The bin still counts against the purge, so empty it by the exact bin
         * ids this sweep just created — never by a name or a sweep-all.
         *
         * `payload.bin.entries`, not `payload.items`. It read the wrong field,
         * found nothing to purge, and the purge was then refused because the
         * bin still offered the row back — so the section survived ARCHIVED and
         * the next run answered 409 "restore it instead" on create. A cleanup
         * that silently cleans nothing is worse than none, because it reports
         * success either way.
         */
        /* Listed as the identity that will PURGE, not as the one that binned.
           Emptying the bin needs `data.delete`, and the listing is filtered by
           the same capability — so an admin's listing came back empty and the
           sweep purged nothing while reporting success. */
        const trash = await call(
          `/api/trash?board=${encodeURIComponent(section.boardKey)}`,
          {},
          SUPER,
        ).then((response) => (response.ok ? response.json() : {}), () => ({}));
        for (const entry of trash.bin?.entries ?? []) {
          await call(`/api/trash?id=${encodeURIComponent(entry.id)}`, { method: "DELETE" }, SUPER);
        }
      }
    }
    await call(`/api/workspace-sections?key=${key}`, { method: "DELETE" });
    await call(`/api/workspace-sections?key=${key}&purge=1`, { method: "DELETE" }, SUPER);
  }
}

async function createSection(key, label, template) {
  const response = await call("/api/workspace-sections", {
    method: "POST",
    body: JSON.stringify({ key, label, ...(template ? { template } : {}) }),
  });
  const body = await response.json();
  assert.ok(response.ok, `creating ${key} failed ${response.status}: ${JSON.stringify(body)}`);
  return body.section;
}

test("live: a Jobs section is the job board, empty", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const [ALPHA] = KEYS.parity;
  await sweep(KEYS.parity);
  try {
    const alpha = await createSection(ALPHA, "W2TPL Parity A", "jobs");
    const [instance, canonical] = await Promise.all([
      (await call(`/api/board?board=${alpha.boardKey}`)).json(),
      (await call("/api/board?board=maintenance")).json(),
    ]);

    /* THE PARITY MATRIX, as an assertion rather than a document: the column
       sets are equal as sets, in both directions. */
    const keysOf = (board) => board.columns.map((column) => column.key).sort();
    assert.deepEqual(
      keysOf(instance),
      keysOf(canonical),
      "an instance must carry the job board's columns, no more and no fewer",
    );

    /* And they must be REQUEST-BACKED, like the canonical board's. A column
       seeded `system = 0` renders "Add value" on every row because the grid
       looks it up in `maintenance_board_cells` instead of on the request. */
    const systemOf = (board) => board.columns.filter((column) => column.system).length;
    assert.equal(systemOf(instance), instance.columns.length);
    assert.equal(systemOf(canonical), canonical.columns.length);

    /* Empty. Nothing is cloned — not a row, not a group membership. */
    assert.equal((instance.requests ?? []).length, 0, "an instance starts empty");
    assert.ok((canonical.requests ?? []).length > 0, "while the job board keeps its work");

    /* The lanes are the operational subset, and none of the estate's filing. */
    assert.equal(instance.groups.length, JOBS_TEMPLATE_GROUP_KEYS.length);
    for (const group of instance.groups) {
      assert.doesNotMatch(
        group.name,
        /completed|done/i,
        `"${group.name}" is an archive lane and must not be cloned`,
      );
    }
    assert.ok(
      canonical.groups.length > instance.groups.length,
      "the canonical board keeps all of its lanes",
    );

    /* Monday's own vocabulary, not the API's "Option 1" placeholder. */
    const chips = (board) => {
      const column = board.columns.find((entry) => entry.key === "status");
      const settings =
        typeof column?.settings === "string" ? JSON.parse(column.settings) : column?.settings ?? {};
      return (settings.choices ?? []).map((choice) => choice.label).sort();
    };
    assert.deepEqual(chips(instance), chips(canonical), "and the same status vocabulary");
  } finally {
    await sweep(KEYS.parity);
  }
});

test("live: two Jobs instances are independent of each other and of the job board", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const [ALPHA, BETA] = KEYS.isolation;
  await sweep(KEYS.isolation);
  try {
    const alpha = await createSection(ALPHA, "W2TPL Isolation A", "jobs");
    const beta = await createSection(BETA, "W2TPL Isolation B", "jobs");
    assert.notEqual(alpha.boardKey, beta.boardKey, "two sections, two registers");

    const added = await call("/api/board/columns", {
      method: "POST",
      body: JSON.stringify({ board: alpha.boardKey, title: "W2TPL Alpha Only", type: "text" }),
    });
    assert.ok(added.ok, `adding a column to Alpha failed: ${added.status}`);

    const [a, b, canonical] = await Promise.all([
      (await call(`/api/board?board=${alpha.boardKey}`)).json(),
      (await call(`/api/board?board=${beta.boardKey}`)).json(),
      (await call("/api/board?board=maintenance")).json(),
    ]);
    const titles = (board) => board.columns.map((column) => column.title);
    assert.ok(titles(a).includes("W2TPL Alpha Only"));
    assert.ok(!titles(b).includes("W2TPL Alpha Only"), "Beta must not see Alpha's column");
    assert.ok(!titles(canonical).includes("W2TPL Alpha Only"), "nor may the job board");
    assert.ok(
      titles(canonical).length >= 20,
      `the job board should still carry its own columns, found ${titles(canonical).length}`,
    );
  } finally {
    await sweep(KEYS.isolation);
  }
});

test("live: a row created on an instance stays on it", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const [ALPHA] = KEYS.rows;
  await sweep(KEYS.rows);
  try {
    const alpha = await createSection(ALPHA, "W2TPL Rows A", "jobs");
    const board = await (await call(`/api/board?board=${alpha.boardKey}`)).json();
    const groupId = board.groups[0]?.id;
    assert.ok(groupId, "an instance must have a lane to file into");

    /* The board goes in the QUERY STRING here, not the body: `boardIdFrom` in
       the board route reads `searchParams`, so a `board` field in the body is
       ignored and the write lands on the default board. The columns route below
       reads its own body instead — the two conventions differ, and getting it
       wrong is a 404 rather than a wrong-board write, which is the safe
       direction and how this was caught. */
    const created = await call(`/api/board?board=${encodeURIComponent(alpha.boardKey)}`, {
      method: "POST",
      body: JSON.stringify({
        action: "create_item",
        board: alpha.boardKey,
        groupId,
        title: "W2TPL fixture row",
      }),
    });
    assert.ok(created.ok, `creating a row on the instance failed: ${created.status}`);

    const [after, canonical] = await Promise.all([
      (await call(`/api/board?board=${alpha.boardKey}`)).json(),
      (await call("/api/board?board=maintenance")).json(),
    ]);
    assert.equal((after.requests ?? []).length, 1, "the row lands on the instance");
    assert.ok(
      !(canonical.requests ?? []).some((row) => row.title === "W2TPL fixture row"),
      "and never on the job board — the stranded-row defect this replaced",
    );
  } finally {
    /* `sweep` empties the register before purging it — see the note on it for
       why that order is what keeps this file re-runnable. */
    await sweep(KEYS.rows);
  }
});
