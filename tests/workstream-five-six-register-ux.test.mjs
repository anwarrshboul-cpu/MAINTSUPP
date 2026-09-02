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
  assert.match(panel, /import type \{ RegisterColumn \}/, "it takes the server's shape");

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

test("UX-1/UX-4 the two pinned lanes are structure, not columns, and cannot be hidden away", async () => {
  const grid = await read(GRID);
  const code = codeOnly(grid);

  // Each lane is rendered outside the `shown.map` that draws register columns:
  // the identity lane before it, the action lane after the extras.
  const headStart = code.indexOf('className="contractor-register__lane contractor-register__lane--start"');
  const columnsStart = code.indexOf("{shown.map((column: RegisterColumn, index: number) => (");
  assert.ok(headStart > 0 && columnsStart > headStart, "the identity header precedes the columns");

  assert.match(code, /contractor-register__lane--start/, "a start lane");
  assert.match(code, /contractor-register__lane--end/, "an end lane");

  /*
   * The lane's LABEL follows a rename of the `name` column, because renaming is
   * a verb the register promises and a lane that ignored it would be the one
   * column whose title could not be changed. Matched on `nativeField`, never on
   * position — the reader may have moved the column anywhere — and read
   * whether the column is shown or hidden, because a label belongs to a column
   * rather than to its visibility.
   */
  assert.match(
    code,
    /snap\.columns\.find\(\(column\) => column\.nativeField === "name"\)\?\.title \?\? "Contractor"/,
    "the identity lane takes its title from the name column when there is one",
  );

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

test("UX-1/UX-4 the lanes sit on a tier token and are opaque in both themes", async () => {
  const css = await read(GLOBALS);
  const lanes = css.slice(css.indexOf("---- The two pinned lanes"));
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

  // Both lanes carry a visible edge, and the dark theme drops the depth
  // shadow rather than painting black on near-black.
  assert.match(lanes, /\.contractor-register__lane--start \{\s*left: 0;/);
  assert.match(lanes, /\.contractor-register__lane--end \{\s*right: 0;/);
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
  const lanes = css.slice(css.indexOf("---- The two pinned lanes"));

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

test("UX-4 the details chevron is pinned at the right and the editor keeps its own way in", async () => {
  const grid = await read(GRID);
  const code = codeOnly(grid);

  const lane = code.slice(code.indexOf('data-label="Actions"'));
  const cell = lane.slice(0, lane.indexOf("</td>"));

  // The chevron OPENS the contractor — the visible twin of the row press —
  // and lives in the lane that never scrolls away.
  assert.match(cell, /aria-label=\{`Open \$\{row\.name\}`\}/, "named for what it does");
  assert.match(cell, /onOpen\(row\.id\)/, "and it opens rather than edits");

  /*
   * The pencil is the row's ONLY route to the ordinary editor, which is the
   * only place a native field can be written. Losing it would leave "Manage
   * contractors" in the page header — which opens with nobody selected — as
   * the way to edit one particular contractor.
   */
  assert.match(cell, /aria-label=\{`Edit \$\{row\.name\}`\}/);
  assert.match(cell, /onManage\(row\.id\)/);

  // Both stop the press reaching the row. Redundant with the guard above and
  // kept because it states the intent where a reader looks for it.
  assert.equal(
    (cell.match(/event\.stopPropagation\(\);/g) ?? []).length,
    2,
    "each action states that it is not a row press",
  );

  /*
   * The action lane's header is named in TEXT and not by `aria-label`: axe
   * flags an empty `<th>` (`empty-table-header`) because a header cell's
   * accessible name is what a screen reader announces on every cell beneath it.
   */
  assert.match(
    code,
    /<th scope="col" className="contractor-register__lane contractor-register__lane--end">\s*<span className="visually-hidden">Actions<\/span>/,
  );

  // The empty-state row spans the register's columns, the page's figures AND
  // the two lanes — a short colSpan leaves a stray bordered cell beside it.
  assert.match(code, /colSpan=\{shown\.length \+ extraColumns\.length \+ 2\}/);
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
  }));
  assert.equal(seeds.length, 25, `the catalogue still describes 25 fields, saw ${seeds.length}`);

  /*
   * ONE column on by default, and it is `availability`. The page draws six
   * figures beside the register that are not columns at all — assigned,
   * completed, completion rate, open urgent, documents, spend — and the grid
   * draws identity and contact in a pinned lane, so the default view is seven
   * lanes wide before a native column is on it. `availability` is the field
   * that decides who gets rung next, so it earns the eighth.
   */
  const visible = seeds.filter((seed) => !seed.hidden).map((seed) => seed.field);
  assert.deepEqual(visible, ["availability"], "only availability seeds onto the table");

  /*
   * `name` SEEDS HIDDEN, which reads like a mistake and is not: the pinned
   * identity lane prints the contractor's name on every row and cannot be
   * hidden, so a `name` column shown as well would print the same string twice.
   * It stays in the catalogue — it is the entry that stops `name` being usable
   * as a CUSTOM column key — and the Columns panel is one press away.
   */
  assert.ok(
    seeds.find((seed) => seed.field === "name")?.hidden,
    "the name column seeds hidden because the lane already prints it",
  );
  assert.match(catalogue, /AND `name` SEEDS HIDDEN, which reads like a mistake and is not/);

  /*
   * AND THIS CHANGES NOTHING FOR AN ORGANISATION THAT HAS ALREADY SEEDED.
   * `hidden` is read once, by `ensureRegisterColumns`, when a register is first
   * created; every workspace that exists keeps whatever its operators have
   * shown and hidden since. Said in the source, because a reader who thought
   * otherwise would expect this commit to undo somebody's configuration.
   */
  assert.match(catalogue, /WHAT `hidden` IS NOT\. It is a SEED, read once by `ensureRegisterColumns`/);
  const engine = await read("app/lib/register-columns.ts");
  assert.match(engine, /hiddenAt: seed\.hidden \? now : null,/, "the seed is applied on insert only");
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
