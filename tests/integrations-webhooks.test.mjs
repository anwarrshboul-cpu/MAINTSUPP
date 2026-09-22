/**
 * §35b — signed outbound webhooks and Slack connections.
 *
 *   · WHERE it will send: https to a public name, never an IP literal or an
 *     internal suffix — and every resolved address checked again at connect.
 *   · WHAT it proves: `Maintsupp-Signature: t=…,v1=HMAC-SHA256(secret, t.body)`,
 *     checked here against node:crypto, not against itself.
 *   · WHEN it sends: job.created and job.status_changed from the one function
 *     every door calls; never an import, a subitem or another board's row.
 *   · HOW it retries: claimed once, backoff 1m → 24h, abandoned after eight,
 *     a 410 or fifteen failures in a row switch the endpoint off.
 *
 * The delivery logic runs against a REAL SQLite (node:sqlite behind drizzle's
 * sqlite-proxy) built from the migration's own DDL, with an injected transport
 * — no network. Owner decision Q2 holds throughout: without
 * MAINTSUPP_SECRETS_KEY nothing is stored and nothing is sent.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import "./reports-ts-loader.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const urls = await import("../app/lib/integrations/outbound-url.ts");
const signing = await import("../app/lib/integrations/webhook-signature.ts");
const slack = await import("../app/lib/integrations/slack.ts");
const webhooks = await import("../app/lib/integrations/webhooks.ts");
const box = await import("../app/lib/secret-box.ts");

/* ================================================================== */
/* Where it will send                                                  */
/* ================================================================== */

test("only https to a public domain name is accepted as typed", () => {
  const accepted = ["https://hooks.zapier.com/hooks/catch/123/abc/", "https://example.com/maintsupp", "https://api.example.co.uk:443/x"];
  for (const url of accepted) assert.equal(urls.checkOutboundUrl(url, "webhook").ok, true, url);
  const refused = {
    "http://example.com/x": /https/,
    "https://user:pass@example.com/x": /username or password/,
    "https://example.com:8443/x": /443/,
    "https://127.0.0.1/x": /not an IP address/,
    "https://[::1]/x": /not an IP address/,
    "https://169.254.169.254/latest/meta-data": /not an IP address/,
    "https://2130706433/x": /not an IP address/,
    "https://localhost/x": /full public domain|private network/,
    "https://db.internal/x": /private network/,
    "https://printer.local/x": /private network/,
    "https://metadata.google.internal/x": /private network/,
    "https://intranet/x": /full public domain/,
    "not a url": /not a web address/,
  };
  for (const [url, reason] of Object.entries(refused)) {
    const verdict = urls.checkOutboundUrl(url, "webhook");
    assert.equal(verdict.ok, false, url);
    assert.match(verdict.error, reason, url);
  }
});

test("a Slack connection must be a Slack incoming webhook", () => {
  assert.equal(urls.checkOutboundUrl("https://hooks.slack.com/services/T000/B000/XXXX", "slack").ok, true);
  for (const url of ["https://hooks.slack.com/other/T/B/X", "https://example.com/services/T/B/X", "https://hooks.slack.com/services/T"]) {
    assert.match(urls.checkOutboundUrl(url, "slack").error, /Slack incoming-webhook/, url);
  }
});

test("every private, loopback, link-local or reserved address is refused, in both families", () => {
  const privateOnes = [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "192.0.2.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fd00:ec2::254", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "2002:c0a8:0101::1",
    "not-an-address",
  ];
  for (const address of privateOnes) assert.equal(urls.isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4009:81f::200e", "::ffff:8.8.8.8"]) {
    assert.equal(urls.isPublicAddress(address), true, address);
  }
});

test("the connecting transport resolves every address and refuses any private answer", async () => {
  const source = code(await read("app/lib/integrations/outbound-http.ts"));
  assert.match(source, /dns\.lookup\(hostname, \{ all: true, verbatim: true \}/);
  assert.match(source, /if \(addresses\.some\(\(entry\) => !isPublicAddress\(entry\.address\)\)\) return callback\(new Error\("private"\)\);/);
  assert.match(source, /lookup: lookup as never,/, "the check and the connection use the same answer");
  assert.match(source, /redirect: "manual"/, "never follow a redirect");
  assert.doesNotMatch(source, /error\.message\s*\}/, "a raw error can carry the URL: fixed phrases only");
});

