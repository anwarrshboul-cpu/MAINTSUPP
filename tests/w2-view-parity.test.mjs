/**
 * W2 REQUIREMENT C — VIEW PARITY.
 *
 * THE OWNER'S WORDS. "For every view type offered on a section page — Table,
 * Form, Kanban, Calendar, Timeline, Chart, File gallery, Reports, Form results,
 * Form responses, Flat table — classify each as SUPPORTED (implement it for
 * instances), NOT SUPPORTED BY ORIGINAL (must not be offered at all — not
 * greyed, not a no-op), or REQUIRES CONFIGURATION (offered, but tells the
 * operator exactly what to configure and then works). There must be no
 * clickable no-ops, and nothing that should exist may be disabled to avoid
 * implementing it."
 *
 * TWO REPORTED DEFECTS THIS FILE HOLDS SHUT:
 *
 *   1. "+ Add View produced no working view." Picking Timeline wrote a real
 *      `board_views` row, drew a real tab and opened a pane reading "Timeline
 *      is not built yet" — a dead tab somebody then had to find and delete.
 *   2. "A view added to one board appeared on another." `POST` read the board
 *      from the JSON body while the chrome put it in the query string, so every
 *      view added on a section's register was written to the canonical job
 *      board. Proven at the time: a Calendar added on `sec-f47167fe0157`
 *      appeared as a twelfth tab on `maintenance`.
 *
 * WHAT THE CLASSIFICATION IS EXPRESSED AS, so a reader can find it. It is
 * `VIEW_TYPES` plus `typesFor` in `app/api/board/views/route.ts`, and nothing
 * else:
 *
 *   · SUPPORTED — in `VIEW_TYPES`, and `built` for this board.
 *   · REQUIRES CONFIGURATION — in `VIEW_TYPES`, `built: false` for this board,
 *     carrying `unavailable`: the sentence saying what to configure. Today the
 *     only members are `form-results` and `form-responses` on a register with
 *     no form of its own, and they stop being members the moment one is made.
 *   · NOT SUPPORTED BY THE ORIGINAL — not in `VIEW_TYPES` at all. Timeline is
 *     the only one, and it is absent rather than disabled.
 *
 * `form` IS IN THE FIRST GROUP, and that is the subtle one. The Form view is
 * the form's own surface, not a reader of it: `FormBuilder` offers "Create a
 * form for this register" when the board has none (W2 requirement B). Gating
 * the type would have made that button unreachable on exactly the boards it
 * exists for — the tab that offers to create the thing, refused because the
 * thing has not been created. So it is offered, clickable, and the
 * configuration step lives INSIDE the view, which is still "tells the operator
 * exactly what to configure and then works".
 *
 * The whole point of it living there is that ONE function answers for the
 * canonical job board and for every generated instance, so an instance offers
 * what its source offers by construction rather than by a board-key test. The
 * live half below proves the two answers are equal where they can be and
 * differ only by a board's own configuration.
 *
 * It skips cleanly with no server. Fixtures are keyed `section:v1qa-*` and are
 * swept BY EXACT KEY — never by substring, which has eaten other lanes'
 * fixtures on this shared database before. `section:testtt` on Staging is the
 * OWNER'S data.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
/* Comments in this codebase quote the very identifiers being banned, so a
   source pin against a pattern has to read the code alone. */
const codeOnly = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ROUTE = "app/api/board/views/route.ts";
const CHROME = "app/(app)/portal/board-chrome.tsx";
const PANE = "app/(app)/portal/board-view-pane.tsx";
const MENU = "app/(app)/portal/board-actions/view-menus.tsx";
const TYPES = "app/(app)/portal/board-view-types.ts";

/** The offer list the "+" menu and the tab strip are both drawn from. */
async function viewTypes() {
  const source = await read(ROUTE);
  const block = source.slice(
    source.indexOf("export const VIEW_TYPES"),
    source.indexOf("] as const;"),
  );
  return [...block.matchAll(/key: "([^"]+)", label: "([^"]+)"/g)].map(([, key, label]) => ({
    key,
    label,
  }));
}

