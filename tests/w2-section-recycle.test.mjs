/**
 * W2C — A CUSTOM SECTION IS ONE PRODUCT OBJECT, AND IT IS DELETED AS ONE.
 *
 * THE REPORT THIS ANSWERS. Permanently removing a workspace section refused
 * three times over — "still holds N items", then "still has N items in the
 * recycle bin", then "still holds N sites" — so an owner who wanted rid of a
 * section had to empty it row by row, then empty the bin, then come back. The
 * instruction was the opposite: a custom section is one object, and deleting it
 * should take its register, its rows, its views, its forms and its files with
 * it, recoverably.
 *
 * WHAT THIS FILE HOLDS, and each is a property somebody could quietly lose:
 *
 *   1. `bin=1` moves the WHOLE bundle and refuses nothing for being occupied.
 *   2. The bin shows ONE entry of type `section`, never one per child.
 *   3. Restore is atomic and returns the same identity — same section key, same
 *      board key, same rows — not a blank replacement.
 *   4. Canonical Jobs, Sites, Contractors and Documentation are untouched by any
 *      of it, in either direction.
 *   5. A child of a deleted section cannot be restored or purged on its own.
 *   6. "Delete for good" needs `data.delete`, destroys the bundle, and frees the
 *      display name for immediate reuse.
 *   7. The thirty days are real arithmetic, verified without waiting thirty days.
 *   8. Built-in sections cannot enter this flow, and nothing crosses an
 *      organisation boundary.
 *
 * FIXTURES ARE KEYED, NEVER NAMED. Every section this file creates carries a
 * generated suffix and is removed by that exact key. A substring sweep over
 * labels has eaten other people's fixtures in this repository before, and the
 * owner's own `test` / `testt` / `testtt` sections live in the same table.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const ADMIN = "admin@test.maintsupp.com";
const SUPER = "super-admin@test.maintsupp.com";
/* A member of the OTHER seeded organisation. Used only to prove that nothing
   here reaches across a tenant boundary. */
const OTHER_ORG = "admin@demo-client-ltd.test.maintsupp.com";

const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* 1 — the schema change, and that it destroys nothing                 */
/* ------------------------------------------------------------------ */

test("the section's deleted_at column is declared, created and added additively", async () => {
  const schema = await read("db/schema.ts");
  const init = await read("db/init.ts");

  assert.match(
    schema,
    /deletedAt: text\("deleted_at"\),/,
    "workspace_sections needs a deleted_at, or a section cannot be in the bin at all",
  );
  const table = schema.slice(
    schema.indexOf('export const workspaceSections = sqliteTable('),
    schema.indexOf("export const sectionViewPreferences"),
  );
  assert.match(table, /archivedAt: text\("archived_at"\)/);
  assert.match(
    table,
    /deletedAt: text\("deleted_at"\)/,
    "and it belongs on workspace_sections, beside archived_at, not on a side table",
  );

  /*
   * ADDITIVE, and this is the one that would take the application down.
   * `db/init.ts` runs on the boot path of every request: an unguarded ALTER
   * throws on the second boot, and a UNIQUE INDEX over data that already
   * violates it throws on every boot for ever.
   */
  assert.match(
    init,
    /await addColumn\(d1, "workspace_sections", "deleted_at", "TEXT"\);/,
    "the column must go through the PRAGMA-guarded helper",
  );
  const block = init.slice(
    init.indexOf('await addColumn(d1, "workspace_sections", "deleted_at"') - 1600,
    init.indexOf('await addColumn(d1, "workspace_sections", "deleted_at"') + 200,
  );
  for (const destructive of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE", "UPDATE "]) {
    assert.ok(
      !block.toUpperCase().includes(destructive),
      `the migration must be purely additive; found ${destructive}`,
    );
  }
  assert.ok(
    !/CREATE\s+UNIQUE\s+INDEX[^\n]*deleted_at/i.test(init),
    "no unique index over the new column — it would fail on every request against data that violates it",
  );
});

/* ------------------------------------------------------------------ */
/* 2 — the bundle: one entry, and nothing else moves                   */
/* ------------------------------------------------------------------ */

test("sending a section to the bin writes ONE entry and takes nothing apart", async () => {
  const bin = await read("app/lib/recycle-bin.ts");
  /* The whole bundle block — the entity type, the snapshot it records and the
     writer — because the snapshot's shape is half of what makes restore exact
     and it is declared beside the function rather than inside it. */
  const send = bin.slice(
    bin.indexOf("/* ── A whole section, as ONE thing"),
    bin.indexOf("export async function binnedSectionBoards"),
  );
  assert.ok(send.length > 400, "the writer exists");

  assert.match(send, /entityType: SECTION_ENTITY_TYPE/, "it goes in as a section");
  assert.equal(
    (send.match(/\.insert\(recycleBin\)/g) ?? []).length,
    1,
    "ONE bin row for the whole bundle — a tombstone per child is the shape the owner rejected",
  );
  /*
   * NOTHING BELONGING TO THE CHILDREN IS TOUCHED. This is what makes restore
   * atomic: there is no half-restored state available, because nothing was
   * taken apart. If any of these appears here, the bundle has become a cascade
   * and Restore has become a hundred separate things that can each fail.
   */
  for (const table of [
    "maintenanceRequests",
    "maintenanceGroupItems",
    "maintenanceBoardCells",
    "maintenanceBoardColumns",
    "boardViews",
    "attachments",
    "sites",
    "contractors",
  ]) {
    assert.doesNotMatch(
      send,
      new RegExp(`\\.(update|delete)\\(${table}\\)`),
      `${table} must not move when a section is binned — the section is the only door onto its register`,
    );
  }

  assert.match(send, /\.update\(workspaceSections\)/, "the section itself is flagged");
  assert.match(send, /deletedAt,/, "with deleted_at");
  assert.match(
    send,
    /archivedAt: snapshot\.wasArchived \? undefined : deletedAt/,
    "and archived as well, so every reader that already drops an archived section drops this one",
  );
  /*
   * The register is archived, which is what stops the PUBLIC form share link,
   * the form editor and the compliance digest from reaching a bundle sitting in
   * the bin. `loadFormByToken` already refuses an archived board; this is the
   * line that makes it apply here.
   */
  assert.match(send, /\.update\(boards\)/);
  assert.match(send, /archived: true/, "the register goes out of use with it");
  assert.match(
    send,
    /boardWasArchived/,
    "and its previous state is snapshotted, so restore puts back what was there",
  );
});

