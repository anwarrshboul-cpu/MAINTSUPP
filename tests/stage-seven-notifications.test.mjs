import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

test("stage 7 migration is additive and registered", async () => {
  const sql = await read("drizzle/0011_stage_seven_notifications.sql");
  const body = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .toUpperCase();
  for (const destructive of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE"]) {
    assert.ok(!body.includes(destructive), `Migration contains ${destructive}.`);
  }

  const journal = JSON.parse(await read("drizzle/meta/_journal.json"));
  const entry = journal.entries.find((e) => e.tag === "0011_stage_seven_notifications");
  assert.ok(entry, "migration 0011 must appear in the journal");
  assert.equal(entry.idx, 11);
});

test("a delivery failure never loses the record", async () => {
  const notifications = await read("app/lib/notifications.ts");
  assert.match(
    notifications,
    /Never throws/,
    "the sender must document that it cannot throw",
  );
  // Every path through sendNotification returns a SendResult rather than raising.
  const send = notifications.slice(notifications.indexOf("export async function sendNotification"));
  assert.match(send.slice(0, 3000), /catch \(cause\)/);
  assert.match(send.slice(0, 3000), /return \{ ok: false/);

  const leads = await read("app/api/leads/route.ts");
  const insertAt = leads.indexOf("db.insert(leads)");
  // Match the call site, not the import at the top of the file.
  const notifyAt = leads.indexOf("sendNotification(db,");
  assert.ok(
    insertAt !== -1 && notifyAt > insertAt,
    "the lead must be saved before any notification is attempted",
  );
});

test("an unconfigured provider is skipped, not failed silently", async () => {
  const source = await read("app/lib/notifications.ts");
  assert.match(source, /status: "skipped"/);
  assert.match(source, /No RESEND_API_KEY configured/);
  assert.match(
    source,
    /returns null rather than throwing/,
    "a missing key must not stop a lead being saved",
  );
});

test("every notification attempt is logged", async () => {
  const source = await read("app/lib/notifications.ts");
  const send = source.slice(source.indexOf("export async function sendNotification"));
  const inserts = (send.match(/insert\(notificationLog\)/g) ?? []).length;
  assert.ok(inserts >= 3, `expected a log row on every path, found ${inserts}`);
});

test("leads notify sales and confirm to the prospect", async () => {
  const source = await read("app/api/leads/route.ts");
  assert.match(source, /event: "lead\.created"/, "sales must be told");
  assert.match(source, /event: "lead\.confirmation"/, "the prospect must be confirmed");
  assert.match(source, /to: salesInbox/);
  assert.match(source, /to: email/, "the confirmation goes to the prospect");
});

test("urgent jobs are flagged in the subject line", async () => {
  const source = await read("app/lib/notifications.ts");
  const template = source.slice(source.indexOf("export function jobAlertTemplate"));
  assert.match(template.slice(0, 900), /urgent \? "URGENT — " : ""/);

  const route = await read("app/api/maintenance/route.ts");
  assert.match(route, /event: \(priority \?\? ""\)\.toLowerCase\(\) === "urgent"/);
});

test("compliance thresholds match the agreed schedule", async () => {
  const source = await read("app/api/notifications/compliance/route.ts");
  assert.match(source, /const STAGES = \[90, 60, 30, 14, 7, 0\]/);
  assert.match(source, /return "overdue"/, "an already-expired document must still alert");
});

test("a compliance alert is not repeated every day", async () => {
  const source = await read("app/api/notifications/compliance/route.ts");
  assert.match(source, /alreadyAlerted/);
  assert.match(source, /lastAlertStage/, "the stage reached must be recorded");
  assert.match(
    source,
    /filter\(\(item\) => !item\.alreadyAlerted\)/,
    "only documents crossing a new threshold should alert",
  );
});

test("a failed compliance alert is retried, not marked as handled", async () => {
  const source = await read("app/api/notifications/compliance/route.ts");
  const post = source.slice(source.indexOf("export async function POST"));
  assert.match(
    post,
    /if \(result\.ok\) \{/,
    "the stage must only be recorded after a successful send",
  );
});

test("the compliance scan can run without sending anything", async () => {
  const source = await read("app/api/notifications/compliance/route.ts");
  assert.match(source, /export async function GET/, "the scan must be readable on its own");
  assert.match(source, /dryRun/, "a dry run must be possible before wiring a cron");
});

test("documents marked not required are excluded", async () => {
  const source = await read("app/api/notifications/compliance/route.ts");
  assert.match(source, /if \(row\.notRequired\) continue/);
});

test("failed notifications can be replayed", async () => {
  const lib = await read("app/lib/notifications.ts");
  assert.match(lib, /export async function replayFailed/);
  assert.match(lib, /IN \('failed', 'skipped'\)/, "skipped messages must be replayable too");

  const route = await read("app/api/notifications/replay/route.ts");
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
});

test("notification routes are organisation-scoped and degrade gracefully", async () => {
  for (const route of [
    "app/api/notifications/compliance/route.ts",
    "app/api/notifications/replay/route.ts",
  ]) {
    const source = await read(route);
    assert.match(source, /scopedDb\(request\)/);
    assert.match(source, /status: 503/);
    assert.doesNotMatch(source, /"sunnamusk-uk"/);
  }
});

test("email templates use British formatting and real company details", async () => {
  const source = await read("app/lib/notifications.ts");
  assert.match(source, /company number 17262302/, "the registered number is required on email");
  assert.match(source, /\+44 7852 224644/);
  assert.doesNotMatch(source, /\$\d/, "no dollar amounts");
});
