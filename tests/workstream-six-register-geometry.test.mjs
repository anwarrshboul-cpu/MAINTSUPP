import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * THE CONTRACTORS REGISTER'S GEOMETRY, AFTER THE OWNER READ IT A SECOND TIME.
 *
 * W05/W06 gave the register a frozen identity lane at the left and a frozen
 * ACTION lane at the right, and the owner accepted the first and rejected the
 * second. What they reported, in the order it matters:
 *
 *   5.  A chevron and a pencil held permanently at the right of every row, on a
 *       table already too wide, for a press the whole row answers and an editor
 *       the profile drawer carries.
 *   9.  "Reach them" should be pinned — and should be the READER's decision,
 *       not a property of the markup.
 *   13. No column may hide under the frozen lane at rest.
 *   22. One divider per boundary. The frozen edge was drawing two.
 *   25. Between 761 and 767 the register was a plain wide table with neither
 *       pinning nor dividers: the card layout switched at 760 and the lane
 *       unstuck at 767, and nobody designed the seven pixels in between.
 *
 * WHAT THESE TESTS ARE FOR. Each of the five is a STRUCTURE that can be undone
 * silently — a second sticky cell, a header loop beside a different cell loop, a
 * lane gated on a flag no live register carries, a shadow beside a border, a
 * breakpoint that drifts. None of them fails loudly; every one of them reads as
 * a rendering fault to whoever finds it. So each test below names the reading
 * that comes back if the structure goes.
 *
 * Source assertions run everywhere. The one live test skips without a dev
 * server, which is the bargain the rest of this suite makes.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const GRID = "app/(app)/portal/contractor-register.tsx";
const PANEL = "app/(app)/portal/register/register-columns-panel.tsx";
/**
 * Where "which column is frozen" is decided, for every register.
 *
 * It used to be decided inside the grid. It moved because the grid, the columns
 * panel and the ordering helpers all have to agree about which column is out of
 * the scrolling run — see GEO-9/10/17 below, and
 * `tests/register-source-of-truth.test.mjs`, which exercises the rule by
 * calling it rather than by reading it.
 */
const CLIENT = "app/(app)/portal/register/register-client.ts";
const GLOBALS = "app/globals.css";
const BRAND = "app/brand-overrides.css";

/** The five widths the stylesheets are allowed to break at. */
const AGREED = [640, 767, 768, 1024, 1280];

/** Source with comment lines dropped, so a pin cannot be satisfied by prose. */
function codeOnly(source) {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

/** This register's own styling, from its section marker to the end of the file. */
async function registerStyles() {
  const css = await read(GLOBALS);
  const start = css.indexOf("---- The configurable register grid");
  assert.ok(start > 0, "globals.css must carry the register section");
  return css.slice(start);
}

// Found rather than assumed — vite takes the first free port from 5173 up.
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

test("GEO-5 nothing is pinned to the right of the register, in the markup or the styling", async () => {
  const code = codeOnly(await read(GRID));
  const styles = await registerStyles();

  /*
   * THE READING IF THIS GOES: eighty-six pixels of every row, at every width,
   * spent on a chevron that repeats the row press and a pencil that repeats the
   * drawer. The owner counted them.
   */
  assert.doesNotMatch(code, /lane--end/, "no end lane in the grid");
  assert.doesNotMatch(styles, /lane--end/, "and no styling waiting for one");
  assert.doesNotMatch(code, /data-label="Actions"/, "no Actions cell");
  assert.doesNotMatch(code, /contractor-register__row-actions/, "nothing to hold two icons in");
  assert.doesNotMatch(
    code,
    /aria-label=\{`(Open|Edit) \$\{row\.name\}`\}/,
    "no permanent chevron and no permanent pencil",
  );

  /*
   * AND NO SECOND STICKY LANE UNDER ANOTHER NAME. `right:` on a sticky cell is
   * the only way to pin one to the trailing edge, so the register's styling may
   * not contain the pair at all.
   */
  const sticky = styles.match(/position: sticky;[\s\S]{0,200}?\}/g) ?? [];
  for (const block of sticky) {
    assert.doesNotMatch(block, /\bright: 0/, `a sticky cell is being pinned right: ${block.slice(0, 80)}`);
  }
});

