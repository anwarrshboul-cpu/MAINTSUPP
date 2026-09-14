/**
 * THE COMPLIANCE WARNING WINDOW — 90 days by default, an organisation's own when
 * it chooses one, counted on the Europe/London calendar day, on every surface.
 *
 * The approved Compliance specification: "Warning window is a config value in
 * Settings (default 90 days)", countdown bands 0–30 / 31–60 / 61–90, Europe/
 * London. The product had shipped a global constant of 60 and counted whole UTC
 * days. Four layers:
 *
 *   1. the classifier and the day (`expiry-status.ts`), called directly;
 *   2. the organisation's setting (`compliance-policy.ts`): parsing, bounds and
 *      refusal;
 *   3. the plumbing, by source — one register resolves the window and every
 *      surface prints the window it classified with; a settings save merges;
 *   4. against the running estate: choose 60, watch every surface move together
 *      and the other settings sections survive the save; restore the default.
 */

import "./reports-ts-loader.mjs";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const expiry = await import("../app/lib/expiry-status.ts");
const policy = await import("../app/lib/compliance-policy.ts");
const { mergeWorkspaceSettingsBlob } = await import("../app/lib/workspace-settings.ts");
const { countdownBands } = await import("../app/lib/compliance-dash.ts");

/* ── 1. The classifier and the day ────────────────────────────────────────── */

test("the default window is 90 days, and it bounds what an organisation may choose", () => {
  assert.equal(expiry.EXPIRY_DUE_SOON_DAYS, 90);
  assert.equal(expiry.normaliseWarningWindow(60), 60);
  assert.equal(expiry.normaliseWarningWindow("45"), 45);
  assert.equal(expiry.normaliseWarningWindow(7), 7);
  assert.equal(expiry.normaliseWarningWindow(365), 365);
  for (const bad of [6, 366, 0, -30, Number.NaN, Infinity, "", "ninety", null, undefined, {}, []]) {
    assert.equal(expiry.normaliseWarningWindow(bad), 90, `${String(bad)} degrades to the default`);
  }
  assert.deepEqual(countdownBands(90).map((band) => [band.fromDays, band.toDays]), [[0, 30], [31, 60], [61, 90]]);
});

test("expiryStatus takes the window it is given, and the default when it is not", () => {
  const today = new Date("2026-09-11T10:00:00Z");
  assert.equal(expiry.expiryStatus("2026-11-20", today).state, "due-soon", "70 days out: amber at 90");
  assert.equal(expiry.expiryStatus("2026-11-20", today, 60).state, "valid", "70 days out: green at 60");
  assert.equal(expiry.expiryStatus("2026-12-10", today).state, "due-soon", "day 90");
  assert.equal(expiry.expiryStatus("2026-12-11", today).state, "valid", "day 91");
  assert.equal(expiry.expiryStatus("2026-09-10", today, 365).state, "expired", "a window never un-expires anything");
});

test("the browser's window is inert on the server", () => {
  /* One server process answers many organisations; a module-level window there
     would let one tenant's setting classify another's register. */
  assert.equal(typeof window, "undefined");
  expiry.setBrowserWarningWindow(30);
  assert.equal(expiry.activeWarningWindow(), 90, "the setter does nothing without a browser");
  assert.equal(expiry.expiryStatus("2026-10-31", new Date("2026-09-11T10:00:00Z")).state, "due-soon");
});

