/**
 * THE CONTRACTORS REGISTER, AS IT IS DRAWN — the lane, and the menu over it.
 *
 * `tests/register-source-of-truth.test.mjs` next door holds the RULES: which
 * column is frozen, what one press of Move does, what the ordered run contains.
 * This file holds what the grid then does with that answer, which is the half
 * the owner was actually looking at when they reported three defects:
 *
 *   1. Unticking "Contractor" left the composite lane on the table. The rule was
 *      half of it; the other half was in the grid, where a fallback re-inserted
 *      the identity rendering whenever no drawn lane carried it — and a column
 *      the reader has unticked is not among the drawn lanes.
 *   2. The table had to render headers, cells, widths, the frozen flag and the
 *      empty row's span from ONE ordered model, with the operational figures
 *      inside it rather than appended after it in JSX.
 *   3. The three-dot column menu rendered UNDERNEATH the sticky lane.
 *
 * ── WHY DEFECT 3 IS NOT A Z-INDEX ────────────────────────────────────────
 *
 * The menu already carried `--z-popover`, a tier six hundred above the lane's
 * `--z-sticky`, and was invisible anyway. A sticky cell that carries a z-index
 * is a stacking CONTEXT, so a descendant's 1000 is resolved inside the header
 * cell's own 40 and never against the page; the body's lane cells are on the
 * same tier and come later in the document, so they paint over it. Measured at
 * 1440 through the DevTools protocol at scrollLeft 0, mid-scroll and hard
 * right: 45 of 45 sample points inside the open menu's rect hit
 * `td.contractor-register__lane` or its contents. Raising the number could not
 * have reached out of that context, and `tests/ui-batch-overlays.test.mjs`
 * refuses a raw one at or above 10 in any case.
 *
 * So the menu LEAVES the table, onto the shared overlay layer that eight other
 * menus already use. The assertions below hold that arrangement rather than a
 * number: the surface is portalled, the box declares no depth of its own, and
 * the layer's tier outranks the lane's.
 *
 * ── WHAT IS ASSERTED, AND HOW ────────────────────────────────────────────
 *
 * DERIVED where a pure function can answer: `registerTableColumns` is called
 * with a register shaped like the owner's and the KEYS THE TABLE WOULD DRAW are
 * compared. SOURCE only for the wiring a pure function cannot see — which
 * component renders the menu, which class the lane is gated on — and each such
 * pin says what it is protecting.
 *
 * NOTHING HERE WRITES TO THE DATABASE. The pure assertions need no fixture and
 * the one live test reads `/api/registers` and asserts, so there is no `ZZQA-`
 * residue to sweep — which on a suite whose live tests share one Miniflare D1
 * is the safest form this file could take.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const GRID = "app/(app)/portal/contractor-register.tsx";
const CLIENT = "app/(app)/portal/register/register-client.ts";
const GLOBALS = "app/globals.css";
const OVERLAY_CSS = "app/(app)/portal/overlay/overlay.css";
const ANCHORED = "app/(app)/portal/overlay/anchored.tsx";

/*
 * `register-client.ts` imports nothing at runtime, so its rules can be
 * exercised without a bundler, a DOM or a React renderer. Transpiled and
 * imported as a data: URL — the idiom `tests/column-drag-and-recovery.test.mjs`
 * established and `tests/register-source-of-truth.test.mjs` uses next door.
 */
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const client = await import(
  `data:text/javascript;base64,${Buffer.from(transpile(await read(CLIENT))).toString("base64")}`
);
const { frozenRegisterColumn, identityRegisterColumn, registerTableColumns } = client;

/** Comments are prose and may say anything; the assertions read code only. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** This register's own styling, from its section marker to the end of the file. */
async function registerStyles() {
  const css = await read(GLOBALS);
  const start = css.indexOf("---- The configurable register grid");
  assert.ok(start > 0, "globals.css must carry the register section");
  return css.slice(start);
}

/* ── The register, as a column list ─────────────────────────────────────── */

/**
 * `[key, hidden, settings]` in position order.
 *
 * The shape is the owner's: the identity pinned at position 0, and the rest at
 * SPARSE visible positions with runs of hidden columns between them. The
 * sparseness matters to this file too — a lane lifted out of a dense run and a
 * lane lifted out of this one are not the same test.
 */