test("GEO-15/16 the headers and the cells come from ONE ordered definition", async () => {
  const code = codeOnly(await read(GRID));

  /*
   * THE READING IF THIS GOES: the figures appear under the wrong headings. A
   * header loop over one list beside a cell loop over another does not fail —
   * it mislabels, and a mislabelled table is the one rendering fault a reader
   * believes. `lanes` is built once and mapped twice.
   */
  assert.match(code, /const lanes = gridLanes\(/, "the order is decided in one place");
  assert.equal(
    (code.match(/\{lanes\.map\(\(lane\) => \{/g) ?? []).length,
    2,
    "and drawn from that one list in both the head and the body",
  );
  assert.doesNotMatch(code, /\{shown\.map\(/, "no second ordered list in the head");
  assert.doesNotMatch(code, /\{extraColumns\.map\(/, "and none for the page's figures either");

  /*
   * THE MEASUREMENTS ARE STILL NOT REGISTER COLUMNS, and the ordered definition
   * says so in its shape: a lane carries a `column` or an `extra`, never both.
   * Seeding them as columns would put a period-scoped count in a catalogue of
   * stored facts and invite `PATCH /api/registers/values` to write one.
   */
  assert.match(code, /column: RegisterColumn \| null;/, "a lane may be a register column");
  assert.match(code, /extra: ExtraColumn<Row> \| null;/, "or one of the page's figures");

  // The empty row spans the same list rather than counting it a second way.
  assert.match(code, /colSpan=\{lanes\.length\}/);
});

test("GEO-15/16 unticking a measurement takes it OFF the table, it does not move it to the end", async () => {
  const code = codeOnly(await read(GRID));

  /*
   * THE DEFECT THIS PINS, MEASURED BEFORE IT WAS FIXED.
   *
   * The six measurement columns are declared in `register-catalogue.ts` so
   * their ORDER belongs to the operator, and `gridLanes` pairs each with the
   * `extraColumns` renderer of the same key. It also keeps a fallback: a
   * register seeded before those columns existed has no row for them, so the
   * page draws the figure anyway rather than losing it until the reconcile in
   * `loadRegisterColumns` catches up.
   *
   * That fallback asked `scrolling` — the columns ON THE TABLE. A measurement
   * the operator had just UNTICKED fell out of `scrolling` and was immediately
   * re-appended by it, so the press did not hide the column: it MOVED it to the
   * end of the row. Measured at 1440 against the live register: hiding
   * "Assigned" left thirty headers with Assigned last, while the API correctly
   * recorded `hidden: true`. Pressing again could not help, because the state
   * the fallback reads had already changed.
   *
   * The fix is one word — the fallback asks `known`, every column the register
   * HOLDS, hidden ones included — and it is one word a later refactor could
   * put back. "No row exists for this key" and "this key is not on the table"
   * are different facts and only the first one may reach the fallback.
   */
  assert.match(
    code,
    /known: readonly RegisterColumn\[\],/,
    "gridLanes is told every column the register holds, not just the visible run",
  );
  assert.match(
    code,
    /if \(known\.some\(\(column\) => column\.key === extra\.key\)\) continue;/,
    "the measurement fallback fires only when there is NO row for the key",
  );
  assert.doesNotMatch(
    code,
    /if \(scrolling\.some\(\(column\) => column\.key === extra\.key\)\) continue;/,
    "asking the VISIBLE run turns a hide into a move to the end of the row",
  );
  /*
   * RE-POINTED FROM `scrolling` TO `tableColumns`, AND THE CONTRACT IS THE SAME
   * ONE, STATED MORE STRICTLY.
   *
   * What this line has always asserted is the SECOND argument pair: `gridLanes`
   * is handed the run it should draw AND `snap.columns`, the full set, so the
   * measurement fallback above can tell "no row for this key" from "not on the
   * table". Both are still here.
   *
   * The first argument changed name because the derivation moved. The grid used
   * to build the run itself — `shown.filter((column) => !frozen || column.id
   * !== frozen.id)` — and `registerTableColumns` in `register-client.ts` now
   * returns the frozen lane followed by that same filtered run, as ONE ordered
   * list. The reason is the defect beside this one: the columns panel and the
   * ordering helpers have to agree with the table about which column is out of
   * the scrolling run, and a filter written inside the grid was a third answer
   * they could not see.
   */
  assert.match(
    code,
    /const tableColumns = registerTableColumns\(snap\.columns, frozen\);/,
    "the run is derived once, by the shared rule",
  );
  /*
   * RE-POINTED FOR W13, AND THE CONTRACT IS UNCHANGED. `gridLanes` gained a
   * fifth thing to be told — `contactColumn`, the column the actionable contact
   * block now rides with, after the owner asked for the second column of the
   * register to be Contact Details — so the call is on several lines and one
   * argument longer. What this assertion has always been about is still exactly
   * what it checks: `tableColumns` (the run to draw) and `snap.columns` (the
   * FULL set, hidden columns included) are both handed over, so the measurement
   * fallback can still tell "no row for this key" from "not on the table".
   * Written as a shape rather than a literal so a reformat does not fail it,
   * and both arguments are still named.
   */
  assert.match(
    code,
    /const lanes = gridLanes\(\s*tableColumns,\s*frozen,\s*identityColumn,\s*contactColumn,\s*extraColumns,\s*snap\.columns,?\s*\);/,
    "and the full column set is still what is handed to it beside that run",
  );
});

test("GEO-6 the row press opens the contractor and exempts everything that already does something", async () => {
  const code = codeOnly(await read(GRID));

  /*
   * ONE `closest` GUARD, NOT `stopPropagation` PER CHILD. Both work today; they
   * differ on the NEXT control somebody puts in a cell. A per-child handler has
   * to be remembered, and nothing fails visibly when it is not — the row simply
   * opens a drawer over the thing the coordinator pressed, which on this row is
   * usually a phone number.
   */
  assert.match(code, /const ROW_INTERACTIVE_SELECTOR = \[/, "the exemption list is one constant");
  for (const selector of ["a", "button", "input", "select", "textarea", "label"]) {
    assert.match(
      code,
      new RegExp(`^\\s*"${selector}",$`, "m"),
      `${selector} must be exempt from the row press`,
    );
  }
  for (const role of ["menu", "menuitem", "button", "checkbox", "switch"]) {
    assert.match(
      code,
      new RegExp(`'\\[role="${role}"\\]',`),
      `a control drawn as role="${role}" must be exempt too`,
    );
  }
  assert.match(
    code,
    /target\.closest\(ROW_INTERACTIVE_SELECTOR\)\) \{\s*return;/,
    "and the guard runs before the row opens anything",
  );

  /*
   * `tel:`, `mailto:` and `wa.me` are all `<a>`, and the column menu's items
   * are `<button role="menuitem">`, so all four are covered by the list above
   * rather than by four handlers that can each be forgotten separately. The
   * pin, the checkbox and the resize handle are covered the same way.
   */
  assert.equal(
    (code.match(/event\.stopPropagation\(\)/g) ?? []).length,
    0,
    "no per-child handler survives — the guard is the whole mechanism",
  );
});

test("GEO-6 the keyboard has a real way in, and no nested interactive markup", async () => {
  const code = codeOnly(await read(GRID));

  /*
   * THE READING IF THIS GOES: the register is unusable without a mouse. The
   * chevron was the other keyboard route and it went with the action lane, so
   * the name button in the identity cell is now the ONLY one.
   */
  assert.match(
    code,
    /className="contractor-register__cell contractor-register__cell--name"/,
    "the name is a real control",
  );
  assert.match(code, /<strong>\{row\.name\}<\/strong>/, "printing the row's own name");

  /*
   * NOT A `<tr>` WEARING A ROLE. A `<tr tabindex="0">` is a focus stop that
   * announces nothing, and a `<tr>` inside a `<button>` is invalid markup that
   * browsers un-nest in different places.
   */
  const rowOpen = code.slice(code.indexOf("{rows.map((row) => ("));
  const rowTag = rowOpen.slice(0, rowOpen.indexOf("<td"));
  assert.doesNotMatch(rowTag, /tabIndex/, "the row is not a focus stop");
  assert.doesNotMatch(rowTag, /role=/, "and it is not pretending to be a control");
  assert.match(rowTag, /onClick=\{/, "it is a click handler and nothing more");

  /*
   * NOTHING NESTED. The identity cell holds ONE button — the name — and the
   * contact block's `tel:` / `mailto:` / `wa.me` anchors are its siblings, not
   * its children. A `<button>` inside a `<button>` is the failure this counts.
   */
  const identity = code.slice(code.indexOf("if (lane.identity) {"));
  const cell = identity.slice(0, identity.indexOf("</td>"));
  assert.equal(
    (cell.match(/<button/g) ?? []).length,
    1,
    "one control in the identity cell, not a control inside a control",
  );
  assert.doesNotMatch(cell, /<a /, "and no anchor wrapping it");
});

test("GEO-12/14 the frozen lane declares a tier token and an opaque ground in both themes", async () => {
  const styles = await registerStyles();

  /*
   * A RAW NUMBER IS WHAT `tests/ui-batch-overlays.test.mjs` REFUSES, and the
   * tier is the one every other frozen table column in this product uses — far
   * below `--z-popover`, so a column menu still opens OVER the lane.
   */
  assert.match(styles, /\.contractor-register__lane \{[^}]*z-index: var\(--z-sticky\);/);
  const rawZ = styles.match(/^\s*z-index:\s*-?\d+\s*;/m);
  assert.equal(rawZ, null, `the register must not declare a raw z-index (${rawZ && rawZ[0]})`);

  /*
   * THE READING IF THE GROUND GOES TRANSLUCENT: the rows slide visibly under
   * the pinned lane. `--surface-card` and not `--paper` — in light both are
   * #ffffff and either looks right, but in dark `--paper` is #121c24 while
   * every `.data-table td` is painted #182830, so the wrong token is a strip of
   * a different colour down the left of every row in one theme only.
   */
  assert.match(styles, /td\.contractor-register__lane \{\s*background: var\(--surface-card\);/);
  assert.match(styles, /th\.contractor-register__lane \{\s*background: var\(--surface-head\);/);

  /*
   * AND THE HOVER RIDES OVER THAT OPAQUE BASE RATHER THAN REPLACING IT. The
   * row hover is a 5.5%-alpha teal wash; taken as a background COLOUR on a
   * sticky cell it is a hole, and only while the pointer is on the row — which
   * no screenshot would ever catch.
   */
  assert.match(styles, /background-color: var\(--surface-card\);/);
  assert.match(styles, /background-image: linear-gradient\(/);

  // A dark edge colour, and no depth shadow there: black on near-black says
  // nothing, so in dark the line carries the whole signal.
  assert.match(styles, /--register-lane-edge: #2b414b;/);
  assert.match(styles, /--register-lane-depth: transparent;/);
});

test("GEO-22 the frozen boundary is ONE line, not a border with a shadow beside it", async () => {
  const styles = await registerStyles();

  /*
   * THE READING IF THIS GOES: a 2px double divider on the one boundary meant to
   * look deliberate, with the outer pixel lying over the first scrolling
   * column. The lane already draws the table's own `border-right`; re-colouring
   * it says "frozen" inside the cell's own box, where nothing can overlap.
   */
  assert.match(
    styles,
    /\.contractor-register__lane--start \{\s*left: 0;\s*box-shadow: 8px 0 10px -8px var\(--register-lane-depth\);/,
    "the fall-off is the only shadow the lane draws",
  );
  assert.doesNotMatch(
    styles,
    /box-shadow: 1px 0 0 var\(--register-lane-edge\)/,
    "a hard 1px shadow beside the border is the double line",
  );
  assert.match(
    styles,
    /border-right-color: var\(--register-lane-edge\);/,
    "the frozen edge is the cell's own divider in a darker ink",
  );

  /*
   * AND THE SELECTOR HAS TO OUT-RANK THE SHARED DIVIDER, which is two classes
   * and an element. Measured: `border-right` computed `rgb(234, 240, 243)` —
   * indistinguishable from the twenty-four ordinary boundaries — until the lane
   * rule was raised to `th.`/`td.`.
   */
  assert.match(
    styles,
    /\.contractor-register__table th\.contractor-register__lane--start,\s*\.contractor-register__table td\.contractor-register__lane--start \{/,
    "element + class, or the shared rule wins the tie",
  );

  // Only `border-right` is ever declared, so a junction carries one line.
  assert.doesNotMatch(styles, /border-left: 1px/, "a second border at a junction is a double line");
});

test("GEO-9/10/17 the frozen lane is a pinned column, and an unpinned register still has one", async () => {
  const code = codeOnly(await read(GRID));

  /*
   * RE-POINTED FROM THE GRID TO `register-client.ts`, AND THE CONTRACT GOT
   * STRICTER RATHER THAN LOOSER.
   *
   * Both assertions used to read `frozenRegisterColumn` out of the grid's own
   * source, because that is where the rule lived. It has moved next door for a
   * reason this test file is one of three witnesses to: the grid, the columns
   * panel and the ordering helpers all have to agree about which column is out
   * of the scrolling run, and three readings of `settings` were three chances
   * to disagree. The rule now has one home and the grid imports it, so the
   * assertions follow it there.
   *
   * ASKED OF THE REGISTER, NOT RE-DERIVED, is unchanged: `pinned` is computed
   * on the server from `register_columns.settings`, there is no `pinned` SQL
   * column, and nothing above the shim may grow a second reading of that JSON.
   */
  const rule = codeOnly(await read(CLIENT));
  assert.match(rule, /const pinned = pinnedColumn\(columns\);/);
  assert.match(code, /pinRegisterColumn\("contractors", column\.id, next\)/, "and Pin is wired to the panel");
  assert.match(code, /frozenRegisterColumn/, "and the grid asks the shared rule for its lane");

  /*
   * THE FALLBACK IS THE POINT. Not one organisation in either database carries
   * a pinned column — the flag is read at seed time, so it reaches a workspace
   * created after it existed and nobody else. "Nothing is pinned" is therefore
   * the state of every live register, and a lane gated on the flag alone would
   * take the contractor's name and phone number off the owner's Preview.
   *
   * RE-POINTED, AND WITH THE CLAUSE THAT WAS MISSING. The old line was
   * `return columns.find((column) => column.nativeField === "name") ?? null;`
   * with no `hidden` check anywhere in the function, which is why unticking
   * "Contractor" in the columns panel changed `hidden_at` and left the lane on
   * the table: the checkbox wrote, and the very next render put the lane back
   * from the same column. The fallback survives — it is still what freezes the
   * identity on a register nobody has pinned — and it is now spelt with the
   * visibility rule the owner's press depends on.
   */
  /*
   * RE-POINTED — the fallback now reads the IDENTITY'S OWN refusal, and the
   * rule this pin protects is narrower rather than weaker.
   *
   * "Visibility wins" is unchanged and is still asserted, one line down. What
   * moved is WHO gets to decline the lane. The old shape asked whether ANY
   * column in the register carried settings.pinned === false, which let one
   * column's history speak for the whole table: the live contractors register
   * carries that flag on contactName and email because somebody pinned each of
   * them once and unpinned it, so the day the identity's own pin was cleared
   * the register would have rendered no frozen lane at all — for a reason
   * nobody chose and nothing on screen explained.
   *
   * A refusal is a choice about one column, so it is read off that column.
   */
  assert.match(
    rule,
    /const identity = identityRegisterColumn\(columns\);\s*if \(!identity \|\| identity\.hidden\) return null;/,
    "the identity is resolved, and a hidden one freezes nothing",
  );
  assert.match(
    rule,
    /identity\.settings\.pinned === false/,
    "and only the identity's own refusal withdraws the fallback lane",
  );
  assert.doesNotMatch(
    rule,
    /columns\.some\(/,
    "no register-wide flag may decide it: one column's history is not the table's",
  );
  assert.match(
    rule,
    /return declined \? null : identity;/,
    "an unpinned register freezes its identity anyway, but never a hidden one",
  );
  assert.match(
    rule,
    /if \(pinned\) return pinned\.hidden \? null : pinned;/,
    "and visibility wins over the pin in the other branch too",
  );

  /*
   * PINNED MEANS DRAWN ONCE. The lane and a still-visible copy of the same
   * column is the contractor's name printed twice on every row, which is what
   * the live register did before this.
   *
   * RE-POINTED TO `registerTableColumns`, WHICH IS WHERE THAT FILTER LIVES NOW.
   * The grid used to write `shown.filter((column) => !frozen || column.id !==
   * frozen.id)` inline; the shared rule now returns the frozen lane followed by
   * the same filtered run, as one ordered list, so the table, the columns panel
   * and the ordering helpers cannot disagree about which column is out of the
   * run. The assertion follows the code and gains a second half it could not
   * have made before: `tests/register-source-of-truth.test.mjs` CALLS this and
   * checks that no column is drawn twice, on the owner's own column list.
   */
  assert.match(
    rule,
    /const scrolling = visibleColumns\(columns\)\.filter\(\s*\(column\) => !frozen \|\| column\.id !== frozen\.id,\s*\);/,
    "the pinned column is removed from the scrolling run",
  );
  assert.match(
    rule,
    /return frozen \? \[frozen, \.\.\.scrolling\] : scrolling;/,
    "and drawn once, at the front, or not at all",
  );

  /*
   * UNPINNED LEAVES NOTHING BEHIND. The sticky class is applied only while the
   * column is frozen, so there is no `position` to unset, no stale `left` and
   * no shadow to hide — which is why none of this is written as an override,
   * and why a stale offset is unrepresentable rather than reset.
   */
  assert.match(
    code,
    /lane\.frozen\s*\?\s*"contractor-register__lane contractor-register__lane--start"\s*:\s*undefined/,
    "the lane class is conditional on the pin, not overridden after it",
  );
  const styles = await registerStyles();
  assert.doesNotMatch(
    styles,
    /position: static;\s*z-index: auto;[\s\S]{0,120}\}\s*\}\s*$/,
    "nothing outside the phone band un-sticks a lane, because nothing needs to",
  );

  /*
   * AND THE IDENTITY IS NEVER ABSENT — WHEN THE REGISTER HAS NO ROW FOR IT.
   *
   * RE-POINTED, AND THIS PIN WAS HALF OF DEFECT 1. It read `if
   * (!lanes.some((lane) => lane.identity))`, which fires whenever the identity
   * is not among the drawn lanes — and a column the operator has UNTICKED is
   * not among the drawn lanes. So unticking "Contractor" wrote `hidden_at`,
   * the column left the run, and this line put the composite lane straight back
   * at the front as an unfrozen cell. The press was unanswerable: the checkbox
   * was correct, the API was correct, and the lane never went away.
   *
   * The condition it should always have been is `identity === null`: the
   * fallback exists for a register that has no ROW for the identity at all —
   * one seeded before the catalogue described it — and "no row" and "unticked"
   * are different facts. The original reasoning survives intact, because a
   * register with no row cannot have been unticked, so a row that does not say
   * whose row it is is still impossible for the reason it always was.
   */
  assert.match(code, /if \(identity === null\) \{/, "the fallback fires only when there is no row");
  assert.doesNotMatch(
    code,
    /if \(!lanes\.some\(\(lane\) => lane\.identity\)\) \{/,
    "asking the DRAWN lanes makes unticking the identity impossible",
  );
});

test("GEO-25 the card layout and the frozen lane switch at the SAME agreed width", async () => {
  const brand = await read(BRAND);
  const styles = await registerStyles();

  /*
   * THE READING IF THIS GOES: 761–767 renders a plain wide table with neither
   * pinning nor dividers nor cards. The card rules switched at 760 and the lane
   * unstuck at 767, and the seven pixels between them were a layout nobody
   * designed and the owner found.
   */
  const cards = brand.indexOf(".analytics-table--mobile-cards {");
  assert.ok(cards > 0, "brand-overrides.css must carry the card layout");
  const opener = brand.lastIndexOf("@media", cards);
  const query = brand.slice(opener, brand.indexOf("{", opener) + 1);
  assert.match(
    query,
    /@media \(max-width: 767px\) \{/,
    `the card layout must switch at 767, saw ${query.trim()}`,
  );

  // And the lane unsticks at the same number, in the same direction.
  const phone = styles.indexOf("@media (max-width: 767px)");
  assert.ok(phone > 0, "the register unsticks its lane at 767");
  assert.match(styles.slice(phone, phone + 400), /position: static;/);

  /*
   * THE WIDTH IS RELEASED WITH THE SAME SPECIFICITY IT WAS SET AT. Measured at
   * 762: the identity cell stayed 250px wide inside a card because the release
   * was one specificity step below the desktop rule — a card that will not fit,
   * which is exactly what the phone band exists to prevent.
   */
  assert.match(
    styles.slice(phone),
    /\.contractor-register__table th\.contractor-register__lane--start,\s*\.contractor-register__table td\.contractor-register__lane--start \{\s*width: auto;\s*min-width: 0;/,
  );

  // Only the agreed widths, in the whole of this register's styling.
  const queries = styles.match(/@media \([^)]*width: (\d+)px\)/g) ?? [];
  assert.ok(queries.length >= 2, "the register styles at more than one width");
  for (const entry of queries) {
    const width = Number(entry.match(/(\d+)px/)[1]);
    assert.ok(AGREED.includes(width), `${entry} is outside the agreed breakpoints`);
  }
});

test("GEO-25 the columns panel introduces no breakpoint of its own", async () => {
  const panel = await read(PANEL);
  const brand = await read(BRAND);

  /*
   * The panel's grid is `auto-fill` with a `min(100%, …)` floor, which narrows
   * to one column on its own at any width. So there is no breakpoint to declare
   * and nothing that can drift off the agreed five — which is the cheapest way
   * to keep a shared component out of this argument entirely.
   */
  assert.doesNotMatch(panel, /@media/, "the component declares no media query");
  const start = brand.indexOf(".register-columns-panel {");
  assert.ok(start > 0, "brand-overrides.css must carry the panel");
  const section = brand.slice(start, brand.indexOf(".register-column {", start));
  assert.doesNotMatch(section, /@media/, "and neither does its styling");
  assert.match(
    section,
    /repeat\(auto-fill, minmax\(min\(100%, 172px\), 1fr\)\)/,
    "the track narrows itself instead",
  );

  /*
   * AND THE TWO-COLUMN RULE IS GONE. The panel used to draw a Shown list beside
   * a Hidden list; it now draws one checklist and a note, and the old
   * `repeat(2, …)` put the note in a column BESIDE the list instead of under
   * it.
   */
  assert.doesNotMatch(
    section,
    /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
    "one checklist, not two lists side by side",
  );
});

test("GEO-13 the live register answers with the shape the frozen lane is derived from", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no dev server on 5173-5177 or 3000");
    return;
  }

  const response = await fetch(`${BASE_URL}/api/registers?register=contractors`, {
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.columns), "the snapshot carries its columns");

  /*
   * `pinned` IS A FIELD ON EVERY COLUMN, derived like `native` and `hidden`.
   * The grid reads it through `pinnedColumn` and never opens `settings` itself,
   * so a snapshot that stopped carrying it would silently freeze nothing.
   */
  for (const column of body.columns) {
    assert.equal(typeof column.pinned, "boolean", `${column.key} must carry a derived pinned flag`);
  }

  /*
   * AT MOST ONE, which is the invariant the frozen lane is a rendering of. Two
   * pinned columns is two sticky cells at `left: 0` drawn on top of each other.
   */
  const pinned = body.columns.filter((column) => column.pinned);
  assert.ok(pinned.length <= 1, `at most one pinned column, saw ${pinned.length}`);

  /*
   * AND THE IDENTITY IS FINDABLE WHATEVER THE ANSWER IS. When nothing is
   * pinned — the state of every live register — the lane falls back to the
   * `name` column, so the register losing that column is the one thing that
   * would leave rows with no identity on them.
   */
  const identity = body.columns.find((column) => column.key === "name");
  assert.ok(identity, "the register must still carry its identity column");
  assert.equal(identity.native, true, "and it is a view onto the contractor's own field");
  if (pinned.length === 1) {
    assert.equal(pinned[0].hidden, false, "a pinned column is always shown");
  }
});
