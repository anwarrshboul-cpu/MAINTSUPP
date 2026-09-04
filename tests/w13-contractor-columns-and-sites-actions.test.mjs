/**
 * W12 / W13 — TWO THINGS THE OWNER ASKED FOR ON THE REGISTERS.
 *
 * W12, on /dashboard/sites: the Actions column carried [+ Raise a ticket]
 * [Edit] [Close] on every row, and the owner boxed the raise control and asked
 * for it out of the register TABLE. It is out. What this file pins is the shape
 * of that removal — one mounting gone, the component and its four other homes
 * untouched, Edit and Close still there — because "remove a button" is the
 * class of change that is trivially re-added by somebody who does not know it
 * was deliberate, and equally trivially over-applied into deleting the feature.
 *
 * W13, on /dashboard/contractors: the register's first column is the
 * contractor's name, the SECOND is their contact details, and columns can be
 * reordered by dragging the header rather than only through Move left / Move
 * right in the header menu.
 *
 * ── WHAT IS ASSERTED AND WHAT IS NOT ─────────────────────────────────────
 *
 * The drop ARITHMETIC is exercised against numbers — the real module, real
 * column arrays shaped like the owner's register, hidden columns at sparse
 * positions — because that is where a column drag goes wrong and a source pin
 * cannot see it. `tests/register-source-of-truth.test.mjs` says why this suite
 * prefers derived answers to pinned text, and this file is built the same way.
 *
 * The GESTURE is not exercised here. Pointer capture, the movement threshold
 * and the drop indicator need a real browser and were verified in one; what is
 * pinned about them is the WIRING a pure test can see — that the arithmetic
 * comes from the board's proven module rather than a third implementation,
 * that only the draggable headers advertise themselves, and that the menu
 * fallback did not quietly go away with the arrival of the drag.
 *
 * NOTHING HERE TOUCHES THE DATABASE. There is no live call and therefore no
 * `ZZQA-` residue to sweep, which on a suite whose live tests share one
 * Miniflare D1 is the safest form this file can take.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const SITES_MANAGER = "app/(app)/portal/sites/sites-manager.tsx";
const RAISE = "app/(app)/portal/raise-ticket.tsx";
const GRID = "app/(app)/portal/contractor-register.tsx";
const DRAG = "app/(app)/portal/contractor-column-drag.ts";
const ORDER = "app/(app)/portal/contractor-column-order.ts";
const DRAG_CSS = "app/(app)/portal/contractor-register-drag.css";
const CATALOGUE = "app/lib/register-catalogue.ts";

/** Comments are prose and may say anything; the assertions read code only. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/*
 * `contractor-column-order.ts` imports one module — `register-client.ts` — and
 * neither pulls in React, a DOM or a bundler at runtime. Both are transpiled
 * and imported as data: URLs, the idiom
 * `tests/column-drag-and-recovery.test.mjs` established for exactly this.
 */
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const asModule = async (source) =>
  import(`data:text/javascript;base64,${Buffer.from(transpile(source)).toString("base64")}`);

/*
 * The one import `contractor-column-order.ts` makes is rewritten to the inlined
 * client, so the pair loads with no resolver. Everything else about the module
 * is the real source.
 */
const clientSource = await read("app/(app)/portal/register/register-client.ts");
const clientUrl = `data:text/javascript;base64,${Buffer.from(
  transpile(clientSource),
).toString("base64")}`;
const { orderAfterHeaderDrop } = await asModule(
  (await read(ORDER)).replace('from "./register/register-client"', `from "${clientUrl}"`),
);
/* The same inlined client the module above was linked against, so the preview
   helper and the arithmetic it previews are the one pair the component uses. */
const { columnsInOrder } = await import(clientUrl);

/* ── A register shaped like the owner's ─────────────────────────────────── */

