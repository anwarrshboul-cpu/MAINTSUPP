/**
 * THE STATUS MAP DECIDES WHAT THE OVERVIEW CALLS OPEN.
 *
 * `job_status_map.counts_as_open` is the configurable category, and the
 * Calendar, the unscheduled tray and every status chip have honoured it for as
 * long as it has existed. The Overview did not. It SELECTED the column at
 * `overview-metrics.ts` and then built `statusMeta` out of `display`, `colour`
 * and `sortOrder` only — the value was fetched and dropped — and closed jobs
 * off the hardcoded `completedStatuses` instead. An administrator who marked a
 * status closed watched twenty jobs leave the tray and stay in the Overview's
 * open figure.
 *
 * What makes this worth a dedicated suite is how it survived: the module's own
 * docstring claimed the map was authoritative, and `ov-dash-metrics.test.mjs`
 * asserted that the STRING `jobStatusMap.countsAsOpen` appeared in the file and
 * called that proof. The assertion passed *because of* the discarded select.
 * Deleting the dead line would have failed a green test.
 *
 * So nothing here pins source text. The live test changes a mapping through the
 * product's own API and watches the figures move, which is the only thing that
 * could not have passed before.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));

const stub = pathToFileURL(`${root}tests/fixtures/cloudflare-workers-stub.mjs`).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") return { url: stub, shortCircuit: true };
    if (spec.startsWith(".") && ctx.parentURL?.endsWith(".ts")) {
      const base = new URL(spec, ctx.parentURL);
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`, `${base.href}.tsx`]) {
        if (fs.existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true };
      }
    }
    return next(spec, ctx);
  },
});

const { closedStatusKeys, statusKey } = await import("../app/lib/job-metrics.ts");
const { completedStatuses } = await import("../app/(app)/portal/dashboard-meters.ts");
const { closedJobSqlFor } = await import("../app/lib/dashboard-aggregates.ts");
const { readDrillFilter } = await import("../app/(app)/portal/board-drill-filter.ts");
const { SQLiteSyncDialect } = await import("drizzle-orm/sqlite-core");

const SHIPPED = completedStatuses.map((label) => statusKey(label)).sort();

/* ── 1. The rule ──────────────────────────────────────────────────────────── */

test("a configured status is closed exactly when the map says it is not open", () => {
  const keys = closedStatusKeys([
    { sourceStatusLabel: "Awaiting client PO", countsAsOpen: false },
    { sourceStatusLabel: "In progress", countsAsOpen: true },
  ]);
  assert.ok(keys.includes("awaiting client po"), "a status marked closed must close");
  assert.ok(!keys.includes("in progress"), "a status marked open must not");
});

test("an organisation can REOPEN a status the shipped list calls closed", () => {
  /* The direction that proves the map is authoritative rather than additive:
     the hardcoded list is not a floor. */
  const keys = closedStatusKeys([{ sourceStatusLabel: "Cancelled", countsAsOpen: true }]);
  assert.ok(!keys.includes("cancelled"), "an explicit mapping must win over the shipped list");
  assert.ok(keys.includes("completed"), "statuses it did not configure are untouched");
});

test("a status with no mapping falls back to the shipped vocabulary", () => {
  const keys = closedStatusKeys([{ sourceStatusLabel: "In progress", countsAsOpen: true }]);
  for (const shipped of SHIPPED) {
    assert.ok(keys.includes(shipped), `${shipped} must still close with no mapping of its own`);
  }
});

test("an empty map is the shipped vocabulary, not an estate where nothing closes", () => {
  /* Load-bearing: a freshly seeded organisation can have no rows at all, and a
     rule that trusted the map alone would call every completed job OPEN. */
  assert.deepEqual(closedStatusKeys([]), SHIPPED);
});

test("a retired mapping is ignored, and its status falls back", () => {
  const keys = closedStatusKeys([
    { sourceStatusLabel: "Cancelled", countsAsOpen: true, active: false },
  ]);
  assert.ok(keys.includes("cancelled"), "an inactive row must not reopen a shipped status");
});

test("the keys are normalised the way every status comparison in the product is", () => {
  const keys = closedStatusKeys([{ sourceStatusLabel: "  AWAITING   Client PO  ", countsAsOpen: false }]);
  assert.ok(keys.includes("awaiting client po"));
});

test("0 and 1 are read as booleans, because SQLite sends the column that way", () => {
  /* `BOOLEAN_COLUMNS` in db/sqlite-to-postgres.ts makes this 0/1 locally and a
     real boolean deployed; a strict `=== false` would behave differently on the
     two databases. */
  const asNumbers = closedStatusKeys([{ sourceStatusLabel: "Parked", countsAsOpen: 0 }]);
  assert.ok(asNumbers.includes("parked"), "0 must read as closed");
  const open = closedStatusKeys([{ sourceStatusLabel: "Cancelled", countsAsOpen: 1 }]);
  assert.ok(!open.includes("cancelled"), "1 must read as open");
});

/* ── 2. The SQL it builds ─────────────────────────────────────────────────── */

const dialect = new SQLiteSyncDialect();

test("the closure SQL carries the configured statuses as bound values", () => {
  const rendered = dialect.sqlToQuery(closedJobSqlFor(["awaiting client po", "cancelled"]));
  assert.ok(rendered.params.includes("awaiting client po"));
  assert.ok(rendered.params.includes("cancelled"));
  assert.ok(!rendered.sql.includes("awaiting client po"), "values are bound, never spliced");
});

