/**
 * MONEY, ON THE WAY IN — a cost is stored as whole pence, by the one rule.
 *
 * `maintenance_requests.cost` is a REAL in pounds, and every figure built on it
 * — the Overview's spend, the Reports block, an invoice — is integer pence
 * through `poundsToPence` in `app/lib/reporting/money.ts`: half away from zero,
 * with the float representation fixed first, so 1.005 is 101p the way a
 * calculator says and not 100p the way `1.005 * 100` says.
 *
 * The write path did not apply that rule. A cost typed as 12.345 was stored as
 * 12.345, and from then on one reader counted 1235p while another printed
 * £12.34 — a penny that appears and disappears depending on who rounded. So
 * `normaliseCost` rounds to the penny ON THE WAY IN, through the very same
 * functions, and every door that writes a cost goes through it: a person's
 * PATCH, an automation rule's "set number", and the monday import.
 *
 * NOTHING EXISTING IS REWRITTEN. This is a write-path rule, not a migration:
 * the 776 costs already on the estate are left exactly as they are, and only a
 * new or edited one is normalised.
 *
 * Reads normalise CRLF — this is a Windows checkout.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const asModule = (js) => `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

/*
 * `request-fields.ts` is loaded by transpiling it to a data URL, which has no
 * base — so both of its relative imports are rewritten to data URLs of their
 * own. Exactly what `tests/audit-api-field-types.test.mjs` does, and for the
 * same reason; `money.ts` and `submission-title.ts` each import nothing but a
 * type, so neither needs rewriting itself.
 */