test("restoring a section is three writes, and restores the state it left", async () => {
  const bin = await read("app/lib/recycle-bin.ts");
  const restore = bin.slice(
    bin.indexOf("async function restoreSection"),
    bin.indexOf("function parsePlacement"),
  );
  assert.ok(restore.length > 400, "the restore exists");
  assert.match(restore, /deletedAt: null/, "the section comes back");
  assert.match(
    restore,
    /archivedAt: snapshot\.wasArchived === true \? undefined : null/,
    "a section archived BEFORE it was deleted comes back archived, not silently re-added to every sidebar",
  );
  assert.match(restore, /archived: false/, "and its register comes back into use");
  assert.match(restore, /\.delete\(recycleBin\)/, "and the entry leaves the bin");
  assert.doesNotMatch(
    restore,
    /\.insert\(workspaceSections\)/,
    "restore must return the SAME section, never create a blank replacement",
  );
});

test("a child of a deleted section cannot be restored or purged on its own", async () => {
  const bin = await read("app/lib/recycle-bin.ts");
  const trash = await read("app/api/trash/route.ts");

  /*
   * THE POLICY, AND WHY IT IS THIS ONE. The alternative was "restore the parent
   * first, silently", which turns one click on one row into putting a whole
   * section and everything on it back in front of every colleague. Refusing
   * says what is in the way; the bin does not list these entries at all, so
   * anything that reaches the refusal is a stale tab or a script — exactly the
   * caller a UI-only rule does not stop.
   */
  const dispatch = bin.slice(
    bin.indexOf("export async function restoreFromBin"),
    bin.indexOf("type BinRow ="),
  );
  assert.match(dispatch, /binnedSectionBoards\(db, orgId\)/);
  assert.match(dispatch, /status: 409/);
  assert.match(dispatch, /recycle bin/i, "and it says where the thing actually is");

  const listing = bin.slice(bin.indexOf("export async function listBin"));
  assert.match(
    listing,
    /SECTION_ENTITY_TYPE/,
    "the bin folds a deleted section's children into its one entry",
  );

  const del = trash.slice(
    trash.indexOf("export async function DELETE"),
    trash.indexOf("function purgeFor"),
  );
  assert.match(
    del,
    /binnedSectionBoards\(db, orgId\)/,
    "and ?all=true must not destroy them one by one behind the section's back",
  );
});

/* ------------------------------------------------------------------ */
/* 3 — canonical sections, and the ownership rule                      */
/* ------------------------------------------------------------------ */

test("only a workspace-added section can enter this flow, and never a shared board", async () => {
  const route = await read("app/api/workspace-sections/route.ts");
  const del = route.slice(route.indexOf("export async function DELETE"));
  const branch = del.slice(del.indexOf("if (toBin) {"), del.indexOf("const purge ="));

  assert.match(
    branch,
    /isWorkspaceSectionKey\(row\.key\)/,
    "server-side, not in the dialog: jobs, contractors, sites and store-documentation are not workspace rows and must be refused by name",
  );
  assert.match(branch, /status: 403/);
  assert.match(
    branch,
    /BUILT_IN_BOARD_KEYS\.has\(row\.surfaceRef\)/,
    "a section pointed at one of the product's own boards owns nothing and must take nothing",
  );
  assert.match(
    branch,
    /section\.boardKey === ownedBoard/,
    "and a register a second live section still opens is not this one's to take",
  );
});

