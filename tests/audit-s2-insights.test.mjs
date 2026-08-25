/**
 * Audit S2 — the Overview insight panels count open/closed by the canonical
 * partition, not by `completedAt`.
 *
 * WHY THIS EXISTS. `isClosedRequest` in dashboard-meters.ts is a union of two
 * signals — `stage === "Completed"` OR `status === "Job Completed"` — precisely
 * because the monday import files finished work in "… Recently completed"
 * groups whose rows keep stage "Incoming" and carry NO completion date. Two
 * Overview insight panels — Open job ageing and Sites needing attention — used
 * `completedAt` as their open/closed signal instead. On the imported data that
 * counts every finished job as open work: the ageing panel lists them under
 * "waiting longest" and the site panel adds them to a site's open-job bar,
 * both disagreeing with the "Open jobs" tile above them, which uses the
 * canonical partition. The staging (Preview) workspace already carries the
 * reverse anomaly — a row with a completion date whose status is still
 * "Pending Approval" — so the two signals demonstrably disagree on real data.
 *
 * The fix routes both panels through `isOpenRequest` / `isClosedRequest`. This
 * pins that, and proves the partition ignores `completedAt` in both directions.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const meters = await (async () => {
  const source = await read("app/(app)/portal/dashboard-meters.ts");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
})();

function row(overrides = {}) {
  return {
    id: "R",
    status: "Pending Scheduling",
    stage: "Incoming",
    priority: "Medium",
    tier: 2,
    requestedAt: "2026-08-01T00:00:00.000Z",
    dueAt: null,
    completedAt: null,
    ...overrides,
  };
}

test("the canonical partition ignores completedAt in both directions", () => {
  const { isOpenRequest, isClosedRequest } = meters;

  // A monday-imported finished job: status says done, but stage is Incoming and
  // there is NO completion date. A `!completedAt` test would call this OPEN.
  const importedDone = row({ status: "Job Completed", stage: "Incoming", completedAt: null });
  assert.equal(isClosedRequest(importedDone), true, "status 'Job Completed' is closed even with no completion date");
  assert.equal(isOpenRequest(importedDone), false);

  // The Preview anomaly: a completion date is set, but the job is not marked
  // done by stage or status. A `completedAt` test would call this CLOSED.
  const anomalous = row({ status: "Pending Approval", stage: "Incoming", completedAt: "2026-08-23T01:04:58.475Z" });
  assert.equal(isOpenRequest(anomalous), true, "a stray completion date does not close a job that is not marked done");
  assert.equal(isClosedRequest(anomalous), false);

  // Open and closed remain a partition.
  for (const r of [importedDone, anomalous, row(), row({ stage: "Completed", status: "Job Completed" })]) {
    assert.equal(isOpenRequest(r), !isClosedRequest(r));
  }
});

test("Open job ageing and Sites needing attention use the canonical partition", async () => {
  const source = await read("app/(app)/portal/dashboard-insights.tsx");

  assert.match(
    source,
    /import \{ isClosedRequest, isOpenRequest \} from "\.\/dashboard-meters"/,
    "the panels import the shared partition",
  );

  // Open job ageing: open set is isOpenRequest, not `!completedAt`.
  assert.match(source, /const open = requests\.filter\(isOpenRequest\)/, "ageing filters by isOpenRequest");

  // Sites needing attention: skips closed rows via isClosedRequest.
  assert.match(source, /if \(isClosedRequest\(request\)\) continue;/, "site attention skips isClosedRequest");

  // The old `completedAt`-as-open signal must not come back in these two panels.
  assert.doesNotMatch(source, /const open = requests\.filter\(\(request\) => !request\.completedAt\)/);
  assert.doesNotMatch(source, /if \(request\.completedAt\) continue;/);
});
