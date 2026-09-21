/**
 * §25 — planned maintenance that creates its own jobs. The owner's decision Q4.
 *
 * Three halves:
 *
 *   · THE RULES are CALLED. `app/lib/planned-recurrence.ts` is importless, so it
 *     is transpiled and run: the calendar arithmetic, the "is it due" decision
 *     and the save-time rules are asserted as behaviour, not as source text.
 *   · THE INVARIANTS that live in SQL and in write order are pinned in source:
 *     additive migration, paused by default, the claim index, claim-before-
 *     create, the conditional advance, and the two doors onto the generator.
 *   · THE LIVE HALF drives the generator over HTTP against a dev server, and
 *     skips when none answers.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";

const ts = (await import("typescript")).default;
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

async function loadRules() {
  const source = await read("app/lib/planned-recurrence.ts");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}
const rules = await loadRules();

const schedule = (overrides = {}) => ({
  generationState: "active",
  status: "Scheduled",
  frequency: "Monthly",
  intervalDays: null,
  nextDueAt: "2026-10-15",
  leadDays: 14,
  recurrenceAnchor: "2026-10-15",
  lastGeneratedDueAt: null,
  ...overrides,
});

/* ================================================================== */
/* The calendar                                                        */
/* ================================================================== */

test("month steps count from the anchor, so a month-end date does not drift", () => {
  const monthly = rules.recurrenceStep("Monthly");
  assert.equal(rules.occurrence("2026-01-31", monthly, 1), "2026-02-28", "clamped to February");
  assert.equal(rules.occurrence("2026-01-31", monthly, 2), "2026-03-31", "and back to the 31st, not the 28th");
  assert.equal(rules.occurrence("2028-01-31", monthly, 1), "2028-02-29", "a leap February");
  assert.equal(rules.occurrence("2026-11-30", rules.recurrenceStep("Quarterly"), 1), "2027-02-28", "across a year");
  assert.equal(rules.occurrence("2026-03-10", rules.recurrenceStep("Annual"), 1), "2027-03-10");
  assert.equal(rules.occurrence("2026-03-10", rules.recurrenceStep("Biannual"), 1), "2026-09-10");
  assert.equal(
    rules.nextOccurrenceAfter("2026-01-31", monthly, "2026-02-28"),
    "2026-03-31",
    "the visit after a clamped one returns to the anchor's day",
  );
});

test("day steps, and custom intervals", () => {
  assert.equal(rules.occurrence("2026-12-30", rules.recurrenceStep("Weekly"), 1), "2027-01-06");
  assert.equal(rules.occurrence("2026-10-01", rules.recurrenceStep("Fortnightly"), 2), "2026-10-29");
  assert.equal(rules.occurrence("2026-10-01", rules.recurrenceStep("Daily"), 31), "2026-11-01");
  assert.deepEqual(rules.recurrenceStep("Custom", 10), { days: 10 });
  assert.equal(rules.recurrenceStep("Custom", null), null, "a custom schedule needs its interval");
  assert.equal(rules.recurrenceStep("Custom", 0), null);
  assert.equal(rules.recurrenceStep("One-off"), null, "a one-off does not repeat");
  assert.equal(rules.recurrenceStep("Every so often"), null, "free text is not a frequency");
  assert.equal(rules.firstOccurrenceOnOrAfter("2026-01-05", rules.recurrenceStep("Weekly"), "2026-03-01"), "2026-03-02");
  assert.equal(rules.firstOccurrenceOnOrAfter("2026-01-05", rules.recurrenceStep("Weekly"), "2026-03-02"), "2026-03-02", "on counts");
});

test("a stored date or timestamp is read as a real calendar day, or not at all", () => {
  assert.equal(rules.isoDay("2026-10-15"), "2026-10-15");
  assert.equal(rules.isoDay("2026-10-15T09:30:00.000Z"), "2026-10-15");
  assert.equal(rules.isoDay("2026-02-30"), null, "February has no 30th");
  assert.equal(rules.isoDay("15/10/2026"), null);
  assert.equal(rules.isoDay(""), null);
  assert.equal(rules.isoDay(null), null);
});