test("today is the Europe/London calendar day — GMT, BST, near midnight UTC and both clock changes", () => {
  const day = (iso) => expiry.complianceDay(new Date(iso));
  assert.equal(day("2026-01-15T23:59:59Z"), "2026-01-15", "GMT: the UK day is the UTC day");
  assert.equal(day("2026-01-16T00:00:00Z"), "2026-01-16");
  assert.equal(day("2026-07-15T22:59:59Z"), "2026-07-15", "BST: 23:59:59 in London");
  assert.equal(day("2026-07-15T23:00:00Z"), "2026-07-16", "BST: midnight in London is 23:00 UTC");
  assert.equal(day("2026-07-15T23:30:00Z"), "2026-07-16", "near midnight UTC it is already tomorrow in London");
  assert.equal(day("2026-03-29T00:59:59Z"), "2026-03-29", "the spring change: still GMT");
  assert.equal(day("2026-03-29T23:00:00Z"), "2026-03-30", "and BST by the evening");
  assert.equal(day("2026-10-25T00:30:00Z"), "2026-10-25", "the autumn change: still BST at 01:30 local");
  assert.equal(day("2026-10-25T23:59:59Z"), "2026-10-25", "and GMT by the evening");
  assert.equal(day("not a date"), expiry.complianceDay(new Date()), "an invalid instant is now, never a throw");
});

test("a certificate due today is Expiring soon, and Expired one London day later — no data change", () => {
  const due = "2026-07-15";
  const at = (iso) => expiry.expiryStatus(due, new Date(iso));
  assert.deepEqual([at("2026-07-15T08:00:00Z").state, at("2026-07-15T08:00:00Z").daysRemaining], ["due-soon", 0]);
  assert.equal(at("2026-07-15T08:00:00Z").label, "Expires today");
  assert.equal(at("2026-07-15T22:59:59Z").state, "due-soon", "the last second of the UK day");
  assert.deepEqual([at("2026-07-15T23:00:00Z").state, at("2026-07-15T23:00:00Z").daysRemaining], ["expired", -1],
    "no off-by-one around BST: the UTC date is still the 15th");
  assert.equal(expiry.expiryStatus("2026-01-15", new Date("2026-01-15T23:59:59Z")).state, "due-soon", "GMT");
  assert.equal(expiry.expiryStatus("2026-01-15", new Date("2026-01-16T00:00:00Z")).state, "expired", "GMT");
});

/* ── 2. The organisation's setting ────────────────────────────────────────── */

test("a settings blob without a window is the default; one with a window is the organisation's", () => {
  assert.deepEqual(policy.compliancePolicyFromBlob(null), { warningWindowDays: 90, configured: false });
  assert.deepEqual(policy.compliancePolicyFromBlob("{}"), { warningWindowDays: 90, configured: false });
  assert.deepEqual(policy.compliancePolicyFromBlob("{not json"), { warningWindowDays: 90, configured: false },
    "a malformed row is the default, never an outage");
  assert.deepEqual(
    policy.compliancePolicyFromBlob(JSON.stringify({ alerts: {}, compliancePolicy: { warningWindowDays: 60 } })),
    { warningWindowDays: 60, configured: true },
  );
  assert.deepEqual(policy.compliancePolicyFromBlob({ compliancePolicy: { warningWindowDays: 999 } }),
    { warningWindowDays: 90, configured: true }, "out of bounds reads as the default, but was a choice");
});

test("a save may write a window in bounds or clear it — anything else is refused, never coerced", () => {
  assert.deepEqual(policy.compliancePolicyInput(undefined), { ok: true, section: null });
  assert.deepEqual(policy.compliancePolicyInput({ warningWindowDays: null }), { ok: true, section: null });
  assert.deepEqual(policy.compliancePolicyInput({ warningWindowDays: "" }), { ok: true, section: null });
  assert.deepEqual(policy.compliancePolicyInput({ warningWindowDays: 60 }), { ok: true, section: { warningWindowDays: 60 } });
  assert.deepEqual(policy.compliancePolicyInput({ warningWindowDays: " 45 " }), { ok: true, section: { warningWindowDays: 45 } });
  for (const bad of [6, 366, 45.5, "9O", "ninety", true]) {
    const result = policy.compliancePolicyInput({ warningWindowDays: bad });
    assert.equal(result.ok, false, `${String(bad)} is refused`);
  }
  assert.equal(policy.compliancePolicyInput(60).ok, false, "the section is an object");
});

