/**
 * Stage 29 — the form builder, and the shared form link.
 *
 * The Form tab used to render a fillable form and nothing else. It now carries
 * monday's builder chrome — Back / Preview / Edit / Design / Settings and a
 * Share button — over the same form, plus a public /f/:token route that anybody
 * can open without an account.
 *
 * THE TWO RULES THIS FILE EXISTS TO HOLD
 *
 *  1. EDITING IS DESKTOP-ONLY; THE LINK IS NOT. The brief was explicit: the
 *     builder and the Share control must not appear on a phone, while the
 *     shared form must work on every device. Those pull in opposite directions
 *     and are easy to get half-right, so both halves are asserted here.
 *
 *  2. THE PUBLIC PAYLOAD IS AN ALLOWLIST. Ten of the nineteen questions are
 *     hidden on monday — "Cost of Works", "Approved by", the 23-label workflow
 *     Status — and the form is reachable by anyone holding a link. A redaction
 *     that forgets one field publishes the board's internals; a projection that
 *     names what to include cannot.
 *
 * Source-text tests, like the rest of the suite: they read files and match. No
 * browser is available here, so the responsive rules are proven by reading the
 * stylesheet, which is how stage-twentyfive and stage-twentyseven do it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const BUILDER_CSS = "app/(app)/portal/form-builder.css";
const PUBLIC_CSS = "app/(public)/f/[token]/public-form.css";
const CONFIG_LIB = "app/lib/form-config.ts";
const PROJECTION_LIB = "app/lib/form-projection.ts";

/* ── Editing on a phone ──────────────────────────────────────────────────── */

/*
 * THIS SECTION REVERSED. It used to be headed "Desktop only" and it pinned the
 * opposite contract: `.form-builder__bar { display: none }` below 768px, plus a
 * `matchMedia` effect that forced the mode back to `view`. Both were correct
 * for the rule they served — the owner has since asked for form editing to be
 * reachable from a phone, so the assertions are re-pointed at the new contract
 * rather than deleted. What they were really protecting survives underneath:
 * the toolbar's presence is still a CSS decision and not a render-time one, and
 * a phone still cannot be stranded inside a panel with no way out.
 */

test("the builder toolbar is reachable on a phone", async () => {
  const css = await read(BUILDER_CSS);
  const narrow = css.slice(css.indexOf("@media (max-width: 767px)"));
  assert.ok(narrow, "the stylesheet must have a phone block");

  const bar = narrow.slice(narrow.indexOf(".form-builder__bar"));
  assert.doesNotMatch(
    bar.slice(0, 200),
    /display:\s*none/,
    "hiding the toolbar below 768px IS the defect — it was the whole of the old no-editing-on-mobile rule",
  );
  assert.doesNotMatch(
    bar.slice(0, 200),
    /visibility:\s*hidden/,
    "and never the worse version of it, which leaves the buttons focusable but off screen",
  );
  /* Wrapping, not sideways scrolling: a strip that scrolls hides the control
     somebody has not thought to look for. */
  assert.match(bar.slice(0, 200), /flex-wrap:\s*wrap/);
});

test("phone editing controls clear the 44px touch floor", async () => {
  const css = await read(BUILDER_CSS);
  const narrow = css.slice(css.indexOf("@media (max-width: 767px)"));
  for (const selector of [
    ".form-builder__back,",
    ".form-builder__modes button {",
    ".form-edit__cardtools button,",
  ]) {
    const at = narrow.indexOf(selector);
    assert.notEqual(at, -1, `${selector} must be sized for a finger in the phone block`);
    assert.match(
      narrow.slice(at, at + 260),
      /min-height:\s*44px/,
      `${selector} must clear the 44px floor the rest of the phone chrome is held to`,
    );
  }
});

/* Comments explain the rule that was removed and name the media query it used.
   Every assertion about the CODE therefore runs against the source stripped of
   them, or the explanation reads as the thing it is explaining. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the toolbar is not shown or hidden by a width check in JavaScript", async () => {
  const builder = codeOnly(await read("app/(app)/portal/form-builder.tsx"));
  /*
   * Unchanged, and the reason is unchanged: a server-rendered app has no
   * viewport, so deciding what to render from one is a hydration mismatch.
   */
  assert.doesNotMatch(
    builder,
    /\{\s*!?\s*(isMobile|isDesktop|narrow)\s*&&\s*<div className="form-builder__bar"/,
    "the toolbar's presence must be a CSS decision, not a render-time one",
  );
  /*
   * The mode reset is gone with the rule that needed it. It ran on mount as
   * well as on change, so leaving it in place would snap any phone route into
   * Edit straight back to `view`.
   */
  assert.doesNotMatch(
    builder,
    /matchMedia\("\(max-width: 767px\)"\)/,
    "the mode must not be force-reset at the phone boundary any more — that is what would make the new toolbar unusable",
  );
});

