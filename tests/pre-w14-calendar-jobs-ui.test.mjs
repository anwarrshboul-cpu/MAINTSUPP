/**
 * MODULE 2 — THE UNSCHEDULED TRAY, THE JOB SIDE PANEL AND THE STATUS CHIPS.
 *
 * Three features and one shared claim: a job must never become invisible. §4.1
 * says an unmapped status is drawn in grey with its raw label and never hidden;
 * §7 says an unbooked job is listed in a tray because a calendar cannot show
 * one; §5 says a click on a chip opens the job rather than a form. Each of
 * those is a rule about what happens to the record nobody has looked at yet,
 * and each of them fails silently when it fails — which is why they are pinned
 * here rather than left to be noticed.
 *
 * WHAT IS TESTED BY BEHAVIOUR AND WHAT IS TESTED BY TEXT
 *
 * The selection, the ordering, the SLA arithmetic and the chip style are pure
 * functions, so they are imported and CALLED. The two modules are `.tsx`, so
 * React, the JSX runtime, the icon set and the stylesheets are replaced with
 * stubs before the import — the components are never rendered, only defined,
 * which is enough for the exported logic beside them.
 *
 * The wiring in `calendar-surface.tsx` and the geometry in the two stylesheets
 * are pinned as source text, which is this suite's existing convention. Those
 * pins are contracts, not spelling: the DOM attributes the drag depends on live
 * in a file this feature does not own, and a rename there would otherwise turn
 * "drag a job onto a day" into a gesture that silently finds nowhere to drop.
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

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
}

/**
 * Transpile one file and re-point its imports at already-built data URLs.
 *
 * Both `from "x"` and the bare `import "x"` a stylesheet arrives as, because a
 * `.css` import left alone is an unresolvable specifier from a data URL and
 * takes the whole module down before a single assertion runs.
 */
async function build(file, imports) {
  let javascript = transpile(await read(file));
  for (const [specifier, url] of Object.entries(imports)) {
    const quoted = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    javascript = javascript
      .replace(new RegExp(`from ["']${quoted}["']`, "g"), `from "${url}"`)
      .replace(new RegExp(`import ["']${quoted}["']`, "g"), `import "${url}"`);
  }
  return asModule(javascript);
}

const reactStub = asModule(`
  export const useCallback = (fn) => fn;
  export const useEffect = () => {};
  export const useMemo = (fn) => fn();
  export const useRef = (value) => ({ current: value ?? null });
  export const useState = (value) => [typeof value === "function" ? value() : value, () => {}];
  export const useSyncExternalStore = (subscribe, snapshot) => snapshot();
`);
const jsxStub = asModule(`
  export const jsx = () => null;
  export const jsxs = () => null;
  export const Fragment = null;
`);
const componentsStub = asModule(`export const Icon = () => null;`);
const cssStub = asModule(`export default {};`);

const chipInkUrl = await build("app/(app)/portal/chip-ink.ts", {});
const formatDateUrl = await build("app/lib/format-date.ts", {});
const metersUrl = await build("app/(app)/portal/dashboard-meters.ts", {});
const periodUrl = await build("app/(app)/portal/period-model.ts", {
  "./dashboard-meters": metersUrl,
});
const statusMapUrl = await build("app/(app)/portal/job-status-map.ts", {});
const plannedVisitUrl = await build("app/(app)/portal/planned-visit.ts", {});

const panel = await import(
  await build("app/(app)/portal/job-side-panel.tsx", {
    react: reactStub,
    "react/jsx-runtime": jsxStub,
    "../../components": componentsStub,
    "../../lib/format-date": formatDateUrl,
    "./chip-ink": chipInkUrl,
    "./job-status-map": statusMapUrl,
    "./period-model": periodUrl,
    "./job-side-panel.css": cssStub,
  })
);

