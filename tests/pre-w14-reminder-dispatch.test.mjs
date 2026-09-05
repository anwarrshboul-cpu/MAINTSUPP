/**
 * THE DISPATCHER'S THREE PROMISES.
 *
 * This suite pins source text rather than running the route, because the route
 * needs a database, a worker binding and a CRON_SECRET that cannot be set in
 * this environment. What it protects are the three orderings that are correct
 * or catastrophic with nothing in between, and none of which a type checker can
 * see:
 *
 *   1. CLAIM BEFORE SEND. Reversed, a crash between the two re-sends the
 *      reminder on the next run — a fourteen-day certificate cascade that
 *      reaches a client nine times.
 *   2. QUIET HOURS DEFER, NEVER CANCEL. A suppressed compliance reminder is a
 *      reminder that did not happen.
 *   3. THE SEND PATH IS SINGULAR. `EMAIL_MODE` is owned by `sendNotification`,
 *      and a second place deciding whether mail leaves the building is how
 *      Preview mail reaches a real client.
 *
 * The idempotency guarantee underneath all of this is the UNIQUE index, which
 * is asserted here against `db/init.ts` and was separately proved against the
 * live SQLite: a second claim on the same (rule, occurrence) is refused by the
 * database, while a repeat three days later is accepted.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const CRON = "app/api/cron/reminders/route.ts";
const INIT = "db/init.ts";
const REPO = "app/lib/reminders/repository.ts";
const ACTION = "app/api/reminders/action/route.ts";
const TEST_SEND = "app/api/reminders/test-send/route.ts";

/* ─────────────────────────────────────────────── 1. claim before send ── */

test("the dispatcher claims the occurrence BEFORE it sends anything", async () => {
  const cron = await read(CRON);
  const claim = cron.indexOf("claimDispatch(");
  const send = cron.indexOf("sendNotification(");
  assert.ok(claim > 0, "the dispatcher must claim");
  assert.ok(send > 0, "the dispatcher must send");
  assert.ok(
    claim < send,
    "sending first means a crash between send and record re-sends on the next run",
  );
});