/* ================================================================== */
/* Is it due                                                           */
/* ================================================================== */

test("only an ACTIVE schedule generates, and only once its lead window opens", () => {
  const plan = (overrides, today = "2026-10-01") => rules.planGeneration(schedule(overrides), today);
  assert.deepEqual(plan({ generationState: "paused" }), { generate: false, reason: "paused" });
  assert.deepEqual(plan({ generationState: null }), { generate: false, reason: "paused" }, "absent is paused");
  assert.deepEqual(plan({ status: "Cancelled" }), { generate: false, reason: "stopped" });
  assert.deepEqual(plan({ status: "On hold" }), { generate: false, reason: "stopped" });
  assert.deepEqual(plan({ nextDueAt: "someday" }), { generate: false, reason: "no-date" });
  assert.deepEqual(plan({ frequency: "Every so often" }), { generate: false, reason: "unknown-frequency" });
  assert.deepEqual(plan({ lastGeneratedDueAt: "2026-10-15" }), { generate: false, reason: "already-generated" });
  assert.deepEqual(plan({}, "2026-09-30"), { generate: false, reason: "not-yet", opensOn: "2026-10-01" }, "due 15th, 14 days' lead");
  assert.deepEqual(plan({}, "2026-10-01"), { generate: true, dueDate: "2026-10-15", opensOn: "2026-10-01" }, "the day the window opens");
  assert.deepEqual(plan({ leadDays: 0 }, "2026-10-15"), { generate: true, dueDate: "2026-10-15", opensOn: "2026-10-15" });
  assert.equal(plan({ frequency: "One-off" }).generate, true, "a one-off generates once");
  assert.equal(plan({}, "2026-11-20").generate, true, "an overdue visit still generates — once");
});

test("the calendar moves on from the visit, never from when the work was done", () => {
  const today = "2026-10-01";
  assert.equal(rules.advanceAfterGeneration(schedule(), "2026-10-15", today), "2026-11-15", "calendar-driven");
  assert.equal(
    rules.advanceAfterGeneration(schedule({ recurrenceAnchor: "2026-01-31" }), "2026-02-28", "2026-02-20"),
    "2026-03-31",
    "stepping from the anchor, not from a clamped visit",
  );
  assert.equal(
    rules.advanceAfterGeneration(schedule({ frequency: "One-off" }), "2026-10-15", today),
    "2026-10-15",
    "a one-off stays put; last_generated_due_at stops it repeating",
  );
  /* NO BACK-FILL: down for months, the calendar jumps to the next visit from today. */
  assert.equal(
    rules.advanceAfterGeneration(schedule({ recurrenceAnchor: "2026-01-15" }), "2026-02-15", "2026-06-20"),
    "2026-07-15",
    "missed visits are skipped, not created in a burst",
  );
});

/* ================================================================== */
/* Saving a schedule                                                    */
/* ================================================================== */

test("a new schedule is paused unless the save switches it on", () => {
  const created = rules.recurrenceOnSave({ frequency: "Monthly", nextDueAt: "2026-10-15" }, null, "2026-09-22");
  assert.equal(created.ok, true);
  assert.equal(created.fields.generationState, "paused");
  assert.equal(created.fields.recurrenceAnchor, "2026-10-15", "a paused schedule keeps a truthful anchor too");
});

test("switching on is refused, in words, when the schedule could never generate", () => {
  const today = "2026-09-22";
  const refuse = (input) => rules.recurrenceOnSave({ generationState: "active", ...input }, null, today);
  assert.match(refuse({ frequency: "Monthly", nextDueAt: "" }).error, /next due date/);
  assert.match(refuse({ frequency: "Whenever", nextDueAt: "2026-10-15" }).error, /frequency it can repeat on/);
  assert.match(refuse({ frequency: "Custom", nextDueAt: "2026-10-15" }).error, /interval in days/);
  assert.match(
    rules.recurrenceOnSave({ generationState: "on" }, null, today).error,
    /paused or active/,
    "only the two states",
  );
  assert.match(
    rules.recurrenceOnSave({ intervalDays: "0" }, null, today).error,
    /whole number of days/,
  );
  assert.equal(refuse({ frequency: "One-off", nextDueAt: "2026-10-15" }).ok, true, "a one-off may auto-create");
  assert.equal(refuse({ frequency: "Custom", intervalDays: "10", nextDueAt: "2026-10-15" }).ok, true);
});