/**
 * `[key, hidden]` in stored order, with `name` pinned and a run of hidden
 * columns between almost every pair of visible ones.
 *
 * The sparseness is the point and is copied from the owner's live register:
 * nine columns on the table out of thirty-one, so "one to the right on screen"
 * and "one to the right in the stored list" are almost never the same move.
 * A fixture with a dense order would pass every arrangement of this arithmetic,
 * including the wrong ones.
 */
const REGISTER = [
  ["name", false],
  ["contactName", false],
  ["email", true],
  ["phone", true],
  ["whatsappNumber", true],
  ["address", true],
  ["postcode", true],
  ["serviceCategories", true],
  ["availability", false],
  ["rating", true],
  ["dayRatePence", true],
  ["policyNumber", false],
  ["insuranceExpiry", false],
  ["notes", true],
  ["assigned", false],
  ["completed", false],
  ["completion", false],
  ["urgent", false],
];

const columns = () =>
  REGISTER.map(([key, hidden], position) => ({
    id: `rcol_${key}`,
    register: "contractors",
    key,
    title: key,
    type: "text",
    position,
    width: 160,
    native: true,
    nativeField: key,
    hidden,
    pinned: key === "name",
    settings: key === "name" ? { pinned: true } : {},
  }));

/**
 * The ids a drag may pick up, in the order they are drawn: every visible column
 * except the frozen lane. This is exactly what the component builds from
 * `registerTableColumns`, and exactly what the header advertises through
 * `data-column-id`.
 */
const drawnIds = () =>
  columns()
    .filter((column) => !column.hidden && column.key !== "name")
    .map((column) => column.id);

/** The keys a given order would draw on the table, in table order. */
const drawn = (order) =>
  order.filter((key) => {
    const column = columns().find((entry) => entry.key === key);
    return column && !column.hidden && key !== "name";
  });

/* ── W12 — the Sites register table ─────────────────────────────────────── */

test("W12 the Sites register table no longer mounts Raise a ticket, and nothing else lost it", async () => {
  const manager = await read(SITES_MANAGER);
  const code = codeOnly(manager);

  assert.doesNotMatch(
    code,
    /RaiseTicketButton/,
    "the Sites register table must not mount the raise control — the owner boxed " +
      "that column on /dashboard/sites and asked for it off the table",
  );
  assert.doesNotMatch(
    code,
    /from "\.\.\/raise-ticket"/,
    "and the import goes with the last usage rather than being left to lint",
  );

  /*
   * THE ROW'S OTHER TWO ACTIONS SURVIVE. This is the half of the change that is
   * easy to overshoot: "take the raise button out of the Actions column" and
   * "take the Actions column out" are one careless edit apart, and Edit and
   * Close are the only way to amend or close a site from the register.
   */
  assert.match(code, /data-label="Actions"/, "the Actions cell is still drawn");
  assert.match(code, /^\s*Edit\s*$/m, "Edit is still offered on every row");
  assert.match(code, /^\s*Close\s*$/m, "and Close on every open one");

  /*
   * AND THE FLEX ROW STAYS. It was introduced to stop the raise control
   * overlapping Edit and Close, so removing the control looks like a reason to
   * remove the wrapper — it is not. `.table-row-actions` is what WRAPS the two
   * survivors onto a second line at 390px; without it the cell offers less
   * width than the buttons need, nothing between it and the viewport scrolls,
   * and "Close" is simply not on the screen. See the block carrying that class
   * in `brand-overrides.css`, where the measurement is recorded.
   */
  assert.match(code, /className="table-row-actions"/, "the wrapping action row stays");
});