const tray = await import(
  await build("app/(app)/portal/unscheduled-tray.tsx", {
    react: reactStub,
    "react/jsx-runtime": jsxStub,
    "../../components": componentsStub,
    "../../lib/format-date": formatDateUrl,
    "./job-status-map": statusMapUrl,
    "./job-side-panel": await build("app/(app)/portal/job-side-panel.tsx", {
      react: reactStub,
      "react/jsx-runtime": jsxStub,
      "../../components": componentsStub,
      "../../lib/format-date": formatDateUrl,
      "./chip-ink": chipInkUrl,
      "./job-status-map": statusMapUrl,
      "./period-model": periodUrl,
      "./job-side-panel.css": cssStub,
    }),
    "./planned-visit": plannedVisitUrl,
    "./unscheduled-tray.css": cssStub,
  })
);

const statusMap = await import(statusMapUrl);

/* ── Fixtures ────────────────────────────────────────────────────────────── */

/** The seeded map, trimmed to the rows these tests actually reason about. */
const MAPPINGS = [
  {
    sourceStatusLabel: "New",
    displayLabel: "New / Reported",
    colourHex: "#3B82F6",
    icon: null,
    chipStyle: "outline",
    countsAsOpen: true,
    countsAsOverdueEligible: true,
    sortOrder: 1,
    active: true,
  },
  {
    sourceStatusLabel: "Awaiting parts",
    displayLabel: "Awaiting parts",
    colourHex: "#F97316",
    icon: null,
    chipStyle: "hatched",
    countsAsOpen: true,
    countsAsOverdueEligible: false,
    sortOrder: 2,
    active: true,
  },
  {
    sourceStatusLabel: "Scheduled",
    displayLabel: "Scheduled / Booked",
    colourHex: "#14B8A6",
    icon: null,
    chipStyle: "solid",
    countsAsOpen: true,
    countsAsOverdueEligible: true,
    sortOrder: 3,
    active: true,
  },
  {
    sourceStatusLabel: "Completed",
    displayLabel: "Completed",
    colourHex: "#22C55E",
    icon: null,
    chipStyle: "solid",
    countsAsOpen: false,
    countsAsOverdueEligible: false,
    sortOrder: 4,
    active: true,
  },
  {
    sourceStatusLabel: "Cancelled",
    displayLabel: "Cancelled",
    colourHex: "#475569",
    icon: null,
    chipStyle: "strikethrough",
    countsAsOpen: false,
    countsAsOverdueEligible: false,
    sortOrder: 5,
    active: true,
  },
];

const INDEX = statusMap.jobStatusIndex(MAPPINGS);

let nextId = 0;
function job(fields = {}) {
  nextId += 1;
  return {
    id: `req_${String(nextId).padStart(3, "0")}`,
    reference: `MS-2026-${String(nextId).padStart(4, "0")}`,
    title: "Replace the extractor belt",
    status: "New",
    priority: "Medium",
    tier: 2,
    siteId: "store-aldgate",
    location: "Aldgate",
    requestedAt: "2026-09-01",
    dueAt: null,
    scheduledDate: null,
    scheduledTime: null,
    archived: false,
    ...fields,
  };
}

/* ── §7: which jobs are in the tray, and in what order ───────────────────── */

test("the tray lists every OPEN job with no scheduled date, and nothing else", () => {
  const rows = tray.unscheduledJobs(
    [
      job({ status: "New" }),
      job({ status: "Scheduled", scheduledDate: "2026-09-20" }),
      job({ status: "Completed" }),
      job({ status: "Cancelled" }),
      job({ status: "New", archived: true }),
    ],
    INDEX,
  );
  assert.deepEqual(
    rows.map((row) => row.status),
    ["New"],
    "booked, finished, cancelled and archived jobs are all out; only open and undated remains",
  );
});

test("an UNMAPPED status is in the tray, because unmapped counts as open", () => {
  /*
   * The single most important assertion in this file. `job-status-map.ts` makes
   * an unmapped status count as open precisely so it cannot fall out of the
   * tray and the open-jobs figure — "the silent disappearance this module
   * exists to prevent". A tray that filtered on a list of known statuses would
   * pass every other test here and lose exactly the jobs nobody has a name for.
   */
  const rows = tray.unscheduledJobs([job({ status: "Awaiting client PO" })], INDEX);
  assert.equal(rows.length, 1);
  assert.equal(
    statusMap.jobChipAppearance(rows[0].status, INDEX).label,
    "Awaiting client PO",
    "and it keeps its raw label rather than being renamed to 'Unmapped'",
  );
});

