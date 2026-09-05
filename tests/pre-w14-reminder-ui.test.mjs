/**
 * THE REMINDER EDITOR AND THE RECIPIENT PICKER — §5, §6, §7 and §14.
 *
 * The engine underneath these two components is already pinned elsewhere
 * (`pre-w14-reminder-schedule.test.mjs` owns the date arithmetic). What this
 * suite protects is the part a person actually touches, and it protects three
 * things in particular because each of them fails SILENTLY:
 *
 *  1. THE DEFAULT LADDER IS A MIRROR, NOT A SECOND OPINION. A new record has
 *     no id, so there is nothing to read reminders for, and the modal has to
 *     seed the cascade itself. That seed is a copy of `REMINDER_DEFAULTS_SEED`
 *     in `db/init.ts`, and a copy that drifts means a certificate created in
 *     the modal and one created by an import carry different ladders — with
 *     nothing anywhere to say so. The two are compared field by field below.
 *
 *  2. DE-DUPLICATION USES THE LIBRARY'S KEY. The send path collapses
 *     recipients on `normaliseRecipientEmail`. A picker that compared
 *     addresses any other way lets two chips through that are one address, and
 *     the reader is told nobody was written to twice.
 *
 *  3. THE PREVIEW PANEL EXISTS AND IS FED BY `previewCascade`. §7.4 calls it
 *     "the single best defence against silent misconfiguration". A panel that
 *     did its own date arithmetic could promise 08:00 while the cron sent at
 *     09:00 across the October clock change, and every assertion about the
 *     engine would still pass.
 *
 * The components are React, so they are loaded with `react`, `react/jsx-runtime`
 * and the workspace-roster store stubbed. That imports the module and exercises
 * its exported pure functions for real; the parts that only exist as markup are
 * pinned against the source instead, which is this suite's usual method.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const asModule = (javascript) =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

const transpile = (source, jsx = false) =>
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
    },
  }).outputText;

/** Comments are prose and may say anything; the source pins read code only. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ── The stubs ────────────────────────────────────────────────────────────────
 *
 * Enough React to let a module BODY evaluate. No hook is ever called by the
 * exported functions under test — they are pure — so the stubs need only exist,
 * not behave. Anything that did depend on real hook semantics would be a
 * component, and components are pinned by source below rather than rendered.
 */
const reactStub = asModule(`
  export const useState = (initial) => [typeof initial === "function" ? initial() : initial, () => {}];
  export const useEffect = () => {};
  export const useMemo = (compute) => compute();
  export const useCallback = (fn) => fn;
  export const useRef = (initial) => ({ current: initial });
  export const useId = () => "test-id";
  export default {};
`);
const jsxStub = asModule(`
  export const jsx = () => null;
  export const jsxs = () => null;
  export const Fragment = "fragment";
`);
const componentsStub = asModule(`export const Icon = () => null;`);
const directoryStub = asModule(`
  export const filterMembers = (members, search) =>
    !search ? members : members.filter((m) => (m.name + m.email).toLowerCase().includes(search.toLowerCase()));
  export const memberColour = () => "#111111";
  export const memberInitials = () => "AB";
  export const useAssigneeDirectory = () => ({ members: [], loading: false, error: null });
`);

