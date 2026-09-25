/**
 * THE COMPLIANCE PAGE COUNTS TWO POPULATIONS, AND SAYS WHICH IS WHICH (2026-09-25).
 *
 * Owner decision: keep them different. On "All portfolios" the Compliance block
 * said "Expired 5" and the Expiry timeline "71 already expired", both correct:
 *
 *   A. the block — the score, its legend and the renewals countdown — counts
 *      SCORED requirements only (`isScoredRow`: not "Not required", and the
 *      responsibility confirmed as the client's);
 *   B. the timeline counts EVERY dated certificate in the portfolio, whatever its
 *      state. Measured on the local estate: its 71 were the 5 scored Expired plus
 *      66 records marked Not required that still carry a lapsed date.
 *
 * The fix is wording only. These tests run both populations through the real
 * builders on one small estate, prove neither calculation moved, prove #116's
 * portfolio scoping still holds, and pin the words that tell the two apart.
 */

import "./reports-ts-loader.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const { buildComplianceDashboard } = await import("../app/lib/compliance-dash.ts");
const { complianceRowsFrom, isScoredRow } = await import("../app/lib/compliance-view.ts");
const { complianceStateFor } = await import("../app/lib/store-documentation-register.ts");
const { EXPIRY_DUE_SOON_DAYS } = await import("../app/lib/compliance-status.ts");
const { expiryTimeline, recordsInScope, scopeFromPayloadSiteIds } = await import(
  "../app/lib/compliance-expiry-timeline.ts"
);
const { drillSiteIds } = await import("../app/lib/job-metrics.ts");

const TODAY = new Date("2026-09-25T10:00:00Z");

function inDays(n) {
  const at = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate()));
  at.setUTCDate(at.getUTCDate() + n);
  return at.toISOString().slice(0, 10);
}

/** One register row, classified by the product's own classifier. */
function entry({ site, kind, expiry = null, files = 1, notRequired = false, duty = null }) {
  return {
    id: `${site}:${kind}`,
    siteId: site,
    siteName: site,
    kind,
    dutyHolder: duty,
    state: complianceStateFor({ tracksExpiry: true, expiry, fileCount: files, notRequired, today: TODAY }),
    expiry,
    fileCount: files,
    itemId: `item-${site}`,
    slotKey: kind.toLowerCase(),
  };
}

/* Three lapsed dates; only one of them is a scored requirement. */
const ESTATE = [
  entry({ site: "s1", kind: "Gas Safety", expiry: inDays(-3) }), // Expired, scored
  entry({ site: "s1", kind: "Fire Alarm", expiry: inDays(40) }), // Expiring soon, scored
  entry({ site: "s2", kind: "Gas Safety", expiry: inDays(-40), notRequired: true }), // lapsed, Not required
  entry({ site: "s3", kind: "Fire Alarm", expiry: inDays(-10), duty: "unconfirmed" }), // lapsed, not the client's
];

function block(entries) {
  return buildComplianceDashboard({
    rows: complianceRowsFrom(entries, new Map()),
    today: TODAY,
    portfolio: { id: "all", name: "All portfolios", siteIds: null },
    portfolios: [],
    range: { from: null, to: null, label: "Any due date" },
    activeSiteIds: ["s1", "s2", "s3"],
    warningWindowDays: EXPIRY_DUE_SOON_DAYS,
  });
}

/* ── 1. The block still counts scored requirements ────────────────────────── */

test("the score and the countdown count scored requirements only", () => {
  assert.equal(ESTATE[2].state, "Not required");
  assert.equal(ESTATE[3].state, "Expired", "lapsed and on file — but not the client's");
  const scoredExpired = ESTATE.filter((row) => isScoredRow(row) && row.state === "Expired").length;
  assert.equal(scoredExpired, 1);

  const metrics = block(ESTATE);
  assert.equal(metrics.score.counts.expired, 1, "the score's Expired is the scored one");
  assert.equal(metrics.countdown.rings.find((ring) => ring.key === "expired").value, 1, "and so is the countdown's");
});

