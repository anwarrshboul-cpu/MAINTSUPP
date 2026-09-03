/**
 * W2 — A SECTION'S NAME IS NOT ITS IDENTITY, and deleting one gives the name back.
 *
 * THE OWNER'S REPRODUCTION. Create a section called "test". Remove it. Remove it
 * permanently. Create "test" again — refused, with no way from the screen to see
 * why. Two defects met to produce that, and either alone would have hidden the
 * other:
 *
 *   1. `createBoard` keyed a board `slugifyKey(name)`, so the DISPLAY NAME was
 *      the address. A board that outlived its section held its name for ever.
 *   2. `PATCH { surface }` re-resolved `surface_ref` against the new surface,
 *      and `resolveSurfaceRef` answers `{ boardKey: null }` for a surface with
 *      no board of its own. Changing a section's screen therefore NULLED the
 *      column that said which register it owned — silently. The purge's
 *      ownership test reads that same column, so the deletion then took nothing
 *      with it and the board survived. Board `test` is still on Staging with 6
 *      columns, 3 groups, 1 view, 0 items and 0 sections pointing at it, and the
 *      audit trail shows four `workspace.section_updated` events on
 *      `section:test` between 17:22 and 17:25 before the purge at 17:26.
 *
 * The fix is both halves: the board key is generated from the instance
 * (`sec-<12hex>`), and a section that is the last one opening its register can
 * no longer be re-homed at all. The live half of this file is the owner's
 * reproduction, run end to end.
 *
 * It skips cleanly with no server. Fixtures are prefixed `S1QA-` and are swept
 * BY EXACT KEY — never by substring, which has eaten other lanes' fixtures on
 * this shared database before.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * `board-registry.ts` is deliberately NOT imported.
 *
 * It imports `../../db/schema` without a file extension, which `node --test`
 * cannot resolve — it strips types rather than compiling. Every other test in
 * this suite reads that file as source for the same reason. So the board-key
 * contract is held here two ways: a source pin on the line the bug lived on,
 * and the live tests at the bottom, which assert the shape the real endpoint
 * hands back. `slugFromLabel` below is the catalogue's copy of the identical
 * transform `slugifyKey` applies, which is precisely why a label could serve as
 * a board address in the first place.
 */
import {
  DEFAULT_TEMPLATE,
  SECTION_SURFACES,
  SECTION_TEMPLATES,
  isChoosableTemplate,
  isTemplateKey,
  slugFromLabel,
  templateDefinition,
} from "../app/api/workspace-sections/catalogue.ts";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const ADMIN = "admin@sunnamusk-uk.test.maintsupp.com";
/* Purging needs `data.delete`, which `admin` is deliberately not given. */
const SUPER = "super-admin@test.maintsupp.com";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const codeOnly = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ------------------------------------------------------------------ */
/* R1 — the key is generated, and it is not the name                  */
/* ------------------------------------------------------------------ */

test("W2 R1 a display name is not an address — three labels, one key", () => {
  /*
   * The defect in one line. Under `slugifyKey(name)` these three labels reduce
   * to ONE board address, so the second section by any of them was refused by
   * `createBoard`'s clash check — and the owner had no way to learn that the
   * thing in the way was a board they had already deleted the section for.
   *
   * `slugFromLabel` is the catalogue's copy of the same transform; the board
   * registry's `slugifyKey` is character-for-character identical, which is what
   * made a label usable as an address at all.
   */
  const collide = ["test", "Test", "TEST"];
  const slugs = new Set(collide.map((name) => slugFromLabel(name)));
  assert.equal(slugs.size, 1, "these all reduce to one key — that WAS the identity");
  assert.equal([...slugs][0], "test");

  /*
   * What is still name-derived, and correctly so: the SECTION key. It is the
   * ROUTE — `/dashboard/s/test` — and is immutable after creation, which is why
   * it may be a slug. The BOARD key is not, and that separation is the whole
   * fix: the live twin test below creates two sections under one label and gets
   * two registers, which was impossible while the two keys were the same idea.
   */
  assert.equal(slugFromLabel("S1QA Twin"), "s1qa-twin");
});

