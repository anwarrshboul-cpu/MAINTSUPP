/**
 * UNDO IN THE FORM EDITOR, AS BEHAVIOUR RATHER THAN AS SOURCE TEXT.
 *
 * The rest of the form-builder suite pins this module's source, which is the
 * right tool for "there is exactly one fetch" and the wrong one for "two
 * overlapping saves undo in the order they were made". That second sentence is
 * a state machine with three refs, a debounce and a tail re-flush in it, and
 * the two defects this file was written for were both invisible in the source:
 *
 *   1. `undo` restored FOUR of the twelve sections a PATCH accepts, so changing
 *      the response limit — or the title, the description, the close date, the
 *      language, the tags, or deactivating the form — produced an Undo that
 *      sent a request, reported "All changes saved", and left the field exactly
 *      as it was. Reported against `responseLimit`; the other seven had the
 *      same hole and nobody had pressed them.
 *
 *   2. The pre-change form was held in ONE slot, consumed by whichever request
 *      was in the air. A second discrete action taken during the first one's
 *      round trip — which is ordinary, because every discrete action saves
 *      immediately — therefore entered no history at all. Two persisted states,
 *      one step back, and the middle one unreachable for ever.
 *
 * ── HOW THE HOOK IS RUN WITHOUT A BROWSER ─────────────────────────────────
 *
 * `useFormSave` is loaded the way `tests/sites-compliance-link.test.mjs` loads
 * TypeScript — transpile, then import from a `data:` URL — with one addition. A
 * `data:` module cannot resolve a relative specifier OR a bare one, and this
 * module imports `react`. So `react` is rewritten to a second `data:` module
 * holding a ~90-line hook runtime: `useState` re-renders synchronously,
 * `useRef` persists, `useMemo`/`useCallback` compare deps, `useEffect` runs
 * after the render that queued it and cleans up before it runs again. That is
 * the whole of the React surface this hook touches.
 *
 * `window.setTimeout` is faked too, so the 800ms debounce is a function call
 * rather than a wait, and `fetch` hands back a deferred per request so a test
 * can hold one save open while it makes the next edit — which is the only way
 * to reproduce defect 2 at all.
 *
 * Reads normalise CRLF — this is a Windows checkout.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const asModule = (js) =>
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;

/* ── The hook runtime ────────────────────────────────────────────────────── */

const REACT_RUNTIME = `
let hooks = [];
let cursor = 0;
let queue = [];
let component = null;
let result = null;
let depth = 0;

const sameDeps = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
  a.every((value, index) => Object.is(value, b[index]));

function renderNow() {
  depth += 1;
  if (depth > 50) { depth = 0; throw new Error("render loop"); }
  try {
    cursor = 0;
    const outer = queue;
    queue = [];
    result = component();
    const effects = queue;
    queue = outer;
    for (const run of effects) run();
  } finally {
    depth -= 1;
  }
}

export function mount(fn) { component = fn; hooks = []; depth = 0; renderNow(); return result; }
export function render() { renderNow(); return result; }
export function current() { return result; }
export function unmount() {
  for (const slot of hooks) {
    if (slot && typeof slot.cleanup === "function") slot.cleanup();
  }
}

export function useState(initial) {
  const index = cursor++;
  if (hooks[index] === undefined) {
    hooks[index] = { value: typeof initial === "function" ? initial() : initial };
  }
  const slot = hooks[index];
  return [slot.value, (next) => {
    const value = typeof next === "function" ? next(slot.value) : next;
    if (Object.is(value, slot.value)) return;
    slot.value = value;
    renderNow();
  }];
}

export function useRef(initial) {
  const index = cursor++;
  if (hooks[index] === undefined) hooks[index] = { current: initial };
  return hooks[index];
}

export function useMemo(factory, deps) {
  const index = cursor++;
  const slot = hooks[index];
  if (slot === undefined || !sameDeps(slot.deps, deps)) {
    const value = factory();
    hooks[index] = { value, deps };
    return value;
  }
  return slot.value;
}

export function useCallback(fn, deps) { return useMemo(() => fn, deps); }

export function useEffect(effect, deps) {
  const index = cursor++;
  let slot = hooks[index];
  if (slot === undefined) slot = hooks[index] = { deps: null, cleanup: null, first: true };
  if (slot.first || !sameDeps(slot.deps, deps)) {
    slot.first = false;
    slot.deps = deps;
    queue.push(() => {
      if (typeof slot.cleanup === "function") slot.cleanup();
      const cleanup = effect();
      slot.cleanup = typeof cleanup === "function" ? cleanup : null;
    });
  }
}
`;

