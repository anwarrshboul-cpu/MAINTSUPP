import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

/**
 * THE CONTRACTORS REGISTER, AFTER THE OWNER READ IT.
 *
 * W05/W06 built the configurable register and the owner accepted it on a
 * Preview. What they then reported was not a broken feature — every verb works
 * — but a table that could not be read:
 *
 *   1. The name column and the contact details were ordinary columns, so the
 *      operator hid the first and scrolled past the second. Rows with no
 *      identity on them at all.
 *   2. Hiding twenty-five columns filled the space below the table with
 *      twenty-five chips that never went away, and nothing anywhere listed
 *      what WAS on the table.
 *   3. The only way into a contractor was a chevron in the last cell of a
 *      twenty-four-column row, four thousand pixels to the right.
 *   4. No line between columns, and twenty-five fields on by default.
 *
 * The fixes are structural rather than cosmetic, which is why they are worth
 * pinning: a lane that is NOT a column cannot be hidden; one panel component
 * means one rendering of `register_columns.hidden_at`; a row press with a
 * `closest` guard cannot be forgotten by whoever adds the next control to a
 * cell. Each test below names the reading that would come back if the
 * structure were undone.
 *
 * Source assertions run everywhere. The behavioural test needs a dev server and
 * skips without one, which is the bargain the rest of this suite makes.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const GRID = "app/(app)/portal/contractor-register.tsx";
const PANEL = "app/(app)/portal/register/register-columns-panel.tsx";
const SITES_GRID = "app/(app)/portal/register/register-grid.tsx";
/**
 * The browser's half of the register, and now the home of the frozen rule.
 *
 * "Which column is the frozen lane" and "what does one press of Move earlier
 * mean" are decided here rather than inside a grid, because the grid, the
 * columns panel and the ordering helpers all have to give the same answer.
 * `tests/register-source-of-truth.test.mjs` exercises both by calling them.
 */
const CLIENT = "app/(app)/portal/register/register-client.ts";
const CATALOGUE = "app/lib/register-catalogue.ts";
const GLOBALS = "app/globals.css";
const APP = "app/(app)/portal/portal-app.tsx";

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

const PRIMARY_ORGANISATION_ID = "org_000000000000000000000001";

// Found rather than assumed — vite takes the first free port from 5173 up.
const CANDIDATES = process.env.MAINTSUPP_BASE_URL
  ? [process.env.MAINTSUPP_BASE_URL]
  : [5173, 5174, 5175, 5176, 5177, 3000].map((port) => `http://localhost:${port}`);
let BASE_URL = CANDIDATES[0];

const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/** A marker every fixture carries, so a stray row is traceable to this run. */
const RUN = `ZZQA-UX-${Date.now().toString(36)}`;

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

let cookie = null;
async function signIn() {
  if (cookie !== null) return cookie;
  try {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    cookie = response.ok
      ? (response.headers.getSetCookie?.() ?? []).map((raw) => raw.split(";")[0]).join("; ")
      : "";
  } catch {
    cookie = "";
  }
  return cookie;
}

async function call(method, path, body) {
  await signIn();
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      cookie: cookie ?? "",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { raw };
  }
  return { status: response.status, body: parsed };
}

/**
 * The development database, opened once — for the residue check only.
 *
 * The API can say a column is gone from the register; only the table can say
 * the ROW is gone. Those are different claims and this file makes the second.
 */
async function openDevDatabase(readOnly) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
  let file;
  try {
    file = (await readdir(directory)).find(
      (entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite",
    );
  } catch {
    return null;
  }
  if (!file) return null;
  try {
    // `fileURLToPath`, not `URL.pathname`: this repo's path has a space in it,
    // and a percent-encoded path opens nothing.
    const db = new DatabaseSync(fileURLToPath(new URL(file, directory)), { readOnly });
    if (!readOnly) db.exec("PRAGMA busy_timeout = 15000");
    return db;
  } catch {
    return null;
  }
}

/**
 * Ids this file CREATED, and the only rows it may delete.
 *
 * By exact primary key, never by a name substring. This suite runs against a
 * development database other work is using, and this repository's notes record
 * a substring sweep eating another agent's fixtures more than once.
 */
const createdColumnIds = [];

