/**
 * The form editor's SURFACE — the contracts that live in JSX and CSS.
 *
 * The arithmetic is in `form-editor-model.test.mjs`, which transpiles the pure
 * modules and runs them. What is left here cannot be executed without a
 * browser, so it is pinned as source text, which is how the rest of this suite
 * proves a responsive rule or a rendering decision.
 *
 * EVERY PIN NAMES THE DEFECT IT PREVENTS. If a refactor moves one of these,
 * re-point it at the contract's new home with the reason written in — that is
 * this repository's rule and these are exactly the assertions it was written
 * for: several of them protect a fix that is invisible in a screenshot.
 *
 * Reads normalise CRLF; this is a Windows checkout.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/* Comments in these files explain the defects being prevented, and several
   quote the code they replaced. Assertions about the CODE run against the
   source stripped of them, or an explanation reads as the thing it explains. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const shell = codeOnly(await read("app/(app)/portal/form-builder.tsx"));
const panel = codeOnly(await read("app/(app)/portal/form-edit-panel.tsx"));
const card = codeOnly(await read("app/(app)/portal/form-question-card.tsx"));
const picker = codeOnly(await read("app/(app)/portal/form-field-picker.tsx"));
const panels = codeOnly(await read("app/(app)/portal/form-builder-panels.tsx"));
const activity = codeOnly(await read("app/(app)/portal/form-activity.tsx"));
const preview = codeOnly(await read("app/(app)/portal/form-preview.tsx"));
const saver = codeOnly(await read("app/(app)/portal/form-builder-save.ts"));
const css = await read("app/(app)/portal/form-builder.css");

/* ── 1. The Content panel offers every column, not a subset ──────────────── */

test("the builder asks the board for ALL of its columns", async () => {
  /*
   * THE DEFECT. The Content panel could only ever offer the questions already
   * in the stored configuration, so a column added to the board after the form
   * was created was unreachable from the builder — there was no control
   * anywhere that could put it on the form. `/api/board/form` carries the form
   * and the board's groups and no columns; `GET /api/board/columns` has always
   * returned every live column, scoped to (organisation, board), in the board's
   * own order.
   */
  assert.match(
    shell,
    /fetch\(`\/api\/board\/columns\?board=\$\{encodeURIComponent\(boardId\)\}`/,
    "the shell must fetch the target board's columns",
  );
  /* Same rule as the form's own load: a closure that reads `boardId` must be
     rebuilt when the board changes, or the picker offers another register's
     columns and a question gets bound to a column this board does not have. */
  const effect = shell.slice(shell.indexOf("/api/board/columns"));
  assert.match(
    effect.slice(0, 700),
    /\}, \[boardId\]\);/,
    "the columns effect must depend on the board",
  );
  assert.match(shell, /columns=\{columns\}/, "and the Edit panel is handed them");
});