test("the tray sorts by SLA deadline, then by priority, and puts undated last", () => {
  const rows = tray.unscheduledJobs(
    [
      job({ title: "no deadline", dueAt: null }),
      job({ title: "late", dueAt: "2026-09-02" }),
      job({ title: "same day, low", dueAt: "2026-09-10", tier: 3 }),
      job({ title: "same day, urgent", dueAt: "2026-09-10", tier: 1 }),
    ],
    INDEX,
  );
  assert.deepEqual(rows.map((row) => row.title), [
    "late",
    "same day, urgent",
    "same day, low",
    "no deadline",
  ]);
});

test("a job with no deadline sorts last, not first — the list is read from the top", () => {
  /*
   * Both orders are arguable in the abstract and only one is right here. A tray
   * that floated the uncommitted work to the top would bury the job whose clock
   * is running out underneath the ones nobody has promised anything about.
   */
  const rows = tray.unscheduledJobs(
    [job({ title: "undated" }), job({ title: "due tomorrow", dueAt: "2026-09-06" })],
    INDEX,
  );
  assert.equal(rows[0].title, "due tomorrow");
});

test("the ordering is total, so the tray does not reshuffle between renders", () => {
  const a = job({ id: "req_a", dueAt: "2026-09-10", tier: 2 });
  const b = job({ id: "req_b", dueAt: "2026-09-10", tier: 2 });
  assert.deepEqual(
    tray.unscheduledJobs([b, a], INDEX).map((row) => row.id),
    tray.unscheduledJobs([a, b], INDEX).map((row) => row.id),
    "two jobs equal on both keys must still have one stable order",
  );
});

/* ── §7 / §8: when the count turns red ───────────────────────────────────── */

const NOON_10TH = Date.parse("2026-09-10T12:00:00Z");

test("the count goes red on a breach and on the last quarter of the window", () => {
  /* A 10-day window opened on the 1st: 25% remaining is the 8th onward. */
  const breached = job({ requestedAt: "2026-09-01", dueAt: "2026-09-08" });
  const inside = job({ requestedAt: "2026-09-05", dueAt: "2026-09-11" });
  const comfortable = job({ requestedAt: "2026-09-09", dueAt: "2026-10-09" });

  assert.equal(tray.jobsInsideSlaWindow([breached], NOON_10TH), 1, "past the deadline");
  assert.equal(tray.jobsInsideSlaWindow([inside], NOON_10TH), 1, "inside the last 25%");
  assert.equal(tray.jobsInsideSlaWindow([comfortable], NOON_10TH), 0, "plenty of window");
  assert.equal(tray.SLA_ALERT_FRACTION, 0.25, "§8's escalation threshold, not a second one");
});

test("a job with no deadline never turns the count red", () => {
  /*
   * It has no window to be inside. Counting it would paint the header red on a
   * tray of work nobody has committed to a date for, which teaches the reader
   * to stop believing the colour.
   */
  assert.equal(tray.jobsInsideSlaWindow([job({ dueAt: null })], NOON_10TH), 0);
});

/* ── The SLA clock ───────────────────────────────────────────────────────── */

test("a deadline is met by the END of its day, not by its midnight", () => {
  /*
   * The boundary that matters. Measuring against 00:00 marks every same-day job
   * breached the moment the clock strikes midnight — a red badge on a job that
   * has the whole working day to run, on every job due today, every day.
   */
  const today = panel.slaCountdown({ deadline: "2026-09-10", now: NOON_10TH });
  assert.equal(today.breached, false, "due today at noon is not late");

  const yesterday = panel.slaCountdown({ deadline: "2026-09-09", now: NOON_10TH });
  assert.equal(yesterday.breached, true);
  assert.match(yesterday.label, /overdue$/);

  const justPast = panel.slaCountdown({
    deadline: "2026-09-10",
    now: Date.parse("2026-09-11T00:00:00Z"),
  });
  assert.equal(justPast.breached, true, "one millisecond into the 11th, it is late");
});

