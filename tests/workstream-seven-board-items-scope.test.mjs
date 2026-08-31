import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

/**
 * `GET /api/board/items?board=…` answers for the board it was asked about.
 *
 * WHAT WAS WRONG. The handler resolved the board and then threw the answer
 * away. `resolveBoard` ran, validated `?board=` and 404ed an unknown key — and
 * its result reached the response envelope and NOTHING else. The `conditions`
 * array was `[organisationId, deletedAt IS NULL]` plus `archived`, and the
 * select read `maintenance_requests` with no board restriction at all, which it
 * could not have had: there is no board column on that table. Placement is what
 * decides a request's board.
 *
 * So `?board=store-documentation` returned the organisation's ENTIRE job list —
 * 44 maintenance jobs on this development workspace against 2 documentation
 * rows — and every alternative view built on this route (kanban, calendar,
 * chart, gallery) drew the maintenance board's rows while claiming to draw the
 * documentation board's. The organisation filter was intact throughout, so this
 * was never a tenant leak. It is worse in one narrow respect: an error is
 * obvious and plausible wrong data is not.
 *
 * WHAT THIS ASSERTS, AND WHY IT IS TWO THINGS RATHER THAN ONE.
 *
 *  1. The two boards' answers are DISJOINT. A request holds exactly one
 *     placement across the whole workspace — `maintenance_group_items.request_id`
 *     is the primary key — so no id may appear under two boards.
 *  2. The documentation answer is NOT A SUPERSET of the maintenance answer.
 *     Disjointness alone would be satisfied by returning nothing, and an empty
 *     answer is the other way to fail this route. This is the assertion that
 *     actually fails against the bug: before the fix both answers were the same
 *     44 ids, so the documentation answer contained every maintenance id.
 *
 * A third rule — an UNPLACED request belongs in no board's answer — is real and
 * is satisfied by construction, but it is asserted against the SOURCE rather
 * than against the server. See the note in the body for why observing it is a
 * race.
 *
 * The fixtures are built rather than borrowed. Both boards' real contents are
 * whatever the development database happens to hold; a test that read them
 * would assert a number rather than a rule, and would pass or fail on what
 * somebody else left behind. One item per board names the rule directly.
 *
 * The source assertion runs everywhere. The behavioural test needs a dev server
 * and skips without one, the bargain the rest of this suite already makes.
 * Fixtures are hard-deleted in `after()` — the board bins an item rather than
 * deleting it, so a fixture removed through the product would survive its own
 * cleanup and sit in the recycle bin for thirty days.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const MAINTENANCE_BOARD = "maintenance";
const DOCUMENTATION_BOARD = "store-documentation";

// Found rather than assumed — vite takes the first free port from 5173 up.
const CANDIDATES = process.env.MAINTSUPP_BASE_URL
  ? [process.env.MAINTSUPP_BASE_URL]
  : [3000, 5173, 5174, 5175, 5176, 5177].map((port) => `http://localhost:${port}`);
let BASE_URL = CANDIDATES[0];

const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/** A marker every fixture carries, so a stray row is traceable to this run. */
const RUN = `w7scope-${Date.now().toString(36)}`;

/** Every request id this file created, for `after()`. */
const created = [];

/*
 * Found once and remembered, with a generous timeout.
 *
 * `/api/context` on a cold vite dev server behind several concurrent callers
 * takes well over the 4 s the rest of this suite allows, and a probe that times
 * out reads as "no server" and skips a test that would have passed. Skipping is
 * the worse failure of the two: a red test gets looked at and a silently
 * skipped one does not.
 */
let serverFound = null;
async function serverIsUp() {
  if (serverFound !== null) return serverFound;
  for (const candidate of CANDIDATES) {
    try {
      const response = await fetch(`${candidate}/api/context`, { signal: AbortSignal.timeout(20000) });
      if (response.ok) {
        BASE_URL = candidate;
        serverFound = true;
        return true;
      }
    } catch {
      // Next candidate.
    }
  }
  serverFound = false;
  return false;
}

let cookie = null;
async function signIn() {
  if (cookie !== null) return cookie;
  try {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    cookie = response.ok
      ? (response.headers.getSetCookie?.() ?? []).map((raw) => raw.split(";")[0]).join("; ")
      : "";
  } catch {
    cookie = "";
  }
  return cookie;
}

async function api(method, path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      cookie,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { raw };
  }
  return { status: response.status, body: parsed };
}

/** The first live group on a board, so no group id is hard-coded. */
async function firstGroupOf(board) {
  const { status, body } = await api("GET", `/api/board?board=${board}`);
  assert.equal(status, 200, `GET /api/board?board=${board} answered ${status}`);
  const group = (body.groups ?? []).find((entry) => !entry.deletedAt && !entry.archived);
  assert.ok(group, `board ${board} has no usable group to file a fixture into`);
  return group.id;
}