test("W2 R1 the generator and its recogniser agree on one shape", async () => {
  /*
   * A SOURCE PIN. `board-registry.ts` cannot be imported here (see the note at
   * the top), and the shape is a real contract: `db/init.ts`'s boot repair
   * excludes `sec-%` precisely because that is what this build creates, so a
   * generator that stopped producing the prefix would quietly re-arm a sweep
   * against live boards. Twelve hex characters, one prefix, both sides.
   */
  const registry = await source("app/lib/board-registry.ts");
  assert.match(registry, /export const SECTION_BOARD_PREFIX = "sec-";/);
  assert.match(
    registry,
    /crypto\.randomUUID\(\)\.replace\(\/-\/g, ""\)\.slice\(0, 12\)/,
    "the key is random, not derived",
  );
  assert.match(registry, /\[0-9a-f\]\{12\}\$/, "and the recogniser pins the same shape");
});

test("W2 R1 createBoard does not read the name to decide the address", async () => {
  /*
   * A SOURCE PIN, because the runtime observable — "two boards with one name" —
   * needs a database. It protects the exact line the bug lived on. If
   * `createBoard` moves, re-point this at its new home; the contract is that
   * the key comes from `input.key` or a generator, never from `input.name`.
   */
  const registry = codeOnly(await source("app/lib/board-registry.ts"));
  const from = registry.indexOf("export async function createBoard");
  assert.notEqual(from, -1, "createBoard must still exist");
  const fn = registry.slice(from, registry.indexOf("export async function renameBoard"));

  assert.doesNotMatch(
    fn,
    /const key = slugifyKey\(name\)/,
    "keying a board by its display name is the defect; it must not come back",
  );
  assert.match(fn, /newSectionBoardKey\(\)/, "the key is generated");
  assert.match(fn, /input\.key \? slugifyKey\(input\.key\)/, "or supplied explicitly");
});

/* ------------------------------------------------------------------ */
/* Templates — offered only when they are real                        */
/* ------------------------------------------------------------------ */

test("W2 every template names a surface this product actually has", () => {
  const surfaces = new Set(SECTION_SURFACES.map((surface) => surface.key));
  assert.ok(SECTION_TEMPLATES.length >= 2, "a chooser needs something to choose between");
  for (const template of SECTION_TEMPLATES) {
    assert.ok(
      surfaces.has(template.surface),
      `template "${template.key}" renders "${template.surface}", which is not a surface`,
    );
    assert.ok(template.label && template.description, `"${template.key}" needs its words`);
  }
});

test("W2 §8 an unavailable template says why, and cannot be chosen", () => {
  /*
   * "Do NOT present clickable fake options." A template the product cannot yet
   * give an INDEPENDENT instance is drawn so the owner can see it exists, and
   * carries the reason it is not on offer — an unavailable entry with no reason
   * is a dead control, which is the thing the rule is about.
   */
  for (const template of SECTION_TEMPLATES) {
    if (template.available) {
      assert.equal(template.unavailable, undefined, `"${template.key}" is available`);
      assert.ok(isChoosableTemplate(template.key));
    } else {
      assert.ok(
        typeof template.unavailable === "string" && template.unavailable.length > 20,
        `"${template.key}" is off and must say why`,
      );
      assert.equal(
        isChoosableTemplate(template.key),
        false,
        `"${template.key}" must not be choosable`,
      );
      /* Still a template the server RECOGNISES: a stored row naming it keeps
         working, which is what separates "not on offer" from "invalid". */
      assert.ok(isTemplateKey(template.key));
    }
  }
  assert.ok(
    SECTION_TEMPLATES.some((template) => template.available),
    "at least one template has to work, or Add creates nothing",
  );
});

test("W2 the default template is one that can actually be chosen", () => {
  assert.ok(isChoosableTemplate(DEFAULT_TEMPLATE));
  assert.equal(templateDefinition(DEFAULT_TEMPLATE)?.available, true);
  assert.equal(isTemplateKey("no-such-template"), false);
});