const REGISTER = [
  ["name", false, { pinned: true }],
  ["contactName", true, { pinned: false }],
  ["email", true, { pinned: false }],
  ["phone", true, {}],
  ["whatsappNumber", true, {}],
  ["availability", false, {}],
  ["notes", true, {}],
  ["active", true, {}],
  ["assigned", false, {}],
  ["completed", false, {}],
  ["completion", false, {}],
  ["urgent", false, {}],
  ["documents", false, {}],
  ["spend", false, {}],
];

/** One wire-shaped column, exactly as `GET /api/registers` sends it. */
function column([key, hidden, settings], position) {
  return {
    id: `rcol_${key}`,
    register: "contractors",
    key,
    title: key === "name" ? "Contractor" : key,
    type: "text",
    position,
    width: 180,
    native: true,
    nativeField: key,
    hidden,
    pinned: settings.pinned === true,
    settings,
  };
}

const columnsOf = (rows) => rows.map((row, index) => column(row, index));
const registerColumns = () => columnsOf(REGISTER);

/** The same register with one column's `hidden` / `settings` overridden. */
function registerWith(key, patch) {
  return columnsOf(
    REGISTER.map((row) =>
      row[0] === key ? [row[0], patch.hidden ?? row[1], patch.settings ?? row[2]] : row,
    ),
  );
}

/** The keys the table draws, in order — the frozen lane first when there is one. */
const drawnKeys = (columns) => registerTableColumns(columns).map((entry) => entry.key);

/* ── A — the composite lane has nothing left to render ──────────────────── */