/* ------------------------------------------------------------------ */
/* The classification, and where it is written down                    */
/* ------------------------------------------------------------------ */

/**
 * The owner's eleven, and what the product does with each.
 *
 * `key` is the app's own identifier for the type. `state` is the classification
 * as this build implements it. Written out in full so the table the owner asked
 * for is IN THE SUITE rather than in a report nobody re-reads.
 */
const CLASSIFICATION = [
  ["Table", "table", "supported"],
  /* Offered and CLICKABLE on every board. The configuration step is inside the
     view — see the note at the top of this file. */
  ["Form", "form", "requires-configuration"],
  ["Kanban", "kanban", "supported"],
  ["Calendar", "calendar", "supported"],
  ["Timeline", "timeline", "not-supported"],
  ["Chart", "chart", "supported"],
  ["File gallery", "gallery", "supported"],
  ["Reports", "reports", "supported"],
  ["Form results", "form-results", "requires-configuration"],
  ["Form responses", "form-responses", "requires-configuration"],
  ["Flat table", "flat-table", "supported"],
];

test("W2 C every one of the owner's eleven types is classified, and the classification is the offer list", async () => {
  const offered = new Map((await viewTypes()).map((type) => [type.key, type.label]));

  for (const [label, key, state] of CLASSIFICATION) {
    if (state === "not-supported") {
      /*
       * "Must not be offered at all — not greyed, not a no-op." An entry in
       * `VIEW_TYPES` IS an offer, whatever `built` says, because that list is
       * what the "+" menu is drawn from.
       */
      assert.equal(offered.has(key), false, `${label} must not be in the offer list at all`);
      continue;
    }
    assert.ok(offered.has(key), `${label} is supported and must be offered`);
    assert.equal(offered.get(key), label, `${label} must be labelled as the owner names it`);
  }
});

test("W2 C the only type that is not supported by the original is the one with no renderer", async () => {
  /*
   * Timeline is the whole of "NOT SUPPORTED BY ORIGINAL": monday's capture of
   * board 1139774521 has no timeline tab, and this product has never had a
   * renderer for one. The rule that matters is that its absence is a PROPERTY
   * OF THE PRODUCT and not of a board — there is no board on which it is
   * offered, so an instance and its source cannot disagree about it.
   */
  const pane = await read(PANE);
  assert.doesNotMatch(
    pane,
    /activeView\.type === "timeline"/,
    "there is no timeline renderer, which is why it is not offered",
  );
  const route = codeOnly(await read(ROUTE));
  assert.doesNotMatch(route, /"timeline"/, "and nothing in the route names it either");
});

test("W2 C every offered type has somewhere to render, and every renderer is offered", async () => {
  /*
   * BOTH DIRECTIONS, because the owner's rule has two halves.
   *
   *   · No clickable no-ops: a type in the menu must reach a component.
   *   · "Nothing that should exist may be disabled to avoid implementing it":
   *     a component that exists must be reachable from the menu, or the product
   *     is hiding work it has already done.
   *
   * `table` is the exception in the first direction and is named rather than
   * skipped: it is the grid BELOW the chrome, which is why `viewReplacesGrid`
   * treats it as the one type that does not replace anything.
   */
  const pane = await read(PANE);
  const rendered = new Set(
    [...pane.matchAll(/activeView\.type === "([^"]+)"/g)].map(([, type]) => type),
  );

  for (const { key, label } of await viewTypes()) {
    if (key === "table") {
      assert.match(
        pane,
        /view\.type !== "table"/,
        "Table is the grid below the chrome — see viewReplacesGrid",
      );
      continue;
    }
    assert.ok(rendered.has(key), `${label} is offered and must render a pane`);
  }

  const offered = new Set((await viewTypes()).map((type) => type.key));
  for (const type of rendered) {
    assert.ok(offered.has(type), `the pane renders "${type}", which nothing offers`);
  }
});

