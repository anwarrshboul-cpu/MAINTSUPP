/**
 * THE PUBLIC LINK PAGES THE FORM.
 *
 * The builder could author a welcome page and page breaks; the link honoured
 * neither. It served every page as one long scroll with every question
 * answerable at once, and the builder's Preview said so on screen — "The link
 * shows all N pages as one page until the public renderer learns about page
 * breaks". This file is the guard for the batch that made that sentence false
 * and then deleted it.
 *
 * HALF OF IT RUNS AND HALF OF IT IS PINNED, on the same split the form editor's
 * two suites use. Where the form BREAKS is arithmetic — "the question after the
 * second marker is on page 2", "a page whose every question is conditional is
 * not a page until its trigger matches" — so `app/lib/form-projection.ts` is
 * transpiled and executed here against real configurations, including the
 * captured monday one. What a submitter is WALKED THROUGH is JSX and state,
 * which cannot be executed without a browser, so it is pinned as source text,
 * and every pin names the defect it prevents. Several of them protect answers
 * that would be silently lost.
 *
 * Reads normalise CRLF; this is a Windows checkout.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/* The pure modules are RUN, not read. Both keep type-only imports, which erase
   — a runtime import would not resolve from a `data:` URL, which has no base. */
async function load(file) {
  const source = await read(file);
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

/* Comments in these files explain the defects being prevented, and several
   quote the code — or the sentence — they replaced. Assertions about the CODE
   run against the source stripped of them, or an explanation reads as the thing
   it explains. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const projection = await load("app/lib/form-projection.ts");
const spec = await load("db/monday-board-spec.ts");

const RENDERER = "app/(public)/f/[token]/form-renderer.tsx";
const LINK = "app/(public)/f/[token]/public-form.tsx";
const PREVIEW = "app/(app)/portal/form-preview.tsx";

const renderer = codeOnly(await read(RENDERER));
const link = codeOnly(await read(LINK));
const preview = codeOnly(await read(PREVIEW));
const css = await read("app/(public)/f/[token]/public-form.css");

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const question = (id, extra = {}) => ({
  id,
  type: "ShortText",
  title: id,
  description: null,
  visible: true,
  required: false,
  options: null,
  showIf: null,
  ...extra,
});

const pageBlock = (id, title = "Page") => question(id, { type: "PAGE_BLOCK", title });

const configOf = (...entries) => ({
  order: entries.map((entry) => entry.id),
  questions: entries,
});

/** The whole payload, over a config that is only the parts the projection reads. */
const payloadOf = (config, extra = {}) =>
  projection.projectPublicForm(
    {
      appearance: { showProgressBar: true, submitButton: { text: null } },
      features: {
        preSubmissionView: {
          enabled: false,
          title: null,
          description: null,
          startButton: { text: null },
        },
        afterSubmissionView: {
          title: null,
          description: null,
          allowResubmit: true,
          showSuccessImage: true,
          redirectAfterSubmission: { enabled: false, redirectUrl: null },
        },
      },
      accessibility: { language: null, logoAltText: null },
      ...config,
      ...extra,
    },
    { token: "t", title: "Maintenance Request", description: null },
  );

/* ── 1. The payload carries the page breaks ──────────────────────────────── */

test("the payload says where the form breaks, which it carried nowhere before", () => {
  /*
   * THE DEFECT: `projectQuestions` drops a `PAGE_BLOCK` as "a container rather
   * than a question", and it used to drop the boundary with it. The served
   * payload therefore had no page information of any kind, and the renderer had
   * nothing to page a form BY — which is why the link showed three pages as one
   * scroll however carefully the operator had split it.
   */
  const config = configOf(
    pageBlock("pb1", "About the fault"),
    question("a"),
    question("b"),
    pageBlock("pb2", "Photographs"),
    question("c"),
  );
  const questions = projection.projectQuestions(config);
  assert.deepEqual(
    questions.map((entry) => [entry.id, entry.page]),
    [
      ["a", 0],
      ["b", 0],
      ["c", 1],
    ],
    "the leading marker opens page 0; the second one is a boundary",
  );

  /* The markers themselves still never reach a browser. */
  assert.deepEqual(
    questions.filter((entry) => entry.type === "PAGE_BLOCK"),
    [],
  );
});

test("the captured monday form is one page, and a second break makes it two", () => {
  /*
   * Run against the REAL configuration every workspace is seeded with, because
   * a page model that only works on a hand-written fixture is not one. Its
   * `order` opens with `page_block__classic_default`, which must NOT count as a
   * boundary — counting it would leave page 0 permanently empty and start every
   * form on a blank step.
   */
  const captured = spec.maintenanceFormConfiguration;
  const one = projection.projectQuestions(captured);
  assert.ok(one.length > 5, "the captured form asks a form's worth of questions");
  assert.deepEqual([...new Set(one.map((entry) => entry.page))], [0]);

  const lastId = one[one.length - 1].id;
  assert.ok(captured.order.includes(lastId), "the fixture below splits at a known position");
  const split = {
    questions: [...captured.questions, pageBlock("page_block_two", "Photographs")],
    order: captured.order.flatMap((id) => (id === lastId ? ["page_block_two", id] : [id])),
  };
  const two = projection.projectQuestions(split);

  assert.deepEqual(
    two.map((entry) => entry.id),
    one.map((entry) => entry.id),
    "a page break changes where the questions are, never which ones are asked",
  );
  assert.equal(two[two.length - 1].page, 1);
  assert.deepEqual([...new Set(two.slice(0, -1).map((entry) => entry.page))], [0]);
});

/* ── 2. A page nobody can see is not a page ──────────────────────────────── */

test("a page emptied by its answers is skipped, in both directions", () => {
  /*
   * THE DEFECT: a blank step. `visibleQuestions` hides a question whose `showIf`
   * has not matched, so a page whose questions are ALL conditional renders as a
   * card with a heading, no fields and a Next button — and it does it on the way
   * back as well as on the way forward. `askedPages` never returns an empty
   * page, so a caller stepping through the list it hands back cannot land on
   * one; there is no "skip" branch to get wrong.
   */
  const config = configOf(
    pageBlock("pb1"),
    question("trigger", { options: null }),
    pageBlock("pb2"),
    question("maybe", { showIf: { questionId: "trigger", equals: ["yes"] } }),
    pageBlock("pb3"),
    question("always"),
  );
  const questions = projection.projectQuestions(config);
  const walk = (answers) =>
    projection.askedPages(questions, answers).map((page) => page.map((entry) => entry.id));

  assert.deepEqual(walk({}), [["trigger"], ["always"]], "two steps, not three");
  assert.deepEqual(walk({ trigger: "yes" }), [["trigger"], ["maybe"], ["always"]]);
  /* Un-answering it takes the page away again — the same list, so Back skips
     it too rather than needing its own rule. */
  assert.deepEqual(walk({ trigger: "no" }), [["trigger"], ["always"]]);
});

test("a page whose every question is hidden never reaches the browser at all", () => {
  const config = configOf(
    pageBlock("pb1"),
    question("a"),
    pageBlock("pb2"),
    question("internal", { visible: false }),
    pageBlock("pb3"),
    question("c"),
  );
  const questions = projection.projectQuestions(config);
  assert.deepEqual(questions.map((entry) => entry.id), ["a", "c"]);
  assert.deepEqual(
    projection.askedPages(questions, {}).map((page) => page.map((entry) => entry.id)),
    [["a"], ["c"]],
    "the hidden page leaves a gap in the numbering, and no step in the walk",
  );
});

test("a form with no questions still has a page to draw the button on", () => {
  assert.deepEqual(projection.askedPages([], {}), [[]]);
});

/* ── 3. The welcome page and the logo's own words ────────────────────────── */

test("the welcome page and the logo description reach the link", () => {
  /*
   * `welcome` was on the projection already and the renderer's own payload type
   * simply did not declare it, so the content crossed the wire and nothing drew
   * it. `logoAlt` did not even cross: `accessibility.logoAltText` has been in
   * the stored configuration since the monday import, the Design panel has been
   * writing it, and `Shell` hard-coded `alt=""` — so a form whose logo was the
   * only thing naming the client announced itself to a screen reader as "image".
   */
  const payload = payloadOf(configOf(pageBlock("pb1"), question("a")), {
    features: {
      preSubmissionView: {
        enabled: true,
        title: "Before you start",
        description: "Two minutes.",
        startButton: { text: "Begin" },
      },
      afterSubmissionView: {
        title: null,
        description: null,
        allowResubmit: true,
        showSuccessImage: true,
        redirectAfterSubmission: { enabled: false, redirectUrl: null },
      },
    },
    accessibility: { language: null, logoAltText: "Sunnamusk UK" },
  });

  assert.deepEqual(payload.welcome, {
    enabled: true,
    title: "Before you start",
    description: "Two minutes.",
    startButton: { text: "Begin" },
  });
  assert.equal(payload.logoAlt, "Sunnamusk UK");

  /* And the renderer reads both, which is the half that was missing. */
  assert.match(renderer, /welcome: WelcomePage;/, "the payload type must declare it");
  assert.match(renderer, /logoAlt: string \| null;/);
  assert.match(renderer, /alt=\{logoAlt \?\? ""\}/, "no hard-coded empty alt");
  assert.match(renderer, /form\.welcome\.title \|\| form\.title/);
  assert.match(renderer, /form\.welcome\.startButton\.text \|\| "Start"/);
  assert.match(link, /<WelcomeScreen form=\{form\} onStart=/);
  assert.match(link, /step < 0 && form\.welcome\.enabled/);
});

/* ── 4. The link walks the pages ─────────────────────────────────────────── */

test("the link steps through the pages instead of scrolling them", () => {
  assert.match(link, /const \[step, setStep\] = useState\(-1\);/, "-1 is the welcome page");
  assert.match(link, /askedPages\(payload\.form\.questions, answers\)/);
  assert.match(link, /pagePayload\(form, pages, current\)/);
  assert.match(link, /<PageSteps/);
  /* Clamped, so an answer that removes the page under the submitter cannot
     leave `step` pointing past the end of the walk. */
  assert.match(link, /Math\.min\(Math\.max\(step, 0\), pages\.length - 1\)/);
  /* A single-page form is decided in ONE place, so neither mount can forget to
     hide the stepper on the overwhelming majority of forms. */
  assert.match(renderer, /if \(pages < 2\) return null;/);
});

test("the button that is not a submit says where it goes", () => {
  /*
   * A button that says "Submit" and then does not submit is the worst thing a
   * paginated form can do — the submitter presses it, something scrolls, and
   * they cannot tell whether they have reported the fault. The label lives with
   * the page payload, once, so the link and the Preview say the same thing.
   */
  assert.match(renderer, /`Next — page \$\{index \+ 2\} of \$\{pages\.length\}`/);
  assert.match(renderer, /questions: pages\[index\] \?\? \[\]/);
});

test("submit only submits on the last page", () => {
  /*
   * THE DEFECT: posting a half-finished form. `onSubmit` on any earlier page
   * must advance instead, and it must do that BEFORE anything that sends.
   */
  const advance = link.indexOf("if (!last) {");
  const send = link.indexOf('setState("sending")');
  const post = link.indexOf("/submit`");
  assert.ok(advance > 0, "the handler must have an advance branch");
  assert.ok(advance < send && advance < post, "advancing must precede sending");
  assert.match(link, /if \(!last\) \{\s*goTo\(current \+ 1\);\s*return;\s*\}/);

  /* And native validation is not defeated on the way: the mounted required
     fields of the current page are exactly what should block a Next. */
  assert.doesNotMatch(link, /noValidate/);
  assert.doesNotMatch(renderer, /noValidate/);
});

/* ── 5. Nothing a submitter typed is lost ────────────────────────────────── */

test("one answers object for the whole form, and the whole of it is posted", () => {
  /*
   * THE DEFECT, twice over. Answers live in ONE lifted state keyed by question
   * id, so unmounting a page's fields loses nothing and Back finds page 1 as it
   * was. And the submit posts that object whole: this file has been bitten
   * before by a browser that translated to a fixed seven-field shape and
   * "silently dropped answers to the other twelve questions".
   */
  assert.equal(
    (link.match(/useState<Record<string, string>>\(\{\}\)/g) ?? []).length,
    1,
    "a second answers state is a page's answers waiting to be thrown away",
  );
  assert.match(link, /body: JSON\.stringify\(\{ answers, fileCount: files\.length \}\)/);
  /* Cleared exactly once, on the way to the thank-you screen — never on a page
     move. */
  assert.equal((link.match(/setAnswers\(\{\}\)/g) ?? []).length, 1);
  assert.equal((link.match(/setFiles\(\[\]\)/g) ?? []).length, 1);
  assert.ok(link.indexOf("setAnswers({})") > link.indexOf('setState("done")'));

  /* Back is a step, not a reset. */
  assert.match(link, /onBack=\{current > 0 \? \(\) => goTo\(current - 1\) : null\}/);
});

test("a required File question is checked on its own page and again at the end", () => {
  /*
   * THE DEFECT: files are ONE list for the whole form while File questions sit
   * on pages, so a per-page check alone strands the requirement on a page the
   * submitter has left, and an end-only check names a field that is no longer
   * on screen. Both are asked, and both go through `askedQuestions` — the rule
   * the submit route applies — so a File question whose `showIf` never matched
   * is not demanded of somebody who was never shown it.
   */
  assert.match(link, /fileProblem\(last \? payload\.form\.questions : pages\[current\]\)/);
  assert.match(link, /askedQuestions\(scope, answers\)/);
  assert.match(link, /question\.type === "File" && question\.required/);

  /* The upload path itself is untouched: /api/files has exactly one caller. */
  assert.match(link, /uploadEvidenceFile\(/);
  assert.doesNotMatch(link, /fetch\("\/api\/files/);
});

/* ── 6. One implementation, two mounts ───────────────────────────────────── */

test("the Preview and the link page the form with the same functions", () => {
  /*
   * The whole reason `form-renderer.tsx` and `form-projection.ts` exist: the
   * preview an operator checks and the page a submitter opens must be one
   * implementation. Pages could easily have been the exception — the Preview
   * had them first — so both mounts are asserted to call the same split and
   * build the same page payload.
   */
  for (const [name, source] of [["the link", link], ["the Preview", preview]]) {
    assert.match(source, /askedPages\(/, `${name} must split with the shared function`);
    assert.match(source, /pagePayload\(/, `${name} must build the page payload with it`);
    assert.match(source, /<PageSteps/, `${name} must draw the shared stepper`);
    assert.match(source, /progressOver=/, `${name} measures the whole form, not the page`);
  }
  assert.match(preview, /<WelcomeScreen form=\{payload\} onStart=/);

  /* And "is this question asked" is one function, not two identical ones: the
     page walk decides emptiness by the same rule `FormBody` filters fields by,
     or a page can be judged worth showing and then render nothing. */
  assert.match(renderer, /export const visibleQuestions = askedQuestions;/);
});

test("the Preview no longer says the link cannot do this", () => {
  /*
   * The sentence this batch existed to falsify. It is asserted gone from what
   * the component RENDERS — the header still quotes it, because a note that was
   * on screen for a release is worth explaining rather than erasing.
   */
  assert.doesNotMatch(preview, /learns about page breaks/);
  assert.doesNotMatch(preview, /as one page/);
  assert.doesNotMatch(preview, /pageIndexById/, "the page index moved to the projection");
});

/* ── 7. The chrome a paged form adds ─────────────────────────────────────── */

test("the stepper and the welcome page are styled by the form's own palette", () => {
  /*
   * This route loads no shared stylesheet, so a rule that reached for an app
   * token would be unstyled on the link — which is how the Preview's own
   * stepper was written, in builder tokens, before it became shared.
   */
  const steps = css.slice(css.indexOf(".pf__steps {"), css.indexOf(".pf__welcome {"));
  assert.ok(steps.length > 0, "the stepper must be styled");
  assert.match(steps, /min-height:\s*44px/, "Back is a tap target on a phone");
  for (const value of steps.match(/#[0-9a-f]{3,8}\b/gi) ?? []) {
    assert.fail(`the stepper hard-codes ${value} instead of using a --pf token`);
  }
  /* The one glyph in the set points forward, so Back is it reversed — and
     reversed back again in a right-to-left form, which `Shell` really does
     re-lay-out. */
  assert.match(css, /\[dir="rtl"\] \.pf__steps button svg/);
  assert.match(css, /\.pf__welcome \{/);
});