/* ------------------------------------------------------------------ */
/* The surface change that produced the orphan                        */
/* ------------------------------------------------------------------ */

test("W2 a section that owns its register cannot be re-homed", async () => {
  /*
   * A source pin on the guard itself. The live test below proves the 409; this
   * proves the guard is reached BEFORE `patch.surfaceRef` is assigned, which is
   * the ordering that makes it impossible to null the column on the way past.
   */
  const route = codeOnly(await source("app/api/workspace-sections/route.ts"));
  const patch = route.slice(
    route.indexOf("export async function PATCH"),
    route.indexOf("async function recordSectionChange"),
  );
  const guard = patch.indexOf("const rehoming =");
  const write = patch.indexOf("patch.surfaceRef = board.boardKey");
  assert.ok(guard > 0, "the re-home guard must exist");
  assert.ok(write > guard, "and it must run before surface_ref can be rewritten");
  assert.match(patch, /ownsBoard: true/, "the refusal has to say what it is protecting");
  assert.match(patch, /status: 409/);

  /* Re-homing a LEGACY second door is the reason the control exists, and a
     board somebody else also opens is not stranded by one section leaving. */
  assert.match(
    patch,
    /section\.boardKey === ownedBoard/,
    "only the LAST section on a register is pinned",
  );
});

test("W2 a template is recorded on creation and is not an editable field", async () => {
  const route = codeOnly(await source("app/api/workspace-sections/route.ts"));
  const patch = route.slice(
    route.indexOf("export async function PATCH"),
    route.indexOf("async function recordSectionChange"),
  );
  assert.match(
    patch,
    /body\.template !== undefined/,
    "a PATCH naming a template must be refused, not silently ignored",
  );
  assert.match(patch, /cannot be changed after it is created/);
});

/* ------------------------------------------------------------------ */
/* The purge is complete                                              */
/* ------------------------------------------------------------------ */

test("W2 §29 the purge and the boot repair delete the same board-scoped tables", async () => {
  /*
   * TWO LISTS, HELD EQUAL HERE.
   *
   * `deleteBoardStructure` speaks drizzle; `repairOrphanedSectionBoards` in
   * `db/init.ts` is dialect-shared raw SQL that runs before any of it is
   * loaded, so the table list genuinely has to exist twice. This is what stops
   * the second copy becoming a quieter, staler definition of "everything a
   * board owns" — add a table to one and this fails until it is in both.
   */
  const registry = codeOnly(await source("app/lib/board-registry.ts"));
  const fn = registry.slice(
    registry.indexOf("export async function deleteBoardStructure"),
    registry.indexOf("export async function boardItemCount"),
  );
  const drizzleToTable = {
    maintenanceBoardColumns: "maintenance_board_columns",
    maintenanceBoardOptions: "maintenance_board_options",
    maintenanceGroups: "maintenance_groups",
    boardViews: "board_views",
    formConfigurations: "form_configurations",
    boardAutomations: "board_automations",
    automationRuns: "automation_runs",
  };
  const init = await source("db/init.ts");
  const sweep = init.slice(init.indexOf("async function repairOrphanedSectionBoards"));

  for (const [symbol, table] of Object.entries(drizzleToTable)) {
    assert.match(fn, new RegExp(`\\.delete\\(${symbol}\\)`), `the purge must clear ${table}`);
    assert.ok(sweep.includes(`"${table}"`), `and so must the boot repair — ${table} is missing`);
  }
  assert.match(fn, /\.delete\(boards\)/, "and the board row itself");

  /* THE RULE THAT DOES NOT MOVE. Nothing that exists independently of this
     board may be destroyed because a menu entry was removed. */
  for (const table of [
    "maintenanceRequests", "attachments", "sites", "contractors",
    "maintenanceBoardCells", "itemUpdates",
  ]) {
    assert.doesNotMatch(fn, new RegExp(`\\.delete\\(${table}\\)`), `${table} is not the board's`);
  }
});