test("W2 C a type that requires configuration is offered WITH the reason, never as 'soon'", async () => {
  /*
   * The middle state, and the one the menu could not previously express. A Form
   * tab on a register with no form of its own is not "not built yet" — the
   * renderer shipped a year ago — and it is not "not supported by the original"
   * either, because the job board next door has one. So it is drawn, with the
   * sentence that says what to configure, and it cannot be clicked into a dead
   * tab. The shape mirrors `SECTION_TEMPLATES`, whose own test states the rule:
   * "an unavailable entry with no reason is a dead control".
   */
  const menu = await read(MENU);
  assert.match(
    menu,
    /className=\{`ba-menu__item\$\{type\.unavailable \? " is-unconfigured" : ""\}`\}/,
    "an entry that needs configuration must be drawn differently from one that works",
  );
  assert.match(
    menu,
    /\{type\.unavailable && <small>\{type\.unavailable\}<\/small>\}/,
    "and it must print the reason, not a 'soon' pill",
  );
  assert.match(
    menu,
    /!type\.built && !type\.unavailable/,
    "'soon' is reserved for a type with no reason of its own — a retired one",
  );

  /* The pane says the same thing, from the same field, rather than keeping a
     second copy of which types are form-backed. */
  const pane = await read(PANE);
  assert.match(pane, /activeView\.unavailable \? `— \$\{activeView\.unavailable\}`/);
  assert.doesNotMatch(
    pane,
    /const FORM_BACKED/,
    "the pane must not restate the classification it is being told",
  );
});

test("W2 C the sentence has one author — the route — and the refusal reuses it", async () => {
  const route = await read(ROUTE);
  assert.match(route, /function needsOwnForm\(label: string\)/);
  assert.match(
    route,
    /built: false, unavailable: needsOwnForm\(type\.label\)/,
    "typesFor is where a type becomes unavailable, and where the reason is written",
  );
  assert.match(
    route,
    /definition\.unavailable \?\?/,
    "POST must refuse with the same words the menu shows, not a second sentence",
  );
  /* The refusal is a 409 — the request was well formed and the board is not
     ready for it — and never a 400, which would blame the caller's input. */
  const post = route.slice(route.indexOf("export async function POST"));
  assert.match(post.slice(0, post.indexOf("let key = slug")), /409,/);
});

/* ------------------------------------------------------------------ */
/* One function answers for both — no board-key comparisons            */
/* ------------------------------------------------------------------ */

test("W2 C nothing in the view path decides what a board may do by comparing its key", async () => {
  /*
   * THE RULE. "A view the original does not support must be absent from an
   * instance's picker for the same reason it is absent on the original,
   * expressed in shared code — not by comparing board keys."
   *
   * Three literals were doing exactly that and are gone:
   *
   *   · `app/api/board/views/route.ts` — `if (boardKey !== DEFAULT_BOARD_KEY)
   *     return;` in `seedViews`, which gave the job board eleven tabs and a
   *     register generated from the SAME Jobs template one.
   *   · `app/(app)/portal/board-chrome.tsx` ×2 — `boardId === "store-
   *     documentation"`, which decided whether a board has a tab strip by its
   *     name. It now asks whether the board HAS views.
   *
   * Comments are stripped before matching because every one of those lines is
   * quoted in the note explaining why it went.
   */
  for (const file of [ROUTE, CHROME, PANE, MENU, TYPES]) {
    const code = codeOnly(await read(file));
    for (const literal of ['"maintenance"', '"store-documentation"', "DEFAULT_BOARD_KEY"]) {
      assert.ok(
        !code.includes(literal),
        `${file} still decides something by the board key ${literal}`,
      );
    }
    assert.doesNotMatch(
      code,
      /startsWith\("sec-"\)/,
      `${file} must not recognise an instance by its key prefix either`,
    );
  }
});

