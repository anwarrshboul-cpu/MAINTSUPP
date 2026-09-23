/**
 * The Overview's SLA compliance targets — dashboard §4.4 and §9 item 25.
 *
 * §9 item 25: "Changing an SLA target in Settings changes the chart with no
 * deploy and does not rewrite historical records." The owner's decision of
 * 2026-09-23 is WHICH target: the percentage the live Priority & SLA gauge and
 * the "SLA Compliance by Priority Tier" bars are held to — until now a
 * constant, 95%. Which jobs count as within SLA is unchanged.
 *
 * ── HOW THIS IS PROVED ─────────────────────────────────────────────────────
 *
 * EXECUTED against real SQLite: a fresh file migrated by the real
 * `ensureDatabase()`, through the transactional D1 stub, exactly as
 * `contractor-alias-transaction.test.mjs` does. The editor's writes, the
 * versioning, the workspace scoping, the one-current-row index and the live
 * card's server path (`loadOverviewMetrics` → `intel`) all run for real. The
 * browser half — that the page draws what the payload says — is held by source
 * pins at the end, and was checked in a browser on the Preview.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function installHooks(sqlitePath) {
  process.env["D1_SQLITE_PATH"] = sqlitePath;
  const stub = pathToFileURL(path.join(root, "tests/fixtures/cloudflare-workers-stub.mjs")).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "cloudflare:workers") return { url: stub, shortCircuit: true };
      if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts")) {
        const base = new URL(specifier, context.parentURL);
        for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) {
          if (fs.existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true };
        }
      }
      return next(specifier, context);
    },
  });
}

let dir = null;
let d1 = null;
let db = null;
let lib = null;
let ORG = null;
const OTHER_ORG = "org_zz_sla_other_workspace";

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maintsupp-sla-targets-"));
  installHooks(path.join(dir, "sla.sqlite"));
  const { ensureDatabase } = await import("../db/init.ts");
  const { getD1, getDb } = await import("../db/index.ts");
  lib = await import("../app/lib/sla-compliance-targets.ts");
  await ensureDatabase();
  d1 = await getD1();
  db = await getDb();
  ORG = (await d1.prepare("SELECT id FROM organisations WHERE status = 'active' ORDER BY id LIMIT 1").first())?.id;
  assert.ok(ORG);
  const org = await d1.prepare("SELECT * FROM organisations WHERE id = ?").bind(ORG).first();
  /* A second workspace, copied from the first so every NOT NULL column is filled. */
  const columns = Object.keys(org).filter((c) => c !== "id" && c !== "slug");
  await d1
    .prepare(
      `INSERT INTO organisations (id${org.slug !== undefined ? ", slug" : ""}, ${columns.join(", ")})
       VALUES (?${org.slug !== undefined ? ", ?" : ""}, ${columns.map(() => "?").join(", ")})`,
    )
    .bind(OTHER_ORG, ...(org.slug !== undefined ? ["zz-sla-other"] : []), ...columns.map((c) => (c === "name" ? "ZZ Other workspace" : org[c])))
    .run();
});

after(async () => {
  if (!dir) return;
  const stub = await import("./fixtures/cloudflare-workers-stub.mjs");
  stub.closeForTests?.();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* A leftover temp directory is the OS's to reclaim; it is not a result. */
  }
});

const rows = async (orgId) =>
  (
    await d1
      .prepare(
        "SELECT priority_key, target_percent, version, effective_from, superseded_at FROM sla_targets WHERE organisation_id = ? AND stage = 'compliance' ORDER BY priority_key, version",
      )
      .bind(orgId)
      .all()
  ).results;

/* ── defaults ─────────────────────────────────────────────────────────────── */

test("with nothing saved, every key is the shipped 95% and says it is the default", async () => {
  const targets = await lib.readSlaComplianceTargets(db, ORG);
  assert.equal(targets.overall, 95);
  assert.deepEqual(targets.byPriority, { urgent: 95, medium: 95, low: 95, not_recorded: 95 });
  assert.ok(targets.entries.every((entry) => entry.source === "default" && entry.version === null));
  assert.equal((await rows(ORG)).length, 0, "no seed — an absent row IS the default");
});

