/**
 * WORKSTREAM 7, official checklist — the document UI, and the two board fixes
 * that had to happen before it could be written.
 *
 * W07-02  edit name / type / description / expiry
 * W07-03  replace with a new version, and read the history
 * W07-05  archive or remove
 * W07-06  confirm before a permanent delete
 * W07-09  the thresholds behind "real totals and expiry" agree with each other
 *
 * Plus the two supplementary items:
 *   the live-board extraction that bought the headroom, and
 *   the first paint that the headroom paid for.
 *
 * WHAT WAS THERE BEFORE. Nothing. Measured in a browser on the live register:
 * the open drawer reported `inputs: []` — no input, textarea or select anywhere
 * in it — and a scan of every button, link and [role=button] on the whole page
 * for /edit|rename|delete|remove|archive|replace|version|history/i returned an
 * empty list. The drawer held Close, Open in new tab, Download and four
 * read-only rows. A delete with a confirmation existed in evidence-manager.tsx,
 * on the job drawer, which is not the surface these criteria are about.
 *
 * Reads normalise CRLF first — this is a Windows checkout.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/**
 * Source with block comments removed.
 *
 * Assertions about what the code does must not read the prose beside it. The
 * note above this drawer records the wording it replaced, and quoting a fix is
 * not committing it again — the register test hit the same trap.
 */
const stripComments = (text) => {
  let out = "";
  let i = 0;
  for (;;) {
    const open = text.indexOf("/*", i);
    if (open === -1) return out + text.slice(i);
    out += text.slice(i, open);
    const close = text.indexOf("*/", open + 2);
    if (close === -1) return out;
    i = close + 2;
  }
};
const drawerSource = async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const slice = portal.slice(
    portal.indexOf("function FileDetailDrawer("),
    portal.indexOf("interface CreateRequestDraft"),
  );
  assert.ok(slice.length > 0, "FileDetailDrawer not found");
  return slice;
};

/* ── W07-02 ───────────────────────────────────────────────────────────────── */

test("W07-02: the drawer edits title, type, description and expiry", async () => {
  const drawer = await drawerSource();

  // Four real fields, each labelled by a `for`/`id` pair rather than a placeholder.
  for (const [id, label] of [
    ["document-title", "Title"],
    ["document-type", "Document type"],
    ["document-expiry", "Expiry date"],
    ["document-description", "Description"],
  ]) {
    assert.match(drawer, new RegExp(`htmlFor="${id}"`), `${id} needs a label`);
    assert.match(drawer, new RegExp(`id="${id}"`), `${id} must exist`);
    assert.ok(drawer.includes(label), `the ${id} field must be named "${label}"`);
  }

  // A date field, not a text box: the column is CHECK-constrained to YYYY-MM-DD
  // on the server, and a typed "31/02/2027" would be a refusal at best.
  assert.match(drawer, /id="document-expiry"\s*\n?\s*type="date"/);

  // The server's own limits, so a value is never silently truncated on save.
  assert.match(drawer, /maxLength=\{200\}/);
  assert.match(drawer, /maxLength=\{80\}/);
  assert.match(drawer, /maxLength=\{2000\}/);

  // It saves, and it says what happened to whom.
  assert.match(drawer, /method: "PATCH"/);
  assert.match(drawer, /onNotify\(`\$\{documentName\(file\)\} updated\.`\)/);
});

test("W07-02: an empty expiry is an answer, and the form says so", async () => {
  const drawer = await drawerSource();

  /*
   * Most rows in this register are photographs, which cannot expire. A form
   * that implies every document needs a date invites somebody to invent one,
   * and an invented expiry is counted as a lapsing certificate by every screen
   * downstream of the shared classifier.
   */
  assert.match(drawer, /Leave empty if this document does not expire/);
  assert.match(drawer, /Leave empty to keep using the filename/);

  /*
   * All four keys are sent on every save. `documentFieldUpdates` on the server
   * reads `"title" in body`, so omitting a key means "leave it alone" — which
   * could never express "clear the title I no longer want".
   */
  const body = drawer.slice(drawer.indexOf("body: JSON.stringify({"), drawer.indexOf("}),", drawer.indexOf("body: JSON.stringify({")));
  for (const field of ["title", "documentType", "description", "expiryDate"]) {
    assert.match(body, new RegExp(`${field}: draft\\.${field}`), `${field} must be sent`);
  }
  assert.match(body, /\|\| null/, "an empty box clears the field rather than storing an empty string");

  // The window is printed from the constant that decides it, not from a literal.
  assert.match(drawer, /\{EXPIRY_DUE_SOON_DAYS\} days before the date/);
});

/* ── W07-03 ───────────────────────────────────────────────────────────────── */