test("W2 C which types a board is offered is one function, asked of the board", async () => {
  const route = await read(ROUTE);
  const get = route.slice(
    route.indexOf("export async function GET"),
    route.indexOf("export async function POST"),
  );
  /* The SAME call in GET and in POST, so the menu cannot offer something the
     write path refuses, or refuse something the menu offers. */
  assert.match(get, /await typesFor\(db, orgId, board\.key\)/);
  const post = route.slice(route.indexOf("export async function POST"));
  assert.match(post, /await typesFor\(db, orgId, board\.key\)/);

  /* And the seeded strip is filtered through that same answer, so a board is
     never given a tab it cannot open. */
  assert.match(get, /await seedViews\(db, orgId, board\.key, types\)/);
  assert.match(
    route,
    /function seedStripFor\(types: ViewTypeOffer\[\]\)/,
    "the strip is a filter over the offer, not a second list",
  );
});

test("W2 C the chrome draws a strip for a board that has views, not for one with the right name", async () => {
  const chrome = codeOnly(await read(CHROME));
  assert.match(chrome, /if \(!boardId\) return;/, "only an unaddressed board is skipped");
  assert.match(
    chrome,
    /\{views\.length > 0 && \(/,
    "the nav is drawn from what came back, so a board that keeps its tabs elsewhere draws none",
  );
});

/* ------------------------------------------------------------------ */
/* Sizes — a file split to relieve a ceiling gets one of its own       */
/* ------------------------------------------------------------------ */

test("W2 C board-view-types.ts stays small", async () => {
  /*
   * `board-view-types.ts` came out of `board-chrome.tsx` when requirement C's
   * `unavailable` field pushed it past its 500-line limit — the same split, for
   * the same reason, that produced `board-view-pane.tsx`, `board-view-writes.ts`
   * and `board-actions/view-menus.tsx`.
   *
   * Capped here rather than in `tests/stage-eight-board-split.test.mjs`, where
   * the rest of the ceilings live, only because that file belongs to another
   * lane in this batch and two lanes editing it would collide. It should be
   * MOVED there — the ceilings are worth more in one list — and this test
   * deleted when it is.
   */
  const source = await read(TYPES);
  const lines = source.split("\n").length;
  assert.ok(lines <= 120, `${TYPES} is ${lines} lines, over its 120 limit — split it further.`);
  assert.ok(
    !/^import /m.test(source),
    "a shared shape that imports nothing can be read by anything without a cycle",
  );
});

/* ------------------------------------------------------------------ */
/* Against a running server                                            */
/* ------------------------------------------------------------------ */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const ADMIN = "admin@sunnamusk-uk.test.maintsupp.com";
/* Purging needs `data.delete`, which `admin` is deliberately not given. */
const SUPER = "super-admin@test.maintsupp.com";

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

/**
 * The dev server is shared with the rest of the batch and answers an HTML
 * error page under load. Parsing that as JSON produces `Unexpected token '<'`
 * with nothing to look at, so the raw body goes into the assertion instead —
 * see the note in CLAUDE.md about an 18–70 second failure being starvation.
 */
async function body(response, what) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    assert.fail(`${what} answered ${response.status} with ${text.slice(0, 200)}`);
  }
}

/**
 * Everything one fixture leaves behind, removed BY EXACT ID.
 *
 * The bin has to be emptied first and that is not tidiness. Deleting a view
 * SENDS IT TO THE RECYCLE BIN (W13-06), and `DELETE /api/workspace-sections
 * ?purge=1` refuses to destroy a register that has restorable rows — quite
 * rightly, or Restore would offer them back onto a board that no longer
 * exists. Without this the archived section survives its own purge, and the
 * next run is refused its LABEL: "was removed and is archived."
 *
 * Never a substring sweep. `section:testtt` on Staging is the owner's.
 */
async function discard(key, board) {
  if (board) {
    const listed = await call(`/api/trash?board=${encodeURIComponent(board)}`, {}, SUPER);
    if (listed.ok) {
      const payload = await listed.json().catch(() => ({}));
      for (const entry of payload.bin?.entries ?? []) {
        await call(`/api/trash?id=${encodeURIComponent(entry.id)}`, { method: "DELETE" }, SUPER);
      }
    }
  }
  await call(`/api/workspace-sections?key=${encodeURIComponent(key)}`, { method: "DELETE" });
  await call(
    `/api/workspace-sections?key=${encodeURIComponent(key)}&purge=1`,
    { method: "DELETE" },
    SUPER,
  );
}