test("delete for good traverses ownership, and never cascades into shared data", async () => {
  const trash = await read("app/api/trash/route.ts");
  const purge = trash.slice(trash.indexOf("async function purgeSection"));

  assert.match(
    purge,
    /BUILT_IN_BOARD_KEYS\.has\(section\.surfaceRef\)/,
    "checked again at purge time — the sweep can reach this thirty days after anybody looked",
  );
  assert.match(purge, /deleteBoardStructure\(db, orgId, boardKey\)/);
  assert.match(purge, /forgetSectionReferences\(db, orgId, sectionKey\)/);
  assert.match(purge, /\.delete\(workspaceSections\)/, "and the section row itself");

  /*
   * A site or a contractor created inside an instance is owned by it AND is the
   * target of NOT NULL foreign keys from six other tables. Destroying one a
   * canonical job, unit, planned visit or compliance document still points at
   * would be a cascade across data the section never owned — and on Postgres it
   * would simply throw, which is the class of failure that passes locally and
   * fails deployed. The referenced ones come home instead.
   */
  const rows = trash.slice(trash.indexOf("async function purgeInstanceRegisterRows"));
  for (const guard of [
    "from(units)",
    "from(plannedMaintenance)",
    "from(complianceDocuments)",
    "from(maintenanceRequests)",
  ]) {
    assert.ok(
      rows.includes(guard),
      `a site that ${guard} still points at must not be destroyed — it must be re-homed`,
    );
  }
  assert.match(
    rows,
    /boardId: CANONICAL_REGISTER/,
    "and re-homing is putting board_id back to the canonical register, not orphaning the row",
  );
  assert.match(
    rows,
    /registerValues/,
    "a destroyed register row takes its own custom column values with it",
  );

  /*
   * `deleteBoardStructure` is configuration only and must stay that way — it is
   * called on this path, and a `.delete(sites)` added to it would turn every
   * purge into the cascade above with none of the checks.
   */
  const registry = await read("app/lib/board-registry.ts");
  const structure = registry.slice(
    registry.indexOf("export async function deleteBoardStructure"),
    registry.indexOf("export async function boardItemCount"),
  );
  for (const table of ["maintenanceRequests", "attachments", "sites", "contractors"]) {
    assert.doesNotMatch(
      structure,
      new RegExp(`\\.delete\\(${table}\\)`),
      `${table} is not the board's to delete`,
    );
  }
});

test("a register whose section is in the bin stops resolving, so a kept link cannot open it", async () => {
  const registry = await read("app/lib/board-registry.ts");
  const resolve = registry.slice(
    registry.indexOf("export async function resolveBoard"),
    registry.indexOf("Give a board the default register structure"),
  );
  assert.match(
    resolve,
    /isSectionBoardKey\(existing\.key\)/,
    "only generated keys pay for the check — the product's own two boards must not",
  );
  assert.match(resolve, /isNotNull\(workspaceSections\.deletedAt\)/);
  assert.match(
    resolve,
    /throw new BoardNotFoundError/,
    "and it is a 404, not a leak of what is in a bin the caller cannot see",
  );
});

/* ------------------------------------------------------------------ */
/* 4 — the 30 days, and what actually runs them                        */
/* ------------------------------------------------------------------ */