test("no deadline is null, never zero — 'none remaining' is a different claim", () => {
  const none = panel.slaCountdown({ deadline: null, now: NOON_10TH });
  assert.equal(none.label, null);
  assert.equal(none.remainingMs, null);
  assert.equal(none.breached, false, "a job with no commitment cannot have missed one");
});

test("the countdown rounds to the resolution the decision is made at", () => {
  const days = panel.slaCountdown({ deadline: "2026-09-13", now: NOON_10TH });
  assert.match(days.label, /^3 days left$/);
  const hours = panel.slaCountdown({ deadline: "2026-09-10", now: NOON_10TH });
  assert.match(hours.label, /hours? left$/, "under 48 hours it is counted in hours");
});

test("a window with no length has no fraction remaining", () => {
  /*
   * Not "100% used". A row whose raised date is after its deadline does not
   * describe a window at all, and inventing a fraction for it would put a red
   * count in front of an operator about nothing.
   */
  assert.equal(
    panel.slaWindowRemaining({
      raisedAt: "2026-09-10",
      deadline: "2026-09-01",
      now: NOON_10TH,
    }),
    null,
  );
  assert.equal(
    panel.slaWindowRemaining({ raisedAt: null, deadline: "2026-09-11", now: NOON_10TH }),
    null,
  );
});

test("the deadline the overdue overlay measures is the SLA, then the booking", () => {
  assert.equal(panel.jobDeadlineDay(job({ dueAt: "2026-09-08", scheduledDate: "2026-09-20" })), "2026-09-08");
  assert.equal(panel.jobDeadlineDay(job({ dueAt: null, scheduledDate: "2026-09-20" })), "2026-09-20");
  assert.equal(panel.jobDeadlineDay(job({ dueAt: null, scheduledDate: null })), null);
});

/* ── §4: the chip ────────────────────────────────────────────────────────── */