/* ── 2. The timeline still counts every dated certificate ─────────────────── */

test("the Expiry timeline counts every dated certificate, scored or not", () => {
  const timeline = expiryTimeline(ESTATE, TODAY);
  assert.equal(timeline.expired, 3, "the scored one, the not-required one and the unconfirmed one");
  assert.equal(timeline.total, 1, "Fire Alarm at s1, due in forty days");
  assert.ok(timeline.expired > block(ESTATE).countdown.rings.find((ring) => ring.key === "expired").value,
    "the larger figure is the timeline's, by design");
});

/* ── 4 & 5. #116's portfolio scope, and its empty state, are unchanged ────── */

test("the timeline still counts only the selected portfolio, and nothing for an empty one", () => {
  const s1 = expiryTimeline(recordsInScope(ESTATE, ["s1"]), TODAY);
  assert.deepEqual([s1.expired, s1.total], [1, 1]);
  const s2s3 = expiryTimeline(recordsInScope(ESTATE, ["s2", "s3"]), TODAY);
  assert.deepEqual([s2s3.expired, s2s3.total], [2, 0]);
  /* A portfolio that resolved to no sites, as the payload sends it. */
  const none = expiryTimeline(recordsInScope(ESTATE, scopeFromPayloadSiteIds(drillSiteIds([]))), TODAY);
  assert.deepEqual([none.expired, none.total], [0, 0]);
  /* All portfolios: no narrowing. */
  assert.equal(expiryTimeline(recordsInScope(ESTATE, scopeFromPayloadSiteIds(drillSiteIds(null))), TODAY).expired, 3);
});

/* ── 3. The words say which population each figure is ─────────────────────── */

test("the page names the two populations: scored requirements and dated certificates", async () => {
  const dash = await read("app/(app)/portal/ops/cp-dash.tsx");
  assert.match(dash, /of \$\{countText\(score\.applicable\)\} scored requirements on track`/);
  assert.match(dash, /Scored requirements expired now or due in the next \{policy\.warningWindowDays\} days/);
  assert.match(dash, /`Renewals countdown of scored requirements, /, "and the countdown's accessible name says so too");

  const insights = await read("app/(app)/portal/dashboard-insights.tsx");
  const timeline = insights.slice(insights.indexOf("export function ComplianceExpiryTimeline"), insights.indexOf("/* ── Reactive versus planned"));
  assert.match(timeline, /\{plural\(months\.expired, "expired dated certificate"\)\}/);
  assert.match(timeline, /hint=\{`\$\{plural\(total, "dated certificate"\)\} due in the next twelve months`\}/);
  assert.match(timeline, /<p className="insight-note insight-note--scope">\s*Includes every dated certificate in the selected portfolio, including records outside the\s*compliance score \(such as those marked not required\), so it can show more expired than the\s*scored figures above\./);
  assert.doesNotMatch(timeline, /already expired/, "the ambiguous label is gone");
  assert.match(timeline, /message: "Nothing due in this portfolio"/, "the empty state is unchanged");
});

test("neither calculation moved: the same predicates and the same counting", async () => {
  const view = await read("app/lib/compliance-view.ts");
  assert.match(view, /return row\.state !== "Not required" && countsTowardCompliance\(row\.dutyHolder\);/);
  const builder = await read("app/lib/compliance-dash.ts");
  assert.match(builder, /const renewing = scored\.filter\(\(row\) => row\.state === "Expired" \|\| row\.state === "Expiring soon"\);/);
  const insights = await read("app/(app)/portal/dashboard-insights.tsx");
  assert.match(insights, /expiryTimeline\(recordsInScope\(compliance, siteIds\), new Date\(clock\)\)/);
  const lib = await read("app/lib/compliance-expiry-timeline.ts");
  assert.match(lib, /if \(status\.daysRemaining < 0\) \{\s*expired \+= 1;/);
});