const RUNTIME_URL = asModule(REACT_RUNTIME);
const react = await import(RUNTIME_URL);

/**
 * The module under test. Held in a variable rather than inlined so the same
 * file can be pointed at a previous revision to prove a pin actually fails —
 * which is how the `responseLimit` reproduction below was verified.
 */
const SAVE_MODULE = "app/(app)/portal/form-builder-save.ts";

const saver = await import(
  asModule(transpile(await read(SAVE_MODULE)).replace(/from ["']react["']/g, `from "${RUNTIME_URL}"`))
);

/* ── A form the server could have sent ───────────────────────────────────── */

/**
 * Shaped from `serialiseForm()` in `app/api/board/form/route.ts` and
 * `maintenanceFormConfiguration` in `db/monday-board-spec.ts`. Small on purpose:
 * what matters is that every SECTION is present, not that every option is.
 */
function sampleForm() {
  return {
    id: "form_test_maintenance",
    boardKey: "maintenance",
    filesIntoThisBoard: true,
    title: "Maintenance Request",
    description: null,
    active: true,
    requireLogin: false,
    hasPassword: false,
    responseLimit: null,
    closeAt: null,
    responseCount: 0,
    shareToken: "a".repeat(32),
    shortToken: null,
    shareUrl: "https://portal.test/f/aaaa",
    presentedUrl: "https://portal.test/f/aaaa",
    config: {
      order: ["page", "q_desc", "q_site"],
      questions: [
        { id: "page", type: "PAGE_BLOCK", title: "Page 1", description: null, visible: true, required: false, options: null, showIf: null },
        { id: "q_desc", type: "LongText", title: "What is the problem?", description: null, visible: true, required: true, options: null, showIf: null },
        { id: "q_site", type: "SingleSelect", title: "Location", description: null, visible: true, required: true, options: [{ label: "Cardiff", value: "cardiff", visible: true, active: true }], showIf: null, settings: { display: "Dropdown" } },
      ],
      features: {
        isInternal: true,
        reCaptchaChallenge: false,
        shortenedLink: { enabled: false, url: null },
        password: { enabled: false },
        draftSubmission: { enabled: false },
        requireLogin: { enabled: false, redirectToLogin: false },
        responseLimit: { enabled: false, limit: null },
        closeDate: { enabled: false, date: null },
        preSubmissionView: { enabled: false, title: null, description: null, startButton: { text: null } },
        afterSubmissionView: {
          title: null,
          description: null,
          redirectAfterSubmission: { enabled: false, redirectUrl: null },
          allowResubmit: true,
          showSuccessImage: true,
          allowEditSubmission: false,
          allowViewSubmission: true,
        },
        board: {
          itemGroupId: null,
          includeNameQuestion: false,
          includeUpdateQuestion: false,
          syncQuestionAndColumnsTitles: false,
          allowCreatingItems: true,
        },
        aiTranslate: { enabled: false },
      },
      appearance: {
        hideBranding: true,
        showProgressBar: false,
        primaryColor: null,
        layout: { type: "CARD", alignment: "Center", direction: "LtR" },
        background: { type: "None", value: null },
        text: { font: "Poppins", color: null, size: "Medium" },
        logo: { position: "Auto", url: null, size: "Medium" },
        submitButton: { text: null },
      },
      accessibility: { language: "English (English)", logoAltText: null },
      tags: [],
    },
  };
}

/* ── The harness ─────────────────────────────────────────────────────────── */

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Mount `useFormSave` over a fake window, fake timers and a `fetch` that hands
 * back one deferred per request.
 *
 * Nothing here guesses at the server: `respond(call, form)` is the test saying
 * what the route would have stored, and the hook takes that answer exactly as
 * it does in the browser.
 */
function harness({ boardId = "maintenance", initial = sampleForm() } = {}) {
  let form = structuredClone(initial);
  let board = boardId;
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 1;
  const calls = [];

  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;

  globalThis.window = {
    setTimeout(fn) {
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== fn));
    },
  };

  globalThis.fetch = (url, init) => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    calls.push({
      url,
      method: init.method,
      body: JSON.parse(init.body),
      settled: false,
      resolve,
    });
    return promise;
  };

  const setForm = (next) => {
    form = next;
    react.render();
  };

  react.mount(() => saver.useFormSave({ boardId: board, form, setForm }));

  return {
    get api() {
      return react.current();
    },
    get form() {
      return form;
    },
    /**
     * Move the editor to another register WITHOUT unmounting it — which is what
     * happens when somebody switches board with the Form tab open, and is the
     * only way the cross-register case below can be reached.
     */
    openBoard(next, nextForm) {
      board = next;
      form = structuredClone(nextForm);
      react.render();
    },
    calls,
    /** The requests that have not been answered yet, oldest first. */
    open() {
      return calls.filter((call) => !call.settled);
    },
    /** Answer one request as the route would. */
    async respond(call, saved, { status = 200, payload } = {}) {
      call.settled = true;
      call.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload ?? { ok: true, form: saved },
      });
      await settle();
      await settle();
      await settle();
    },
    /** Fire every debounce timer that is due. */
    async runTimers() {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
      await settle();
    },
    key(event) {
      for (const fn of listeners.get("keydown") ?? []) fn(event);
    },
    restore() {
      react.unmount();
      globalThis.window = previousWindow;
      globalThis.fetch = previousFetch;
    },
  };
}