/* ================================================================== */
/* What it proves                                                      */
/* ================================================================== */

test("the signature is HMAC-SHA256 over `t.body`, and a receiver can verify it", async () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1", type: "job.created" });
  const header = await signing.signWebhook(secret, body, 1_790_000_000);
  const expected = createHmac("sha256", secret).update(`1790000000.${body}`).digest("hex");
  assert.equal(header, `t=1790000000,v1=${expected}`, "known answer from node:crypto");
  const now = 1_790_000_000_000;
  assert.equal(await signing.verifyWebhookSignature(header, body, secret, 300, now), true);
  assert.equal(await signing.verifyWebhookSignature(header, body, "whsec_other", 300, now), false, "wrong secret");
  assert.equal(await signing.verifyWebhookSignature(header, `${body} `, secret, 300, now), false, "edited body");
  assert.equal(await signing.verifyWebhookSignature(header, body, secret, 300, now + 301_000), false, "stale");
  assert.equal(await signing.verifyWebhookSignature(`${header},v1=${"0".repeat(64)}`, body, secret, 300, now), true, "rollover: any v1 may match");
  assert.match(signing.newSigningSecret(), /^whsec_[A-Za-z0-9_-]{43}$/);
});

/* ================================================================== */
/* When it sends                                                       */
/* ================================================================== */

test("job.created from every creating door, job.status_changed from a status move, nothing from an import", () => {
  const created = [
    { requestId: "a", field: "stage", from: null, to: "Incoming" },
    { requestId: "a", field: "status", from: null, to: "New" },
  ];
  assert.deepEqual(webhooks.classifyJobEvents("created:portal", created), [{ type: "job.created", requestId: "a" }]);
  assert.deepEqual(webhooks.classifyJobEvents("board.create", created).map((e) => e.type), ["job.created"]);
  assert.deepEqual(webhooks.classifyJobEvents("board.duplicate", created).map((e) => e.type), ["job.created"]);
  assert.deepEqual(webhooks.classifyJobEvents("import", created), [], "an import is a migration, not news");
  const moved = [
    { requestId: "b", field: "status", from: "New", to: "Scheduled" },
    { requestId: "b", field: "stage", from: "Incoming", to: "Active" },
  ];
  assert.deepEqual(webhooks.classifyJobEvents("job.edit", moved), [
    { type: "job.status_changed", requestId: "b", change: { field: "status", from: "New", to: "Scheduled" } },
  ]);
  assert.deepEqual(webhooks.classifyJobEvents("board.move", [{ requestId: "c", field: "stage", from: "A", to: "B" }]), [], "a stage-only move is not a status change");
});

test("the one door every job change passes calls the emitter, which never throws", async () => {
  const history = code(await read("app/lib/job-status-history.ts"));
  assert.match(history, /await emitJobEvents\(db, \{ organisationId: input\.organisationId, source: input\.source, changes \}\);/);
  const lib = code(await read("app/lib/integrations/webhooks.ts"));
  const emit = lib.slice(lib.indexOf("export async function emitJobEvents"), lib.indexOf("async function endpointCredentials"));
  assert.match(emit, /\} catch \(error\) \{\s*console\.error\("\[webhooks\] events could not be queued:", errorName\(error\)\);/);
  assert.match(emit, /isNull\(maintenanceRequests\.deletedAt\),\s*isNull\(maintenanceRequests\.parentId\),\s*jobsBoardCondition\(\),/);
});

test("a Slack message is one escaped line — a job title cannot page a channel", () => {
  const message = slack.slackMessage(
    { type: "job.created", data: { job: { id: "j1", reference: "MS-1", title: "<!channel> leak & <https://evil|click>", priority: "Urgent", location: "Unit 4" } } },
    "https://maintsupp.com",
  );
  assert.equal(message.text.split("\n")[0], "New job MS-1: &lt;!channel&gt; leak &amp; &lt;https://evil|click&gt; — Unit 4 (Urgent)");
  assert.match(message.text, /<https:\/\/maintsupp\.com\/dashboard\/jobs\?item=j1\|Open in MAINTSUPP>$/);
  assert.equal(slack.slackMessage({ type: "ping" }, null).text, "MAINTSUPP test message: this Slack connection works.");
  assert.match(
    slack.slackMessage({ type: "job.status_changed", data: { job: { id: "j", reference: "MS-2", title: "Door" }, change: { from: "New", to: "Done" } } }, null).text,
    /^Job MS-2 \(Door\) moved from New to Done$/,
  );
});

