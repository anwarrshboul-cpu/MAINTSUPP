/**
 * Stage 30 — canonical options, the shared renderer, and the read-only ticket.
 *
 * THE RULES THIS FILE EXISTS TO HOLD
 *
 *  1. NO OPTION A SUBMITTER SEES MAY EXIST ONLY IN THE FORM. Location options
 *     are the Sites register; Engineer and Priority are the option registry.
 *     The form keeps order-and-visibility preferences, never a copy.
 *
 *  2. BUSINESS LOGIC KEYS ON VALUES, NEVER ON DISPLAY LABELS. Labels became
 *     editable, so `priority === "Urgent"` ternaries had to go: the SLA lives
 *     in one module keyed on the stable registry value, and the submit routes
 *     canonicalise before storing or computing anything.
 *
 *  3. PREVIEW IS THE PUBLIC FORM. One renderer module, one projection, one
 *     option substitution built by one function for both endpoints — and no
 *     iframe, because X-Frame-Options: DENY is deliberate and stays.
 *
 *  4. THE FIX TRACKER'S COPIED LINK IS PUBLIC AND READ-ONLY. A viewer token
 *     carries no write right anywhere: stripped at mint, stripped again at
 *     resolve, refused by the POST route, and rendered without controls.
 *
 * Source-text tests, like the rest of the suite.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* ── 1. SLA and tier come from values, not labels ────────────────────────── */

test("no submission route compares a priority label to compute anything", async () => {
  for (const path of [
    "app/api/forms/[token]/submit/route.ts",
    "app/api/maintenance/route.ts",
  ]) {
    const route = await read(path);
    assert.doesNotMatch(
      route,
      /priority === "Urgent" \? 4/,
      `${path} must read the SLA from priority-rules, not a label ternary`,
    );
    assert.doesNotMatch(
      route,
      /priority === "Urgent" \? 1/,
      `${path} must read the tier from priority-rules, not a label ternary`,
    );
    assert.match(route, /priorityRule\(priority\)/, `${path} must use the shared rule`);
  }
});