test("W2 the boot repair cannot race a board being created right now", async () => {
  /*
   * `POST /api/workspace-sections` creates the BOARD first and the SECTION
   * second, so there is a window in which a healthy board has no section
   * pointing at it. `db/init.ts` runs on the boot path of every isolate, so a
   * sweep that deleted on "nobody names it" alone would eventually take one out
   * from under an in-flight request.
   *
   * This pin ORIGINALLY asserted a blanket `key NOT LIKE 'sec-%'`, which made
   * the sweep legacy-only and therefore race-free by construction. That
   * exclusion was narrowed on purpose: it also made the sweep unable to clear a
   * GENERATED board whose section had already been purged, which is the residue
   * the pre-guard purge left behind and the shape QA found in the wild. The
   * contract has not weakened, it has moved — a generated key now needs a
   * second proof, an audit line naming it whose section no longer exists, and
   * that line is written AFTER the section row so a board inside the creation
   * window still cannot be a candidate. Re-pointed here rather than deleted.
   */
  const init = await source("db/init.ts");
  const sweep = init.slice(init.indexOf("async function repairOrphanedSectionBoards"));
  assert.match(sweep, /key NOT IN \('maintenance', 'store-documentation'\)/, "built-ins are safe");
  assert.match(sweep, /if \(key\.startsWith\("sec-"\)\)/, "a generated key is judged separately");
  assert.match(
    sweep,
    /action = 'workspace\.section_created'/,
    "the race guard for a generated key — the line is written after the section row",
  );
  assert.match(
    sweep,
    /creators\.length === 0\) continue/,
    "no audit line means the board may be mid-creation; hands off",
  );
  assert.match(
    sweep,
    /creators\.some\(\(section\) => liveSectionKeys\.has/,
    "and a board whose section still exists is never swept",
  );
  assert.match(sweep, /row\.surface_ref/, "a board any section names is safe");
  assert.match(sweep, /FROM maintenance_group_items/, "a board holding items is safe");
  assert.match(sweep, /FROM recycle_bin/, "and so is one with restorable rows");
});

test("W2 §29 a register whose items are only in the bin still refuses to be destroyed", async () => {
  /*
   * Binning an item LIFTS its placement out of `maintenance_group_items`, so
   * `boardItemCount` answers 0 for a register whose every row is one click from
   * coming back. Without this second count, deleting the rows and then the
   * section destroyed the board and left the bin offering rows back onto a
   * board that no longer existed — the items refusal, defeated by taking one
   * extra step first.
   */
  const route = codeOnly(await source("app/api/workspace-sections/route.ts"));
  const del = route.slice(route.indexOf("export async function DELETE"));
  assert.match(del, /boardItemCount\(context\.db, context\.orgId, ownedBoard\)/);
  assert.match(del, /if \(items > 0\)/, "an occupied register must be refused");
  assert.match(del, /boardBinCount\(context\.db, context\.orgId, ownedBoard\)/);
  assert.match(del, /if \(binned > 0\)/, "and so must one whose items are in the bin");
});

test("W2 §29 a purge finds the register a detached section created", async () => {
  /*
   * THE ROW SHAPE ALREADY IN THE WILD. Before the guard above existed, changing
   * a section's screen nulled `surface_ref` while the register it named stayed
   * up. The purge's ownership test reads that column, so it deleted the row and
   * left a live board nothing routes to — the whole of the owner's defect.
   *
   * The guard stops new ones; this is what clears the ones already made. The
   * board comes from the section's own `workspace.section_created` audit line
   * rather than from a name match, so it cannot pick the wrong board, and every
   * protection the normal path applies is applied to what it finds.
   */
  const route = codeOnly(await source("app/api/workspace-sections/route.ts"));
  const del = route.slice(route.indexOf("export async function DELETE"));
  assert.match(
    del,
    /await abandonedBoardFor\(context, row\.key\)/,
    "a NULL surface_ref must not be read as 'this section owned nothing'",
  );

  const recover = route.slice(
    route.indexOf("async function abandonedBoardFor"),
    route.indexOf("export async function DELETE"),
  );
  assert.match(recover, /"workspace\.section_created"/, "the record, not a guess");
  assert.match(recover, /BUILT_IN_BOARD_KEYS\.has\(board\)/, "a shared screen is never claimed");
  assert.match(recover, /\.from\(boards\)/, "and the board has to still exist");
});

