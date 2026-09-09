/**
 * 2B AND 2C's SCREEN — adding a site without leaving the register, and editing
 * the requirement template.
 *
 * ── WHAT IS PINNED HERE AND WHAT IS NOT ───────────────────────────────────
 *
 * These are React components. What can be checked without a browser is the set
 * of properties whose ABSENCE is silent — a control with no label, a message
 * that is only a colour, a form that posts a field the route refuses, a screen
 * that turns a backend failure into an empty state. Those are exactly the
 * defects that survive a manual pass because everything still looks right.
 *
 * What is NOT pinned here, and is marked in the report as needing browser QA:
 * that the page renders at 375px, that focus moves in a sensible order, and
 * that the save round-trips. No dev server was started for this work.
 *
 * Reads normalise CRLF; line endings in this repository are per file.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/** Source with comments removed, for any assertion about an ABSENCE. */
const code = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const setup = await read("app/(app)/portal/ops/compliance-setup.tsx");
const setupCss = await read("app/(app)/portal/ops/compliance-setup.css");
const page = await read("app/(app)/portal/ops/compliance-page.tsx");

/* ── The screen is reachable, and reachable from the state it fixes ───────── */

test("Set up is a view of the register, sharing its URL state", () => {
  assert.match(page, /\["setup", "Set up"\]/);
  assert.match(page, /view === "setup"/);
  assert.match(page, /import \{ ComplianceSetup \} from "\.\/compliance-setup"/);
});

test("the setup view is reachable from an EMPTY register, which is the point", () => {
  /*
   * "No compliance requirements are set up yet" is precisely the state somebody
   * comes here to fix. If the empty-state guard short-circuited first, the fix
   * would be unreachable from the screen that reports the problem — the same
   * ordering bug the confirm queue had to be placed ahead of.
   */
  const branch = page.slice(page.indexOf("summary.error ?"));
  const setupAt = branch.indexOf('view === "setup"');
  const emptyAt = branch.indexOf("registerTotal === 0");
  assert.ok(setupAt > 0 && emptyAt > 0);
  assert.ok(setupAt < emptyAt, "the setup branch must come before the empty-state guard");
});

/* ── 2B. Adding a site inline ─────────────────────────────────────────────── */

