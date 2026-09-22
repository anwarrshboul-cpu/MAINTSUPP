/**
 * §34 — automations that post to Slack and send signed webhooks.
 *
 *   · The two actions are REAL only where they can be: the builder offers THIS
 *     workspace's own switched-on endpoints as the choices, greys the action out
 *     with the true reason when there are none (or when the deployment cannot
 *     store a credential at all — owner decision Q2), and `validateRule` refuses
 *     any endpoint that is not one of those choices.
 *   · Sending goes through the §35b pipeline: the endpoint is re-read at run
 *     time (right workspace, right kind, still on), a delivery row is written,
 *     one attempt is made straight away, and the retries and log apply.
 *
 * The send path runs against a real in-memory SQLite (node:sqlite + drizzle
 * sqlite-proxy) built from the migration DDL, with an injected transport.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import "./reports-ts-loader.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const catalogModule = await import("../app/lib/automations/catalog.ts");
const store = await import("../app/lib/automations/store.ts");
const webhooks = await import("../app/lib/integrations/webhooks.ts");
const slack = await import("../app/lib/integrations/slack.ts");
const box = await import("../app/lib/secret-box.ts");

const action = (catalog, type) => catalog.actions.find((entry) => entry.type === type);

/* ================================================================== */
/* The builder is honest                                               */
/* ================================================================== */

test("with no credential store, both actions are greyed and say why", () => {
  const catalog = catalogModule.buildCatalog({ emailConfigured: false });
  for (const type of ["slack_notify", "send_webhook"]) {
    assert.equal(action(catalog, type).available, false, type);
    assert.match(action(catalog, type).reason, /MAINTSUPP_SECRETS_KEY/, type);
  }
});

test("with the store but no endpoint, the reason says where to add one", () => {
  const catalog = catalogModule.buildCatalog({ emailConfigured: false, secretsConfigured: true, slackEndpoints: [], webhookEndpoints: [] });
  assert.match(action(catalog, "slack_notify").reason, /Add a Slack connection under Account → Developers/);
  assert.match(action(catalog, "send_webhook").reason, /Add a webhook under Account → Developers/);
});

test("the workspace's own endpoints are the choices, and nothing else validates", () => {
  const catalog = catalogModule.buildCatalog({
    emailConfigured: false,
    secretsConfigured: true,
    slackEndpoints: [{ value: "whk_slack", label: "Ops channel" }],
    webhookEndpoints: [{ value: "whk_zap", label: "Zapier" }],
  });
  const slackAction = action(catalog, "slack_notify");
  assert.equal(slackAction.available, true);
  assert.deepEqual(slackAction.fields[0], { key: "endpoint", label: "Slack connection", kind: "choice", options: [{ value: "whk_slack", label: "Ops channel" }] });
  assert.equal(action(catalog, "send_webhook").available, true);

  const rule = (actionType, endpoint) =>
    store.validateRule(catalog, [], [], {
      triggerType: "item_created",
      triggerConfig: {},
      actionType,
      actionConfig: { endpoint, message: "New job: {name}" },
    });
  assert.equal(rule("slack_notify", "whk_slack").ok, true);
  assert.equal(rule("slack_notify", "whk_zap").ok, false, "a webhook is not a Slack connection");
  assert.equal(rule("slack_notify", "whk_other_workspace").ok, false, "another workspace's endpoint is not a choice");
  assert.equal(rule("send_webhook", "whk_zap").ok, true);
});

