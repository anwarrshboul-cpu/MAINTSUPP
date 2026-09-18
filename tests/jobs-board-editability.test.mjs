/**
 * Jobs board — Approved by, Store Location Name, and the date/timeline cells.
 *
 * THREE THINGS WERE BROKEN, and they had one shape in common: a cell that drew
 * a list it had built for itself instead of the list the product already had.
 *
 *   · APPROVED BY was an `OptionCell` fed by `assigneeOptions`, which derives
 *     its values from `row.assignee` — the ASSIGNEE, not the approver. So the
 *     column offered the wrong people, and on an estate with nothing assigned
 *     it offered nobody at all. This is verbatim the bug `assignee-directory.ts`
 *     records fixing for Assigned To; Approved by was simply left behind.
 *
 *   · STORE LOCATION NAME was an `OptionCell` whose options were
 *     `request.location ? [{ value: request.location }] : []` — a list of one
 *     entry, the cell's own current value. A store could therefore never be
 *     changed from the board, and every chip drew in `groupColors[0]` while the
 *     column footer drew the real per-site palette. `/api/board` had been
 *     building proper options from the site register the whole time.
 *
 *   · THE TIMELINE STRIP rendered from `draftStart`/`draftEnd`, which
 *     `useState` seeds once. Its start IS Date Requested and its end IS Due
 *     Date — both edited in other cells on the same row — so changing either
 *     left the strip showing a stale range until the timeline's own editor was
 *     opened, which is what re-seeded the drafts.
 *
 * Source pins, because each of these is a decision about WHERE a list comes
 * from, and a passing request cannot demonstrate the difference between the
 * right list and a lucky one. The live half at the bottom drives a running
 * server and skips when nothing answers, in this suite's usual way.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { storeLocationChoices } from "../app/(app)/portal/board-store-location.ts";

/*
 * `dateOnlyValue` is not imported: its module reaches `./format-date` without a
 * file extension, which Node's ESM resolver will not follow from a test. Its
 * contract is pinned at source below, and the LIVE half round-trips real days
 * through the server, which is the proof that actually matters here.
 */
function dateOnlyValue(value) {
  if (!value) return "";
  const trimmed = String(value).trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
        ? parsed.date
        : "";
    } catch {
      return "";
    }
  }
  const date = trimmed.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER_EMAIL = "owner@maintsupp.com";
const OWNER_PASSWORD = process.env.MAINTSUPP_OWNER_PASSWORD ?? "Sunnamusk-Owner-2026";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

/** The same file with its comments removed — see owner-part-five-assignee-picker. */
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The body of one `case "<key>":` in the board's cell switch. */
function boardCase(board, key) {
  const start = board.indexOf(`case "${key}":`);
  assert.notEqual(start, -1, `the board must still render a ${key} cell`);
  const next = board.indexOf("      case \"", start + 10);
  return board.slice(start, next === -1 ? board.length : next);
}

/* ------------------------------------------------------------------ */
/* 1. Approved by is a person, chosen from the workspace               */
/* ------------------------------------------------------------------ */

test("Approved by picks from the roster, not from the board's own assignee values", async () => {
  const board = codeOnly(await source("app/(app)/portal/live-board.tsx"));
  const cell = boardCase(board, "approvedBy");
  assert.match(cell, /<AssigneeCell/, "Approved by must render the person picker");
  assert.doesNotMatch(
    cell,
    /options=\{assigneeOptions\}/,
    "that list is derived from row.assignee — the wrong people, and none at all on an empty estate",
  );
  assert.match(cell, /assigneeUserId=\{request\.approvedByUserId \?\? null\}/);
  assert.match(
    cell,
    /approvedByUserId: change\.assigneeUserId/,
    "the name and the account are written as one change, as Assigned To is",
  );
  // The empty row is worded for an approval rather than an assignment.
  assert.match(cell, /emptyLabel="Not approved"/);
});