test("the payload is an allowlist: no contact, requester, description or cost", async () => {
  const lib = code(await read("app/lib/integrations/webhooks.ts"));
  const job = lib.slice(lib.indexOf("export function webhookJob"), lib.indexOf("export function eventPayload"));
  assert.doesNotMatch(job, /contact|requester|description|cost|invoice|createdByEmail|publicUpload/i);
});

/* ================================================================== */
/* How it sends and retries — against a real SQLite                     */
/* ================================================================== */

const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  /* node:sqlite enforces foreign keys, so the parents the DDL names exist. */
  sqlite.exec("CREATE TABLE organisations (id TEXT PRIMARY KEY); INSERT INTO organisations VALUES ('org_a'), ('org_b');");
  const init = await read("db/init.ts");
  for (const table of ["webhook_endpoints", "webhook_deliveries"]) {
    const ddl = init.match(new RegExp("`(CREATE TABLE IF NOT EXISTS " + table + " \\([\\s\\S]*?\\))`"))[1];
    sqlite.exec(ddl);
  }
  sqlite.exec(init.match(/"(CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_once_idx[^"]+)"/)[1]);
  sqlite.exec(`CREATE TABLE maintenance_requests (id TEXT PRIMARY KEY, organisation_id TEXT, reference TEXT, title TEXT,
    status TEXT, stage TEXT, priority TEXT, category TEXT, site_id TEXT, location TEXT, requested_at TEXT, due_at TEXT,
    completed_at TEXT, deleted_at TEXT, parent_id TEXT)`);
  sqlite.exec("CREATE TABLE maintenance_group_items (request_id TEXT, organisation_id TEXT, board_id TEXT)");
  const db = drizzle(async (sql, params, method) => {
    const statement = sqlite.prepare(sql);
    const values = params.map((value) => (value === undefined ? null : value));
    if (method === "run") {
      statement.run(...values);
      return { rows: [] };
    }
    statement.setReturnArrays?.(true);
    const rows = statement.all(...values).map((row) => (Array.isArray(row) ? row : Object.values(row)));
    return { rows: method === "get" ? rows[0] : rows };
  });
  return { sqlite, db };
}

async function withKey(run) {
  const saved = process.env.MAINTSUPP_SECRETS_KEY;
  process.env.MAINTSUPP_SECRETS_KEY = KEY;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.MAINTSUPP_SECRETS_KEY;
    else process.env.MAINTSUPP_SECRETS_KEY = saved;
  }
}

