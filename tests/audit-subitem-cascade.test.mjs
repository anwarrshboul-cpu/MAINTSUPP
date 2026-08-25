/**
 * Audit D2-1 (P1) — a subitem goes where its parent goes.
 *
 * `sendJobsToBin` binned exactly the ids it was handed and never looked at
 * `parent_id`. Every child of a deleted job therefore stayed LIVE, and
 * invisible: a subitem is only drawn underneath a parent row that no longer
 * rendered. The row was on no board, in no bin, unreachable by search, and
 * still counted by `/api/maintenance`, so it went on feeding the Overview's
 * meters. Purging the parent stranded it for ever behind a dangling
 * `parent_id`.
 *
 * The children are folded into the id set at the top of the bin operation so
 * they travel the SAME path a parent does — placement lifted into their own
 * bin entry, then deleted — which is the asymmetry this file's header exists
 * to explain. Restoring the parent brings back the children that carry its
 * `deleted_at`; restoring a child on its own while the parent is still binned
 * is refused, because that recreates the same orphan from the other side; and
 * purging a job purges what hangs off it.
 *
 * Proven end to end against the running server (parent + two subitems: bin →
 * 0 live, 3 bin entries; child restore → 409; parent restore → all three back
 * and still attached; purge → nothing stranded). Pinned here.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

test("binning a job folds its live subitems into the same operation", async () => {
  const source = await read("app/lib/recycle-bin.ts");
  const fn = source.slice(
    source.indexOf("export async function sendJobsToBin"),
    source.indexOf("/** Soft-delete one board group"),
  );
  assert.ok(
    fn.includes("inArray(maintenanceRequests.parentId, requestIds)"),
    "the children of the ids being binned have to be found",
  );
  assert.ok(
    fn.includes("isNull(maintenanceRequests.deletedAt)"),
    "only live children — one already in the bin keeps its own entry",
  );
  assert.ok(
    fn.includes("chunkIds(withChildren)"),
    "the loop must walk the EXPANDED set, or the children are found and then ignored",
  );
});

test("a child is binned through the same path as a parent, so its placement is snapshotted", async () => {
  const source = await read("app/lib/recycle-bin.ts");
  const fn = source.slice(
    source.indexOf("export async function sendJobsToBin"),
    source.indexOf("/** Soft-delete one board group"),
  );
  // The whole point of folding them in at the top rather than soft-deleting
  // them separately: one code path, so a child cannot keep a placement that
  // the board reads which do not filter deleted_at would still join through.
  const placementLift = fn.indexOf("The placement, read BEFORE it is deleted");
  const expansion = fn.indexOf("withChildren");
  assert.ok(expansion > 0 && placementLift > expansion,
    "children must be folded in before the placement snapshot, not after");
});

test("restoring a job brings back the subitems that went down with it", async () => {
  const source = await read("app/lib/recycle-bin.ts");
  const fn = source.slice(source.indexOf("async function restoreJob"));
  assert.ok(
    fn.includes("eq(maintenanceRequests.parentId, entry.entityId)"),
    "the children of the restored job have to be found",
  );
  assert.ok(
    fn.includes("eq(maintenanceRequests.deletedAt, job.deletedAt)"),
    "matched on the parent's own stamp — a child deleted separately stays binned",
  );
  assert.ok(
    fn.includes("target: maintenanceGroupItems.requestId"),
    "a restored child needs its placement back or it is invisible again",
  );
});

test("a subitem cannot be restored while its parent is still in the bin", async () => {
  const source = await read("app/lib/recycle-bin.ts");
  const fn = source.slice(source.indexOf("async function restoreJob"));
  assert.ok(fn.includes("if (job.parentId) {"), "the guard must exist");
  assert.match(
    fn,
    /Restore the job and this comes back with it/,
    "and it must say what to do instead",
  );
  assert.ok(
    fn.indexOf("if (job.parentId) {") < fn.indexOf("const placement = parsePlacement"),
    "refuse before doing any restore work",
  );
});

test("purging a job purges what hangs off it", async () => {
  const source = await read("app/api/trash/route.ts");
  const fn = source.slice(
    source.indexOf("async function purgeJob("),
    source.indexOf("async function purgeGroup("),
  );
  assert.ok(
    fn.includes("eq(maintenanceRequests.parentId, requestId)"),
    "the children have to be found before the parent row goes",
  );
  assert.ok(
    fn.includes("purgeJobRow(db, orgId, child.id)"),
    "each child is destroyed the same way the parent is",
  );
  assert.ok(
    fn.includes("eq(recycleBin.entityId, child.id)"),
    "and its bin entry goes, or the bin offers a row that no longer exists",
  );
});