test("a claim that finds the row already taken skips quietly", async () => {
  const cron = await read(CRON);
  assert.match(
    cron,
    /const dispatchId = await claimDispatch\([\s\S]{0,200}?if \(!dispatchId\) \{[\s\S]{0,120}?continue;/,
    "null from claimDispatch is the normal overlap answer, not an error",
  );
});

test("claimDispatch treats the unique violation as the answer, not an exception", async () => {
  const repo = await read(REPO);
  const fn = repo.slice(
    repo.indexOf("export async function claimDispatch"),
    repo.indexOf("export async function recordDispatchResult"),
  );
  assert.ok(fn.length > 0, "claimDispatch must exist");
  assert.match(fn, /await db\.insert\(reminderDispatch\)/, "the check must BE the insert");
  assert.match(fn, /catch \{[\s\S]*?return null;/, "a violation returns null rather than throwing");
  assert.ok(
    !/\.select\(\)[\s\S]*?from\(reminderDispatch\)/.test(fn),
    "a SELECT-then-INSERT is a race with itself and must never appear here",
  );
});

test("the database, not the application, enforces one dispatch per occurrence", async () => {
  const init = await read(INIT);
  assert.match(
    init,
    /CREATE UNIQUE INDEX IF NOT EXISTS reminder_dispatch_once_idx ON reminder_dispatch\(reminder_id, occurrence_date\)/,
    "the UNIQUE index is the guarantee; the code merely reads its refusal",
  );
});

/* ────────────────────────────────────────────────── 2. quiet hours ── */

test("quiet hours move the send and claim nothing", async () => {
  const cron = await read(CRON);
  const quiet = cron.slice(cron.indexOf("deferPastQuietHours("));
  const nextClaim = quiet.indexOf("claimDispatch(");
  const deferral = quiet.indexOf("noteQuietHoursDeferral(");
  assert.ok(deferral > 0, "a deferral must be recorded");
  assert.ok(
    deferral < nextClaim || nextClaim === -1,
    "the deferral must happen before any claim, or the occurrence is consumed unsent",
  );
  assert.match(quiet, /continue;/, "and the run must move on without dispatching");
});

test("a deferred reminder stays pending — deferring is not cancelling", async () => {
  const cron = await read(CRON);
  const fn = cron.slice(cron.indexOf("async function noteQuietHoursDeferral"));
  assert.match(fn, /nextSendAt/, "it moves the date");
  assert.ok(
    !/status:\s*["'](cancelled|sent|failed)["']/.test(fn.slice(0, 600)),
    "it must not change the status — the reminder is still owed",
  );
});

test("quiet hours are off unless an admin turned them on", async () => {
  const settings = await read("app/lib/reminders/settings.ts");
  assert.match(
    settings,
    /DEFAULT_REMINDER_SETTINGS[\s\S]{0,120}?enabled: false/,
    "an organisation that never opened the setting must send at the time it typed",
  );
  assert.match(
    settings,
    /catch \{[\s\S]{0,400}?return \{\};/,
    "a malformed blob reads as 'not configured' rather than stopping every reminder",
  );
});

/* ──────────────────────────────────────────── 3. one send path ── */

test("the dispatcher never decides for itself whether mail may leave", async () => {
  const cron = await read(CRON);
  /*
   * The header of that route DISCUSSES `EMAIL_MODE` at length, which is a good
   * thing and must not fail this test. What is forbidden is USING it: reading
   * the variable, or calling the accessor, either of which would be a second
   * place deciding whether mail leaves the building.
   */
  const code = cron.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(
    !/process\.env\.EMAIL_MODE|outboundEmailMode\s*\(/.test(code),
    "EMAIL_MODE belongs to sendNotification; a second gate is how Preview mail reaches a client",
  );
  assert.match(cron, /sendNotification\(/, "every send goes through the one sender");
});

test("a reminder with no resolvable recipient is recorded as failed, not as sent", async () => {
  const cron = await read(CRON);
  assert.match(
    cron,
    /addresses\.length === 0[\s\S]{0,400}?status: "failed"/,
    "nothing was attempted, but it must not read as a delivery",
  );
});

test("the rule is advanced even when the send failed", async () => {
  const cron = await read(CRON);
  const tail = cron.slice(cron.indexOf("nextRepeatOccurrence("));
  assert.match(tail, /noteSendOnRule\(/, "the rule must move on");
  /*
   * A failed send that left `next_send_at` in the past would be selected again
   * every hour and refused by the claim every time — permanently due and
   * permanently skipped.
   */
  assert.ok(
    cron.indexOf("nextRepeatOccurrence(") > cron.indexOf("catch (error)"),
    "the advance sits after the try/catch so a failure still advances",
  );
});

test("the schedule's snake_case fields are mapped explicitly, not spread", async () => {
  const cron = await read(CRON);
  const call = cron.slice(cron.indexOf("const next = nextRepeatOccurrence("));
  /*
   * The bug this pins: drizzle returns camelCase and `schedule.ts` reads
   * snake_case. Spreading the row compiles, reads `undefined` for
   * `repeat_enabled`, and means no reminder ever repeats — with nothing red.
   */
  assert.match(call, /repeat_enabled: rule\.repeatEnabled/);
  assert.match(call, /sends_count: Number\(rule\.sendsCount \?\? 0\) \+ 1/);
  assert.ok(
    !/\.\.\.\(rule as unknown as ReminderRuleRow\)/.test(call),
    "spreading the drizzle row silently disables every repeat",
  );
});

/* ──────────────────────────────────────────────── the token links ── */

test("the emailed link cannot act on a GET", async () => {
  const action = await read(ACTION);
  const get = action.slice(action.indexOf("export async function GET"));
  assert.match(get, /status: 405/, "a scanner must not be able to spend a single-use token");
  assert.ok(
    !/redeemActionToken/.test(get),
    "redemption belongs to the POST the confirmation page issues",
  );
});

test("a token is spent with the used-at test inside the UPDATE", async () => {
  const repo = await read(REPO);
  const fn = repo.slice(repo.indexOf("export async function redeemActionToken"));
  assert.match(
    fn,
    /\.update\(reminderTokens\)[\s\S]{0,400}?isNull\(reminderTokens\.usedAt\)/,
    "reading the flag then writing lets two simultaneous clicks both succeed",
  );
  assert.match(fn, /if \(updated\.length === 0\) return null;/, "zero rows changed means somebody else won");
});

test("only the hash of a token is stored", async () => {
  const repo = await read(REPO);
  assert.match(repo, /crypto\.subtle\.digest\("SHA-256"/);
  const issue = repo.slice(repo.indexOf("export async function issueActionToken"));
  assert.match(issue, /tokenHash: await hashToken\(token\)/);
  assert.ok(
    !/token,\s*$/m.test(issue.slice(0, issue.indexOf("return token"))),
    "the token itself must never be written to a column",
  );
});

test("acknowledging stops one step, and renewing stops the record", async () => {
  const repo = await read(REPO);
  const ack = repo.slice(
    repo.indexOf("export async function acknowledgeReminder"),
    repo.indexOf("export async function snoozeReminder"),
  );
  assert.match(ack, /eq\(reminderRules\.id, reminderId\)/, "acknowledgement is scoped to ONE row");

  const renew = repo.slice(repo.indexOf("export async function cancelPendingForSubject"));
  assert.match(renew, /eq\(reminderRules\.subjectId, subjectId\)/, "renewal covers the whole record");
  assert.match(
    renew,
    /or\(eq\(reminderRules\.status, "pending"\), eq\(reminderRules\.status, "failed"\)\)/,
    "already-sent reminders are never retracted — they are the record of what was sent",
  );
});

/* ──────────────────────────────────────────────────── test send ── */

test("a test send is addressed from the session and cannot be redirected", async () => {
  const source = await read(TEST_SEND);
  assert.match(source, /const to = \(actor\.email \?\? ""\)\.trim\(\);/);
  assert.ok(
    !/body[?.]*\.(to|email|recipient)/.test(source),
    "a recipient parameter would make this an open relay wearing a different name",
  );
});

test("a test send consumes no dispatch row and issues no working token", async () => {
  const source = await read(TEST_SEND);
  assert.ok(
    !/claimDispatch|recordDispatchResult/.test(source),
    "consuming the occurrence would stop the real reminder ever going out",
  );
  assert.ok(
    !/issueActionToken/.test(source),
    "a preview must not hand out live Acknowledge or Mark-renewed links",
  );
  assert.match(source, /\[TEST\]/, "and it must be labelled");
});