after(async () => {
  if (createdColumnIds.length === 0) return;
  const db = await openDevDatabase(false);
  if (!db) {
    console.warn("fixture cleanup could not open the development database");
    return;
  }
  try {
    for (const id of createdColumnIds) {
      db.prepare("DELETE FROM register_columns WHERE id = ?").run(id);
      db.prepare("DELETE FROM register_values WHERE column_key = ? AND organisation_id = ?").run(
        id,
        PRIMARY_ORGANISATION_ID,
      );
      db.prepare("DELETE FROM audit_events WHERE entity_id = ?").run(id);
    }
  } catch (error) {
    console.warn(`fixture cleanup left rows behind: ${error.message}`);
  } finally {
    try {
      db.close();
    } catch {
      // The handle is going out of scope regardless.
    }
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Source — the shape of the thing
   ═══════════════════════════════════════════════════════════════════════════ */

test("UX-2 the permanent hidden-column chip block is gone from the register", async () => {
  const grid = await read(GRID);
  const code = codeOnly(grid);

  /*
   * The block was `<div className="contractor-register__hidden">` holding a
   * `<span className="drawer-label">Hidden columns</span>` and one button per
   * hidden column, rendered after the table and for as long as anything was
   * hidden. On the live register that was twenty-five buttons below the rows
   * permanently, so the page never ended.
   */
  assert.doesNotMatch(code, /contractor-register__hidden/, "the chip block's class is gone");
  assert.doesNotMatch(code, />Hidden columns</, "and so is its heading");

  // And its styling went with the markup rather than being left behind to
  // style nothing.
  const css = await read(GLOBALS);
  assert.doesNotMatch(css, /\.contractor-register__hidden \{/);
  assert.doesNotMatch(css, /\.contractor-register__hidden-chips \{/);

  /*
   * The reasoning the block carried is still true — a "show hidden" control
   * cannot offer back a column it was never told about — so it was rewritten
   * where it now applies rather than deleted with the code.
   */
  assert.match(
    grid,
    /SHOW HIDDEN — MOVED INTO THE COLUMNS PANEL/,
    "the note has to say where the behaviour went",
  );
});

test("UX-2 one columns panel component serves both registers, over one hidden-column state", async () => {
  const panel = await read(PANEL);
  const grid = await read(GRID);
  const sites = await read(SITES_GRID);

  assert.match(panel, /export function RegisterColumnsPanel\(/, "the shared component exists");

  // Both registers mount THAT, rather than each rendering a list of its own.
  for (const [name, source] of [
    ["the Contractors register", grid],
    ["the Sites register", sites],
  ]) {
    assert.match(source, /import \{ RegisterColumnsPanel \}/, `${name} imports the panel`);
    assert.match(source, /<RegisterColumnsPanel/, `${name} mounts the panel`);
  }

  /*
   * NO SECOND HIDDEN-COLUMN STATE. The panel is handed the columns and reports
   * a press back; it holds no `useState` and calls no API, so there is nothing
   * in it that could disagree with `register_columns.hidden_at`. A panel that
   * remembered what was hidden would be a second answer to a question the
   * database already answers, and the two would part company the first time a
   * write failed.
   */
  assert.doesNotMatch(codeOnly(panel), /useState|useEffect|fetch\(/, "the panel stores nothing");
  /*
   * RE-POINTED FROM `import type { RegisterColumn }` TO THE SAME LINE CARRYING
   * ONE PURE FUNCTION BESIDE IT, and the contract is untouched.
   *
   * What this asserts is that the panel takes the SERVER'S SHAPE rather than
   * modelling a column of its own, and it still does — `RegisterColumn` is
   * imported as a type from the one module that defines it. What joined it is
   * `canMoveRegisterColumn`, which decides whether Move earlier / Move later
   * would change the table: a pure question about the columns it was handed,
   * with no state, no fetch and no memory. It is imported rather than
   * re-derived for exactly the reason this test exists — the panel must not
   * hold a second answer to a question something else already answers — and
   * `index === 0` was that second answer: a test on the FULL list, which left
   * the button live on a column already first ON THE TABLE.
   */
  assert.match(
    panel,
    /import \{ canMoveRegisterColumn, type RegisterColumn \} from "\.\/register-client";/,
    "it takes the server's shape, and the shared rule for what a press would do",
  );

  // The one verb, called from the grids and nowhere else.
  assert.doesNotMatch(codeOnly(panel), /setRegisterColumnHidden/, "the grid owns the call");
  assert.match(grid, /setRegisterColumnHidden\(column\.id, next\)/);
  assert.match(sites, /setRegisterColumnHidden\(column\.id, next\)/);

  /*
   * And the Contractors-only list markup went with it: the checkbox list this
   * register used to draw, and the `globals.css` rules that styled it.
   */
  const css = await read(GLOBALS);
  assert.doesNotMatch(css, /\.contractor-register__panel ul \{/, "the private list styling is gone");
  assert.doesNotMatch(css, /\.contractor-register__panel li \{/);
});

test("UX-1/UX-4 the frozen lane is one column, it is never absent, and nothing is pinned right", async () => {
  const grid = await read(GRID);
  const code = codeOnly(grid);

  /*
   * RE-POINTED, AND THE CONTRACT MOVED UNDER IT — twice, in the same pass.
   *
   * It read "the two pinned lanes are structure, not columns". There are no
   * longer two and the one that is left IS a column:
   *
   *   1. THE ACTION LANE IS GONE. The owner asked for the permanent chevron and
   *      pencil to be removed, so a test that required an `--end` lane was
   *      requiring the defect. The assertion is inverted rather than deleted —
   *      "no sticky lane on the right" is the thing to hold now, and holding it
   *      is what stops the eighty-six pixels coming back.
   *   2. THE START LANE IS A PINNED COLUMN, not a lane invented beside one.
   *      `register_columns.settings.pinned`, at most one per register, so the
   *      identity is drawn ONCE — as the lane, and dropped from the scrolling
   *      run. The old shape drew the lane beside a still-visible `name` column
   *      and the live register printed the contractor's name twice per row.
   *
   * What the original was protecting survives in the last two assertions and in
   * the fallback below: the row always says whose row it is.
   */
  const headStart = code.indexOf("contractor-register__lane contractor-register__lane--start");
  const lanesBuilt = code.indexOf("const lanes = gridLanes(");
  assert.ok(headStart > 0 && lanesBuilt > 0 && lanesBuilt < headStart, "the lanes are decided before they are drawn");

  assert.match(code, /contractor-register__lane--start/, "a start lane");
  assert.doesNotMatch(
    code,
    /contractor-register__lane--end/,
    "no sticky action lane on the right — the row press and the profile drawer carry those two verbs",
  );

  /*
   * THE FROZEN COLUMN IS NOT ALSO IN THE SCROLLING RUN. This is the assertion
   * that stops the duplicate name coming back.
   *
   * RE-POINTED TO `registerTableColumns`, WHICH IS WHERE THE FILTER LIVES NOW,
   * and the contract is stronger for the move rather than weaker. The grid used
   * to write the filter inline; the shared rule now returns the frozen lane
   * followed by that same run, as ONE ordered list, because the table, the
   * columns panel and the ordering helpers all have to agree about which column
   * is out of the run — and while that filter was inside the grid, the panel's
   * Move earlier could hand a column past a lane it could not see.
   */
  const rule = codeOnly(await read(CLIENT));
  assert.match(
    rule,
    /const scrolling = visibleColumns\(columns\)\.filter\(\s*\(column\) => !frozen \|\| column\.id !== frozen\.id,\s*\);/,
    "the pinned column is removed from the scrolling set",
  );
  assert.match(
    rule,
    /return frozen \? \[frozen, \.\.\.scrolling\] : scrolling;/,
    "and drawn as the lane, exactly once",
  );
  assert.match(
    code,
    /const tableColumns = registerTableColumns\(snap\.columns, frozen\);/,
    "and the grid draws the answer rather than deriving a second one",
  );

  /*
   * AND A REGISTER WITH NOTHING PINNED STILL HAS ITS IDENTITY FROZEN. Not one
   * organisation in either database carries a pinned column — the seed sets the
   * flag at seed time only — so "nothing is pinned" is the state of every live
   * register, and a lane gated on the flag alone would take the name and the
   * phone number off the owner's Preview.
   *
   * RE-POINTED FROM THE GRID TO `register-client.ts`, WITH THE CLAUSE THE OWNER
   * FOUND MISSING.
   *
   * The rule moved next door because three surfaces have to agree about which
   * column is out of the scrolling run — the grid, the columns panel and the
   * ordering helpers — and three readings of `settings` were three chances to
   * disagree. It also grew the check whose absence was a defect: the fallback
   * ended `columns.find((column) => column.nativeField === "name") ?? null`
   * with no `hidden` test anywhere in the function, so unticking "Contractor"
   * in the columns panel wrote `hidden_at` and the very next render put the
   * lane straight back from the same column. Visibility now wins in BOTH
   * branches. The fallback itself is untouched and still the point of the
   * function.
   */
  assert.match(
    rule,
    /const pinned = pinnedColumn\(columns\);/,
    "the register's own answer is asked first",
  );
  assert.match(
    rule,
    /if \(pinned\) return pinned\.hidden \? null : pinned;/,
    "and a pinned column that is off the register freezes nothing",
  );
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
    "and an unpinned register freezes its identity anyway, unless it was unticked",
  );
  assert.match(code, /frozenRegisterColumn/, "the grid asks the shared rule for its lane");

  /*
   * The lane's LABEL follows a rename of the `name` column, because renaming is
   * a verb the register promises and a lane that ignored it would be the one
   * column whose title could not be changed. Matched on `nativeField`, never on
   * position — the reader may have moved the column anywhere — and read
   * whether the column is shown or hidden, because a label belongs to a column
   * rather than to its visibility.
   */
  /*
   * RE-POINTED FROM THE GRID'S OWN `find` TO THE SHARED LOOKUP, AND FROM THE
   * LITERAL "Contractor" TO THE CONSTANT THAT NAMES IT.
   *
   * The rule is word for word what it was — matched on `nativeField`, never on
   * position, and found whether the column is shown or hidden — and it is now
   * spelt once, in `register-client.ts`, where the frozen rule and the ordering
   * helpers read the same answer. The grid had a second copy of this `find`
   * beside `frozenRegisterColumn`'s, which is how the two came to disagree
   * about a hidden identity: one treated "hidden" as "gone" and the other did
   * not, and the composite lane survived a press that had already hidden it.
   *
   * `CONTRACTOR_COLUMN_TITLE` is the same string, named. It is reachable only
   * on a register with no row for the identity at all, and it is the DEFAULT
   * label rather than the lane's — a rename to "Supplier" still renames the
   * lane, which is the half of this assertion that matters.
   */
  assert.match(
    code,
    /const identityColumn = identityRegisterColumn\(snap\.columns\);/,
    "the identity column is found by its native field, by the shared lookup",
  );
  assert.match(
    code,
    /identityColumn\?\.title \?\? CONTRACTOR_COLUMN_TITLE/,
    "and the lane takes its title from that column when there is one",
  );
  const client = await read(CLIENT);
  assert.match(
    client,
    /return columns\.find\(\(column\) => column\.nativeField === CONTRACTOR_COLUMN_KEY\) \?\? null;/,
    "and the shared lookup is still a match on the native field",
  );
  assert.match(client, /export const CONTRACTOR_COLUMN_TITLE = "Contractor";/);

  /*
   * THE IDENTITY IS READ OFF THE ROW, not off the register. This is the whole
   * point of the change: `visibleColumns` can return a list with no name in it
   * — the live register's did — and a lane that drew `registerCellValue` for
   * the name column would go blank with it.
   */
  assert.match(code, /<strong>\{row\.name\}<\/strong>/, "the lane prints the row's own name");

  // The one reader is still called exactly once, and still handed both stores.
  assert.equal(
    (code.match(/registerCellValue\(/g) ?? []).length,
    1,
    "every cell must still come through one call to registerCellValue",
  );
});

test("UX-1/UX-4 the frozen lane sits on a tier token and is opaque in both themes", async () => {
  const css = await read(GLOBALS);
  /*
   * RE-POINTED at the section's new heading, which changed with its subject:
   * "The two pinned lanes" became "The frozen lane" when the right-hand action
   * lane was deleted. The slice is what scopes every assertion below to this
   * register's styling, so it follows the heading rather than being widened.
   */
  const lanes = css.slice(css.indexOf("---- The frozen lane,"));
  assert.ok(lanes.length > 0, "globals.css must carry the lane section");

  // A raw number here is what `tests/ui-batch-overlays.test.mjs` refuses, and
  // the tier is the one every other frozen table column in this product uses.
  assert.match(lanes, /\.contractor-register__lane \{[^}]*z-index: var\(--z-sticky\);/);
  const rawZ = lanes.match(/^\s*z-index:\s*-?\d+\s*;/m);
  assert.equal(rawZ, null, `the lanes must not declare a raw z-index (${rawZ && rawZ[0]})`);

  /*
   * OPAQUE, AND ON THE SAME GROUND AS THE ROW. `--surface-card` and not
   * `--paper`: in light both are #ffffff and either reads correct, but in dark
   * `--paper` is #121c24 while every `.data-table td` is painted #182830 —
   * which is `--surface-card`. The wrong token was a strip of a different
   * colour down the left of every row in the dark theme only.
   */
  assert.match(
    lanes,
    /td\.contractor-register__lane \{\s*background: var\(--surface-card\);/,
    "the body lane paints the row's own ground",
  );
  assert.match(
    lanes,
    /th\.contractor-register__lane \{\s*background: var\(--surface-head\);/,
    "and the header lane the header's",
  );

  /*
   * THE HOVER IS A WASH OVER AN OPAQUE BASE. `.data-table tbody tr:hover td` is
   * 5.5%-alpha teal; taken as a background COLOUR on a sticky cell it is a
   * hole, and the rows sliding underneath show through — but only while the
   * pointer is on the row, which no screenshot would ever catch.
   */
  assert.match(lanes, /background-color: var\(--surface-card\);/);
  assert.match(lanes, /background-image: linear-gradient\(/);

  /*
   * THE LANE CARRIES A VISIBLE EDGE, AND EXACTLY ONE LINE DRAWS IT.
   *
   * The `--end` half of this pair is gone with the action lane it described.
   * What replaced it is the stronger claim: the frozen boundary is the SAME
   * `border-right` every other cell draws, re-coloured — not a second 1px line
   * painted outside the first as a shadow, which is what it was and which is a
   * double border on the one boundary meant to look deliberate. The selector
   * has to be element + class or the shared divider rule out-ranks it and the
   * edge silently stays `--line-soft`; that was measured, not assumed.
   */
  assert.match(lanes, /\.contractor-register__lane--start \{\s*left: 0;/);
  assert.doesNotMatch(
    lanes,
    /\.contractor-register__lane--end/,
    "nothing is pinned to the right of this table any more",
  );
  assert.match(
    lanes,
    /th\.contractor-register__lane--start,\s*\.contractor-register__table td\.contractor-register__lane--start \{[^}]*border-right-color: var\(--register-lane-edge\);/,
    "the frozen edge is the cell's own divider in a darker ink, so there is one line and no bleed",
  );
  assert.doesNotMatch(
    lanes,
    /box-shadow: 1px 0 0 var\(--register-lane-edge\)/,
    "a hard 1px shadow beside the border is the double line this replaced",
  );
  assert.match(lanes, /--register-lane-edge: #2b414b;/, "a dark edge colour");

  /*
   * NOTHING IS PINNED ON A PHONE — `.analytics-table--mobile-cards` has already
   * stopped this being a table by then, so there is no scroll to freeze against
   * and a 250px sticky cell inside a card is a card that will not fit.
   */
  const phone = lanes.slice(lanes.indexOf("@media (max-width: 767px)"));
  assert.match(phone.slice(0, 400), /position: static;/, "the lanes unstick on a phone");

  // Only the agreed breakpoints, in the whole of this register's styling.
  const section = css.slice(css.indexOf("---- The configurable register grid"));
  const queries = section.match(/@media \([^)]*width: (\d+)px\)/g) ?? [];
  assert.ok(queries.length >= 2, "the register styles at more than one width");
  for (const query of queries) {
    const width = Number(query.match(/(\d+)px/)[1]);
    assert.ok(
      [640, 767, 768, 1024, 1280].includes(width),
      `${query} is outside the agreed breakpoints`,
    );
  }
});

test("UX-5 the column dividers are one thin line per boundary, and the table does not drift wider", async () => {
  const css = await read(GLOBALS);
  // RE-POINTED at the section's new heading: "The two pinned lanes" became
  // "The frozen lane" when the right-hand action lane was deleted.
  const lanes = css.slice(css.indexOf("---- The frozen lane,"));

  /*
   * `separate` is not a preference. Under `border-collapse: collapse` the
   * borders belong to the TABLE and not to the cells, so a sticky cell scrolls
   * out from under its own border and leaves the divider stranded mid-table.
   */
  assert.match(
    lanes,
    /\.contractor-register__table \{\s*border-collapse: separate;\s*border-spacing: 0;/,
    "sticky cells need their own borders",
  );

  /*
   * ONE LINE PER BOUNDARY. Only `border-right` is ever declared — no cell
   * carries a matching `border-left` — so two neighbours cannot both draw at
   * the same junction, and `box-sizing: border-box` keeps the pixel inside the
   * width the column was resized to instead of adding to it.
   */
  assert.match(
    lanes,
    /\.contractor-register__table th,\s*\.contractor-register__table td \{\s*border-right: 1px solid var\(--line-soft\);/,
    "a soft divider, not the heavy line that makes a table look boxed",
  );
  assert.match(lanes, /td:last-child \{\s*border-right: 0;/, "and nothing on the outside edge");
  assert.doesNotMatch(lanes, /border-left: 1px/, "a second border at a junction is a double line");
});

test("UX-3 the whole row opens the contractor, and nothing interactive is swallowed", async () => {
  const grid = await read(GRID);
  const code = codeOnly(grid);

  /*
   * ONE GUARD RATHER THAN `stopPropagation` ON EVERY CHILD. Both work today;
   * they differ on the NEXT control somebody puts in a cell. A per-child
   * handler has to be remembered, and nothing fails visibly when it is not —
   * the row simply opens a drawer over the thing the user pressed. `closest`
   * over the elements a browser already treats as interactive exempts a new
   * link, button or field the moment it exists.
   */
  assert.match(code, /const ROW_INTERACTIVE_SELECTOR = \[/, "the exemption list is one constant");
  for (const selector of ["a", "button", "input", "select", "textarea", "label"]) {
    assert.match(
      code,
      new RegExp(`^\\s*"${selector}",$`, "m"),
      `${selector} must be exempt from the row press`,
    );
  }
  assert.match(code, /'\[role="menuitem"\]',/, "a column menu item is exempt");
  assert.match(
    code,
    /target\.closest\(ROW_INTERACTIVE_SELECTOR\)\) \{\s*return;/,
    "and the guard runs before the row opens anything",
  );

  /*
   * NO NESTED INTERACTIVE ELEMENTS. The row is a `<tr>` with a click handler
   * and no `role`, no `tabIndex` and no wrapping control: a `<tr>` inside a
   * `<button>` is invalid markup, and a `<tr tabindex="0">` is a focus stop
   * that announces nothing. The keyboard route is the two real buttons — the
   * name in the identity lane and the chevron in the action lane.
   */
  /*
   * The `<tr>` element only — from the row loop to the first cell. Sliced on
   * `<td`, not on the first `>`, because the tag's own `onClick` is an arrow
   * function and `=>` would end the slice on the attribute being checked.
   */
  const rowOpen = code.slice(code.indexOf("{rows.map((row) => ("));
  const rowTag = rowOpen.slice(0, rowOpen.indexOf("<td"));
  assert.doesNotMatch(rowTag, /tabIndex/, "the row is not a focus stop");
  assert.doesNotMatch(rowTag, /role=/, "and it is not pretending to be a control");
  assert.match(rowTag, /onClick=\{/, "it is a click handler and nothing more");
  assert.match(
    code,
    /className=\{onOpen \? "contractor-register__row is-openable" : "contractor-register__row"\}/,
    "and it only offers the pointer when it was actually given an onOpen",
  );

  const css = await read(GLOBALS);
  assert.match(css, /\.contractor-register__row\.is-openable \{\s*cursor: pointer;/);
});

test("UX-4 there is no permanent action lane, and both of its verbs still have a home", async () => {
  const grid = await read(GRID);
  const code = codeOnly(grid);

  /*
   * RE-POINTED, AND THE SUBJECT INVERTED — deliberately, because the owner
   * asked for exactly what this test used to require.
   *
   * It read "the details chevron is pinned at the right and the editor keeps
   * its own way in", and it was right at the time: a chevron four thousand
   * pixels along a twenty-four-column row is unreachable, so pinning it was the
   * fix. What the owner then saw was the cost — a frozen lane holding a chevron
   * and a pencil on every row at every width, eighty-six pixels of a table they
   * had already called too wide, for a press the whole row now answers and an
   * editor the profile drawer now carries.
   *
   * So the contract it was protecting is not dropped, it MOVED, and each half
   * is asserted where it went:
   *   · OPEN  — the row press, guarded by `ROW_INTERACTIVE_SELECTOR`, plus the
   *             name button that gives a keyboard the same route. Both are
   *             covered by the UX-3 test above; what is asserted here is that
   *             nothing replaced the lane.
   *   · EDIT  — the profile drawer. `onManage` stays declared on the grid so
   *             the page's existing wiring type-checks, and is drawn nowhere
   *             here.
   */
  assert.equal(
    code.indexOf('data-label="Actions"'),
    -1,
    "no Actions cell — that lane is gone, not moved",
  );
  assert.doesNotMatch(code, /aria-label=\{`Open \$\{row\.name\}`\}/, "no permanent chevron column");
  assert.doesNotMatch(code, /aria-label=\{`Edit \$\{row\.name\}`\}/, "no permanent pencil column");
  assert.doesNotMatch(code, /contractor-register__row-actions/, "and nothing to hold them in");
  assert.doesNotMatch(
    code,
    /<th scope="col" className="contractor-register__lane contractor-register__lane--end">/,
    "nor a header for a column that no longer exists",
  );

  /*
   * THE EDITOR'S PROP SURVIVES THE CONTROL. Dropping it from the type would
   * make the page that has always passed it a compile error in somebody else's
   * file, and the comment beside it is where a reader will look for the pencil.
   */
  assert.match(code, /onManage\?: \(id: string\) => void;/, "still declared, deliberately unused");
  assert.equal(
    (code.match(/onManage\(/g) ?? []).length,
    0,
    "and called nowhere in the grid",
  );

  /*
   * The empty-state row spans EVERY LANE THE HEADER DREW, counted from the same
   * list the header drew it from. It was `shown.length + extraColumns.length +
   * 2` — the two lanes hard-coded into the sum — which is a second derivation
   * of the width and goes wrong the first time the two disagree.
   */
  assert.match(code, /colSpan=\{lanes\.length\}/);
});

test("UX-1 the contact block is drawn once, in the pinned lane, and not as a scrolling column", async () => {
  const grid = await read(GRID);
  const app = await read(APP);

  // The grid takes it as the identity lane's second half rather than as one of
  // the page's period-scoped figures.
  assert.match(grid, /contact\?: \(row: Row\) => React\.ReactNode;/, "a prop of its own");
  assert.match(codeOnly(grid), /\{contact\?\.\(row\)\}/, "rendered inside the identity lane");

  /*
   * IT WAS AN `extraColumn` TITLED "Reach them". As an extra it was drawn after
   * every register column, so on a twenty-four-column register the number was
   * four thousand pixels right of the name it belonged to — and once the
   * operator hid the name column it became the FIRST thing on the row, with
   * nothing to say whose contact details it was.
   */
  assert.doesNotMatch(codeOnly(app), /key: "reach"/, "no longer an extra column");
  assert.doesNotMatch(codeOnly(app), /title: "Reach them"/);
  assert.match(
    codeOnly(app),
    /contact=\{\(contractor\) => <ContractorContact contractor=\{contractor\} \/>\}/,
    "the page hands the actionable contact to the lane",
  );

  /*
   * And exactly once on this screen. Two copies of the WhatsApp rule is two
   * chances to build a `wa.me` link out of a national number, which is what
   * `contact-links.ts` exists to prevent.
   */
  assert.equal(
    (codeOnly(app).match(/<ContractorContact contractor=/g) ?? []).length,
    1,
    "the contractors page renders the contact block once",
  );

  // The five period-scoped figures are untouched and still extras.
  for (const key of ["assigned", "completed", "completion", "urgent", "documents", "spend"]) {
    assert.match(app, new RegExp(`key: "${key}",`), `${key} is still a page figure`);
  }
});

test("UX-8 the contractor catalogue's default view is the operational one, not all 25 fields", async () => {
  const catalogue = await read(CATALOGUE);
  const block = catalogue.slice(
    catalogue.indexOf("export const CONTRACTOR_NATIVE_COLUMNS"),
    catalogue.indexOf("/** The native columns a register starts with"),
  );

  const seeds = [...block.matchAll(/\{ field: "([A-Za-z0-9_]+)"[^}]*\}/g)].map((match) => ({
    field: match[1],
    hidden: /hidden: true/.test(match[0]),
    pinned: /pinned: true/.test(match[0]),
  }));
  /*
   * RE-POINTED FROM 25 TO 31 — the six measurement columns joined the
   * catalogue, and the contract this test protects is unchanged by it.
   *
   * What it has always been about is that the DEFAULT VIEW is the operational
   * one rather than every field the table holds, and that is still exactly what
   * is asserted below. The six figures — assigned, completed, completion rate,
   * open urgent, documents, spend — used to be drawn beside the register from a
   * hardcoded list in the page, which meant the reader could see them and could
   * not move or hide them: `reorderRegisterColumns` drops any key with no row
   * behind it, and the Columns panel cannot list what it has no record of.
   * Declaring them here is what makes the official requirement that they be
   * reorderable true, and it costs the register nothing — they carry
   * `measurement: true`, the grid pairs each with the `extraColumns` renderer
   * of the same key, and nothing reads a stored value for them.
   *
   * So the count moved and the meaning did not. The two assertions that follow
   * are the real contract and are deliberately left alone.
   */
  assert.equal(seeds.length, 31, `the catalogue describes 25 fields and 6 measurements, saw ${seeds.length}`);
  assert.equal(
    [...block.matchAll(/measurement: true/g)].length,
    6,
    "and exactly six of them are measurements",
  );

  /*
   * ONE STORED FIELD on by default, and it is `availability`. The six figures
   * — assigned, completed, completion rate, open urgent, documents, spend —
   * are now catalogue columns too, so that they can be reordered and hidden
   * like anything else, but they are computed rather than stored and are
   * counted separately above. The grid draws identity and contact in a frozen
   * lane, so the default view is seven lanes wide before a stored field is on
   * it. `availability` is the field that decides who gets rung next, so it
   * earns the eighth.
   */
  const visible = seeds.filter((seed) => !seed.hidden).map((seed) => seed.field);
  /*
   * RE-POINTED alongside the count above. The six measurements seed VISIBLE
   * because they are the default operational view the owner asked for — the
   * register reads Reach them, Assigned, Completed, Completion rate, Open
   * urgent, Documents, Spend — and they are listed here in catalogue order so a
   * silent reordering of the default view fails this test rather than shipping.
   * The contract is unchanged: exactly ONE stored field is on by default, and
   * it is still `availability`.
   */
  assert.deepEqual(
    visible,
    [
      "name",
      "assigned",
      "completed",
      "completion",
      "urgent",
      "documents",
      "spend",
      "availability",
    ],
    "the default view is the identity lane, the six figures, and availability",
  );
  assert.deepEqual(
    visible.filter((field) => !["name", "assigned", "completed", "completion", "urgent", "documents", "spend"].includes(field)),
    ["availability"],
    "exactly one STORED field seeds onto the scrolling table",
  );

  /*
   * `name` SEEDS PINNED, AND THIS PIN WAS RE-POINTED RATHER THAN DROPPED.
   *
   * It used to assert that `name` seeded HIDDEN, and the reason was sound: the
   * identity lane printed the contractor's name on every row, so a `name`
   * column shown as well would have printed the same string twice. The contract
   * it was protecting is "the contractor's name appears once", and that has not
   * changed — what changed is where the lane's content comes from. The lane is
   * now the PINNED column rather than hard-coded structure, so `name` is the
   * lane: it seeds shown-and-pinned, the grid draws it frozen at the left
   * instead of in the scrolling run, and it is still printed once.
   *
   * Seeding it hidden would now be the bug, because a pinned-and-hidden column
   * is a frozen lane with nothing in it — which is why the engine refuses to
   * write that pair at all.
   */
  const name = seeds.find((seed) => seed.field === "name");
  assert.ok(name?.pinned, "the name column seeds pinned, which is what puts it in the lane");
  assert.ok(!name?.hidden, "and a pinned column is on the register by definition");
  assert.match(catalogue, /AND `name` SEEDS PINNED RATHER THAN HIDDEN/);

  // Exactly one, on this register. Two frozen lanes on a phone is a table with
  // no scrolling half left, and the API enforces the same rule on every write.
  assert.equal(
    seeds.filter((seed) => seed.pinned).length,
    1,
    "at most one pinned column per register, at seed as well as at runtime",
  );

  /*
   * AND THIS CHANGES NOTHING FOR AN ORGANISATION THAT HAS ALREADY SEEDED.
   * `hidden` is read once, by `ensureRegisterColumns`, when a register is first
   * created; every workspace that exists keeps whatever its operators have
   * shown and hidden since. Said in the source, because a reader who thought
   * otherwise would expect this commit to undo somebody's configuration.
   */
  assert.match(catalogue, /WHAT `hidden` IS NOT\. It is a SEED, read once by `ensureRegisterColumns`/);
  const engine = await read("app/lib/register-columns.ts");
  /*
   * RE-POINTED, NOT WEAKENED. This was `hiddenAt: seed.hidden ? now : null` and
   * it was pinning one thing: that the seed is applied on INSERT and never
   * re-applied. It still is. The expression grew a second term because `pinned`
   * now shares the seed and the two contradict each other — a column that is
   * both is a frozen lane with nothing in it — so the precedence is stated in
   * the code rather than left to whichever verb somebody presses first.
   */
  assert.match(
    engine,
    /hiddenAt: seed\.hidden && !seed\.pinned \? now : null,/,
    "the seed is applied on insert only, and a pin beats a hide",
  );
  assert.match(engine, /onConflictDoNothing\(\)/, "and never re-applied to an existing row");

  // Sites is untouched: its own hidden set is the superseded and import-only
  // fields it always had.
  const sites = catalogue.slice(
    catalogue.indexOf("export const SITE_NATIVE_COLUMNS"),
    catalogue.indexOf("export const CONTRACTOR_NATIVE_COLUMNS"),
  );
  const siteHidden = [...sites.matchAll(/\{ field: "([A-Za-z0-9_]+)"[^}]*hidden: true[^}]*\}/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    siteHidden.sort(),
    [
      "active",
      "address",
      "lifecycle",
      "manager",
      "mondayComplianceName",
      "mondayMaintenanceName",
      "type",
    ],
    "the Sites catalogue keeps exactly the hidden set it had",
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   Behaviour — against the running development server
   ═══════════════════════════════════════════════════════════════════════════ */

test("UX-11 the Columns panel's show and hide are the same data model the rest of the register uses", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  /*
   * EXERCISED ON A COLUMN THIS FILE CREATED, and never on a seeded one. The
   * shared development register is somebody else's screen too; a native column
   * left hidden by a test is residue that reads as a product defect. The
   * native path is covered — with restore points — by
   * `tests/workstream-five-six-register-columns.test.mjs`.
   */
  const added = await call("POST", "/api/registers", {
    register: "contractors",
    title: `${RUN} Preferred contact hour`,
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const column = added.body.column;
  createdColumnIds.push(column.id);
  assert.equal(column.hidden, false, "a new column starts on the table");

  // HIDE — the verb the panel calls.
  const hidden = await call("PATCH", "/api/registers", { id: column.id, hidden: true });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));

  /*
   * PERSISTENCE ACROSS RELOAD is not a client concern: the flag is a row, so a
   * second GET is what a reloaded page would do. The column must still be IN
   * the answer carrying `hidden: true` — a route that filtered hidden columns
   * out would leave the panel unable to offer back a column it was never told
   * about, which is the whole reason the chip block existed.
   */
  let snapshot = await call("GET", "/api/registers?register=contractors");
  let seen = snapshot.body.columns.find((entry) => entry.id === column.id);
  assert.ok(seen, "a hidden column is still returned");
  assert.equal(seen.hidden, true);

  // SHOW — the same verb, the other way, and the round trip back is one press.
  const shown = await call("PATCH", "/api/registers", { id: column.id, hidden: false });
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  snapshot = await call("GET", "/api/registers?register=contractors");
  seen = snapshot.body.columns.find((entry) => entry.id === column.id);
  assert.equal(seen.hidden, false, "showing it puts it back on the table");

  // The other four verbs still answer on the same column, which is what
  // "the panel uses the same data model" has to mean in practice.
  assert.equal(
    (await call("PATCH", "/api/registers", { id: column.id, title: `${RUN} Best hour` })).status,
    200,
    "rename",
  );
  assert.equal(
    (await call("PATCH", "/api/registers", { id: column.id, width: 240 })).status,
    200,
    "resize",
  );
  snapshot = await call("GET", "/api/registers?register=contractors");
  const order = snapshot.body.columns.map((entry) => entry.key);
  const moved = order.filter((key) => key !== column.key);
  moved.splice(1, 0, column.key);
  assert.equal(
    (await call("PATCH", "/api/registers", { register: "contractors", order: moved })).status,
    200,
    "reorder",
  );

  snapshot = await call("GET", "/api/registers?register=contractors");
  seen = snapshot.body.columns.find((entry) => entry.id === column.id);
  assert.equal(seen.title, `${RUN} Best hour`, "the rename survived");
  assert.equal(seen.width, 240, "and the width");
  assert.equal(seen.position, 1, "and the position");

  // REMOVED BY THIS FILE, and then proved gone from the table rather than
  // merely absent from an answer.
  const removed = await call("DELETE", `/api/registers?id=${encodeURIComponent(column.id)}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  const db = await openDevDatabase(true);
  if (!db) {
    t.diagnostic("no development database; the residue check was not run");
    return;
  }
  try {
    const residue = db
      .prepare("SELECT id, deleted_at FROM register_columns WHERE id = ?")
      .all(column.id);
    assert.equal(residue.length, 1, "a removed custom column is soft-removed, not dropped");
    assert.ok(residue[0].deleted_at, "and it carries the timestamp that says so");
  } finally {
    db.close();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   UX-12/13 — the panel the owner accepted: one compact checklist, every verb
   ═══════════════════════════════════════════════════════════════════════════ */

test("UX-12 the columns panel is ONE compact checklist with every column in it exactly once", async () => {
  const panel = await read(PANEL);
  const code = codeOnly(panel);

  /*
   * ONE MAP, so a column cannot be drawn twice.
   *
   * The panel's first version split the columns into Shown and Hidden and drew
   * two lists. That is the obvious design and the wrong one: toggling a column
   * moved it to the other side of the panel, so the thing under the pointer
   * jumped away and had to be found again to undo the press — and it made "is
   * this column on the table?" a question about which list the reader happened
   * to be looking at, which on the live contractors register was twenty-five
   * entries down one side and none down the other.
   */
  assert.equal(
    (code.match(/columns\.map\(/g) ?? []).length,
    1,
    "every column is rendered from one map over the whole list",
  );
  assert.equal((code.match(/<ul/g) ?? []).length, 1, "and there is one list, not one per kind");
  assert.doesNotMatch(code, /<h4>/, "no Shown / Hidden headings");
  assert.doesNotMatch(code, /Nothing is hidden|Nothing is on the table/, "and no empty state for a list that is gone");

  // THE TICK IS THE VISIBILITY, read straight off the server's answer. Nothing
  // in this component remembers what is hidden.
  assert.match(code, /type="checkbox"/);
  assert.match(code, /checked=\{!column\.hidden\}/, "checked means on the register");
  assert.match(code, /onSetHidden\(column, !event\.target\.checked\)/);
  assert.doesNotMatch(code, /useState|useEffect|fetch\(/, "the panel still stores nothing");

  /*
   * AND THE TOOLTIP ON THAT TICK DESCRIBES THE PRESS THE PRODUCT ACTUALLY
   * MAKES. It read "Hiding it will unpin it." — the contract of the server that
   * shipped before `frozenRegisterColumn` learnt that visibility beats pinning.
   * `PATCH /api/registers` now LEAVES the pin alone when it hides (the round
   * trip is in `workstream-five-six-register-columns.test.mjs`), so that
   * promise was false on the one control the owner's defect report was about:
   * untick Contractor, tick it again, and the frozen lane comes back exactly
   * where it was. A label describing behaviour the product no longer has is
   * worse than no label, because a reader who believes it will not try the
   * press. Pinned here so the string cannot drift back.
   */
  assert.doesNotMatch(
    code,
    /Hiding it will unpin it/,
    "the tick must not promise an unpin the server no longer performs",
  );
  assert.match(
    code,
    /is pinned\. Hiding it takes it off the register and keeps the pin; showing it again brings it back pinned\./,
    "it says the press is reversible, which is what hiding a pinned column now is",
  );
  assert.doesNotMatch(
    code,
    /frozen lane/,
    "and says it without naming a lane, because Sites shares this panel and has none",
  );

  /*
   * COMPACT AND MULTI-COLUMN, AND IT WRAPS RATHER THAN CLIPS.
   *
   * `minmax(min(100%, …), 1fr)` is the whole responsive rule: wide gives five
   * or six across, narrow gives fewer, and a container narrower than one item
   * gives exactly one. The `min(100%, …)` is what makes that last case wrap
   * instead of forcing a track wider than the panel and pushing the grid out
   * through the side of the page. A single full-width vertical list — forty
   * site columns down one column — is what this refuses.
   */
  assert.match(
    panel,
    /repeat\(auto-fill, minmax\(min\(100%, \d+px\), 1fr\)\)/,
    "the checklist is an auto-filling grid, not a single column",
  );
  assert.doesNotMatch(
    panel,
    /@media/,
    "it breaks at no width, so it cannot disagree with the five the stylesheets may use",
  );

  /*
   * BUILT IN MARKS A NATIVE COLUMN and says the one thing about a column a
   * reader cannot get from its name: where the value lives, and therefore why
   * this one can be hidden but never deleted.
   */
  assert.match(code, /\{column\.native \? \(/);
  assert.match(code, /register-columns-panel__badge">Built in</);
});

test("UX-12 every register verb is reachable per column from the panel, and Remove is custom-only", async () => {
  const panel = await read(PANEL);
  const code = codeOnly(panel);

  /*
   * THE PANEL IS THE ONLY WAY IN FOR A HIDDEN COLUMN. The header menu is
   * reachable only from a column that is ON the table, so without these a
   * hidden column could be shown and nothing else — no rename, no move, no
   * width — until it had been shown, adjusted and hidden again.
   */
  for (const label of ["Move earlier", "Move later", "Rename", "Wider", "Narrower", "Remove"]) {
    assert.match(code, new RegExp(`^\\s*${label}\\s*$`, "m"), `the menu offers ${label}`);
  }

  // Each verb draws a control only when the host wired it, so a register that
  // has not adopted one shows nothing rather than a button that does nothing.
  for (const prop of ["onMove", "onRename", "onResize", "onPin"]) {
    assert.match(code, new RegExp(`\\{${prop} \\? \\(`), `${prop} gates its own control`);
  }

  /*
   * PIN SAYS WHICH WAY IT WILL GO, in the label and in the accessible name.
   * "Pin" on an already-pinned column would be a control named for the state
   * rather than for the action, and a screen reader user has no strip of frozen
   * colour to read the state from.
   */
  /*
   * RE-POINTED FROM `column.pinned` TO `pinnedHere`, and the contract this
   * protects got STRICTER rather than looser.
   *
   * The rule stated just above is that the control is named for the ACTION,
   * never for the state. Reading the stored flag alone broke that rule on the
   * register the owner actually has: nobody there has ever pressed Pin, so
   * every column reports `pinned: false` — including the one visibly sitting
   * in the frozen lane, because the grid falls back to freezing the identity
   * column. The button therefore read "Pin" on an already-pinned column, which
   * is the exact thing this test exists to forbid, and turning the lane off
   * took two presses: one to make the implicit state explicit, another to
   * reverse it.
   *
   * `pinnedHere` is "pinned as the reader can see it" rather than only as the
   * row records it. The two assertions below are unchanged.
   */
  assert.match(code, /\{pinnedHere \? "Unpin" : "Pin"\}/);
  assert.match(
    code,
    /const pinnedHere =[\s\S]{0,120}?column\.key === frozenKey\);/,
    "and the effective state is derived once rather than re-computed per control",
  );
  assert.match(code, /Unpin \$\{column\.title\} from the left of the register/);
  assert.match(code, /Pin \$\{column\.title\} to the left of the register/);

  /*
   * REMOVE IS ABSENT ON A NATIVE COLUMN rather than refused. The header menu
   * offers Delete on a native column deliberately, so the server's instruction
   * — "Native columns cannot be deleted. Hide it instead." — is read at the
   * moment somebody tries; here the tick that does exactly that is two
   * centimetres to the left, so a refusal would teach nothing.
   */
  assert.match(code, /\{onRemove && !column\.native \? \(/, "Remove is offered on custom columns only");

  /*
   * AND A CUSTOM COLUMN IS IN THE SAME GRID. There is no second list for the
   * ones somebody added — that was the shape this panel replaced, and it made
   * the register's own columns and the operator's columns look like two
   * different kinds of thing when the only difference is where the value lives.
   */
  assert.equal(
    (code.match(/columns\.map\(/g) ?? []).length,
    1,
    "custom columns come out of the same map as the built-in ones",
  );

  // Every control is named for its column. Forty buttons called "Rename" is a
  // menu a screen reader cannot navigate.
  for (const name of ["Move ${column.title} earlier", "Rename ${column.title}", "Make ${column.title} wider"]) {
    assert.ok(code.includes(name), `${name} must be the accessible name`);
  }
});

test("UX-13 the Columns button is what opens the panel, on both registers", async () => {
  /*
   * REQUIREMENT 21. The checklist is behind a control rather than always on
   * screen: it is forty rows on the sites register, and a settings panel parked
   * permanently above a table is a table that starts below the fold. The
   * control has to say whether it is open — `aria-expanded` — or a keyboard
   * user presses it and is told nothing happened.
   */
  for (const [name, path] of [
    ["the Contractors register", GRID],
    ["the Sites register", SITES_GRID],
  ]) {
    const source = await read(path);
    const at = source.search(/\n\s*Columns\n/);
    assert.ok(at > 0, `${name} has a Columns control`);

    const before = source.slice(Math.max(0, at - 800), at);
    const expanded = before.match(/aria-expanded=\{(\w+)\}/);
    assert.ok(expanded, `${name}'s Columns control says whether it is expanded`);

    const flag = expanded[1];
    assert.match(
      codeOnly(source),
      new RegExp(`\\{${flag} &&`),
      `${name} mounts the panel behind the same flag the button reports`,
    );
    assert.match(
      source,
      new RegExp(`\\[${flag}, set\\w+\\] = useState\\(false\\)`),
      `${name}'s panel starts closed`,
    );
  }
});

test("UX-14 one order drives the headers and the cells, so a move takes the column with it", async () => {
  const sites = await read(SITES_GRID);
  const code = codeOnly(sites);

  /*
   * THE SAME ARRAY, TWICE. The header row and every body row map `shown`, so a
   * reorder cannot move a header without moving the cells under it — the
   * failure that would put a postcode under a column headed "City" and look
   * like corrupted data rather than like a rendering bug.
   */
  assert.equal(
    (code.match(/\{shown\.map\(/g) ?? []).length,
    2,
    "the headers and the cells come from one ordered list",
  );

  /*
   * AND THE ORDER IS THE SERVER'S. There is no local layout and no
   * `localStorage` key: position, width, label and hidden all live in
   * `register_columns`, so a reload — or the same person on a second device —
   * sees the register as it was configured. This is the whole of "persists
   * across reload".
   */
  assert.doesNotMatch(code, /localStorage/, "the layout is not remembered by the browser");
  assert.match(code, /const next = await fetchRegister\(register\);/);
  assert.match(code, /setReloadToken\(\(token\) => token \+ 1\);/, "a write is followed by a re-read");

  /*
   * A PINNED COLUMN LEADS THE TABLE, and nothing is written to put it there.
   * `column.position` is untouched, so unpinning puts the column straight back
   * where the operator had it rather than leaving it stranded at the front with
   * no record of where it came from.
   */
  assert.match(code, /const pinned = visible\.filter\(\(column\) => column\.pinned\);/);
  assert.match(code, /\[\.\.\.pinned, \.\.\.visible\.filter\(\(column\) => !column\.pinned\)\]/);
});

test("UX-14 a reorder from the panel moves the column and survives a reload", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  /*
   * ON A COLUMN THIS FILE CREATED. A reorder renumbers every position on the
   * register, so the assertion has to be about where THIS column landed rather
   * than about the whole order — the shared development register is somebody
   * else's screen and they may be dragging it at the same time.
   */
  const added = await call("POST", "/api/registers", {
    register: "contractors",
    title: `${RUN} ZZQA-PANEL-order`,
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const column = added.body.column;
  createdColumnIds.push(column.id);

  // The panel's Move sends the WHOLE order, built from the full column list —
  // hidden columns included, so dropping next to a hidden one does not silently
  // reshuffle the columns nobody can see.
  let snapshot = await call("GET", "/api/registers?register=contractors");
  const keys = snapshot.body.columns.map((entry) => entry.key);
  const without = keys.filter((key) => key !== column.key);
  const target = 2;
  without.splice(target, 0, column.key);

  const moved = await call("PATCH", "/api/registers", {
    register: "contractors",
    order: without,
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));

  // A SECOND GET IS WHAT A RELOADED PAGE DOES. The order is a row, not a
  // browser's memory of one.
  snapshot = await call("GET", "/api/registers?register=contractors");
  const seen = snapshot.body.columns.find((entry) => entry.id === column.id);
  assert.equal(seen.position, target, "the column is where it was dropped, after a reload");

  // Positions stay dense and unique, which is what stops two columns sharing a
  // slot and being ordered by a tiebreaker that differs between SQLite and
  // Postgres.
  const positions = snapshot.body.columns.map((entry) => entry.position);
  assert.deepEqual(
    positions,
    positions.map((_, index) => index),
    "0..n-1 with no gaps and no duplicates",
  );

  // The other panel verbs answer on the same column, which is what "the panel
  // uses the same data model" has to mean in practice.
  assert.equal(
    (await call("PATCH", "/api/registers", { id: column.id, title: `${RUN} ZZQA-PANEL-renamed` }))
      .status,
    200,
    "rename",
  );
  assert.equal(
    (await call("PATCH", "/api/registers", { id: column.id, width: 260 })).status,
    200,
    "resize",
  );
  snapshot = await call("GET", "/api/registers?register=contractors");
  const after = snapshot.body.columns.find((entry) => entry.id === column.id);
  assert.equal(after.title, `${RUN} ZZQA-PANEL-renamed`);
  assert.equal(after.width, 260);

  // And the custom-column remove the panel offers is the soft one.
  const removed = await call("DELETE", `/api/registers?id=${encodeURIComponent(column.id)}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  snapshot = await call("GET", "/api/registers?register=contractors");
  assert.equal(
    snapshot.body.columns.find((entry) => entry.id === column.id),
    undefined,
    "a removed column leaves the register",
  );
});

test("UX-12 both registers wire every column verb into the one panel", async () => {
  /*
   * REQUIREMENT 18 — the Sites register gets the identical panel, and the
   * identity is the COMPONENT rather than a shape two screens agree on. That is
   * settled by `UX-2 one columns panel component serves both registers`. This
   * test holds the other half: the panel makes every verb but show/hide
   * optional, so a host that mounts it and passes only `onSetHidden` gets a
   * checklist and nothing else — the same component, a different register.
   *
   * The props are asserted by NAME rather than by what they are bound to,
   * because each host already owns handlers of the right shapes (`move(column,
   * delta)`, `rename(column)`) and the wiring is meant to be the function
   * rather than an adapter around it.
   */
  for (const [name, path] of [
    ["the Contractors register", GRID],
    ["the Sites register", SITES_GRID],
  ]) {
    const source = await read(path);
    const mount = source.slice(source.indexOf("<RegisterColumnsPanel"));
    const props = mount.slice(0, mount.indexOf("/>"));
    for (const prop of ["columns", "busy", "onSetHidden", "onMove", "onRename", "onResize", "onPin", "onRemove"]) {
      assert.match(
        props,
        new RegExp(`\\b${prop}=`),
        `${name} must pass ${prop} to the panel — the panel draws no control for a verb nobody wired`,
      );
    }
  }
});