test("the inline form posts to the one route that also creates the profile", () => {
  /*
   * `POST /api/sites` creates the site AND its compliance profile in the same
   * request, and rolls the site back if the profile fails. Posting anywhere
   * else — or inserting directly — would produce a site the register cannot
   * see, which is the exact defect `ensureComplianceProfile` was added to end.
   */
  const form = setup.slice(setup.indexOf("function AddSiteInline"));
  assert.match(form, /fetch\("\/api\/sites", \{/);
  assert.match(form, /method: "POST"/);
});

test("the inline form never sends an empty required address", () => {
  /*
   * `addressLine1` is required by the route and there is nowhere on a four-field
   * form to type one. Sending "" is refused; inventing a placeholder address
   * would put a fiction in a legally significant column. The town — or failing
   * that the name — is at least true, and whatever is still missing is what the
   * missing-details list exists to chase.
   */
  const form = setup.slice(setup.indexOf("function AddSiteInline"));
  assert.match(form, /addressLine1: town\.trim\(\) \|\| name\.trim\(\)/);
});

test("every control on the inline form has a real label", () => {
  /*
   * A placeholder is not a label: it disappears on focus, is not announced by
   * every reader, and leaves somebody who tabs into a half-filled form with no
   * idea which field they are in.
   */
  const form = setup.slice(setup.indexOf("function AddSiteInline"));
  for (const id of [
    "inline-site-name",
    "inline-site-code",
    "inline-site-town",
    "inline-site-postcode",
  ]) {
    assert.match(form, new RegExp(`htmlFor="${id}"`), `${id} needs a label`);
    assert.match(form, new RegExp(`id="${id}"`), `${id} needs the matching control`);
  }
});

test("the inline postcode is checked by the same function the site form uses", () => {
  /* Two implementations of "is this a postcode" is two answers, and the second
     one is the one nobody tests. */
  assert.match(setup, /import \{ checkPostcode \} from "\.\.\/\.\.\/\.\.\/lib\/uk-postcode"/);
  const form = setup.slice(setup.indexOf("function AddSiteInline"));
  assert.match(form, /aria-invalid=\{postcodeCheck\.problem \? true : undefined\}/);
  assert.match(form, /aria-describedby=\{postcodeCheck\.problem \? "inline-site-postcode-problem" : undefined\}/);
});

test("a failed create is reported, never swallowed into a quiet success", () => {
  const form = setup.slice(setup.indexOf("function AddSiteInline"));
  assert.match(form, /if \(!response\.ok \|\| !body \|\| body\.error\)/);
  /* The server's own sentence where there is one — it says which name collided
     or which option is not configured, and a generic message throws that away. */
  assert.match(form, /setProblem\(body\?\.error \?\?/);
});

/* ── 2C. The template editor ──────────────────────────────────────────────── */

test("the editor says, on screen, that saving changes no compliance record", () => {
  /*
   * The single most important sentence on the page. The accident this batch
   * exists to undo was a write nobody expected; a settings screen that might or
   * might not rewrite sixty rows is the same accident waiting.
   */
  assert.match(setup, /It does not create, rename or delete a\s*\n?\s*single compliance record/);
  assert.match(setup, /Saved\. No compliance record was changed\./);
});

test("a board requirement can be switched off but not renamed", () => {
  /*
   * The board has a column for each of the twelve. A register with no name for
   * a column it can see would show a certificate it cannot label — so the name
   * is read-only and the checkbox is not.
   */
  assert.match(setup, /readOnly=\{entry\.board\}/);
  assert.match(setup, /Named by the Store Documentation board, so it cannot be renamed here\./);
  /* And the read-only field is still described, not merely dimmed. */
  assert.match(setup, /aria-describedby=\{entry\.board \? `template-board-\$\{index\}` : undefined\}/);
});

test("the shipped aliases are shown beside the box, never pre-filled into it", () => {
  /*
   * Merging them would invite somebody to tidy up a list they never wrote and
   * cannot delete — `buildKindResolver` applies the built-in map whether or not
   * the box repeats it. Showing them apart is the honest rendering: these are
   * known to the product, those are yours.
   */
  assert.match(setup, /Already recognised: \$\{shipped\.join\(", "\)\}/);
  assert.doesNotMatch(
    code(setup),
    /aliases: \[\.\.\.shipped/,
    "the shipped names must not be written into the operator's own list",
  );
});

test("the server's refusal reaches the screen with the offending word in it", () => {
  /* `"Fire Alarm" is listed under both "Sprinkler" and "Fire Alarm"` is
     actionable; "The template could not be saved" is not. */
  assert.match(setup, /setProblem\(body\?\.error \?\? "The template could not be saved\."\)/);
});

test("a failed READ is an error state, never an empty template", () => {
  /*
   * An empty template on screen is indistinguishable from a workspace that
   * tracks nothing — and somebody would then "fix" it by saving, which would
   * write that emptiness. Turning a backend failure into a plausible empty
   * state is the one thing this screen must never do.
   */
  assert.match(setup, /<ErrorState what=\{error\} onRetry=\{reload\} \/>/);
  assert.match(setup, /if \(live\) setError\("The compliance template could not be loaded\."\)/);
});

/* ── 2D. The preview on screen ────────────────────────────────────────────── */

test("the preview names both words of an aliased match", () => {
  /*
   * "already held as Legionella risk assessment (Water Hygiene)" is what lets
   * somebody see that the machine understood their vocabulary. A count would
   * not: the run that created 144 duplicates would have looked entirely
   * reasonable as a count.
   */
  assert.match(setup, /\$\{entry\.matchedAs\} \(\$\{entry\.kind\}\)/);
  assert.match(setup, /will NOT be duplicated/);
});

test("apply is only offered after a preview, and undo after an apply", () => {
  const panel = setup.slice(setup.indexOf("function BackfillPanel"));
  /* The apply button is inside `preview ? … : null`, so there is no path from
     opening this screen to writing rows without seeing what they are. */
  assert.match(panel, /\{preview \? \(\s*\n\s*<button type="button" className="primary-button"[\s\S]{0,200}?run\(false\)/);
  assert.match(panel, /\{applied\?\.revert \? \(/);
  assert.match(panel, /Undo this batch/);
});

test("the undo tells somebody what it KEPT, not only what it removed", () => {
  /*
   * "Removed 130" alone would leave somebody believing the undo was total when
   * it deliberately was not: a record with a certificate attached is kept.
   */
  const panel = setup.slice(setup.indexOf("function BackfillPanel"));
  assert.match(panel, /were kept because somebody had already worked on them/);
});

/* ── 2K. What can be checked without a browser ────────────────────────────── */

test("only the agreed breakpoints", () => {
  /* 640 / 767 / 768 / 1024 / 1280, and several stage tests fail on any other. */
  const widths = [...setupCss.matchAll(/\((?:min|max)-width:\s*(\d+)px\)/g)].map(
    (match) => match[1],
  );
  assert.ok(widths.length > 0, "there is at least one media query to check");
  for (const width of widths) {
    assert.ok(
      ["640", "767", "768", "1024", "1280"].includes(width),
      `${width}px is not one of the agreed breakpoints`,
    );
  }
});

test("the text inputs are 16px and 44px, or iOS zooms and fingers miss", () => {
  /*
   * Under 16px, iOS zooms the page on focus and does not zoom back. Under 44px,
   * the target is below the floor this product holds itself to — and these are
   * controls somebody uses twelve times in a row while filling in a template.
   */
  const start = setupCss.indexOf('.compliance-template__row .form-field input[type="text"]');
  assert.ok(start > 0, "the rule must exist");
  /* To the end of the block, not a fixed character count — the declarations sit
     below an explanation and a slice that stopped short would pass on prose. */
  const rule = setupCss.slice(start, setupCss.indexOf("}", start));
  assert.match(rule, /font-size: 1rem/);
  assert.match(rule, /min-height: 2\.75rem/);
});

test("375px is the base case and the two-column layout is opt-in above 768", () => {
  /*
   * The alias box holds a comma-separated list; halving its width on a phone is
   * what makes people give up and type one name.
   */
  const twoColumn = setupCss.indexOf("grid-template-columns: 1fr 1fr");
  const query = setupCss.lastIndexOf("@media (min-width: 768px)", twoColumn);
  assert.ok(query > 0 && query < twoColumn, "two columns must live inside the 768 query");
});

test("nothing on this screen can scroll the page sideways", () => {
  /* A horizontally scrolling FORM is a form whose submit button people cannot
     find. Widths are relative and no min-width is set on anything. */
  /*
   * Media queries are the legitimate use of `min-width` and are checked by the
   * breakpoint test above; what must not appear is a min-width on an ELEMENT,
   * which is what pushes a page wider than the screen. Declarations are read
   * without the `@media (...)` conditions to tell the two apart.
   */
  const declarations = code(setupCss).replace(/@media[^{]*\{/g, "{");
  assert.doesNotMatch(declarations, /min-width:\s*\d+px/);
  assert.match(setupCss, /width: 100%/);
});

test("every message is announced, and none of them is only a colour", () => {
  /*
   * `alert` for something that failed and interrupts; `status` for something
   * that happened and does not. Both reach a reader; neither depends on being
   * able to tell amber from grey.
   */
  const alerts = setup.match(/role="alert"/g) ?? [];
  const statuses = setup.match(/role="status"/g) ?? [];
  assert.ok(alerts.length >= 3, "each of the three cards reports its own failure");
  assert.ok(statuses.length >= 3, "and its own success");
  assert.match(setupCss, /--muted/, "and the muted text is a token, not a literal");
});

test("a busy control is disabled, so a double tap cannot run a batch twice", () => {
  /* On a phone, a slow apply looks like a tap that did not register. */
  const panel = setup.slice(setup.indexOf("function BackfillPanel"));
  const disabled = panel.match(/disabled=\{busy\}/g) ?? [];
  assert.ok(disabled.length >= 3, "preview, apply and undo must all refuse a second tap");
});
