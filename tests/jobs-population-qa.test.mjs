/**
 * QA 2026-10-01, Jobs / Planned: three places that counted or drew rows that
 * are not jobs, or another client's lanes.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the calendar draws jobs only, and the Jobs meters skip subitems", async () => {
  const calendar = await read("app/(app)/portal/calendar-surface.tsx");
  assert.match(calendar, /\.filter\(\(request\) => isOnJobsBoard\(request\) && !request\.parentId\)/);
  const meters = await read("app/(app)/portal/dashboard-meters.ts");
  assert.match(meters, /const requests = allRequests\.filter\(\(request\) => !request\.parentId\);/);
});

test("the loading board shows the four stage lanes, not a customer's store lanes", async () => {
  const model = await read("app/(app)/portal/board-model.ts");
  assert.match(model, /\.filter\(\(group\) => group\.key in FALLBACK_STAGE_BY_GROUP_KEY\)/);
});

test("the CSV Group column exports the group's name, not the stage key", async () => {
  const csv = await read("app/lib/board-csv.ts");
  assert.match(csv, /case "move":[\s\S]{0,400}return input\.groupNames\?\.\[request\.id\] \?\? request\.stage;/);
  const route = await read("app/api/board/csv/route.ts");
  assert.match(route, /innerJoin\(maintenanceGroups, eq\(maintenanceGroups\.id, maintenanceGroupItems\.groupId\)\)/);
  assert.match(route, /groupNames,\s*boardId: board\.key,/);
});

/* Owner decision 2026-10-01: one name per job. Verified live: a grid rename
   sets title, and a later description edit leaves it alone. */
test("a job has one name: a rename sets the title, a description edit never does", async () => {
  const board = await read("app/api/board/route.ts");
  assert.match(board, /if \(column\.system && column\.key === "name" && after && after\.trim\(\)\) \{\s*await db\s*\.update\(maintenanceRequests\)\s*\.set\(\{ title: after\.trim\(\)\.slice\(0, 200\)/);
  const fields = await read("app/lib/request-fields.ts");
  assert.doesNotMatch(fields, /values\.title = requestTitle\(description/);
});
