/**
 * The form editor's three pure modules, RUN rather than read.
 *
 * Most of this suite matches source text, and for good reason — it is how a
 * repository with no browser proves a contract about JSX or CSS. But the page
 * model and the intake report are ARITHMETIC and RULES: "moving a question down
 * to slot 7 puts it at slot 7", "a Manager question that is asked but not
 * required is refused by the submit route". A regular expression cannot tell
 * whether either is true. So these three modules were written with only
 * type-only imports — the same discipline `app/lib/form-projection.ts` follows
 * — and are transpiled to a `data:` module and executed here.
 *
 * The one thing that is still a source pin is the duplicated canonical map, and
 * it is pinned in both directions: see the last test.
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

async function load(file) {
  const source = await read(file);
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const pages = await load("app/(app)/portal/form-pages.ts");
const intake = await load("app/(app)/portal/form-intake-warnings.ts");
const bindings = await load("app/(app)/portal/form-bindings.ts");

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

/** The shape every captured configuration has: one page block, then questions. */
function onePage() {
  return {
    order: ["pb1", "a", "b", "c"],
    questions: [pageBlock("pb1"), question("a"), question("b"), question("c")],
  };
}

function twoPages() {
  return {
    order: ["pb1", "a", "b", "pb2", "c"],
    questions: [
      pageBlock("pb1", "About the fault"),
      question("a"),
      question("b"),
      pageBlock("pb2", "Photographs"),
      question("c"),
    ],
  };
}

/* ── fullOrder ───────────────────────────────────────────────────────────── */

test("the flat order drops a dangling id and never loses an unordered question", () => {
  const config = {
    /* `gone` is what a delete leaves behind if the order is not sent with it. */
    order: ["pb1", "gone", "a"],
    questions: [pageBlock("pb1"), question("a"), question("late")],
  };
  assert.deepEqual(pages.fullOrder(config), ["pb1", "a", "late"]);
});

test("a duplicated id in the stored order is kept once", () => {
  const config = { order: ["a", "a"], questions: [question("a")] };
  assert.deepEqual(pages.fullOrder(config), ["a"]);
});

/* ── The page model ──────────────────────────────────────────────────────── */

test("the captured single-page shape is one page, not two", () => {
  /*
   * The regression this pins. Every captured configuration begins with
   * `page_block__classic_default`, so a page model that treated a leading block
   * as a BOUNDARY would report an empty page 1 followed by the real one, and
   * the canvas would draw a heading over nothing on every form in the product.
   */
  const model = pages.pagesOf(onePage());
  assert.equal(model.length, 1);
  assert.equal(model[0].number, 1);
  assert.deepEqual(
    model[0].questions.map((entry) => entry.id),
    ["a", "b", "c"],
  );
});

test("a second page block starts a second page", () => {
  const model = pages.pagesOf(twoPages());
  assert.equal(model.length, 2);
  assert.equal(model[0].title, "About the fault");
  assert.deepEqual(model[0].questions.map((entry) => entry.id), ["a", "b"]);
  assert.equal(model[1].title, "Photographs");
  assert.deepEqual(model[1].questions.map((entry) => entry.id), ["c"]);
});

test("questions before any page block still belong to a page", () => {
  const config = { order: ["a", "pb1", "b"], questions: [question("a"), pageBlock("pb1"), question("b")] };
  const model = pages.pagesOf(config);
  assert.equal(model.length, 2);
  assert.equal(model[0].id, null, "the implicit page has no block of its own");
  assert.deepEqual(model[0].questions.map((entry) => entry.id), ["a"]);
});

test("pageIndexById agrees with pagesOf, which is what lets a renderer page a form", () => {
  for (const config of [onePage(), twoPages()]) {
    const index = pages.pageIndexById(config);
    pages.pagesOf(config).forEach((page, position) => {
      for (const entry of page.questions) {
        assert.equal(index.get(entry.id), position, `${entry.id} is on page ${position}`);
      }
    });
  }
});

/* ── Slots ───────────────────────────────────────────────────────────────── */

test("the slots name every position once, and only once", () => {
  const slots = pages.orderSlots(twoPages());
  assert.deepEqual(
    slots.map((slot) => [slot.index, slot.label]),
    [
      [1, "Before “a”"],
      [2, "Before “b”"],
      /* The position before a page break IS "the end of the page above it" —
         offered once under that name, not twice under two. */
      [3, "At the end of page 1"],
      [4, "Before “c”"],
      [5, "At the end of page 2"],
    ],
  );
});

test("a single-page form's last slot is not called page 1", () => {
  const slots = pages.orderSlots(onePage());
  assert.equal(slots[slots.length - 1].label, "At the end");
});

