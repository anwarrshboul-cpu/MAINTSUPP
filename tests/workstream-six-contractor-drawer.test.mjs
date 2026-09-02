import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

/**
 * THE CONTRACTOR DRAWER, AFTER THE TABLE STOPPED CARRYING ITS ACTIONS.
 *
 * The register used to end every row with a pinned lane of two icons: a chevron
 * that opened the contractor and a pencil that opened the record editor. Both
 * are gone — the whole row is the press that opens the drawer now — and the
 * pencil went with them. That removal is only safe because the affordance moved
 * rather than vanished, and this file is the proof that it did.
 *
 * ── The five things this suite protects ────────────────────────────────────
 *
 * 1. THERE IS EXACTLY ONE CONTRACTOR EDITOR. `WorkspaceDataManager`'s contractor
 *    tab owns the 25 native fields, their validation and their save verb. The
 *    drawer's Edit calls the page's own `onManage` and does nothing else — no
 *    second form, no second save, no drawer-local copy of a rate. Two editors
 *    would be two answers to "what did we agree their day rate was".
 *
 * 2. IT IS ACTUALLY WIRED. `ContractorProfile` takes `onManage` as a REQUIRED
 *    prop and the Contractors page hands it the same function object it hands
 *    the register, so "the drawer is the only route to the editor" cannot
 *    quietly become "there is no route to the editor". With the pencil gone
 *    that is not a cosmetic regression, it is a product that cannot be edited.
 *
 * 3. THE ID IS THE WHOLE CONTRACT. The manager resolves its record with
 *    `recordsFor("contractor", workspace).find(item => item.id === recordId)`.
 *    The drawer passes `contractor.id` untouched; the SERVER section below
 *    creates a real contractor and proves that id is the one `/api/workspace`
 *    lists, which is what that `find` reads.
 *
 * 4. THE SUMMARY IS STILL A SUMMARY. It stays the default first view with its
 *    grouped areas, and the four rules it was written around survive the new
 *    button: WhatsApp is never inferred from the telephone, `active` and
 *    `availability` stay two facts, agreed terms are never summed or called
 *    spend, and the work figures are the page's shared attribution carried in.
 *    `tests/workstream-six-contractor-summary.test.mjs` holds those in depth;
 *    what is asserted here is that adding an EDIT action did not turn the read
 *    view into a form.
 *
 * 5. THE DRAWER STILL BEHAVES LIKE A DIALOG. Escape closes it, focus moves to
 *    the surface on open and returns to the control that opened it on close —
 *    which matters more now that the control is the row itself — and the tab
 *    strip is the shared WAI-ARIA one rather than a third set of plain buttons.
 *
 * FIXTURES ARE REMOVED BY EXACT PRIMARY KEY, never by a name substring. The
 * development database is shared with other agents and other suites; the
 * `ZZQA-W6-*`, `w6contractor-*` and `ZZQA-SUMMARY-*` rows in it belong to them
 * and are not touched here.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(root + file, "utf8")).replace(/\r\n/g, "\n");

/** Comments are where the reasoning lives; assertions about CODE ignore them. */
function codeOnly(source) {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return (
        !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*")
      );
    })
    .join("\n");
}

const PROFILE = "app/(app)/portal/contractor-profile.tsx";
const SUMMARY = "app/(app)/portal/contractor-summary.tsx";
const REGISTER = "app/(app)/portal/contractor-register.tsx";
const PORTAL = "app/(app)/portal/portal-app.tsx";
const MANAGER = "app/(app)/portal/workspace-data-manager.tsx";

/* ═══════════════════════════════════════════════════════════════════════════
   SOURCE — the edit affordance, and the one editor behind it
   ═══════════════════════════════════════════════════════════════════════════ */