/**
 * A Jobs instance, and the board key it was given.
 *
 * One key and one label per test rather than a shared pair, because a fixture
 * that fails to purge holds its LABEL against the next test and every
 * subsequent one fails for a reason that has nothing to do with what it tests.
 */
async function instance(key, label) {
  await discard(key);
  const send = () =>
    call("/api/workspace-sections", {
      method: "POST",
      body: JSON.stringify({ key, label, template: "jobs" }),
    });
  let response = await send();
  /*
   * ONE RETRY, AND ONLY FOR AN ANSWER THE APP DID NOT WRITE.
   *
   * The app's own failures are JSON carrying an `error`; a 5xx with an empty or
   * HTML body is the dev server reloading its module graph, which it does
   * whenever another lane saves a file in this shared tree. Retrying that is
   * not tolerance for a broken endpoint — a second non-JSON answer still fails
   * the test, with the raw body in the message.
   */
  if (response.status >= 500) {
    const text = await response.clone().text();
    if (!text.trim().startsWith("{")) {
      await discard(key);
      response = await send();
    }
  }
  const payload = await body(response, `creating ${key}`);
  assert.equal(response.status, 201, `create failed: ${payload.error}`);
  return payload.section.boardKey;
}

async function viewsOf(board) {
  const payload = await body(
    await call(`/api/board/views?board=${encodeURIComponent(board)}`),
    `views of ${board}`,
  );
  assert.ok(
    Array.isArray(payload.views) && Array.isArray(payload.types),
    `views of ${board} answered ${JSON.stringify(payload).slice(0, 200)}`,
  );
  return payload;
}

/**
 * One view write, with a single retry on the route's generic 503.
 *
 * NOT a softened assertion — a 503 still fails the test if it comes back twice,
 * and every status other than 503 is taken at face value. It is there because
 * these tests share one Miniflare D1 with whatever else is running against the
 * dev server, and a locked SQLite file surfaces as this route's catch-all
 * "Board views are temporarily unavailable." CLAUDE.md names the symptom: a
 * live test that takes 18-70 seconds is starvation, not an assertion. Retrying
 * the write once distinguishes "the database was busy" from "the route refuses
 * this", which is the only thing being tested here.
 */
async function addView(board, type, name) {
  const send = () =>
    call(`/api/board/views?board=${encodeURIComponent(board)}`, {
      method: "POST",
      body: JSON.stringify({ name, type: type.key ?? type, icon: type.icon }),
    });
  let response = await send();
  /* Three attempts, backing off, because the lock is held for as long as
     whatever else is writing takes. Still fails if it never clears. */
  for (let attempt = 0; response.status === 503 && attempt < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    response = await send();
  }
  return { status: response.status, payload: await body(response, `adding ${type.key ?? type}`) };
}

test("live: an instance is offered exactly what the canonical Jobs board is offered, minus its own configuration", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const key = "section:v1qa-offer";
  let board;
  try {
    board = await instance(key, "V1QA-Offer");
    const canonical = await viewsOf("maintenance");
    const mine = await viewsOf(board);

    /* THE SAME TYPES, IN THE SAME ORDER. Not a subset, not a superset — one
       list, answered by one function. A difference here would mean an instance
       has a different idea of what the product can do than its source. */
    assert.deepEqual(
      mine.types.map((type) => type.key),
      canonical.types.map((type) => type.key),
      "the offer list is the product's, not the board's",
    );

    /* Timeline is offered on NEITHER, which is what "absent for the same
       reason" means in practice. */
    for (const payload of [canonical, mine]) {
      assert.ok(
        !payload.types.some((type) => type.key === "timeline"),
        "Timeline must not be offered on any board",
      );
    }

    /* WHERE THEY DIFFER, AND WHY. Only the three form-backed types, only on the
       instance, and each carries the sentence saying what to configure. */
    const unavailable = mine.types.filter((type) => !type.built);
    assert.deepEqual(
      unavailable.map((type) => type.key),
      ["form-results", "form-responses"],
      "a register with no form of its own can serve everything else, Form included",
    );
    for (const type of unavailable) {
      assert.ok(
        typeof type.unavailable === "string" && type.unavailable.length > 40,
        `${type.key} is not offered and must say why`,
      );
      assert.match(type.unavailable, /form/i, "and the reason must name what to configure");
    }
    assert.ok(
      canonical.types.every((type) => type.built),
      "the job board has a form, so every offered type works there",
    );
  } finally {
    await discard(key, board);
  }
});