/* ── Moving ──────────────────────────────────────────────────────────────── */

test("moving a question DOWN lands on the slot it names, not one short of it", () => {
  /*
   * The off-by-one this exists to hold. A slot index is read against the order
   * as it stands; removing the entry first shifts everything after it left by
   * one. Without the correction in `moveTo`, every downward move landed one
   * place early and the control looked broken in exactly the case people use
   * it for.
   */
  const order = pages.fullOrder(onePage());
  assert.deepEqual(pages.moveTo(order, "a", 4), ["pb1", "b", "c", "a"]);
});

test("moving a question UP lands on the slot it names", () => {
  const order = pages.fullOrder(onePage());
  assert.deepEqual(pages.moveTo(order, "c", 1), ["pb1", "c", "a", "b"]);
});

test("Move to can cross a page break in one gesture", () => {
  const config = twoPages();
  const moved = pages.moveTo(pages.fullOrder(config), "a", 5);
  const after = pages.pagesOf({ order: moved, questions: config.questions });
  assert.deepEqual(after[0].questions.map((entry) => entry.id), ["b"]);
  assert.deepEqual(after[1].questions.map((entry) => entry.id), ["c", "a"]);
});

test("nudging counts a page break as a place, so arrow keys can cross one", () => {
  const config = twoPages();
  /* `b` is immediately before pb2; one nudge down swaps them and puts b on
     page 2. The old swap-with-page-blocks-stripped implementation could not
     express this at all. */
  const moved = pages.nudge(pages.fullOrder(config), "b", 1);
  assert.deepEqual(moved, ["pb1", "a", "pb2", "b", "c"]);
});

test("a nudge past either end is a no-op rather than a corruption", () => {
  const order = pages.fullOrder(onePage());
  assert.deepEqual(pages.nudge(order, "pb1", -1), order);
  assert.deepEqual(pages.nudge(order, "c", 1), order);
  assert.deepEqual(pages.nudge(order, "nobody", 1), order);
});

test("inserting puts a new id exactly at the slot", () => {
  const order = pages.fullOrder(onePage());
  assert.deepEqual(pages.insertAt(order, "new", 2), ["pb1", "a", "new", "b", "c"]);
  assert.deepEqual(pages.insertAt(order, "new", 99), ["pb1", "a", "b", "c", "new"]);
});

/* ── Removing a page ─────────────────────────────────────────────────────── */

test("removing a page break MERGES its questions upwards, it does not delete them", () => {
  /*
   * The safety property of the whole page model. A page is a marker in the
   * flat order, so dropping the marker leaves every question exactly where it
   * was — which is what "remove page break" has to mean, because the
   * alternative silently deletes an operator's questions.
   */
  const next = pages.removePageBlock(twoPages(), "pb2");
  assert.deepEqual(next.order, ["pb1", "a", "b", "c"]);
  assert.equal(next.questions.length, 4);
  const model = pages.pagesOf(next);
  assert.equal(model.length, 1);
  assert.deepEqual(model[0].questions.map((entry) => entry.id), ["a", "b", "c"]);
});

test("a new page block is a question with monday's own type", () => {
  const block = pages.newPageBlock("Photographs", "123");
  assert.equal(block.type, "PAGE_BLOCK");
  assert.equal(block.title, "Photographs");
  assert.match(block.id, /^page_block_/);
  /* An empty name is not allowed to produce a nameless heading. */
  assert.equal(pages.newPageBlock("   ", "1").title, "Page");
});

/* ── The intake report ───────────────────────────────────────────────────── */

const LOCATION = "single_selecty9rcyhe";
const MANAGER = "short_text64";
const CONTACT = "numbertb4g1z46";
const DESCRIPTION = "short_text";

/** A job-board form that passes every rule, as the baseline to break. */
function healthyJobForm() {
  return {
    config: {
      order: ["pb1", LOCATION, MANAGER, CONTACT, DESCRIPTION],
      questions: [
        pageBlock("pb1"),
        question(LOCATION, { type: "SingleSelect", title: "Location", required: true }),
        question(MANAGER, { title: "Manager", required: true }),
        question(CONTACT, { type: "Number", title: "Contact number", required: true }),
        question(DESCRIPTION, { title: "Description", required: true }),
      ],
    },
    boundIds: null,
    optionOverrides: { [LOCATION]: [{ label: "Aldgate", value: "site_1" }] },
    filesIntoThisBoard: true,
    active: true,
    closeAt: null,
    responseLimit: null,
    responseCount: 0,
  };
}

const ids = (warnings) => warnings.map((warning) => warning.id);

test("a healthy job-board form reports nothing", () => {
  assert.deepEqual(intake.intakeWarnings(healthyJobForm()), []);
});

