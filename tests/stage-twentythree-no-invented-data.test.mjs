/**
 * Stage 23 — nothing on the dashboard is invented when the real thing is gone.
 *
 * This has been wrong in three successive ways, each fix exposing the next.
 *
 * FIRST, the chip said "Loading workspace" for ever on a failed load, so a 503
 * from D1 presented `mock-data.ts` — eleven invented jobs — as the customer's
 * own figures, with nothing on screen saying otherwise.
 *
 * SECOND, the chip was made honest ("Sample data — workspace unavailable") but
 * the invented rows STAYED underneath it, and every dashboard went on computing
 * spend, compliance and SLA from them. A caption does not undo a £42,540 figure
 * sitting next to it.
 *
 * THIRD, with the sample rows finally gone, the panels drew £0 / 0 open / 100%
 * SLA from an empty array — indistinguishable from a genuinely quiet month, and
 * sitting beside real annual budgets that had loaded fine. A fabricated zero is
 * still a fabrication, and it appears in the two places somebody goes
 * specifically to find out how much has been spent.
 *
 * And one that hid all of it: `loadWorkspace` stamped `dataMode = "live"`. The
 * workspace fetch carries sites, contractors and settings; it succeeding says
 * nothing about whether the JOB list did. With `/api/maintenance` failing and
 * everything else healthy, the screen still read "Live workspace".
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const PORTAL = "app/(app)/portal/portal-app.tsx";

test("the dashboard cannot reach the sample data at all", async () => {
  const source = await read(PORTAL);

  // Not "does not use it" — cannot. An import is how it came back last time.
  assert.doesNotMatch(
    source,
    /from "\.\.\/\.\.\/lib\/mock-data"/,
    "portal-app must not import mock-data; empty is honest, invented is not",
  );
  assert.doesNotMatch(source, /\bsampleRequests\b/);
  assert.doesNotMatch(source, /\bsampleFiles\b/);
});

test("every seeded state starts empty", async () => {
  const source = await read(PORTAL);

  assert.match(source, /useState<MaintenanceRequest\[\]>\(\[\]\)/);
  assert.match(source, /useState<FileRecord\[\]>\(\[\]\)/);
  assert.match(
    source,
    /const currentStores = workspace\?\.stores \?\? \[\];/,
    "an unreadable workspace has no sites, and saying so beats drawing somebody else's estate",
  );
});

test("a failed load clears what was there rather than leaving it", async () => {
  const source = await read(PORTAL);

  assert.match(
    source,
    /if \(active\) \{\s*\n\s*setRequests\(\[\]\);\s*\n\s*setDataMode\("unavailable"\);/,
    "the jobs are cleared AND the mode is set — the second without the first was the second bug",
  );
  assert.match(source, /if \(active\) setDocuments\(\[\]\);/);
});

test("the chip describes the jobs, and only the jobs", async () => {
  const source = await read(PORTAL);

  assert.match(source, /useState<"live" \| "loading" \| "unavailable">\(\s*"loading",/);
  // The old label named sample data that no longer exists.
  assert.doesNotMatch(source, /Sample data — workspace unavailable/);
  assert.match(source, /\? "Workspace unavailable"/);

  /*
   * `loadWorkspace` must not speak for the job list — and the assertion has to
   * read CODE, not prose. The comment that records this decision quotes the
   * call it is refusing to make, which a naive scan counts as the call itself.
   */
  const at = source.indexOf("setWorkspace(payload.workspace);");
  const loader = source
    .slice(at, at + 900)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(
    loader,
    /setDataMode\("live"\)/,
    "the workspace fetch succeeding says nothing about whether the jobs loaded",
  );
});

test("Overview and Reports refuse to draw a figure they did not measure", async () => {
  const source = await read(PORTAL);

  assert.match(source, /function WorkspaceUnavailable\(/);
  assert.match(
    source,
    /\{activeSurface === "overview" && dataMode === "unavailable" && \(/,
  );
  assert.match(
    source,
    /\{activeSurface === "reports" && dataMode === "unavailable" && \(/,
  );
  // And the real panels are skipped, not merely covered.
  assert.match(source, /\{activeSurface === "overview" && dataMode !== "unavailable" && \(/);
  assert.match(source, /\{activeSurface === "reports" && dataMode !== "unavailable" && \(/);

  // The notice itself carries no numbers — that is the entire point of it.
  const notice = source.slice(
    source.indexOf("function WorkspaceUnavailable("),
    source.indexOf("function ComplianceView("),
  );
  assert.doesNotMatch(notice, /£|\d+%/, "a failure notice with a figure on it is the bug again");
  assert.match(notice, /Try again/, "and it offers the way out");
});
