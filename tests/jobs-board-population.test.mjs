/**
 * THE JOBS POPULATION — one definition, and every row it counts is drawable.
 *
 * ── THE DEFECT, AS IT WAS FIRST DESCRIBED AND AS IT ACTUALLY WAS ───────────
 *
 * Reported: the Overview counted 98 open jobs, the drill kept the same 98, and
 * the Jobs board drew 82 — "the missing 16 are Pending Approval, at
 * site-unassigned, with no group the board could place them into".
 *
 * Traced, the 16 were not unplaceable jobs. They were Store Documentation
 * register rows ("New store") — request rows placed on the
 * `store-documentation` board, which the Jobs board narrows away on purpose
 * because a store is not a job. The AGGREGATE was wrong: `liveWorkOrderCondition`
 * and the Overview block's own scope counted every live request in the
 * organisation, whichever board it lived on, and the browser's drill and the
 * sidebar badge did the same. So the fix is the population, not the renderer:
 * a job is a live row NOT placed on any board other than the Jobs board.
 *
 * A separate, real render drop was found on the way and is pinned here too: a
 * placement naming a binned or foreign group bucketed its row under an id no
 * drawn group reads, so the row vanished. `drawnGroupId` files such a row where
 * the server files an unplaced one.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const { JOBS_BOARD_KEY, isOnJobsBoard } = await import("../app/lib/job-metrics.ts");
const { drawnGroupId } = await import("../app/(app)/portal/board-group-fallback.ts");
const { readDrillFilter } = await import("../app/(app)/portal/board-drill-filter.ts");

const BASE = "http://localhost:5173";
const headers = { "x-maintsupp-identity": "admin@sunnamusk-uk.test.maintsupp.com", Accept: "application/json" };

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/overview/metrics`, { headers, signal: AbortSignal.timeout(4000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

/* ── The rule, called ─────────────────────────────────────────────────────── */

test("a row belongs to the Jobs population when it is on the Jobs board or on none", () => {
  assert.equal(JOBS_BOARD_KEY, "maintenance");
  assert.equal(isOnJobsBoard({ boardId: "maintenance" }), true, "a job on the Jobs board");
  assert.equal(isOnJobsBoard({ boardId: null }), true, "an unplaced row, which the board files into its stage group");
  assert.equal(isOnJobsBoard({}), true, "a row from a path that sends no placement at all");
  assert.equal(isOnJobsBoard({ boardId: "store-documentation" }), false, "a Store Documentation store is not a job");
  assert.equal(isOnJobsBoard({ boardId: "sec-3369a21ee724" }), false, "a section's row lives on its section");
});

test("the browser constant is the board registry's default board", async () => {
  const registry = await read("app/lib/board-registry.ts");
  assert.match(registry, new RegExp(`export const DEFAULT_BOARD_KEY = "${JOBS_BOARD_KEY}";`));
});