/* ── 3. The plumbing ──────────────────────────────────────────────────────── */

test("one register resolves the window, and every surface prints the window it classified with", async () => {
  const register = codeOnly(await read("app/lib/compliance-register.ts"));
  assert.match(register, /readCompliancePolicy\(db, orgId\)\.then\(\(policy\) => policy\.warningWindowDays\)/,
    "resolved once, inside the register every surface reads");
  assert.match(register, /storeDocumentationRegister\(boardRows, \{ today, notRequired, windowDays \}\)/);
  assert.match(register, /return \{ entries, bySite, windowDays \};/);

  const metrics = codeOnly(await read("app/api/compliance/metrics/route.ts"));
  assert.match(metrics, /warningWindowDays: register\.windowDays,/, "the countdown splits the classified window");
  assert.doesNotMatch(metrics, /EXPIRY_DUE_SOON_DAYS/);
  const summary = codeOnly(await read("app/api/compliance/summary/route.ts"));
  assert.match(summary, /expiryWindowDays: register\.windowDays,/, "the register prints the classified window");
  assert.doesNotMatch(summary, /EXPIRY_DUE_SOON_DAYS/);

  const dash = codeOnly(await read("app/lib/compliance-dash.ts"));
  assert.match(dash, /today: complianceDay\(today\),/, "the payload's day is the London day");
  assert.doesNotMatch(dash, /toISOString\(\)\.slice\(0, 10\)/);

  const classifier = codeOnly(await read("app/lib/expiry-status.ts"));
  assert.match(classifier, /function todayDayIndex\(today: Date\): number \{\s*return utcDayIndex\(complianceDay\(today\)\);/);
  assert.match(classifier, /if \(daysRemaining <= window\) \{/);
  assert.deepEqual(
    classifier.match(/^import .*$/gm),
    ['import { formatLongDate, formatShortDate } from "./format-date";'],
    "the classifier still imports only ./format-date — fourteen suites transpile it and rewrite that one import",
  );
});

test("a settings save keeps every section it does not own — the template, the reminders, the window", () => {
  const stored = JSON.stringify({
    alerts: { urgent: true, compliance: true, daily: false },
    slas: { Urgent: "4 hours" },
    completionEvidenceCategories: ["Locks"],
    complianceTemplate: { kinds: [{ kind: "Fire Alarm", aliases: ["FA"], enabled: true }] },
    reminders: { quietHours: { start: "20:00", end: "07:00" } },
    compliancePolicy: { warningWindowDays: 45 },
  });
  /* What the Settings screen sends: its own three sections and nothing else. */
  const screen = { alerts: { urgent: false, compliance: true, daily: true }, slas: { Urgent: "2 hours" }, completionEvidenceCategories: [] };
  const merged = mergeWorkspaceSettingsBlob(stored, screen);
  assert.equal(merged.ok, true);
  const blob = JSON.parse(merged.settings);
  assert.deepEqual(blob.alerts, screen.alerts, "the sections the screen owns are replaced");
  assert.deepEqual(blob.slas, screen.slas);
  assert.deepEqual(blob.completionEvidenceCategories, []);
  assert.deepEqual(blob.complianceTemplate, JSON.parse(stored).complianceTemplate, "the compliance template survives");
  assert.deepEqual(blob.reminders, JSON.parse(stored).reminders, "the reminder settings survive");
  assert.deepEqual(blob.compliancePolicy, { warningWindowDays: 45 }, "an unsent window is left as chosen");

  const chosen = JSON.parse(mergeWorkspaceSettingsBlob(stored, { compliancePolicy: { warningWindowDays: 60 } }).settings);
  assert.deepEqual(chosen.compliancePolicy, { warningWindowDays: 60 });
  assert.deepEqual(chosen.alerts, JSON.parse(stored).alerts, "a sections-missing save changes nothing else");
  const cleared = JSON.parse(mergeWorkspaceSettingsBlob(stored, { compliancePolicy: { warningWindowDays: null } }).settings);
  assert.equal("compliancePolicy" in cleared, false, "clearing returns the organisation to the default");
  assert.equal(mergeWorkspaceSettingsBlob(stored, { compliancePolicy: { warningWindowDays: 3 } }).ok, false, "refused, not coerced");
  assert.deepEqual(JSON.parse(mergeWorkspaceSettingsBlob(null, screen).settings), screen, "no stored row yet");
  assert.deepEqual(JSON.parse(mergeWorkspaceSettingsBlob("{broken", screen).settings), screen, "a malformed row is replaced, not fatal");
  assert.equal("injected" in JSON.parse(mergeWorkspaceSettingsBlob(stored, { injected: 1 }).settings), false,
    "a key the screen does not own cannot be written through this route");
});

test("a settings save merges into the stored blob and validates the window", async () => {
  const route = codeOnly(await read("app/api/workspace/route.ts"));
  const merge = route.slice(route.indexOf("async function mergeWorkspaceSettings"));
  assert.match(merge.slice(0, 800), /return mergeWorkspaceSettingsBlob\(row\?\.settings \?\? null, data\);/, "starts from what is stored");
  assert.equal((route.match(/await mergeWorkspaceSettings\(db, orgId, data\)/g) ?? []).length, 2, "POST and PATCH");
  assert.doesNotMatch(route, /settings: JSON\.stringify\(settings\)/, "no save writes the request body wholesale any more");
  assert.match(route, /compliancePolicy: compliancePolicyFromBlob\(settingsRows\[0\]\?\.settings \?\? null\),/,
    "the GET hands the shell the effective window");
  const shell = await read("app/(app)/portal/portal-app.tsx");
  assert.match(shell, /setBrowserWarningWindow\(payload\.workspace\.settings\?\.compliancePolicy\?\.warningWindowDays\);\s*setWorkspace\(payload\.workspace\);/,
    "handed to the browser classifier before the snapshot renders");
});

/* ── 4. Against the running estate ────────────────────────────────────────── */

const BASE = "http://localhost:5173";

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/context`, { signal: AbortSignal.timeout(4000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

/* A settings save needs a signed-in account with `settings.edit`: the seeded
   development owner, exactly as tests/stage-twentythree-completion-evidence does. */
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

async function storedSettings(orgId) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
  let file;
  try {
    file = (await readdir(directory)).find((entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite");
  } catch {
    return null;
  }
  if (!file) return null;
  const db = new DatabaseSync(fileURLToPath(new URL(file, directory)), { readOnly: true });
  try {
    const row = db.prepare("SELECT settings FROM workspace_settings WHERE organisation_id = ?").get(orgId);
    return row ? JSON.parse(row.settings) : {};
  } finally {
    db.close();
  }
}

test("LIVE choosing 60 moves every surface together, keeps the other settings, and 90 comes back", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const cookie = await signIn();
  if (!cookie) {
    t.skip("the seeded owner could not sign in");
    return;
  }
  /*
   * DEMO CLIENT LTD, not the development organisation. This test changes an
   * organisation's window for a few seconds, and the suite's other live files
   * compare two compliance endpoints for the development organisation in
   * parallel — a window that moved between their two reads would fail them for
   * nothing. The organisation cookie selects the tenant for THIS session's
   * requests only.
   */
  const OTHER_ORG = "org_000000000000000000000002";
  const headers = { cookie: `${cookie}; maintsupp_demo_organisation=${OTHER_ORG}`, Accept: "application/json" };
  const context = await (await fetch(`${BASE}/api/context`, { headers })).json();
  const orgId = context?.context?.currentOrganisation?.id;
  if (orgId !== OTHER_ORG) {
    t.skip("the second tenant is not selectable here; not changing the development organisation's window");
    return;
  }
  const workspace = await (await fetch(`${BASE}/api/workspace`, { headers })).json();
  const settings = workspace.workspace?.settings;
  if (!settings || !orgId) {
    t.skip("the workspace snapshot did not load");
    return;
  }
  const saveSettings = (data) =>
    fetch(`${BASE}/api/workspace`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ entity: "settings", id: orgId, data }),
    });
  const before = await storedSettings(orgId);
  const keptKeys = before ? Object.keys(before).filter((key) => !["alerts", "slas", "completionEvidenceCategories", "compliancePolicy"].includes(key)) : [];

  const surfaces = async () => {
    const [metrics, summary, overview, sites] = await Promise.all(
      ["/api/compliance/metrics", "/api/compliance/summary", "/api/overview/metrics", "/api/sites"].map(async (url) =>
        (await fetch(`${BASE}${url}`, { headers })).json(),
      ),
    );
    return { metrics, summary, overview, sites };
  };

  try {
    /* The default, first. */
    const atDefault = await surfaces();
    assert.equal(atDefault.metrics.policy.warningWindowDays, 90);
    assert.deepEqual(atDefault.metrics.countdown.rings.filter((ring) => ring.key.startsWith("band")).map((ring) => ring.label),
      ["0–30 days", "31–60 days", "61–90 days"]);
    assert.equal(atDefault.summary.expiryWindowDays, 90);
    assert.equal(atDefault.metrics.today, new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date()),
      "the block's day is the London day");

    /* A malformed window is refused, and nothing is written. */
    const refused = await saveSettings({ ...settings, compliancePolicy: { warningWindowDays: 5 } });
    assert.equal(refused.status, 400);

    /* Choose 60. */
    const saved = await saveSettings({ ...settings, compliancePolicy: { warningWindowDays: 60 } });
    assert.equal(saved.status, 200, await saved.clone().text());
    const at60 = await surfaces();
    assert.equal(at60.metrics.policy.warningWindowDays, 60, "the block splits the organisation's window");
    assert.deepEqual(at60.metrics.countdown.rings.filter((ring) => ring.key.startsWith("band")).map((ring) => ring.label),
      ["0–20 days", "21–40 days", "41–60 days"]);
    assert.equal(at60.summary.expiryWindowDays, 60, "the register prints it");
    assert.deepEqual(at60.metrics.reconciliation, []);
    assert.equal(at60.metrics.score.percent, at60.overview.compliance.percent, "Overview = block, under the chosen window");
    assert.equal(at60.metrics.score.applicable, at60.overview.compliance.applicable);
    assert.equal(at60.sites.portfolioCompliance.percent, at60.metrics.score.percent, "Sites tile = block");
    assert.ok(at60.metrics.score.counts.expiring <= atDefault.metrics.score.counts.expiring,
      "a narrower window can only turn amber certificates green");
    const snapshot = await (await fetch(`${BASE}/api/workspace`, { headers })).json();
    assert.deepEqual(snapshot.workspace.settings.compliancePolicy, { warningWindowDays: 60, configured: true });

    /* The save kept every section it does not own. */
    const after = await storedSettings(orgId);
    if (after) {
      for (const key of keptKeys) assert.ok(key in after, `the settings save kept "${key}"`);
      assert.deepEqual(after.compliancePolicy, { warningWindowDays: 60 });
    }
  } finally {
    /* Back to the product default — the organisation never chose a window. */
    const restored = await saveSettings({ ...settings, compliancePolicy: { warningWindowDays: null } });
    assert.equal(restored.status, 200);
  }
  const back = await (await fetch(`${BASE}/api/compliance/metrics`, { headers })).json();
  assert.equal(back.policy.warningWindowDays, 90, "the default is back");
  const final = await storedSettings(orgId);
  if (final) assert.equal("compliancePolicy" in final, false, "clearing the window removes the key, leaving the default");
});