test("live: every type an instance is offered actually makes a working view on that instance", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const key = "section:v1qa-create";
  let board;
  try {
    board = await instance(key, "V1QA-Create");
    const { types } = await viewsOf(board);

    for (const type of types) {
      const { status, payload } = await addView(board, type, `V1QA ${type.label}`);

      if (!type.built) {
        /*
         * REQUIRES CONFIGURATION, and the server says so in the same words the
         * menu shows. 409 rather than 400: the request is fine, the board is
         * not ready. And critically NO ROW IS WRITTEN — a dead tab is the
         * defect, not the error.
         */
        assert.equal(status, 409, `${type.key} must be refused, not created`);
        assert.equal(payload.error, type.unavailable, "the refusal is the menu's own sentence");
        continue;
      }

      assert.equal(status, 201, `${type.key} was offered and failed: ${payload.error}`);
      assert.equal(payload.type, type.key);
    }

    /* AND EVERY ONE OF THEM IS ON THIS BOARD. This is defect 2 — a view added
       on a section's register used to be written to the canonical job board. */
    const mine = await viewsOf(board);
    const added = mine.views.filter((view) => view.name.startsWith("V1QA "));
    assert.equal(
      added.length,
      types.filter((type) => type.built).length,
      "every created view must be on the board it was created from",
    );
    assert.ok(added.every((view) => view.built), "and every one of them must render");

    const canonical = await viewsOf("maintenance");
    assert.ok(
      !canonical.views.some((view) => view.name.startsWith("V1QA ")),
      "nothing may have leaked onto the job board",
    );
  } finally {
    await discard(key, board);
  }
});

test("live: 'requires configuration' means it works once configured", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  /*
   * THE HALF OF THE OWNER'S THIRD CATEGORY THAT IS EASY TO SKIP. "Offered, but
   * tells the operator exactly what to configure AND THEN WORKS." A refusal
   * with a helpful sentence and no way to satisfy it is a dead control wearing
   * an apology, so this follows the sentence's own instruction and checks that
   * doing what it says is enough.
   *
   * The configuration is `POST /api/board/form` (W2 requirement B) — the same
   * verb the Form tab's "Create a form for this register" button sends. If that
   * endpoint is not there this test says so rather than failing: the two lanes
   * land together, and a missing create path is the form lane's news, not a
   * regression in the classification.
   */
  const key = "section:v1qa-config";
  let board;
  try {
    board = await instance(key, "V1QA-Config");
    const before = await viewsOf(board);
    const gated = before.types.filter((type) => !type.built).map((type) => type.key);
    assert.deepEqual(gated, ["form-results", "form-responses"]);

    const created = await call(`/api/board/form?board=${encodeURIComponent(board)}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (created.status === 404 || created.status === 405) {
      t.diagnostic("no POST /api/board/form — the create path has not landed yet");
      return;
    }
    assert.ok(created.ok, `creating this register's form failed: ${created.status}`);

    /* AND NOW THEY WORK — the same function, the same board, one thing changed. */
    const after = await viewsOf(board);
    assert.ok(
      after.types.every((type) => type.built),
      "every offered type must be available once the register has its own form",
    );
    for (const type of gated) {
      const { status } = await addView(board, type, `V1QA ${type}`);
      assert.equal(status, 201, `${type} must be addable once the form exists`);
    }
  } finally {
    await discard(key, board);
  }
});