test("W12 the raise-ticket control itself and its four other homes are untouched", async () => {
  const raise = await read(RAISE);
  assert.match(
    raise,
    /export function RaiseTicketButton\(/,
    "the shared control still exists — only one of its mountings was removed",
  );
  assert.match(raise, /label = "Raise a ticket"/, "and it still has its default label");

  /*
   * FOUR SURFACES STILL RAISE AGAINST A SITE, and every one of them is a place
   * where a fault is genuinely being looked at rather than a register being
   * administered. If a future change takes one of these out, it should be
   * because somebody asked — not because this file's W12 removal was read as
   * "the product no longer raises tickets from context".
   */
  for (const file of [
    "app/(app)/portal/units/units-manager.tsx",
    "app/(app)/portal/views/store-compliance-tracker.tsx",
    "app/(app)/portal/views/store-documentation-board.tsx",
    "app/(app)/portal/portal-app.tsx",
  ]) {
    assert.match(
      codeOnly(await read(file)),
      /<RaiseTicketButton/,
      `${file} still raises against a site`,
    );
  }
});

/* ── W13 — first the name, then how to reach them ───────────────────────── */

test("W13 the contact block is a column of its own, drawn in one lane", async () => {
  const grid = codeOnly(await read(GRID));

  assert.match(
    grid,
    /export const CONTACT_COLUMN_KEY = "contactName";/,
    "the contact lane is a native column and not an invented key — a key with " +
      "no entity field behind it can only ever be blank",
  );
  assert.match(
    grid,
    /return columns\.find\(\(column\) => column\.nativeField === CONTACT_COLUMN_KEY\) \?\? null;/,
    "and it is found by native field, never by position, so it follows a drag",
  );

  /*
   * ONE LANE PER RENDER. The block is drawn in the contact column's lane, and
   * under the name ONLY when the register holds no contact column at all. Both
   * are pinned, because "drawn once" is a claim about the pair and not about
   * either half.
   */
  assert.match(grid, /if \(lane\.contact\) \{[\s\S]{0,600}\{contact\?\.\(row\)\}/);
  assert.match(grid, /\{contactColumn === null && contact\?\.\(row\)\}/);

  /*
   * AND A HIDDEN CONTACT COLUMN TAKES THE BLOCK WITH IT. The fallback tests
   * `=== null`, not `.hidden`. Falling back on hidden would put the block
   * straight back under the name the moment somebody unticked the column, which
   * is a checkbox that appears to do nothing — the defect
   * `tests/register-source-of-truth.test.mjs` opens with.
   */
  assert.doesNotMatch(
    grid,
    /contactColumn[\s\S]{0,80}\.hidden[\s\S]{0,120}contact\?\./,
    "the fallback must never be gated on the column's visibility",
  );

  // The catalogue seeds it second and shown; SOT-3 owns that pin in full.
  const catalogue = await read(CATALOGUE);
  assert.match(catalogue, /\{ field: "contactName", title: "Contact details"/);
});

test("W13 the header drag reuses the board's arithmetic rather than a third copy", async () => {
  const drag = await read(DRAG);

  /*
   * THE POINT OF THE PIN. There are two column drags in this product already —
   * the board's, and the Sites grid's ±1 delegation — and the failure mode a
   * third one introduces is not a crash: it is two gestures that FEEL
   * different, flip their indicator at different moments, and disagree about
   * what "one place to the right" means. The threshold, the midpoint rule and
   * the marker are imported from the module that is already tested against
   * numbers.
   */
  assert.match(
    drag,
    /import \{[\s\S]{0,200}COLUMN_DRAG_THRESHOLD,[\s\S]{0,200}\} from "\.\/board-column-drag";/,
    "the gesture takes its arithmetic from board-column-drag.ts",
  );
  for (const imported of ["columnDropIndex", "columnDropMarker"]) {
    assert.match(drag, new RegExp(`\\b${imported}\\b`), `and uses ${imported} from it`);
  }
  assert.doesNotMatch(
    codeOnly(drag),
    /const .*THRESHOLD\s*=\s*\d/,
    "and declares no threshold of its own",
  );

  /*
   * TOUCH IS REFUSED, and that is not an oversight to be fixed later. Swallowing
   * touch on the header costs the horizontal scroll that is the only way a
   * narrow screen reads a thirty-one-column table — the same call the board
   * made, for the same reason.
   */
  assert.match(
    codeOnly(drag),
    /if \(event\.pointerType === "touch"\) return;/,
    "a touch press is not a drag",
  );

  /*
   * THE TWO CHILDREN A PRESS MUST NOT SWALLOW. The resize separator owns its
   * own `pointerdown`, and the `…` button opens a popover on `click` that a 4px
   * twitch would otherwise eat.
   */
  assert.match(drag, /contractor-register__resize/, "the resize handle is excluded");
  assert.match(drag, /contractor-register__menu-anchor/, "and so is the column menu");
});

test("W13 only the movable headers advertise themselves, and the menu route is intact", async () => {
  const grid = codeOnly(await read(GRID));

  /*
   * WHAT LOOKS DRAGGABLE, WHAT IS DRAGGABLE AND WHAT THE DROP INDEX IS COUNTED
   * AGAINST ARE ONE FACT. The gesture measures `th[data-column-id]`, the CSS
   * puts the grab cursor on the same selector, and the component sets the
   * attribute only on a lane that has a column and is not the frozen one.
   */
  assert.match(
    grid,
    /const draggable = column !== null && !lane\.frozen;/,
    "the frozen lane and the column-less lanes are not draggable",
  );
  assert.match(grid, /data-column-id=\{draggable \? column\.id : undefined\}/);

  const css = await read(DRAG_CSS);
  assert.match(
    css,
    /\.contractor-register__table thead th\[data-column-id\] \{\s*cursor: grab;/,
    "and the cursor is on the same selector the gesture measures",
  );

  /*
   * THE KEYBOARD AND TOUCH ROUTE SURVIVES THE ARRIVAL OF THE DRAG. A drag has
   * no keyboard equivalent at all, and below 767px this table becomes cards
   * with no header to press, so Move left / Move right are not a legacy
   * fallback — they are the only route for two whole classes of user.
   */
  assert.match(grid, /^\s*Move left\s*$/m, "Move left is still in the header menu");
  assert.match(grid, /^\s*Move right\s*$/m, "and so is Move right");
  assert.match(
    grid,
    /canMoveRegisterColumn\(snap\.columns, column, -1, frozenKey\)/,
    "still offered from the same answer the press writes",
  );

  /*
   * NO WIDTH IN THE NEW STYLESHEET, and no breakpoint either. The contact
   * column's width is the stored one the reader drags, so a second declaration
   * here would give the column two owners and the drag would appear to do
   * nothing. And `@media` is not needed: the header is `display: none` below
   * 767 anyway, so a query here would be one more of this codebase's five
   * agreed breakpoints (640/767/768/1024/1280) to keep in step for no effect.
   */
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(cssCode, /@media/, "the drag stylesheet declares no breakpoint");
  assert.doesNotMatch(
    cssCode.slice(cssCode.indexOf(".contractor-register__contact")),
    /[^-]width:/,
    "and does not re-declare the contact column's width",
  );
});

/* ── W13 — the arithmetic, against numbers ──────────────────────────────── */

test("W13 a drop moves the column on the TABLE, however many hidden ones lie between", async () => {
  const all = columns();
  const ids = drawnIds();
  const before = drawn(all.map((column) => column.key));
  assert.deepEqual(
    before,
    ["contactName", "availability", "policyNumber", "insuranceExpiry", "assigned", "completed", "completion", "urgent"],
    "the fixture draws eight scrolling columns out of eighteen",
  );

  /*
   * `insuranceExpiry` (drawn 3rd of the scrolling run) dropped into the gap
   * before `contactName` (drawn 1st). Four hidden columns sit between them in
   * the stored order, which is the arrangement that made the old ±1 press write
   * a new order and leave the table looking identical.
   */
  const order = orderAfterHeaderDrop(all, ids, "rcol_insuranceExpiry", 0);
  assert.ok(order, "a real move produces an order");
  assert.deepEqual(
    drawn(order),
    ["insuranceExpiry", "contactName", "availability", "policyNumber", "assigned", "completed", "completion", "urgent"],
    "one drop, one visible change",
  );

  // Every column is still in the answer exactly once — hidden ones included.
  assert.equal(order.length, all.length, "the whole order is returned, not the visible part");
  assert.deepEqual(
    [...order].sort(),
    all.map((column) => column.key).sort(),
    "and nothing is lost or duplicated by the splice",
  );
});

test("W13 a drop past the last header lands it last on the table", async () => {
  const all = columns();
  const ids = drawnIds();
  const order = orderAfterHeaderDrop(all, ids, "rcol_contactName", ids.length);
  assert.ok(order);
  assert.deepEqual(
    drawn(order),
    ["availability", "policyNumber", "insuranceExpiry", "assigned", "completed", "completion", "urgent", "contactName"],
    "dropping past everything means after everything",
  );
});

test("W13 a drop back where it started writes nothing", async () => {
  const all = columns();
  const ids = drawnIds();
  /*
   * BOTH GAPS BESIDE A COLUMN ARE ITS OWN PLACE. The pointer is over the order
   * that still includes the carried column, so index `n` and index `n + 1` both
   * mean "leave it where it is" — and a reorder written for either would put a
   * change in the audit log for a gesture that changed nothing.
   */
  const at = ids.indexOf("rcol_policyNumber");
  assert.equal(orderAfterHeaderDrop(all, ids, "rcol_policyNumber", at), null);
  assert.equal(orderAfterHeaderDrop(all, ids, "rcol_policyNumber", at + 1), null);
});

test("W13 a one-place drop is the same write as one press of Move right", async () => {
  const all = columns();
  const ids = drawnIds();

  /*
   * ONE DEFINITION OF "LATER", AND THE DEFECT THIS CLOSES.
   *
   * `orderAfterMove` already delegates a one-place move to `orderAfterStep` —
   * but its test for "one place" is `|target - from| === 1` on the STORED list,
   * and on this fixture (which is the owner's arrangement) `availability` and
   * `policyNumber` are neighbours ON THE TABLE with two hidden columns between
   * them in the list. So the delegation never fired for the surface it was
   * written for and a one-column drag took the splice branch.
   *
   * Both branches draw the same table, which is why this is invisible until you
   * look at the stored order. A press is a SWAP: every column the gesture did
   * not name keeps its index, so Move right then Move left restores exactly
   * what was there. The splice drags the hidden run along and leaves the
   * columns panel's checklist rearranged after that round trip. Asserted
   * against the real `orderAfterStep`, so the two can never drift.
   */
  const client = await asModule(clientSource);
  const at = ids.indexOf("rcol_availability");
  const dropped = orderAfterHeaderDrop(all, ids, "rcol_availability", at + 2, "name");
  const pressed = client.orderAfterStep(all, "availability", 1, "name");
  assert.deepEqual(dropped, pressed, "the drag and the press write the same order");

  /*
   * AND THE ROUND TRIP IS THE POINT. Drag it one place later, then one place
   * earlier, and every key is back where it started — the twenty-two hidden
   * ones included, which is the half a screenshot cannot show.
   */
  const after = dropped
    .map((key) => all.find((column) => column.key === key))
    .map((column, position) => ({ ...column, position }));
  const afterIds = after
    .filter((column) => !column.hidden && column.key !== "name")
    .map((column) => column.id);
  const reverseFrom = afterIds.indexOf("rcol_availability");
  const back = orderAfterHeaderDrop(
    after,
    afterIds,
    "rcol_availability",
    reverseFrom - 1,
    "name",
  );
  assert.ok(back, "the reverse drag is a real move");
  assert.deepEqual(
    back,
    all.map((column) => column.key),
    "one place later then one place earlier restores the exact stored order",
  );
});

test("W13 the frozen lane cannot be carried and nothing lands to its left", async () => {
  const all = columns();
  const ids = drawnIds();

  /*
   * IT IS NOT IN THE DRAWN RUN AT ALL, which is how the "fixed first column"
   * constraint is kept — by construction, rather than by a check somebody can
   * forget. A caller that somehow named it gets null.
   */
  assert.ok(!ids.includes("rcol_name"), "the frozen lane advertises no drag id");
  assert.equal(orderAfterHeaderDrop(all, ids, "rcol_name", 3), null);

  /*
   * AND INDEX 0 IS THE FRONT OF THE SCROLLING RUN, NOT THE FRONT OF THE TABLE.
   * `name` stays first in every answer this function can produce.
   */
  for (const id of ids) {
    const order = orderAfterHeaderDrop(all, ids, id, 0);
    if (!order) continue;
    assert.equal(order[0], "name", `dropping ${id} at the front leaves the lane in place`);
  }
});

/* ── W13 — a drop is drawn before it is saved ───────────────────────────── */

/*
 * WHAT THE OWNER ACTUALLY REPORTED, and why these are not gesture tests.
 *
 * The drag saved correctly from the day it shipped. What it did not do was
 * SHOW anything: the drop fired a PATCH and then a GET, and until both came
 * back the header row was exactly where it had been — measured at ~1.4s and
 * ~0.2s against local dev, longer over the network, with no spinner on the
 * table and nothing else moving. The only reading available to a person is
 * that the drag did not take, so they reloaded the page, and the new order was
 * there. "It only works after a refresh" is what a correct write with no
 * feedback looks like from the outside.
 *
 * So what is pinned here is the two halves of the fix a pure test can see: the
 * arithmetic that says what the preview must draw, and the wiring that says the
 * preview is drawn first and undone ONLY when the server refuses.
 */

test("W13 the preview draws exactly the order the server is about to store", async () => {
  const all = columns();
  const ids = drawnIds();
  const carried = "rcol_policyNumber";
  const order = orderAfterHeaderDrop(all, ids, carried, ids.indexOf(carried) + 3);
  assert.ok(order, "the fixture drop must produce a write to preview");

  const preview = columnsInOrder(all, order);

  /*
   * THE POINT OF THE WHOLE HELPER. If the preview and the reconciling read
   * disagreed, the table would jump a second time when the GET landed — which
   * is a worse artefact than the delay it was added to remove.
   */
  assert.deepEqual(
    preview.map((column) => column.key),
    order,
    "the preview is the written order, not an approximation of it",
  );

  /* And what a reader SEES is the same table the reload draws. */
  assert.deepEqual(
    preview.filter((column) => !column.hidden && column.key !== "name").map((c) => c.key),
    drawn(order),
  );

  /*
   * POSITIONS RENUMBERED DENSELY 0..n-1, because that is what the route does
   * and the next drag is computed against these numbers. A preview that left
   * the old positions on the rows would make the SECOND drag in a row wrong.
   */
  assert.deepEqual(
    preview.map((column) => column.position),
    preview.map((_, index) => index),
  );
  assert.equal(preview.length, all.length, "no column is dropped by the preview");
});

test("W13 the preview keeps a column it was not told about, in its stored place", async () => {
  const all = columns();
  /* An order missing its last two entries — the shape an older client, or a
     future partial write, would send. The route keeps the unnamed ones at the
     end in stored order; anything else here would preview a reshuffle that
     never happens. */
  const partial = all.slice(0, -2).map((column) => column.key);
  const preview = columnsInOrder(all, partial);

  assert.deepEqual(
    preview.map((column) => column.key),
    all.map((column) => column.key),
  );
});

test("W13 the preview takes ids as well as keys, because the call it previews does", async () => {
  const all = columns();
  const byKey = columnsInOrder(all, orderAfterHeaderDrop(all, drawnIds(), "rcol_policyNumber", 0));
  const byId = columnsInOrder(
    all,
    byKey.map((column) => column.id),
  );
  assert.deepEqual(
    byId.map((column) => column.key),
    byKey.map((column) => column.key),
    "a preview that accepted less than reorderRegisterColumns would be a trap",
  );
});

test("W13 a drop is drawn before it is written, and undone only if the write is refused", async () => {
  const code = codeOnly(await read(GRID));

  /*
   * THE ORDER OF THESE TWO STATEMENTS IS THE FIX. `setSnap` with the previewed
   * columns must come BEFORE the `run(...)` that sends the PATCH — a preview
   * drawn after the await is the delay this closed, written a longer way.
   */
  const drop = /const previous = snap;\s*setSnap\(\{ \.\.\.previous, columns: columnsInOrder\(previous\.columns, order\) \}\);\s*void run\(\s*`move:\$\{columnId\}`,\s*\(\) => reorderRegisterColumns\("contractors", order\),\s*previous,\s*\);/;
  assert.match(code, drop, "the drop previews the new order and hands run the snapshot to restore");

  /*
   * THE MENU IS THE KEYBOARD AND TOUCH ROUTE to the same move — the gesture
   * refuses `pointerType === "touch"` outright and below 767px there is no
   * header to press at all — so it gets the same immediacy. A register where
   * the mouse felt instant and the accessible path did not would be a worse
   * product than one where neither did.
   */
  assert.match(
    code,
    /const order = orderAfterStep\(snap\.columns, column\.key, delta, frozenKey\);\s*const previous = snap;\s*setSnap\(\{ \.\.\.previous, columns: columnsInOrder\(previous\.columns, order\) \}\);/,
    "Move earlier / Move later previews its write too",
  );

  /*
   * AND THE ROLLBACK IS ONLY EVER ON FAILURE. `revertTo` is read in the catch
   * and nowhere else: a restore on the success path would put the pre-drop
   * order back for the moment before the reload landed, which is the flicker
   * this whole change exists to remove.
   */
  const body = code.slice(code.indexOf("const run = useCallback"));
  const tryAt = body.indexOf("try {");
  const catchAt = body.indexOf("} catch (caught) {");
  assert.ok(tryAt > 0 && catchAt > tryAt, "run still has the try/catch this reads");
  assert.doesNotMatch(
    body.slice(tryAt, catchAt),
    /revertTo/,
    "nothing is reverted while the write is succeeding",
  );
  assert.match(body.slice(catchAt), /if \(revertTo\) setSnap\(revertTo\);/);

  /*
   * THE SERVER READ IS STILL THERE. The preview is a preview; `load()` after a
   * successful write remains the thing that makes the screen true, and dropping
   * it in favour of the optimistic copy is the drift `load`'s own note warns
   * about.
   */
  assert.match(body.slice(tryAt, catchAt), /await work\(\);\s*load\(\);/);
});

test("W13 nothing but the two moves writes optimistically", async () => {
  const code = codeOnly(await read(GRID));
  /*
   * A THIRD ARGUMENT TO `run` IS A LOCAL CHANGE SOMEBODY HAS ALREADY DRAWN, so
   * every caller that passes one owes a `setSnap` before it. Rename, resize,
   * hide, pin, add, remove and restore all still wait for the server and are
   * unchanged — they are single-column verbs whose answer the reload draws, and
   * previewing them would be new risk for no complaint.
   */
  const previews = [...code.matchAll(/setSnap\(\{ \.\.\.previous, columns: columnsInOrder\(/g)];
  assert.equal(previews.length, 2, "exactly the drop and the menu move preview");
  const withRevert = [
    ...code.matchAll(/reorderRegisterColumns\("contractors", order\),\s*previous,/g),
  ];
  assert.equal(withRevert.length, 2, "and exactly those two hand run a snapshot to restore");
});