/* ------------------------------------------------------------------ */
/* Against a running server — the owner's reproduction                */
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

/* Swept BY EXACT KEY. A substring sweep has repeatedly eaten other lanes'
   fixtures on this shared database, and `section:testtt` on Staging is the
   OWNER'S — W2 R6. */
const KEYS = [
  "section:s1qa-reuse",
  "section:s1qa-twin-a",
  "section:s1qa-twin-b",
  "section:s1qa-legacy",
  "section:s1qa-shared",
];

async function sweep() {
  for (const key of KEYS) {
    await call(`/api/workspace-sections?key=${encodeURIComponent(key)}`, { method: "DELETE" });
    await call(
      `/api/workspace-sections?key=${encodeURIComponent(key)}&purge=1`,
      { method: "DELETE" },
      SUPER,
    );
  }
}

async function add(key, label, extra = {}) {
  const response = await call("/api/workspace-sections", {
    method: "POST",
    body: JSON.stringify({ key, label, ...extra }),
  });
  const payload = await response.json();
  return { status: response.status, ...payload };
}

test("live: the owner's reproduction — a name removed permanently can be used again", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  await sweep();
  try {
    const first = await add("section:s1qa-reuse", "S1QA-Reuse");
    assert.equal(first.status, 201, `the first create failed: ${first.error}`);
    const board = first.section.boardKey;
    assert.match(board, /^sec-[0-9a-f]{12}$/, "the register is addressed by the instance");
    assert.equal(first.section.template, "jobs", "and it records what it was built from");

    /* Remove (archives), then remove permanently. Both are the product's own
       path — archived-first is still the precondition. */
    await call(`/api/workspace-sections?key=section:s1qa-reuse`, { method: "DELETE" });
    const purged = await call(
      `/api/workspace-sections?key=section:s1qa-reuse&purge=1`,
      { method: "DELETE" },
      SUPER,
    );
    assert.equal(purged.status, 200, "the purge itself must succeed");
    assert.equal((await purged.json()).board, board, "and it must take the register with it");

    /* THE BOARD IS GONE, not merely unreferenced. An unreachable board is what
       held the name hostage. */
    assert.equal(
      (await call(`/api/board?board=${board}`)).status,
      404,
      "the register must not survive its section",
    );

    /* AND THE NAME IS FREE. This is the whole reproduction. */
    const again = await add("section:s1qa-reuse", "S1QA-Reuse");
    assert.equal(again.status, 201, `the name was still blocked: ${again.error}`);
    assert.notEqual(
      again.section.boardKey,
      board,
      "the second instance gets its own register, not the first one's",
    );
  } finally {
    await sweep();
  }
});

test("live: two sections may carry the same name at the same time", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  await sweep();
  try {
    /* The label is IDENTICAL, and under the old rule both would have wanted the
       address `s1qa-twin` — the second was refused with "A board called S1QA
       Twin already exists." Stated here so the reason this test exists is
       visible without reading the history. */
    assert.equal(slugFromLabel("S1QA Twin"), "s1qa-twin");

    const a = await add("section:s1qa-twin-a", "S1QA Twin");
    const b = await add("section:s1qa-twin-b", "S1QA Twin");
    assert.equal(a.status, 201, `the first twin failed: ${a.error}`);
    assert.equal(b.status, 201, `the second twin was refused: ${b.error}`);
    assert.notEqual(a.section.boardKey, b.section.boardKey, "one name, two registers");
  } finally {
    await sweep();
  }
});