test("the drawer header carries an Edit action, named after the contractor it edits", async () => {
  const profile = codeOnly(await read(PROFILE));

  /*
   * IN THE HEADER, not in the Summary panel. The Summary is one of five tabs;
   * the header is the one strip on screen whichever view the reader is in, so
   * somebody who decides from the Jobs list that a rate is wrong does not have
   * to navigate back a tab to say so.
   */
  const header = profile.slice(
    profile.indexOf('<div className="detail-drawer__header">'),
    profile.indexOf('<div className="contractor-profile__tabs">'),
  );
  assert.ok(header.length > 0, "the drawer still has a header before its tab strip");

  assert.match(
    header,
    /aria-label=\{`Edit \$\{contractor\.name\}`\}/,
    "the accessible name says WHOSE record it edits — 'Edit' alone is what a "
      + "screen reader would announce out of context, from a table of thirty",
  );
  assert.match(header, /<Icon name="edit"/, "and it is the pencil, as the table's was");
  assert.match(
    header,
    /onClick=\{openEditor\}/,
    "pressing it runs the one handler, not an inline second implementation",
  );

  /*
   * BOTH BUTTONS IN THE SHARED ACTIONS CLUSTER. `.detail-drawer__actions`
   * (overlay/overlay.css) already owns the `margin-left: auto` and the gap, and
   * the phone rule that sizes a drawer header button to 42x42 names it. Two
   * loose `<button>` children would each take `margin-left: auto` from a rule
   * written for a single control.
   */
  assert.match(header, /<div className="detail-drawer__actions">/, "one actions cluster");
  assert.match(
    header,
    /aria-label="Close contractor profile"/,
    "the close is still there and still named",
  );
});