test("REN-A unticking Contractor leaves no composite lane for the grid to draw", async () => {
  const shown = registerColumns();
  assert.equal(drawnKeys(shown)[0], "name", "the lane is there to begin with");

  /*
   * WHAT THE SERVER WRITES WHEN THE BOX IS UNTICKED, and this fixture was
   * behind the route it models. `PATCH /api/registers { id, hidden: true }`
   * stamps `hidden_at` and LEAVES THE PIN — that is the whole of the change
   * that makes ticking the box again give back the lane the operator had — so
   * the snapshot that comes back carries `{"pinned": true}` and not `false`.
   * Asserting against the `false` shape alone would have exercised the
   * `settings.pinned === false` branch of `frozenRegisterColumn` and never the
   * `pinned.hidden` one, which is precisely the branch the owner's press now
   * goes through. Both shapes are asserted, the live one first.
   */
  const hidden = registerWith("name", { hidden: true, settings: { pinned: true } });
  assert.equal(
    frozenRegisterColumn(hidden),
    null,
    "nothing is frozen, even though the row still carries the pin",
  );
  assert.ok(!drawnKeys(hidden).includes("name"), "and the column is not in the run either");

  /* The older shape a hand-unpinned register can still be in. */
  const hiddenUnpinned = registerWith("name", { hidden: true, settings: { pinned: false } });
  assert.equal(frozenRegisterColumn(hiddenUnpinned), null, "nothing is frozen there either");
  assert.ok(!drawnKeys(hiddenUnpinned).includes("name"));

  const grid = codeOnly(await read(GRID));

  /*
   * THE OTHER HALF OF DEFECT 1, AND IT LIVED HERE. `gridLanes` used to end with
   * `if (!lanes.some((lane) => lane.identity))` and splice the identity
   * rendering back in at the front — a condition that is true of an UNTICKED
   * column as surely as of an absent one. So the checkbox wrote, the API
   * agreed, the column left the run, and the composite lane reappeared as an
   * unfrozen cell on the very next render. The fallback exists for a register
   * that has no ROW for the identity at all, which is what `identity === null`
   * says and what `!lanes.some(...)` never did.
   */
  assert.match(grid, /if \(identity === null\) \{/, "the fallback asks whether a row exists");
  assert.doesNotMatch(
    grid,
    /!lanes\.some\(\(lane\) => lane\.identity\)/,
    "asking the DRAWN lanes makes unticking the identity impossible",
  );

  /*
   * AND THE IDENTITY RENDERING RIDES ON A COLUMN IN THE RUN. `lane.identity` is
   * set from the run's own entries, so a column that is not in the run cannot
   * carry the name, the archived badge or the actionable contact block —
   * whichever of the two `<td>` branches drew it.
   */
  assert.match(
    grid,
    /identity: identity !== null && column\.id === identity\.id,/,
    "a lane is the identity only when it IS the identity column",
  );

  /* The register still has a row for it — hidden is not absent, and the panel's
     tick has to be able to bring it back. */
  assert.equal(identityRegisterColumn(hidden)?.key, "name");
  assert.equal(
    drawnKeys(registerWith("name", { hidden: false, settings: { pinned: true } }))[0],
    "name",
    "ticking it again returns it to the lane it was in",
  );
});

/* ── E — a pin extracts the lane and moves nothing else ─────────────────── */

test("REN-E a pinned Contractor is lifted out without disturbing the configured order", () => {
  /*
   * THE OWNER'S OWN CASE. Four columns configured in the order Completed,
   * Spend, Assigned, Documents — deliberately not their catalogue order — with
   * the identity pinned. What must come out is the lane followed by those four
   * in the order they were configured, because "pinned" is a statement about
   * where ONE column is drawn and not a licence to re-sort the rest.
   */
  const rows = [
    ["name", false, { pinned: true }],
    ["contactName", true, {}],
    ["completed", false, {}],
    ["email", true, {}],
    ["spend", false, {}],
    ["assigned", false, {}],
    ["active", true, {}],
    ["documents", false, {}],
  ];
  const pinned = columnsOf(rows);
  assert.deepEqual(
    drawnKeys(pinned),
    ["name", "completed", "spend", "assigned", "documents"],
    "the lane leads and the middle columns keep their configured relative order",
  );

  /*
   * AND UNPINNING PUTS IT BACK WHERE IT WAS CONFIGURED, not at the front and
   * not at the end. Nothing writes `position` when a pin is released — see
   * `pinRegisterColumn` — so the column returns to the place the operator gave
   * it, which here is still first because that is where they put it.
   */
  const unpinned = columnsOf(
    rows.map((row) => (row[0] === "name" ? [row[0], row[1], { pinned: false }] : row)),
  );
  assert.equal(frozenRegisterColumn(unpinned), null, "an explicit no leaves no lane");
  assert.deepEqual(
    drawnKeys(unpinned),
    ["name", "completed", "spend", "assigned", "documents"],
    "the same columns in the same order, with none of them frozen",
  );
  assert.equal(
    drawnKeys(unpinned).filter((key) => key === "name").length,
    1,
    "and never twice — a lane beside a still-visible copy is the name on every row twice",
  );

  /* Move the identity into the middle and the lane still leads: the pin decides
     the lane, the position decides everything else. */
  const midway = columnsOf([
    ["completed", false, {}],
    ["spend", false, {}],
    ["name", false, { pinned: true }],
    ["documents", false, {}],
  ]);
  assert.deepEqual(drawnKeys(midway), ["name", "completed", "spend", "documents"]);
});

/* ── F — a hidden lane leaves no spacer, in the markup or the styling ───── */

test("REN-F a hidden Contractor leaves no frozen spacer, width or offset behind", async () => {
  const stale = registerWith("name", { hidden: true, settings: { pinned: true } });
  assert.equal(frozenRegisterColumn(stale), null, "a hidden pinned column freezes nothing");
  assert.deepEqual(
    drawnKeys(stale),
    drawnKeys(registerWith("name", { hidden: true, settings: { pinned: false } })),
    "and the drawn order does not depend on a pin nobody can see",
  );

  const grid = codeOnly(await read(GRID));

  /*
   * THE STICKY FLAG COMES FROM THE SAME ANSWER THE RUN DID. `frozen` is derived
   * once and handed both to `registerTableColumns` and to `gridLanes`, so a
   * lane cannot be sticky without being the column that was frozen — and when
   * nothing is frozen, nothing is. Asking twice is how a lane and a scrolling
   * copy of one column came to be drawn side by side.
   */
  assert.match(
    grid,
    /const tableColumns = registerTableColumns\(snap\.columns, frozen\);/,
    "the run is derived from the one frozen answer",
  );
  assert.match(
    grid,
    /lanes\.push\(laneOf\(column, frozen !== null && column\.id === frozen\.id\)\);/,
    "and so is the sticky flag on each lane",
  );

  /*
   * NOTHING IS OVERRIDDEN AFTERWARDS. The class carrying `position: sticky`,
   * the `left: 0` and the 250px width is applied only while `lane.frozen`, in
   * both the head and the body — so there is no position to unset, no stale
   * offset and no width to reset. A stale frozen strip is unrepresentable
   * rather than cleaned up.
   */
  assert.equal(
    (grid.match(/"contractor-register__lane contractor-register__lane--start"/g) ?? []).length,
    2,
    "the lane class is written exactly twice: once for the header, once for the cell",
  );
  /*
   * RE-POINTED FOR W13, AND ONLY THE ELSE-BRANCH MOVED. This read
   * `: undefined` on both, because both were a bare ternary handed straight to
   * `className`. The header now composes its class from a list — the lane
   * class, the "being carried" class and the two drop-indicator classes — so
   * its else-branch is a `null` that `.filter(Boolean)` drops. The CONDITION is
   * what this pin is about and it is unchanged: the sticky class is applied
   * only while `lane.frozen`, never applied and then overridden, so there is
   * still no stale offset or width to unset.
   */
  assert.equal(
    (
      grid.match(
        /lane\.frozen\s*\?\s*"contractor-register__lane contractor-register__lane--start"\s*:\s*(?:undefined|null)/g,
      ) ?? []
    ).length,
    2,
    "and each of the two is conditional on the lane's own flag, not applied and then overridden",
  );

  /*
   * THE WIDTH IS THE LANE CLASS'S, NOT A RULE THAT COULD OUTLIVE IT. 250px is
   * declared on `--start` alone, so a register with nothing frozen has no
   * element for it to apply to.
   */
  const styles = await registerStyles();
  assert.match(
    styles,
    /th\.contractor-register__lane--start,\s*\.contractor-register__table td\.contractor-register__lane--start \{[^}]*width: 250px;/,
    "the reserved width belongs to the frozen class and to nothing else",
  );
  assert.doesNotMatch(
    styles,
    /\.contractor-register__table (th|td):first-child \{[^}]*(position: sticky|left: 0)/,
    "and nothing freezes a cell by its POSITION, which would survive the column going away",
  );
});

/* ── D — one ordered model draws the headers, the cells and the span ───── */

test("REN-D the headers, the cells, the widths and the empty span come from one model", async () => {
  const grid = codeOnly(await read(GRID));

  assert.equal(
    (grid.match(/\{lanes\.map\(\(lane\) => \{/g) ?? []).length,
    2,
    "the <thead> and the <tbody> map the same array",
  );
  assert.doesNotMatch(grid, /\{shown\.map\(/, "no second ordered list in the head");
  assert.doesNotMatch(
    grid,
    /\{extraColumns\.map\(/,
    "and the page's figures are not appended after the configured columns in JSX",
  );
  assert.match(grid, /colSpan=\{lanes\.length\}/, "the empty row spans the same list");

  /*
   * THE WIDTH IS READ OFF THE MODEL TOO. A `<colgroup>` would constrain the
   * table at every width including the one where it stops being a table — the
   * card layout below 767 — so the width is declared on the header cell of the
   * lane it belongs to, and the frozen lane declares none.
   */
  assert.match(
    grid,
    /column && !lane\.frozen\s*\?\s*\{ width: `\$\{widthOf\(column\)\}px`, minWidth: `\$\{widthOf\(column\)\}px` \}/,
    "each lane's width comes from its own column",
  );

  /*
   * AND THE OPERATIONAL FIGURES ARE LANES LIKE ANY OTHER. They are declared in
   * `register-catalogue.ts`, so they arrive carrying an order the operator
   * chose; `gridLanes` pairs each with the `extraColumns` renderer of the same
   * key. The append below it fires only for a key the register has NO ROW for —
   * asked of `known`, every column the register holds, because asking the
   * VISIBLE run turned a hide into a move to the end of the row.
   */
  assert.match(grid, /const extraByKey = new Map\(extras\.map\(/, "a figure is paired to its column");
  assert.match(
    grid,
    /if \(known\.some\(\(column\) => column\.key === extra\.key\)\) continue;/,
    "and only an unbacked key is appended",
  );

  /* Derived: the run really does carry the six figures among the columns rather
     than after them, on a register that has moved one of them. */
  const withFiguresInside = columnsOf([
    ["spend", false, { pinned: true }],
    ["name", false, {}],
    ["assigned", false, {}],
    ["availability", false, {}],
    ["documents", false, {}],
  ]);
  assert.deepEqual(drawnKeys(withFiguresInside), [
    "spend",
    "name",
    "assigned",
    "availability",
    "documents",
  ]);
});

/* ── G — the menu paints over the lane, by leaving the table ────────────── */

test("REN-G the column menu renders on the shared overlay layer, not inside the sticky cell", async () => {
  const grid = codeOnly(await read(GRID));

  assert.match(
    grid,
    /import \{ AnchoredPopover \} from "\.\/overlay\/anchored";/,
    "the grid uses the shared anchored surface",
  );
  assert.match(grid, /<AnchoredPopover/, "and renders the menu through it");
  assert.match(
    grid,
    /<div className="contractor-register__menu">\{children\}<\/div>/,
    "with the menu's own class kept as the skin inside the positioned surface",
  );
  assert.doesNotMatch(
    grid,
    /<div className="contractor-register__menu" role="menu">/,
    "and no second role=menu nested inside the surface's own",
  );

  /*
   * ONE ANCHOR PER TRIGGER. `useAnchoredPosition` measures `anchorRef.current`,
   * and thirty headers in a `.map` need thirty stable refs — one shared ref
   * would place every menu against whichever button rendered last. The trigger
   * is owned by the component that owns the ref, which is what makes them
   * belong to each other.
   */
  assert.match(grid, /function RegisterHeadMenu\(\{/, "a component per header owns its anchor");
  assert.match(grid, /const anchorRef = useRef<HTMLButtonElement>\(null\);/);
  assert.match(grid, /anchorRef=\{anchorRef\}/);

  /*
   * AND THE GRID'S OWN "PRESS OUTSIDE" LISTENER IS GONE. It closed the menu
   * unless the press was inside `.contractor-register__menu-anchor` — an
   * ancestor the portalled surface no longer has — so it would have fired on
   * the menu's own items, unmounting them before the click landed and turning
   * every entry into a no-op. `AnchoredPopover` owns press-outside, Escape and
   * the focus return, and tests containment against the surface it rendered.
   */
  assert.doesNotMatch(
    grid,
    /window\.addEventListener\("pointerdown"/,
    "the grid must not close a surface it does not render",
  );
  const anchored = await read(ANCHORED);
  assert.match(anchored, /document\.addEventListener\("pointerdown", onPointerDown, true\)/);
  assert.match(anchored, /if \(surface\?\.contains\(target\) \|\| anchorRef\.current\?\.contains\(target\)\) return;/);
  assert.match(anchored, /if \(event\.key !== "Escape" \|\| event\.defaultPrevented\) return;/);
});

test("REN-G the menu declares no depth of its own, and the layer outranks the lane", async () => {
  const styles = await registerStyles();

  /*
   * THE FIX IS THE ABSENCE. `.contractor-register__menu` was `position:
   * absolute` on `--z-popover` inside the header cell, and on the pinned column
   * it was invisible regardless: a sticky cell carrying a z-index is a stacking
   * context, so 1000 was resolved inside the cell's own 40. The box now carries
   * the skin and nothing else; the depth is the layer's.
   */
  const menu = styles.match(/\.contractor-register__menu \{[^}]*\}/);
  assert.ok(menu, "the register still styles its menu");
  for (const property of ["position:", "z-index:", "top:", "right:", "left:"]) {
    assert.ok(
      !menu[0].includes(property),
      `the menu must not ${property.replace(":", "")} itself — that is the layer's job (${menu[0]})`,
    );
  }
  assert.match(menu[0], /background: var\(--surface-card/, "but it keeps its ground");
  assert.match(menu[0], /box-shadow:/, "and its shadow");

  /* No raw z-index anywhere in the register's section — the rule
     `tests/ui-batch-overlays.test.mjs` enforces, restated where it can regress. */
  const raw = styles.match(/^\s*z-index:\s*-?\d+\s*;/m);
  assert.equal(raw, null, `the register must declare no raw z-index (${raw && raw[0]})`);

  /*
   * AND THE TIERS ARE ORDERED, RESOLVED RATHER THAN ASSUMED. The lane sits on
   * `--z-sticky` and the layer on `--z-popover`; a menu that has LEFT the
   * table only paints over the lane because the second outranks the first.
   */
  const globals = await read(GLOBALS);
  const tier = (name) => {
    const found = globals.match(new RegExp(`--${name}:\\s*(\\d+);`));
    assert.ok(found, `--${name} must be declared`);
    return Number(found[1]);
  };
  assert.ok(
    tier("z-sticky") < tier("z-popover"),
    "a frozen column must sit below the popover layer",
  );
  assert.match(styles, /\.contractor-register__lane \{[^}]*z-index: var\(--z-sticky\);/);

  const overlay = await read(OVERLAY_CSS);
  assert.match(overlay, /\.ms-layer \{[\s\S]*?position: fixed;/, "the layer is fixed to the viewport");
  assert.match(overlay, /\.ms-layer \{[\s\S]*?z-index: var\(--z-popover\);/, "on the popover tier");
  assert.match(
    overlay,
    /#maintsupp-layers \{\s*position: static;/,
    "and its host is not a stacking context, or every layer would flatten into it",
  );
});

/* ── 14 — the row still opens, and the menu still does not ──────────────── */

test("REN-14 the row press opens the contractor and the column menu never does", async () => {
  const grid = codeOnly(await read(GRID));

  assert.match(grid, /const ROW_INTERACTIVE_SELECTOR = \[/, "the exemption list is one constant");
  assert.match(
    grid,
    /target\.closest\(ROW_INTERACTIVE_SELECTOR\)\) \{\s*return;/,
    "and the guard runs before the row opens anything",
  );
  for (const role of ["menu", "menuitem", "button", "checkbox", "switch"]) {
    assert.match(
      grid,
      new RegExp(`'\\[role="${role}"\\]',`),
      `a control drawn as role="${role}" stays exempt from the row press`,
    );
  }

  /*
   * AND THE MENU IS NOW OUT OF THE ROW'S REACH ENTIRELY — belt as well as
   * braces. The trigger is in `<thead>`, which carries no row handler, and the
   * surface is portalled to `<body>`, so a press on Rename or Hide is not
   * inside any `<tr>` for the guard to have to exempt. The guard stays because
   * the CELLS still hold links and buttons, and because the next control
   * somebody adds to one should be exempt the moment it exists.
   */
  assert.match(grid, /<LayerPortal|<AnchoredPopover/, "the menu leaves the row's subtree");
  assert.equal(
    (grid.match(/event\.stopPropagation\(\)/g) ?? []).length,
    0,
    "no per-child handler survives — the guard is the whole mechanism",
  );

  /* Every menu item closes the menu before it acts, because nothing else will:
     a portalled surface is not dismissed by a press on its own items. */
  for (const verb of ["rename\\(column\\)", "move\\(column, -1\\)", "move\\(column, 1\\)"]) {
    assert.match(
      grid,
      new RegExp(`setOpenMenu\\(null\\);\\s*${verb};`),
      `the ${verb} item closes the menu it was pressed in`,
    );
  }
});

/* ── 13 — the live register agrees with the rule the grid draws from ───── */

const CANDIDATES = process.env.MAINTSUPP_BASE_URL
  ? [process.env.MAINTSUPP_BASE_URL]
  : [5173, 5174, 5175, 5176, 5177, 3000].map((port) => `http://localhost:${port}`);
let BASE_URL = CANDIDATES[0];

async function serverIsUp() {
  for (const candidate of CANDIDATES) {
    try {
      const response = await fetch(`${candidate}/api/registers?register=contractors`, {
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) {
        BASE_URL = candidate;
        return true;
      }
    } catch {
      // Next candidate.
    }
  }
  return false;
}

test("REN-13 the live register's own answer and the drawn run cannot disagree", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no dev server on 5173/3000 — the source assertions above still ran");
    return;
  }
  const body = await (await fetch(`${BASE_URL}/api/registers?register=contractors`)).json();
  assert.ok(Array.isArray(body.columns), "the snapshot carries its columns");

  /*
   * THE GRID DRAWS `registerTableColumns(snap.columns, frozen)` AND NOTHING
   * ELSE, so the run derived from the live answer is exactly what is on the
   * table. Three things have to hold of it whatever state the register is in,
   * and every one of them was violable before: nothing hidden is drawn, nothing
   * is drawn twice, and the frozen lane — if there is one — leads.
   */
  const drawn = registerTableColumns(body.columns);
  assert.ok(
    drawn.every((entry) => !entry.hidden),
    "nothing the reader has unticked reaches the table",
  );
  assert.equal(new Set(drawn.map((entry) => entry.id)).size, drawn.length, "and nothing twice");

  const frozen = frozenRegisterColumn(body.columns);
  if (frozen) {
    assert.equal(frozen.hidden, false, "a frozen lane is never a hidden column");
    assert.equal(drawn[0].id, frozen.id, "and it is the first thing drawn");
  } else {
    /* No lane: the first drawn column is simply the first visible one, and it
       starts at the register's normal left content edge because no sticky class
       is applied to anything. */
    const visible = body.columns.filter((entry) => !entry.hidden);
    assert.equal(drawn.length, visible.length, "every visible column is drawn and no lane besides");
    if (visible.length) assert.equal(drawn[0].id, visible[0].id);
  }

  const identity = identityRegisterColumn(body.columns);
  if (identity && identity.hidden) {
    assert.equal(frozen, null, "an unticked Contractor freezes nothing on the live register");
    assert.ok(
      !drawn.some((entry) => entry.id === identity.id),
      "and is on the table in no form at all",
    );
  }
});
