/**
 * §33 — notifications that tell the truth, a person's own email switches, and
 * the guard that sends one email once.
 *
 *   1. A sink-mode send is `redirected`, never `sent` (owner decision Q1): the
 *      provider accepted it, the recipient received nothing, so `ok` is false
 *      and every caller that trusts `ok` hears the truth.
 *   2. A person who switched a topic off is not emailed about it; the log row
 *      says why. Emails with no person behind the address (operations alerts),
 *      invitations and test sends are never held back.
 *   3. The same email to the same address about the same thing goes once per
 *      ten minutes, claimed by one conditional upsert; a FAILED send gives the
 *      window back so a retry is not refused.
 *   4. The workspace Settings card no longer offers three switches nothing read.
 *
 * The send path is CALLED with a fake database and a fake `fetch`, the way
 * `users-access-rbac.test.mjs` calls it; the SQL itself is exercised by the
 * live half against the dev server's D1.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { getTableName } from "drizzle-orm";
import "./reports-ts-loader.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const notifications = await import("../app/lib/notifications.ts");
const preferences = await import("../app/lib/notification-preferences.ts");

/* ================================================================== */
/* A fake database: enough of drizzle's chain for the send path        */
/* ================================================================== */

function fakeDb({ declined = false, failSelect = false } = {}) {
  const log = [];
  const updates = [];
  const cooldowns = new Map();
  let selects = 0;
  const thenable = (value, extra = {}) => ({
    ...extra,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    catch: (reject) => Promise.resolve(value).catch(reject),
  });
  return {
    log,
    updates,
    cooldowns,
    get selects() {
      return selects;
    },
    insert(table) {
      const name = getTableName(table);
      return {
        values(row) {
          if (name === "notification_log") {
            log.push({ ...row });
            return thenable(undefined);
          }
          return thenable(undefined, {
            onConflictDoUpdate(config) {
              return {
                returning: async () => {
                  const now = config.set.lastAt;
                  const last = cooldowns.get(row.key);
                  if (last === undefined || last <= now - preferences.STORM_WINDOW_MS) {
                    cooldowns.set(row.key, now);
                    return [{ key: row.key }];
                  }
                  return [];
                },
              };
            },
          });
        },
      };
    },
    update(table) {
      const name = getTableName(table);
      return {
        set(row) {
          return {
            where: async () => {
              updates.push({ table: name, ...row });
              if (name === "notification_cooldowns") for (const key of cooldowns.keys()) cooldowns.set(key, row.lastAt);
            },
          };
        },
      };
    },
    select() {
      selects += 1;
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: async () => {
          if (failSelect) throw new Error("relation does not exist");
          return declined ? [{ state: "off" }] : [];
        },
      };
      return chain;
    },
    delete() {
      return { where: () => thenable(undefined) };
    },
  };
}

async function withEmail(env, run) {
  const saved = { EMAIL_MODE: process.env.EMAIL_MODE, RESEND_API_KEY: process.env.RESEND_API_KEY, EMAIL_SINK: process.env.EMAIL_SINK, fetch: globalThis.fetch };
  const calls = [];
  try {
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return env.__fail
        ? new Response("provider refused", { status: 500 })
        : new Response(JSON.stringify({ id: `provider-${calls.length}` }), { status: 200 });
    };
    return await run(calls);
  } finally {
    for (const key of ["EMAIL_MODE", "RESEND_API_KEY", "EMAIL_SINK"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    globalThis.fetch = saved.fetch;
  }
}

const LIVE = { EMAIL_MODE: "live", RESEND_API_KEY: "test-only-not-a-key" };
const SINK = { EMAIL_MODE: "sink", RESEND_API_KEY: "test-only-not-a-key", EMAIL_SINK: "sink@maintsupp.test" };

const automationEmail = (overrides = {}) => ({
  organisationId: "org_test",
  channel: "email",
  event: "automation",
  subjectType: "job",
  subjectId: "job_1",
  to: "coordinator@example.com",
  subject: "Leaking tap — Notify coordinator",
  body: "<p>Leaking tap</p>",
  ...overrides,
});

/* ================================================================== */
/* 1. Redirected is not sent                                           */
/* ================================================================== */

test("a sink-mode send is 'redirected' with ok false, and the log keeps the real recipient", async () => {
  await withEmail(SINK, async (calls) => {
    const db = fakeDb();
    const result = await notifications.sendNotification(db, automationEmail());
    assert.equal(result.status, "redirected");
    assert.equal(result.ok, false, "nobody the email was for received it");
    assert.equal(result.error, notifications.REDIRECTED_REASON);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.to, ["sink@maintsupp.test"], "it went to the test inbox");
    assert.equal(db.log[0].recipient, "coordinator@example.com", "the row names who it was FOR");
    const final = db.updates.find((row) => row.table === "notification_log");
    assert.equal(final.status, "redirected");
    assert.equal("deliveredAt" in final, false, "nothing was delivered to the recipient, so no delivery time");
  });
});