test("live: an instance is seeded the Jobs strip, and a deleted tab does not come back", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const key = "section:v1qa-strip";
  let board;
  try {
    board = await instance(key, "V1QA-Strip");
    const first = await viewsOf(board);

    /*
     * THE PARITY THE OWNER IS BUYING. "The original section, with all its
     * functionality and configuration, but empty and independent." Before this,
     * an instance came up with the single `main` tab `provisionMainView` gives
     * it while the board it was built from came up with eleven.
     */
    assert.ok(first.views.length > 1, "an instance must be seeded its template's strip");
    const canonical = await viewsOf("maintenance");
    const canonicalKeys = canonical.views.map((view) => view.key);
    for (const view of first.views) {
      assert.ok(
        canonicalKeys.includes(view.key),
        `${view.key} is on the instance and not on the board it was built from`,
      );
    }
    /* The difference is exactly the tabs a board with no form cannot serve. */
    assert.deepEqual(
      canonicalKeys.filter((key) => !first.views.some((view) => view.key === key)),
      ["form-results", "form-responses"],
      "an instance is short only the two tabs that read a form's answers",
    );
    assert.ok(
      first.views.every((view) => view.built),
      "a seeded tab that cannot open is the dead tab this workstream is about",
    );

    /* SAME ORDER, NOT JUST THE SAME SET. monday's tab order is the thing being
       reproduced, and an instance that had the right tabs in a different order
       would not be the same section. Its positions are the canonical order with
       the two it cannot serve taken out, renumbered without gaps. */
    assert.deepEqual(
      [...first.views].sort((a, b) => a.position - b.position).map((view) => view.key),
      canonicalKeys.filter((key) => first.views.some((view) => view.key === key)),
      "the instance's strip is its source's order, minus what it cannot serve",
    );
    assert.deepEqual(
      first.views.map((view) => view.position).sort((a, b) => a - b),
      first.views.map((_, index) => index),
      "positions are renumbered, not left with holes where a tab was skipped",
    );

    const main = first.views.find((view) => view.key === "main");
    assert.equal(main.isDefault, true, "an instance opens on its Main table");
    assert.equal(main.system, true, "and that tab cannot be deleted");

    /* IDEMPOTENT, AND IT NEVER RESURRECTS. Stage 5's promise, held for the new
       caller as well as the old one. */
    const calendar = first.views.find((view) => view.key === "calendar");
    const removed = await call(
      `/api/board/views?id=${encodeURIComponent(calendar.id)}&board=${encodeURIComponent(board)}`,
      { method: "DELETE" },
    );
    assert.equal(removed.status, 200);
    const second = await viewsOf(board);
    assert.ok(
      !second.views.some((view) => view.key === "calendar"),
      "a deleted tab must not be seeded back on the next page load",
    );
  } finally {
    await discard(key, board);
  }
});

