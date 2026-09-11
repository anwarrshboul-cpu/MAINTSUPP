/**
 * A SECTION'S OWN REGISTER IS NOT THE JOBS LIST, so a Jobs drill must not touch it.
 *
 * Every dashboard drill-through opens the canonical Jobs board carrying its
 * filter in the query string, and that filter keeps only rows that count as
 * work ON that board — `countsAsWork` in `board-drill-filter.ts`, through
 * `isOnJobsBoard`. A workspace section bound to its own register (`sec-…`) is
 * ALSO the `maintenance` surface, and the shell applied the same filter to it:
 * every row of the section failed `isOnJobsBoard`, so the register rendered
 * empty under a "Filtered from a dashboard" banner about a list it is not.
 *
 * The fix is a gate, not a change of rule: `countsAsWork` is right about the
 * Jobs board and is untouched (`tests/jobs-board-population.test.mjs` pins it).
 * The drill, its totals and its banner simply apply only where the canonical
 * board is on screen.
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
const asModule = (js) => `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const SHELL = "app/(app)/portal/portal-app.tsx";

/*
 * The gate itself, sliced out of the shell between its markers, transpiled and
 * run on its own — the arrangement `ovt:similarity` uses in
 * /api/overview/contractor-aliases. It imports nothing and takes the Jobs
 * board's key as an argument precisely so this is possible: 9,800 lines of TSX
 * cannot be imported into `node --test`.
 */
const gate = await (async () => {
  const source = await read(SHELL);
  const start = source.indexOf("/* sbd:gate:start");
  const end = source.indexOf("/* sbd:gate:end */");
  assert.ok(start >= 0 && end > start, "the gate's markers must survive a refactor");
  const block = source.slice(start, end).replace(/^function /m, "export function ");
  return import(asModule(transpile(block)));
})();

const JOBS = "maintenance";

test("the drill reads the canonical Jobs board, and nothing else", () => {
  const applies = (surface, section) => gate.drillReadsThisBoard(surface, section, JOBS);

  assert.equal(applies("maintenance", null), true, "the built-in Jobs page");
  assert.equal(
    applies("maintenance", { boardKey: "maintenance", key: "section:jobs-2" }),
    true,
    "and a legacy section that is a second door onto the same board",
  );
  assert.equal(applies("maintenance", { boardKey: "  maintenance  " }), true, "however it is stored");

  assert.equal(
    applies("maintenance", { boardKey: "sec-cctv" }),
    false,
    "a section with a register of its own is a different list",
  );
  assert.equal(
    applies("maintenance", { boardKey: null }),
    false,
    "and a section detached from its register draws nothing at all",
  );
  assert.equal(applies("maintenance", {}), false, "an entry created before section boards existed");

  for (const surface of ["overview", "stores", "store-documentation", "calendar", "reports", "__pending"]) {
    assert.equal(applies(surface, null), false, `${surface} has no Jobs drill`);
  }
});

test("without the gate, a Jobs drill empties a section's register — which is why it exists", async () => {
  const { readDrillFilter } = await import("../app/(app)/portal/board-drill-filter.ts");
  const sectionRow = {
    id: "MN-1",
    boardId: "sec-cctv",
    status: "Pending Approval",
    stage: "Incoming",
    archived: false,
    parentId: null,
    requestedAt: new Date().toISOString(),
    siteId: "site-1",
    tier: 3,
    priority: "Medium",
    category: "CCTV",
    engineer: "Specialist",
    cost: null,
  };
  const jobRow = { ...sectionRow, id: "MN-2", boardId: "maintenance" };

  const drill = readDrillFilter(new URLSearchParams("family=open"), new Date());
  assert.equal(drill.empty, false);
  assert.equal(drill.matches(jobRow), true, "a job on the Jobs board is kept");
  assert.equal(
    drill.matches(sectionRow),
    false,
    "a section's row is not — the drill counts only what the Jobs board holds",
  );

  /* What the gate hands the board instead: no parameters at all, so the filter
     is empty, nothing is removed and no banner is drawn. */
  const ungated = readDrillFilter(new URLSearchParams(""), new Date());
  assert.equal(ungated.empty, true);
  assert.deepEqual(ungated.chips, []);
  assert.equal(ungated.matches(sectionRow), true, "the section's board is shown whole");
});

test("the shell gates the filter, the totals and the banner on the same answer", async () => {
  const shell = await read(SHELL);

  assert.match(
    shell,
    /const drillApplies = drillReadsThisBoard\(activeSurface, activeCustom, JOBS_BOARD_KEY\);/,
    "one answer, computed once",
  );
  /* The Jobs board's key is imported, not written out a second time here. */
  assert.match(shell, /import \{ JOBS_BOARD_KEY,[^}]*\} from "\.\.\/\.\.\/lib\/job-metrics";/);

  /* Off the Jobs board the filter is read from an EMPTY query string, so
     `drill.empty` is true and `boardRequests`, `drillTotals` and the banner all
     follow from it rather than from three separate conditions that could drift. */
  assert.match(
    shell,
    /readDrillFilter\(new URLSearchParams\(drillApplies \? routeSearch : ""\), new Date\(\), context\)/,
  );
  assert.match(shell, /const boardRequests = useMemo\(\s*\n?\s*\(\) => \(drill\.empty \? requests : requests\.filter\(drill\.matches\)\)/);
  assert.match(shell, /if \(drill\.empty\) return null;/, "no totals without a drill");
  assert.match(shell, /\{drillApplies && !drill\.empty \? \(/, "and no banner");
  assert.doesNotMatch(
    shell,
    /\{activeSurface === "maintenance" && !drill\.empty \? \(/,
    "the surface alone is no longer the test — that is what emptied the section",
  );

  /* The board still receives the list — gated or not, it is the same prop. */
  assert.match(shell, /requests=\{boardRequests\}/);
});

test("the population rule itself is untouched", async () => {
  const filter = await read("app/(app)/portal/board-drill-filter.ts");
  assert.match(
    filter,
    /return request\.archived !== true && !request\.parentId && isOnJobsBoard\(request\);/,
    "countsAsWork is right about the Jobs board and must not be weakened to fix a section's board",
  );
  const shell = await read(SHELL);
  assert.match(shell, /return !request\.parentId && !request\.archived && isOnJobsBoard\(request\);/);
});