test("switching on an old schedule rolls it to the coming visit, not a year of missed ones", () => {
  const stored = { generationState: "paused", frequency: "Monthly", intervalDays: null, nextDueAt: "2025-11-10", recurrenceAnchor: "2025-11-10" };
  const saved = rules.recurrenceOnSave({ generationState: "active" }, stored, "2026-09-22");
  assert.equal(saved.ok, true);
  assert.equal(saved.fields.generationState, "active");
  assert.equal(saved.fields.recurrenceAnchor, "2025-11-10", "the calendar keeps its day");
  assert.equal(saved.fields.nextDueAt, "2026-10-10", "the first visit today or later");
});

test("an unchanged save does not move the anchor — the drift the editor would otherwise cause", () => {
  /* The editor posts every field. After a clamp the stored due date is the
     28th; re-anchoring on it would lose the 31st for ever. */
  const stored = { generationState: "active", frequency: "Monthly", intervalDays: null, nextDueAt: "2026-02-28", recurrenceAnchor: "2026-01-31" };
  const saved = rules.recurrenceOnSave(
    { generationState: "active", frequency: "Monthly", intervalDays: "", nextDueAt: "2026-02-28", leadDays: "14" },
    stored,
    "2026-02-10",
  );
  assert.equal(saved.ok, true);
  assert.equal("recurrenceAnchor" in saved.fields, false, "the anchor is untouched");
  const moved = rules.recurrenceOnSave({ nextDueAt: "2026-03-05" }, stored, "2026-02-10");
  assert.equal(moved.fields.recurrenceAnchor, "2026-03-05", "a real change of date re-anchors");
});

/* ================================================================== */
/* The invariants in SQL and in write order                             */
/* ================================================================== */

test("the migration is additive, and every existing schedule stays paused", async () => {
  const init = code(await read("db/init.ts"));
  const stage = init.slice(init.indexOf("async function ensurePlannedRecurrence"), init.indexOf("\n}\n", init.indexOf("async function ensurePlannedRecurrence")));
  assert.match(stage, /\["generation_state", "TEXT NOT NULL DEFAULT 'paused'"\]/, "paused by default is the decision");
  assert.match(stage, /CREATE UNIQUE INDEX IF NOT EXISTS planned_occurrences_once_idx ON planned_occurrences\(schedule_id, due_date\)/);
  assert.doesNotMatch(stage, /\b(DROP|UPDATE|DELETE)\b/, "nothing rewritten, nothing backfilled");
  assert.match(init, /await ensurePlannedRecurrence\(d1\);/);
  const schema = await read("db/schema.ts");
  assert.match(schema, /generationState: text\("generation_state"\)\.notNull\(\)\.default\("paused"\)/);
  assert.match(schema, /uniqueIndex\("planned_occurrences_once_idx"\)\.on\(table\.scheduleId, table\.dueDate\)/);
});

test("the sign-in throttle's millisecond columns are BIGINT for the next database built", async () => {
  const init = code(await read("db/init.ts"));
  assert.match(init, /first_at BIGINT NOT NULL DEFAULT 0,\s*blocked_until BIGINT NOT NULL DEFAULT 0/);
});