test("a live send is still 'sent' with ok true", async () => {
  await withEmail(LIVE, async (calls) => {
    const db = fakeDb();
    const result = await notifications.sendNotification(db, automationEmail());
    assert.equal(result.status, "sent");
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].body.to, ["coordinator@example.com"]);
  });
});

/* ================================================================== */
/* 2. A person's own switch                                            */
/* ================================================================== */

test("a recipient who switched the topic off is not emailed, and the log says why", async () => {
  await withEmail(LIVE, async (calls) => {
    const db = fakeDb({ declined: true });
    const result = await notifications.sendNotification(db, automationEmail());
    assert.equal(result.status, "suppressed");
    assert.equal(result.suppressedBy, "preference");
    assert.equal(calls.length, 0, "no provider call");
    assert.equal(db.log[0].status, "suppressed");
    assert.match(db.log[0].error, /switched off "Automation emails" in their notification settings/);
  });
});

test("operations alerts, invitations and test sends are nobody's switch to turn off", async () => {
  await withEmail(LIVE, async (calls) => {
    for (const event of ["job.urgent", "job.created", "lead.created", "contractor.uploaded", "compliance.expired", "user.invited", "reminder-test"]) {
      assert.equal(preferences.topicForEvent(event), null, `${event} has no topic`);
    }
    const db = fakeDb({ declined: true });
    const result = await notifications.sendNotification(db, automationEmail({ event: "job.urgent", subjectId: "job_9" }));
    assert.equal(result.status, "sent", "a declined row cannot touch an event with no topic");
    assert.equal(db.selects, 0, "and it is not even looked up");
    assert.equal(calls.length, 1);
  });
  assert.equal(preferences.topicForEvent("report.scheduled"), "reports");
  assert.equal(preferences.topicForEvent("automation"), "automations");
  assert.equal(preferences.topicForEvent("reminder"), "reminders");
});

test("a preference lookup that fails lets the email through", async () => {
  await withEmail(LIVE, async (calls) => {
    const db = fakeDb({ failSelect: true });
    const result = await notifications.sendNotification(db, automationEmail());
    assert.equal(result.status, "sent", "fail open: a lost alert is worse than an unwanted one");
    assert.equal(calls.length, 1);
  });
});

/* ================================================================== */
/* 3. The storm guard                                                  */
/* ================================================================== */

test("the same email twice inside ten minutes goes once", async () => {
  await withEmail(LIVE, async (calls) => {
    const db = fakeDb();
    const first = await notifications.sendNotification(db, automationEmail());
    const second = await notifications.sendNotification(db, automationEmail());
    assert.equal(first.status, "sent");
    assert.equal(second.status, "suppressed");
    assert.equal(second.suppressedBy, "duplicate");
    assert.match(second.error, /last 10 minutes/);
    assert.equal(calls.length, 1, "one provider call");
    assert.equal(db.log.length, 2, "but both are in the log");

    const other = await notifications.sendNotification(db, automationEmail({ subjectId: "job_2" }));
    assert.equal(other.status, "sent", "the same words about a DIFFERENT job are a different email");
    const otherPerson = await notifications.sendNotification(db, automationEmail({ to: "someone.else@example.com" }));
    assert.equal(otherPerson.status, "sent", "and to a different person");
  });
});

test("invitations, test sends and replays are never held back as duplicates", async () => {
  await withEmail(LIVE, async (calls) => {
    const db = fakeDb();
    for (const event of ["user.invited", "reminder-test"]) {
      const request = automationEmail({ event, subjectType: event === "user.invited" ? "invitation" : "job" });
      assert.equal((await notifications.sendNotification(db, request)).status, "sent");
      assert.equal((await notifications.sendNotification(db, request)).status, "sent", `${event} twice is sent twice`);
    }
    await notifications.sendNotification(db, automationEmail({ subjectId: "job_r" }));
    const replay = await notifications.sendNotification(db, automationEmail({ subjectId: "job_r", replayOf: "ntf_old" }));
    assert.equal(replay.status, "sent", "an operator's replay is not a duplicate of the attempt it replaces");
    assert.equal(calls.length, 6);
  });
});