/* ── editing, persistence and versioning ─────────────────────────────────── */

test("a save persists as version 1, and a second save supersedes it without rewriting it", async () => {
  const first = await lib.saveSlaComplianceTargets(db, ORG, { urgent: 90, overall: 92 }, "owner@example.invalid", "2026-09-23T10:00:00.000Z");
  assert.deepEqual(
    first.changes.map((c) => [c.key, c.from, c.to, c.version]),
    [["overall", 95, 92, 1], ["urgent", 95, 90, 1]],
  );
  assert.equal(first.targets.overall, 92);
  assert.equal(first.targets.byPriority.urgent, 90);
  assert.equal(first.targets.byPriority.medium, 95, "an untouched key stays the default");

  const second = await lib.saveSlaComplianceTargets(db, ORG, { urgent: 85 }, "admin@example.invalid", "2026-09-24T09:00:00.000Z");
  assert.deepEqual(second.changes.map((c) => [c.key, c.from, c.to, c.version]), [["urgent", 90, 85, 2]]);

  const urgent = (await rows(ORG)).filter((r) => r.priority_key === "urgent");
  assert.equal(urgent.length, 2, "both versions are kept — history is never overwritten");
  assert.deepEqual(
    urgent.map((r) => [r.version, r.target_percent, r.effective_from, r.superseded_at]),
    [
      [1, 90, "2026-09-23T10:00:00.000Z", "2026-09-24T09:00:00.000Z"],
      [2, 85, "2026-09-24T09:00:00.000Z", null],
    ],
    "version 1 keeps its value and start; only its end is stamped",
  );
  const now = await lib.readSlaComplianceTargets(db, ORG);
  assert.equal(now.byPriority.urgent, 85);
  const entry = now.entries.find((e) => e.key === "urgent");
  assert.equal(entry.version, 2);
  assert.equal(entry.updatedBy, "admin@example.invalid");

  const history = await lib.slaComplianceTargetHistory(db, ORG);
  assert.ok(history.some((h) => h.key === "urgent" && h.version === 1 && h.percent === 90), "the history lists the superseded version");

  const logged = await d1
    .prepare("SELECT count(*) AS n FROM activity_log WHERE entity_type = 'sla_targets' AND organisation_id = ?")
    .bind(ORG)
    .first();
  assert.equal(Number(logged.n), 2, "each save writes one activity row in the same batch");
});

test("saving the value already in effect writes nothing at all", async () => {
  const before = (await rows(ORG)).length;
  const saved = await lib.saveSlaComplianceTargets(db, ORG, { urgent: 85, overall: 92 }, "owner@example.invalid", "2026-09-25T09:00:00.000Z");
  assert.deepEqual(saved.changes, []);
  assert.equal((await rows(ORG)).length, before);
});

test("a save touches no job and no other workspace", async () => {
  const jobs = await d1.prepare("SELECT count(*) AS n, coalesce(max(updated_at), '') AS m FROM maintenance_requests").first();
  await lib.saveSlaComplianceTargets(db, ORG, { low: 80 }, "owner@example.invalid", "2026-09-26T09:00:00.000Z");
  const after = await d1.prepare("SELECT count(*) AS n, coalesce(max(updated_at), '') AS m FROM maintenance_requests").first();
  assert.deepEqual(after, jobs, "the target is the line, not the measurement — no job row moves");
  const other = await lib.readSlaComplianceTargets(db, OTHER_ORG);
  assert.equal(other.byPriority.low, 95, "another workspace still reads the default");
  assert.equal(other.overall, 95);
});

test("input is checked: whole percentages 1–100, known keys only, at least one key", () => {
  assert.equal(lib.parseSlaTargetInput({ urgent: 90 }).ok, true);
  for (const bad of [null, [], {}, { urgent: 0 }, { urgent: 101 }, { urgent: 90.5 }, { urgent: "90" }, { urgnet: 90 }]) {
    assert.equal(lib.parseSlaTargetInput(bad).ok, false, `refuses ${JSON.stringify(bad)}`);
  }
});