test("overdue LAYERS on the status colour and never replaces it", () => {
  /*
   * §4.2's whole point, and the assertion this file exists for. A job that is
   * both "Awaiting parts" and late is two facts; a chip repainted red would
   * have told the reader the less useful one.
   */
  const appearance = statusMap.jobChipAppearance("Awaiting parts", INDEX);
  const late = panel.jobChipCss({ appearance, overdue: true, urgent: false });
  const onTime = panel.jobChipCss({ appearance, overdue: false, urgent: false });

  assert.equal(late.backgroundColor, "#F97316", "the ground is still the STATUS colour");
  assert.equal(late.backgroundColor, onTime.backgroundColor, "overdue changed nothing about it");
  assert.match(String(late.borderLeftColor), /danger|#EF4444/i, "the red is on the edge");
  assert.equal(late.borderLeftWidth, 4, "and the edge thickens so it survives greyscale");
  assert.notEqual(onTime.borderLeftColor, late.borderLeftColor);

  /*
   * NO SHORTHAND BESIDE A LONGHAND, pinned because this shipped broken once and
   * a browser was what caught it. Written as `border: "1px solid …"` alongside
   * `borderLeftWidth`, React replays the shorthand AFTER the longhand on a
   * re-render — so the 4px overdue edge reverted to 1px and the one visual
   * signal §4.2 asks for was erased by the property next to it. React warns
   * about the pair in the console; nothing else does.
   */
  for (const shorthand of ["border", "background", "borderWidth", "borderColor"]) {
    assert.equal(
      late[shorthand],
      undefined,
      `${shorthand} is a shorthand and would clobber the longhand beside it`,
    );
  }
});

test("a job chip is square-cornered, which is how it is told from a certificate", () => {
  /*
   * §4.3 — "job chips and certificate chips are distinguishable by shape and
   * icon in greyscale". Shape is set here; the icon is `KIND_ICON` in
   * calendar-views.tsx, pinned further down.
   */
  const css = panel.jobChipCss({
    appearance: statusMap.jobChipAppearance("Scheduled", INDEX),
    overdue: false,
    urgent: false,
  });
  assert.ok(css.borderRadius <= 4, `a job is square, not rounded (got ${css.borderRadius})`);
});

test("an unmapped status is grey, outlined and carries its raw label", () => {
  const appearance = statusMap.jobChipAppearance("Awaiting client PO", INDEX);
  assert.equal(appearance.mapped, false);
  assert.equal(appearance.colourHex, statusMap.UNMAPPED_STATUS_COLOUR);
  assert.equal(appearance.label, "Awaiting client PO");

  const css = panel.jobChipCss({ appearance, overdue: false, urgent: false });
  assert.match(
    String(css.backgroundColor),
    /^var\(--/,
    "an outline chip's GROUND is a surface token, so it is legible in both themes",
  );
  assert.equal(String(css.borderLeftColor).toLowerCase(), statusMap.UNMAPPED_STATUS_COLOUR.toLowerCase());
});

test("hatched, strikethrough and the P1 dot each read without colour", () => {
  const hatched = panel.jobChipCss({
    appearance: statusMap.jobChipAppearance("Awaiting parts", INDEX),
    overdue: false,
    urgent: false,
  });
  assert.match(String(hatched.backgroundImage), /repeating-linear-gradient/, "stripes");

  const cancelled = panel.jobChipCss({
    appearance: statusMap.jobChipAppearance("Cancelled", INDEX),
    overdue: false,
    urgent: false,
  });
  assert.equal(cancelled.textDecoration, "line-through");

  const p1 = panel.jobChipCss({
    appearance: statusMap.jobChipAppearance("Scheduled", INDEX),
    overdue: false,
    urgent: true,
  });
  assert.match(String(p1.backgroundImage), /radial-gradient/, "§4.2's P1 dot");
  assert.equal(
    panel.jobChipCss({
      appearance: statusMap.jobChipAppearance("Scheduled", INDEX),
      overdue: false,
      urgent: false,
    }).backgroundImage,
    undefined,
    "and it is absent on everything that is not P1",
  );
});

test("a completed chip is not faded, and the reason is written down", async () => {
  /*
   * §4.2 asks for 60% opacity and this deliberately does not do it. RE-STATED
   * HERE rather than left in a comment because a later pass "completing the
   * spec" would add it back: `calendar-preferences.ts` measured the cost — a
   * 0.7 wash on a chip that measured 5:1 puts it under AA, invisibly to the
   * contrast suite, which measures the pair and not what was painted over it.
   */
  const css = panel.jobChipCss({
    appearance: statusMap.jobChipAppearance("Completed", INDEX),
    overdue: false,
    urgent: false,
  });
  assert.equal(css.opacity, undefined, "no opacity on a chip whose ink was measured");
  const source = await read("app/(app)/portal/job-side-panel.tsx");
  assert.match(source, /60% opacity/, "and the decision is explained where it was made");
});

/* ── §2 / §5: where a schedule is written ────────────────────────────────── */

test("scheduling a job from the tray writes to the JOB, via the shared decision", () => {
  /*
   * `planned-visit.ts`: a drag, a dialog and a drop out of the tray "are three
   * code paths that must agree, and they agree by all asking here". This pins
   * that the tray asks rather than deciding for itself — the answer being
   * obvious for a job is exactly why a shortcut would be tempting.
   */
  const target = tray.jobScheduleTarget(job({ id: "req_42" }));
  assert.deepEqual(target, {
    kind: "job",
    requestId: "req_42",
    field: "scheduled_date",
  });
});

test("the undo offer lasts the eight seconds §5 asks for", () => {
  assert.equal(tray.SCHEDULE_UNDO_MS, 8000);
});

/* ── The DOM contract the drag depends on ────────────────────────────────── */

test("the tray drops onto the day cells the calendar grid actually publishes", async () => {
  /*
   * A CROSS-FILE CONTRACT, and the reason this is pinned rather than trusted.
   * The tray's drag finds its destination with `elementFromPoint().closest()`
   * over an attribute that lives in `calendar-views.tsx` — a file this feature
   * does not own. Renaming it there breaks nothing that compiles and nothing
   * that renders; it makes a drag quietly find nowhere to drop, on a gesture
   * nobody re-tests after an unrelated refactor.
   */
  const views = await read("app/(app)/portal/calendar-views.tsx");
  assert.match(views, /data-calendar-day=""/, "the month and week cells are marked");
  assert.match(views, /data-day=\{day\}/, "and carry the day they are");

  const drag = await read("app/(app)/portal/calendar-event-drag.ts");
  assert.match(
    drag,
    /const DROP_TARGET_CLASS = "is-calendar-drop"/,
    "the highlight class the tray reuses so both gestures look the same",
  );

  const trayFile = await read("app/(app)/portal/unscheduled-tray.tsx");
  assert.match(trayFile, /CALENDAR_DAY_SELECTOR = "\[data-calendar-day\]"/);
  assert.match(trayFile, /CALENDAR_DROP_CLASS = "is-calendar-drop"/);
  assert.equal(tray.CALENDAR_DAY_SELECTOR, "[data-calendar-day]");
  assert.equal(tray.CALENDAR_DROP_CLASS, "is-calendar-drop");
});

/* ── The wiring in calendar-surface.tsx ──────────────────────────────────── */

const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the calendar mounts the tray and the panel, and only there", async () => {
  const surface = codeOnly(await read("app/(app)/portal/calendar-surface.tsx"));
  assert.match(surface, /<UnscheduledTray/, "the tray is docked beside the grid");
  assert.match(surface, /<JobSidePanel/, "and the panel opens in the same column");
  assert.match(
    surface,
    /<section className="panel calendar-panel">/,
    "the panel both hosts know this screen by must survive the new wrapper",
  );
});

