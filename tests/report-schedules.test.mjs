/**
 * §32 — reports emailed on a schedule.
 *
 * The calendar rules are CALLED. The guarantees that make this safe are pinned:
 * each recipient's figures are computed under their own access with the page's
 * own loader; recipients are members, never typed addresses; a run is claimed
 * once; and the outcome recorded is what the email door returned — with email
 * not configured, "not delivered" and why, never "sent" (owner decision Q1).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const ts = (await import("typescript")).default;
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

async function loadRules() {
  const source = await read("app/lib/report-schedule-rules.ts");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}
const rules = await loadRules();

test("the next run is the next matching day strictly after today", () => {
  assert.equal(rules.weekdayOf("2026-09-21"), 1, "21 September 2026 is a Monday");
  assert.equal(rules.nextRunOn({ cadence: "daily" }, "2026-09-21"), "2026-09-22");
  assert.equal(rules.nextRunOn({ cadence: "weekly", weekday: 1 }, "2026-09-21"), "2026-09-28", "a Monday schedule made on a Monday waits a week");
  assert.equal(rules.nextRunOn({ cadence: "weekly", weekday: 3 }, "2026-09-21"), "2026-09-23");
  assert.equal(rules.nextRunOn({ cadence: "weekly", weekday: 7 }, "2026-09-26"), "2026-09-27");
  assert.equal(rules.nextRunOn({ cadence: "monthly", monthDay: 1 }, "2026-09-21"), "2026-10-01");
  assert.equal(rules.nextRunOn({ cadence: "monthly", monthDay: 25 }, "2026-09-21"), "2026-09-25");
  assert.equal(rules.nextRunOn({ cadence: "monthly", monthDay: 21 }, "2026-09-21"), "2026-10-21", "today does not count");
  assert.equal(rules.nextRunOn({ cadence: "monthly", monthDay: 5 }, "2026-12-30"), "2027-01-05", "across a year");
  assert.equal(rules.nextRunOn({ cadence: "monthly", monthDay: 31 }, "2026-09-21"), null, "only days every month has");
  assert.equal(rules.nextRunOn({ cadence: "hourly" }, "2026-09-21"), null);
});

test("the period a run reports on always ends yesterday", () => {
  assert.deepEqual(rules.periodWindow("last_7_days", "2026-09-21"), { from: "2026-09-14", to: "2026-09-20" });
  assert.deepEqual(rules.periodWindow("last_30_days", "2026-09-21"), { from: "2026-08-22", to: "2026-09-20" });
  assert.deepEqual(rules.periodWindow("month_to_date", "2026-09-21"), { from: "2026-09-01", to: "2026-09-20" });
  assert.deepEqual(rules.periodWindow("month_to_date", "2026-10-01"), { from: "2026-09-01", to: "2026-09-30" }, "on the 1st, the month just ended");
  assert.deepEqual(rules.periodWindow("last_month", "2026-09-21"), { from: "2026-08-01", to: "2026-08-31" });
  assert.deepEqual(rules.periodWindow("last_month", "2026-01-10"), { from: "2025-12-01", to: "2025-12-31" });
  assert.equal(rules.periodWindow("forever", "2026-09-21"), null);
});

test("a schedule is refused in words when it could not run", () => {
  const base = { name: "Weekly", period: "last_7_days", cadence: "weekly", weekday: 1, recipients: ["user-a"] };
  assert.equal(rules.validateSchedule(base, null).ok, true);
  assert.match(rules.validateSchedule({ ...base, name: "" }, null).error, /name/);
  assert.match(rules.validateSchedule({ ...base, period: "forever" }, null).error, /period/);
  assert.match(rules.validateSchedule({ ...base, cadence: "hourly" }, null).error, /daily, weekly or monthly/);
  assert.match(rules.validateSchedule({ ...base, weekday: 9 }, null).error, /day of the week/);
  assert.match(rules.validateSchedule({ ...base, cadence: "monthly", monthDay: 30 }, null).error, /1 to 28/);
  assert.match(rules.validateSchedule({ ...base, recipients: [] }, null).error, /at least one/);
  assert.match(rules.validateSchedule({ ...base, recipients: Array.from({ length: 21 }, (_, i) => `u${i}`) }, null).error, /At most 20/);
  assert.equal(rules.validateSchedule({ ...base, recipients: ["a", "a", " a "] }, null).fields.recipients, '["a"]', "deduplicated");
});

test("each recipient's figures are computed under their own access, by the page's own loader", async () => {
  const delivery = code(await read("app/lib/report-delivery.ts"));
  assert.match(delivery, /const access = await accessOf\(db, organisationId, person\.id\);/);
  assert.match(delivery, /if \(!\(await may\(db, organisationId, access, "board\.view"\)\)\)/);
  assert.match(delivery, /await loadReportsSnapshot\(db, organisationId, access!\.siteScope, window\)/);
  /* The owner's permission is checked at run time, and a lost one pauses it. */
  assert.match(delivery, /may\(db, organisationId, owner, "data\.export"\)/);
  assert.match(delivery, /await finish\("refused", "The person who set this schedule up can no longer export reports here, so it has been paused\.", 0, true\);/);
  /* The page reads through the same loader. */
  const route = code(await read("app/api/reports/metrics/route.ts"));
  assert.match(route, /await loadReportsSnapshot\(/);
});

