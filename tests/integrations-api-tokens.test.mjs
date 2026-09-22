/**
 * §35a — integrations: the secret box, scoped API tokens, the read-only
 * `/api/v1`, and an Integrations screen that describes the deployment that is
 * actually running.
 *
 * Owner decisions this holds the code to:
 *   Q2  build the encryption architecture, add NO key: without
 *       `MAINTSUPP_SECRETS_KEY` the box says "not configured" and seals nothing.
 *   Q3  scoped REST API tokens; Microsoft 365 and HubSpot shown as
 *       "Not connected — requires setup" with no Connect button.
 *
 * The pure modules are CALLED (secret box, token rules, posture); the routes'
 * guarantees are pinned in their source; the live half drives the whole token
 * lifecycle against the dev server's D1 and skips when none answers.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import "./reports-ts-loader.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const box = await import("../app/lib/secret-box.ts");
const tokens = await import("../app/lib/integrations/api-tokens.ts");
const posture = await import("../app/lib/integrations/posture.ts");

const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const OTHER = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const where = { purpose: "webhook.secret", organisationId: "org_a", recordId: "whk_1" };

/* ================================================================== */
/* The secret box                                                      */
/* ================================================================== */

test("without MAINTSUPP_SECRETS_KEY the box says not configured and refuses to seal", async () => {
  const status = await box.secretBoxStatus({});
  assert.equal(status.configured, false);
  assert.match(status.reason, /MAINTSUPP_SECRETS_KEY is not set/);
  assert.equal(box.secretBoxConfigured({}), false);
  await assert.rejects(box.sealSecret("whsec_x", where, {}), (error) => error instanceof box.SecretBoxUnavailableError);
});

test("a key that is not 32 bytes is reported as misconfigured, never used", async () => {
  const short = Buffer.from("too short").toString("base64");
  const status = await box.secretBoxStatus({ MAINTSUPP_SECRETS_KEY: short });
  assert.equal(status.configured, false);
  assert.match(status.reason, /does not decode to 32 bytes/);
  await assert.rejects(box.sealSecret("x", where, { MAINTSUPP_SECRETS_KEY: short }), box.SecretBoxUnavailableError);
});

