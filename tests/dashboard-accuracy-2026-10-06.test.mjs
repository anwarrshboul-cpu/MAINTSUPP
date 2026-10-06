/**
 * Dashboard accuracy pass (owner's request, 2026-10-06): "all the dashboards
 * have to be synchronised and accurate 100% … any charts, any diagram, any
 * figure have to be reflected and connected."
 *
 * What this file holds the product to:
 *   - one definition of OPEN, including the statuses an administrator mapped
 *     closed, for the sidebar badge as for the SQL figures;
 *   - one compliance population: a closed or European store is listed but not
 *     scored, on the Overview, the Compliance page, its register and Sites;
 *   - a job's money is one number: writes keep `cost_pence` with `cost`, and
 *     the rows an earlier edit left behind are repaired only on request;
 *   - the report treats "no site" placeholders as no site.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const { openJobCount } = await import("../app/lib/job-metrics.ts");

test("open honours the configured closed statuses when they are given", () => {
  const jobs = [
    { stage: "In progress", status: "Awaiting invoice" },
    { stage: "In progress", status: "Working on it" },
    { stage: "Completed", status: "Done" },
  ];
  assert.equal(openJobCount(jobs, ["awaiting invoice"]), 1, "a status mapped closed is not open");
  assert.equal(openJobCount(jobs, []), 2, "with nothing mapped, only Completed is closed");
});

test("a closed or European store's record is outside the percentage, and only an explicit false says so", async () => {
  const status = await read("app/lib/compliance-status.ts");
  assert.match(status, /record\.operational !== false && countsTowardCompliance\(record\.dutyHolder\)/);
  assert.match(status, /\(record\) => record\.state !== "Not required" && !scorable\(record\)/, "counted as excluded");
  assert.match(status, /\(record\) => record\.state === "Compliant" && scorable\(record\)/, "and never as satisfied");
  const view = await read("app/lib/compliance-view.ts");
  assert.match(view, /return row\.operational !== false && row\.state !== "Not required"/, "drills list what the figure counted");
});

test("every register entry carries whether it is operational, from the one definition", async () => {
  const register = await read("app/lib/compliance-register.ts");
  assert.equal((register.match(/operational: withinOperationalEstate\(\{/g) ?? []).length, 2);
  const view = await read("app/lib/compliance-view.ts");
  assert.match(view, /\.\.\.\(entry\.operational === undefined \? \{\} : \{ operational: entry\.operational \}\)/);
});

test("stale pence are repaired only when staff ask, never on boot", async () => {
  const init = await read("db/init.ts");
  assert.doesNotMatch(init, /realignCostPence|ensureCostPenceInStep/);
  const route = await read("app/api/integrations/monday/route.ts");
  assert.match(route, /body\.action === "realign-cost-pence"/);
  assert.match(route, /realignCostPence\(await getDb\(\), \{ apply \}\)/);
  const lib = await read("app/lib/cost-pence-realign.ts");
  assert.match(lib, /if \(options\.apply\) \{/);
  const fields = await read("app/lib/request-fields.ts");
  assert.match(fields, /values\.costPence = cost === null \? null : poundsToPence\(cost\)/);
});

test("the report reads the board's no-site placeholders as no site", async () => {
  const engine = await read("app/lib/reporting/engine.ts");
  assert.match(engine, /siteId === "site-unassigned" \|\| siteId\.startsWith\("site-website-intake-"\)/);
  assert.match(engine, /const siteId = isPlaceholderSiteId\(row\.siteId\) \? null : row\.siteId;/);
});