/** Apply a section body the way `PATCH /api/board/form` applies it. */
function applyPatch(form, body) {
  const next = structuredClone(form);
  for (const key of ["title", "description", "active", "requireLogin", "responseLimit", "closeAt"]) {
    if (key in body) next[key] = body[key];
  }
  if (Array.isArray(body.questions)) next.config.questions = structuredClone(body.questions);
  if (Array.isArray(body.order)) next.config.order = body.order.map(String);
  if (Array.isArray(body.tags)) next.config.tags = body.tags.map(String);
  for (const key of ["features", "appearance", "accessibility"]) {
    if (body[key] && typeof body[key] === "object") {
      next.config[key] = { ...next.config[key], ...structuredClone(body[key]) };
    }
  }
  return next;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 1. THE REPORTED DEFECT                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

test("changing the response limit is undone", async () => {
  /*
   * THE REPRODUCTION. `responseLimit` is a COLUMN, not part of the `config`
   * blob, so the four config sections the first Undo restored could not carry
   * it however complete they were. Against the previous revision this fails on
   * the first assertion with `undefined !== null` — the undo body has four keys
   * and none of them is this one — and the editor's own toolbar reports "All
   * changes saved" while the limit stays where it was put.
   */
  const h = harness();
  const before = structuredClone(h.form);
  try {
    h.api.save({ responseLimit: 100 }, { immediate: true });
    await settle();
    const [saving] = h.open();
    assert.equal(saving.body.responseLimit, 100, "the change itself goes out");
    await h.respond(saving, applyPatch(before, { responseLimit: 100 }));

    assert.equal(h.form.responseLimit, 100, "and the editor takes the server's answer");
    assert.equal(h.api.canUndo, true, "a persisted change is a step back");

    h.api.undo();
    await settle();
    const [undoing] = h.open();
    assert.ok(undoing, "Undo is a save of its own");
    assert.equal(
      undoing.body.responseLimit,
      null,
      "and it carries the response limit back to what it was",
    );
    await h.respond(undoing, applyPatch(h.form, undoing.body));
    assert.equal(h.form.responseLimit, null, "so the persisted form is the one before the change");
  } finally {
    h.restore();
  }
});

/* ────────────────────────────────────────────────────────────────────────── */
/* 2. EVERY PERSISTED SECTION                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

test("undo covers every section a PATCH accepts, or names why it cannot", async () => {
  /*
   * READ OFF THE ROUTE, not off a list kept here. `PatchBody` is the complete
   * description of what can be persisted, so a section added to it later either
   * appears in `formUndoBody` or is deliberately named in
   * `FORM_UNRESTORABLE_SECTIONS` — and if it is neither, this fails on the day
   * it is added rather than on the day somebody presses Undo.
   */
  const route = await read("app/api/board/form/route.ts");
  const block = route.match(/type PatchBody = \{([\s\S]*?)\n\};/);
  assert.ok(block, "PatchBody must still be the declared shape of a save");
  const sections = [...block[1].matchAll(/^\s{2}(\w+)\?:/gm)].map((match) => match[1]);
  assert.ok(sections.length >= 14, `expected the full section list, found ${sections.join(", ")}`);

  const covered = Object.keys(saver.formUndoBody(sampleForm()));
  const excused = [...saver.FORM_UNRESTORABLE_SECTIONS];

  for (const section of sections) {
    assert.ok(
      covered.includes(section) || excused.includes(section),
      `${section} is persisted but no Undo would put it back`,
    );
  }
  /* And nothing is claimed that the route would ignore. */
  for (const key of covered) {
    assert.ok(sections.includes(key), `${key} is sent by Undo but PATCH does not accept it`);
  }
  /* The excuses are real ones, not a way of shrinking the list. */
  assert.deepEqual(excused, ["password", "regenerateToken"]);
});