test("W07-03: a replacement is a new version, not an overwrite", async () => {
  const drawer = await drawerSource();

  assert.match(drawer, /body\.append\("replaces", file\.id\)/, "the server needs the predecessor");
  assert.match(drawer, /Upload new version/);
  // The promise the control makes, in the words under it.
  assert.match(
    drawer,
    /The current file is kept and marked superseded, not overwritten\./,
  );
});

test("W07-03: the history lists number, date, uploader, state and a way in", async () => {
  const drawer = await drawerSource();

  assert.match(
    drawer,
    /\/api\/files\?versionsOf=\$\{encodeURIComponent\(file\.rootDocumentId\)\}/,
    "the lineage id is what identifies a document across its versions",
  );
  const list = drawer.slice(
    drawer.indexOf('<ol className="document-versions">'),
    drawer.indexOf("</ol>"),
  );
  assert.ok(list.length > 0, "the version list was not found");
  assert.match(list, /v\{version\.versionNo\}/, "the version number");
  assert.match(list, /formatDate\(version\.createdAt, true\)/, "when it was filed");
  assert.match(list, /version\.uploadedByEmail/, "who filed it");
  assert.match(list, /version\.isCurrent \? "Current" : "Superseded"/, "which one is live");
  // A historical version has to be openable, or the history is a list of names.
  assert.match(list, /href=\{version\.inlineUrl\}/);
  assert.match(list, /download=\{version\.originalName\}/);
  assert.match(list, /aria-label=\{`Open version \$\{version\.versionNo\}/);

  /*
   * An unreadable history and an empty one mean opposite things, and a
   * shortened one means a third: `versionNo` can be 2 on a lineage that returns
   * one row, and drawing that without a word invites the reader to treat a gap
   * as a complete audit trail.
   */
  assert.match(drawer, /The version history could not be read\./);
  assert.match(drawer, /this is the only version of this document/);
  assert.match(drawer, /versions\.length < file\.versionNo/);
  /*
   * It states the COUNT and stops. It must not claim the missing versions
   * were deleted: this component cannot check storage, and the short
   * lineages that prompted the note turned out to be a shared dev server
   * mid-teardown, not lost history. Asserted negatively as well as
   * positively, because the tempting sentence is the one that overclaims.
   */
  assert.match(drawer, /Treat this history as incomplete./);
  // Comments stripped: the note above the code records the wording it
  // replaced, and quoting a fix is not committing it again.
  assert.doesNotMatch(
    stripComments(drawer),
    /no longer held in the|still stored/,
    "a count is something the client knows; a reason is not",
  );
});

/* ── W07-05 and W07-06 ────────────────────────────────────────────────────── */

test("W07-05: the register can archive and restore, as well as remove", async () => {
  const drawer = await drawerSource();

  assert.match(drawer, /archived \? "Restore to register" : "Archive"/);
  assert.match(drawer, /JSON\.stringify\(\{ archived: next \}\)/);
  assert.match(drawer, /Remove permanently/);
  assert.match(drawer, /method: "DELETE"/);

  // Archiving and removing are different promises and are described as such.
  assert.match(
    drawer,
    /Archiving keeps the document readable and takes it out of the live\s*\n?\s*register\. Removing deletes the stored file and cannot be undone\./,
  );
  // An archived document says it is out of the compliance count.
  assert.match(drawer, /does not count towards compliance/);
});

test("W07-06: the delete confirm names the file, the place, the permanence and the consequence", async () => {
  const drawer = await drawerSource();
  const confirm = drawer.slice(
    drawer.indexOf("window.confirm("),
    drawer.indexOf("setBusy(\"delete\")"),
  );
  assert.ok(confirm.length > 0, "the confirmation was not found");

  /*
   * The template is `app/(app)/portal/cells/file-cell.tsx`, which is the only
   * other place in this app that deletes a compliance document. A confirm that
   * says "are you sure" is a speed bump; this one is the last place somebody
   * finds out that deleting an EICR is not the same as tidying a folder.
   */
  assert.match(confirm, /\$\{documentName\(file\)\}/, "it must name the file");
  assert.match(confirm, /\$\{documentSiteLabel\(file\)\}/, "and where it is filed");
  assert.match(confirm, /deleted permanently/, "and that the bytes go");
  assert.match(
    confirm,
    /compliance record will show this slot as empty/,
    "and what the compliance record will say afterwards",
  );
  // The honest alternative is offered in the same breath.
  assert.match(confirm, /Archive it instead to keep it readable/);
  // Versions go with it, and that is said when there are any.
  assert.match(confirm, /file\.versionNo > 1/);
});

/* ── W07-09 strays: one threshold, one classifier ─────────────────────────── */

test("W07-09: neither compliance view keeps a second due-soon window", async () => {
  for (const file of [
    "app/(app)/portal/views/store-expiry-calendar.tsx",
    "app/(app)/portal/views/store-compliance-tracker.tsx",
  ]) {
    const source = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(
      source,
      /const DUE_SOON_DAYS\s*=/,
      `${file} must not declare its own renewal window`,
    );
    assert.doesNotMatch(
      source,
      /within \$\{DUE_SOON_DAYS\}/,
      `${file} printed "within 30 days" over a tile a 60-day window filled`,
    );
  }

  // The calendar's amber hint is printed from the constant that decides it.
  const calendar = await read("app/(app)/portal/views/store-expiry-calendar.tsx");
  assert.match(calendar, /hint: `within \$\{EXPIRY_DUE_SOON_DAYS\} days`/);
});

test("W07-09: the verdict is read off the typed union, not sniffed out of a string", async () => {
  const calendar = await read("app/(app)/portal/views/store-expiry-calendar.tsx");
  const tracker = await read("app/(app)/portal/views/store-compliance-tracker.tsx");

  /*
   * Both files used to take `expiryStatus`'s answer as `unknown`, probe a list
   * of candidate field names for something string-shaped, then match that
   * string against groups of substrings — and both had to test "expired"
   * before "expiring" because the two share a prefix. `ExpiryState` is a
   * four-member union and has been all along.
   */
  for (const [name, source] of [["calendar", calendar], ["tracker", tracker]]) {
    for (const dead of ["readTone", "verdictFromToken", "verdictFromDays", "tokenFrom", "daysUntil"]) {
      assert.ok(
        !new RegExp(`function ${dead}\\b`).test(source),
        `${name} must not keep ${dead} — it is a second classifier`,
      );
    }
    assert.doesNotMatch(
      source,
      /TOKEN_KEYS|"tone", "status", "state"/,
      `${name} must not probe for field names on a typed return value`,
    );
    // Both now import the shared module directly rather than a re-export.
    assert.match(
      source,
      /from "\.\.\/\.\.\/\.\.\/lib\/expiry-status"/,
      `${name} must read the shared classifier's own module`,
    );
  }

  assert.match(calendar, /expiryStatus\(iso, utcOf\(today\)\)\.state/);
  assert.match(tracker, /const status = expiryStatus\(iso, today\)/);
  // The day count comes from the same call rather than a second date routine.
  assert.match(tracker, /daysAway: status\.daysRemaining/);
});