test("two current rows for one key cannot exist — the index refuses the second", async () => {
  await assert.rejects(
    d1
      .prepare(
        `INSERT INTO sla_targets (id, organisation_id, stage, priority_key, target_minutes, target_percent, basis, version, effective_from)
         VALUES ('zz-dup', ?, 'compliance', 'urgent', 0, 70, 'percent', 9, '2026-09-27T00:00:00.000Z')`,
      )
      .bind(ORG)
      .run(),
    /UNIQUE|constraint/i,
  );
});

/* ── the live card reads them ────────────────────────────────────────────── */

test("the Overview's payload carries the workspace's targets to the gauge and to each bar", async () => {
  const { loadOverviewMetrics } = await import("../app/lib/overview-metrics.ts");
  const metrics = await loadOverviewMetrics(db, ORG, { from: "2026-01-01", to: "2026-09-30" });
  assert.equal(metrics.intel.slaTargetPercent, 92, "the gauge is held to the OVERALL target saved above");
  const byKey = Object.fromEntries(metrics.intel.slaByPriority.map((row) => [row.key, row.targetPercent]));
  assert.equal(byKey.urgent, 85, "the High bar is held to version 2");
  assert.equal(byKey.low, 80);
  assert.equal(byKey.medium, 95, "an unsaved priority is still the shipped default");

  const other = await loadOverviewMetrics(db, OTHER_ORG, { from: "2026-01-01", to: "2026-09-30" });
  assert.equal(other.intel.slaTargetPercent, 95, "the other workspace's card is untouched");
});

test("the pure builder applies the targets, and falls back to 95% without them", async () => {
  const { buildSlaByPriority } = await import("../app/lib/overview-intel.ts");
  const input = [{ priority: "Urgent", total: 10, overdue: 2 }, { priority: "Low", total: 4, overdue: 0 }];
  const normalise = (value) => (/urgent|high/i.test(value ?? "") ? "urgent" : /low/i.test(value ?? "") ? "low" : "medium");
  const held = buildSlaByPriority(input, normalise, { overall: 90, byPriority: { urgent: 88, medium: 91, low: 70, not_recorded: 95 } });
  assert.deepEqual(held.map((r) => [r.key, r.targetPercent]), [["urgent", 88], ["medium", 91], ["low", 70]]);
  const shipped = buildSlaByPriority(input, normalise);
  assert.ok(shipped.every((r) => r.targetPercent === 95));
});

/* ── the route, the editor and the card, as written ──────────────────────── */

test("the route reads with board.view, writes with settings.edit, and audits", () => {
  const route = read("app/api/sla-targets/route.ts");
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PUT"));
  const put = route.slice(route.indexOf("export async function PUT"));
  assert.match(get, /scopedDbWithCapability\(request, "board\.view"\)/);
  assert.match(put, /scopedDbWithCapability\(request, "settings\.edit"\)/, "owner and admin only, per §4.4");
  assert.match(put, /saveSlaComplianceTargets\(scope\.db, scope\.orgId,/, "the organisation is the caller's own");
  assert.match(put, /recordAudit\(/);
  assert.match(put, /status: 409/, "a lost race is answered, not a 503");
  assert.match(route, /const anonymous = anonymousRefusal\(error\);/);
});

test("Settings shows the editor, and the card draws each bar against its own target", () => {
  const portal = read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /<SlaTargetsPanel \/>/);
  const panel = read("app/(app)/portal/views/sla-targets-panel.tsx");
  assert.match(panel, /method: "PUT"/);
  assert.match(panel, /fetch\("\/api\/sla-targets"/);
  const card = read("app/(app)/portal/ops/oi-dash.tsx");
  assert.match(card, /const rowTarget = row\.targetPercent \?\? target;/);
  assert.match(card, /qualityTone\(sla\.percent, heldTo\(intel\.slaTargetPercent\)\)/, "the gauge's colour follows the overall target");
  const bars = read("app/(app)/portal/ops/oi-dash-charts.tsx");
  assert.match(bars, /left: `\$\{markerAt\(row\.target\)\}%`/, "each bar's marker stands at its own target");
});