test("a job chip opens the side panel, not the record and not a form", async () => {
  const surface = codeOnly(await read("app/(app)/portal/calendar-surface.tsx"));
  assert.match(
    surface,
    /if \(event\.kind === "job" && event\.request\) \{[\s\S]{0,120}setOpenJobId\(event\.request\.id\)/,
    "§5 — a chip is a scheduling question, and the full drawer takes the week off the screen",
  );
  assert.match(
    surface,
    /onOpenRecord=\{\(\) => onOpenRequest\(openJob\)\}/,
    "and the record is still one deliberate click away, from the panel's own footer",
  );
});

test("the open job is held by ID, so an edit is never shown against a stale copy", async () => {
  const surface = await read("app/(app)/portal/calendar-surface.tsx");
  assert.match(surface, /const \[openJobId, setOpenJobId\] = useState<string \| null>\(null\)/);
  assert.match(
    surface,
    /requests\.find\(\(request\) => request\.id === openJobId\)/,
    "read back out of the records every render rather than frozen at open time",
  );
});

test("a finished job is not dragged, and the rule comes from the map", async () => {
  const surface = await read("app/(app)/portal/calendar-surface.tsx");
  assert.match(
    surface,
    /if \(!appearance\.countsAsOpen\) \{/,
    "§5 blocks Completed and Cancelled by `counts_as_open`, not by a list of words " +
      "— an estate that renames 'Cancelled' keeps the rule",
  );
  assert.match(
    surface,
    /day > deadline && event\.field !== "dueAt"/,
    "and dragging past the deadline confirms — except when the deadline IS what is being dragged",
  );
  assert.match(surface, /<ScheduleConfirm/, "the confirmation is a dialog, not window.confirm");
});

test("a write from the calendar goes to the job route, and is checked on the way back", async () => {
  const surface = await read("app/(app)/portal/calendar-surface.tsx");
  assert.match(
    surface,
    /fetch\("\/api\/maintenance", \{\s*method: "PATCH"/,
    "the same route the board and the drawer use — §2's no-duplicate rule, by construction",
  );
  assert.match(
    surface,
    /function fieldWasApplied\(sent: unknown, saved: unknown\): boolean/,
    "PATCH ignores fields it does not know, so a 200 that stored nothing must not read as success",
  );
  assert.match(
    surface,
    /did not store \$\{ignored\.join\(", "\)\}/,
    "and the caller is told which field was dropped",
  );
  assert.match(surface, /jobScheduleTarget\(job\)/, "the drop asks where the write goes");
});

test("the unmapped-status notice is raised on the calendar", async () => {
  const surface = await read("app/(app)/portal/calendar-surface.tsx");
  assert.match(surface, /unmappedStatusNotice\(/, "§4.1's one-line admin notice");
  assert.match(
    surface,
    /statusMapLoaded\s*\?\s*unmappedStatusNotice/,
    "and it is not raised before the map has arrived, when everything looks unmapped",
  );
});

test("the surface still uses parseStamp and never Date.parse", async () => {
  /*
   * RE-STATED from workstream-eight, not duplicated to be tidy: this file adds
   * date arithmetic to the same component, and `Date.parse` reads a bare
   * `YYYY-MM-DD` as UTC midnight — which west of Greenwich moved every range
   * boundary a day. A new helper is exactly how it would come back.
   */
  const surface = await read("app/(app)/portal/calendar-surface.tsx");
  assert.doesNotMatch(surface, /Date\.parse\(/);
});

/* ── The two stylesheets ─────────────────────────────────────────────────── */

const SHEETS = [
  "app/(app)/portal/unscheduled-tray.css",
  "app/(app)/portal/job-side-panel.css",
];

test("no colour literal for any surface, line or ink", async () => {
  /*
   * The rule that keeps dark mode working. A hex in one of these files would be
   * correct in whichever theme its author had open and wrong in the other, and
   * nothing renders differently enough for review to catch it. The one status
   * colour that IS a literal never reaches CSS: it arrives as an inline style
   * from `job_status_map`, because a value the database holds cannot be a token.
   *
   * `rgba()` is allowed for the modal scrim alone, which is what
   * calendar-page.css already does for the same object — a scrim is a shadow
   * over the page rather than a surface with a foreground, and there is no
   * token for one.
   */
  for (const sheet of SHEETS) {
    const css = await read(sheet);
    const literals = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(literals, [], `${sheet} must use tokens: found ${literals.join(", ")}`);
    for (const rgba of css.match(/rgba?\([^)]*\)/g) ?? []) {
      assert.ok(
        css.slice(0, css.indexOf(rgba)).includes("scrim"),
        `${rgba} in ${sheet} is outside the scrim exception`,
      );
    }
  }
});

test("the stylesheets keep to the agreed breakpoints", async () => {
  for (const sheet of SHEETS) {
    const css = await read(sheet);
    for (const query of css.match(/@media \([^)]*width: (\d+)px\)/g) ?? []) {
      const width = Number(query.match(/(\d+)px/)[1]);
      assert.ok(
        [640, 767, 768, 1024, 1280].includes(width),
        `${query} in ${sheet} is outside the agreed breakpoints`,
      );
    }
  }
});

test("§7's bottom sheet exists, and the tray is never simply hidden", async () => {
  const css = await read("app/(app)/portal/unscheduled-tray.css");
  const sheet = css.slice(css.indexOf("@media (max-width: 640px)"));
  assert.match(sheet, /position: fixed/, "the tray becomes a bottom sheet on a phone");
  assert.match(sheet, /bottom: 0/);
  /*
   * And it must RELEASE the docked `top: 12px`. With both edges set and a
   * max-height, `top` wins — which anchored the "bottom sheet" to the top of the
   * phone, over the calendar it exists to be dropped onto. Measured at top 12 /
   * bottom 441 of a 780px viewport before this line was added.
   */
  assert.match(sheet, /top: auto/, "or the sticky offset above pins it to the top");
  assert.doesNotMatch(
    css,
    /\.unscheduled-tray\s*\{[^}]*display: none/,
    "collapsed is the header alone — a hidden tray takes its count with it, and the count is the feature",
  );
});

test("every control a thumb has to hit is at least 44px", async () => {
  for (const sheet of SHEETS) {
    const css = await read(sheet);
    assert.match(css, /min-height: 44px/, `${sheet} must state the touch minimum`);
  }
  const css = await read("app/(app)/portal/unscheduled-tray.css");
  assert.match(
    css,
    /\.unscheduled-tray__row\[data-tray-draggable\] \{[^}]*touch-action: none/,
    "and a draggable row takes the gesture off the browser, or a finger on it is a scroll",
  );
  assert.match(
    css,
    /\.unscheduled-tray__ghost \{[^}]*pointer-events: none/,
    "the ghost must not be the element `elementFromPoint` finds, or nothing is ever a drop target",
  );
});