test("the shared form submit canonicalises priority and engineer to registry values", async () => {
  const submit = await read("app/api/forms/[token]/submit/route.ts");
  assert.match(submit, /listOptionValues\(db, record\.organisationId, "priority"\)/);
  assert.match(
    submit,
    /listOptionValues\(\s*db,\s*record\.organisationId,\s*"engineer_required",?\s*\)/,
  );
  assert.match(submit, /canonicalOptionValue\(priorityOptions/);
  assert.match(submit, /canonicalOptionValue\(engineerOptions/);
});

test("the rules module keys on values and defaults rather than refusing", async () => {
  const rules = await read("app/lib/priority-rules.ts");
  assert.match(rules, /Urgent: \{ dueHours: 4, tier: 1 \}/);
  assert.match(rules, /Medium: \{ dueHours: 72, tier: 2 \}/);
  assert.match(rules, /DEFAULT_PRIORITY_RULE/);
  /* Pure: importable by anything without dragging the database along. */
  assert.doesNotMatch(rules, /from "drizzle-orm"/);
});

/* ── 2. One substitution, served to both endpoints ───────────────────────── */

test("the public route and the builder route offer the same options", async () => {
  const publicRoute = await read("app/api/forms/[token]/route.ts");
  const builderRoute = await read("app/api/board/form/route.ts");
  assert.match(publicRoute, /formOptionOverrides\(db, record\.organisationId, record\.config\)/);
  assert.match(builderRoute, /formOptionOverrides\(db, orgId, record\.config\)/);
  /* The PATCH answer repaints the builder, so it must carry them too. */
  assert.match(builderRoute, /formOptionOverrides\(db, orgId, saved\.config\)/);
});

test("only ACTIVE sites are offered to a submitter", async () => {
  /*
   * The filter moved rather than went away, and it got stricter on the way.
   *
   * This asserted `eq(sites.active, true)` inside form-options. Batch 1B made
   * the site register the client's real estate — closed stores, the office and
   * two warehouses are all canonical Sites now — and `active` alone would have
   * offered "Warehouse 2" to somebody reporting a leak in a shop. So the rule
   * is one shared definition, and the form and the board's Location column both
   * read it, because two definitions is how a dropdown comes to disagree with
   * the register behind it.
   */
  const options = await read("app/lib/form-options.ts");
  assert.match(options, /listRetailSites\(db, organisationId\)/, "the form asks for retail sites");
  assert.doesNotMatch(options, /eq\(sites\.active, true\)/, "and does not keep a second copy of the rule");

  const repository = await read("app/lib/sites-repository.ts");
  const helper = repository.slice(repository.indexOf("export async function listRetailSites"));
  const body = helper.slice(0, helper.indexOf("export async function listSites"));
  assert.match(body, /row\.active/, "an archived site must leave the form");
  assert.match(body, /row\.status === "active"/, "and so must a closed one");
  assert.match(
    body,
    /RETAIL_SITE_TYPES\.includes/,
    "and the office, the warehouses and anything unverified are not locations a shop reports from",
  );
  assert.match(
    repository,
    /const RETAIL_SITE_TYPES = \["Inline", "Kiosk"\]/,
    "retail is the two types a customer walks into",
  );
});

test("the form stores preferences over canonical lists, never copies", async () => {
  const projection = await read("app/lib/form-projection.ts");
  assert.match(projection, /export function mergeOptionStates/);
  assert.match(projection, /export function applyOptionPreferences/);
  /* Still pure — the browser imports this. */
  assert.doesNotMatch(projection, /from "drizzle-orm"/);
  assert.doesNotMatch(projection, /options-repository/);
});

/* ── 3. One renderer, no iframe ──────────────────────────────────────────── */

test("the builder previews with the public renderer, not a frame of it", async () => {
  const builder = await read("app/(app)/portal/form-builder.tsx");
  assert.doesNotMatch(builder, /<iframe/i, "X-Frame-Options: DENY is deliberate; nothing may frame the app");
  assert.match(builder, /<FormPreview form=\{form\} \/>/);

  const preview = await read("app/(app)/portal/form-preview.tsx");
  assert.match(preview, /from "\.\.\/\.\.\/\(public\)\/f\/\[token\]\/form-renderer"/);
  assert.match(preview, /projectPublicForm\(/);
  assert.match(
    preview,
    /form\.optionOverrides \?\? \{\}/,
    "Preview must project with the substitution the server serves",
  );

  const page = await read("app/(public)/f/[token]/public-form.tsx");
  assert.match(page, /from "\.\/form-renderer"/, "the public page mounts the same module");
});

test("the worker's frame refusal is untouched", async () => {
  const worker = await read("worker/index.ts");
  assert.match(worker, /X-Frame-Options["']?,\s*["']DENY/i);
});

/* ── 4. The viewer token is read-only at every layer ─────────────────────── */

test("a viewer grant is stripped of writes at mint AND at resolve", async () => {
  const tokens = await read("app/lib/job-tokens.ts");
  const mint = tokens.slice(tokens.indexOf("export async function createJobToken"));
  assert.match(mint.slice(0, 1600), /const viewer = audience === "viewer";/);
  assert.match(mint.slice(0, 1600), /viewer \? \[\] : sanitiseKinds/);
  const resolve = tokens.slice(tokens.indexOf("export async function resolveJobToken"));
  assert.match(resolve, /const viewer = row\.audience === "viewer";/);
  assert.match(resolve, /viewer \? false : row\.canComment/);
});

test("the public job route refuses every write from a viewer link", async () => {
  const route = await read("app/api/job-link/[token]/route.ts");
  const post = route.slice(route.indexOf("export async function POST"));
  assert.match(post, /scope\.audience === "viewer"/);
  assert.match(post, /This link is view-only\./);
});

test("Copy Link's outcome is shown at the button, never only off-screen", async () => {
  /*
   * The first wiring reported through `notice`, which renders at the FOOT of
   * a panel long enough to scroll — a refusal painted off-screen and the
   * click read as doing nothing. The share feedback must render before the
   * facts grid (i.e. adjacent to the header the button lives in), and a
   * clipboard refusal must surface the link for manual copy, not swallow it.
   */
  const view = await read("app/(app)/portal/views/fix-tracker.tsx");
  const feedback = view.indexOf('className="fix-tracker__share"');
  const facts = view.indexOf('className="fix-tracker__facts"');
  assert.ok(feedback > 0, "the share feedback block must exist");
  assert.ok(feedback < facts, "and it must sit with the header, above the facts");
  assert.match(view, /setShare\(\{ url, copied: false \}\)/, "a refused clipboard hands over the link");

  /*
   * The mint refuses strangers in production and spares the demo identity in
   * development only — the same line every other write route draws.
   */
  const links = await read("app/api/board/links/route.ts");
  assert.match(links, /!authenticated && !demoIdentityAllowed\(\)/);
  assert.match(links, /Sign in to issue a contractor link\./);
});

test("the Fix Tracker mints a WORKING link, and viewer stays read-only for the ones already out", async () => {
  /*
   * THE OWNER CANCELLED THE READ-ONLY RULE, and this test is the record of
   * what that did and — more importantly — what it deliberately did NOT do.
   *
   * The Fix Tracker's Copy Link used to mint `viewer`. The requirement now is
   * that it offers the same working job page as a contractor link: uploads,
   * dates, signature, notes, completion, all writing to the canonical job. It
   * was implemented by changing the AUDIENCE ASKED FOR and nothing else, so
   * the permission model in force is the proven contractor one rather than a
   * second set of rules that would have to be kept safe in parallel.
   *
   * The `viewer` audience itself is untouched and still forced read-only at
   * BOTH layers — the two tests above this one are what hold that — because
   * links minted before the change are still in circulation and must keep the
   * grant they were issued with. Nothing in the app mints one any more.
   */
  const view = await read("app/(app)/portal/views/fix-tracker.tsx");
  assert.match(view, /audience: "contractor"/);
  assert.doesNotMatch(view, /audience: "viewer"/);

  const links = await read("app/api/board/links/route.ts");
  assert.match(
    links,
    /body\.audience === "viewer" \? "viewer" : "contractor"/,
    "the audience is still allowlisted, not passed through",
  );

  /*
   * The page keeps its read-only rendering path. It is now reached only by a
   * token that genuinely grants nothing — an old viewer link, or a contractor
   * grant narrowed to no slots and no rights — and removing it would turn
   * those into a page offering controls that can only fail.
   */
  const page = await read("app/(public)/j/[token]/contractor-job-view.tsx");
  assert.match(page, /data\.audience === "viewer"/);
  assert.match(page, /readOnly \?/, "a link that grants nothing still draws no action sections");
});

test("every registry write is mirrored onto the board's chip store", async () => {
  /*
   * The board draws chips from `maintenance_board_options`; the registry the
   * options admin and the form builder write is `option_values`. Before the
   * mirror, renaming "Urgent" updated the form and every selector while the
   * chips kept the old word forever. One write path, two stores, same request.
   */
  const route = await read("app/api/options/route.ts");
  assert.match(route, /async function mirrorBoardOption/);
  const handlers = ["export async function POST", "export async function PATCH", "export async function DELETE"];
  for (const marker of handlers) {
    const body = route.slice(route.indexOf(marker), route.indexOf(marker) + 5200);
    assert.match(
      body,
      /mirrorBoardOption\(/,
      `${marker} must keep the chip store in step with the registry`,
    );
  }
});

test("the chip store's own editor mirrors back onto the registry", async () => {
  const route = await read("app/api/board/route.ts");
  assert.match(route, /async function mirrorRegistryOption/);
  for (const action of ['action === "create_option"', 'action === "update_option"', 'action === "delete_option"']) {
    const body = route.slice(route.indexOf(action), route.indexOf(action) + 4000);
    assert.match(
      body,
      /mirrorRegistryOption\(/,
      `${action} writes the chip store, so it must mirror the registry`,
    );
  }
});

test("no blanket input rule reaches a checkbox, in any stylesheet", async () => {
  /*
   * The switch fix failed twice because the blanket "form controls are sunken"
   * rule existed in THREE places and each fix found one. brand-overrides
   * carries two (both excluded), and globals.css carried the third — measured
   * in a real browser: the OFF track painted --surface-sunken whatever the
   * tokens said. Every copy must exclude what cannot be typed into.
   */
  for (const path of ["app/globals.css", "app/brand-overrides.css"]) {
    /* Comments stripped: the fixes narrate the selector they exclude. */
    const css = (await read(path)).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/\.portal-shell input([^,{]*)([,{])/g)) {
      if (/:not\(\[type="checkbox"\]\)/.test(match[1])) continue;
      /* The rest of the rule this selector belongs to, up to its close. */
      const block = css.slice(match.index, css.indexOf("}", match.index) + 1);
      assert.doesNotMatch(
        block,
        /background\s*:/,
        `${path}: a bare ".portal-shell input" rule paints backgrounds — it would repaint every switch's track`,
      );
    }
  }
});

test("the file index answers a photo column the way the board counts it", async () => {
  /*
   * /api/board counts a photo cell as rows filed by column PLUS rows carrying
   * only the matching kind. The hover card fetches through /api/files with the
   * column id, so that route must apply the same predicate — filtering by
   * column alone answered an empty list for a visibly full cell.
   */
  const route = await read("app/api/files/route.ts");
  assert.match(route, /columnRow\?\.key === "issuePictures"/);
  assert.match(
    route,
    /and\(eq\(attachments\.kind, columnKind\), isNull\(attachments\.boardColumnId\)\)/,
    "kind-only rows belong to the cell too — the board already counts them",
  );
});

/* ── 5. The board repaints without a reload ──────────────────────────────── */

test("uploads and deletions announce themselves to the board", async () => {
  const manager = await read("app/(app)/portal/evidence-manager.tsx");
  const uploads = manager.slice(manager.indexOf("async function uploadSelected"));
  assert.match(
    uploads.slice(0, uploads.indexOf("async function deleteFile")),
    /maintsupp:refresh-board/,
    "a new photograph must appear without a page reload",
  );
  assert.match(
    uploads.slice(uploads.indexOf("async function deleteFile")),
    /maintsupp:refresh-board/,
    "a removed photograph must leave the thumbnails too",
  );
  assert.doesNotMatch(manager, /window\.location\.reload/);
});

/* ── 6. The hover card and the strip arrows cannot fight the layout ──────── */

test("the hover card is a portalled overlay at the photo's own aspect ratio", async () => {
  const manager = await read("app/(app)/portal/evidence-manager.tsx");
  assert.match(manager, /createPortal\(/);

  const css = await read("app/globals.css");
  const card = css.slice(css.indexOf(".sheet-file-hover {"));
  assert.match(card.slice(0, 600), /position: fixed;/);
  const pane = css.slice(css.indexOf(".sheet-file-hover__preview img"));
  assert.match(pane.slice(0, 300), /object-fit: contain;/, "cover was a crop of a crop");
});

test("the view-strip arrows are overlays, so their visibility cannot resize the strip", async () => {
  const css = await read("app/(app)/portal/views/scroll-affordance.css");
  for (const selector of [".board-views__forward {", ".board-views__back {"]) {
    const rule = css.slice(css.indexOf(selector));
    assert.match(
      rule.slice(0, 300),
      /position: absolute;/,
      `${selector} in flex flow re-fires the ResizeObserver that decides it`,
    );
  }
  const chrome = await read("app/(app)/portal/board-chrome.tsx");
  assert.match(chrome, /className="board-views__strip"/);
});