/* The engine, transpiled for real — nothing about it is stubbed. */
const scheduleUrl = asModule(transpile(await read("app/lib/reminders/schedule.ts")));
const recipientsUrl = asModule(transpile(await read("app/lib/reminders/recipients.ts")));
const cascadeUrl = asModule(
  transpile(await read("app/lib/reminders/cascade.ts"))
    .replace(/from ["']\.\/schedule["']/g, `from "${scheduleUrl}"`)
    .replace(/from ["']\.\/recipients["']/g, `from "${recipientsUrl}"`),
);
const formatDateUrl = asModule(transpile(await read("app/lib/format-date.ts")));

const pickerSource = await read("app/(app)/portal/recipient-picker.tsx");
const rowsSource = await read("app/(app)/portal/reminder-rows.tsx");
const rowsCss = await read("app/(app)/portal/reminder-rows.css");
const dialogSource = await read("app/(app)/portal/manual-event-dialog.tsx");
const dialogCss = await read("app/(app)/portal/manual-event-dialog.css");

const wire = (compiled, extra = {}) => {
  let out = compiled
    .replace(/from ["']react\/jsx-runtime["']/g, `from "${jsxStub}"`)
    .replace(/from ["']react["']/g, `from "${reactStub}"`)
    .replace(/from ["']\.\.\/\.\.\/components["']/g, `from "${componentsStub}"`)
    .replace(/from ["']\.\/assignee-directory["']/g, `from "${directoryStub}"`)
    .replace(/from ["']\.\.\/\.\.\/lib\/format-date["']/g, `from "${formatDateUrl}"`)
    .replace(/from ["']\.\.\/\.\.\/lib\/reminders\/recipients["']/g, `from "${recipientsUrl}"`)
    .replace(/from ["']\.\.\/\.\.\/lib\/reminders\/cascade["']/g, `from "${cascadeUrl}"`)
    .replace(/from ["']\.\.\/\.\.\/lib\/reminders\/schedule["']/g, `from "${scheduleUrl}"`)
    /* A stylesheet is a side-effect import with no module to give it. */
    .replace(/^\s*import ["'][^"']+\.css["'];\s*$/gm, "");
  for (const [from, to] of Object.entries(extra)) {
    out = out.replace(new RegExp(`from ["']${from}["']`, "g"), `from "${to}"`);
  }
  return out;
};

const pickerUrl = asModule(wire(transpile(pickerSource, true)));
const picker = await import(pickerUrl);
const rows = await import(
  asModule(wire(transpile(rowsSource, true), { "\\./recipient-picker": pickerUrl }))
);

/* ─────────────────────────────────────── §6 — the recipient picker's rules ── */

test("a recipient is identified by the same key the send path collapses on", () => {
  /*
   * `normaliseRecipientEmail` lowercases and trims, and it is the ONLY thing
   * two addresses are compared on anywhere in this system. If this diverges,
   * the picker accepts a pair it believes distinct and one of the two people
   * never hears anything.
   */
  assert.equal(
    picker.recipientKey({ userId: null, email: "  Ops@Maintauk.CO.UK ", groupKey: null }),
    picker.recipientKey({ userId: null, email: "ops@maintauk.co.uk", groupKey: null }),
  );
  assert.equal(picker.recipientKey({ userId: "u1", email: null, groupKey: null }), "user:u1");
  assert.equal(
    picker.recipientKey({ userId: null, email: null, groupKey: "renewal-owner" }),
    "group:renewal-owner",
  );
});

test("the same address is never added twice, whatever case it arrives in", () => {
  const one = picker.addRecipient([], { userId: null, email: "Ops@Maintauk.co.uk", groupKey: null });
  assert.equal(one.length, 1);
  const two = picker.addRecipient(one, { userId: null, email: "ops@MAINTAUK.CO.UK", groupKey: null });
  assert.equal(two.length, 1, "§6: the same address must never receive two copies");
});

test("a person picked from the roster and their typed address are one recipient", () => {
  /*
   * The failure this closes is invisible in the UI: two chips, one address,
   * and a reader who believes they wrote to two people. The roster is passed
   * in precisely so the two routes to the same mailbox can be recognised.
   */
  const members = [{ id: "u1", name: "Priya Shah", email: "priya@maintauk.co.uk" }];
  const picked = picker.addRecipient([], { userId: "u1", email: null, groupKey: null }, members);
  const again = picker.addRecipient(
    picked,
    { userId: null, email: "PRIYA@maintauk.co.uk", groupKey: null },
    members,
  );
  assert.equal(again.length, 1);
});

test("two different dynamic groups both survive, because they are different roles", () => {
  const list = picker.addRecipient(
    picker.addRecipient([], { userId: null, email: null, groupKey: "renewal-owner" }),
    { userId: null, email: null, groupKey: "escalation-contact" },
  );
  assert.equal(list.length, 2);
});

test("a malformed address blocks the save and an empty group does not", () => {
  /*
   * §6 says the save is blocked on an invalid entry. An empty dynamic group is
   * NOT invalid — it resolves at send time and somebody may hold the role by
   * then, which is the entire argument for having dynamic groups.
   */
  assert.equal(picker.recipientProblem([{ userId: null, email: null, groupKey: "all-admins" }]), null);
  assert.equal(picker.recipientProblem([{ userId: null, email: "ops@maintauk", groupKey: null }]) !== null, true);
  assert.match(
    picker.recipientProblem([{ userId: null, email: "not-an-address", groupKey: null }]) ?? "",
    /not-an-address/,
    "the reader is told which entry, not merely that one is wrong",
  );
});

test("the picker offers people, groups and a typed address from one combobox", () => {
  const code = codeOnly(pickerSource);
  assert.match(code, /role="combobox"/, "§6: ONE combobox, not three fields");
  assert.match(code, /role="listbox"/);
  assert.match(code, /role="option"/);
  assert.match(code, /Add \$\{typed\}/, '§6: "Add typed@email.com" is offered');
  assert.match(code, /DYNAMIC_GROUPS/, "the groups come from the library, not a local list");
  assert.match(code, /isValidRecipientEmail/, "format is validated by the shared function");
  assert.match(
    code,
    /rows\.push\(\{\s*kind: "email"[\s\S]{0,400}?for \(const member of filterMembers/,
    "§6: the typed address is the FIRST result, before the name matches",
  );
});

test("a group chip is told apart from a person chip without relying on colour", () => {
  /* §8's rule — colour is never the only signal — and the reason it matters
     here: a group resolves at send time and a person does not. */
  assert.match(codeOnly(pickerSource), /recipient-chip--group/);
  assert.match(codeOnly(pickerSource), /recipient-chip__kind/, "the word 'group' is on the chip");
  const chip = rowsCss.slice(rowsCss.indexOf(".recipient-chip--group"));
  assert.match(chip.slice(0, 200), /border-style: dashed/, "shape, not only colour");
});

test("Escape closes the dropdown without closing the dialog behind it", () => {
  /*
   * The dialog listens for Escape on its scrim. A dropdown that let the key
   * bubble would throw away a half-filled form because somebody dismissed a
   * suggestion list — and the same dialog has already had its Escape handling
   * broken once, so this is pinned rather than assumed.
   */
  const code = codeOnly(pickerSource);
  assert.match(
    code,
    /pressed\.key === "Escape" && open[\s\S]{0,200}?stopPropagation\(\)/,
    "stopped only while the list is OPEN, so Escape still closes the dialog otherwise",
  );
});

test("the outside-click dismissal is bound in the capture phase", () => {
  /*
   * REGRESSION PIN, and it names a measured defect rather than a style.
   *
   * On the bubble phase this listener runs after React has handled the same
   * mousedown and flushed the render it caused, so the option element that was
   * clicked has already been removed from the tree — `contains()` is asked
   * about a detached node, answers false, and the dropdown closes on EVERY
   * selection. It did, in a browser: picking one recipient dismissed the list,
   * and the Escape meant for the list then closed the whole dialog with the
   * form in it. Capture runs before the target sees the event, so the DOM is
   * still the one that was clicked.
   */
  const code = codeOnly(pickerSource);
  assert.match(code, /addEventListener\("mousedown", dismiss, true\)/);
  assert.match(code, /removeEventListener\("mousedown", dismiss, true\)/, "same phase, or it is never removed");
});

test("focus never falls out of the dialog when a row or a chip is removed", () => {
  /*
   * ALSO MEASURED. A delete button unmounts itself; focus falls to
   * `document.body`, which is outside the scrim where the dialog's Escape
   * handler lives, and the modal stops closing from a keyboard. The dialog has
   * already been fixed once for the same class of bug — see the note on its
   * focus effect — so both removals hand focus to something that survives.
   */
  assert.match(codeOnly(rowsSource), /addRowRef\.current\?\.focus\(\)/);
  assert.match(
    codeOnly(pickerSource),
    /onChange\(value\.filter[\s\S]{0,80}?inputRef\.current\?\.focus\(\)/,
    "removing a chip returns focus to the input beside it",
  );
});

/* ────────────────────────────────── §7.2 — the seed ladder is a true mirror ── */

test("the modal's default cascade matches reminder_defaults in db/init.ts, step for step", async () => {
  /*
   * THE COPY THAT MUST NOT DRIFT. `db/init.ts` seeds `reminder_defaults` and is
   * the authority; the modal carries its own copy only because a record with
   * no id has nothing to read defaults for. Two ladders that disagree would
   * mean a certificate created in the dialog and one created by the importer
   * chase people on different days, with nothing to say which is right.
   */
  const initSource = await read("db/init.ts");
  const start = initSource.indexOf("const REMINDER_DEFAULTS_SEED");
  assert.ok(start > 0, "REMINDER_DEFAULTS_SEED has moved — re-point this pin, do not delete it");
  const open = initSource.indexOf("= [", start);
  const close = initSource.indexOf("\n];", open);
  const seed = new Function(`return ${initSource.slice(open + 2, close + 2)}`)();

  for (const scope of ["certificate", "visit", "job"]) {
    const fromDatabase = seed.filter((entry) => entry.scope === scope);
    const fromModal = rows.REMINDER_DEFAULT_LADDER[scope];
    assert.equal(
      fromModal.length,
      fromDatabase.length,
      `${scope}: the modal seeds ${fromModal.length} steps and the database ${fromDatabase.length}`,
    );
    fromDatabase.forEach((entry, index) => {
      const mirror = fromModal[index];
      assert.equal(mirror.step_key, entry.key, `${scope} step ${index}: key`);
      assert.equal(mirror.offset_value, entry.value, `${scope} step ${index}: offset`);
      assert.equal(mirror.offset_direction, entry.direction, `${scope} step ${index}: direction`);
      assert.equal(mirror.send_time, "08:00", "§7.2: every default step sends at 08:00");
      assert.deepEqual(mirror.recipient_groups_json, entry.groups, `${scope} step ${index}: groups`);
      assert.equal(Number(mirror.repeat_enabled), entry.repeat, `${scope} step ${index}: repeat`);
      assert.equal(mirror.repeat_interval_days, entry.interval, `${scope} step ${index}: interval`);
      assert.equal(mirror.repeat_cap, entry.cap, `${scope} step ${index}: cap`);
    });
  }
});

test("a new certificate arrives carrying 90 / 60 / 30 / 14 / on-expiry / overdue", () => {
  /* §14: "Creating a certificate generates the six default reminder steps". */
  const drafts = rows.defaultReminderDrafts("certificate", "2027-03-01");
  assert.equal(drafts.length, 6);
  assert.deepEqual(
    drafts.map((row) => `${row.offsetValue}${row.offsetDirection}`),
    ["90before", "60before", "30before", "14before", "0on", "7after"],
  );
  for (const row of drafts) {
    assert.equal(row.sendTime, "08:00", "§7.1: the default send time");
    assert.equal(row.timezone, "Europe/London", "§7.1: the zone is not a guess");
    assert.equal(row.isEnabled, true);
    assert.ok(row.recipients.length, "every default step reaches somebody");
    assert.ok(
      row.recipients.every((entry) => entry.groupKey && !entry.email && !entry.userId),
      "defaults are DYNAMIC groups, so a staff change cannot break an old record",
    );
  }
  assert.equal(drafts[3].repeatEnabled, true, "§7.2: the 14-day step repeats");
  assert.equal(drafts[3].repeatIntervalDays, 3);
  assert.equal(drafts[5].repeatCap, 8, "§7.2: the overdue step caps at 8, not 10");
});

test("a planned visit gets one step the day before, and a note gets none", () => {
  const visit = rows.defaultReminderDrafts("visit", "2027-03-01");
  assert.equal(visit.length, 1, "§4: one reminder, 24 hours before start");
  assert.equal(visit[0].offsetValue, 1);
  assert.equal(visit[0].offsetUnit, "day");
  assert.equal(visit[0].offsetDirection, "before");
  assert.equal(visit[0].sendTime, "08:00");

  assert.deepEqual(
    rows.defaultReminderDrafts("note", "2027-03-01"),
    [],
    "§3: a note's reminders are optional and none by default",
  );
});

test("each calendar item type writes its reminders under the right subject", () => {
  assert.equal(rows.reminderScopeFor("Certificate"), "certificate");
  assert.equal(rows.reminderScopeFor("Planned visit"), "visit");
  assert.equal(rows.reminderScopeFor("Note"), "note");
});

test("an added row is a real, sendable row rather than a blank one", () => {
  const blank = rows.blankReminderDraft();
  assert.equal(blank.id, null, "not yet written");
  assert.equal(blank.sendTime, "08:00");
  assert.equal(blank.timezone, "Europe/London");
  assert.equal(blank.repeatEnabled, false, "§7.1: repeat is off by default");
  assert.equal(blank.repeatIntervalDays, 3, "§7.1: and 3 days when it is turned on");
  assert.equal(blank.repeatCap, 10, "§7.1: hard cap of 10 sends");
  assert.notEqual(blank.key, rows.blankReminderDraft().key, "two added rows are two rows");
});

test("one bad address anywhere in the cascade blocks the whole save", () => {
  const draft = rows.blankReminderDraft();
  assert.equal(rows.reminderDraftsProblem([draft]), null);
  const broken = { ...draft, recipients: [{ userId: null, email: "ops@maintauk", groupKey: null }] };
  const problem = rows.reminderDraftsProblem([draft, broken]);
  assert.ok(problem, "§6: block save on invalid entries");
  assert.match(problem, /ops@maintauk/);
});

/* ────────────────────────────────────────── writing the rows back to D1 ── */

test("saving diffs the list: deletes first, patches the changed, posts the new", async () => {
  /*
   * The route has no bulk-replace verb, and its own note says why: a replace
   * silently discards a row somebody else added while the dialog was open, and
   * a discarded reminder is one everybody believes is set and that never
   * fires. So the client diffs, and the ORDER matters — a delete that landed
   * after its replacement had been created would be the same hazard.
   */
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, text: async () => JSON.stringify({ ok: true }) };
  };
  try {
    const kept = { ...rows.blankReminderDraft(), id: "rem_kept", offsetValue: 45 };
    const dropped = { ...rows.blankReminderDraft(), id: "rem_dropped" };
    const added = rows.blankReminderDraft();
    await rows.persistReminderDrafts({
      scope: "certificate",
      subjectId: "cal_1",
      anchorDate: "2027-03-01",
      rows: [kept, added],
      baseline: [{ ...kept, offsetValue: 30 }, dropped],
    });
    assert.deepEqual(
      calls.map((call) => call.method),
      ["DELETE", "PATCH", "POST"],
      "deletes run before the writes that replace them",
    );
    assert.match(calls[0].url, /id=rem_dropped/);
    assert.equal(calls[1].body.id, "rem_kept");
    assert.equal(calls[1].body.offsetValue, 45, "the changed field goes with the patch");
    assert.equal(calls[2].body.subjectId, "cal_1");
    for (const call of calls.slice(1)) {
      assert.equal(
        call.body.anchorDate,
        "2027-03-01",
        "every write carries the anchor, or next_send_at is computed from the old date",
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("an untouched row is still re-anchored, because the expiry date may have moved", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, text: async () => JSON.stringify({ ok: true }) };
  };
  try {
    const row = { ...rows.blankReminderDraft(), id: "rem_1" };
    await rows.persistReminderDrafts({
      scope: "certificate",
      subjectId: "cal_1",
      anchorDate: "2028-01-09",
      rows: [row],
      baseline: [{ ...row }],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "PATCH");
    assert.deepEqual(
      Object.keys(calls[0].body).sort(),
      ["anchorDate", "id"],
      "nothing else is rewritten — only the derived send date is refreshed",
    );
  } finally {
    globalThis.fetch = original;
  }
});

/* ───────────────────────────────── §7.1 and §7.4 — what a row actually has ── */

test("every reminder row carries all of §7.1's fields", () => {
  const code = codeOnly(rowsSource);
  assert.match(code, /role="switch"/, "enabled toggle");
  assert.match(code, /offsetDirection: changed\.target\.value/, "before / after / on the day");
  assert.match(code, /<option value="week">weeks<\/option>/, "days, weeks and months");
  assert.match(code, /type="time"/, "an exact send time, per row");
  assert.match(code, /reminder-row__zone/, "the read-only zone label beside it");
  assert.match(code, /<RecipientPicker/, "its own recipient set");
  assert.match(code, /customMessage: changed\.target\.value/, "the custom message");
  assert.match(code, /repeatEnabled: changed\.target\.checked/, "repeat until acknowledged");
  assert.match(code, /repeatIntervalDays: Math\.max\(/, "and its interval");
  assert.match(code, /reminder-row__delete/, "§7.4: any row, including a default, may be deleted");
  assert.match(code, /Add a reminder/, "§7.4: unlimited extra rows may be added");
});

test("the send time defaults to 08:00, steps in quarter hours, and stays free to type", () => {
  /* §7.1 asks for both "15-minute steps" and "free entry of any time
     permitted", which are only both true if the quarters are SUGGESTED. */
  const code = codeOnly(rowsSource);
  assert.match(code, /minutes \+= 15/, "the ladder is quarter-hourly");
  assert.match(code, /list=\{timesId\}/, "offered as a datalist, not enforced by `step`");
  assert.match(code, /normaliseClockTime/, "and normalised through the shared function");
  assert.match(rowsSource, /DEFAULT_SEND_TIME/);
});

test("the timezone is shown and is not editable", () => {
  const code = codeOnly(rowsSource);
  assert.match(code, /<span className="reminder-row__zone">\{row\.timezone \|\| DEFAULT_TIMEZONE\}/);
  assert.doesNotMatch(code, /timezone: changed\.target\.value/, "§7.1: read-only label");
});

test("the preview panel is fed by previewCascade and never by its own arithmetic", () => {
  /*
   * The one rule this component has: every instant comes from the shared
   * engine. A panel that computed a date itself could promise 08:00 while the
   * cron sent at 09:00 across the October change, and the engine's own tests
   * would all still pass.
   */
  const code = codeOnly(rowsSource);
  assert.match(code, /previewCascade\(/, "§7.4: the live list of dates and times");
  assert.match(code, /reminderOccurrenceUtc\(/, "and the instants behind it");
  assert.match(code, /PAST_REMINDER_WARNING/, "§7.4's exact sentence, not a paraphrase");
  assert.doesNotMatch(
    code,
    /new Date\([^)]*\)\s*\.\s*set(FullYear|Month|Date|Hours)/,
    "no local date arithmetic",
  );
  assert.doesNotMatch(code, /86400000|24 \* 60 \* 60/, "no hand-rolled day maths");
});

test("the preview sits above the rows it explains", () => {
  const code = codeOnly(rowsSource);
  const preview = code.indexOf("<ReminderPreview");
  const list = code.indexOf("reminder-rows__list");
  assert.ok(preview > 0 && list > preview, "§7.4: prominent, not a footnote");
});

test("a past reminder says so inline, in the specification's own words", async () => {
  const cascade = await import(cascadeUrl);
  const entries = cascade.previewCascade(
    [
      {
        stepKey: "d90",
        isEnabled: true,
        offsetValue: 90,
        offsetDirection: "before",
        occurrenceUtc: new Date("2020-01-01T08:00:00Z"),
      },
    ],
    "Europe/London",
    new Date("2026-09-05T09:00:00Z"),
  );
  assert.equal(entries[0].warning, cascade.PAST_REMINDER_WARNING);
  assert.equal(entries[0].willSend, false, "§7.4: and it is never sent");
  assert.match(
    rowsCss,
    /\.reminder-preview__item\.is-past/,
    "the past row is given its own ground, so the warning is not merely text",
  );
});

test("test send goes to the logged-in user through the route that marks it [TEST]", () => {
  const code = codeOnly(rowsSource);
  assert.match(code, /"\/api\/reminders\/test-send"/);
  assert.match(code, /Test send to me/, "the button says who it reaches");
  assert.doesNotMatch(
    code,
    /recipients: recipientPayload\(row\)[\s\S]{0,200}test-send/,
    "the recipient set is not sent — the route decides, and it decides 'you'",
  );
});

/* ───────────────────────────────────────────── §5 — wired into the dialog ── */

test("the dialog offers reminders on every type, seeded by that type's ladder", () => {
  const code = codeOnly(dialogSource);
  assert.match(code, /reminderScopeFor\(chosenType\?\.key \?\? "Note"\)/);
  assert.match(code, /<ReminderRows/);
  assert.match(code, /anchorDate=\{startsOn\}/, "the record's own date drives every offset");
});

test("the dialog refuses to save a cascade with a malformed address", () => {
  const code = codeOnly(dialogSource);
  assert.match(code, /reminderDraftsProblem\(reminders\.rows\)/);
  assert.match(
    code,
    /const badRecipient[\s\S]{0,120}?if \(badRecipient\) throw new Error\(badRecipient\)/,
    "§6: block save on invalid entries",
  );
});

test("an existing record's reminders are written before the save that closes the dialog", () => {
  /*
   * Ordering, not style. `onSave` unmounts this component, so a reminder write
   * awaited after it has nowhere to report a refusal — the record would save
   * and the failure would vanish.
   */
  const code = codeOnly(dialogSource);
  const persist = code.indexOf("persistReminderDrafts");
  const save = code.indexOf("await onSave(");
  assert.ok(persist > 0 && save > persist, "the cascade is written first");
});

test("a new record's reminders are never dropped in silence", () => {
  const code = codeOnly(dialogSource);
  assert.match(code, /createdItemId\(/, "the new row is identified rather than guessed at");
  assert.match(
    code,
    /could not be attached/,
    "and when it cannot be, the reader is told instead of losing the cascade",
  );
});

test("the type chooser and its Escape handling are untouched", () => {
  /*
   * REGRESSION PIN, and it names a real defect. The focus effect once carried
   * `[]` instead of `[chosenType]`: picking a type unmounted the button that
   * held focus without moving it, focus fell to document.body — outside the
   * scrim, where the Escape handler lives — and the dialog could not be closed
   * from a keyboard at all. Anything added to this file has to leave both of
   * these alone.
   */
  const code = codeOnly(dialogSource);
  assert.match(code, /const target = chosenType \? firstFieldRef\.current : firstChoiceRef\.current;/);
  assert.match(code, /\}, \[chosenType\]\);/, "not [] — see the note beside the effect");
  assert.equal(
    (code.match(/if \(pressed\.key === "Escape"\) onCancel\(\);/g) ?? []).length,
    2,
    "Escape still closes both the chooser and the form",
  );
  assert.match(code, /CALENDAR_ITEM_TYPES\.map/, "the three-option chooser is still step one");
  assert.match(code, /Change type/, "and the back arrow still returns to it");
});

/* ──────────────────────────────────────────────────── the house CSS rules ── */

test("the reminder stylesheet uses tokens and never a colour literal", () => {
  /*
   * A previous pass broke dark mode with hard-coded hex values that only
   * showed up on somebody else's laptop. Every colour here resolves through a
   * custom property that globals.css declares in BOTH themes.
   */
  const literals = rowsCss.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? [];
  assert.deepEqual(literals, [], `colour literals in reminder-rows.css: ${literals.join(", ")}`);
  assert.match(rowsCss, /var\(--surface-card\)/);
  assert.match(rowsCss, /var\(--switch-on\)/);
});

test("both stylesheets stay on the agreed breakpoints", () => {
  for (const [name, css] of [["reminder-rows.css", rowsCss], ["manual-event-dialog.css", dialogCss]]) {
    for (const query of css.match(/@media \([^)]*width: (\d+)px\)/g) ?? []) {
      const width = Number(query.match(/(\d+)px/)[1]);
      assert.ok([640, 767, 768, 1024, 1280].includes(width), `${name}: ${query} is outside the agreed breakpoints`);
    }
  }
});

test("the dialog becomes a bottom sheet under 640px", () => {
  /* §2: "on viewports under 640px the modal renders as a bottom sheet, not a
     centred dialog" — reach, not fashion: Save has to be under a thumb. */
  const sheet = dialogCss.slice(dialogCss.indexOf("@media (max-width: 640px)"));
  assert.ok(sheet, "the bottom-sheet query is missing");
  assert.match(sheet, /place-items: end stretch/, "anchored to the bottom edge, full width");
  assert.match(sheet, /border-radius: 16px 16px 0 0/);
  assert.match(sheet, /max-height: 92vh/, "and it scrolls rather than growing off the top");
  assert.match(sheet, /min-height: 44px/, "the actions clear the touch floor");
});

test("everything a thumb has to hit clears 44px", () => {
  for (const selector of [
    ".recipient-picker__field",
    ".recipient-picker__option",
    ".reminder-rows__add",
    ".reminder-row__check",
  ]) {
    const rule = rowsCss.slice(rowsCss.indexOf(`${selector} {`));
    assert.match(rule.slice(0, 400), /min-height: 44px/, `${selector} is under the touch floor`);
  }
});

test("the picker's own input is 16px, or iOS zooms the dialog and will not zoom back", () => {
  const rule = rowsCss.slice(rowsCss.indexOf(".recipient-picker__input {"));
  assert.match(rule.slice(0, 400), /font-size: 16px/);
});