test("the generator claims the visit before it creates the job, and advances conditionally", async () => {
  const generator = code(await read("app/lib/planned-generation.ts"));
  const claim = generator.indexOf(".insert(plannedOccurrences)");
  const create = generator.indexOf("await createSubmission(");
  assert.ok(claim > 0 && create > claim, "claim first: the unique index decides who creates");
  assert.match(generator, /\.onConflictDoNothing\(\)\s*\.returning\(\{ id: plannedOccurrences\.id \}\)/);
  /* The guard is on the TEXT column this feature owns, not on `next_due_at`,
     which is timestamptz in Production and would compare exactly only while
     every stored value is millisecond-precise. */
  assert.match(
    generator,
    /return or\(isNull\(plannedMaintenance\.lastGeneratedDueAt\), ne\(plannedMaintenance\.lastGeneratedDueAt, dueDate\)\);/,
    "two runs cannot step the calendar twice",
  );
  assert.equal((generator.match(/notYetRecorded\(dueDate\)/g) ?? []).length, 2, "both advances are guarded");
  assert.doesNotMatch(generator, /eq\(plannedMaintenance\.nextDueAt,/, "never an exact match on a timestamptz");
  assert.match(generator, /await db\.delete\(plannedOccurrences\)\.where\(eq\(plannedOccurrences\.id, claimId\)\)/, "a failed creation releases its claim");
  assert.match(generator, /source: "Planned maintenance"/);
  assert.match(generator, /scheduledDate: dueDate,/, "the visit's day is the job's day");
  assert.match(generator, /dueAt: endOfVisitDay,/, "not an SLA deadline counted from creation");
  assert.doesNotMatch(generator, /\.insert\(maintenanceRequests\)/, "jobs come through createSubmission only");
});

test("the two doors onto the generator: the cron fails closed, the button is sites.edit and site-scoped", async () => {
  const cron = code(await read("app/api/cron/planned-maintenance/route.ts"));
  assert.match(cron, /authoriseCron\(request, "planned-maintenance", await resolveCronSecret\(\)\)/);
  assert.match(cron, /export async function GET\(request: Request\) \{\s*return POST\(request\);/);
  const build = await read("vercel/build-output.mjs");
  assert.match(build, /\{ path: "\/api\/cron\/planned-maintenance", schedule: "\d+ \d+ \* \* \*" \}/, "declared, daily");

  const button = code(await read("app/api/planned-maintenance/generate/route.ts"));
  assert.match(button, /scopedDbWithCapability\(request, "sites\.edit"\)/);
  assert.match(button, /organisationId: scope\.orgId,\s*siteScope: scope\.siteScope,/);
  assert.match(button, /anonymousRefusal\(error\)/);
});

test("the workspace route decides the recurrence columns with the same rules", async () => {
  const route = code(await read("app/api/workspace/route.ts"));
  const uses = route.match(/recurrenceOnSave\(/g) ?? [];
  assert.equal(uses.length, 2, "on create and on update");
  assert.match(route, /\.\.\.recurrence\.fields,\s*updatedAt/, "applied after the supplied fields, so a roll-forward wins");
  assert.match(route, /generationState: item\.generationState === "active" \? "active" : "paused",/);
});

/* ================================================================== */
/* The live half                                                        */
/* ================================================================== */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const OWNER = {
  email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
  password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
};

const serverUp = await (async () => {
  try {
    const r = await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(4000) });
    return r.status < 500;
  } catch {
    return false;
  }
})();

let cookie = null;
async function call(path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { accept: "application/json", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const created = [];
after(async () => {
  if (!serverUp || !cookie) return;
  for (const id of created) {
    await call("/api/workspace", { method: "DELETE", body: JSON.stringify({ entity: "planned", id }) });
  }
});

test("live: an active schedule creates its visit once, then waits for the next window", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(OWNER),
  });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");

  /* The canonical register first; a freshly seeded database has its stores
     only in the workspace snapshot. */
  const sites = await call("/api/sites");
  const snapshot = sites.body?.sites?.length ? null : await call("/api/workspace");
  const siteId = sites.body?.sites?.[0]?.id ?? snapshot?.body?.workspace?.stores?.[0]?.id;
  if (!siteId) return t.skip("no site to schedule against");

  const today = rules.todayUtc();
  const due = rules.addDays(today, 5);
  const stamp = Date.now();

  /* A paused schedule is inert. */
  const paused = await call("/api/workspace", {
    method: "POST",
    body: JSON.stringify({ entity: "planned", data: { siteId, title: `P7-QA paused ${stamp}`, category: "Planned maintenance", frequency: "Weekly", nextDueAt: due, leadDays: 7 } }),
  });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  created.push(paused.body.id);
  const pausedRun = await call("/api/planned-maintenance/generate", { method: "POST", body: JSON.stringify({ scheduleId: paused.body.id }) });
  assert.equal(pausedRun.status, 200);
  assert.equal(pausedRun.body.created, 0, "a paused schedule creates nothing");

  /* An active one, due in five days with a seven-day lead: its window is open. */
  const active = await call("/api/workspace", {
    method: "POST",
    body: JSON.stringify({ entity: "planned", data: { siteId, title: `P7-QA weekly ${stamp}`, category: "Planned maintenance", frequency: "Weekly", nextDueAt: due, leadDays: 7, generationState: "active" } }),
  });
  assert.equal(active.status, 200, JSON.stringify(active.body));
  created.push(active.body.id);

  const first = await call("/api/planned-maintenance/generate", { method: "POST", body: JSON.stringify({ scheduleId: active.body.id }) });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.created, 1, "the visit becomes a job");
  const outcome = first.body.outcomes.find((o) => o.scheduleId === active.body.id);
  assert.equal(outcome.dueDate, due);
  assert.equal(outcome.nextDueAt, rules.addDays(due, 7), "the calendar steps a week");

  const job = await call(`/api/maintenance?id=${encodeURIComponent(outcome.requestId)}`);
  assert.equal(job.status, 200, "the job is a real job on the board");

  /* Pressed again: the next visit's window (due + 7 − 7 = due) is not open yet. */
  const second = await call("/api/planned-maintenance/generate", { method: "POST", body: JSON.stringify({ scheduleId: active.body.id }) });
  assert.equal(second.body.created, 0, "one occurrence at a time");

  /* Put the date back to the visit already generated: the claim refuses a duplicate. */
  const rewound = await call("/api/workspace", {
    method: "PATCH",
    body: JSON.stringify({ entity: "planned", id: active.body.id, data: { nextDueAt: due } }),
  });
  assert.equal(rewound.status, 200, JSON.stringify(rewound.body));
  const third = await call("/api/planned-maintenance/generate", { method: "POST", body: JSON.stringify({ scheduleId: active.body.id }) });
  assert.equal(third.body.created, 0, "the same visit is never created twice");
  const again = third.body.outcomes.find((o) => o.scheduleId === active.body.id);
  assert.equal(again.reason, "already-generated");
  assert.equal(again.requestId, outcome.requestId, "it points at the job that already exists");

  /* Two runs at once for one fresh visit: the unique claim lets exactly one through. */
  const raced = await call("/api/workspace", {
    method: "POST",
    body: JSON.stringify({ entity: "planned", data: { siteId, title: `P7-QA raced ${stamp}`, category: "Planned maintenance", frequency: "Monthly", nextDueAt: due, leadDays: 7, generationState: "active" } }),
  });
  assert.equal(raced.status, 200, JSON.stringify(raced.body));
  created.push(raced.body.id);
  const runs = await Promise.all(
    [1, 2, 3].map(() => call("/api/planned-maintenance/generate", { method: "POST", body: JSON.stringify({ scheduleId: raced.body.id }) })),
  );
  const total = runs.reduce((sum, run) => sum + (run.body?.created ?? 0), 0);
  assert.equal(total, 1, "three simultaneous runs, one job");

  /* Refused in words, not stored silently. */
  const bad = await call("/api/workspace", {
    method: "POST",
    body: JSON.stringify({ entity: "planned", data: { siteId, title: `P7-QA custom ${stamp}`, category: "Planned maintenance", frequency: "Custom", nextDueAt: due, generationState: "active" } }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /interval in days/);
});