const money = await import(asModule(transpile(await read("app/lib/reporting/money.ts"))));
const fields = await (async () => {
  const submissionTitle = asModule(transpile(await read("app/lib/submission-title.ts")));
  const moneyUrl = asModule(transpile(await read("app/lib/reporting/money.ts")));
  const source = transpile(await read("app/lib/request-fields.ts"))
    .replace(/from ["']\.\/submission-title["']/g, `from "${submissionTitle}"`)
    .replace(/from ["']\.\/reporting\/money["']/g, `from "${moneyUrl}"`);
  return import(asModule(source));
})();

const { invalidRequestFields, normaliseCost, requestFieldValues } = fields;

/* ── 1. The rule itself ───────────────────────────────────────────────────── */

test("a cost is rounded to the penny, half away from zero, on the way in", () => {
  assert.equal(normaliseCost(12.345), 12.35);
  assert.equal(normaliseCost(1.005), 1.01, "the case a bare *100 gets wrong: 100.49999999999999");
  assert.equal(normaliseCost(0.125), 0.13);
  assert.equal(normaliseCost(0.124), 0.12);
  assert.equal(normaliseCost(12.34), 12.34, "an amount already in pence is unchanged");
  assert.equal(normaliseCost(0), 0, "zero recorded is a fact, not an absence");
  assert.equal(normaliseCost(1000), 1000);
});

test("negative clamps to zero, and nothing else changes about clearing", () => {
  assert.equal(normaliseCost(-5), 0, "as it always has — a job cannot cost less than nothing");
  assert.equal(normaliseCost(-0.004), 0);
  assert.equal(normaliseCost(null), null, "null clears the cost");
  assert.equal(normaliseCost(""), null, 'and so does "", which is what an emptied input sends');
});

test("anything the column cannot hold is unreadable — never a silent zero", () => {
  for (const bad of ["free", "12.50", undefined, Number.NaN, Infinity, -Infinity, {}, [], true]) {
    assert.equal(normaliseCost(bad), undefined, `${String(bad)} is not an amount`);
  }
  /* Past `MAX_SAFE_INTEGER` pence — about £90 trillion — the pounds stored and
     the pence every figure counts can no longer agree, so the amount is
     unreadable rather than quietly stored as something else. */
  assert.equal(normaliseCost(1e20), undefined);
  assert.equal(normaliseCost(1e15), undefined);
  assert.equal(typeof normaliseCost(1e12), "number", "and anything sane still lands");
});

test("it is the invoice arithmetic's own rule, not a second copy of it", async () => {
  for (const amount of [12.345, 1.005, 0.125, 99.999, 4210.5, 0.005, 7, 0]) {
    assert.equal(
      normaliseCost(amount),
      money.penceToPounds(money.poundsToPence(amount)),
      `${amount} must agree with poundsToPence/penceToPounds exactly`,
    );
  }
  const source = codeOnly(await read("app/lib/request-fields.ts"));
  assert.match(source, /import \{ penceToPounds, poundsToPence \} from "\.\/reporting\/money";/);
  assert.doesNotMatch(
    source.slice(source.indexOf("export function normaliseCost")),
    /Math\.round\(/,
    "no rounding of its own — that is what money.ts is for",
  );
});

/* ── 2. The write paths that use it ───────────────────────────────────────── */

test("the field normaliser stores the rounded amount, and the validator agrees with it", () => {
  assert.deepEqual(requestFieldValues({ cost: 12.345 }).cost, 12.35);
  assert.deepEqual(requestFieldValues({ cost: -5 }).cost, 0);
  assert.equal(requestFieldValues({ cost: null }).cost, null);
  assert.equal(requestFieldValues({ cost: "" }).cost, null);
  assert.equal("cost" in requestFieldValues({ cost: "free" }), false, "malformed is dropped, as the engine needs");
  assert.equal("cost" in requestFieldValues({ priority: "Low" }), false, "an absent key writes nothing");

  /* The two must not drift: what the validator accepts must survive coercion,
     or a person's PATCH is answered 200 for an edit that did not happen. */
  for (const good of [{ cost: 12.345 }, { cost: 0 }, { cost: null }, { cost: "" }, { cost: 40 }]) {
    assert.deepEqual(invalidRequestFields(good), [], `${JSON.stringify(good)} is accepted`);
    if (good.cost !== null && good.cost !== "") {
      assert.equal("cost" in requestFieldValues(good), true, "and is written");
    }
  }
  for (const bad of [{ cost: "free" }, { cost: Number.NaN }, { cost: 1e20 }, { cost: true }]) {
    const problems = invalidRequestFields(bad);
    assert.equal(problems.length, 1, `${JSON.stringify(bad)} is refused`);
    assert.match(problems[0], /^cost must be/);
  }
});

test("every door that writes a cost goes through the one normaliser", async () => {
  const fieldsSource = codeOnly(await read("app/lib/request-fields.ts"));
  assert.match(fieldsSource, /const cost = normaliseCost\(fields\.cost\);/);
  assert.match(fieldsSource, /has\("cost"\) && normaliseCost\(fields\.cost\) === undefined/);
  assert.doesNotMatch(
    fieldsSource,
    /values\.cost = Math\.max\(0, fields\.cost\)/,
    "the old un-rounded write is gone, not merely wrapped",
  );

  /* The board's cost cell, the drawer, the calendar and the Fix Tracker all
     PATCH /api/maintenance, which applies `requestFieldValues`; the automation
     engine's "set number" calls the same function. The importer is the one
     other writer, and it converts its own text. */
  const engine = codeOnly(await read("app/lib/automations/actions.ts"));
  assert.match(engine, /requestFieldValues\(\{ \[entry\.field\]: raw \}\)/);

  const importer = codeOnly(await read("app/api/import/route.ts"));
  assert.match(
    importer,
    /cost: item\.values\.cost \? normaliseCost\(Number\(item\.values\.cost\)\) \?\? null : null,/,
    "an imported cost is rounded the same way, and unreadable text is no cost rather than NaN",
  );

  /* And nothing existing is rewritten: no migration, no backfill. */
  const init = codeOnly(await read("db/init.ts"));
  assert.doesNotMatch(init, /UPDATE maintenance_requests[\s\S]{0,200}SET cost/i, "existing rows are left alone");
});

/* ── 3. Against the running estate ────────────────────────────────────────── */

const BASE = "http://localhost:5173";
const MARKER = "MWQA-";

async function serverIsUp() {
  try {
    /* 8s, not the 4s most live files use: measured on this estate the dev
       server answers `/api/context` in 2–6 seconds while the suite is running
       beside it, and a health check that times out first turns a slow server
       into a silently skipped test. */
    const response = await fetch(`${BASE}/api/context`, { signal: AbortSignal.timeout(8000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function signIn() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
      password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
    }),
  });
  if (!login.ok) return null;
  return (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
}

test("LIVE a cost typed with three decimals is stored as pence, and clearing still clears", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const cookie = await signIn();
  if (!cookie) {
    t.skip("the seeded owner could not sign in");
    return;
  }
  const headers = { cookie, accept: "application/json" };
  const json = { ...headers, "content-type": "application/json" };
  const run = `${MARKER}${Date.now().toString(36)}`;

  const sites = await (await fetch(`${BASE}/api/sites?limit=5`, { headers })).json();
  const siteName = (sites.sites ?? []).map((site) => site.name).find(Boolean);
  if (!siteName) {
    t.skip("no site to raise a fixture job against");
    return;
  }

  const created = await fetch(`${BASE}/api/maintenance`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      location: siteName,
      requester: `${run} tester`,
      contact: "07000 000000",
      description: `${run} money write fixture — swept by the test that made it.`,
      category: "Other",
      priority: "Low",
      engineer: "Handyman",
    }),
  });
  const body = await created.json();
  assert.equal(created.status, 201, JSON.stringify(body));
  const id = body.request.id;

  const patch = async (cost) => {
    const response = await fetch(`${BASE}/api/maintenance`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ id, fields: { cost } }),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    const rounded = await patch(12.345);
    assert.equal(rounded.status, 200, JSON.stringify(rounded.body));
    assert.equal(rounded.body.request.cost, 12.35, "stored as pence, not as typed");

    const halfPenny = await patch(1.005);
    assert.equal(halfPenny.body.request.cost, 1.01);

    const negative = await patch(-5);
    assert.equal(negative.body.request.cost, 0, "a negative cost clamps, as it always has");

    const refused = await patch("free");
    assert.equal(refused.status, 400, "a typo is refused rather than deleting the recorded cost");
    const unchanged = await (await fetch(`${BASE}/api/maintenance?id=${id}`, { headers })).json();
    assert.equal(unchanged.request.cost, 0, "and nothing was written");

    const cleared = await patch(null);
    assert.equal(cleared.body.request.cost ?? null, null, "null still clears it");
  } finally {
    const feed = await (await fetch(`${BASE}/api/maintenance?limit=1000`, { headers })).json();
    const mine = (feed.requests ?? []).filter(
      (row) => `${row.title ?? ""} ${row.description ?? ""}`.includes(MARKER),
    );
    if (mine.length) {
      await fetch(`${BASE}/api/board?board=maintenance`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ action: "delete_items", requestIds: mine.map((row) => row.id) }),
      });
      const trash = await (await fetch(`${BASE}/api/trash?limit=500`, { headers })).json();
      for (const entry of trash.bin?.entries ?? []) {
        if (!mine.some((row) => row.id === entry.entityId)) continue;
        await fetch(`${BASE}/api/trash?id=${encodeURIComponent(entry.id)}`, { method: "DELETE", headers });
      }
    }
  }
});