test("live: renaming a section moves its label and not its address", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  await sweep();
  try {
    const created = await add("section:s1qa-reuse", "S1QA-Before");
    assert.equal(created.status, 201, `create failed: ${created.error}`);
    const board = created.section.boardKey;

    const renamed = await call("/api/workspace-sections", {
      method: "PATCH",
      body: JSON.stringify({ key: "section:s1qa-reuse", label: "S1QA-After" }),
    });
    assert.equal(renamed.status, 200);
    const after = (await renamed.json()).section;
    assert.equal(after.label, "S1QA-After");
    assert.equal(after.boardKey, board, "renaming must not move the register");

    /* And the register's own heading followed, which is what makes the label
       live on `boards.name` rather than in the key. */
    const boardPayload = await (await call(`/api/board?board=${board}`)).json();
    const name = boardPayload.board?.name ?? boardPayload.name;
    if (name !== undefined) assert.equal(name, "S1QA-After");
  } finally {
    await sweep();
  }
});

test("live: an instance refuses to be re-homed; a legacy second door still can be", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  await sweep();
  try {
    /* An INSTANCE. Changing its screen is what nulled `surface_ref` and left
       board `test` behind on Staging. */
    const instance = await add("section:s1qa-reuse", "S1QA-Instance");
    assert.equal(instance.status, 201, `create failed: ${instance.error}`);
    const board = instance.section.boardKey;

    const refused = await call("/api/workspace-sections", {
      method: "PATCH",
      body: JSON.stringify({ key: "section:s1qa-reuse", surface: "reports" }),
    });
    assert.equal(refused.status, 409, "re-homing an instance must be refused");
    const refusal = await refused.json();
    assert.equal(refusal.ownsBoard, true);
    assert.equal(refusal.board, board);

    /* AND NOTHING WAS WRITTEN. A refusal that half-applied would be worse than
       the bug — this is the assertion that the orphan cannot be recreated. */
    const listed = await (await call("/api/workspace-sections")).json();
    const still = listed.sections.find((entry) => entry.key === "section:s1qa-reuse");
    assert.equal(still.boardKey, board, "the register must still belong to it");
    assert.equal(still.surface, "maintenance", "and its screen must be unchanged");

    /* A LEGACY second door owns nothing, and re-homing one is the only reason
       the control is still in the dialog. */
    const legacy = await add("section:s1qa-legacy", "S1QA-Legacy", { surface: "maintenance" });
    assert.equal(legacy.status, 201, `create failed: ${legacy.error}`);
    assert.equal(legacy.section.ownsBoard, false);
    assert.equal(legacy.section.template, null, "a second door has no template — R6");

    const moved = await call("/api/workspace-sections", {
      method: "PATCH",
      body: JSON.stringify({ key: "section:s1qa-legacy", surface: "reports" }),
    });
    assert.equal(moved.status, 200, "a legacy section must still be re-homeable");
    assert.equal((await moved.json()).section.surface, "reports");
  } finally {
    await sweep();
  }
});

test("live: QA's four steps — the edit that orphaned a board is refused outright", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  await sweep();
  try {
    /*
     * The reproduction as QA ran it, step for step:
     *   1. Add "X" and note its board
     *   2. Edit -> Screen -> Reports -> Save
     *   3. Remove, then Remove permanently
     *   4. Add "X" again
     * On the unfixed code step 2 succeeded, step 3 left the board answering 200
     * with its six columns and three groups, and step 4 was refused 409.
     */
    const created = await add("section:s1qa-reuse", "S1QA-QA");
    assert.equal(created.status, 201, `step 1 failed: ${created.error}`);
    const board = created.section.boardKey;

    const edit = await call("/api/workspace-sections", {
      method: "PATCH",
      body: JSON.stringify({ key: "section:s1qa-reuse", surface: "reports" }),
    });
    assert.equal(edit.status, 409, "step 2 is where the board was abandoned");

    await call(`/api/workspace-sections?key=section:s1qa-reuse`, { method: "DELETE" });
    const purged = await call(
      `/api/workspace-sections?key=section:s1qa-reuse&purge=1`,
      { method: "DELETE" },
      SUPER,
    );
    assert.equal(purged.status, 200, "step 3 must destroy the section");
    assert.equal((await purged.json()).board, board, "and take its register with it");
    assert.equal(
      (await call(`/api/board?board=${board}`)).status,
      404,
      "no purge may leave a live board with no owner",
    );

    const again = await add("section:s1qa-reuse", "S1QA-QA");
    assert.equal(again.status, 201, `step 4 was still refused: ${again.error}`);
  } finally {
    await sweep();
  }
});