test("a failed send gives its window back, so the retry is attempted", async () => {
  await withEmail({ ...LIVE, __fail: "1" }, async (calls) => {
    const db = fakeDb();
    const first = await notifications.sendNotification(db, automationEmail());
    assert.equal(first.status, "failed");
    const retry = await notifications.sendNotification(db, automationEmail());
    assert.equal(retry.status, "failed", "attempted again, not suppressed as a duplicate");
    assert.equal(calls.length, 2);
  });
});

test("a lead confirmation is keyed by address, so a public form cannot mail one stranger repeatedly", async () => {
  const one = await preferences.stormKey({ organisationId: "o", channel: "email", event: "lead.confirmation", subjectType: "lead", subjectId: "lead_1", to: "Victim@Example.com", subject: "We have your portfolio review request" });
  const two = await preferences.stormKey({ organisationId: "o", channel: "email", event: "lead.confirmation", subjectType: "lead", subjectId: "lead_2", to: "victim@example.com ", subject: "We have your portfolio review request" });
  assert.equal(one, two, "two submissions, one address: the same email");
  const jobA = await preferences.stormKey({ organisationId: "o", channel: "email", event: "automation", subjectType: "job", subjectId: "a", to: "x@y.z", subject: "s" });
  const jobB = await preferences.stormKey({ organisationId: "o", channel: "email", event: "automation", subjectType: "job", subjectId: "b", to: "x@y.z", subject: "s" });
  assert.notEqual(jobA, jobB, "everything else is keyed by the record too");
  assert.match(one, /^[0-9a-f]{64}$/, "a hash — the table stores no address");
});

/* ================================================================== */
/* Source contracts                                                    */
/* ================================================================== */