test("seal and open round-trip; the envelope names its key and hides the value", async () => {
  const env = { MAINTSUPP_SECRETS_KEY: KEY };
  const secret = "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX";
  const sealed = await box.sealSecret(secret, where, env);
  assert.match(sealed, /^msb1\.[0-9a-f]{8}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(!sealed.includes("hooks.slack.com") && !sealed.includes("XXXX"), "no plaintext in the envelope");
  assert.equal(await box.openSecret(sealed, where, env), secret);
  const again = await box.sealSecret(secret, where, env);
  assert.notEqual(again, sealed, "a fresh IV every time");
  const status = await box.secretBoxStatus(env);
  assert.equal(status.configured, true);
  assert.equal(status.keyId, sealed.split(".")[1], "the status names the key the envelope carries");
});

test("a sealed value moved to another record, workspace or purpose does not open", async () => {
  const env = { MAINTSUPP_SECRETS_KEY: KEY };
  const sealed = await box.sealSecret("whsec_abc", where, env);
  for (const moved of [
    { ...where, recordId: "whk_2" },
    { ...where, organisationId: "org_b" },
    { ...where, purpose: "slack.url" },
  ]) {
    await assert.rejects(box.openSecret(sealed, moved, env), /could not be opened/);
  }
});

test("a tampered envelope fails; the previous key still opens; a foreign key does not", async () => {
  const sealed = await box.sealSecret("whsec_abc", where, { MAINTSUPP_SECRETS_KEY: KEY });
  const parts = sealed.split(".");
  const flipped = parts[3].startsWith("A") ? `B${parts[3].slice(1)}` : `A${parts[3].slice(1)}`;
  await assert.rejects(box.openSecret([...parts.slice(0, 3), flipped].join("."), where, { MAINTSUPP_SECRETS_KEY: KEY }));
  const rotated = { MAINTSUPP_SECRETS_KEY: OTHER, MAINTSUPP_SECRETS_KEY_PREVIOUS: KEY };
  assert.equal(await box.openSecret(sealed, where, rotated), "whsec_abc", "a rotation keeps what was sealed readable");
  await assert.rejects(box.openSecret(sealed, where, { MAINTSUPP_SECRETS_KEY: OTHER }), /no longer configured/);
  await assert.rejects(box.openSecret("plain-text-secret", where, { MAINTSUPP_SECRETS_KEY: KEY }), /not in a format/);
});

test("a screen sees at most the last four characters", () => {
  assert.equal(box.secretHint("whsec_0123456789abcdef"), "…cdef");
  assert.equal(box.secretHint("short"), "…");
});

/* ================================================================== */
/* Token rules                                                         */
/* ================================================================== */

const admin = { role: "admin", capabilities: {} };
const manager = { role: "manager", capabilities: {} };

test("a token is mst_<12 hex>_<64 hex>, and only a well-formed bearer header is read", () => {
  const { token, prefix } = tokens.mintToken();
  assert.match(token, /^mst_[0-9a-f]{12}_[0-9a-f]{64}$/);
  assert.equal(tokens.parseToken(token)?.prefix, prefix);
  assert.equal(tokens.parseToken("mst_short_abc"), null);
  assert.equal(tokens.bearerToken(`Bearer ${token}`), token);
  assert.equal(tokens.bearerToken(`bearer   ${token}  `), token);
  assert.equal(tokens.bearerToken(`Basic ${token}`), null);
  assert.equal(tokens.bearerToken(null), null);
  assert.notEqual(tokens.mintToken().token, token);
});

test("a token never reads more than its creator can now", () => {
  assert.deepEqual(tokens.effectiveTokenScopes(["jobs:read", "sites:read"], admin), ["jobs:read", "sites:read"]);
  assert.deepEqual(tokens.effectiveTokenScopes(["jobs:read"], manager), [], "a Manager cannot hold integrations.manage");
  assert.deepEqual(
    tokens.effectiveTokenScopes(["jobs:read"], { role: "admin", capabilities: { "integrations.manage": false } }),
    [],
    "losing integrations.manage kills every token the person issued",
  );
  assert.deepEqual(
    tokens.effectiveTokenScopes(["jobs:read"], { role: "admin", capabilities: { "board.view": false } }),
    [],
    "losing board.view kills jobs:read",
  );
  assert.deepEqual(tokens.readScopes('["jobs:read","delete:everything","jobs:read"]'), ["jobs:read"], "unknown words are dropped");
  assert.deepEqual(tokens.readScopes("not json"), []);
});

test("issuing is refused in words, and cannot widen the creator's access", () => {
  assert.equal(tokens.validateTokenRequest({ name: "Finance", scopes: ["jobs:read"] }, admin).ok, true);
  assert.equal(tokens.validateTokenRequest({ name: "Finance", scopes: ["jobs:read"] }, admin).days, 90);
  assert.match(tokens.validateTokenRequest({ name: "x", scopes: ["jobs:read"] }, admin).error, /name/);
  assert.match(tokens.validateTokenRequest({ name: "Finance", scopes: [] }, admin).error, /at least one/);
  assert.match(tokens.validateTokenRequest({ name: "Finance", scopes: ["jobs:write"] }, admin).error, /not one a token can have/);
  assert.match(tokens.validateTokenRequest({ name: "Finance", scopes: ["jobs:read"], days: 7 }, admin).error, /30, 90, 365/);
  const blind = { role: "admin", capabilities: { "board.view": false } };
  assert.match(tokens.validateTokenRequest({ name: "Finance", scopes: ["jobs:read"] }, blind).error, /cannot issue a token that reads what you cannot/);
});

/* ================================================================== */
/* The Integrations screen describes what is running                   */
/* ================================================================== */

test("storage and database are reported from the runtime and the variables it acts on", () => {
  const all = { S3_ENDPOINT: "https://x", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" };
  assert.match(posture.storagePosture(all, "node", 12, false).name, /Supabase Storage/);
  assert.equal(posture.storagePosture(all, "node", 12, false).configured, true);
  const half = posture.storagePosture({ S3_ENDPOINT: "https://x" }, "node", 0, false);
  assert.equal(half.configured, false);
  assert.match(half.detail, /S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY missing/);
  assert.match(posture.storagePosture({}, "node", 0, false).detail, /serverless host does not keep/);
  assert.match(posture.storagePosture({}, "workers", 3, true).name, /R2 \(local development\)/);
  assert.match(posture.databasePosture({ PG_D1: "1" }, "node").name, /Supabase Postgres/);
  assert.match(posture.databasePosture({}, "node").name, /SQLite file/);
  assert.match(posture.databasePosture({}, "workers").name, /D1 \(local development\)/);
});

test("the platform route no longer describes a Worker, and promises no connection that does not exist", async () => {
  const route = code(await read("app/api/account/platform/route.ts"));
  assert.doesNotMatch(route, /Cloudflare R2 file storage|Bound as DB|key: "r2"|key: "d1"/);
  assert.match(route, /storagePosture\(processEnv, runtime, fileRows\[0\]\?\.value \?\? 0, bucketBound\)/);
  assert.match(route, /databasePosture\(processEnv, runtime\)/);
  for (const key of ["microsoft365", "hubspot"]) {
    const block = route.slice(route.indexOf(`key: "${key}"`), route.indexOf(`key: "${key}"`) + 400);
    assert.match(block, /configured: false/);
    assert.match(block, /Not connected — requires setup/);
    assert.doesNotMatch(block.slice(0, block.indexOf("},")), /action:/, `${key} has no Connect button`);
  }
  assert.match(route, /configured: secrets\.configured/);
  assert.match(route, /key: "api_tokens",\s*name: "Workspace API tokens",\s*available: true/);
  assert.doesNotMatch(route, /personal_api_keys/);
  assert.doesNotMatch(route, /error instanceof Error\s*\?\s*error\.message/, "a database message is not an answer");
  /* The withholding the security batch put in place is untouched. */
  assert.match(route, /can\(subject, "settings\.edit"\)/);
  assert.match(route, /developers: \{ \.\.\.platform\.developers, publicEndpoints: \[\] \}/);
});

/* ================================================================== */
/* The routes' guarantees, in their source                              */
/* ================================================================== */

test("integrations.manage is Owner/Admin by default and above a Manager's ceiling", async () => {
  const permissions = await import("../app/lib/permissions.ts");
  assert.ok(permissions.CAPABILITIES.includes("integrations.manage"));
  assert.equal(permissions.can({ role: "owner", capabilities: {} }, "integrations.manage"), true);
  assert.equal(permissions.can({ role: "admin", capabilities: {} }, "integrations.manage"), true);
  assert.equal(permissions.can({ role: "super_admin", capabilities: {} }, "integrations.manage"), true);
  assert.equal(permissions.can({ role: "manager", capabilities: { "integrations.manage": true } }, "integrations.manage"), false, "a row cannot lift the ceiling");
  assert.equal(permissions.can({ role: "client", capabilities: {} }, "integrations.manage"), false);
});

test("a token is stored only as its hash, shown once, and managed only with integrations.manage", async () => {
  const route = code(await read("app/api/integrations/tokens/route.ts"));
  assert.equal((route.match(/scopedDbWithCapability\(request, "integrations\.manage"\)/g) ?? []).length, 3, "GET, POST and DELETE");
  assert.match(route, /tokenHash: await hashToken\(token\),/);
  assert.match(route, /if \(!scope\.authenticated \|\| !scope\.session\) \{/, "a demo identity cannot hold a credential");
  const expose = route.slice(route.indexOf("function expose("), route.indexOf("export async function GET"));
  assert.doesNotMatch(expose, /tokenHash|token:/, "the list never carries the hash or the token");
  assert.match(route, /and\(eq\(apiTokens\.id, id\), eq\(apiTokens\.organisationId, scope\.orgId\)\)/, "revoke is scoped to the workspace");
  assert.match(route, /detail: \{ prefix, scopes: checked\.scopes, expiresAt \}/, "the audit carries the prefix, never the token");
  assert.match(route, /MAX_LIVE_TOKENS/);
});

test("a bearer request reads only the header and re-resolves the creator's access", async () => {
  const auth = code(await read("app/lib/integrations/api-auth.ts"));
  assert.doesNotMatch(auth, /cookie|resolveTenantAccess|scopedDb\(|getSession|IDENTITY_HEADER/i, "no session path, no demo identity");
  assert.match(auth, /bearerToken\(request\.headers\.get\("authorization"\)\)/);
  assert.match(auth, /and\(eq\(apiTokens\.tokenHash, await hashToken\(presented\)\), isNull\(apiTokens\.revokedAt\)\)/);
  assert.match(auth, /if \(!\(Date\.parse\(row\.expiresAt\) > Date\.now\(\)\)\) return refuse/);
  assert.match(auth, /await creatorAccess\(db, row\.createdByEmail, row\.organisationId\)/);
  assert.match(auth, /effectiveTokenScopes\(readScopes\(row\.scopes\), subject\)/);
  assert.match(auth, /if \(company && internalCompanies\.has\(company\)\) return null;/, "never an internal company's workspace");
  assert.match(auth, /publicRetryAfter\(d1, API_AUTH_FAILURES, address\)/);
  assert.match(auth, /publicRetryAfter\(d1, API_TOKEN_RATE, row\.id\)/);
});

test("/api/v1 is read-only, on the Jobs board's own rows, and never wider than the creator", async () => {
  const jobs = code(await read("app/api/v1/jobs/route.ts"));
  assert.match(jobs, /scopedDbWithApiToken\(request, "jobs:read"\)/);
  assert.match(jobs, /liveWorkOrderCondition\(orgId\)/);
  assert.match(jobs, /if \(siteScope\) conditions\.push\(inArray\(maintenanceRequests\.siteId, siteScope\)\)/);
  assert.match(jobs, /\.map\(exposeRequest\)/);
  const sites = code(await read("app/api/v1/sites/route.ts"));
  assert.match(sites, /scopedDbWithApiToken\(request, "sites:read"\)/);
  assert.match(sites, /withinMemberScope\(allowed, row\.id\)/);
  const payloads = code(await read("app/lib/integrations/api-payloads.ts"));
  assert.doesNotMatch(payloads, /manager|access|landlord|billing|organisationId/i, "an allowlist: no contacts, access or billing");
  for (const file of ["app/api/v1/jobs/route.ts", "app/api/v1/sites/route.ts"]) {
    const source = code(await read(file));
    assert.doesNotMatch(source, /export async function (POST|PUT|PATCH|DELETE)/, `${file} is read-only`);
  }
});

test("the table is additive and the key is documented, not set", async () => {
  const init = await read("db/init.ts");
  assert.match(init, /CREATE TABLE IF NOT EXISTS api_tokens \([\s\S]*?token_hash TEXT NOT NULL,[\s\S]*?scopes TEXT NOT NULL DEFAULT '\[\]'/);
  assert.match(init, /CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_hash_idx ON api_tokens\(token_hash\)/);
  assert.match(init, /await ensureApiTokens\(d1\);/);
  const doc = await read("docs/DEPLOYMENT-PORTAL.md");
  assert.match(doc, /`MAINTSUPP_SECRETS_KEY` \| server \| optional — \*\*deliberately NOT set\*\*/);
  const vercel = await read("vercel/build-output.mjs");
  assert.doesNotMatch(vercel, /MAINTSUPP_SECRETS_KEY/, "no key is written into a deployment");
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

test("live: a token is issued once, reads /api/v1, and is dead the moment it is revoked", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((v) => v.split(";")[0]).join("; ");
  const as = { headers: { cookie } };

  const listed = await call("/api/integrations/tokens", as);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal((await call("/api/integrations/tokens", { ...as, method: "POST", body: JSON.stringify({ name: "x", scopes: ["jobs:read"] }) })).status, 400);

  const issued = await call("/api/integrations/tokens", {
    ...as,
    method: "POST",
    body: JSON.stringify({ name: `P35-QA ${Date.now()}`, scopes: ["jobs:read"], days: 30 }),
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const token = issued.body.token;
  const id = issued.body.record.id;
  assert.match(token, /^mst_[0-9a-f]{12}_[0-9a-f]{64}$/);
  try {
    const again = await call("/api/integrations/tokens", as);
    const text = JSON.stringify(again.body);
    assert.ok(!text.includes(token) && !text.includes(token.split("_")[2]), "the list never shows the token again");

    const bearer = { headers: { authorization: `Bearer ${token}` } };
    const jobs = await call("/api/v1/jobs?limit=5", bearer);
    assert.equal(jobs.status, 200, JSON.stringify(jobs.body));
    assert.ok(Array.isArray(jobs.body.jobs) && jobs.body.jobs.length <= 5);
    for (const job of jobs.body.jobs) {
      assert.equal("publicUploadTokenHash" in job, false);
      assert.equal("organisationId" in job, false);
    }
    const sites = await call("/api/v1/sites", bearer);
    assert.equal(sites.status, 403, "issued for jobs only, so sites are refused");
    assert.equal(sites.body.scope, "sites:read");

    assert.equal((await call("/api/v1/jobs", as)).status, 401, "a browser session is not an API token");
    assert.equal((await call("/api/v1/jobs", { headers: { authorization: "Bearer mst_000000000000_" + "0".repeat(64) } })).status, 401);
    assert.equal((await call("/api/v1/jobs?limit=900", bearer)).status, 400);
  } finally {
    const revoked = await call(`/api/integrations/tokens?id=${encodeURIComponent(id)}`, { ...as, method: "DELETE" });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.token.state, "revoked");
  }
  assert.equal((await call("/api/v1/jobs", { headers: { authorization: `Bearer ${token}` } })).status, 401, "revoked means dead, at once");
});

test("live: a Client cannot manage tokens; a demo identity cannot issue one", { skip: !serverUp }, async () => {
  /* The seeded per-workspace identity: a client membership in the primary
     workspace. (No Manager is seeded there — an unknown identity falls through
     to the default actor — so the Manager's ceiling is proven by the unit test
     above, where `can()` refuses it whatever a row says.) */
  for (const email of ["client@sunnamusk-uk.test.maintsupp.com"]) {
    const refused = await call("/api/integrations/tokens", { headers: { "x-maintsupp-identity": email } });
    assert.equal(refused.status, 403, `${email}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.capability, "integrations.manage");
  }
  const demoAdmin = await call("/api/integrations/tokens", {
    method: "POST",
    headers: { "x-maintsupp-identity": "admin@sunnamusk-uk.test.maintsupp.com" },
    body: JSON.stringify({ name: "Demo token", scopes: ["jobs:read"] }),
  });
  assert.equal(demoAdmin.status, 401, "only a signed-in account is responsible for a credential");
});