test("the picker lists the columns already on the form as well as the ones that are not", async () => {
  /*
   * A list that silently omits what is already asked cannot answer "why isn't
   * Cost of Works on here?" — the honest answer is "it is, further down". Both
   * groups are drawn; the second is disabled rather than hidden.
   */
  assert.match(picker, /optgroup label="Not on the form yet"/);
  assert.match(picker, /optgroup label="Already on the form"/);
  assert.match(picker, /taken\.map\(\(column\) => \(/);
});

/* ── 2. Collapsed question cards ─────────────────────────────────────────── */

test("a question card is collapsed until it is opened, and opening it is a disclosure", async () => {
  assert.match(panel, /collapsed=\{!open\[question\.id\]\}/, "collapsed is the default state");
  assert.match(card, /aria-expanded=\{false\}/, "the collapsed row announces itself");
  assert.match(card, /aria-expanded=\{!collapsed\}/, "and so does the disclosure button");
  assert.match(card, /aria-controls=\{bodyId\}/, "both point at the body they open");
});

test("a collapsed card is hidden, not unmounted", async () => {
  /*
   * The body holds state — a half-typed description inside a `DraftInput`, an
   * expanded option list — and unmounting would throw it away every time
   * somebody collapsed a card to look at the one below it. `hidden` also takes
   * the body out of the accessibility tree, which a `max-height: 0` would not.
   */
  assert.match(card, /className="form-edit__cardbody" id=\{bodyId\} hidden=\{collapsed\}/);
  assert.doesNotMatch(
    card,
    /\{!collapsed && \(\s*<div className="form-edit__cardbody"/,
    "an unmounted body loses a half-typed answer every time a card is collapsed",
  );
});

/* ── 3. Insertion at a chosen position ───────────────────────────────────── */

test("a question can be added at any position, not only at the end", async () => {
  assert.match(panel, /<InsertRow\s+slotIndex=\{index\}/, "between every pair of questions");
  assert.match(panel, /<InsertRow\s+slotIndex=\{endSlot\}/, "and at the end of each page");
  assert.match(panel, /orderSlots\(config\)/, "the positions come from the shared slot list");
});

test("the insertion control is a top-level component, or its picker loses focus", async () => {
  /*
   * A component declared inside another component's body is a NEW component
   * type on every render, so React unmounts and remounts its whole subtree each
   * time the panel re-renders — which for this one means the select closes
   * while somebody is choosing from it. Invisible in a screenshot; fatal in use.
   */
  assert.match(panel, /^function InsertRow\(\{/m, "declared at the top level");
  assert.doesNotMatch(
    panel,
    /^ {2}function InsertRow\(/m,
    "never nested inside FormEditPanel — that remounts the picker on every render",
  );
});

/* ── 4. Drag, AND an explicit accessible move ────────────────────────────── */

test("reordering works by pointer, by arrow key and by an explicit menu", async () => {
  /*
   * Drag-and-drop has no keyboard equivalent in any browser, so a pointer-only
   * reorder is a reorder half the audience cannot perform. All three gestures
   * write the same flat `order` array.
   */
  assert.match(card, /draggable\n/, "the handle is the draggable part, not the whole card");
  assert.match(card, /onDragStart=\{\(event\) => \{/);
  assert.match(card, /event\.dataTransfer\.setData\("text\/plain", question\.id\)/);

  assert.match(card, /if \(event\.key === "ArrowUp"\)/, "keyboard reorder on the handle");
  assert.match(card, /event\.key === "ArrowDown"/);
  assert.match(card, /event\.key === "Home"/, "and a way to reach the ends without N presses");
  assert.match(card, /event\.key === "End"/);

  const moveTo = card.slice(card.indexOf("<span>Move to</span>"));
  assert.match(moveTo.slice(0, 700), /slots\.map\(\(slot\) => \(/, "Move to… lists the named slots");
  assert.match(moveTo.slice(0, 700), /moveTo\(question\.id, target\)/);
});

test("the drag handle is a real control with an accessible name", async () => {
  const handle = card.slice(card.indexOf('className="form-edit__handle"'));
  assert.match(handle.slice(0, 900), /aria-label=\{`Reorder \$\{question\.title\}/);
  assert.doesNotMatch(
    handle.slice(0, 900),
    /aria-hidden/,
    "hiding the handle would take the keyboard reorder with it",
  );
});

/* ── 5. Type-specific settings, and no dead ones ─────────────────────────── */

test("each question type exposes the settings that actually do something", async () => {
  assert.match(card, /question\.type === "Date" \|\| question\.type === "DateRange"/);
  assert.match(card, /defaultCurrentDate/);
  assert.match(card, /includeTime/);
  assert.match(card, /question\.type === "SingleSelect"/);
  assert.match(card, /optionsOrder/);
  assert.match(
    card,
    /question\.type === "ShortText" \|\|\s*question\.type === "LongText" \|\|\s*question\.type === "Number"/,
    "Number takes a pre-fill too — `resolvePrefill` returns `defaultAnswer` for it",
  );
  /* `showIf` has been in the stored configuration all along and no control has
     ever set it, while `askedQuestions()` has honoured it on BOTH the renderer
     and the submit route. The only missing piece was a way to say it. */
  assert.match(card, /<span>Only ask this when<\/span>/);
  assert.match(card, /showIf: \{ questionId, equals: first \? \[first\.value\] : \[\] \}/);
});

test("no setting is drawn for a type this build honours nothing for", async () => {
  /*
   * The rule the panel already stated and this keeps: "a `today as default`
   * switch on a text question would be a control that does nothing, which is
   * the thing being fixed". File, Person and Sub-items have no honoured
   * setting, so they get no settings block rather than a disabled one.
   */
  const settings = card.slice(
    card.indexOf('className="form-edit__settings"'),
    card.indexOf('question.type === "SingleSelect" && ('),
  );
  for (const type of ["File", "People", "Subitems"]) {
    assert.doesNotMatch(
      settings,
      new RegExp(`question\\.type === "${type}"`),
      `${type} has no honoured setting, so it must not be given a dead control`,
    );
  }
});

/* ── 6. Intake warnings ──────────────────────────────────────────────────── */

test("the editor says when the form could not actually file a job", async () => {
  assert.match(panel, /intakeWarnings\(\{/, "the report is computed from the configuration");
  assert.match(panel, /className="form-edit__intake"/, "and shown at the top of the canvas");
  assert.match(panel, /This form cannot file a job as it stands/);
  /* Per-question problems are marked on the question, not only counted. */
  assert.match(panel, /warnings=\{warningsByQuestion\.get\(question\.id\) \?\? \[\]\}/);
  assert.match(card, /className="form-edit__cardwarn"/);
});

/* ── 7. One field picker, reused ─────────────────────────────────────────── */

test("there is exactly one field picker and every caller uses it", async () => {
  assert.equal(
    (picker.match(/export function FormFieldPicker/g) ?? []).length,
    1,
    "one component",
  );
  for (const [name, source] of [
    ["form-edit-panel.tsx", panel],
    ["form-question-card.tsx", card],
  ]) {
    assert.match(
      source,
      /import \{ FormFieldPicker \} from "\.\/form-field-picker"/,
      `${name} must use the shared picker rather than its own select`,
    );
  }
  /* And nobody hand-rolls a second one: a `<select>` mapping the column list is
     the shape this component exists to be the only instance of. */
  for (const [name, source] of [
    ["form-edit-panel.tsx", panel],
    ["form-question-card.tsx", card],
  ]) {
    assert.doesNotMatch(
      source,
      /columns\.map\(\(column\) => \(\s*<option/,
      `${name} must not build its own column dropdown`,
    );
  }
});

/* ── 8. Multi-page forms ─────────────────────────────────────────────────── */

test("pages come from the shared page model, and reordering no longer hoists them", async () => {
  /*
   * THE DEFECT THIS REPLACED, verbatim from the old panel:
   *
   *     const pageBlocks = form.config.order.filter(… type === "PAGE_BLOCK" …);
   *     patch({ order: [...pageBlocks, ...order] });
   *
   * Correct with one page block; with two it hoists both to the front, page two
   * loses its break and every question lands on page one. Every reorder now
   * goes through the flat order WITH the markers in it.
   */
  assert.match(panel, /pagesOf\(config\)/);
  assert.doesNotMatch(
    panel,
    /\[\.\.\.pageBlocks, \.\.\.order\]/,
    "hoisting the page blocks to the front is what collapsed a multi-page form",
  );
  assert.match(panel, /patch\(\{ order: nudge\(order, id, direction\) \}\)/);
  assert.match(panel, /patch\(\{ order: moveTo\(order, id, slotIndex\) \}\)/);
  assert.match(panel, /className="form-edit__addpage"/, "and a page can be added");
  assert.match(panel, /removePageBlock\(config, pageId\)/, "and removed");
});

test("a page break persists inside sections PATCH already accepts", async () => {
  /*
   * The reason multi-page needed no route change and put no new hole in the
   * undo contract: a page is a `PAGE_BLOCK` question in `questions` and an id
   * in `order`, and both are already sections of `PatchBody` AND of
   * `formUndoBody()`. `tests/form-undo.test.mjs` reads the two lists and fails
   * the day they disagree — so this is the assertion that says the page model
   * deliberately stayed inside them.
   */
  const route = await read("app/api/board/form/route.ts");
  const declared = route.match(/type PatchBody = \{([\s\S]*?)\n\};/);
  assert.ok(declared, "PatchBody must still be the declared shape of a save");
  const sections = [...declared[1].matchAll(/^\s{2}(\w+)\?:/gm)].map((match) => match[1]);
  for (const write of [...panel.matchAll(/patch\(\{\s*([A-Za-z]+)/g)].map((m) => m[1])) {
    assert.ok(
      sections.includes(write),
      `the Edit panel writes "${write}", which PATCH /api/board/form does not accept`,
    );
  }
  const undone = saver.match(/export function formUndoBody[\s\S]*?\n\}/)[0];
  for (const write of ["questions", "order", "features", "appearance", "accessibility"]) {
    assert.ok(undone.includes(`${write}:`), `${write} must still be restorable by Undo`);
  }
});

/*
 * THIS TEST'S THREE PINS ALL MOVED, and the test is stronger for it.
 *
 * They used to name what the preview did BY ITSELF while the public link could
 * not page a form at all: `pageIndexById(form.config)`, its own
 * `questions: pages[current]` payload, and its own "Next — page N of M" label.
 * The link pages now, so the split went to `askedPages` in
 * app/lib/form-projection.ts and the page payload — label included — went to
 * `pagePayload` in form-renderer.tsx. The pins moved with them AND gained the
 * other half: the two mounts are asserted to call the same functions, which is
 * the difference between one implementation and two that agree by inspection.
 */
test("the preview pages the form with the same function a renderer would", async () => {
  const renderer = codeOnly(await read("app/(public)/f/[token]/form-renderer.tsx"));
  const link = codeOnly(await read("app/(public)/f/[token]/public-form.tsx"));

  assert.match(preview, /askedPages\(payload\.questions, answers\)/);
  assert.match(link, /askedPages\(payload\.form\.questions, answers\)/);

  assert.match(renderer, /questions: pages\[index\] \?\? \[\]/, "one page's questions per step");
  assert.match(renderer, /`Next — page \$\{index \+ 2\} of \$\{pages\.length\}`/);
  assert.match(preview, /pagePayload\(payload, pages, current\)/);
  assert.match(link, /pagePayload\(form, pages, current\)/);

  /* Composed from what the renderer already exports rather than forked: one
     implementation of the layout, the progress bar and the file picker. */
  assert.match(preview, /from "\.\.\/\.\.\/\(public\)\/f\/\[token\]\/form-renderer"/);
  assert.doesNotMatch(preview, /<iframe/i, "X-Frame-Options: DENY is deliberate");
});

/* ── 9. The welcome page ─────────────────────────────────────────────────── */

test("the welcome page is configurable and previewed", async () => {
  assert.match(panels, /title="Welcome page"/);
  assert.match(panels, /preSubmissionView: \{ \.\.\.features\.preSubmissionView, enabled: next \}/);
  assert.match(panels, /startButton: \{ text: next\.trim\(\) \|\| null \}/);
  /* Drawn in the SAME Shell as the form, so it inherits the accent, the
     background, the logo and the language rather than restating any of them —
     and drawn by `WelcomeScreen` in the RENDERER since the public link learnt
     to show it, so this pin names that one home rather than the preview's own
     copy of the markup. The fallback heading moved with it, which is the part
     most likely to have drifted between two copies. */
  const renderer = codeOnly(await read("app/(public)/f/[token]/form-renderer.tsx"));
  assert.match(renderer, /form\.welcome\.startButton\.text \|\| "Start"/);
  assert.match(renderer, /form\.welcome\.title \|\| form\.title/);
  assert.match(preview, /<WelcomeScreen form=\{payload\} onStart=/);
  assert.match(preview, /step < 0 && welcome\.enabled/);
  /* And the link shows it, which is what the preview was previewing. */
  const link = codeOnly(await read("app/(public)/f/[token]/public-form.tsx"));
  assert.match(link, /step < 0 && form\.welcome\.enabled/);
  assert.match(link, /<WelcomeScreen form=\{form\} onStart=/);
});

/* ── 10. Design and Settings completion ──────────────────────────────────── */

test("the Design panel offers the appearance fields the renderer honours", async () => {
  /* `Shell` assigns `appearance.text.color` to `--pf-ink` and always has; no
     control ever set it, so a dark Background left the text unreadable. */
  assert.match(panels, /<span>Text colour<\/span>/);
  assert.match(panels, /text: \{ \.\.\.appearance\.text, color: event\.target\.value \}/);
  assert.match(panels, /Reset the text to the default ink/);
  /* Recorded-but-not-yet-rendered settings say so, as this panel already does
     for Save as draft, reCAPTCHA and AI translation. */
  assert.match(panels, /<span>Logo description<\/span>/);
  assert.match(panels, /logoAltText: next\.trim\(\) \|\| null/);
});

test("the Settings panel offers the confirmation screen the renderer draws", async () => {
  assert.match(panels, /<span>Confirmation heading<\/span>/);
  assert.match(panels, /<span>Confirmation message<\/span>/);
  assert.match(panels, /label="Success image"/);
  assert.match(panels, /showSuccessImage: next/);
});

/* ── 11. The activity log ────────────────────────────────────────────────── */

test("the editor lists what it has saved, from the same record Undo uses", async () => {
  assert.match(saver, /export function changedSections\(/);
  assert.match(saver, /const sections = changedSections\(restorePoint, settled\);/);
  /* Appended under exactly the condition a history step is pushed, so the log
     and Undo cannot disagree about what happened. */
  const success = saver.slice(saver.indexOf("setUndoable({ depth: history.current.length"));
  assert.match(success.slice(0, 500), /setLog\(\(current\) =>/);
  assert.match(shell, /mode === "activity" && <FormActivity log=\{saver\.log\}/);
  /* It LISTS. Undo restores, is board-scoped and is covered by 35 tests; a
     second restore path would be a second implementation of the hardest thing
     in this editor. */
  assert.doesNotMatch(activity, /onRestore|patch\(/, "the activity log is a read");
  assert.match(
    activity,
    /does\s+not yet keep a permanent record of form changes/,
    "and it says what it is not",
  );
});

test("the log belongs to one register, exactly as the history does", async () => {
  const reset = saver.slice(saver.indexOf("if (historyBoard.current !== boardId)"));
  assert.match(
    reset.slice(0, 260),
    /setLog\(\[\]\)/,
    "one board's changes must never be listed under another board's name",
  );
});

/* ── 12. Bindings are addressed by column id ─────────────────────────────── */

test("a question is bound to a column by ID, never by label or index", async () => {
  /*
   * By label: a column title is edited from the board's own header menu by
   * somebody not thinking about a form, and `syncQuestionAndColumnsTitles`
   * exists to rename questions when it happens — a label binding would silently
   * re-point or break. By index: a column added, deleted or dragged shifts
   * every index after it, so today's answers file into yesterday's column.
   */
  assert.match(picker, /<option key=\{column\.id\} value=\{column\.id\}/);
  assert.match(picker, /value=\{current\?\.id \?\? ""\}/);
  assert.match(picker, /columns\.find\(\(entry\) => entry\.id === event\.target\.value\)/);
  assert.doesNotMatch(
    picker,
    /value=\{column\.title\}|value=\{index\}/,
    "a binding by title or by position is the defect this control exists to prevent",
  );
  assert.match(panel, /questionIdForColumn\(column\)/, "and the id follows from the column");
});

test("a system column is only offerable through a canonical question", async () => {
  /*
   * A system column's value is a field on `maintenance_requests` written by the
   * routes that own that record, so a derived question pointed at one collects
   * an answer with no cell to hold it. `deriveFormQuestions` refuses them for
   * the same reason; here they are shown disabled with the reason attached
   * rather than quietly missing.
   */
  assert.match(
    picker,
    /!column\.system \|\| Boolean\(CANONICAL_QUESTION_BY_COLUMN_KEY\[column\.key\]\)/,
  );
  assert.match(picker, /filled by the system/);
});

/* ── 13. 375px, and reachable by keyboard ────────────────────────────────── */

test("every new control clears the 44px touch floor on a phone", async () => {
  const narrow = css.slice(css.indexOf("@media (max-width: 767px)"));
  for (const selector of [
    ".form-edit__handle,",
    ".form-edit__insertbtn,",
    ".form-picker__select,",
  ]) {
    const at = narrow.indexOf(selector);
    assert.notEqual(at, -1, `${selector} must be sized for a finger in the phone block`);
  }
  const rule = narrow.slice(narrow.indexOf(".form-edit__handle,"));
  assert.match(rule.slice(0, 400), /min-height:\s*44px/);
});

test("nothing the phone needs lives only in the Content rail", async () => {
  /*
   * The rail is `display: none` below 768px and stays that way — it is an
   * OUTLINE, and the stylesheet has always said so. That is only true while
   * every control lives on the canvas, which is what this checks: a control
   * that existed only in the rail would have quietly made this editor
   * desktop-only again, which is the rule the owner asked to have reversed.
   */
  const rail = panel.slice(
    panel.indexOf('<aside className="form-edit__content"'),
    panel.indexOf('<div className="form-edit__canvas">'),
  );
  for (const control of ["InsertRow", "FormFieldPicker", "form-edit__addpage", "removePage("]) {
    assert.ok(!rail.includes(control), `${control} must be on the canvas, not only in the rail`);
  }
  /* The rail's rows are still navigable by keyboard: they are buttons. */
  assert.match(rail, /<button type="button" onClick=\{\(\) => reveal\(question\.id\)\}>/);
});

test("the card head wraps at 375px rather than shrinking seven targets", async () => {
  const narrow = css.slice(css.indexOf("@media (max-width: 767px)"));
  const head = narrow.slice(narrow.indexOf(".form-edit__cardhead {"));
  assert.match(head.slice(0, 160), /flex-wrap:\s*wrap/);
});

test("every control the editor adds carries an accessible name", async () => {
  /* A `<select>` with no label is unusable by a screen reader, and three of the
     new controls are selects. The picker's is required by its own props type. */
  assert.match(picker, /label: string;/);
  assert.match(picker, /<label className="form-picker__label" htmlFor=\{selectId\}>/);
  assert.match(panel, /label=\{`Add a question before \$\{question\.title\}`\}/);
  assert.match(card, /aria-label=\{collapsed \? `Edit \$\{question\.title\}`/);
  assert.match(panel, /aria-label=\{`Name for page \$\{page\.number\}`\}/);
  /* And focus is visible on each of them. */
  for (const selector of [
    ".form-picker__select:focus-visible",
    ".form-edit__handle:focus-visible",
    ".form-edit__insertbtn:focus-visible",
    ".form-edit__cardname:focus-visible",
    ".form-edit__content li button:focus-visible",
  ]) {
    assert.ok(css.includes(selector), `${selector} must have a visible focus ring`);
  }
});