test("the SQL twin makes the same cut, inside the one work-order rule", async () => {
  const filters = await read("app/lib/dashboard-filters.ts");
  const condition = filters.slice(filters.indexOf("export function jobsBoardCondition"));
  assert.match(condition.slice(0, 600), /not exists \(select 1 from \$\{maintenanceGroupItems\}/,
    "correlated `not exists`, never the NULL trapdoor of `not in (select …)`");
  assert.match(condition.slice(0, 600), /\$\{maintenanceGroupItems\.boardId\} <> \$\{sql\.raw\(`'\$\{JOBS_BOARD_KEY\}'`\)\}/,
    "against the shared constant, written in so it binds no variable");
  assert.match(condition.slice(0, 600), /\$\{maintenanceGroupItems\.organisationId\} = \$\{\s*maintenanceRequests\.organisationId\s*\}/,
    "and scoped to the outer row's organisation");

  const live = filters.slice(filters.indexOf("export function liveWorkOrderCondition"));
  assert.match(live.slice(0, 400), /jobsBoardCondition\(\),/, "every dashboard aggregate inherits it");

  /* The Overview block used to RESTATE the three exclusions, which is exactly
     how a fourth gets added in one place and missed in the other. */
  const overview = await read("app/lib/overview-metrics.ts");
  const scope = overview.slice(overview.indexOf("export function dashboardJobScope"));
  assert.match(scope.slice(0, 300), /const base = liveWorkOrderCondition\(orgId\);/);
  assert.doesNotMatch(overview, /function jobScope\(/, "no private restatement of the rule survives");
});

test("the drill and the sidebar badge apply the same cut in the browser", async () => {
  const drill = await read("app/(app)/portal/board-drill-filter.ts");
  assert.match(drill, /return request\.archived !== true && !request\.parentId && isOnJobsBoard\(request\);/);
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /return !request\.parentId && !request\.archived && isOnJobsBoard\(request\);/);
  const feed = await read("app/api/maintenance/route.ts");
  assert.match(feed, /boardId: boardByRequest\.get\(row\.id\) \?\? null,/, "the feed says where each row lives");
});

test("a drill never selects a row that lives on another board", () => {
  const rows = [
    { id: "job", status: "New", stage: "Incoming", boardId: "maintenance", siteId: "s1" },
    { id: "unplaced", status: "New", stage: "Incoming", boardId: null, siteId: "s1" },
    { id: "store", status: "Pending Approval", stage: "Incoming", boardId: "store-documentation", siteId: "site-unassigned" },
    { id: "section", status: "New", stage: "Incoming", boardId: "sec-abc", siteId: "s1" },
  ];
  const filter = readDrillFilter(new URLSearchParams("family=open"), new Date("2026-09-11T10:00:00Z"));
  assert.deepEqual(rows.filter((row) => filter.matches(row)).map((row) => row.id), ["job", "unplaced"]);
});

/* ── The render fallback, called ──────────────────────────────────────────── */

const GROUPS = [
  { id: "g-incoming", stageKey: "Incoming" },
  { id: "g-progress", stageKey: "In Progress" },
  { id: "g-done", stageKey: null },
];

test("an ordinary grouped row stays in its own group", () => {
  assert.equal(drawnGroupId("g-progress", "Incoming", GROUPS), "g-progress",
    "the placement wins over the stage when its group is drawn");
});

test("a row whose group the board no longer draws is filed, never dropped", () => {
  /* A binned group, another board's group, and an id that names nothing. */
  for (const stale of ["g-binned", "other-board-group", "group-does-not-exist"]) {
    assert.equal(drawnGroupId(stale, "In Progress", GROUPS), "g-progress", `${stale}: filed by its stage`);
    assert.equal(drawnGroupId(stale, "Some new status stage", GROUPS), "g-incoming",
      `${stale}: an unknown stage falls to the first group`);
  }
});

test("an unplaced row is filed exactly as the server files it", () => {
  assert.equal(drawnGroupId(undefined, "In Progress", GROUPS), "g-progress");
  assert.equal(drawnGroupId(null, "Incoming", GROUPS), "g-incoming");
  assert.equal(drawnGroupId("", "Nope", GROUPS), "g-incoming");
});

test("every row lands in exactly one drawn group — no drops, no duplicates", () => {
  const drawn = new Set(GROUPS.map((group) => group.id));
  const rows = [
    ["a", "g-incoming", "Incoming"],
    ["b", "g-binned", "In Progress"],
    ["c", undefined, "Completed"],
    ["d", "elsewhere", undefined],
  ];
  const buckets = new Map();
  for (const [id, placed, stage] of rows) {
    const group = drawnGroupId(placed, stage, GROUPS);
    assert.ok(drawn.has(group), `${id} is filed into a group the board draws`);
    buckets.set(group, [...(buckets.get(group) ?? []), id]);
  }
  const filed = [...buckets.values()].flat();
  assert.equal(filed.length, rows.length, "nothing dropped");
  assert.equal(new Set(filed).size, rows.length, "nothing drawn twice");
});

test("with no groups at all there is nothing to file into, and nothing is invented", () => {
  assert.equal(drawnGroupId("g-anything", "Incoming", []), undefined);
});

test("the board routes BOTH of its bucketing sites through the fallback", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  const uses = board.match(/drawnGroupId\(placement\.get\(request\.id\)\?\.groupId, request\.stage, groups\)/g) ?? [];
  assert.equal(uses.length, 2, "groupedRows and groupForRequest — the drawing and the row's drawn group");
  const grouped = board.slice(board.indexOf("const groupedRows = useMemo"), board.indexOf("const groupRows = (groupId"));
  assert.doesNotMatch(grouped, /placement\.get\(request\.id\)\?\.groupId \?\?/,
    "the bucketing no longer trusts a stale group id");
  /*
   * The ONE raw lookup that remains is deliberate: `moveItem`'s SOURCE is the
   * stored placement, because that is the group the server re-indexes. For a
   * row drawn by the fallback it differs from the drawn group, so dragging the
   * row even within its drawn group is a real move — which re-files it and
   * repairs the stale id.
   */
  const rawLookups = board.match(/placement\.get\(request\.id\)\?\.groupId \?\?/g) ?? [];
  assert.equal(rawLookups.length, 1);
  assert.match(board, /const sourceGroupId =\s*placement\.get\(request\.id\)\?\.groupId \?\? groupForRequest\(request\);/);
  /* The rendering writes nothing: the helper has no import to write with. */
  const helper = await read("app/(app)/portal/board-group-fallback.ts");
  assert.doesNotMatch(helper, /^import /m, "the fallback is pure");
});