test("live: recovering an abandoned register never takes one another section uses", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  await sweep();
  try {
    /*
     * The safety property of `abandonedBoardFor`. A register two sections open
     * is shared IN FACT, whoever created it — so a purge that recovers a board
     * from the creator's audit line must still refuse to remove one somebody
     * else is using. Built through the API rather than the database, because
     * this shape is reachable and the dangerous one is not: a section may only
     * abandon a register while another section still holds it.
     */
    const instance = await add("section:s1qa-reuse", "S1QA-Owner");
    assert.equal(instance.status, 201, `create failed: ${instance.error}`);
    const board = instance.section.boardKey;

    const second = await add("section:s1qa-shared", "S1QA-Shared", { surface: "maintenance" });
    assert.equal(second.status, 201, `create failed: ${second.error}`);
    const pointed = await call("/api/workspace-sections", {
      method: "PATCH",
      body: JSON.stringify({ key: "section:s1qa-shared", board }),
    });
    assert.equal(pointed.status, 200, "a legacy section may be pointed at a register");

    /* Now the first one may leave: the register survives in the other's hands.
       This is the ONLY way a section detaches from a board it created. */
    const moved = await call("/api/workspace-sections", {
      method: "PATCH",
      body: JSON.stringify({ key: "section:s1qa-reuse", surface: "reports" }),
    });
    assert.equal(moved.status, 200, "a shared register does not pin its creator");
    assert.equal((await moved.json()).section.boardKey, null, "and the row is now detached");

    /* Purging the creator recovers the board from its audit line — and then
       refuses to remove it, because somebody else opens it. */
    await call(`/api/workspace-sections?key=section:s1qa-reuse`, { method: "DELETE" });
    const purged = await call(
      `/api/workspace-sections?key=section:s1qa-reuse&purge=1`,
      { method: "DELETE" },
      SUPER,
    );
    assert.equal(purged.status, 200);
    assert.equal((await purged.json()).board, null, "a shared register is not the purge's to take");
    assert.equal(
      (await call(`/api/board?board=${board}`)).status,
      200,
      "and it must still be there for the section that uses it",
    );

    /* And when the last holder goes, so does the register. */
    await call(`/api/workspace-sections?key=section:s1qa-shared`, { method: "DELETE" });
    const last = await call(
      `/api/workspace-sections?key=section:s1qa-shared&purge=1`,
      { method: "DELETE" },
      SUPER,
    );
    assert.equal((await last.json()).board, board);
    assert.equal((await call(`/api/board?board=${board}`)).status, 404);
  } finally {
    await sweep();
  }
});

test("live: the catalogue offers templates, and only the ones that work", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const payload = await (await call("/api/workspace-sections")).json();
  assert.ok(Array.isArray(payload.templates), "the dialog reads its templates from here");
  assert.deepEqual(
    payload.templates.map((entry) => entry.key),
    SECTION_TEMPLATES.map((entry) => entry.key),
    "the server is the authority; the browser keeps no second list",
  );

  /* §8 again, at the endpoint. A template the dialog does not offer is refused
     on write too, so a script or a stale tab cannot get one. */
  const blocked = SECTION_TEMPLATES.find((entry) => !entry.available);
  if (blocked) {
    const refused = await add("section:s1qa-reuse", "S1QA-Blocked", { template: blocked.key });
    assert.equal(refused.status, 400, `"${blocked.key}" must be refused on write`);
    assert.equal(refused.available, false);
    await sweep();
  }
});