test("a question the server demands but the form calls optional is BLOCKING", () => {
  /*
   * Trap 1, and the reason this feature exists. `app/api/forms/[token]/submit`
   * refuses a blank Location, Manager or Contact number WHENEVER THEY ARE
   * ASKED, whatever the question's own Required flag says. So a form showing
   * any of the three as optional refuses submissions with "Location, manager
   * and contact details are required." — naming fields it had just called
   * optional. The editor could not show that before this.
   */
  for (const id of [LOCATION, MANAGER, CONTACT]) {
    const input = healthyJobForm();
    input.config.questions.find((entry) => entry.id === id).required = false;
    const found = intake
      .intakeWarnings(input)
      .find((warning) => warning.id === `optional-but-demanded-${id}`);
    assert.ok(found, `${id} must be reported`);
    assert.equal(found.level, "blocking");
    assert.match(found.detail, /Location, manager and contact details are required/);
  }
});

test("an optional Description is blocking, because the server has a ten-character floor", () => {
  const input = healthyJobForm();
  input.config.questions.find((entry) => entry.id === DESCRIPTION).required = false;
  const found = intake.intakeWarnings(input).find((warning) => warning.id === "description-floor");
  assert.ok(found);
  assert.equal(found.level, "blocking");
  assert.match(found.detail, /shorter than ten characters/);
});

test("a Location question with no live sites behind it is blocking", () => {
  /*
   * Trap 3. The stored options are monday's 21 captured labels, and the server
   * substitutes the live `sites` register over them — so an estate with no
   * canonical sites offers a list of nothing and refuses every submission with
   * "Choose a location from the list.", while the editor looks perfectly fine.
   */
  const input = healthyJobForm();
  input.optionOverrides = { [LOCATION]: [] };
  const found = intake.intakeWarnings(input).find((warning) => warning.id === "location-empty");
  assert.ok(found);
  assert.equal(found.level, "blocking");
  assert.equal(found.questionId, LOCATION);
});

test("a form that does not ask where the work is warns, but does not block", () => {
  const input = healthyJobForm();
  input.config.questions.find((entry) => entry.id === LOCATION).visible = false;
  const found = intake.intakeWarnings(input).find((warning) => warning.id === "no-location");
  assert.ok(found);
  assert.equal(found.level, "warning", "the job is created; it just has no site");
});

test("none of the canonical intake rules fire on a register that does not file here", () => {
  /*
   * A generic register's form has no Location column, so warning about one
   * would be noise on every workspace section — and the submit route agrees:
   * it only demands these fields when the form asks them.
   */
  const input = healthyJobForm();
  input.filesIntoThisBoard = false;
  input.config.questions = input.config.questions.filter((entry) => entry.id !== LOCATION);
  input.config.order = input.config.order.filter((entry) => entry !== LOCATION);
  assert.deepEqual(intake.intakeWarnings(input), []);
});

test("a question whose column has gone is blocking, and only once the columns are known", () => {
  const input = healthyJobForm();
  input.config.questions.push(question("col_deleted", { title: "Cost centre" }));
  input.config.order.push("col_deleted");

  /* Columns still loading: the check stands down rather than accusing every
     question on the form because a second request has not answered. */
  assert.equal(
    ids(intake.intakeWarnings(input)).filter((id) => id.startsWith("unbound-")).length,
    0,
  );

  input.boundIds = new Set([LOCATION, MANAGER, CONTACT, DESCRIPTION]);
  const found = intake
    .intakeWarnings(input)
    .find((warning) => warning.id === "unbound-col_deleted");
  assert.ok(found);
  assert.equal(found.level, "blocking");
});

test("required-but-hidden is reported, because the flag does nothing", () => {
  const input = healthyJobForm();
  input.config.questions.push(question("extra", { visible: false, required: true }));
  input.config.order.push("extra");
  assert.ok(ids(intake.intakeWarnings(input)).includes("required-hidden-extra"));
});

test("a conditional question whose trigger is not asked can never appear", () => {
  const input = healthyJobForm();
  input.config.questions.push(
    question("extra", { showIf: { questionId: "nobody", equals: ["yes"] } }),
  );
  input.config.order.push("extra");
  const found = intake
    .intakeWarnings(input)
    .find((warning) => warning.id === "orphan-condition-extra");
  assert.ok(found);
  assert.equal(found.level, "blocking");
});

test("a conditional question waiting on an option that no longer exists is reported", () => {
  const input = healthyJobForm();
  input.config.questions.push(
    question("extra", { showIf: { questionId: LOCATION, equals: ["a store that closed"] } }),
  );
  input.config.order.push("extra");
  assert.ok(ids(intake.intakeWarnings(input)).includes("unreachable-condition-extra"));
});