test("the route applies every section Undo sends", async () => {
  /*
   * THE OTHER HALF OF "Undo itself saves".
   *
   * The harness above models `PATCH /api/board/form` — it has to, because the
   * hook is being run without a server — so a section Undo sends that the real
   * route quietly ignored would pass every behavioural test in this file and
   * still leave the field unchanged after a reload. This closes that gap by
   * reading the route: each key must reach a guard that actually applies it.
   *
   * Substring checks rather than patterns, because what is being asserted is
   * the presence of a guard, not its punctuation. A source pin, and a
   * deliberate one — it protects a boundary: if a guard moves, re-point this at
   * wherever the section is applied instead, never delete it.
   */
  const route = await read("app/api/board/form/route.ts");
  const guards = {
    title: '"title" in body',
    description: '"description" in body',
    active: '"active" in body',
    requireLogin: '"requireLogin" in body',
    responseLimit: '"responseLimit" in body',
    closeAt: '"closeAt" in body',
    questions: "Array.isArray(body.questions)",
    order: "Array.isArray(body.order)",
    features: 'body.features && typeof body.features === "object"',
    appearance: 'body.appearance && typeof body.appearance === "object"',
    accessibility: 'body.accessibility && typeof body.accessibility === "object"',
    tags: "Array.isArray(body.tags)",
  };
  for (const key of Object.keys(saver.formUndoBody(sampleForm()))) {
    assert.ok(guards[key], `${key} is sent by Undo and nothing here checks the route takes it`);
    assert.ok(
      route.includes(guards[key]),
      `the route must apply ${key} when it is sent — looked for ${guards[key]}`,
    );
  }
  /* And the write is a PATCH of named sections, so the fields Undo deliberately
     does NOT send survive it — the password and the share token above all. */
  assert.ok(
    route.includes("await db.update(formConfigurations).set(updates)"),
    "a PATCH of what was sent, never a whole-document PUT",
  );
});

/**
 * One persisted change per field, each undone on its own.
 *
 * Table-driven because the point is coverage: every entry is a real edit some
 * control in `form-builder-panels.tsx` or `form-share-dialog.tsx` makes, and
 * each is asserted to (a) genuinely change the definition and (b) come back
 * whole. The three that are asserted through `applyPatch` rather than by
 * reading one key are the merged ones, where the route merges rather than
 * replaces and a partial restore would be invisible in a single field.
 */