async function addEndpoint(sqlite, { id = "whk_1", kind = "webhook", events = ["job.created", "job.status_changed"], state = "on", failures = 0 } = {}) {
  const url = kind === "slack" ? "https://hooks.slack.com/services/T/B/X" : "https://receiver.example.com/hook";
  const secret = "whsec_testsecret";
  const sealedUrl = await box.sealSecret(url, { purpose: "webhook.url", organisationId: "org_a", recordId: id });
  const sealedSecret = kind === "webhook" ? await box.sealSecret(secret, { purpose: "webhook.secret", organisationId: "org_a", recordId: id }) : null;
  sqlite
    .prepare(`INSERT INTO webhook_endpoints (id, organisation_id, kind, name, url_host, url_hint, url_sealed, secret_sealed,
      events, state, consecutive_failures, created_by_user_id, created_by_email) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, "org_a", kind, "Receiver", "receiver.example.com", "https://receiver.example.com/…hook", sealedUrl, sealedSecret, JSON.stringify(events), state, failures, "u1", "owner@example.com");
  return { url, secret };
}

function addDelivery(sqlite, { id = "whd_1", endpointId = "whk_1", status = "pending", attempts = 0, next = 0 } = {}) {
  const payload = JSON.stringify({ id: `evt_${id}`, type: "job.created", data: { job: { id: "j1", reference: "MS-1", title: "Door" } } });
  sqlite
    .prepare(`INSERT INTO webhook_deliveries (id, organisation_id, endpoint_id, event_id, event_type, payload, status, attempts, next_attempt_at, claimed_until)
      VALUES (?,?,?,?,?,?,?,?,?,0)`)
    .run(id, "org_a", endpointId, `evt_${id}`, "job.created", payload, status, attempts, next);
  return payload;
}

const row = (sqlite, table, id) => sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);

test("a delivery is signed, sent to the stored address, and recorded as delivered", async () => {
  await withKey(async () => {
    const { sqlite, db } = await database();
    const { url, secret } = await addEndpoint(sqlite);
    const payload = addDelivery(sqlite);
    const sent = [];
    const outcome = await webhooks.attemptDelivery(db, "whd_1", "org_a", async (request) => {
      sent.push(request);
      return { status: 204, excerpt: "" };
    });
    assert.equal(outcome, "delivered");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, url, "the sealed address, opened");
    assert.equal(sent[0].body, payload, "exactly the payload that was stored");
    assert.equal(sent[0].headers["maintsupp-event-id"], "evt_whd_1");
    assert.equal(sent[0].headers["maintsupp-delivery-attempt"], "1");
    assert.equal(await signing.verifyWebhookSignature(sent[0].headers["maintsupp-signature"], sent[0].body, secret), true);
    assert.equal(row(sqlite, "webhook_deliveries", "whd_1").status, "delivered");
    assert.equal(row(sqlite, "webhook_endpoints", "whk_1").last_outcome, "delivered");
  });
});

test("a failure is retried on the backoff, then abandoned; a 410 or fifteen in a row switch the endpoint off", async () => {
  await withKey(async () => {
    const { sqlite, db } = await database();
    await addEndpoint(sqlite);
    addDelivery(sqlite);
    const before = Date.now();
    assert.equal(await webhooks.attemptDelivery(db, "whd_1", "org_a", async () => ({ status: 500, excerpt: "boom" })), "failed");
    const failed = row(sqlite, "webhook_deliveries", "whd_1");
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 1);
    assert.ok(failed.next_attempt_at >= before + 60_000 && failed.next_attempt_at < before + 70_000, "first retry after a minute");
    assert.match(failed.error, /answered 500/);

    assert.equal(webhooks.retryDelay(1), 60_000);
    assert.equal(webhooks.retryDelay(2), 300_000);
    assert.equal(webhooks.retryDelay(7), 86_400_000);
    assert.equal(webhooks.retryDelay(8), null, "eight attempts, then abandoned");

    sqlite.prepare("UPDATE webhook_deliveries SET attempts = 7 WHERE id = 'whd_1'").run();
    assert.equal(await webhooks.attemptDelivery(db, "whd_1", "org_a", async () => ({ status: 503, excerpt: "" })), "abandoned");

    addDelivery(sqlite, { id: "whd_2" });
    assert.equal(await webhooks.attemptDelivery(db, "whd_2", "org_a", async () => ({ status: 410, excerpt: "" })), "abandoned");
    assert.equal(row(sqlite, "webhook_endpoints", "whk_1").state, "disabled");
    assert.match(row(sqlite, "webhook_endpoints", "whk_1").state_reason, /410 Gone/);

    await addEndpoint(sqlite, { id: "whk_2", failures: 14 });
    addDelivery(sqlite, { id: "whd_3", endpointId: "whk_2" });
    await webhooks.attemptDelivery(db, "whd_3", "org_a", async () => ({ error: "The receiver did not answer in time." }));
    assert.equal(row(sqlite, "webhook_endpoints", "whk_2").state, "disabled");
    assert.match(row(sqlite, "webhook_endpoints", "whk_2").state_reason, /15 failed deliveries in a row/);
  });
});

test("a redirect is a failure, never followed; a paused endpoint is not sent to; a claim is taken once", async () => {
  await withKey(async () => {
    const { sqlite, db } = await database();
    await addEndpoint(sqlite);
    addDelivery(sqlite);
    await webhooks.attemptDelivery(db, "whd_1", "org_a", async () => ({ status: 302, excerpt: "" }));
    assert.match(row(sqlite, "webhook_deliveries", "whd_1").error, /answered 302 \(a redirect\); redirects are not followed/);

    await addEndpoint(sqlite, { id: "whk_p", state: "paused" });
    addDelivery(sqlite, { id: "whd_p", endpointId: "whk_p" });
    let called = 0;
    assert.equal(await webhooks.attemptDelivery(db, "whd_p", "org_a", async () => (called++, { status: 200, excerpt: "" })), "skipped");
    assert.equal(called, 0);

    addDelivery(sqlite, { id: "whd_race" });
    let sends = 0;
    const slow = async () => {
      sends += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: 200, excerpt: "" };
    };
    const outcomes = await Promise.all([
      webhooks.attemptDelivery(db, "whd_race", "org_a", slow),
      webhooks.attemptDelivery(db, "whd_race", "org_a", slow),
    ]);
    assert.equal(sends, 1, "two runs racing for one delivery send it once");
    assert.deepEqual(outcomes.sort(), ["delivered", "skipped"]);
  });
});

test("without the key nothing can be opened, so nothing is sent, and the reason is recorded", async () => {
  const { sqlite, db } = await database();
  await withKey(() => addEndpoint(sqlite));
  addDelivery(sqlite);
  let called = 0;
  const outcome = await webhooks.attemptDelivery(db, "whd_1", "org_a", async () => (called++, { status: 200, excerpt: "" }));
  assert.equal(outcome, "failed");
  assert.equal(called, 0);
  assert.match(row(sqlite, "webhook_deliveries", "whd_1").error, /Credential storage is not configured/);
});

test("the retry run sends what is due, leaves what is not, and skips endpoints that are off", async () => {
  await withKey(async () => {
    const { sqlite, db } = await database();
    await addEndpoint(sqlite);
    await addEndpoint(sqlite, { id: "whk_off", state: "disabled" });
    addDelivery(sqlite, { id: "whd_due", status: "failed", attempts: 1, next: Date.now() - 1000 });
    addDelivery(sqlite, { id: "whd_later", status: "failed", attempts: 1, next: Date.now() + 3_600_000 });
    addDelivery(sqlite, { id: "whd_off", endpointId: "whk_off" });
    const seen = [];
    const summary = await webhooks.retryWebhookDeliveries(db, { transport: async (request) => (seen.push(request.headers["maintsupp-event-id"]), { status: 200, excerpt: "" }) });
    assert.deepEqual(seen, ["evt_whd_due"]);
    assert.equal(summary.delivered, 1);
    assert.equal(row(sqlite, "webhook_deliveries", "whd_later").status, "failed");
    assert.equal(row(sqlite, "webhook_deliveries", "whd_off").status, "pending");
  });
});

test("emitJobEvents queues and sends a job.created — and never an import, a subitem or another board's row", async () => {
  await withKey(async () => {
    const { sqlite, db } = await database();
    await addEndpoint(sqlite, { events: ["job.created"] });
    const job = sqlite.prepare("INSERT INTO maintenance_requests (id, organisation_id, reference, title, status, stage, priority, location, parent_id) VALUES (?,?,?,?,?,?,?,?,?)");
    job.run("j1", "org_a", "MS-1", "Door", "New", "Incoming", "Urgent", "Unit 4", null);
    job.run("j_sub", "org_a", "MS-2", "Subitem", "New", "Incoming", null, null, "j1");
    job.run("j_reg", "org_a", "MS-3", "Register row", "New", "Incoming", null, null, null);
    sqlite.prepare("INSERT INTO maintenance_group_items VALUES ('j_reg', 'org_a', 'store-documentation')").run();
    const sent = [];
    const transport = async (request) => (sent.push(JSON.parse(request.body)), { status: 200, excerpt: "" });
    const created = (id) => [{ requestId: id, field: "status", from: null, to: "New" }];

    await webhooks.emitJobEvents(db, { organisationId: "org_a", source: "created:portal", changes: created("j1") }, transport);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "job.created");
    assert.deepEqual(Object.keys(sent[0].data.job).sort(), ["category", "completedAt", "dueAt", "id", "location", "priority", "reference", "requestedAt", "siteId", "stage", "status", "title"]);
    assert.equal(sent[0].workspace.id, "org_a");

    await webhooks.emitJobEvents(db, { organisationId: "org_a", source: "import", changes: created("j1") }, transport);
    await webhooks.emitJobEvents(db, { organisationId: "org_a", source: "created:portal", changes: created("j_sub") }, transport);
    await webhooks.emitJobEvents(db, { organisationId: "org_a", source: "created:portal", changes: created("j_reg") }, transport);
    await webhooks.emitJobEvents(db, { organisationId: "org_b", source: "created:portal", changes: created("j1") }, transport);
    await webhooks.emitJobEvents(db, { organisationId: "org_a", source: "job.edit", changes: [{ requestId: "j1", field: "status", from: "New", to: "Done" }] }, transport);
    assert.equal(sent.length, 1, "import, subitem, register row, another workspace, an unsubscribed event: none sent");
  });
});

/* ================================================================== */
/* Routes and wiring                                                   */
/* ================================================================== */

test("the management routes need integrations.manage, the key, a real account and a whole-workspace view", async () => {
  const route = code(await read("app/api/integrations/webhooks/route.ts"));
  assert.equal((route.match(/scopedDbWithCapability\(request, "integrations\.manage"\)/g) ?? []).length, 4);
  assert.match(route, /if \(!storage\.configured\) \{\s*return Response\.json\(\s*\{ error: `Webhooks cannot be added on this deployment: \$\{storage\.reason\}`, notConfigured: true \},\s*\{ status: 409 \},/);
  assert.match(route, /if \(scope\.siteScope\) \{/, "a site-restricted admin cannot export the whole workspace's events");
  assert.match(route, /urlSealed: await sealSecret\(url, \{ purpose: "webhook\.url"/);
  assert.match(route, /detail: \{ kind, host: shown\.host, events: requested \}/, "the audit names the host, never the address");
  assert.match(route, /urlSealed: "", secretSealed: null/, "removing wipes the credential");
  const lib = code(await read("app/lib/integrations/webhooks.ts"));
  const columns = lib.slice(lib.indexOf("export const ENDPOINT_COLUMNS"), lib.indexOf("export async function listEndpoints"));
  assert.doesNotMatch(columns, /Sealed/, "a list never selects a sealed column");
  for (const file of ["app/api/integrations/webhooks/deliveries/route.ts", "app/api/integrations/webhooks/test/route.ts"]) {
    assert.match(code(await read(file)), /scopedDbWithCapability\(request, "integrations\.manage"\)/, file);
  }
});

test("retries ride the daily run; no cron is added", async () => {
  const daily = code(await read("app/api/cron/daily/route.ts"));
  assert.match(daily, /await retryWebhookDeliveries\(db, \{ limit: 200, budgetMs: 20_000 \}\)/);
  const build = await read("vercel/build-output.mjs");
  const crons = [...build.matchAll(/\{ path: "\/api\/cron\/[a-z-]+", schedule: "[^"]+" \}/g)];
  assert.equal(crons.length, 2, "the plan allows two declared crons, and there are still two");
});

test("the tables are additive, BIGINT where time is compared, and translate to Postgres intact", async () => {
  const init = await read("db/init.ts");
  assert.match(init, /await ensureWebhooks\(d1\);/);
  const ddl = init.match(/`(CREATE TABLE IF NOT EXISTS webhook_deliveries \([\s\S]*?\))`/)[1];
  assert.match(ddl, /next_attempt_at BIGINT NOT NULL DEFAULT 0/);
  assert.match(ddl, /claimed_until BIGINT NOT NULL DEFAULT 0/);
  assert.match(init, /CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_once_idx ON webhook_deliveries\(endpoint_id, event_id\)/);
  const translate = await import("../db/sqlite-to-postgres.ts");
  assert.match(translate.translateSql(ddl), /next_attempt_at BIGINT/i);
  for (const column of ["kind", "state", "status", "events", "payload", "url_sealed", "secret_sealed", "attempts", "consecutive_failures"]) {
    assert.equal(translate.BOOLEAN_COLUMN_NAMES.has(column), false, `${column} must not be converted as a boolean`);
  }
});

test("nothing secret reaches a log or the audit trail", async () => {
  for (const file of ["app/lib/integrations/webhooks.ts", "app/lib/integrations/outbound-http.ts", "app/api/integrations/webhooks/route.ts"]) {
    const source = code(await read(file));
    for (const call of source.matchAll(/console\.(error|log|warn)\(([^;]*)\);/g)) {
      assert.doesNotMatch(call[2], /url|secret|token|payload|credentials/i, `${file}: ${call[0]}`);
    }
  }
  const route = code(await read("app/api/integrations/webhooks/route.ts"));
  for (const audit of route.matchAll(/detail: \{([^}]*)\}/g)) {
    assert.doesNotMatch(audit[1], /url\b|secret|signingSecret/i, audit[0]);
  }
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

async function call(path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { accept: "application/json", "content-type": "application/json", ...(init.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

test("live: the screen says honestly whether webhooks can be stored, and refuses a private address", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((v) => v.split(";")[0]).join("; ");
  const as = { headers: { cookie } };
  const listed = await call("/api/integrations/webhooks", as);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(typeof listed.body.configured, "boolean");
  const add = (url) => call("/api/integrations/webhooks", { ...as, method: "POST", body: JSON.stringify({ kind: "webhook", name: "P35b-QA", url, events: ["job.created"] }) });
  if (!listed.body.configured) {
    const refused = await add("https://example.com/hook");
    assert.equal(refused.status, 409);
    assert.equal(refused.body.notConfigured, true);
    assert.match(refused.body.error, /MAINTSUPP_SECRETS_KEY/);
    return;
  }
  for (const url of ["http://example.com/hook", "https://127.0.0.1/hook", "https://localhost/hook", "https://metadata.google.internal/x"]) {
    assert.equal((await add(url)).status, 400, url);
  }
  const created = await add("https://example.com/maintsupp-qa-hook");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.endpoint.id;
  try {
    assert.match(created.body.signingSecret, /^whsec_/);
    const again = await call("/api/integrations/webhooks", as);
    const text = JSON.stringify(again.body);
    assert.ok(!text.includes(created.body.signingSecret) && !text.includes("maintsupp-qa-hook"), "neither the secret nor the path is shown again");
    const tested = await call("/api/integrations/webhooks/test", { ...as, method: "POST", body: JSON.stringify({ id }) });
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    assert.ok(["delivered", "failed"].includes(tested.body.outcome), JSON.stringify(tested.body));
    const log = await call(`/api/integrations/webhooks/deliveries?endpointId=${id}`, as);
    assert.equal(log.body.deliveries[0].eventType, "ping");
  } finally {
    await call(`/api/integrations/webhooks?id=${id}`, { ...as, method: "DELETE" });
  }
});

test("live: creating and moving a real job queues job.created and job.status_changed", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((v) => v.split(";")[0]).join("; ");
  const as = { headers: { cookie } };
  const listed = await call("/api/integrations/webhooks", as);
  if (!listed.body?.configured) return t.skip("this server holds no MAINTSUPP_SECRETS_KEY, so nothing can be subscribed");

  const endpoint = await call("/api/integrations/webhooks", {
    ...as,
    method: "POST",
    body: JSON.stringify({ kind: "webhook", name: "P35b-QA events", url: "https://example.com/maintsupp-qa-events", events: ["job.created", "job.status_changed"] }),
  });
  assert.equal(endpoint.status, 201, JSON.stringify(endpoint.body));
  const endpointId = endpoint.body.endpoint.id;
  let jobId = null;
  try {
    const created = await call("/api/board/items", { ...as, method: "POST", body: JSON.stringify({ board: "maintenance", title: `P35b-QA job ${Date.now()}` }) });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body).slice(0, 200));
    jobId = created.body.request?.id ?? created.body.item?.requestId ?? created.body.id;
    const moved = await call("/api/board/items", { ...as, method: "PATCH", body: JSON.stringify({ board: "maintenance", itemIds: [jobId], status: "P35b-QA status" }) });
    assert.equal(moved.status, 200, JSON.stringify(moved.body).slice(0, 200));
    const log = await call(`/api/integrations/webhooks/deliveries?endpointId=${endpointId}`, as);
    const types = log.body.deliveries.map((delivery) => delivery.eventType).sort();
    assert.deepEqual(types, ["job.created", "job.status_changed"], JSON.stringify(log.body.deliveries));
    for (const delivery of log.body.deliveries) {
      assert.ok(["delivered", "failed", "pending"].includes(delivery.status), JSON.stringify(delivery));
      assert.ok(delivery.attempts >= 1 || delivery.status === "pending");
    }
  } finally {
    await call(`/api/integrations/webhooks?id=${endpointId}`, { ...as, method: "DELETE" });
    if (jobId) await call(`/api/board/items?id=${encodeURIComponent(jobId)}`, { ...as, method: "DELETE" });
  }
});