test("a run is claimed once, and the outcome is what the email door returned", async () => {
  const delivery = code(await read("app/lib/report-delivery.ts"));
  const claim = delivery.indexOf(".insert(reportDispatches)");
  const send = delivery.indexOf("await sendNotification(db,");
  assert.ok(claim > 0 && send > claim, "claimed before anything is sent");
  assert.match(delivery, /\.onConflictDoNothing\(\)\s*\.returning\(\{ id: reportDispatches\.id \}\)/);
  assert.match(delivery, /statuses\.push\(sent\.status\);/);
  assert.match(delivery, /await finish\("not-delivered", `\$\{delivery\.reason \?\? "Email was not delivered\."\}/, "undelivered says why");
  assert.match(delivery, /const sentCount = statuses\.filter\(\(s\) => s === "sent"\)\.length;/, "'sent' only counts real sends");
  const schema = await read("db/schema.ts");
  assert.match(schema, /uniqueIndex\("report_dispatches_once_idx"\)\.on\(table\.scheduleId, table\.occurrence\)/);
});

test("recipients are members of this workspace, never typed addresses", async () => {
  const route = code(await read("app/api/reports/schedules/route.ts"));
  assert.match(route, /Reports can only be sent to active members of this workspace\./);
  assert.match(route, /scopedDbWithCapability\(request, "data\.export"\)/);
  assert.doesNotMatch(route, /body\.email|recipients: \[?body\.to/);
  assert.match(route, /emailDelivery: emailDeliveryStatus\(\),/, "the screen is told before anybody waits");
});

test("the screen says when email is not configured, and never calls an undelivered run sent", async () => {
  const ui = await read("app/(app)/portal/ops/report-schedules.tsx");
  assert.match(ui, /payload\.emailDelivery\.deliverable/);
  assert.match(ui, /"not-delivered": "Not delivered"/);
  const notifications = await read("app/lib/notifications.ts");
  assert.match(notifications, /export function emailDeliveryStatus\(\)/);
  assert.match(notifications, /Email delivery is not configured on this deployment, so nothing is delivered\./);
  /* The owner-approved legal name, in every email footer. */
  assert.match(notifications, /MAINTSUPP LTD, registered in England &amp; Wales, company number 17262302\./);
  assert.doesNotMatch(notifications, /trading name of Maintauk Ltd/);
});

test("the daily runner sends due schedules; it fails closed without the secret", async () => {
  const daily = code(await read("app/api/cron/daily/route.ts"));
  assert.match(daily, /deliverScheduledReports\(db, \{ origin: publicOrigin\(request\) \}\)/);
  assert.match(daily, /authoriseCron\(request, "daily", await resolveCronSecret\(\)\)/);
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
    const r = await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) });
    return r.status < 500;
  } catch {
    return false;
  }
})();

async function call(cookie, path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { accept: "application/json", "content-type": "application/json", cookie, ...(init.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

test("live: a schedule runs now, and with no email provider it is recorded as not delivered", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((v) => v.split(";")[0]).join("; ");

  const listed = await call(cookie, "/api/reports/schedules");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const recipient = listed.body.recipientsAvailable[0];
  if (!recipient) return t.skip("no member to send to");

  const outsider = await call(cookie, "/api/reports/schedules", {
    method: "POST",
    body: JSON.stringify({ name: "P32-QA outsider", period: "last_7_days", cadence: "daily", recipients: ["user-not-a-member"] }),
  });
  assert.equal(outsider.status, 400, "a non-member is refused");

  const created = await call(cookie, "/api/reports/schedules", {
    method: "POST",
    body: JSON.stringify({ name: `P32-QA weekly ${Date.now()}`, period: "last_30_days", cadence: "weekly", weekday: 1, recipients: [recipient.id] }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.schedule.id;
  assert.ok(created.body.schedule.nextRunOn > new Date().toISOString().slice(0, 10), "the first run is after today");

  const ran = await call(cookie, "/api/reports/schedules/run", { method: "POST", body: JSON.stringify({ id }) });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  if (!listed.body.emailDelivery.deliverable) {
    assert.equal(ran.body.outcome.outcome, "not-delivered", JSON.stringify(ran.body.outcome));
    assert.match(ran.body.outcome.detail, /not configured|test mode|log mode/);
  }
  const after = (await call(cookie, "/api/reports/schedules")).body.schedules.find((s) => s.id === id);
  assert.equal(after.lastOutcome, ran.body.outcome.outcome, "the run is recorded on the schedule");
  assert.equal(after.nextRunOn, created.body.schedule.nextRunOn, "Send now does not use up the scheduled run");

  const paused = await call(cookie, "/api/reports/schedules", { method: "PATCH", body: JSON.stringify({ id, state: "paused" }) });
  assert.equal(paused.body.schedule.state, "paused");
  const removed = await call(cookie, `/api/reports/schedules?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
});