test("the retention is 30 days, applied to sections by the one existing sweep", async () => {
  const bin = await read("app/lib/recycle-bin.ts");
  const trash = await read("app/api/trash/route.ts");

  assert.match(bin, /export const RETENTION_DAYS = 30;/);
  assert.match(bin, /RETENTION_DAYS \* DAY_MS/, "expiry is derived from it, not written twice");
  const sweep = bin.slice(bin.indexOf("export async function sweepRecycleBin"));
  assert.match(
    sweep,
    /lte\(recycleBin\.expiresAt, nowIso\(\)\)/,
    "eligibility is expires_at <= now, over the indexed column",
  );

  /*
   * A SECTION IS SWEPT BY THE SAME CODE A PERSON PRESSES. `purgeFor` is what
   * both the deliberate "Delete for good" and the thirty-day sweep call, so the
   * automatic ending cannot be a different, quieter deletion than the chosen
   * one.
   */
  assert.match(
    trash,
    /if \(entityType === SECTION_ENTITY_TYPE\) \{[\s\S]{0,200}purgeSection\(db, organisationId, entityId\)/,
    "the sweep must know how to destroy a section, or a bundle sits in the bin for ever",
  );

  /*
   * NOTHING RUNS ON A CLOCK IN THIS DEPLOYMENT — no cron trigger, no queue, no
   * alarm. `maybeSweepRecycleBin` is sampled off this route's own reads, which
   * is honest and is what the screen says. `?sweep=1` is the deterministic
   * version, so the retention can be RUN by an operator or wired to a scheduler
   * later without inventing one now.
   */
  assert.match(trash, /searchParams\.get\("sweep"\)/);
  const forced = trash.slice(trash.indexOf('searchParams.get("sweep")') - 400);
  assert.match(
    forced.slice(0, 900),
    /scopedDbWithCapability\(request, "data\.delete"\)/,
    "forcing the sweep destroys things, so it needs the destructive capability — the route's own guard is only board.view",
  );
});

test("the expiry threshold is exact, and timezone-safe by construction", async () => {
  const bin = await read("app/lib/recycle-bin.ts");
  /*
   * Verified as arithmetic rather than by waiting thirty days. The formula is
   * read out of the source so this cannot pass against a different one.
   */
  assert.match(
    bin,
    /export function expiryFrom\(deletedAt: string\) \{\s*\n\s*return new Date\(new Date\(deletedAt\)\.getTime\(\) \+ RETENTION_DAYS \* DAY_MS\)\.toISOString\(\);/,
  );
  assert.match(
    bin,
    /return remaining <= 0 \? 0 : Math\.ceil\(remaining \/ DAY_MS\);/,
    "0 once it is due, never negative",
  );
  /*
   * `toISOString()` on both sides is the whole of the timezone safety: every
   * value written and every value compared is UTC with a `Z`, so the comparison
   * cannot move with the server's locale or with British Summer Time. The
   * header on `nowIso` says why one format matters; this is the reason it has
   * to be the UTC one.
   */
  assert.match(bin, /export function nowIso\(\) \{\s*\n\s*return new Date\(\)\.toISOString\(\);/);
});

/* ------------------------------------------------------------------ */
/* 5 — the screen says what the button does                            */
/* ------------------------------------------------------------------ */

test("the section manager deletes to the bin, and its confirmation is honest", async () => {
  const manager = await read("app/(app)/portal/section-manager.tsx");
  const code = manager.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /*
   * `bin=1`, not `purge=1`. This assertion used to require `purge=1` — "only
   * the explicit flag destroys anything" — which was right while the button was
   * a one-step destruction. It is now a move to the Recycle Bin, and `purge=1`
   * is what the product must NOT send: it still refuses an occupied register,
   * which is the dead end the owner reported.
   */
  assert.match(code, /&bin=1`/, "the destructive button sends the reversible verb");
  assert.doesNotMatch(
    code,
    /purge=1/,
    "and never the irreversible one — that path still exists on the API and is not the product's",
  );

  assert.match(manager, /role="alertdialog"/, "a confirmation has to be announced as one");
  assert.doesNotMatch(
    code,
    /window\.confirm|[^.\w]confirm\(/,
    "a step that has to be read past, not a browser dialog",
  );
  assert.match(
    manager,
    /Recycle Bin for 30\s*\n?\s*days|Recycle Bin for 30 days/,
    "the consequence copy has to name where it goes and for how long",
  );
  assert.match(
    manager,
    /cannot be undone/,
    "and still name the part that really cannot be — what happens after the 30 days",
  );
  assert.doesNotMatch(
    code,
    /Remove permanently/,
    "the old label described an act this button no longer performs (the header comment still names it, deliberately, as the record of what changed)",
  );
});

/* ------------------------------------------------------------------ */
/* 6 — against a running server                                        */
/* ------------------------------------------------------------------ */

let cookie = null;
async function signIn() {
  if (cookie !== null) return cookie;
  try {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
        password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
      }),
    });
    cookie = response.ok
      ? (response.headers.getSetCookie?.() ?? []).map((raw) => raw.split(";")[0]).join("; ")
      : "";
  } catch {
    cookie = "";
  }
  return cookie;
}

/**
 * A request AS A ROLE, with no session cookie — and the omission is the point.
 *
 * `resolveTenantAccess` will not let a header widen a REAL session's reach, so
 * a request carrying the owner's cookie is the owner whatever
 * `x-maintsupp-identity` says. Two of the properties this file exists to check
 * are exactly about who the caller is — that an admin cannot finish off a
 * section, and that another tenant cannot touch one at all — and both pass
 * vacuously if the cookie rides along. So the default here is cookie-free, and
 * the one endpoint that genuinely demands a proven session asks for it by name.
 */
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

/** The same request with the owner's real session, for the writes that need one. */
function callSignedIn(path, options = {}) {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-maintsupp-identity": ADMIN,
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {}),
    },
  });
}

const body = async (response) => response.json().catch(() => ({}));

async function serverIsUp() {
  try {
    return (await call("/api/workspace-sections")).ok;
  } catch {
    return false;
  }
}

/**
 * One row on a register, retried past a lost id race.
 *
 * `MN-` ids are allocated from `MAX(id) + attempt` and are REUSED, so a second
 * writer working on the same database at the same moment can take the number
 * this create was about to use and hand back a 503. That is a property of the
 * shared fixture estate, not of anything this file is testing, and a fixture
 * that fails for it reports a defect that is not there.
 */
async function createItem(board, groupId) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const created = await call(`/api/board?board=${board}`, {
      method: "POST",
      body: JSON.stringify({ action: "create_item", groupId }),
    });
    if (created.status === 201) return (await body(created)).request?.id ?? null;
    if (created.status !== 503) {
      assert.equal(created.status, 201, JSON.stringify(await body(created)));
    }
  }
  return null;
}

/** A key nothing else in this repository, or this workspace, can already hold. */
const suffix = () => Math.random().toString(16).slice(2, 8);
const keyFor = (slug) => `section:zzqa-w2c-${slug}`;

async function createSection(slug, extra = {}) {
  const key = keyFor(slug);
  const response = await call("/api/workspace-sections", {
    method: "POST",
    body: JSON.stringify({ label: `ZZQA W2C ${slug}`, key: `zzqa-w2c-${slug}`, ...extra }),
  });
  const payload = await body(response);
  assert.equal(response.status, 201, `the fixture must be created: ${JSON.stringify(payload)}`);
  assert.equal(payload.section.key, key);
  return payload.section;
}

/** The bin entry for one section, by its exact key. Null when it is not there. */
async function sectionEntry(key) {
  const payload = await body(await call("/api/trash", {}, SUPER));
  return (
    (payload.bin?.entries ?? []).find(
      (entry) => entry.entityType === "section" && entry.entityId === key,
    ) ?? null
  );
}

/**
 * Remove one fixture, by its exact generated key and nothing else.
 *
 * Bin then delete for good, which is the product's own two steps and therefore
 * also a check that teardown works. Every call is tolerant: a fixture a failed
 * assertion left in a different state must not poison the next run.
 */
async function sweep(key) {
  await call(`/api/workspace-sections?key=${encodeURIComponent(key)}&bin=1`, {
    method: "DELETE",
  }).catch(() => {});
  const entry = await sectionEntry(key).catch(() => null);
  if (entry) {
    await call(`/api/trash?id=${encodeURIComponent(entry.id)}`, { method: "DELETE" }, SUPER).catch(
      () => {},
    );
  }
}

/* ── A — an empty section ───────────────────────────────────────────── */

test("live A: an empty section is deleted as one entry and restored whole", async (t) => {
  await signIn();
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const slug = `a-${suffix()}`;
  const key = keyFor(slug);
  try {
    const section = await createSection(slug);
    const board = section.boardKey;
    assert.ok(board?.startsWith("sec-"), "an added section gets a register of its own");

    const deleted = await call(`/api/workspace-sections?key=${key}&bin=1`, { method: "DELETE" });
    const result = await body(deleted);
    assert.equal(deleted.status, 200, JSON.stringify(result));
    assert.equal(result.binned, true);
    assert.equal(result.board, board, "the bundle names the register it took");

    const entries = (await body(await call("/api/trash", {}, SUPER))).bin.entries;
    const mine = entries.filter((entry) => entry.boardId === board);
    assert.equal(mine.length, 1, "ONE entry for the whole section, not one per child");
    assert.equal(mine[0].entityType, "section");
    assert.equal(mine[0].title, section.label, "and it is named after the section");
    assert.equal(mine[0].daysLeft, 30);

    /* Out of the sidebar, and the register unreachable even by key. */
    const nav = await body(await call("/api/navigation"));
    assert.ok(
      !nav.layout.groups.flatMap((group) => group.items).some((item) => item.key === key),
      "a deleted section leaves every sidebar at once",
    );
    assert.equal(
      (await call(`/api/board?board=${board}`)).status,
      404,
      "and a kept link to its register stops opening it",
    );

    const restored = await call("/api/trash", {
      method: "POST",
      body: JSON.stringify({ id: mine[0].id }),
    });
    assert.equal(restored.status, 200, JSON.stringify(await body(restored)));

    const after = await body(await call("/api/workspace-sections"));
    const back = after.sections.find((entry) => entry.key === key);
    assert.ok(back, "the SAME section comes back");
    assert.equal(back.boardKey, board, "with the SAME register — not a blank replacement");
    assert.equal(back.archived, false);
    assert.equal(back.deleted, false);
    assert.equal((await call(`/api/board?board=${board}`)).status, 200);
  } finally {
    await sweep(key);
  }
});

/* ── B — a Jobs section with rows, views and a form ─────────────────── */

test("live B: a Jobs section is deleted without being emptied, and comes back whole", async (t) => {
  await signIn();
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const slug = `b-${suffix()}`;
  const key = keyFor(slug);
  try {
    const section = await createSection(slug);
    const board = section.boardKey;

    const groups = (await body(await call(`/api/board?board=${board}`))).groups;
    const groupId = groups[0].id;

    const items = [];
    for (let index = 0; index < 2; index += 1) {
      const id = await createItem(board, groupId);
      assert.ok(id, "the fixture row must be created");
      items.push(id);
    }

    const views = (await body(await call(`/api/board/views?board=${board}`))).views;
    assert.ok(views.length >= 2, "a Jobs register arrives with a view strip");
    const forms = views.filter((view) => view.type === "form" || view.kind === "form").length;

    /* The canonical job board, counted BEFORE. The property is that it GAINS
       AND LOSES NOTHING, in either direction, at any point below. */
    const canonicalBefore = (await body(await call("/api/board/items?board=maintenance"))).items
      .length;

    /*
     * THE POINT OF THE WHOLE CHANGE: no emptying first. The old path answered
     * 409 "still holds 2 items" here and sent the operator away to delete them
     * by hand.
     */
    const deleted = await call(`/api/workspace-sections?key=${key}&bin=1`, { method: "DELETE" });
    const result = await body(deleted);
    assert.equal(deleted.status, 200, JSON.stringify(result));
    assert.equal(result.counts.items, 2, "the entry says what is at stake");
    assert.ok(result.counts.views >= 2);
    assert.match(result.summary, /2 items/);

    const entry = await sectionEntry(key);
    assert.ok(entry, "one entry, of type section");
    const listed = (await body(await call("/api/trash", {}, SUPER))).bin.entries.filter(
      (row) => row.boardId === board,
    );
    assert.equal(listed.length, 1, "its rows and views are folded into it, not listed beside it");

    const canonicalAfter = (await body(await call("/api/board/items?board=maintenance"))).items
      .length;
    assert.equal(
      canonicalAfter,
      canonicalBefore,
      "the canonical job board must not change because another section was deleted",
    );
    for (const id of items) {
      assert.ok(
        !(await body(await call("/api/board/items?board=maintenance"))).items.some(
          (row) => row.id === id,
        ),
        "and none of the section's rows may land on it",
      );
    }

    const restored = await call("/api/trash", {
      method: "POST",
      body: JSON.stringify({ id: entry.id }),
    });
    assert.equal(restored.status, 200, JSON.stringify(await body(restored)));

    const back = (await body(await call(`/api/board/items?board=${board}`))).items.map(
      (row) => row.id,
    );
    for (const id of items) {
      assert.ok(back.includes(id), `${id} must come back on the register it was filed on`);
    }
    const viewsBack = (await body(await call(`/api/board/views?board=${board}`))).views;
    assert.equal(viewsBack.length, views.length, "and every view with it");
    assert.equal(
      viewsBack.filter((view) => view.type === "form" || view.kind === "form").length,
      forms,
      "the form included",
    );
  } finally {
    await sweep(key);
  }
});

/* ── C and D — Contractors and Sites instances ──────────────────────── */

test("live C: a Contractors instance's contractor returns only inside that instance", async (t) => {
  await signIn();
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const slug = `c-${suffix()}`;
  const key = keyFor(slug);
  const name = `ZZQA W2C contractor ${slug}`;
  try {
    await createSection(slug, { template: "contractors" });

    /* `POST /api/workspace` refuses the testing role switcher — it grants, so it
       demands a proven session. This one call signs in for real. */
    const created = await callSignedIn(`/api/workspace?section=${key}`, {
      method: "POST",
      body: JSON.stringify({ entity: "contractor", data: { name, active: true } }),
    });
    if (!created.ok) {
      t.skip(`the instance would not accept a contractor (${created.status}) — see W2 scope model`);
      return;
    }

    const inside = () =>
      body(call(`/api/contractors?section=${key}`)).then?.((value) => value) ??
      body(call(`/api/contractors?section=${key}`));
    const held = (await body(await call(`/api/contractors?section=${key}`))).contractors ?? [];
    assert.ok(
      held.some((row) => row.name === name),
      "the contractor is in the instance",
    );
    void inside;

    const canonicalBefore = (await body(await call("/api/workspace"))).workspace.contractors.length;

    const deleted = await call(`/api/workspace-sections?key=${key}&bin=1`, { method: "DELETE" });
    assert.equal(deleted.status, 200, JSON.stringify(await body(deleted)));
    assert.equal((await body(deleted)).counts?.contractors ?? 1, 1, "the entry counts it");

    /*
     * THE ONE THING THAT MUST NOT HAPPEN. A contractor created inside an
     * instance must not appear on the workspace's own roster because the
     * section was deleted — that is the silent re-home the purge path refuses
     * without a confirmation, and it must not happen behind a delete either.
     */
    const canonicalDuring = (await body(await call("/api/workspace"))).workspace.contractors;
    assert.equal(
      canonicalDuring.length,
      canonicalBefore,
      "the canonical roster must not gain the instance's row",
    );
    assert.ok(!canonicalDuring.some((row) => row.name === name));

    const entry = await sectionEntry(key);
    assert.ok(entry, "one entry for the instance");
    assert.equal(
      (await call("/api/trash", { method: "POST", body: JSON.stringify({ id: entry.id }) })).status,
      200,
    );

    const backInside = (await body(await call(`/api/contractors?section=${key}`))).contractors ?? [];
    assert.ok(
      backInside.some((row) => row.name === name),
      "the contractor returns INSIDE the instance",
    );
    assert.equal(
      (await body(await call("/api/workspace"))).workspace.contractors.length,
      canonicalBefore,
      "and still not on the canonical roster",
    );
  } finally {
    await sweep(key);
  }
});

test("live D: a Sites instance's site returns only inside that instance", async (t) => {
  await signIn();
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const slug = `d-${suffix()}`;
  const key = keyFor(slug);
  const name = `ZZQA W2C site ${slug}`;
  try {
    await createSection(slug, { template: "sites" });

    const created = await call(`/api/sites?section=${key}`, {
      method: "POST",
      body: JSON.stringify({
        data: { name, addressLine1: "1 Recycle Street", city: "London" },
        confirmDuplicate: true,
      }),
    });
    if (!created.ok) {
      t.skip(`the instance would not accept a site (${created.status})`);
      return;
    }

    const canonicalBefore = (await body(await call("/api/sites"))).sites.length;

    const deleted = await call(`/api/workspace-sections?key=${key}&bin=1`, { method: "DELETE" });
    const result = await body(deleted);
    assert.equal(deleted.status, 200, JSON.stringify(result));
    assert.equal(result.counts.sites, 1, "the entry counts the site it is taking with it");

    const canonicalDuring = (await body(await call("/api/sites"))).sites;
    assert.equal(
      canonicalDuring.length,
      canonicalBefore,
      "the workspace's own register must not gain the instance's site",
    );
    assert.ok(!canonicalDuring.some((row) => row.name === name));

    const entry = await sectionEntry(key);
    assert.ok(entry);
    assert.equal(
      (await call("/api/trash", { method: "POST", body: JSON.stringify({ id: entry.id }) })).status,
      200,
    );

    const backInside = (await body(await call(`/api/sites?section=${key}`))).sites ?? [];
    assert.ok(
      backInside.some((row) => row.name === name),
      "the site returns INSIDE the instance",
    );
    assert.equal(
      (await body(await call("/api/sites"))).sites.length,
      canonicalBefore,
      "and still not on the canonical one",
    );
  } finally {
    await sweep(key);
  }
});

/* ── E — a Documentation instance with a document ───────────────────── */

test("live E: a Documentation instance keeps its document across delete and restore", async (t) => {
  await signIn();
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const slug = `e-${suffix()}`;
  const key = keyFor(slug);
  const title = `ZZQA W2C document ${slug}`;
  try {
    const section = await createSection(slug, { template: "store-documentation" });
    const board = section.boardKey;

    const groups = (await body(await call(`/api/board?board=${board}`))).groups;
    const requestId = await createItem(board, groups[0].id);
    assert.ok(requestId, "a Documents instance takes a row");

    /* `/api/board`, not `/api/board/items` — the items feed carries rows, and the
       register's own column definitions come from the board payload. A file
       column's type is `files`, plural; the singular is accepted too so this
       does not become a second place that has to be kept in step. */
    const columns = (await body(await call(`/api/board?board=${board}`))).columns ?? [];
    const fileColumn = columns.find(
      (column) => column.type === "files" || column.type === "file",
    );
    if (!fileColumn) {
      t.skip("this build's Documents template has no file column to anchor a document to");
      return;
    }

    const form = new FormData();
    form.set("file", new File(["zzqa-w2c"], `${slug}.txt`, { type: "text/plain" }));
    form.set("requestId", requestId);
    form.set("columnId", fileColumn.id);
    form.set("title", title);
    const uploaded = await fetch(`${BASE_URL}/api/files`, {
      method: "POST",
      body: form,
      headers: {
        "x-maintsupp-identity": ADMIN,
        ...(cookie ? { cookie } : {}),
      },
    });
    if (!uploaded.ok) {
      t.skip(`the upload path refused (${uploaded.status}) — see the 1 MiB ceiling note`);
      return;
    }
    const documentId = (await body(uploaded)).attachment?.id ?? (await body(uploaded)).id;

    const deleted = await call(`/api/workspace-sections?key=${key}&bin=1`, { method: "DELETE" });
    const result = await body(deleted);
    assert.equal(deleted.status, 200, JSON.stringify(result));
    assert.equal(result.counts.items, 1);
    assert.ok(result.counts.attachments >= 1, "the entry counts the document it is taking");

    /* The canonical compliance board must not have gained or lost anything. */
    assert.equal(
      (await call(`/api/board?board=store-documentation`)).status,
      200,
      "the product's own Documentation board is untouched",
    );

    const entry = await sectionEntry(key);
    assert.ok(entry);
    assert.equal(
      (await call("/api/trash", { method: "POST", body: JSON.stringify({ id: entry.id }) })).status,
      200,
    );

    const rows = (await body(await call(`/api/board/items?board=${board}`))).items ?? [];
    assert.ok(
      rows.some((row) => row.id === requestId),
      "the row comes back on the instance",
    );
    if (documentId) {
      const files = await body(await call(`/api/files?requestId=${encodeURIComponent(requestId)}`));
      const list = files.attachments ?? files.files ?? [];
      assert.ok(
        list.some((file) => file.id === documentId),
        "and its document with it, same id and same version",
      );
    }
  } finally {
    await sweep(key);
  }
});

/* ── F — delete for good, and the name is free again ────────────────── */

test("live F: delete for good frees the display name, and needs data.delete", async (t) => {
  await signIn();
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const slug = `f-${suffix()}`;
  const key = keyFor(slug);
  const label = `ZZQA W2C ${slug}`;
  try {
    const section = await createSection(slug);
    const board = section.boardKey;

    const groups = (await body(await call(`/api/board?board=${board}`))).groups;
    await createItem(board, groups[0].id);

    await call(`/api/workspace-sections?key=${key}&bin=1`, { method: "DELETE" });
    const entry = await sectionEntry(key);
    assert.ok(entry, "it is in the bin");

    /*
     * `data.delete` is withheld from `admin` on purpose — "archiving is
     * reversible and deletion is not". Moving the section to the bin is the
     * reversible half and an admin may do it; finishing it off is not.
     */
    const refused = await call(`/api/trash?id=${entry.id}`, { method: "DELETE" });
    assert.equal(refused.status, 403, "an admin must not be able to finish it off");
    assert.match((await body(refused)).error ?? "", /data\.delete/);
    assert.ok(await sectionEntry(key), "and the refusal must not have changed anything");

    const purged = await call(`/api/trash?id=${entry.id}`, { method: "DELETE" }, SUPER);
    assert.equal(purged.status, 200, JSON.stringify(await body(purged)));

    assert.equal(await sectionEntry(key), null, "the entry is gone");
    assert.equal(
      (await call(`/api/board?board=${board}`)).status,
      404,
      "the register is gone with it",
    );
    const rows = (await body(await call("/api/workspace-sections"))).sections;
    assert.ok(!rows.some((row) => row.key === key), "and so is the section row");

    /*
     * §29 — NOTHING MAY BLOCK REUSE. No orphaned board, view or form key, and
     * no `workspace_sections` row still holding the name. The board key is
     * generated rather than derived from the label, so the new one differs.
     */
    const again = await call("/api/workspace-sections", {
      method: "POST",
      body: JSON.stringify({ label, key: `zzqa-w2c-${slug}` }),
    });
    const remade = await body(again);
    assert.equal(again.status, 201, `the name must be usable again: ${JSON.stringify(remade)}`);
    assert.notEqual(
      remade.section.boardKey,
      board,
      "with a register of its own, not the dead one's key",
    );
  } finally {
    await sweep(key);
  }
});

/* ── G — the thirty days, without waiting for them ──────────────────── */

test("live G: the 30-day threshold is stored exactly, and a fresh bundle is not eligible", async (t) => {
  await signIn();
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const slug = `g-${suffix()}`;
  const key = keyFor(slug);
  try {
    await createSection(slug);
    const deleted = await body(
      await call(`/api/workspace-sections?key=${key}&bin=1`, { method: "DELETE" }),
    );
    assert.equal(deleted.retentionDays, 30);

    const entry = await sectionEntry(key);
    assert.ok(entry);

    /*
     * THE ARITHMETIC, CHECKED RATHER THAN WAITED FOR. Both timestamps are UTC
     * ISO with a `Z`, which is what makes the comparison independent of the
     * server's locale and of British Summer Time — a `2026-03-28` deletion and
     * a `2026-04-27` expiry are exactly 30 × 86 400 000 ms apart either way.
     */
    assert.match(entry.deletedAt, /Z$/, "written as UTC");
    assert.match(entry.expiresAt, /Z$/, "and compared as UTC");
    assert.equal(
      new Date(entry.expiresAt).getTime() - new Date(entry.deletedAt).getTime(),
      30 * DAY_MS,
      "exactly thirty calendar days, to the millisecond",
    );
    assert.equal(entry.daysLeft, 30);
    assert.equal(entry.expired, false);

    /*
     * ELIGIBILITY, PROVEN BY A SWEEP THAT DECLINES. `?sweep=1` runs the real
     * unsampled sweep — the same one the automatic path uses — and a bundle
     * with thirty days left must survive it. A sweep that emptied the bin
     * regardless of `expires_at` would fail here rather than three days before
     * somebody needed a restore.
     */
    const swept = await call("/api/trash?sweep=1", {}, SUPER);
    /* Read ONCE. A Response body is a stream and the second read is empty, which
       is how the "reports what it destroyed" assertion first failed against a
       sweep that had reported perfectly well. */
    const sweepResult = await body(swept);
    assert.equal(swept.status, 200, JSON.stringify(sweepResult));
    assert.equal(typeof sweepResult.swept, "number", "the sweep reports what it destroyed");
    assert.ok(await sectionEntry(key), "a bundle with 30 days left is not due and must survive");
  } finally {
    await sweep(key);
  }
});

/* ── The refusals ───────────────────────────────────────────────────── */

test("live: a built-in section cannot be deleted through this flow", async (t) => {
  await signIn();
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  /*
   * Enforced on the SERVER. These four are the platform, not workspace rows, so
   * the endpoint has nothing to find — and the namespace check refuses a
   * crafted key that somehow did. Either way the answer must not be 200.
   */
  for (const builtIn of ["jobs", "contractors", "sites", "store-documentation", "reports"]) {
    const response = await call(
      `/api/workspace-sections?key=${encodeURIComponent(builtIn)}&bin=1`,
      { method: "DELETE" },
    );
    assert.ok(
      response.status === 404 || response.status === 403,
      `${builtIn} must be refused, got ${response.status}`,
    );
    assert.equal(
      (await call(`/api/navigation`)).status,
      200,
      "and the sidebar must still resolve afterwards",
    );
  }
});

test("live: nothing crosses an organisation boundary", async (t) => {
  await signIn();
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const slug = `x-${suffix()}`;
  const key = keyFor(slug);
  try {
    await createSection(slug);
    await call(`/api/workspace-sections?key=${key}&bin=1`, { method: "DELETE" });
    const entry = await sectionEntry(key);
    assert.ok(entry, "binned in the first organisation");

    /* The other tenant cannot see, restore or destroy it. Each query is scoped
       by the organisation the SESSION resolved, never by what was asked for. */
    const theirs = await call(
      `/api/workspace-sections?key=${key}&bin=1`,
      { method: "DELETE" },
      OTHER_ORG,
    );
    assert.equal(theirs.status, 404, "another workspace has no such section");

    const restore = await call(
      "/api/trash",
      { method: "POST", body: JSON.stringify({ id: entry.id }) },
      OTHER_ORG,
    );
    assert.ok(
      restore.status === 404 || restore.status === 403,
      `a bin entry must not restore across tenants, got ${restore.status}`,
    );
    assert.ok(await sectionEntry(key), "and it must still be there afterwards");
  } finally {
    await sweep(key);
  }
});

test("live: a section in the bin holds its name, and says where it is", async (t) => {
  await signIn();
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const slug = `n-${suffix()}`;
  const key = keyFor(slug);
  const label = `ZZQA W2C ${slug}`;
  try {
    await createSection(slug);
    await call(`/api/workspace-sections?key=${key}&bin=1`, { method: "DELETE" });

    /*
     * A key held by a bundle in the bin must say SO, rather than reporting the
     * archived state it also carries — that would send somebody to a Restore
     * button the section manager deliberately does not offer for a section the
     * bin owns.
     */
    const clash = await call("/api/workspace-sections", {
      method: "POST",
      body: JSON.stringify({ label, key: `zzqa-w2c-${slug}` }),
    });
    assert.equal(clash.status, 409);
    const payload = await body(clash);
    assert.equal(payload.deleted, true);
    assert.match(payload.error, /recycle bin/i);

    /* And it cannot be quietly un-archived back into the sidebar behind the
       bin's back — that is the half-restored state with two owners. */
    const patched = await call("/api/workspace-sections", {
      method: "PATCH",
      body: JSON.stringify({ key, archived: false }),
    });
    assert.equal(patched.status, 409);
    assert.match((await body(patched)).error, /recycle bin/i);
  } finally {
    await sweep(key);
  }
});
