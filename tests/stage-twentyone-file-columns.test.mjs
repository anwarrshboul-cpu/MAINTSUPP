import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * A file column is validated against its own board.
 *
 * Both upload routes asked whether the target column belonged to the board
 * `"maintenance"`, written as a literal. Store Documentation's twelve file
 * columns — RAMS, the Fire Risk Assessment, PLI, PAT, the electrical
 * certificate and the rest — are on `"store-documentation"`, so every one of
 * them failed that check and the route answered "The file column no longer
 * exists." with a 404. The compliance tracker could not accept a single
 * certificate, which is the one thing it is for.
 *
 * The fix compares against the board the work order is actually placed on. The
 * check itself must stay: a column belonging to some *other* board is still
 * refused, and that is the property the literal was holding. So this asserts
 * both halves — the literal is gone, and the comparison is still made.
 */

const UPLOAD_ROUTES = ["app/api/files/route.ts", "app/api/files/multipart/route.ts"];

test("no upload route pins a file column to the maintenance board", async () => {
  for (const file of UPLOAD_ROUTES) {
    const source = await read(file);
    assert.doesNotMatch(
      source,
      /maintenanceBoardColumns\.boardId,\s*"maintenance"/,
      `${file} must not compare a file column against a hardcoded board`,
    );
  }
});

test("both upload routes still scope a file column to the work order's board", async () => {
  for (const file of UPLOAD_ROUTES) {
    const source = await read(file);
    assert.match(
      source,
      /boardKeyForRequest\(db, orgId, workOrder\.id\)/,
      `${file} must resolve the board from the work order`,
    );
    assert.match(
      source,
      /eq\(maintenanceBoardColumns\.boardId, boardKey\)/,
      `${file} must still refuse a column from another board`,
    );
  }
});

test("boardKeyForRequest reads placement, and falls back to the default board", async () => {
  const source = await read("app/lib/board-registry.ts");

  // Placement is the only thing that ties a row to a board — maintenance_requests
  // carries no board id at all, so a lookup against that table would be silently
  // wrong rather than merely absent.
  assert.match(source, /export async function boardKeyForRequest/);
  assert.match(source, /from\(maintenanceGroupItems\)/);

  /*
   * Read from the placement's own board_id, never through its group.
   *
   * The two can disagree — a Store Documentation row was found pointing at a
   * maintenance group — and `board_id` is the column the board route itself
   * filters on when deciding which rows a board contains. Answering from the
   * group would let the upload check and the board disagree about where a row
   * lives.
   */
  assert.match(source, /boardId: maintenanceGroupItems\.boardId/);
  assert.doesNotMatch(
    source.slice(source.indexOf("export async function boardKeyForRequest")),
    /innerJoin/,
    "board membership must not be resolved through the group",
  );

  // An unplaced row belongs to the default board, which is what the board route
  // assumes when it files an unplaced row into groups[0]. Returning undefined
  // here would make the column check compare against undefined and refuse
  // every upload on a row that has not been placed yet.
  assert.match(source, /placement\?\.boardId \?\? DEFAULT_BOARD_KEY/);
});

test("the tenant scope survives the board comparison", async () => {
  // The board key decides *which* board, never *whose*. Both routes must still
  // carry the organisation predicate, or widening the board check would have
  // widened tenant isolation with it.
  for (const file of UPLOAD_ROUTES) {
    const source = await read(file);
    assert.match(
      source,
      /eq\(maintenanceBoardColumns\.organisationId, orgId\)/,
      `${file} must keep the organisation predicate on the column lookup`,
    );
  }
});

/**
 * The throttle table has to exist on the path every request actually takes.
 *
 * Migrations do not run on the bootstrap path — `db/init.ts` does. A table
 * declared only in `schema.ts` and `drizzle/` is a table the running database
 * does not have, which is precisely how `board_views` came to exist in a
 * migration while every board's tab strip answered 503. A rate limiter that
 * throws on a missing table would fail open on every sign-in.
 */
test("sign_in_failures is created at runtime, not only in a migration", async () => {
  const init = await read("db/init.ts");
  const schema = await read("db/schema.ts");

  assert.match(init, /CREATE TABLE IF NOT EXISTS sign_in_failures/);
  assert.match(init, /CREATE INDEX IF NOT EXISTS sign_in_failures_expiry_idx/);
  assert.match(schema, /sqliteTable\(\s*\n?\s*"sign_in_failures"/);
});

test("the throttle fails open rather than locking everyone out", async () => {
  const session = await read("app/lib/auth-session.ts");

  // A counter write that throws must not take sign-in down with it: the attempt
  // is still refused on its own merits by checkPassword. Losing the count is
  // better than refusing every credential in a working system.
  const record = session.slice(session.indexOf("export async function recordSignInFailure"));
  assert.match(record.slice(0, 3000), /\.catch\(\(\) => \{/);
});

/**
 * A wide row with only its Name filled is an item, not a group heading.
 *
 * `nonEmpty` discards blanks, so `Warehouse 1,,,,,,,,,` reduced to one value
 * and the parser read it as a group name. The item was then not imported, not
 * skipped and not counted — it simply disappeared, and a phantom group took its
 * place. Three real stores went that way and the preview reported 28 items for
 * a 31-row file. The maintenance board hid it because its export carries an
 * Item ID beside every Name, so two cells are always filled.
 */
test("a nearly-empty item row is not mistaken for a group heading", async () => {
  const source = await read("app/lib/monday-import.ts");

  // The row's WIDTH decides, and it is tested before the filled count.
  assert.match(source, /if \(row\.length <= 1 && filled\.length === 1\)/);
  assert.doesNotMatch(
    source,
    /if \(filled\.length === 1\) \{\s*\n\s*pendingGroup/,
    "a lone filled cell must not by itself mean a group heading",
  );
});

/**
 * The upload fork has to sit below the runtime's form-parsing ceiling.
 *
 * `POST /api/files` calls `request.formData()`, and the Workers runtime refuses
 * to parse a form body at or above 1 MiB — answering a bare 413 before any
 * route code runs, so none of this codebase's error messages apply. At the old
 * 4 MB threshold every photograph between 1 MiB and 4 MiB failed to upload
 * from the board, from a job and from a contractor link.
 *
 * Measured, not assumed: 1000 KB returned 201, 1024 KB returned 413, and a
 * 6 MB raw PUT to the multipart route was accepted.
 */
test("the direct upload threshold stays under the form-parsing limit", async () => {
  const source = await read("app/lib/client-upload.ts");
  const match = /const DIRECT_UPLOAD_LIMIT = ([\d *]+);/.exec(source);
  assert.ok(match, "DIRECT_UPLOAD_LIMIT must be declared");

  const limit = Function(`"use strict"; return (${match[1]});`)();
  assert.ok(
    limit < 1024 * 1024,
    `DIRECT_UPLOAD_LIMIT is ${limit}; it must stay below the 1 MiB form-parsing ceiling`,
  );
});