test("a phone cannot be stranded inside a builder panel", async () => {
  const builder = codeOnly(await read("app/(app)/portal/form-builder.tsx"));
  /* What the deleted mode reset was really guaranteeing: a way out, drawn at
     every width, whenever a panel is open. */
  assert.match(
    builder,
    /editing \|\| mode === "preview" \? \([\s\S]{0,320}?onClick=\{\(\) => setMode\("view"\)\}/,
    "every editing mode must draw Back to view, and the toolbar holding it is now on a phone too",
  );
});

test("a phone edits the same configuration a desktop does", async () => {
  const builder = codeOnly(await read("app/(app)/portal/form-builder.tsx"));
  const panels = codeOnly(await read("app/(app)/portal/form-builder-panels.tsx"));
  /* One write path. There must be no mobile-only form model, no second draft
     and nothing to reconcile — every panel control calls the same `patch`. */
  assert.match(
    builder,
    /api\/board\/form\?board=\$\{encodeURIComponent\(boardId\)\}`, \{\s*method: "PATCH"/,
    "settings are saved by one request to one endpoint",
  );
  assert.equal(
    (panels.match(/fetch\(/g) ?? []).length,
    0,
    "no panel may reach the network on its own; they all go through the builder's patch",
  );
});

test("the Design panel's colour pickers are not read-only fields", async () => {
  const panels = codeOnly(await read("app/(app)/portal/form-builder-panels.tsx"));
  /*
   * Both swatches were `value={…}` with only `onBlur`. React calls that a
   * controlled input with no way to update it — it warns "this will render a
   * read-only field" and holds the DOM value back to the prop on every render.
   * They appeared to work only because nothing re-rendered mid-drag.
   *
   * The commit-on-blur intent is right and unchanged: `onChange` on a colour
   * picker is one PATCH per pixel of mouse travel. Uncontrolled is how that
   * intent is actually spelled.
   */
  for (const match of panels.match(/<input[\s\S]{0,400}?type="color"[\s\S]{0,400?}?\/>/g) ?? []) {
    assert.doesNotMatch(match, /\svalue=\{/, "a colour picker must not be controlled without an onChange");
  }
  const colourInputs = (panels.match(/type="color"/g) ?? []).length;
  assert.equal(colourInputs, 2, "the accent and the background swatch");
  assert.equal(
    (panels.match(/defaultValue=\{appearance\./g) ?? []).length,
    2,
    "both swatches must be uncontrolled, so the native picker owns the live value and blur commits it once",
  );
  assert.equal(
    (panels.match(/key=\{appearance\.(primaryColor|background\.value)/g) ?? []).length,
    2,
    "each needs a key, or a defaultValue read once at mount never re-seeds when Reset changes the stored colour",
  );
});

test("the shared form is never hidden on a phone", async () => {
  const css = await read(PUBLIC_CSS);
  /*
   * The inverse of the rule above, and the half that is easy to lose: the
   * public page must carry no rule that removes the form, the submit button or
   * the card at any width.
   */
  const phone = css.slice(css.indexOf("@media (max-width: 640px)"));
  for (const selector of [".pf__form", ".pf__submit", ".pf__card", ".pf__field"]) {
    const rule = phone.indexOf(selector);
    if (rule < 0) continue;
    assert.doesNotMatch(
      phone.slice(rule, rule + 200),
      /display:\s*none/,
      `${selector} must never be hidden on a phone — the link works on every device`,
    );
  }
});

test("the public form's inputs clear the iOS zoom floor", async () => {
  const css = await read(PUBLIC_CSS);
  /*
   * `>` and not a descendant selector — see the note in the stylesheet. As a
   * descendant rule this reached the visually-hidden file input nested in
   * `.pf__files` and gave it `width: 100%` against the initial containing
   * block, which was 421px of horizontal scroll at 1440px. The 16px floor
   * below is the original guarantee and is unchanged.
   */
  const anchor = css.indexOf(".pf__field > input,");
  assert.ok(anchor > 0, "the field rule must be scoped to direct children");
  const inputs = css.slice(anchor);
  /*
   * Below 16px iOS Safari zooms on focus and does not zoom back, leaving a
   * submitter on a horizontally scrolled page mid-form.
   */
  assert.match(inputs.slice(0, 420), /font-size:\s*16px/);

  /*
   * And the hidden file input must not be reachable by it, or the overflow
   * comes straight back the next time somebody widens the selector.
   */
  assert.doesNotMatch(
    css,
    /^\.pf__field input,/m,
    "the descendant form of this rule is what caused the overflow",
  );
  const tap = css.slice(css.indexOf(".pf__submit"));
  assert.match(tap.slice(0, 500), /min-height:\s*44px/, "the submit button is a tap target");
});

/* ── Breakpoints ─────────────────────────────────────────────────────────── */

test("both stylesheets use only the agreed breakpoints", async () => {
  for (const path of [BUILDER_CSS, PUBLIC_CSS]) {
    const css = await read(path);
    const queries = css.match(/@media \([^)]*width: (\d+)px\)/g) ?? [];
    for (const query of queries) {
      const width = Number(query.match(/(\d+)px/)[1]);
      assert.ok(
        [640, 767, 768, 1024, 1280].includes(width),
        `${path}: ${query} is outside the agreed breakpoints`,
      );
    }
  }
});

/* ── Colour discipline ───────────────────────────────────────────────────── */

test("the builder paints only through tokens", async () => {
  const css = await read(BUILDER_CSS);
  /*
   * The palette in globals.css is tuned so every foreground clears AA against
   * the surface it lands on in both themes, and the contrast test recomputes
   * those ratios FROM THAT FILE. A literal here would be the one pairing
   * nobody had measured. The single permitted rgba is the dialog backdrop,
   * which sits over the page rather than under any text.
   */
  const literals = [...css.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0]);
  assert.deepEqual(literals, [], `hard-coded colours in ${BUILDER_CSS}: ${literals.join(", ")}`);

  const rgba = [...css.matchAll(/rgba?\([^)]*\)/g)].map((match) => match[0]);
  assert.ok(
    rgba.every((value) => css.slice(css.indexOf(value) - 200, css.indexOf(value)).includes("backdrop")),
    "the only literal alpha may be the share dialog's backdrop",
  );
});

test("the public form defines its palette in both schemes", async () => {
  const css = await read(PUBLIC_CSS);
  /*
   * This route is outside the portal and has no `data-theme` attribute to read,
   * so `prefers-color-scheme` is the only signal. Every token the light block
   * sets must be restated in the dark one — a half-restated palette is exactly
   * how ink ends up at 1.03:1 on a card whose background did change.
   */
  const light = css.slice(css.indexOf(".pf {"), css.indexOf("@media (prefers-color-scheme: dark)"));
  const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));

  const names = (block) =>
    [...block.matchAll(/(--pf-[a-z-]+):/g)].map((match) => match[1]).sort();
  const lightNames = names(light).filter((name) => name !== "--pf-font");
  const darkNames = names(dark);

  for (const name of lightNames) {
    assert.ok(darkNames.includes(name), `${name} has no dark value — it would carry over`);
  }
});

/* ── The public payload is an allowlist ──────────────────────────────────── */

test("hidden questions never reach the browser", async () => {
  /*
   * The projection moved to `app/lib/form-projection.ts` — a PURE module with
   * no database imports — so the builder's Preview can call the very same
   * function in the browser. It had to: `worker/index.ts` sets
   * `X-Frame-Options: DENY` on every response, so the previous approach of
   * framing the real /f/:token route was refused by policy on every port and
   * every domain. Sharing the rules is what stops Preview and the public form
   * drifting, and weakening that header would have been the wrong trade.
   *
   * So this follows the move rather than relaxing: the guarantee — a hidden
   * question and a retired option never reach a browser — is asserted at its
   * new home, and `form-config` is checked to be delegating rather than
   * keeping a second copy that could rot.
   */
  const projection = await read(PROJECTION_LIB);
  assert.match(
    projection,
    /\.filter\(\(question\) => question\.visible && question\.type !== "PAGE_BLOCK"\)/,
    "only visible questions may be published",
  );
  /* A retired store must not be selectable, and monday retires by flag. */
  assert.match(projection, /option\.visible && option\.active/);

  /*
   * The projection module now presents the WHOLE payload (`projectPublicForm`)
   * so the builder's Preview can compute in the browser exactly what the
   * server serves. Both hops are asserted: the pure module holds the one
   * question filter, and the server's `publicForm` delegates to it rather
   * than keeping a second copy that could rot.
   */
  assert.match(
    projection,
    /projectQuestions\(config, optionOverrides, now\)/,
    "the presentation must be built on the shared question projection",
  );
  const lib = await read(CONFIG_LIB);
  assert.match(
    lib,
    /return projectPublicForm\(/,
    "the server must delegate to the shared projection, not keep a second copy of the rules",
  );
  assert.doesNotMatch(
    lib.slice(lib.indexOf("export function publicForm")),
    /question\.visible && question\.type !== "PAGE_BLOCK"/,
    "the filter must live in exactly one place",
  );

  /*
   * And the pure module must stay pure, or a client component importing it
   * drags drizzle and the password hasher into the browser bundle.
   */
  assert.doesNotMatch(projection, /from "drizzle-orm"/);
  assert.doesNotMatch(projection, /from "\.\.\/\.\.\/db"/);
  assert.doesNotMatch(projection, /from "\.\/password"/);
});

test("the password hash has exactly one reader and never leaves it", async () => {
  const lib = await read(CONFIG_LIB);

  /*
   * `FormRecord` carries `hasPassword`, a boolean, and deliberately not the
   * hash. Everything that loads a form gets a `FormRecord`, so there is no
   * shape in which a route could serve the digest by accident.
   */
  assert.match(lib, /hasPassword: Boolean\(row\.passwordHash\)/);
  assert.doesNotMatch(
    lib.slice(lib.indexOf("function toRecord")),
    /passwordHash: row\.passwordHash/,
    "the hash must not be carried on the record every route holds",
  );

  for (const path of [
    "app/api/forms/[token]/route.ts",
    "app/api/forms/[token]/submit/route.ts",
    "app/api/board/form/route.ts",
  ]) {
    const route = await read(path);
    assert.doesNotMatch(route, /passwordHash: record/, `${path} must not echo the hash`);
    assert.doesNotMatch(route, /\.passwordHash\b(?!\s*[=:]\s*(null|await))/, `${path} must not read the hash`);
  }
});

test("an unresolvable token and another tenant's form are indistinguishable", async () => {
  const route = await read("app/api/forms/[token]/route.ts");
  /*
   * Two different answers here would turn the endpoint into an oracle for
   * guessing valid tokens.
   */
  assert.match(route, /function notFound\(\)/);
  assert.match(route, /This form could not be found\./);
  const bodies = [...route.matchAll(/status: 404/g)];
  assert.equal(bodies.length, 1, "there is one 404 and every miss goes through it");
});

test("the token is bounded before it reaches a query", async () => {
  const lib = await read(CONFIG_LIB);
  const loader = lib.slice(lib.indexOf("export async function loadFormByToken"));
  assert.match(loader.slice(0, 400), /\/\^\[a-f0-9\]\{10,64\}\$\/i/);
});

/* ── The gates ───────────────────────────────────────────────────────────── */

test("availability is checked on the read, not only on the submit", async () => {
  /*
   * Checking only on submit would draw somebody the whole form, let them fill
   * it in, and refuse at the end — which is the experience the close-date and
   * response-limit features exist to prevent.
   */
  const route = await read("app/api/forms/[token]/route.ts");
  assert.match(route, /formAvailability\(record\)/);
  const submit = await read("app/api/forms/[token]/submit/route.ts");
  assert.match(submit, /formAvailability\(record\)/);
});

test("a response is counted only once it exists", async () => {
  const submit = await read("app/api/forms/[token]/submit/route.ts");
  const insert = submit.indexOf(".insert(maintenanceRequests)");
  const increment = submit.indexOf("responseCount} + 1");
  assert.ok(insert > 0 && increment > insert, "the counter must follow the insert, not precede it");
});

test("the submit route resolves the site inside the form's own organisation", async () => {
  const submit = await read("app/api/forms/[token]/submit/route.ts");
  /*
   * Without the organisation predicate a submitter could name any site string
   * and have it matched against another tenant's estate. The token authorises
   * one workspace, not whichever happens to have a site by that name.
   *
   * RE-POINTED, AND THE RULE GREW A SECOND HALF. This matched the two
   * predicates written on one line. W2 added a third — the REGISTER — because
   * the organisation is no longer the whole boundary: a site can belong to a
   * custom Sites section, and this endpoint is PUBLIC, so a submitted name
   * matching a site inside somebody's own register attached the job to it.
   * Reproduced before the fix.
   *
   * Asserted clause by clause rather than as one string, which is both stricter
   * and immune to the next reformat: the name, the organisation and the
   * canonical register must each be in the predicate.
   */
  assert.match(submit, /eq\(sites\.name, location\)/, "matched by the submitted name");
  assert.match(
    submit,
    /eq\(sites\.organisationId, record\.organisationId\)/,
    "inside the form's own organisation",
  );
  assert.match(
    submit,
    /registerScopeFilter\(sites\.boardId, CANONICAL_REGISTER\)/,
    "and only the canonical register — a public submitter cannot name an instance",
  );
});

test("the unlock cookie is derived from the stored hash, so it self-invalidates", async () => {
  const lib = await read(CONFIG_LIB);
  const unlock = lib.slice(lib.indexOf("export async function expectedUnlockValue"));
  assert.match(unlock.slice(0, 500), /digest\(`\$\{formId\}:\$\{row\.passwordHash\}`\)/);
  /*
   * The cookie STRING, not the function that builds it — the surrounding
   * comment mentions Max-Age to explain its absence, and matching the prose
   * would pass or fail on the wording rather than on the header.
   */
  const built = lib.match(/return `\$\{unlockCookieName\(formId\)\}=[^`]*`/);
  assert.ok(built, "the unlock cookie must be built from one template");
  assert.match(built[0], /HttpOnly/, "the unlock cookie is not readable by script");
  assert.match(built[0], /SameSite=Lax/);
  /* No Max-Age: it dies with the browser, because form passwords are shared. */
  assert.doesNotMatch(built[0], /Max-Age/);
});

/* ── The seed ────────────────────────────────────────────────────────────── */

test("the captured configuration is monday's, in monday's order", async () => {
  const spec = await read("db/monday-board-spec.ts");
  const config = spec.slice(spec.indexOf("export const maintenanceFormConfiguration"));

  assert.match(config, /viewId: "646339"/);
  assert.match(config, /boardId: "1139774521"/);

  /*
   * The live form token and its wkf.ms short link must NOT be here. This repo
   * is public and that pair is a working submission endpoint into the client's
   * production board — see the note in the spec. This is the guard against
   * somebody pasting the whole API response back in.
   */
  /*
   * Matched against VALUES, not prose: the comments here necessarily mention
   * both in order to explain their absence, and an assertion that tripped on
   * its own explanation would push the next person into deleting the warning.
   */
  const whole = await read("db/monday-board-spec.ts");
  assert.doesNotMatch(
    whole,
    /[0-9a-f]{32}/,
    "a 32-hex monday form token must stay out of a public repo",
  );
  assert.doesNotMatch(
    whole,
    /https:\/\/wkf\.ms\/\S+/,
    "the live short link must stay out of a public repo",
  );

  /* All nineteen, page block first, in `sortedQuestionsList` order. */
  const order = config.slice(config.indexOf("order: ["), config.indexOf("questions: ["));
  const ids = [...order.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 19, "monday's form has nineteen questions");
  assert.equal(ids[0], "page_block__classic_default");
  assert.deepEqual(ids.slice(1, 9), [
    "single_selecty9rcyhe",
    "short_text64",
    "numbertb4g1z46",
    "date",
    "single_select",
    "short_text",
    "upload_file",
    "status",
  ]);

  /* The store list has a gap at 5 — a deleted store, and monday does not renumber. */
  assert.match(config, /label: "Brighton – Churchill Square", value: "6"/);
});

test("the seed runs once per organisation and never overwrites an edit", async () => {
  const init = await read("db/init.ts");
  const fn = init.slice(
    init.indexOf("async function ensureFormBuilder"),
    init.indexOf("async function ensureStageSevenNotifications"),
  );
  assert.match(fn, /INSERT OR IGNORE INTO form_configurations/);
  assert.match(
    fn,
    /CREATE UNIQUE INDEX IF NOT EXISTS form_configurations_view_idx/,
    "the IGNORE only means what it should if the view is unique",
  );
});

test("the builder's own view keeps the hidden questions", async () => {
  /*
   * The opposite of the public projection, and deliberately so: an admin has to
   * see and unhide the ten hidden questions, so the builder endpoint sends the
   * whole config. What it still never sends is the hash — asserted above.
   */
  const route = await read("app/api/board/form/route.ts");
  assert.match(route, /config: record\.config/);
  assert.match(route, /hasPassword: record\.hasPassword/);
});