/** One item, created through the product's own create endpoint. */
async function createItem(board, title, groupId) {
  const { status, body } = await api("POST", "/api/board/items", {
    board,
    title,
    ...(groupId ? { groupId } : {}),
  });
  assert.equal(status, 201, `create on ${board} answered ${status}: ${JSON.stringify(body)}`);
  assert.ok(body.id, "create returned no id");
  created.push(body.id);
  return body.id;
}

/** Every item id this route reports for one board, paging to the cap. */
async function itemIdsFor(board) {
  const { status, body } = await api("GET", `/api/board/items?board=${board}&limit=500`);
  assert.equal(status, 200, `GET /api/board/items?board=${board} answered ${status}`);
  assert.equal(body.board?.key, board, "the envelope named a different board");
  return (body.items ?? []).map((item) => item.id);
}

test("the resolved board reaches the query, not only the response envelope", async () => {
  const source = await read("app/api/board/items/route.ts");
  const get = source.slice(source.indexOf("export async function GET"), source.indexOf("export async function POST"));

  assert.match(
    get,
    /resolveBoard\(/,
    "GET no longer resolves the board at all",
  );
  /*
   * The narrow shape of the defect: `board` used once, in the envelope. Two
   * uses is the minimum a scoped read can have — resolve, then filter.
   */
  const boardUses = get.match(/\bboard\b(?!Id|Key|Column|s\b)/g) ?? [];
  assert.ok(
    boardUses.length >= 2,
    "the resolved board is still used exactly once — the envelope — and never in the query",
  );
  assert.match(
    get,
    /maintenanceGroupItems\.boardId/,
    "the item read does not filter through the placement's board_id",
  );
  assert.match(
    get,
    /eq\(maintenanceGroupItems\.boardId,\s*board\.key\)/,
    "the placement filter does not use the board the caller asked for",
  );
  /*
   * The filter has to be part of `conditions`, which is applied BEFORE
   * `.limit()`. Filtering the page after it was cut would hand back short
   * pages and a `nextCursor` that skips rows.
   */
  const conditions = get.slice(get.indexOf("const conditions = ["), get.indexOf("const rows ="));
  assert.match(
    conditions,
    /maintenanceGroupItems\.boardId/,
    "the board filter is applied after the limit, so a page is not a page of this board",
  );
});

test("a board's items are only that board's items", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server on any candidate port");
    return;
  }
  if (!(await signIn())) {
    t.skip("could not sign in to the development server");
    return;
  }

  const documentationGroup = await firstGroupOf(DOCUMENTATION_BOARD);
  const maintenanceGroup = await firstGroupOf(MAINTENANCE_BOARD);

  const onDocumentation = await createItem(
    DOCUMENTATION_BOARD,
    `${RUN} documentation row`,
    documentationGroup,
  );
  const onMaintenance = await createItem(
    MAINTENANCE_BOARD,
    `${RUN} maintenance job`,
    maintenanceGroup,
  );
  /*
   * NO UNPLACED FIXTURE, AND THE REASON IS WORTH RECORDING.
   *
   * `POST /api/board/items` writes a placement only when a `groupId` is sent, so
   * an unplaced request is reachable — and the filter this test defends excludes
   * it by construction, which is correct: its board is undefined. But the state
   * does not survive being observed. `ensureBoardState` in
   * app/api/board/route.ts HEALS unplaced requests by inserting a placement onto
   * whichever board is being loaded, so ANY concurrent `/api/board` request —
   * another tab, another test, a second developer — files the fixture before
   * this test can read it, and the assertion fails for a reason that has nothing
   * to do with the defect. Measured: it passed alone and failed in a parallel
   * run.
   *
   * The rule is asserted where it is deterministic instead: the source test
   * above pins the placement subquery, and a request with no placement row
   * cannot satisfy it.
   */
  const documentationIds = await itemIdsFor(DOCUMENTATION_BOARD);
  const maintenanceIds = await itemIdsFor(MAINTENANCE_BOARD);

  // Each fixture answers for its own board and no other.
  assert.ok(
    documentationIds.includes(onDocumentation),
    "the documentation board does not report the row filed onto it",
  );
  assert.ok(
    !maintenanceIds.includes(onDocumentation),
    "the maintenance board reports a documentation row",
  );
  assert.ok(
    maintenanceIds.includes(onMaintenance),
    "the maintenance board does not report the job filed onto it",
  );
  assert.ok(
    !documentationIds.includes(onMaintenance),
    "the documentation board reports a maintenance job",
  );

  // 1. Disjoint. One placement per request, so no id may sit under two boards.
  const overlap = documentationIds.filter((id) => maintenanceIds.includes(id));
  assert.deepEqual(
    overlap,
    [],
    `${overlap.length} id(s) were reported by both boards: ${overlap.slice(0, 5).join(", ")}`,
  );

  // 2. Not a superset. This is the assertion the bug actually failed: before
  //    the fix both answers were the same list, so every maintenance id was
  //    also a documentation id.
  const maintenanceOnly = maintenanceIds.filter((id) => !documentationIds.includes(id));
  assert.ok(
    maintenanceOnly.length > 0,
    "the documentation answer contains every maintenance id — `?board=` is decorative",
  );
});