test("the switch and the guard run inside the one send door, before the mode checks and the network", async () => {
  const source = code(await read("app/lib/notifications.ts"));
  const send = source.indexOf("export async function sendNotification");
  const declined = source.indexOf("await recipientDeclined(db, request.to, topic)");
  const claim = source.indexOf("await claimSendSlot(db, request.organisationId, slot)");
  const logGuard = source.indexOf('config.mode === "log"', send);
  const network = source.indexOf("deliverEmail(config, request)", send);
  assert.ok(send > 0 && declined > send && claim > declined && logGuard > claim && network > logGuard);
  assert.match(source, /STORM_EXEMPT_EVENTS\.has\(request\.event\) \|\| request\.replayOf \? null : await stormKey\(request\)/);
  assert.equal((source.match(/if \(slot\) await releaseSendSlot\(db, slot\);/g) ?? []).length, 2, "both failure paths give the window back");
  assert.match(source, /if \(config\.mode === "sink"\) \{[\s\S]{0,400}status: "redirected"[\s\S]{0,300}return \{ ok: false, logId, status: "redirected", error: REDIRECTED_REASON \};/);
});

test("the claim is one conditional upsert, and both lookups fail open", async () => {
  const source = code(await read("app/lib/notification-preferences.ts"));
  assert.match(source, /\.onConflictDoUpdate\(\{\s*target: notificationCooldowns\.key,\s*set: \{ lastAt: now \},\s*setWhere: sql`\$\{notificationCooldowns\.lastAt\} <= \$\{now - STORM_WINDOW_MS\}`,\s*\}\)\s*\.returning/);
  assert.match(source, /return rows\.length > 0;\s*\} catch \{\s*return true;/, "a failed claim sends");
  assert.match(source, /return rows\[0\]\?\.state === "off";\s*\} catch \{\s*return false;/, "a failed lookup sends");
  assert.match(source, /export const STORM_WINDOW_MS = 10 \* 60 \* 1000;/);
});

test("the tables are additive, TEXT states and BIGINT time, and the fingerprint moved", async () => {
  const init = await read("db/init.ts");
  assert.match(init, /CREATE TABLE IF NOT EXISTS notification_preferences \([\s\S]*?state TEXT NOT NULL DEFAULT 'on'/);
  assert.match(init, /CREATE UNIQUE INDEX IF NOT EXISTS notification_preferences_user_topic_idx ON notification_preferences\(user_id, topic\)/);
  assert.match(init, /CREATE TABLE IF NOT EXISTS notification_cooldowns \([\s\S]*?last_at BIGINT NOT NULL DEFAULT 0/);
  assert.match(init, /await ensureNotificationPreferences\(d1\);/);
  const stage = init.slice(init.indexOf("async function ensureNotificationPreferences"), init.indexOf("async function ensureNotificationPreferences") + 1500);
  assert.doesNotMatch(stage, /DROP|ALTER|DELETE|BOOLEAN/i);
  const booleans = await read("db/sqlite-to-postgres.ts");
  assert.doesNotMatch(booleans, /"state"/, "no new boolean conversion rides on a bare column name");
});

test("every caller reads the new outcomes truthfully", async () => {
  const automation = code(await read("app/lib/automations/actions.ts"));
  assert.match(automation, /if \(result\.status === "skipped" \|\| result\.status === "redirected" \|\| result\.status === "suppressed"\) \{\s*return \{ summary: `email to \$\{to\} not delivered`, skipped:/);
  const reminders = code(await read("app/api/cron/reminders/route.ts"));
  assert.match(reminders, /result\.status === "suppressed" \|\|\s*result\.status === "skipped" \|\|\s*result\.status === "redirected"\s*\)\s*suppressed \+= 1;/);
  const invitations = code(await read("app/api/auth/invitations/route.ts"));
  assert.match(invitations, /case "redirected":\s*return \{\s*\.\.\.base,\s*status: "sink",/);
  assert.doesNotMatch(invitations, /outboundEmailMode\(\)/, "the send's own answer, not a second reading of the mode");
  const testSend = code(await read("app/api/reminders/test-send/route.ts"));
  assert.match(testSend, /result\.status === "redirected"\s*\? `Email is in test mode on this deployment/);
  const reports = code(await read("app/lib/report-delivery.ts"));
  assert.match(reports, /if \(sent\.suppressedBy === "preference"\) reasons\.push/);
  assert.match(reports, /if \(sent\.suppressedBy === "duplicate"\) reasons\.push/);
  const connections = code(await read("app/api/automations/connections/route.ts"));
  assert.match(connections, /delivery\.deliverable\s*\? "Messages are sent through/);
  const platform = code(await read("app/api/account/platform/route.ts"));
  assert.doesNotMatch(platform, /RESEND_API_KEY is set; notifications are delivered and logged\./, "a key is not delivery");
});

test("a person's switches are their own: identity from the session, never the body", async () => {
  const route = code(await read("app/api/account/notifications/route.ts"));
  assert.match(route, /if \(!context\.authenticated\) \{\s*return Response\.json\(\{ error: "Sign in to change your notification settings\." \}, \{ status: 401 \}\);/);
  assert.match(route, /const userId = await accountId\(context\.db, context\.identityEmail\);/);
  assert.match(route, /if \(!TOPIC_KEYS\.has\(topic\)\)/);
  assert.match(route, /typeof payload\?\.enabled !== "boolean"/);
  assert.doesNotMatch(route, /payload\??\.userId|payload\??\.email/, "no id or address is taken from the request");
  assert.match(route, /delivery: emailDeliveryStatus\(\),/, "the screen is told when nothing is delivered");
});

test("the account area has a Notifications panel, reachable from the menu", async () => {
  const panels = await read("app/(app)/portal/views/account-panels.ts");
  assert.match(panels, /\{ key: "notifications", label: "Notifications", icon: "bell", group: "Account"/);
  const shell = await read("app/(app)/portal/views/account-shell.tsx");
  assert.match(shell, /case "notifications":\s*return <AccountNotificationsPanel onNotify=\{notify\} \/>;/);
  const menu = await read("app/(app)/portal/account-menu.tsx");
  assert.match(menu, /href: "\/dashboard\/account\/notifications"/);
  const view = await read("app/(app)/portal/views/account-notifications.tsx");
  assert.match(view, /delivery && !delivery\.deliverable/, "undelivered email is said above the switches");
  assert.match(view, /method: "PUT"/);
});

test("the workspace Settings card no longer offers switches nothing read", async () => {
  const portal = code(await read("app/(app)/portal/portal-app.tsx"));
  assert.doesNotMatch(portal, /Daily operations digest/, "a digest that never existed is not offered");
  assert.doesNotMatch(portal, /setAlerts|alerts\[setting\.key\]/, "no decorative alert switches");
  assert.match(portal, /<WorkspaceEmailPanel \/>/);
  const panel = code(await read("app/(app)/portal/views/workspace-email-panel.tsx"));
  assert.doesNotMatch(panel, /type="checkbox"/, "it describes; it does not pretend to switch");
  assert.match(panel, /href="\/dashboard\/account\/notifications"/);
});

/* ================================================================== */
/* The live half                                                       */
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

async function signIn(t) {
  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) {
    t.skip("the seeded owner could not sign in");
    return null;
  }
  return (login.headers.getSetCookie?.() ?? []).map((v) => v.split(";")[0]).join("; ");
}

test("live: a person reads and sets their own switches, and bad input is refused", { skip: !serverUp }, async (t) => {
  const cookie = await signIn(t);
  if (!cookie) return;
  const read1 = await call(cookie, "/api/account/notifications");
  assert.equal(read1.status, 200, JSON.stringify(read1.body));
  assert.deepEqual(read1.body.topics.map((topic) => topic.key), ["reports", "automations", "reminders"]);
  assert.equal(typeof read1.body.delivery.deliverable, "boolean");

  assert.equal((await call(cookie, "/api/account/notifications", { method: "PUT", body: JSON.stringify({ topic: "everything", enabled: false }) })).status, 400);
  assert.equal((await call(cookie, "/api/account/notifications", { method: "PUT", body: JSON.stringify({ topic: "reports", enabled: "no" }) })).status, 400);

  const off = await call(cookie, "/api/account/notifications", { method: "PUT", body: JSON.stringify({ topic: "reports", enabled: false }) });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.topics.find((topic) => topic.key === "reports").enabled, false);
  const again = await call(cookie, "/api/account/notifications");
  assert.equal(again.body.topics.find((topic) => topic.key === "reports").enabled, false, "it persists");
  const on = await call(cookie, "/api/account/notifications", { method: "PUT", body: JSON.stringify({ topic: "reports", enabled: true }) });
  assert.equal(on.body.topics.find((topic) => topic.key === "reports").enabled, true);
});

test("live: a repeat inside ten minutes is held back, and a person who switched reports off is named", { skip: !serverUp }, async (t) => {
  const session = await signIn(t);
  if (!session) return;
  /* Any member will do for the duplicate; the switch can only be tested on the
     signed-in owner's own account, so that half runs where the owner is a
     member (the demonstration workspace on Staging) and is skipped otherwise. */
  let cookie = null;
  let recipient = null;
  let ownerIsMember = false;
  for (const candidate of [session, `${session}; maintsupp_demo_organisation=org_000000000000000000000002`]) {
    const listed = await call(candidate, "/api/reports/schedules");
    if (listed.status !== 200 || !listed.body.recipientsAvailable?.length) continue;
    const me = listed.body.recipientsAvailable.find((person) => person.email?.toLowerCase() === OWNER.email.toLowerCase());
    if (me || !cookie) {
      cookie = candidate;
      recipient = me ?? listed.body.recipientsAvailable[0];
      ownerIsMember = Boolean(me);
    }
    if (me) break;
  }
  if (!cookie) return t.skip("no workspace with a member to send to");

  const created = await call(cookie, "/api/reports/schedules", {
    method: "POST",
    body: JSON.stringify({ name: `P33-QA ${Date.now()}`, period: "last_7_days", cadence: "weekly", weekday: 1, recipients: [recipient.id] }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.schedule.id;
  try {
    const first = await call(cookie, "/api/reports/schedules/run", { method: "POST", body: JSON.stringify({ id }) });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.doesNotMatch(first.body.outcome.detail, /already had this report/, "the first run is not a duplicate");

    const second = await call(cookie, "/api/reports/schedules/run", { method: "POST", body: JSON.stringify({ id }) });
    assert.match(second.body.outcome.detail, /already had this report in the last 10 minutes/, JSON.stringify(second.body.outcome));
    assert.notEqual(second.body.outcome.outcome, "sent");

    if (ownerIsMember) {
      await call(cookie, "/api/account/notifications", { method: "PUT", body: JSON.stringify({ topic: "reports", enabled: false }) });
      const declined = await call(cookie, "/api/reports/schedules/run", { method: "POST", body: JSON.stringify({ id }) });
      assert.match(declined.body.outcome.detail, /has switched off report emails/, JSON.stringify(declined.body.outcome));
    } else {
      t.diagnostic("the owner is not a member here, so the switch half was not exercised");
    }
  } finally {
    await call(cookie, "/api/account/notifications", { method: "PUT", body: JSON.stringify({ topic: "reports", enabled: true }) });
    await call(cookie, `/api/reports/schedules?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  }
});