test("the picker's wording is a prop, so one component serves both columns", async () => {
  const cell = codeOnly(await source("app/(app)/portal/assignee-cell.tsx"));
  assert.match(cell, /emptyLabel = "Unassigned"/, "Assigned To keeps its own wording by default");
  assert.match(cell, /clearLabel = "Clear the assignment"/);
  // The pinned contract of the original picker is untouched by the sharing.
  assert.match(cell, /onChange\(\{ assignee: nextName, assigneeUserId: nextId \}\)/);
});

test("the approver's id is resolved server-side, through the same tenancy predicate", async () => {
  const reference = codeOnly(await source("app/lib/assignee-reference.ts"));
  assert.match(reference, /export async function approvedByLinkValues/);
  assert.match(
    reference,
    /personLinkValues\(db, orgId, fields, "approvedBy", "approvedByUserId"\)/,
    "the approver must go through the SAME resolver as the assignee, not a copy of it",
  );
  // One membership predicate, written once, covering both pairs.
  assert.equal(
    (reference.match(/eq\(memberships\.organisationId, orgId\)/g) ?? []).length,
    1,
    "a second copy of the org filter is a second chance to get it wrong",
  );

  const route = codeOnly(await source("app/api/maintenance/route.ts"));
  assert.match(route, /approvedByLinkValues\(db, orgId, fields\)/);
  assert.match(
    route,
    /if \(!approvedByLink\.ok\) \{\s*return Response\.json\(\{ error: approvedByLink\.reason \}, \{ status: 404 \}\);/,
    "an id naming nobody in this organisation is REFUSED, never silently dropped",
  );
});

test("a name-only write cannot leave the previous approver's account linked", async () => {
  const fields = codeOnly(await source("app/lib/request-fields.ts"));
  const block = fields.slice(
    fields.indexOf('typeof fields.approvedBy === "string"'),
    fields.indexOf('typeof fields.approvedBy === "string"') + 300,
  );
  assert.match(block, /values\.approvedByUserId = null;/, "the same rule `assignee` follows");
});

test("the column is additive: a new nullable column and a moved fingerprint", async () => {
  const init = await source("db/init.ts");
  assert.match(
    init,
    /addColumn\(d1, "maintenance_requests", "approved_by_user_id", "TEXT"\)/,
  );
  assert.doesNotMatch(init, /DROP COLUMN approved_by|ALTER COLUMN approved_by\b/i);
  const schema = await source("db/schema.ts");
  assert.match(schema, /approvedByUserId: text\("approved_by_user_id"\)/);
  assert.doesNotMatch(
    schema,
    /approvedByUserId: text\("approved_by_user_id"\)\.notNull\(\)/,
    "a not-null column would fail on every existing row",
  );
});

/* ------------------------------------------------------------------ */
/* 2. Store Location Name is the site register                         */
/* ------------------------------------------------------------------ */

test("the Store Location cell offers the workspace's stores, not its own value", async () => {
  const board = codeOnly(await source("app/(app)/portal/live-board.tsx"));
  const cell = boardCase(board, "storeLocation");
  assert.match(cell, /options=\{optionSets\.storeLocation\}/);
  assert.doesNotMatch(
    cell,
    /\[\{ value: request\.location, color: groupColors\[0\] \}\]/,
    "a one-entry list of the cell's own value is not a picker",
  );
  assert.match(cell, /editableColumn="storeLocation"/, "the labels are editable");
  assert.match(cell, /onUpdateOption=\{onUpdateOption\}/);
  // A shop is created and retired in the register, never from a board cell.
  assert.doesNotMatch(cell, /onCreateOption=|onDeleteOption=/);
});

test("renaming a store location renames the site, under sites.edit", async () => {
  const route = codeOnly(await source("app/api/board/route.ts"));
  const block = route.slice(
    route.indexOf('action === "update_option"'),
    route.indexOf('action === "delete_option"'),
  );
  assert.match(block, /optionId\.startsWith\("site-option-"\)/);
  assert.match(
    block,
    /requireCapability\(subject, "sites\.edit"\)/,
    "board.edit is not permission to rename the client's shops",
  );
  assert.match(block, /\.update\(sites\)/);
  assert.match(
    block,
    /eq\(sites\.organisationId, orgId\)/,
    "the org filter, on the site write as on every other",
  );
  // Rows already filed under the old spelling follow the rename.
  assert.match(block, /eq\(maintenanceRequests\.location, previousName\)/);
});

test("the option id is the site's, so a rename cannot break the rows using it", async () => {
  const route = await source("app/api/board/route.ts");
  assert.match(route, /id: `site-option-\$\{site\.id\}`/);
  const writes = await source("app/(app)/portal/board-option-writes.ts");
  assert.match(
    writes,
    /option\.id === updated\.id \? updated : option/,
    "the list is reconciled on the id the server answered with",
  );
});

test("the picker is the register plus whatever the board already uses", () => {
  const siteOptions = [
    { value: "Meadowbank", color: "#037f4c", id: "site-option-1" },
    { value: "Harbour Point", color: "#579bfc", id: "site-option-2" },
  ];
  const rows = [
    { location: "Meadowbank" }, // already a site — not duplicated
    { location: "Loading bay" }, // an area, which no register names
    { location: "Back of house" },
    { location: "  " }, // blank is not a value
    { location: null },
    { location: "Loading bay" }, // seen twice, offered once
  ];
  const choices = storeLocationChoices(siteOptions, rows, ["#a", "#b"]);
  assert.deepEqual(
    choices.map((option) => option.value),
    ["Meadowbank", "Harbour Point", "Back of house", "Loading bay"],
    "the register keeps its own order; the extras are alphabetical after it",
  );
  // The register's entries keep their site id, so they stay renameable...
  assert.equal(choices[0].id, "site-option-1");
  // ...and the free-text ones carry none, which is what disables the editor.
  assert.equal(choices[3].id, undefined);
  // The colour is the VALUE's, not the row order's: filtering a row out must
  // not repaint the chips that remain.
  const palette = ["#a", "#b", "#c"];
  const one = storeLocationChoices([], rows, palette);
  const fewer = storeLocationChoices([], [{ location: "Loading bay" }], palette);
  assert.equal(
    one.find((option) => option.value === "Loading bay").color,
    fewer.find((option) => option.value === "Loading bay").color,
    "the same area keeps its colour however many rows are on screen",
  );
  assert.ok(palette.includes(choices[2].color), "extras are coloured from the palette");

  // An estate with no retail sites still gets a usable picker.
  assert.deepEqual(
    storeLocationChoices([], [{ location: "Whole site" }], ["#a"]).map((o) => o.value),
    ["Whole site"],
  );
  assert.deepEqual(storeLocationChoices([], [], ["#a"]), []);
});

test("a workspace's own site types reach the location picker", async () => {
  /*
   * THE SECOND HALF OF THE SAME BUG, found while wiring the picker up.
   *
   * `listRetailSites` allowed exactly `["Inline", "Kiosk"]` — the two types the
   * first client's register used — while site types are configured per
   * workspace. The demonstration estate is a Flagship, three Stores, two Kiosks
   * and a Warehouse, so its Location picker offered two of its eight sites and
   * said nothing about the other six. The rule was always "not the office, not
   * the warehouse"; it is written that way now.
   */
  const repository = await source("app/lib/sites-repository.ts");
  assert.match(repository, /const NON_RETAIL_SITE_TYPES = new Set\(\["office", "warehouse"\]\)/);
  assert.doesNotMatch(
    codeOnly(repository),
    /\["Inline", "Kiosk"\]/,
    "one client's vocabulary must not stand in for the rule",
  );
  // Case and padding come from a per-workspace option set, not from this file.
  const guard = repository.slice(repository.indexOf("function isRetailSiteType"));
  assert.match(guard.slice(0, 300), /\.trim\(\)\.toLowerCase\(\)/);
  // And an unclassified row is still never offered.
  assert.match(guard.slice(0, 300), /type\.length > 0/);
});

test("one list feeds the cells and the column footer", async () => {
  const summary = codeOnly(await source("app/(app)/portal/board-column-summary.tsx"));
  const block = summary.slice(summary.indexOf('key === "storeLocation"'));
  assert.match(
    block.slice(0, 600),
    /options=\{optionSets\.storeLocation\}/,
    "the footer must not rebuild its own list — that is how it came to disagree with the cells",
  );
  assert.doesNotMatch(
    block.slice(0, 600),
    /groupColors\[index % groupColors\.length\]/,
    "no second palette for the same column",
  );
});

test("lifecycle verbs are drawn only where they work", async () => {
  const cells = codeOnly(await source("app/(app)/portal/board-cells.tsx"));
  assert.match(
    cells,
    /\{onDeleteOption && \(/,
    "deactivate and delete are the chip store's verbs and are hidden without a handler",
  );
  assert.match(cells, /\{onCreateOption && \(/);
});

/* ------------------------------------------------------------------ */
/* 3. Dates and the timeline                                           */
/* ------------------------------------------------------------------ */

test("the timeline strip is derived from the saved dates, never from the draft", async () => {
  const cells = codeOnly(await source("app/(app)/portal/board-cells.tsx"));
  const block = cells.slice(cells.indexOf("export function TimelineCell"));
  assert.match(block, /const savedStart = dateInputValue\(start\);/);
  assert.match(block, /const savedEnd = dateInputValue\(end\);/);
  assert.match(
    block,
    /savedStart && savedEnd\s*\?\s*`\$\{savedStart\.slice\(5\)\} → \$\{savedEnd\.slice\(5\)\}`/,
    "the label must read the props; a draft-derived label cannot see Date Requested change",
  );
  const label = block.slice(block.indexOf("const label ="), block.indexOf("const saveTimeline"));
  assert.doesNotMatch(label, /draftStart|draftEnd/, "no draft state in the strip's label");
});

test("the timeline's start and end are the same fields the two date cells edit", async () => {
  const board = codeOnly(await source("app/(app)/portal/live-board.tsx"));
  const cell = boardCase(board, "timeline");
  assert.match(cell, /start=\{request\.requestedAt\}/);
  assert.match(cell, /end=\{request\.dueAt\}/);
  // Which is exactly why a stale strip was possible: `requested` writes the
  // same column, from a different cell.
  assert.match(boardCase(board, "requested"), /value=\{request\.requestedAt\}/);
});

test("the date helpers slice, and never parse a calendar day into an instant", async () => {
  /*
   * THE ONE-DAY SHIFT, PINNED AT ITS CAUSE.
   *
   * A calendar day is not an instant. The moment `YYYY-MM-DD` goes through
   * `new Date(...).toISOString()`, the answer depends on the reader's zone,
   * and "2026-09-04" chosen in London comes back as the 3rd. `dateOnlyValue`
   * takes the first ten characters and `boardDateValue` emits them unchanged,
   * so no zone is ever consulted. Measured on Staging: the session TimeZone is
   * UTC and '2026-09-04'::timestamptz reads back as 2026-09-04.
   */
  const expiry = await source("app/lib/expiry-status.ts");
  const helper = expiry.slice(expiry.indexOf("export function dateOnlyValue"));
  const body = helper.slice(0, helper.indexOf(String.fromCharCode(10) + "}"));
  assert.match(body, /trimmed\.slice\(0, 10\)/, "the day is sliced out, not parsed");
  assert.doesNotMatch(body, /new Date\(/, "a Date here is a timezone bug waiting to happen");

  const format = await source("app/(app)/portal/board-format.ts");
  const emit = format.slice(format.indexOf("export function boardDateValue"));
  assert.doesNotMatch(
    emit.slice(0, emit.indexOf(String.fromCharCode(10) + "}")),
    /new Date\(|toISOString/,
    "a day with no time is emitted as the bare day",
  );

  for (const day of ["2026-09-04", "2026-01-01", "2026-12-31", "2026-02-29", "2027-03-01"]) {
    assert.equal(dateOnlyValue(day), day);
    assert.equal(dateOnlyValue(`${day}T00:00:00.000Z`), day);
    assert.equal(dateOnlyValue(`${day}T23:30:00.000Z`), day);
    assert.equal(dateOnlyValue(JSON.stringify({ date: day, time: "09:00" })), day);
  }
  assert.equal(dateOnlyValue(null), "");
  assert.equal(dateOnlyValue("not a date"), "");
});

test("Date Requested may move freely; only clearing it is refused", async () => {
  const board = codeOnly(await source("app/(app)/portal/live-board.tsx"));
  const cell = boardCase(board, "requested");
  // `clearable={false}` is the ONLY restriction, and it exists because the
  // timeline's start is this field. No past/future bound is imposed anywhere.
  assert.match(cell, /clearable=\{false\}/);
  assert.doesNotMatch(cell, /min=|max=|todayBoardDate\(\)/, "no floor or ceiling on the day chosen");
  const completed = boardCase(board, "completed");
  assert.doesNotMatch(completed, /min=|max=/, "Date Completed is unbounded too");
  assert.doesNotMatch(
    completed,
    /todayBoardDate\(\)/,
    "a later edit must not be snapped to today",
  );
});

/* ------------------------------------------------------------------ */
/* 4. Styling — the brand, and only through tokens                     */
/* ------------------------------------------------------------------ */

test("a dated timeline wears the brand; an empty one stays the neutral chip", async () => {
  const css = await source("app/globals.css");
  assert.match(css, /--chip-dated-bg: var\(--brand-wash\);/, "light: the teal wash");
  assert.match(css, /--chip-dated-fg: var\(--navy-700\);/, "light: navy on it");
  assert.match(css, /--chip-dated-bg: var\(--navy-800\);/, "dark: the navy surface");
  assert.match(css, /--chip-dated-fg: var\(--brand-fg\);/, "dark: the brighter teal on it");

  const rule = /\.sheet-timeline > button\[data-state="set"\]\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  assert.ok(rule, "the dated state must have its own rule");
  assert.match(rule, /background: var\(--chip-dated-bg\)/);
  assert.match(rule, /--control-own-fg: var\(--chip-dated-fg\)/, "or the dark blanket repaints it");
  assert.doesNotMatch(rule, /#[0-9a-f]{3,8}/i, "tokens only — no hex in the rule");

  const strip = /\.sheet-timeline > button \{[^}]*\}/.exec(css)?.[0] ?? "";
  assert.match(strip, /background: var\(--chip-neutral-bg\)/, "the empty strip keeps the neutral chip");
});

test("the date cell reads as a value and opens a branded picker", async () => {
  const css = await source("app/globals.css");
  const rule = /\.sheet-date-input \{[^}]*\}/.exec(css)?.[0] ?? "";
  assert.match(rule, /color: var\(--ink\)/, "the date is the cell's value, not a hint");
  assert.doesNotMatch(rule, /color: var\(--muted\)/);
  assert.match(
    rule,
    /accent-color: var\(--brand-fill\)/,
    "the native calendar follows the brand rather than the system blue",
  );
  // The hint under it is the thing that stays quiet.
  const hint = /\.sheet-date__relative\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  assert.match(hint, /color: var\(--muted\)/);
});

test("the strip says whether it is set, so the CSS never has to guess", async () => {
  const tooltip = codeOnly(await source("app/(app)/portal/timeline-tooltip.tsx"));
  assert.match(tooltip, /data-state=\{start \|\| end \? "set" : "empty"\}/);
});

/* ------------------------------------------------------------------ */
/* 5. Live — the same three things against a running server            */
/* ------------------------------------------------------------------ */

async function signIn() {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  if (!response.ok) return null;
  const cookie = response.headers.get("set-cookie");
  return cookie ? cookie.split(";")[0] : null;
}

/**
 * A location this workspace will accept.
 *
 * `POST /api/maintenance` refuses a site the client workspace does not have
 * ("Choose a site from this client workspace"), and which sites exist differs
 * per estate — so the fixture asks rather than assuming. Falls back to a value
 * already in use on the board, which is by definition acceptable.
 */
async function aValidLocation(cookie) {
  const board = await fetch(`${BASE_URL}/api/board`, { headers: { cookie } });
  const payload = await board.json();
  const fromOptions = (payload.options ?? []).find(
    (option) => option.columnKey === "storeLocation",
  );
  if (fromOptions?.value) return { location: fromOptions.value, siteId: null };

  /*
   * Nothing offered, so the fixture brings its own shop.
   *
   * `POST /api/maintenance` resolves the location against the SITE REGISTER and
   * refuses a name it does not hold, and a freshly migrated estate holds no
   * sites at all — reusing a location off an existing row is not enough,
   * because those rows predate the register. The site is created here and
   * removed in the caller's `finally`, so the estate is as it was found.
   */
  const name = `QA Location Fixture ${Date.now()}`;
  const made = await fetch(`${BASE_URL}/api/sites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      data: { name, addressLine1: "1 Example Street", type: "Kiosk", status: "active" },
    }),
  });
  if (!made.ok) return { location: "", siteId: null };
  const site = (await made.json()).site ?? {};
  return { location: site.name ?? name, siteId: site.id ?? null };
}

/**
 * Removes a site the fixture created. A no-op when it reused a real one.
 *
 * The id goes in the BODY — `DELETE /api/sites` reads `{ id }` from JSON, not
 * from the query string, and a query-string call is answered "A site ID is
 * required" with a 400 that a fixture would never notice. It was not noticed:
 * an earlier run of this file left its site behind on the local estate.
 */
async function dropSite(cookie, siteId) {
  if (!siteId) return;
  await fetch(`${BASE_URL}/api/sites`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ id: siteId }),
  });
}

async function reachable() {
  try {
    const response = await fetch(`${BASE_URL}/api/context`, {
      signal: AbortSignal.timeout(4000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

test("live: the approver is a member, and an outsider's id is refused", async (t) => {
  if (!(await reachable())) return t.skip("no dev server on " + BASE_URL);
  const cookie = await signIn();
  if (!cookie) return t.skip("could not sign in");

  const members = await fetch(`${BASE_URL}/api/board/members`, { headers: { cookie } });
  assert.equal(members.status, 200, "the roster the picker draws from");
  const roster = (await members.json()).members ?? [];
  assert.ok(roster.length > 0, "a workspace with people in it");

  const place = await aValidLocation(cookie);
  const created = await fetch(`${BASE_URL}/api/maintenance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      description: "QA — approved-by round trip",
      location: place.location,
      requester: "QA",
      contact: "07000000000",
    }),
  });
  const createdBody = await created.text();
  assert.equal(created.status, 201, createdBody);
  const id = JSON.parse(createdBody).request.id;

  try {
    // An id that names nobody here is refused, not silently dropped.
    const refused = await fetch(`${BASE_URL}/api/maintenance`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ id, fields: { approvedByUserId: "user-not-in-this-workspace" } }),
    });
    assert.equal(refused.status, 404, "an outsider's id must be refused");

    // A real member: the NAME is derived from the roster, not from the caller.
    const person = roster[0];
    const saved = await fetch(`${BASE_URL}/api/maintenance`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        id,
        fields: { approvedByUserId: person.id, approvedBy: "Somebody Else Entirely" },
      }),
    });
    assert.equal(saved.status, 200, await saved.text());

    const after = await fetch(`${BASE_URL}/api/maintenance?limit=200`, { headers: { cookie } });
    const row = (await after.json()).requests.find((entry) => entry.id === id);
    assert.equal(row.approvedByUserId, person.id);
    assert.equal(
      row.approvedBy,
      person.name,
      "the display name is the roster's, never the one the caller sent alongside the id",
    );
  } finally {
    /*
     * `/api/maintenance` HAS NO DELETE. Removing a job is
     * `DELETE /api/board/items?id=…`, which archives it — evidence and history
     * are kept by design. A `?id=` call to the wrong route answered 405 and
     * this fixture never noticed, so three runs of it left their jobs on the
     * board; the tests still passed, which is exactly how litter accumulates.
     */
    await fetch(`${BASE_URL}/api/board/items?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { cookie },
    });
    await dropSite(cookie, place.siteId);
  }
});

test("live: every store option the board serves is a site, by id", async (t) => {
  if (!(await reachable())) return t.skip("no dev server on " + BASE_URL);
  const cookie = await signIn();
  if (!cookie) return t.skip("could not sign in");

  const board = await fetch(`${BASE_URL}/api/board`, { headers: { cookie } });
  assert.equal(board.status, 200);
  const payload = await board.json();
  const stores = (payload.options ?? []).filter(
    (option) => option.columnKey === "storeLocation",
  );
  /*
   * Zero is a legitimate answer — a workspace with no RETAIL sites has no
   * stores to offer, which is exactly why the picker cannot be the register
   * alone. What must hold is that anything the SERVER serves for this column
   * is a site: the chip store's own rows for it are deliberately ignored.
   */
  for (const store of stores) {
    assert.match(store.id, /^site-option-/, "a served store option is a site, by id");
    assert.ok(store.label, "and carries a label to draw");
  }

  // Whatever the register holds, the picker can still express every value the
  // board is actually using — which is the thing that was broken.
  const inUse = new Set(
    (payload.requests ?? [])
      .map((request) => (request.location ?? "").trim())
      .filter(Boolean),
  );
  const offered = new Set(
    storeLocationChoices(
      stores.map((store) => ({ value: store.value, color: store.colour ?? store.color })),
      payload.requests ?? [],
      ["#579bfc"],
    ).map((option) => option.value),
  );
  for (const value of inUse) {
    assert.ok(offered.has(value), `the picker must be able to express "${value}"`);
  }
});

test("live: a date moves earlier, later, across a month and across a year", async (t) => {
  if (!(await reachable())) return t.skip("no dev server on " + BASE_URL);
  const cookie = await signIn();
  if (!cookie) return t.skip("could not sign in");

  const place = await aValidLocation(cookie);
  const created = await fetch(`${BASE_URL}/api/maintenance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      description: "QA — date round trip",
      location: place.location,
      requester: "QA",
      contact: "07000000000",
    }),
  });
  const createdBody = await created.text();
  assert.equal(created.status, 201, createdBody);
  const id = JSON.parse(createdBody).request.id;

  const read = async () => {
    const response = await fetch(`${BASE_URL}/api/maintenance?limit=200`, { headers: { cookie } });
    return (await response.json()).requests.find((entry) => entry.id === id);
  };
  const set = async (fields) => {
    const response = await fetch(`${BASE_URL}/api/maintenance`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ id, fields }),
    });
    assert.equal(response.status, 200, await response.text());
  };

  try {
    /*
     * Backwards, forwards, over a month boundary and over a year boundary, then
     * back to the first day again — repeatedly, because "it saved once" and
     * "it can be edited again" are different claims and only the second was in
     * doubt. The day read back must be the day sent, to the character.
     */
    for (const day of [
      "2026-09-04",
      "2026-08-29", // earlier, and into the previous month
      "2026-10-03", // later, and into the next
      "2025-12-31", // back across a year boundary
      "2027-01-01", // forward across one
      "2026-09-04", // and home again
    ]) {
      await set({ requestedAt: day });
      assert.equal(dateOnlyValue((await read()).requestedAt), day, `requested -> ${day}`);
      await set({ completedAt: day });
      assert.equal(dateOnlyValue((await read()).completedAt), day, `completed -> ${day}`);
    }

    // The timeline's endpoints ARE those fields, so moving one moves the strip.
    await set({ requestedAt: "2026-09-01", dueAt: "2026-09-20" });
    let row = await read();
    assert.equal(dateOnlyValue(row.requestedAt), "2026-09-01");
    assert.equal(dateOnlyValue(row.dueAt), "2026-09-20");
    await set({ requestedAt: "2026-08-25" });
    row = await read();
    assert.equal(dateOnlyValue(row.requestedAt), "2026-08-25", "the strip's start follows");
    assert.equal(dateOnlyValue(row.dueAt), "2026-09-20", "and its end is left alone");

    // Date Completed is not snapped to today by a later edit.
    await set({ completedAt: "2026-08-26" });
    assert.equal(dateOnlyValue((await read()).completedAt), "2026-08-26");
  } finally {
    /*
     * `/api/maintenance` HAS NO DELETE. Removing a job is
     * `DELETE /api/board/items?id=…`, which archives it — evidence and history
     * are kept by design. A `?id=` call to the wrong route answered 405 and
     * this fixture never noticed, so three runs of it left their jobs on the
     * board; the tests still passed, which is exactly how litter accumulates.
     */
    await fetch(`${BASE_URL}/api/board/items?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { cookie },
    });
    await dropSite(cookie, place.siteId);
  }
});