const EDITS = [
  ["the form title", (form) => { form.title = "Report a fault"; }],
  ["the form description", (form) => { form.description = "Tell us what is broken."; }],
  ["deactivating the form", (form) => { form.active = false; }],
  ["requiring a login", (form) => { form.requireLogin = true; }],
  ["a response limit", (form) => { form.responseLimit = 25; }],
  ["a close date", (form) => { form.closeAt = "2026-12-31T23:59:59.999Z"; }],
  ["adding a question", (form) => {
    form.config.questions.push({ id: "q_new", type: "ShortText", title: "Contact", description: null, visible: true, required: false, options: null, showIf: null });
    form.config.order.push("q_new");
  }],
  ["removing a question", (form) => {
    form.config.questions = form.config.questions.filter((q) => q.id !== "q_site");
    form.config.order = form.config.order.filter((id) => id !== "q_site");
  }],
  ["reordering the questions", (form) => {
    form.config.order = ["page", "q_site", "q_desc"];
  }],
  ["a question label", (form) => { form.config.questions[1].title = "Describe the fault"; }],
  ["question help text", (form) => { form.config.questions[1].description = "Include the shop floor."; }],
  ["the required flag", (form) => { form.config.questions[1].required = false; }],
  ["conditional routing on a question", (form) => {
    form.config.questions[2].showIf = { questionId: "q_desc", equals: ["leak"] };
  }],
  ["a question's own settings", (form) => {
    form.config.questions[2].settings = { display: "Vertical", optionsOrder: "Alphabetical" };
  }],
  ["hiding a question", (form) => { form.config.questions[2].visible = false; }],
  ["where answers are filed", (form) => { form.config.features.board.itemGroupId = "group_two"; }],
  ["the welcome page", (form) => {
    form.config.features.preSubmissionView = { enabled: true, title: "Before you start", description: null, startButton: { text: "Begin" } };
  }],
  ["the confirmation page", (form) => {
    form.config.features.afterSubmissionView.title = "Thank you";
    form.config.features.afterSubmissionView.allowResubmit = false;
  }],
  ["the post-submission redirect", (form) => {
    form.config.features.afterSubmissionView.redirectAfterSubmission = { enabled: true, redirectUrl: "https://example.test/thanks" };
  }],
  ["availability switches", (form) => {
    form.config.features.draftSubmission.enabled = true;
    form.config.features.aiTranslate.enabled = true;
    form.config.features.reCaptchaChallenge = true;
  }],
  ["the shortened link", (form) => { form.config.features.shortenedLink = { enabled: true, url: null }; }],
  ["the design", (form) => {
    form.config.appearance.primaryColor = "#0b5c3f";
    form.config.appearance.layout = { type: "CLASSIC", alignment: "Left", direction: "LtR" };
    form.config.appearance.text = { font: "Inter", color: "#101010", size: "Large" };
    form.config.appearance.submitButton = { text: "Send it" };
  }],
  ["the form language", (form) => { form.config.accessibility.language = "Arabic (العربية)"; }],
  ["the logo alt text", (form) => { form.config.accessibility.logoAltText = "Client logo"; }],
  ["tags", (form) => { form.config.tags = ["urgent", "estate"]; }],
];