test("the rule routes and the builder read the WORKSPACE's catalogue", async () => {
  const route = code(await read("app/api/automations/route.ts"));
  assert.equal((route.match(/validateRule\(await workspaceCatalog\(db, orgId\), columns, groups/g) ?? []).length, 2, "create and edit");
  assert.doesNotMatch(route, /currentCatalog\(\)/);
  const catalogRoute = code(await read("app/api/automations/catalog/route.ts"));
  assert.match(catalogRoute, /await workspaceCatalog\(guard\.scope\.db, guard\.scope\.orgId\)/);
  const storeSource = code(await read("app/lib/automations/store.ts"));
  assert.match(storeSource, /and\(eq\(webhookEndpoints\.organisationId, organisationId\), eq\(webhookEndpoints\.state, "on"\)\)/);
});

test("the action handler goes through sendAutomationEvent and tells the truth about the outcome", async () => {
  const actions = code(await read("app/lib/automations/actions.ts"));
  assert.match(actions, /if \(type === "slack_notify" \|\| type === "send_webhook"\) \{/);
  assert.match(actions, /await sendAutomationEvent\(ctx\.db, \{\s*organisationId: ctx\.orgId,/);
  assert.match(actions, /if \(sent\.outcome === "missing"\) return \{ summary: "", skipped:/, "a connection that has gone skips the rule, with the reason");
  assert.match(actions, /if \(sent\.outcome === "abandoned"\) throw new Error/, "a receiver that said gone fails it");
  assert.match(actions, /not delivered yet/, "a queued first failure is said, not dressed up as sent");
});

/* ================================================================== */
/* The send path — a real SQLite                                        */
/* ================================================================== */

const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE organisations (id TEXT PRIMARY KEY); INSERT INTO organisations VALUES ('org_a'), ('org_b');");
  const init = await read("db/init.ts");
  for (const table of ["webhook_endpoints", "webhook_deliveries"]) {
    sqlite.exec(init.match(new RegExp("`(CREATE TABLE IF NOT EXISTS " + table + " \\([\\s\\S]*?\\))`"))[1]);
  }
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

async function addEndpoint(sqlite, { id, kind, state = "on", org = "org_a" }) {
  const url = kind === "slack" ? "https://hooks.slack.com/services/T/B/X" : "https://hooks.example.com/zap";
  const sealedUrl = await box.sealSecret(url, { purpose: "webhook.url", organisationId: org, recordId: id });
  const sealedSecret =
    kind === "webhook" ? await box.sealSecret("whsec_zap", { purpose: "webhook.secret", organisationId: org, recordId: id }) : null;
  sqlite
    .prepare(`INSERT INTO webhook_endpoints (id, organisation_id, kind, name, url_host, url_hint, url_sealed, secret_sealed,
      events, state, consecutive_failures, created_by_user_id, created_by_email) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, org, kind, kind === "slack" ? "Ops channel" : "Zapier", "h", "h", sealedUrl, sealedSecret, "[]", state, 0, "u", "o@example.com");
  return url;
}

const job = { id: "j1", reference: "MS-9", title: "Leaking <tap>", status: "New", stage: "Incoming", priority: "Urgent", category: null, siteId: "s1", location: "Unit 4", requestedAt: null, dueAt: null, completedAt: null };

test("a Slack action posts the rule's words and the job, escaped, to the chosen connection", async () => {
  await withKey(async () => {
    const { sqlite, db } = await database();
    const url = await addEndpoint(sqlite, { id: "whk_slack", kind: "slack" });
    const sent = [];
    const result = await webhooks.sendAutomationEvent(
      db,
      { organisationId: "org_a", endpointId: "whk_slack", kind: "slack", rule: { id: "r1", name: "Urgent to ops" }, message: "Urgent job: Leaking <tap>", job },
      async (request) => (sent.push(request), { status: 200, excerpt: "ok" }),
    );
    assert.equal(result.outcome, "delivered");
    assert.equal(result.endpointName, "Ops channel");
    assert.equal(sent[0].url, url);
    assert.equal(JSON.parse(sent[0].body).text.split("\n")[0], "Urgent job: Leaking &lt;tap&gt; — MS-9: Leaking &lt;tap&gt;");
    const row = sqlite.prepare("SELECT event_type, status FROM webhook_deliveries").get();
    assert.deepEqual({ ...row }, { event_type: "automation.action", status: "delivered" }, "it is in the delivery log like any event");
  });
});

test("a webhook action sends a signed automation event with the rule and the job", async () => {
  await withKey(async () => {
    const { sqlite, db } = await database();
    await addEndpoint(sqlite, { id: "whk_zap", kind: "webhook" });
    const sent = [];
    await webhooks.sendAutomationEvent(
      db,
      { organisationId: "org_a", endpointId: "whk_zap", kind: "webhook", rule: { id: "r2", name: "To Zapier" }, message: null, job },
      async (request) => (sent.push(request), { status: 202, excerpt: "" }),
    );
    const body = JSON.parse(sent[0].body);
    assert.equal(body.type, "automation.action");
    assert.deepEqual(body.data.automation, { id: "r2", name: "To Zapier" });
    assert.equal(body.data.job.reference, "MS-9");
    const signing = await import("../app/lib/integrations/webhook-signature.ts");
    assert.equal(await signing.verifyWebhookSignature(sent[0].headers["maintsupp-signature"], sent[0].body, "whsec_zap"), true);
  });
});

test("a connection that is paused, of the wrong kind, gone, or another workspace's is not sent to", async () => {
  await withKey(async () => {
    const { sqlite, db } = await database();
    await addEndpoint(sqlite, { id: "whk_paused", kind: "slack", state: "paused" });
    await addEndpoint(sqlite, { id: "whk_zap", kind: "webhook" });
    await addEndpoint(sqlite, { id: "whk_b", kind: "slack", org: "org_b" });
    let calls = 0;
    const transport = async () => (calls++, { status: 200, excerpt: "" });
    const send = (endpointId, kind) =>
      webhooks.sendAutomationEvent(db, { organisationId: "org_a", endpointId, kind, rule: { id: "r", name: "r" }, message: "x", job: null }, transport);
    const paused = await send("whk_paused", "slack");
    assert.equal(paused.outcome, "missing");
    assert.match(paused.error, /is paused/);
    assert.equal((await send("whk_zap", "slack")).outcome, "missing", "a webhook is not a Slack connection");
    assert.equal((await send("whk_b", "slack")).outcome, "missing", "another workspace's connection");
    assert.equal((await send("whk_none", "slack")).outcome, "missing");
    assert.equal(calls, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").get().n, 0, "nothing is queued for them");
  });
});

test("a failed first attempt is queued for retry, not lost and not called sent", async () => {
  await withKey(async () => {
    const { sqlite, db } = await database();
    await addEndpoint(sqlite, { id: "whk_zap", kind: "webhook" });
    const result = await webhooks.sendAutomationEvent(
      db,
      { organisationId: "org_a", endpointId: "whk_zap", kind: "webhook", rule: { id: "r", name: "r" }, message: null, job: null },
      async () => ({ status: 500, excerpt: "" }),
    );
    assert.equal(result.outcome, "failed");
    assert.match(result.error, /answered 500/);
    const row = sqlite.prepare("SELECT status, attempts, next_attempt_at FROM webhook_deliveries").get();
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 1);
    assert.ok(row.next_attempt_at > Date.now(), "scheduled for a retry");
  });
});

test("Slack text for an automation with no job is just the rule's words", () => {
  assert.equal(slack.slackMessage({ type: "automation.action", data: { message: "Daily check done" } }, null).text, "Daily check done");
  assert.equal(slack.slackMessage({ type: "automation.action", data: {} }, null).text, "Automation");
});

test("the automation connections list reports Slack and webhooks from real endpoints", async () => {
  const route = code(await read("app/api/automations/connections/route.ts"));
  assert.match(route, /and\(eq\(webhookEndpoints\.organisationId, guard\.scope\.orgId\), eq\(webhookEndpoints\.state, "on"\)\)/);
  assert.match(route, /connected: slackOn > 0,/);
  assert.match(route, /connected: webhooksOn > 0,/);
  for (const fake of ["whatsapp", "teams", "gmail", "outlook"]) assert.doesNotMatch(route, new RegExp(`key: "${fake}"`));
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

test("live: a rule sends a real item's creation to the workspace's webhook, and the run says what happened", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((v) => v.split(";")[0]).join("; ");
  const as = { headers: { cookie } };

  const before = await call("/api/automations/catalog", as);
  const idle = before.body.actions.find((entry) => entry.type === "send_webhook");
  const webhooksState = await call("/api/integrations/webhooks", as);
  if (!webhooksState.body?.configured) {
    assert.equal(idle.available, false);
    assert.match(idle.reason, /MAINTSUPP_SECRETS_KEY/);
    return t.skip("no MAINTSUPP_SECRETS_KEY here: the greyed state was checked instead");
  }

  const endpoint = await call("/api/integrations/webhooks", {
    ...as,
    method: "POST",
    body: JSON.stringify({ kind: "webhook", name: "P34-QA hook", url: "https://example.com/maintsupp-qa-automation", events: ["job.status_changed"] }),
  });
  assert.equal(endpoint.status, 201, JSON.stringify(endpoint.body));
  const endpointId = endpoint.body.endpoint.id;
  let ruleId = null;
  let itemId = null;
  try {
    const catalog = await call("/api/automations/catalog", as);
    const send = catalog.body.actions.find((entry) => entry.type === "send_webhook");
    assert.equal(send.available, true);
    assert.ok(send.fields[0].options.some((option) => option.value === endpointId), "the new endpoint is a choice");

    const refused = await call("/api/automations", {
      ...as,
      method: "POST",
      body: JSON.stringify({ boardId: "maintenance", triggerType: "item_created", actionType: "send_webhook", actionConfig: { endpoint: "whk_not_ours" } }),
    });
    assert.equal(refused.status, 400, "an endpoint that is not one of this workspace's choices is refused");

    const rule = await call("/api/automations", {
      ...as,
      method: "POST",
      body: JSON.stringify({ boardId: "maintenance", triggerType: "item_created", actionType: "send_webhook", actionConfig: { endpoint: endpointId, message: "P34 {name}" } }),
    });
    assert.equal(rule.status, 201, JSON.stringify(rule.body));
    ruleId = rule.body.rule.id;

    const created = await call("/api/board/items", { ...as, method: "POST", body: JSON.stringify({ board: "maintenance", title: `P34-QA item ${Date.now()}` }) });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body).slice(0, 200));
    itemId = created.body.request?.id ?? created.body.item?.requestId ?? created.body.id;

    const runs = await call(`/api/automations/runs?boardId=maintenance&automationId=${encodeURIComponent(ruleId)}`, as);
    const run = runs.body.runs.find((entry) => entry.requestId === itemId);
    assert.ok(run, JSON.stringify(runs.body).slice(0, 300));
    assert.equal(run.status, "success", JSON.stringify(run));
    assert.match(run.action, /webhook "P34-QA hook"/, JSON.stringify(run));

    const log = await call(`/api/integrations/webhooks/deliveries?endpointId=${endpointId}`, as);
    assert.ok(log.body.deliveries.some((delivery) => delivery.eventType === "automation.action"), JSON.stringify(log.body));
  } finally {
    if (ruleId) await call(`/api/automations?id=${encodeURIComponent(ruleId)}`, { ...as, method: "DELETE" });
    await call(`/api/integrations/webhooks?id=${endpointId}`, { ...as, method: "DELETE" });
    if (itemId) await call(`/api/board/items?id=${encodeURIComponent(itemId)}`, { ...as, method: "DELETE" });
  }
});
