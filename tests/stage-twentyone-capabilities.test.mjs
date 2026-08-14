import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * Authorisation on the operational routes, not just the admin ones.
 *
 * `scopedDb` answers "whose data is this" — tenant isolation, enforced
 * everywhere. It does not answer "may this role do this", and the two were
 * conflated: every operational write route resolved a scoped database and then
 * wrote. The admin routes were never affected, because they go through
 * `admin-context.ts`, which resolves permissions.
 *
 * The gap was demonstrated against a running server before it was closed. A
 * `client` identity — whose built-in capabilities are `board.view` and
 * `data.export`, nothing else — POSTed /api/board/groups and was answered 201,
 * and the group appeared on the board. /api/sites answered 400 "A site name is
 * required", which is a validation error: authorisation had already passed.
 *
 * After the fix the same three calls answer 403 with the capability named,
 * while the owner's identical call still returns 201 and a plain GET of the
 * board still returns 200.
 */

/** Route → the capability its write verbs must require. */
const GUARDED = {
  "app/api/board/route.ts": "board.edit",
  "app/api/board/groups/route.ts": "board.edit",
  "app/api/board/columns/route.ts": "board.edit",
  "app/api/board/items/route.ts": "board.edit",
  "app/api/board/views/route.ts": "board.edit",
  "app/api/board/links/route.ts": "board.edit",
  "app/api/options/route.ts": "board.edit",
  "app/api/sites/route.ts": "sites.edit",
  "app/api/sites/groups/route.ts": "sites.edit",
  "app/api/units/route.ts": "sites.edit",
  "app/api/import/route.ts": "data.import",
};

test("every operational write route demands a capability", async () => {
  for (const [file, capability] of Object.entries(GUARDED)) {
    const source = await read(file);
    assert.match(
      source,
      new RegExp(`scopedDbWithCapability\\(request, "${capability}"\\)`),
      `${file} must require "${capability}" on its write verbs`,
    );
  }
});

test("a denied capability short-circuits before anything is written", async () => {
  for (const file of Object.keys(GUARDED)) {
    const source = await read(file);
    // The refusal has to be returned, not merely computed. A guard whose result
    // is ignored reads exactly like one that works.
    assert.match(
      source,
      /if \(guard\.denied\) return guard\.denied;/,
      `${file} must return the refusal`,
    );
  }
});

test("every write verb in a guarded route is behind the guard", async () => {
  /*
   * Counted rather than spot-checked.
   *
   * A route with POST, PATCH and DELETE needs three guards; guarding two of
   * them leaves a hole that a "does the file mention the helper" test would
   * happily pass. The counts are compared directly, so adding a fourth write
   * verb without a guard fails here.
   */
  for (const file of Object.keys(GUARDED)) {
    const source = await read(file);
    /*
     * Counted PER HANDLER, not per file.
     *
     * This compared a file's guard count against its write-verb count, which
     * worked only while reads were ungated. `board.view` now gates GET on the
     * board and the job list — a strengthening — and a whole-file count reads
     * that as one guard too many. Attributing each guard to the handler it
     * sits in keeps the original property, which is that no write verb is
     * missing one, and stops a legitimate read guard registering as a fault.
     */
    const handlers = [
      ...source.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\(/g),
    ];
    for (const [index, match] of handlers.entries()) {
      const verb = match[1];
      if (!["POST", "PATCH", "PUT", "DELETE"].includes(verb)) continue;
      const body = source.slice(
        match.index,
        handlers[index + 1]?.index ?? source.length,
      );
      assert.match(
        body,
        /scopedDbWithCapability\(request,|requireCapability\(/,
        `${file}'s ${verb} is not behind a capability guard`,
      );
    }
  }
});

test("the helper checks the capability against the resolved scope", async () => {
  const source = await read("app/lib/tenant-db.ts");

  assert.match(source, /export async function scopedDbWithCapability/);
  // Permissions are resolved for the organisation the scope landed on, not for
  // one named by the request — otherwise the capability check could be pointed
  // at a workspace whose overrides are more generous.
  assert.match(
    source,
    /resolvePermissions\(scope\.db, scope\.orgId, scope\.actor\.role\)/,
  );
  assert.match(source, /requireCapability\(subject, capability\)/);
});

test("a read-only verb is not gated by an edit capability", async () => {
  /*
   * GET must stay open to `board.view`.
   *
   * The point of the original fix is that a client can still read their own
   * boards — that is the capability they hold. A GET that picked up a
   * `board.edit` guard would lock clients out of the product rather than out
   * of the write path.
   *
   * The check reads the capability NAME rather than the helper. It used to
   * refuse `scopedDbWithCapability` outright in a GET, which was a fair
   * approximation while every capability guard was a write guard — and became
   * wrong the moment `board.view` started deciding something. Refusing the
   * helper would now mean refusing to enforce the very capability this test is
   * named after.
   */
  const EDIT_CAPABILITIES = /"(board\.edit|sites\.edit|settings\.edit|roles\.edit|users\.edit|teams\.manage|data\.import|data\.delete)"/;

  for (const file of ["app/api/board/route.ts", "app/api/sites/route.ts"]) {
    const source = await read(file);
    const getStart = source.indexOf("export async function GET(");
    assert.ok(getStart > 0, `${file} must still have a GET`);
    const nextExport = source.indexOf("export async function ", getStart + 10);
    const body = source.slice(getStart, nextExport === -1 ? undefined : nextExport);
    const guarded = [...body.matchAll(/scopedDbWithCapability\(request, ("[a-z_.]+")\)/g)];
    for (const [, capability] of guarded) {
      assert.doesNotMatch(
        capability,
        EDIT_CAPABILITIES,
        `${file}'s GET must not require ${capability} — reading is not editing`,
      );
    }
  }
});