test("no write path can file a row into a group its board does not draw", async () => {
  /*
   * Reproduced before the fix, on a marked QA row: `move_items` into a Store
   * Documentation group answered 200 and the job left the Jobs board. The
   * target lookup checked the organisation alone; so did the group DELETE's
   * `moveTo`. Both now require a live group on the same board.
   */
  const route = await read("app/api/board/route.ts");
  const moveItems = route.slice(route.indexOf('if (action === "move_items" || action === "archive_items")'));
  assert.match(moveItems.slice(0, 2400), /eq\(maintenanceGroups\.boardId, boardId\),\s*isNull\(maintenanceGroups\.deletedAt\),/,
    "move_items accepts only a live group on this board");
  const groups = await read("app/api/board/groups/route.ts");
  assert.match(groups, /eq\(maintenanceGroups\.id, moveTo\),[\s\S]{0,200}eq\(maintenanceGroups\.boardId, existing\.boardId\),\s*isNull\(maintenanceGroups\.deletedAt\),/,
    "a deleted group's rows can only be re-parented onto a live group of the same board");
  assert.match(groups, /if \(!destination \|\| moveTo === id\)/);
});

/* ── Against the running estate ───────────────────────────────────────────── */

test("every open job the Overview counts is a row the Jobs board draws", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const metrics = await (await fetch(`${BASE}/api/overview/metrics`, { headers })).json();
  const feed = (await (await fetch(`${BASE}/api/maintenance?limit=2000`, { headers })).json()).requests ?? [];
  const board = await (await fetch(`${BASE}/api/board?board=maintenance`, { headers })).json();

  assert.ok(feed.every((row) => "boardId" in row), "the feed carries each row's placement");

  const drill = readDrillFilter(new URLSearchParams("family=open"), new Date());
  const selected = feed.filter((row) => drill.matches(row));
  assert.equal(selected.length, metrics.openJobs,
    `the drill selects ${selected.length} where the Overview counts ${metrics.openJobs}`);

  const placements = new Map((board.items ?? []).map((item) => [item.requestId, item.groupId]));
  const groups = board.groups ?? [];
  const drawable = selected.filter((row) => {
    if (!placements.has(row.id) && row.boardId) return false;
    return Boolean(drawnGroupId(placements.get(row.id), row.stage, groups));
  });
  assert.equal(drawable.length, selected.length,
    "supplied equals drawable: every counted open job has a group on the Jobs board");
  assert.deepEqual(metrics.reconciliation, [], "and the block's own identities still hold");
});