test("a batch save counts the rows it wrote, not the ids it was handed", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server on any candidate port");
    return;
  }
  if (!(await signIn())) {
    t.skip("could not sign in to the development server");
    return;
  }

  const group = await firstGroupOf(DOCUMENTATION_BOARD);
  const real = await createItem(DOCUMENTATION_BOARD, `${RUN} batch fixture`, group);
  /*
   * An id that names nothing, which is the cheap half of the defect. The
   * expensive half is an id belonging to ANOTHER organisation: the UPDATE's
   * `organisationId` predicate refuses both identically, and only the second
   * needs a second tenant's row to demonstrate. They travel the same code path,
   * so the reachable one is the one asserted.
   */
  const foreign = "MN-DOES-NOT-EXIST";

  const patch = (itemIds) =>
    api("PATCH", "/api/board/items", {
      board: DOCUMENTATION_BOARD,
      itemIds,
      status: "Pending Approval",
    });

  const nothing = await patch([foreign]);
  assert.equal(nothing.status, 200, "a batch naming nothing is not an error");
  assert.equal(
    nothing.body.updated,
    0,
    "a PATCH that wrote no row reported it as saved — the answer, not the write, is the defect",
  );

  const one = await patch([real]);
  assert.equal(one.body.updated, 1, "a PATCH that wrote one row must say one");

  const mixed = await patch([real, foreign]);
  assert.equal(
    mixed.body.updated,
    1,
    "a mixed batch reported every id it was handed as saved",
  );
});

test("activity follows the rows that changed, not the ids that were sent", async () => {
  const source = await read("app/api/board/items/route.ts");
  const patch = source.slice(source.indexOf("export async function PATCH"), source.indexOf("export async function DELETE"));
  const batch = patch.slice(patch.indexOf("const afterRows"));

  assert.doesNotMatch(
    batch,
    /for \(const itemId of itemIds\) \{\s*await recordActivity\(/,
    "item_activity is still written for ids the organisation-scoped UPDATE refused",
  );
  assert.match(
    batch,
    /for \(const row of afterRows\) \{\s*await recordActivity\(/,
    "the audit trail does not follow `afterRows`",
  );
  assert.match(
    batch,
    /updated: afterRows\.length/,
    "the batch reply still counts the ids it was handed",
  );
});

/**
 * Hard-deleted, in dependency order.
 *
 * Deleting through the product moves an item to the recycle bin, where it would
 * outlive this run by thirty days and be counted by whatever reads the bin next.
 */
after(async () => {
  if (!created.length) return;
  let db = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
    const file = (await readdir(directory)).find(
      (entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite",
    );
    if (!file) return;
    // `fileURLToPath`, not `URL.pathname`: this repo's path has a space in it,
    // and a percent-encoded path opens nothing.
    db = new DatabaseSync(fileURLToPath(new URL(file, directory)));
  } catch {
    return;
  }

  try {
    try {
      db.exec("PRAGMA busy_timeout = 15000");
    } catch {
      // An older binding without the pragma still gets the retry below.
    }
    for (const id of created) {
      for (const statement of [
        "DELETE FROM maintenance_board_cells WHERE request_id = ?",
        "DELETE FROM maintenance_group_items WHERE request_id = ?",
        "DELETE FROM item_activity WHERE request_id = ?",
        "DELETE FROM activity_log WHERE entity_type = 'maintenance_request' AND entity_id = ?",
        "DELETE FROM maintenance_requests WHERE id = ?",
      ]) {
        let lastError = null;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            db.prepare(statement).run(id);
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            // A table this build does not have is not a cleanup failure; a lock is.
            if (!/lock|busy/i.test(String(error?.message ?? error))) {
              lastError = null;
              break;
            }
            const until = Date.now() + 200 * (attempt + 1);
            while (Date.now() < until) {
              // `after()` is synchronous enough that a timer would not be awaited.
            }
          }
        }
        if (lastError) {
          console.warn(`fixture cleanup could not run "${statement}" for ${id}: ${lastError.message}`);
        }
      }
      const left = db.prepare("SELECT count(*) AS n FROM maintenance_requests WHERE id = ?").get(id);
      if (left?.n) console.warn(`fixture item ${id} survived cleanup and must be removed by hand`);
    }
  } finally {
    try {
      db.close();
    } catch {
      // The handle is going out of scope regardless.
    }
  }
});