test("live: a view id belonging to board A is a 404 when addressed with ?board=B", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const key = "section:v1qa-cross-a";
  const otherKey = "section:v1qa-cross-b";
  let board;
  let other;
  try {
    board = await instance(key, "V1QA-Cross-A");
    other = await instance(otherKey, "V1QA-Cross-B");

    const mine = await viewsOf(board);
    const foreign = mine.views.find((view) => !view.system);
    assert.ok(foreign, "the instance needs a non-system tab to try to steal");

    /*
     * 404 — NOT 200, AND NOT 503. Every verb. A 200 would tell a client its
     * write landed when it did not; a 503 would tell a browser to retry
     * something no retry can fix, and would blame the workspace for a request
     * that is simply about the wrong board.
     */
    const rename = await call(`/api/board/views?board=${encodeURIComponent(other)}`, {
      method: "PATCH",
      body: JSON.stringify({ id: foreign.id, name: "V1QA stolen" }),
    });
    assert.equal(rename.status, 404, "a rename across boards must be refused");

    const setDefault = await call(`/api/board/views?board=${encodeURIComponent(other)}`, {
      method: "PATCH",
      body: JSON.stringify({ id: foreign.id, isDefault: true }),
    });
    assert.equal(setDefault.status, 404, "and so must re-defaulting one");

    const removed = await call(
      `/api/board/views?id=${encodeURIComponent(foreign.id)}&board=${encodeURIComponent(other)}`,
      { method: "DELETE" },
    );
    assert.equal(removed.status, 404, "and binning one");

    /*
     * REORDER WAS THE HOLE. The lookup is scoped to the board, so a foreign id
     * was simply not in the map and the loop `continue`d past it — the write
     * never happened, and the request came back `{ ok: true }`. Measured on the
     * running server before the fix: 200, with the job board untouched. A
     * caller told its reorder succeeded when it could not have.
     */
    const reorder = await call(`/api/board/views?board=${encodeURIComponent(other)}`, {
      method: "PATCH",
      body: JSON.stringify({ order: [{ id: foreign.id, position: 99 }] }),
    });
    assert.equal(reorder.status, 404, "a reorder naming another board's view must be refused");

    /* NOTHING MOVED, WHICH IS THE PROPERTY BEHIND ALL FOUR. */
    const after = await viewsOf(board);
    const unchanged = after.views.find((view) => view.id === foreign.id);
    assert.ok(unchanged, "the view must still be on its own board");
    assert.equal(unchanged.name, foreign.name);
    assert.equal(unchanged.position, foreign.position);
    assert.equal(unchanged.isDefault, foreign.isDefault);
  } finally {
    await discard(key, board);
    await discard(otherKey, other);
  }
});

test("live: a reorder is applied to the board it names, and to no other", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const key = "section:v1qa-order";
  let board;
  try {
    board = await instance(key, "V1QA-Order");
    const before = await viewsOf(board);
    const canonicalBefore = await viewsOf("maintenance");

    /* Reverse this board's own strip — a legitimate reorder, which must work. */
    const order = before.views.map((view, index) => ({
      id: view.id,
      position: before.views.length - 1 - index,
    }));
    const response = await call(`/api/board/views?board=${encodeURIComponent(board)}`, {
      method: "PATCH",
      body: JSON.stringify({ order }),
    });
    assert.equal(response.status, 200, "a board may reorder its own views");

    const after = await viewsOf(board);
    assert.deepEqual(
      after.views.map((view) => view.key),
      [...before.views].reverse().map((view) => view.key),
      "the strip must actually be in the new order",
    );

    /* And the canonical board's strip is byte-for-byte where it was. */
    const canonicalAfter = await viewsOf("maintenance");
    assert.deepEqual(
      canonicalAfter.views.map((view) => `${view.key}@${view.position}`),
      canonicalBefore.views.map((view) => `${view.key}@${view.position}`),
      "reordering one board's strip must not renumber another's",
    );
  } finally {
    await discard(key, board);
  }
});

test("live: a board that is not a Jobs register is not given the Jobs strip", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  /*
   * The property the board-key comparison used to hold, held by the column
   * test instead. Store Documentation declares its own three tabs in
   * `views/store-documentation-board.tsx` and holds no `board_views` rows;
   * seeding Fix Tracker or the Maintenance Request form onto it would offer
   * tabs that cannot render, and drawing a second strip over its own would be
   * worse.
   */
  const payload = await viewsOf("store-documentation");
  assert.deepEqual(payload.views, [], "Store Documentation keeps its own tabs");
  /* It is still ASKED the same question, and gets the same product answer —
     which is what stops "no strip" from meaning "no capabilities". */
  assert.ok(payload.types.length > 0, "the offer list is the product's, on every board");
});

test("live: an unknown board is a 404, and an empty ?board= is not the job board", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  /*
   * `portal-app.tsx` passes `activeCustom.boardKey ?? ""` for a section with no
   * register of its own. Reading that as "no opinion" would hand a detached
   * section the JOB BOARD's tab strip and let it write views onto it — the
   * whole of defect 2, by a different door.
   */
  const unknown = await call("/api/board/views?board=sec-000000000000");
  assert.equal(unknown.status, 404);
  const empty = await call("/api/board/views?board=");
  assert.equal(empty.status, 404);
  assert.equal((await empty.json()).error, "No board was named.");
});