/* ── Supplementary 1: the extraction and the first paint ──────────────────── */

test("supplementary: the extraction left live-board real headroom", async () => {
  const board = await readFile(
    path.join(root, "app/(app)/portal/live-board.tsx"),
    "utf8",
  );
  /*
   * The cap in stage-eight-board-split.test.mjs is `source.split("\n").length
   * < 6000`, computed on the raw file. live-board.tsx is CRLF and ends with a
   * newline, so it read 5,996 before this — THREE lines of headroom, not five,
   * and not enough to fix a bug in. That is why the first-paint defect below
   * went unfixed the last time it was found.
   */
  const lines = board.split("\n").length;
  assert.ok(lines < 5600, `live-board.tsx is ${lines} lines; the extraction must leave real room`);

  // The two cells moved whole, and only the entry point is exported.
  const cell = await read("app/(app)/portal/cells/custom-column-cell.tsx");
  assert.match(cell, /export function CustomColumnCell\(/);
  assert.match(cell, /^function CustomChoiceCell\(/m, "its only caller is in this file");
  assert.doesNotMatch(cell, /export function CustomChoiceCell/);
  assert.match(board, /import \{ CustomColumnCell \} from "\.\/cells\/custom-column-cell"/);
  // A leaf: it must not import the board back.
  assert.doesNotMatch(cell, /from "\.\.\/live-board"/);
});

test("supplementary: only the maintenance board is seeded with the maintenance schema", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");

  /*
   * `fallbackGroups` and `fallbackSystemColumns` are the maintenance board's
   * four groups and twenty-five columns, derived from monday-board-spec. They
   * were seeded unconditionally, so /dashboard/store-documentation painted the
   * maintenance board's schema — a fully drawn grid with Add-item affordances —
   * until `/api/board?board=store-documentation` answered. No rows leaked; the
   * SCHEMA was wrong, which is worse than blank, because a reader who acts on a
   * column heading has been told something false about the register.
   */
  assert.match(board, /const isMaintenanceBoard = boardId === "maintenance";/);
  assert.match(
    board,
    /useState<MaintenanceGroup\[\]>\(\s*\n?\s*isMaintenanceBoard \? fallbackGroups : \[\],\s*\n?\s*\)/,
  );
  assert.match(
    board,
    /useState<MaintenanceBoardColumn\[\]>\(\s*\n?\s*isMaintenanceBoard \? fallbackSystemColumns : \[\],\s*\n?\s*\)/,
  );

  // And the same rule where the loaded board reports no system columns of its
  // own: offering another board's schema there is the same substitution.
  assert.match(
    board,
    /loadedSystemColumns\.length\s*\n?\s*\? loadedSystemColumns\s*\n?\s*: boardId === "maintenance"/,
  );
});

/* ── Touch targets on the W7 surfaces ─────────────────────────────────────── */

test("the W7 touch targets clear 44px, without new breakpoints", async () => {
  const brand = await read("app/brand-overrides.css");
  const calendarCss = await read("app/(app)/portal/views/store-expiry-calendar.css");
  const globals = await read("app/globals.css");

  // Measured 42x44 at 320, 360 and 430 — the only way out of the drawer bar
  // Escape and the scrim.
  assert.match(
    brand,
    /\.detail-drawer--file \.detail-drawer__header \.icon-button \{\s*\n\s*min-width: 44px;/,
  );
  /*
   * The period picker, measured 168x40 at 430/393/390/375/360/320.
   *
   * POSITION IS PART OF THIS FIX, so position is what is asserted. The floor
   * it has to beat is
   * `.section-header__* > .analytics-period :is(select, input)` at 40px,
   * which is (0,2,1). The first attempt was
   * `.portal-shell .analytics-period select` — ALSO (0,2,1), and earlier in
   * the file, so the tie went to the floor and the rule did nothing at all.
   * It read as correct for a whole session. Presence alone would have passed
   * that; only order catches it.
   */
  const floor = ".section-header__controls > .analytics-period :is(select, input)";
  const floorAt = brand.indexOf(floor);
  assert.ok(floorAt > -1, "the 40px floor moved - recheck the override below");
  const overrideAt = brand.indexOf(floor, floorAt + 1);
  assert.ok(overrideAt > -1, "the period picker needs a 44px override");
  assert.ok(
    overrideAt > floorAt,
    "an equal-specificity override only wins if it comes LATER in the file",
  );
  assert.match(brand.slice(overrideAt, overrideAt + 220), /min-height: 44px/);
  // Phone only: desktop chrome is not resized.
  const mediaAt = brand.lastIndexOf("@media (max-width: 768px)", overrideAt);
  assert.ok(mediaAt > floorAt, "the override must sit inside the phone block");
  // The chip goes up too, or the stretched control outgrows the box it is in.
  const chipBlock = brand.slice(mediaAt, overrideAt);
  assert.ok(
    chipBlock.includes(".section-header__controls > .analytics-period {"),
    "the chip must reach 44 as well as the control inside it",
  );
  assert.match(chipBlock, /min-height: 44px/);
  // Measured 163x20 at >=768 and 175x21 at <=430: `padding: 0; border: 0` left
  // its box as the 12px line box.
  const toggle = calendarCss.slice(
    calendarCss.indexOf(".store-expiry__overdue-toggle {"),
    calendarCss.indexOf("}", calendarCss.indexOf(".store-expiry__overdue-toggle {")),
  );
  assert.match(toggle, /min-height: 44px/);
  assert.match(toggle, /display: inline-flex/, "the ink must not move, only the hit area");

  /*
   * NO NEW BREAKPOINT WAS INTRODUCED FOR ANY OF THIS.
   *
   * Both fixes above went into the `@media (max-width: 768px)` block that
   * already holds the register's other touch-target corrections, and the filter
   * selects inherit their phone layout from the `.workspace-toolbar > select`
   * rules that block already carries — which is the reason the Sites register's
   * markup pattern was copied rather than a new one invented.
   *
   * 768 is on the agreed list that stage-five-board-chrome and stage-six-views
   * enforce over their own sections of this file: 640/767/768/1024/1280.
   */
  const agreed = [640, 767, 768, 1024, 1280];
  const drawerFixAt = brand.indexOf(
    ".detail-drawer--file .detail-drawer__header .icon-button {",
  );
  const blockStart = brand.lastIndexOf("@media (max-width: ", drawerFixAt);
  assert.ok(blockStart > -1, "the drawer fix must sit under a breakpoint");
  // parseInt stops at the "px"; no regex, because an escaped digit class
  // does not survive every editing path this file has been through.
  const marker = "max-width: ";
  const head = brand.slice(blockStart, drawerFixAt);
  const width = parseInt(head.slice(head.indexOf(marker) + marker.length), 10);
  assert.ok(
    agreed.includes(width),
    width + "px is outside the agreed breakpoints",
  );

  // The new register chrome keys on the typed state, not on a lower-cased label.
  for (const state of ["valid", "due-soon", "expired", "not-recorded", "archived"]) {
    assert.match(globals, new RegExp(`\\.document-status--${state}`), `${state} needs a colour`);
  }
});