test("the stage arm survives, so a finished job cannot be reopened by configuration", () => {
  /* A stage is not a status and is not configurable. Marking "Completed" open
     must not resurrect work that has actually been finished. */
  const rendered = dialect.sqlToQuery(closedJobSqlFor([]));
  assert.match(rendered.sql, /stage/i, "an empty key set still closes on the stage");
  assert.ok(rendered.params.includes("Completed"), "and the stage it closes on is bound");
});

/* ── 3. The drill has to agree, or the list contradicts the figure ────────── */

const job = (id, status, stage = "Incoming") => ({
  id,
  status,
  stage,
  archived: false,
  parentId: null,
  priority: "medium",
  dueAt: null,
  requestedAt: "2026-05-01",
  completedAt: null,
  siteId: "site-1",
});

const population = [
  job("a", "Job Scheduled"),
  job("b", "Job Scheduled"),
  job("c", "Pending Approval"),
  job("d", "Job Completed"),
];

const openCount = (context) => {
  const filter = readDrillFilter(new URLSearchParams("family=open"), new Date(), {
    population,
    ...context,
  });
  return population.filter((row) => filter.matches(row)).length;
};

test("with no mappings the drill counts what it always counted", () => {
  /* Several suites call `readDrillFilter` with no context at all; the shipped
     vocabulary has to remain the default or they change meaning silently. */
  assert.equal(openCount({}), 3, "three open, one Job Completed");
});

test("the drill honours a status the organisation has marked closed", () => {
  const keys = closedStatusKeys([
    { sourceStatusLabel: "Job Scheduled", countsAsOpen: false },
    { sourceStatusLabel: "Job Completed", countsAsOpen: false },
  ]);
  assert.equal(openCount({ closedStatusKeys: keys }), 1, "only Pending Approval stays open");
});

test("an empty key list is ignored rather than read as 'nothing closes'", () => {
  /* The shell passes `undefined` until the fetch lands. If an empty array ever
     reaches here it must not open completed jobs into the list. */
  assert.equal(openCount({ closedStatusKeys: [] }), 3);
});

test("family=closed is the exact mirror, so the two halves of a cohort partition it", () => {
  const keys = closedStatusKeys([{ sourceStatusLabel: "Job Scheduled", countsAsOpen: false }]);
  const count = (query) => {
    const filter = readDrillFilter(new URLSearchParams(query), new Date(), {
      population,
      closedStatusKeys: keys,
    });
    return population.filter((row) => filter.matches(row)).length;
  };
  const open = count("family=open");
  const closed = count("family=closed");
  assert.equal(open + closed, population.length, "every job is on exactly one side");
  assert.equal(closed, 3, "two Job Scheduled plus the Job Completed");
});

/* ── 4. Against the live estate — the audit's own reproduction ────────────── */

const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const headers = {
  "x-maintsupp-identity": "admin@sunnamusk-uk.test.maintsupp.com",
  Accept: "application/json",
  "Content-Type": "application/json",
};

async function overview(search = "from=2025-10-01&to=2026-09-16") {
  const response = await fetch(`${BASE}/api/overview/metrics?${search}`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  return response.ok ? response.json() : null;
}

async function serverIsUp() {
  try {
    const body = await overview();
    return Boolean(body?.intel);
  } catch {
    return false;
  }
}

test("LIVE marking a status closed removes exactly its jobs from every open figure", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server answering with intel");
    return;
  }
  const map = await (await fetch(`${BASE}/api/calendar/status-map`, { headers })).json();
  const target = (map.mappings ?? []).find(
    (row) => row.active && row.countsAsOpen && statusKey(row.sourceStatusLabel) === "job scheduled",
  );
  if (!target) {
    t.skip("this estate has no open 'Job Scheduled' mapping to toggle");
    return;
  }

  const before = await overview();
  const slice = before.intel.status.find(
    (entry) => statusKey(entry.label) === "job scheduled",
  );
  const moved = slice ? slice.value : 0;
  assert.ok(moved > 0, "the status must actually carry open jobs for this to prove anything");

  const setOpen = async (countsAsOpen) => {
    const response = await fetch(`${BASE}/api/calendar/status-map`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ id: target.id, countsAsOpen }),
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200, "the mapping write must succeed");
  };

  try {
    await setOpen(false);
    const after = await overview();

    assert.equal(
      after.intel.open,
      before.intel.open - moved,
      "Open jobs must drop by exactly the jobs carrying that status",
    );
    assert.ok(
      !after.intel.status.some((entry) => statusKey(entry.label) === "job scheduled"),
      "and the status must leave the open-work donut entirely",
    );

    /* Not just the headline: every split of open work is drawn from the same
       cohort, so all of them must move together or the page contradicts
       itself. */
    for (const [name, slices] of [
      ["status", after.intel.status],
      ["tiers", after.intel.tiers],
      ["engineers", after.intel.engineers],
    ]) {
      const total = slices.reduce((sum, entry) => sum + entry.value, 0);
      assert.equal(total, after.intel.open, `the ${name} split must still sum to Open jobs`);
    }
    assert.ok(
      after.intel.sla.open === after.intel.open && after.intel.sla.overdue <= after.intel.open,
      "the SLA figures must be computed over the same open cohort",
    );
    assert.deepEqual(after.reconciliation, [], "the payload must still reconcile");
  } finally {
    /* Restore whatever happened above, including on a failed assertion — this
       row is shared state for every other suite on this estate. */
    await setOpen(true);
  }

  const restored = await overview();
  assert.equal(restored.intel.open, before.intel.open, "restoring the mapping restores the figure");
  assert.equal(
    restored.intel.sla.overdue,
    before.intel.sla.overdue,
    "and every dependent figure with it",
  );
});
