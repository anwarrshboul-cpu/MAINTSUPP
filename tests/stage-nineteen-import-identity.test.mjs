import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * What an imported row is matched on.
 *
 * THE BUG THESE LOCK
 *
 * `commit()` matched a row in the file to a row already in the database by its
 * lowercased title. Store Documentation never showed the fault, because store
 * names are unique. The Maintenance board is not like that: monday names every
 * form submission "Incoming form answer", so 732 of its 744 items share 20
 * names between them. A 744-row import therefore folded 713 distinct jobs onto
 * whichever rows happened to be there first and reported it as
 * "created 31, updated 713" — a success message for having lost 96% of the
 * board. The row count read 41.
 *
 * The fix is an explicit identity: monday's item id, stored on
 * `maintenance_requests.external_id` and matched before the title.
 */

test("an imported row carries the identity it came with", async () => {
  const schema = await read("db/schema.ts");
  assert.match(
    schema,
    /externalId: text\("external_id"\)/,
    "the source system's row id must be stored, or a re-import has nothing stable to match on",
  );

  // Runtime DDL, not just the Drizzle schema: migrations do not run on the
  // bootstrap path, so a column that exists only in schema.ts is a column the
  // running database does not have.
  const init = await read("db/init.ts");
  assert.match(init, /ensureImportIdentity/);
  assert.match(init, /addColumn\(d1, "maintenance_requests", "external_id", "TEXT"\)/);
  assert.match(init, /maintenance_requests_external_idx/);
});

test("the importer reads monday's item id and keeps it out of the board", async () => {
  const importer = await read("app/lib/monday-import.ts");

  assert.match(importer, /export const EXTERNAL_ID_KEY/);
  // Prefixed so it can never collide with a board column key.
  assert.match(
    importer,
    /EXTERNAL_ID_KEY = "__externalId"/,
    "the identity must sit outside the board's key space",
  );
  assert.match(importer, /"item id": EXTERNAL_ID_KEY/);

  // It is an identity, not a column: nothing should render it as a cell.
  const spec = await read("db/monday-board-spec.ts");
  assert.ok(
    !spec.includes("__externalId"),
    "the item id is the row's identity, not a column on the board",
  );
});

test("matching prefers the identity and never falls back past it", async () => {
  const route = await read("app/api/import/route.ts");

  assert.match(route, /itemByExternalId/);
  assert.match(
    route,
    /const existingId = externalId\s*\n?\s*\? itemByExternalId\.get\(externalId\)\s*\n?\s*: itemByTitle\.get\(name\.toLowerCase\(\)\)/,
    "an export carrying ids must match on them alone — falling through to the title would merge a new job into an unrelated row sharing monday's default name",
  );

  // Title matching stays for older exports that carry no id, so a file exported
  // before this still updates rather than duplicating.
  assert.match(route, /itemByTitle/);
});

test("a row matched by title is given an identity for next time", async () => {
  const route = await read("app/api/import/route.ts");
  const commit = route.slice(route.indexOf("async function commit"));
  assert.match(
    commit,
    /\.\.\.\(externalId && !itemByExternalId\.has\(externalId\) \? \{ externalId \} : \{\}\)/,
    "a row imported before identities existed must acquire one, or it is matched by title forever",
  );
});

test("a re-import refreshes the row, not just its cells", async () => {
  const route = await read("app/api/import/route.ts");
  const commit = route.slice(route.indexOf("async function commit"));

  // Writing only cells left status, stage and every date frozen at whatever the
  // first import guessed — which is how 744 jobs came to be stamped "requested
  // today" with no completion dates and a stage of Incoming.
  assert.match(commit, /const fields = \{/);
  assert.match(commit, /\.update\(maintenanceRequests\)\s*\n?\s*\.set\(\{\s*\n?\s*\.\.\.fields,/);

  // The dates that make the period selector, the ageing chart and the SLA mean
  // mean anything.
  for (const field of ["completedAt", "dueAt", "requestedAt", "stage"]) {
    assert.ok(commit.includes(field), `${field} must be carried from the export`);
  }

  // A re-run must not restamp a row's raised date to today.
  assert.match(
    commit,
    /\.\.\.\(item\.values\.requested \? \{ requestedAt: item\.values\.requested \} : \{\}\)/,
    "a source with no raised date must leave the existing one alone",
  );
});

test("completion is read from monday's own done flag, not from wording", async () => {
  const route = await read("app/api/import/route.ts");

  // monday has no lifecycle column: a job is finished because its status is
  // flagged done and because it sits in an archive group. The 28 archive groups
  // carry no stage_key, so without this all 672 completed jobs imported as
  // Incoming and the board read 744 open.
  assert.match(route, /const DONE_STATUSES = new Set\(\["Job Completed"\]\)/);
  assert.match(route, /group\?\.stageKey \?\?/, "a group's stage_key must win where it has one");

  // Only the flagged label may be in the set. Statuses like "Completion Invoice
  // Paid" sound final and are NOT flagged done on monday — the set is read off
  // the capture's is_done, not off the wording. Scoped to the set itself so the
  // comment that explains this does not trip its own check.
  const set = route.slice(route.indexOf("const DONE_STATUSES"));
  const members = set.slice(0, set.indexOf("]")).match(/"[^"]+"/g) ?? [];
  assert.deepEqual(
    members,
    ['"Job Completed"'],
    "done-ness comes from monday's is_done flag, not from a status that sounds final",
  );
});

test("the preview warns before an import can collapse", async () => {
  const route = await read("app/api/import/route.ts");

  assert.match(route, /function identityRisk/);
  assert.match(route, /wouldCollapse/);
  assert.match(route, /carriesItemIds/);
  // It has to reach the operator, not just exist.
  assert.match(
    route,
    /identity: identityRisk\(plan\)/,
    "the risk must be in the preview payload — a preview that hides it is why this shipped",
  );
});

test("row order inside a group comes from the file", async () => {
  const route = await read("app/api/import/route.ts");
  const commit = route.slice(route.indexOf("async function commit"));

  assert.match(commit, /positionInGroup/);
  assert.doesNotMatch(
    commit,
    /requestId,\s*\n\s*position: 0,/,
    "writing every placement at position 0 leaves the board in insertion order, not the source board's order",
  );
  // A re-run must restore the source order, not leave a dragged row where it was.
  assert.match(
    commit,
    /set: \{ groupId, position, updatedAt/,
    "a re-import must reset position, or the second run silently disagrees with the first",
  );
});

test("the capture and its build script are kept with the board", async () => {
  // The CSV the importer was fed is reproducible: the script that built it from
  // the monday API sits beside the capture, so the next person can rebuild it
  // rather than guessing what was loaded.
  const script = await read("db/monday-export/build-maintenance-csv.mjs");
  assert.match(script, /Item ID/);
  assert.match(script, /GROUP_ORDER/, "group order must come from the board, not from item order");
  assert.match(
    script,
    /if \(seen\.has\(item\.id\)\) continue;/,
    "paged pulls must be de-duplicated, or a repeated row imports as a second job",
  );

  const capture = await read("db/monday-export/MAINTENANCE-MONDAY-CAPTURE.md");
  assert.match(capture, /1139774521/);
  assert.match(capture, /Nottingham complited/, "monday's own typos are part of the capture");
});