test("an empty second page is reported, and an implicit empty first page is not", () => {
  const input = healthyJobForm();
  input.config.questions.push(pageBlock("pb2", "Photographs"));
  input.config.order.push("pb2");
  assert.ok(ids(intake.intakeWarnings(input)).includes("empty-page-pb2"));

  /* One page and no questions is `no-questions`, said once rather than twice. */
  const bare = healthyJobForm();
  bare.config = { order: ["pb1"], questions: [pageBlock("pb1")] };
  const bareIds = ids(intake.intakeWarnings(bare));
  assert.ok(bareIds.includes("no-questions"));
  assert.ok(!bareIds.includes("empty-page-pb1"));
});

test("the availability gates are reported as warnings, in the words the link uses", () => {
  const off = healthyJobForm();
  off.active = false;
  assert.ok(ids(intake.intakeWarnings(off)).includes("deactivated"));

  const closed = healthyJobForm();
  closed.closeAt = new Date(Date.now() - 86_400_000).toISOString();
  assert.ok(ids(intake.intakeWarnings(closed)).includes("closed"));

  const future = healthyJobForm();
  future.closeAt = new Date(Date.now() + 86_400_000).toISOString();
  assert.ok(!ids(intake.intakeWarnings(future)).includes("closed"));

  const full = healthyJobForm();
  full.responseLimit = 25;
  full.responseCount = 25;
  assert.ok(ids(intake.intakeWarnings(full)).includes("full"), ">= the limit, not > it");
});

test("worstLevel is what the banner reads", () => {
  assert.equal(intake.worstLevel([]), null);
  assert.equal(intake.worstLevel([{ level: "warning" }]), "warning");
  assert.equal(intake.worstLevel([{ level: "warning" }, { level: "blocking" }]), "blocking");
});

/* ── The one duplicated map, pinned in both directions ───────────────────── */

test("the builder's canonical map is identical to the server's", async () => {
  /*
   * `form-bindings.ts` transcribes `CANONICAL_QUESTION_BY_COLUMN` from
   * `app/lib/form-derive.ts` because that module imports the whole captured
   * monday specification and the builder must not ship it to a browser to read
   * eighteen strings. A copy is only acceptable while something fails when it
   * drifts, and this is that something: a canonical question added, removed or
   * re-pointed there fails HERE, rather than quietly turning every form in the
   * product into a page of "has nowhere to save its answer".
   */
  const derive = await read("app/lib/form-derive.ts");
  const block = derive.match(
    /export const CANONICAL_QUESTION_BY_COLUMN: Readonly<Record<string, string>> = \{([\s\S]*?)\n\};/,
  );
  assert.ok(block, "the server's map must still be the declared shape");
  const server = Object.fromEntries(
    [...block[1].matchAll(/^\s{2}(\w+):\s*"([^"]+)",/gm)].map((match) => [match[1], match[2]]),
  );
  assert.ok(Object.keys(server).length >= 18, "the eighteen asked columns");
  assert.deepEqual(bindings.CANONICAL_QUESTION_BY_COLUMN_KEY, server);
});

test("the builder's column-type map is identical to the server's", async () => {
  const derive = await read("app/lib/form-derive.ts");
  const block = derive.match(
    /const QUESTION_TYPE_BY_COLUMN_TYPE: Readonly<Record<string, FormQuestion\["type"\]>> = \{([\s\S]*?)\n\};/,
  );
  assert.ok(block, "the server's type map must still be the declared shape");
  const server = Object.fromEntries(
    [...block[1].matchAll(/^\s{2}(\w+):\s*"([^"]+)",/gm)].map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(bindings.QUESTION_TYPE_BY_COLUMN_TYPE, server);
});

test("a question is addressed by column id, and a canonical one by monday's id", () => {
  const plain = { id: "col_7", key: "cost_centre", title: "Cost centre", type: "text", required: false, system: false };
  assert.equal(
    bindings.questionIdForColumn(plain),
    "col_7",
    "a derived question carries the column's ROW id, because that is the cell the answer lands in",
  );
  const location = { id: "col_1", key: "location", title: "Location", type: "status", required: true, system: false };
  assert.equal(
    bindings.questionIdForColumn(location),
    LOCATION,
    "a canonical question carries monday's id, because the submit route reads it by name",
  );
  assert.equal(bindings.columnForQuestion(LOCATION, [location, plain]), location);
  assert.equal(bindings.columnForQuestion("col_7", [location, plain]), plain);
  assert.equal(bindings.columnForQuestion("nobody", [location, plain]), null);
});