for (const [what, mutate] of EDITS) {
  test(`undo restores ${what}`, async () => {
    const h = harness();
    const before = structuredClone(h.form);
    const after = structuredClone(before);
    mutate(after);
    assert.notEqual(
      JSON.stringify(saver.formUndoBody(before)),
      JSON.stringify(saver.formUndoBody(after)),
      "the edit must actually change the definition, or the case proves nothing",
    );
    try {
      /* The body a panel would send is irrelevant to the contract — what is
         asserted is that whatever the server ends up storing can be reversed. */
      h.api.save({ marker: what }, { immediate: true });
      await settle();
      await h.respond(h.open()[0], after);
      assert.equal(h.api.canUndo, true, "a persisted change is a step back");

      h.api.undo();
      await settle();
      const [undoing] = h.open();
      assert.ok(undoing, "Undo saves");
      assert.equal(
        JSON.stringify(applyPatch(after, undoing.body)),
        JSON.stringify(before),
        "and what the route would store afterwards is the state before the change",
      );
    } finally {
      h.restore();
    }
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 3. OVERLAPPING AND DEBOUNCED SAVES                                         */
/* ────────────────────────────────────────────────────────────────────────── */

test("two overlapping saves undo in the order they were made", async () => {
  /*
   * THE SECOND DEFECT, and the one no source-text pin could have caught.
   *
   * Every discrete action saves immediately, so a second toggle pressed during
   * the first one's round trip is ordinary rather than exotic. With one slot
   * for the pre-change form, the first request consumed it and the second
   * change recorded NOTHING: history held one entry, one Undo went straight
   * past the middle state to the beginning, and the state in between could
   * never be returned to.
   *
   * DELIBERATELY TWO `appearance` EDITS, which is the one thing about the shape
   * of this test that matters. `appearance` is a section the old Undo already
   * carried, so the failure it produces against the previous revision is the
   * ORDERING defect on its own — "#0b5c3f" expected, `null` found, the middle
   * state skipped — rather than the missing-key defect above wearing its
   * clothes. Both are real and they are not the same bug.
   */
  const h = harness();
  const v0 = structuredClone(h.form);
  try {
    h.api.save({ appearance: { primaryColor: "#0b5c3f" } }, { immediate: true });
    await settle();
    const first = h.open()[0];
    assert.ok(first, "the first change is in the air");

    /* The second edit, made while the first is still unanswered. */
    h.api.save({ appearance: { showProgressBar: true } }, { immediate: true });
    await settle();
    assert.equal(h.open().length, 1, "a save in flight holds the next one back rather than racing it");

    const v1 = applyPatch(v0, { appearance: { primaryColor: "#0b5c3f" } });
    await h.respond(first, v1);

    const second = h.open()[0];
    assert.ok(second, "and the queued change goes the moment the first lands");
    const v2 = applyPatch(v1, { appearance: { showProgressBar: true } });
    await h.respond(second, v2);

    assert.equal(h.form.config.appearance.primaryColor, "#0b5c3f");
    assert.equal(h.form.config.appearance.showProgressBar, true);

    /* One Undo, one state back — the MIDDLE one. */
    h.api.undo();
    await settle();
    const undoOne = h.open()[0];
    assert.equal(
      undoOne.body.appearance.primaryColor,
      "#0b5c3f",
      "the first Undo does not skip the state between the two saves",
    );
    assert.equal(undoOne.body.appearance.showProgressBar, false);
    await h.respond(undoOne, applyPatch(v2, undoOne.body));
    assert.equal(
      JSON.stringify(saver.formUndoBody(h.form)),
      JSON.stringify(saver.formUndoBody(v1)),
      "one Undo = the state immediately before the last change",
    );

    /* And a second Undo reaches the beginning, not the other way round. */
    assert.equal(h.api.canUndo, true, "the earlier step is still there to go back to");
    h.api.undo();
    await settle();
    const undoTwo = h.open()[0];
    assert.equal(undoTwo.body.appearance.primaryColor, null);
    await h.respond(undoTwo, applyPatch(h.form, undoTwo.body));
    assert.equal(
      JSON.stringify(saver.formUndoBody(h.form)),
      JSON.stringify(saver.formUndoBody(v0)),
      "two Undos = two states back, in order",
    );
    assert.equal(h.api.canUndo, false, "and there is nothing left to undo");
  } finally {
    h.restore();
  }
});

test("a debounced burst is one step, not one per keystroke", async () => {
  const h = harness();
  const v0 = structuredClone(h.form);
  try {
    /* What `DraftInput` plus the 800ms debounce produce while somebody types:
       several calls, one request, and therefore one state to go back to. */
    h.api.save({ title: "R" });
    h.api.save({ title: "Re" });
    h.api.save({ title: "Report a fault" });
    assert.equal(h.calls.length, 0, "nothing is sent until the debounce fires");

    await h.runTimers();
    const [burst] = h.open();
    assert.ok(burst, "and then exactly one request goes");
    assert.equal(h.calls.length, 1);
    assert.equal(burst.body.title, "Report a fault", "carrying the LAST value, not the first");

    await h.respond(burst, applyPatch(v0, { title: "Report a fault" }));
    h.api.undo();
    await settle();
    const [undoing] = h.open();
    assert.equal(undoing.body.title, "Maintenance Request");
    await h.respond(undoing, applyPatch(h.form, undoing.body));
    assert.equal(h.api.canUndo, false, "three keystrokes were one step, so one Undo empties it");
  } finally {
    h.restore();
  }
});

test("a change that failed and was retried is still one step back", async () => {
  /*
   * The failure arm merges the failed body under anything queued behind it, so
   * the two become one batch. Its restore point has to be the EARLIER of the
   * two or the failed edit is unreachable by Undo once the Retry succeeds —
   * the same lost step as defect 2, arriving through the recovery path.
   */
  const h = harness();
  const v0 = structuredClone(h.form);
  try {
    h.api.save({ title: "Report a fault" }, { immediate: true });
    await settle();
    await h.respond(h.open()[0], null, {
      status: 503,
      payload: { error: "The workspace database is out of connections right now.", retry: true },
    });
    assert.equal(h.api.state, "failed");
    assert.equal(h.api.canUndo, false, "a change that did not persist is not a state to return to");

    h.api.retry();
    await settle();
    const again = h.open()[0];
    assert.equal(again.body.title, "Report a fault", "Retry re-sends exactly what failed");
    await h.respond(again, applyPatch(v0, { title: "Report a fault" }));

    assert.equal(h.api.state, "saved");
    assert.equal(h.api.canUndo, true);
    h.api.undo();
    await settle();
    assert.equal(h.open()[0].body.title, "Maintenance Request", "and it goes back to before the failure");
  } finally {
    h.restore();
  }
});

test("a save that changed nothing a person can see is not a step back", async () => {
  /*
   * `responseCount` moves when somebody submits the form, and a password or a
   * regenerated link changes the row without changing anything Undo could
   * restore. None of the three may become a history entry, because an Undo that
   * does nothing when pressed is worse than a disabled one.
   */
  const h = harness();
  const v0 = structuredClone(h.form);
  try {
    const sameDefinition = structuredClone(v0);
    sameDefinition.responseCount = 7;
    sameDefinition.hasPassword = true;
    sameDefinition.shareToken = "b".repeat(32);
    sameDefinition.presentedUrl = "https://portal.test/f/bbbb";

    h.api.save({ password: "a-long-enough-password" }, { immediate: true });
    await settle();
    await h.respond(h.open()[0], sameDefinition);
    assert.equal(h.api.state, "saved");
    assert.equal(h.api.canUndo, false, "nothing an Undo could reverse actually changed");
  } finally {
    h.restore();
  }
});

/* ────────────────────────────────────────────────────────────────────────── */
/* 4. DEPTH, THE KEYBOARD, AND WHOSE HISTORY IT IS                            */
/* ────────────────────────────────────────────────────────────────────────── */

test("at least twenty steps of history are kept", async () => {
  assert.ok(saver.FORM_HISTORY_LIMIT >= 20, "the brief asks for at least twenty");
  const h = harness();
  const titles = ["Maintenance Request"];
  try {
    for (let step = 1; step <= 21; step += 1) {
      const next = applyPatch(h.form, { title: `Revision ${step}` });
      h.api.save({ title: next.title }, { immediate: true });
      await settle();
      await h.respond(h.open()[0], next);
      titles.push(next.title);
    }
    assert.equal(h.form.title, "Revision 21");

    /* Back down the whole stack, one recognisable state at a time. */
    for (let step = 21; step >= 1; step -= 1) {
      assert.equal(h.api.canUndo, true, `step ${step} must still be reachable`);
      h.api.undo();
      await settle();
      const [undoing] = h.open();
      assert.equal(undoing.body.title, titles[step - 1], `Undo ${22 - step} restores the state before revision ${step}`);
      await h.respond(undoing, applyPatch(h.form, undoing.body));
    }
    assert.equal(h.form.title, "Maintenance Request");
    assert.equal(h.api.canUndo, false);
  } finally {
    h.restore();
  }
});

test("Ctrl/Cmd+Z undoes, except where the browser's own undo is the right one", async () => {
  const h = harness();
  const v0 = structuredClone(h.form);
  try {
    h.api.save({ title: "Report a fault" }, { immediate: true });
    await settle();
    await h.respond(h.open()[0], applyPatch(v0, { title: "Report a fault" }));

    /* Inside a field somebody is typing in: the key belongs to the browser. */
    let prevented = false;
    h.key({
      ctrlKey: true,
      metaKey: false,
      key: "z",
      target: { tagName: "INPUT" },
      preventDefault: () => {
        prevented = true;
      },
    });
    await settle();
    assert.equal(prevented, false, "the shortcut does not swallow the key inside an input");
    assert.equal(h.open().length, 0, "and nothing is saved");

    /* Anywhere else in the editor, it is the editor's undo. */
    h.key({
      ctrlKey: true,
      metaKey: false,
      key: "z",
      target: { tagName: "DIV" },
      preventDefault: () => {
        prevented = true;
      },
    });
    await settle();
    assert.equal(prevented, true);
    const [undoing] = h.open();
    assert.ok(undoing, "Ctrl+Z saves the previous definition");
    assert.equal(undoing.body.title, "Maintenance Request");
    assert.match(undoing.url, /\/api\/board\/form\?board=maintenance/);
    assert.equal(undoing.method, "PATCH");

    /* Cmd+Z, for the same reason, on the other platform. */
    await h.respond(undoing, applyPatch(h.form, undoing.body));
    assert.equal(h.api.canUndo, false);
    h.key({
      ctrlKey: false,
      metaKey: true,
      key: "Z",
      target: { tagName: "DIV" },
      preventDefault: () => {},
    });
    await settle();
    assert.equal(h.open().length, 0, "with an empty history it does nothing at all");
  } finally {
    h.restore();
  }
});

test("Undo never restores another register's form", async () => {
  /*
   * `boardId` changes without this hook unmounting — `form-builder.tsx` says so
   * where it computes `pending`. A history kept across that switch would have
   * offered a live Undo button pointed at ANOTHER board's definition, and
   * pressing it would have written one register's questions, title and access
   * settings over another's public form.
   */
  const h = harness();
  const v0 = structuredClone(h.form);
  try {
    h.api.save({ title: "Report a fault" }, { immediate: true });
    await settle();
    await h.respond(h.open()[0], applyPatch(v0, { title: "Report a fault" }));
    assert.equal(h.api.canUndo, true, "one register's own history is offered");

    /* Somebody clicks through to another register. */
    const other = sampleForm();
    other.id = "form_test_store_documentation";
    other.boardKey = "store-documentation";
    other.title = "Store Documentation";
    h.openBoard("store-documentation", other);
    assert.equal(
      h.api.canUndo,
      false,
      "the button must go dead — the stack behind it belongs to the register that was just left",
    );

    /* Ctrl+Z must obey the same rule, or the keyboard is a second, less
       careful Undo that writes one board's definition onto another. */
    let prevented = false;
    h.key({
      ctrlKey: true,
      metaKey: false,
      key: "z",
      target: { tagName: "DIV" },
      preventDefault: () => {
        prevented = true;
      },
    });
    await settle();
    assert.equal(prevented, false);
    assert.equal(h.open().length, 0, "and nothing at all is written to the new register");

    /* The new register then builds a history of its own, from its own state. */
    h.api.save({ title: "Store check" }, { immediate: true });
    await settle();
    const saving = h.open()[0];
    assert.match(saving.url, /board=store-documentation/, "every save names its own register");
    await h.respond(saving, applyPatch(other, { title: "Store check" }));
    assert.equal(h.api.canUndo, true);

    h.api.undo();
    await settle();
    const [undoing] = h.open();
    assert.equal(undoing.body.title, "Store Documentation", "back to THIS register's previous state");
    assert.match(undoing.url, /board=store-documentation/);
    await h.respond(undoing, applyPatch(h.form, undoing.body));
    assert.equal(h.api.canUndo, false, "and the register that was left never re-enters the stack");
  } finally {
    h.restore();
  }
});