test("Edit opens the EXISTING editor — one implementation, reached by id", async () => {
  const profile = await read(PROFILE);
  const code = codeOnly(profile);

  /*
   * THE HANDLER IN FULL. It closes this panel and calls the page's `onManage`
   * with the contractor's own id. Nothing else: no fetch, no local form state,
   * no navigation of its own.
   */
  assert.match(
    code,
    /const openEditor = useCallback\(\(\) => \{\s*onClose\(\);\s*onManage\(contractor\.id\);\s*\},\s*\[onClose, onManage, contractor\.id\]\);/,
    "close this layer, then hand the id to the one editor",
  );

  /*
   * REQUIRED, NOT OPTIONAL. An optional `onManage` is how "the drawer is the
   * only route to the editor" becomes "there is no route to the editor" without
   * anything failing to compile.
   */
  assert.match(
    code,
    /\n  onManage: \(id: string\) => void;/,
    "onManage is a required prop of ContractorProfile",
  );
  assert.doesNotMatch(
    code,
    /onManage\?: /,
    "and is not optional — the type checker is what catches an unwired drawer",
  );

  /*
   * ONE EDITOR. The drawer writes exactly two things and both are RELATIONS
   * rather than fields — a site link and a document filed against them. It has
   * no form over the contractor record and must not grow one.
   */
  assert.doesNotMatch(
    code,
    /recordToEditor|saveWorkspaceRecord|entity: "contractor"/,
    "the drawer never edits the contractor record itself",
  );
  const writes = code.match(/method: "(POST|PATCH|PUT|DELETE)"/g) ?? [];
  assert.ok(
    writes.length > 0,
    "the drawer does write — the site link and the document are relations",
  );
  assert.doesNotMatch(
    code,
    /fetch\(\s*`?\/api\/workspace/,
    "but never through /api/workspace, which is the record editor's verb",
  );

  /*
   * THE ID IS THE WHOLE CONTRACT, and this is the other half of it. Re-pointed
   * here rather than asserted loosely: the manager finds its record by
   * identity, so a drawer that passed a name, a slug or an index would open the
   * manager on a list and look like the editor had simply failed.
   */
  const manager = codeOnly(await read(MANAGER));
  assert.match(
    manager,
    /recordsFor\(initialTab, workspace\)\.find\(\(item\) => item\.id === initialRecordId\)/,
    "the manager resolves initialRecordId by id — so the drawer must send an id",
  );
});

test("the Contractors page hands the drawer the same onManage it hands the register", async () => {
  const portal = await read(PORTAL);

  /*
   * THE SAME FUNCTION OBJECT, not a second lambda that happens to call the same
   * thing. `onManage={onManage}` on both is what makes "one editor, one way in"
   * true by construction rather than by two call sites agreeing today.
   */
  const section = portal.slice(portal.indexOf("<ContractorRegister"));
  const registerProps = section.slice(0, section.indexOf("/>"));
  assert.match(registerProps, /onManage=\{onManage\}/, "the register is given the page's onManage");

  const drawerAt = portal.indexOf("<ContractorProfile");
  assert.ok(drawerAt > 0, "the profile drawer is mounted by the Contractors page");
  const drawerProps = portal.slice(drawerAt, portal.indexOf("/>", drawerAt));
  assert.match(drawerProps, /onManage=\{onManage\}/, "and so is the drawer — the same one");
  assert.match(
    drawerProps,
    /onClose=\{\(\) => setOpenProfile\(null\)\}/,
    "and closing the drawer is still the page's own state, unchanged",
  );

  /*
   * AND THAT `onManage` IS THE MANAGER. One hop up: the Contractors section is
   * handed `openWorkspaceManager("contractor", id)`, which is the same call the
   * "Manage contractors" button and the avatar menu reach.
   */
  assert.match(
    portal,
    /onManage=\{\(id\) => openWorkspaceManager\("contractor", id\)\}/,
    "the page's onManage opens the workspace manager on the contractor tab",
  );
});

test("the register no longer carries a permanent pencil, and needs none", async () => {
  const register = codeOnly(await read(REGISTER));

  /*
   * THE PINNED ACTION LANE IS GONE. It stood at the right edge of every row and
   * cost a column of width on every screen to offer two presses the row and the
   * drawer already provide. What must not come back is a PERMANENT per-row edit
   * control: the drawer is where that lives now, and a second one on the table
   * is a second thing to keep in step with the one editor.
   */
  assert.doesNotMatch(
    register,
    /aria-label=\{`Edit \$\{row\.name\}`\}/,
    "no per-row Edit button remains on the table",
  );
  assert.doesNotMatch(
    register,
    /<Icon name="edit"/,
    "and no pencil is drawn in the register at all",
  );
  assert.doesNotMatch(
    register,
    /contractor-register__row-actions/,
    "the pinned per-row action lane is gone with it",
  );

  /*
   * THE ROW IS THE TRIGGER, and the NAME is the focusable one. A `<tr>` cannot
   * be focused, labelled or pressed with a keyboard, so the name is a real
   * `<button>` and the row press is the convenience laid over it. That button
   * is what the drawer restores focus to, which is why this is asserted here
   * and not only in the register's own suite.
   */
  assert.match(
    register,
    /className="contractor-register__cell contractor-register__cell--name"/,
    "the name is the focusable trigger the drawer will hand focus back to",
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   SOURCE — the drawer still behaves like a dialog
   ═══════════════════════════════════════════════════════════════════════════ */

test("Escape closes the drawer, and does not close what is being typed in", async () => {
  const profile = codeOnly(await read(PROFILE));

  assert.match(
    profile,
    /if \(event\.key !== "Escape" \|\| event\.defaultPrevented\) return;/,
    "Escape closes, unless something nearer has already handled it",
  );
  assert.match(
    profile,
    /if \(target instanceof Element && target\.closest\("input, textarea, select"\)\) return;/,
    "and inside a box it means 'abandon what I am typing', as everywhere else",
  );
  assert.match(profile, /window\.addEventListener\("keydown", onKeyDown\)/, "bound while open");
  assert.match(
    profile,
    /return \(\) => window\.removeEventListener\("keydown", onKeyDown\)/,
    "and unbound when it closes — a second listener would close two layers",
  );

  /*
   * WHY EDIT CLOSES THE DRAWER FIRST. The manager listens for Escape on
   * `window` too and does NOT preventDefault, so a drawer left standing behind
   * it would take the same keystroke and dismiss two overlays at once. The
   * manager's own handler is written around "one layer at a time"; leaving this
   * one open underneath would have broken exactly that.
   */
  const manager = await read(MANAGER);
  assert.match(
    manager,
    /if \(event\.key === "Escape"\) \{/,
    "the manager listens for Escape as well",
  );
  assert.doesNotMatch(
    codeOnly(manager).slice(
      codeOnly(manager).indexOf('if (event.key === "Escape") {'),
      codeOnly(manager).indexOf('if (event.key !== "Tab") return;'),
    ),
    /preventDefault/,
    "and does not mark it handled — which is why the drawer closes before it opens",
  );
});

test("focus moves to the drawer on open and returns to the invoking row on close", async () => {
  const profile = codeOnly(await read(PROFILE));

  assert.match(
    profile,
    /const opener =\s*document\.activeElement instanceof HTMLElement \? document\.activeElement : null;/,
    "the opener is captured on MOUNT — by close time it is no longer the active element",
  );
  assert.match(
    profile,
    /surface\.focus\(\{ preventScroll: true \}\)/,
    "focus moves to the dialog surface, so its label is announced before its close button",
  );
  assert.match(
    profile,
    /if \(!opener \|\| !document\.contains\(opener\)\) return;/,
    "a row that re-rendered away is not focused",
  );
  assert.match(
    profile,
    /if \(!active \|\| active === document\.body\) opener\.focus\(\{ preventScroll: true \}\);/,
    "and focus is restored only if nothing else has claimed it",
  );

  /* The surface is a labelled, modal dialog and says so. */
  assert.match(profile, /role="dialog"/, "a dialog");
  assert.match(profile, /aria-modal="true"/, "and a modal one");
  assert.match(
    profile,
    /aria-label=\{`Contractor profile: \$\{contractor\.name\}`\}/,
    "named after the contractor it is about",
  );
});

test("the tab strip is the shared WAI-ARIA one, and Summary is still the first view", async () => {
  const profile = await read(PROFILE);

  assert.match(
    profile,
    /const TABS = \["Summary", "Details", "Sites", "Documents", "Jobs"\] as const;/,
    "five views, Summary first",
  );
  assert.match(
    profile,
    /useState<\(typeof TABS\)\[number\]>\("Summary"\)/,
    "and the drawer opens on it — the Edit action did not become the landing",
  );
  assert.match(
    profile,
    /import \{ SectionPanel, SectionTabs \} from "\.\/sites\/section-tabs";/,
    "the strip is the shared tabs component: roving tabindex, aria-controls, "
      + "role=tabpanel — not a third set of plain buttons calling itself a tablist",
  );

  /*
   * NOTHING NESTED. The header's two controls are siblings inside a plain
   * `<div>`; a control inside a control is invalid and is what axe calls
   * `nested-interactive`.
   */
  assert.doesNotMatch(
    codeOnly(profile),
    /<button[^>]*>\s*<button/,
    "no button inside a button",
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   SOURCE — the Summary survived the new button
   ═══════════════════════════════════════════════════════════════════════════ */

test("the Summary is still a read view, not a form the Edit action made redundant", async () => {
  const summary = codeOnly(await read(SUMMARY));

  /*
   * THE GROUPED AREAS, ALL OF THEM. Adding an editor route must not have been
   * taken as licence to thin the read view out — the whole reason the Summary
   * exists is that the edit form is 25 boxes in tab order and answers no
   * question quickly.
   */
  for (const heading of [
    "Reach them",
    "Status",
    "Services &amp; coverage",
    "Compliance",
    "Agreed commercial terms",
    "Performance",
  ]) {
    assert.ok(
      summary.includes(`<h3>${heading}</h3>`),
      `the Summary still groups "${heading.replace("&amp;", "&")}"`,
    );
  }

  /* No inputs, no save: a summary with a text box in it is the form again. */
  assert.doesNotMatch(summary, /<input|<textarea|<select/, "the Summary holds no boxes");
  assert.doesNotMatch(summary, /method: "(POST|PATCH|PUT|DELETE)"/, "and writes nothing");
});

test("the Summary's four standing rules are untouched by the drawer's Edit", async () => {
  const summary = codeOnly(await read(SUMMARY));

  /*
   * 1 — WHATSAPP IS THE WHATSAPP COLUMN. `wa.me` addresses people by full
   * international number and answers a national one with "the phone number
   * shared via url is invalid", so a link built out of `phone` is a contractor
   * the register claims is messageable on a value nobody entered. The Summary
   * reaches both only through `ContractorContact`, which owns the rule.
   */
  assert.match(
    summary,
    /import \{ ContractorContact \} from "\.\/contractor-contact";/,
    "contact links come from the one component that owns the rule",
  );
  assert.doesNotMatch(summary, /wa\.me|whatsappHref/, "the Summary builds no WhatsApp link itself");
  assert.doesNotMatch(
    summary,
    /whatsappNumber[^;\n]*\|\|[^;\n]*phone|phone[^;\n]*\|\|[^;\n]*whatsappNumber/,
    "and never falls back from one column to the other",
  );

  /*
   * 2 — TWO COLUMNS, TWO ROWS. `active` is whether they are on the register at
   * all; `availability` is whether one who is can take work this week. Joining
   * them into one sentence is how a ticked, saved "Active" box came to sit
   * beside the word "Inactive".
   */
  assert.match(summary, /<ContractorRow label="On the register">/, "the register state is its own row");
  assert.match(
    summary,
    /<ContractorRow label="Availability" when=\{Boolean\(availability\)\}>/,
    "and availability is another",
  );
  assert.match(
    summary,
    /Two different facts\./,
    "with a sentence on the screen saying they are not the same claim",
  );

  /*
   * 3 — AGREED TERMS ARE NOT SPEND. Rates are what was AGREED; without days
   * worked, hours worked or call-outs used, a total of them is not a summary of
   * cost, it is an invented number. So no line in this file may both name a
   * rate and add it to anything.
   */
  const rateLines = summary
    .split("\n")
    .filter((line) => /dayRatePence|hourlyRatePence|callOutCostPence|otherCostPence/.test(line));
  assert.ok(rateLines.length > 0, "the rates are rendered");
  for (const line of rateLines) {
    assert.doesNotMatch(
      line,
      /\breduce\b|\+=|\bsum\b|\btotal\b|\bspend\b/i,
      `a rate is summed or called spend: ${line.trim()}`,
    );
  }

  /*
   * 4 — THE WORK FIGURES ARE THE PAGE'S ATTRIBUTION, CARRIED. The id-first rule
   * is applied once, by the Contractors page. A second copy here would be a
   * second answer to "whose job was that", and a rename would move money.
   */
  assert.match(
    summary,
    /from "\.\.\/\.\.\/lib\/contractor-attribution"/,
    "the spend basis note comes from the shared attribution module",
  );
  assert.doesNotMatch(
    summary,
    /request\.contractor\b|\.toLowerCase\(\)\s*===\s*[^;\n]*name/,
    "and nothing here attributes a job by matching a name",
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   SERVER — the id the drawer hands over is the id the editor looks up
   ═══════════════════════════════════════════════════════════════════════════ */

const CANDIDATES = process.env.MAINTSUPP_BASE_URL
  ? [process.env.MAINTSUPP_BASE_URL]
  : [5173, 5174, 5175, 3000].map((port) => `http://localhost:${port}`);
let BASE_URL = CANDIDATES[0];
const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/**
 * The marker every fixture carries.
 *
 * Run-scoped, because the workspace API has no hard delete for a contractor —
 * `DELETE` archives the row — so a fixed prefix would leave a second row of the
 * same name behind on the next run. Cleanup is nevertheless BY PRIMARY KEY; the
 * prefix is for a human reading the register, not for the sweep.
 */
const RUN = `ZZQA-DRAWER-${Date.now().toString(36)}`;
const createdContractors = [];

let cookie = null;
async function signIn() {
  if (cookie !== null) return cookie;
  cookie = "";
  for (const candidate of CANDIDATES) {
    try {
      const response = await fetch(`${candidate}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) continue;
      BASE_URL = candidate;
      cookie = (response.headers.getSetCookie?.() ?? [])
        .map((raw) => raw.split(";")[0])
        .join("; ");
      if (cookie) return cookie;
    } catch {
      // Next candidate.
    }
  }
  return cookie;
}

async function call(method, path, body) {
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

async function openDevDatabase() {
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
    // `fileURLToPath`, not `URL.pathname`: this repository's path has a space
    // in it, and a percent-encoded path opens nothing.
    const db = new DatabaseSync(fileURLToPath(new URL(file, directory)));
    // The dev server holds this file open; an unqualified write loses the race.
    db.exec("PRAGMA busy_timeout = 15000");
    return db;
  } catch {
    return null;
  }
}

test("a real contractor's id reaches the editor's lookup unchanged", async (t) => {
  if (!(await signIn())) {
    t.skip("no development server");
    return;
  }

  const created = await call("POST", "/api/workspace", {
    entity: "contractor",
    data: {
      name: `${RUN}-editable`,
      email: "drawer@zzqa.example",
      phone: "01204 555111",
      availability: "Available",
      dayRatePence: 45000,
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.id;
  createdContractors.push(id);

  /*
   * THE EXACT LIST THE MANAGER READS. `recordsFor("contractor", workspace)` is
   * `workspace.contractors`, and it finds its record with
   * `item.id === initialRecordId`. The drawer hands over `contractor.id` from a
   * row of this same list, so this is the whole chain from press to editor.
   */
  const snapshot = await call("GET", "/api/workspace");
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
  const contractors = snapshot.body?.workspace?.contractors ?? [];
  const row = contractors.find((entry) => entry.id === id);
  assert.ok(row, "the drawer's row and the editor's record are the same id");
  assert.equal(row.name, `${RUN}-editable`, "and the same contractor");

  /*
   * AND THE ID IS AN IDENTITY, not the fallback roster's bare slug. The page
   * synthesises `contractor-<slug-of-name>` ids out of job text when the
   * register is empty; a real row's id is that slug PLUS a random suffix, which
   * is the difference that lets two firms called the same thing be two records.
   * Asserted as inequality against the fallback's exact shape rather than as
   * "no slug in it", because the server does build the readable half from the
   * name and a test that forbade that would be pinning a fiction.
   */
  const fallbackShape = `contractor-${row.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  assert.notEqual(
    String(id),
    fallbackShape,
    "a registered contractor's id is more than the slug the fallback roster would build",
  );
  assert.ok(
    String(id).startsWith(`${fallbackShape}-`) || !String(id).includes(fallbackShape),
    "and whatever else it is, it is not that slug wearing a different prefix",
  );
  const sameName = contractors.filter((entry) => entry.name === row.name);
  assert.equal(sameName.length, 1, "and this fixture is the only row wearing this name");
});

test("the drawer's own record carries everything the Summary gates on", async (t) => {
  if (!(await signIn())) {
    t.skip("no development server");
    return;
  }

  const created = await call("POST", "/api/workspace", {
    entity: "contractor",
    data: {
      name: `${RUN}-gates`,
      phone: "01204 555222",
      whatsappNumber: "+447700900123",
      availability: "Limited",
      active: true,
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  createdContractors.push(created.body.id);

  const snapshot = await call("GET", "/api/workspace");
  const row = (snapshot.body?.workspace?.contractors ?? []).find(
    (entry) => entry.id === created.body.id,
  );
  assert.ok(row, "the fixture is on the register");

  /*
   * TWO SEPARATE FACTS ARRIVING AS TWO SEPARATE FIELDS. The Summary draws them
   * as two rows because the payload has two values; a server that collapsed
   * them would make the screen's distinction cosmetic.
   */
  assert.equal(row.active, true, "on the register");
  assert.equal(row.availability, "Limited", "and separately, their availability");

  /*
   * AND WHATSAPP ARRIVES AS ITS OWN COLUMN, unequal to the telephone. This is
   * the payload half of the rule `contact-links.ts` enforces in the browser.
   */
  assert.equal(row.phone, "01204 555222");
  assert.equal(row.whatsappNumber, "+447700900123");
  assert.notEqual(row.whatsappNumber, row.phone, "the two are never the same value");
});

/**
 * BY PRIMARY KEY, AND THE RESIDUE IS ASSERTED.
 *
 * The development database is shared with other agents and other suites; a
 * `LIKE 'ZZQA%'` sweep here has eaten other people's fixtures before. Every id
 * below was returned by the API call that created the row.
 *
 * One transaction rather than a dozen statements: `node --test` runs files in
 * parallel and each separate delete takes its own write lock, which is a window
 * in which somebody else's request gets "database is locked".
 */
after(async () => {
  if (!createdContractors.length) return;
  const db = await openDevDatabase();
  assert.ok(db, "fixture cleanup could not open the development database");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of createdContractors) {
        db.prepare("DELETE FROM contractor_sites WHERE contractor_id = ?").run(id);
        db.prepare("DELETE FROM contractor_certifications WHERE contractor_id = ?").run(id);
        db.prepare("DELETE FROM contractors WHERE id = ?").run(id);
        db.prepare("DELETE FROM activity_log WHERE entity_id = ?").run(id);
        db.prepare("DELETE FROM audit_events WHERE entity_id = ?").run(id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const residue = [];
    for (const id of createdContractors) {
      if (db.prepare("SELECT id FROM contractors WHERE id = ?").get(id)) {
        residue.push(`contractor ${id}`);
      }
    }
    assert.deepEqual(residue, [], `fixtures survived cleanup: ${residue.join(", ")}`);
  } finally {
    try {
      db.close();
    } catch {
      // The handle is going out of scope regardless.
    }
  }
});
