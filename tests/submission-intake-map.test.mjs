/**
 * FIVE DOORS, ONE INTAKE — and the census that was wrong in both directions.
 *
 * Two source comments in this codebase said there were THREE routes that create
 * a work order, and asked whoever changed one to remember the other two:
 * `app/api/forms/[token]/submit/route.ts` and `app/api/report-job/route.ts`.
 * A sweep of `insert(maintenanceRequests)` found FIVE creators —
 *
 *   1. POST /api/maintenance                session + board.edit
 *   2. POST /api/forms/[token]/submit       share token
 *   3. POST /api/report-job                 anonymous, the public website
 *   4. POST /api/board/items                session + board.edit
 *   5. createBoardItem()                    session AND the automation engine
 *
 * — and "remember the other two" is precisely the arrangement that let three
 * copies of the title rule drift apart, left two doors writing no placement,
 * left three inserting on a raw SQL MAX with no conflict retry, and left one
 * with no `tier`, `due_at` or `next_update_at` at all.
 *
 * This file pins that they now all go through
 * `app/lib/submission-service.ts`, and pins each of the specific defects the
 * unification closed so none can come back one door at a time.
 *
 * It reads source text rather than driving a server, so it runs on a quiet tree
 * and cannot be starved. Reads normalise CRLF — line endings here are PER FILE.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");
/** Comments explain the defects at length; assertions must see only the code. */
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const DOORS = [
  ["app/api/maintenance/route.ts", "the authenticated raise-a-job endpoint"],
  ["app/api/report-job/route.ts", "the public website form"],
  ["app/api/forms/[token]/submit/route.ts", "a shared form link"],
  ["app/api/board/items/route.ts", "the board's own create"],
  ["app/lib/board-mutations.ts", "createBoardItem, shared with the automation engine"],
];

/* ── 1. The census ─────────────────────────────────────────────────────── */

test("nothing but the submission service inserts a NEW work order", async () => {
  /*
   * The exceptions are all COPIES or SEEDS rather than intake, and each is
   * named so that adding a sixth creator fails here instead of quietly
   * becoming a sixth answer to the same eight questions:
   *
   *   seedMaintenanceIfEmpty / seedRequestsIfEmpty  development sample rows
   *   intent:"duplicate" / duplicateBoardItems      copies of an existing row
   *   POST /api/import                              a bulk import, own contract
   */
  const allowed = new Set([
    "app/lib/submission-service.ts",
    "app/api/maintenance/route.ts", // seedMaintenanceIfEmpty
    "app/api/board/route.ts", // seedRequestsIfEmpty
    "app/api/board/items/route.ts", // intent:"duplicate"
    "app/lib/board-mutations.ts", // duplicateBoardItems
    "app/api/import/route.ts", // the importer
  ]);

  const { readdir } = await import("node:fs/promises");
  const walk = async (dir) => {
    const found = [];
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) found.push(...(await walk(rel)));
      else if (/\.tsx?$/.test(entry.name)) found.push(rel);
    }
    return found;
  };

  const offenders = [];
  for (const file of await walk("app")) {
    const source = await read(file);
    if (source.includes("insert(maintenanceRequests)") && !allowed.has(file)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a new work order is created in ONE place — see app/lib/submission-service.ts",
  );
});

test("every intake door calls the shared service", async () => {
  for (const [file, what] of DOORS) {
    const source = codeOnly(await read(file));
    const usesService =
      source.includes("createSubmission(db, {") || source.includes("allocateSubmission(db, {");
    assert.ok(usesService, `${what} (${file}) must go through the submission service`);
  }
});

/* ── 2. The identifier ─────────────────────────────────────────────────── */

test("no door reads a SQL MAX and inserts on top of it", async () => {
  /*
   * THE 503 NOBODY COULD RETRY PAST. Three doors read
   * `coalesce(max(cast(substr(id, 4) as integer)), 1048)` and inserted
   * `MN-<max+1>`, so two submissions in the same second computed the same
   * number and the second lost the primary key. It was also a deployed-only
   * outage waiting to happen: the cast reaches every id it meets, SQLite yields
   * 0 silently and Postgres raises 22P02, and an imported estate is exactly
   * where a non-`MN-` id turns up.
   */
  for (const [file, what] of DOORS) {
    /* `codeOnly`: the migration notes in these files QUOTE the SQL they no
       longer run, which is the point of writing them down. */
    const source = codeOnly(await read(file));
    assert.doesNotMatch(
      source,
      /max\(cast\(substr\(/,
      `${what} must not cast an id in SQL — SQLite yields 0 and Postgres raises 22P02`,
    );
    assert.doesNotMatch(
      source,
      /maxNumber \?\? 1048/,
      `${what} must not allocate an id without a conflict retry`,
    );
  }

  const service = await read("app/lib/submission-service.ts");
  assert.match(service, /export const MAX_ITEM_ID_ATTEMPTS = 8;/);
  assert.match(service, /\.onConflictDoNothing\(\)\s*\n?\s*\.returning\(\)/);
});

/* ── 3. Placement ──────────────────────────────────────────────────────── */

test("placement is part of creation, not something a board load does later", async () => {
  /*
   * `/api/maintenance` and `/api/report-job` wrote NO placement and relied on
   * `ensureBoardState` in /api/board to adopt every unplaced work order onto
   * whichever board is being loaded. That is not a lazy version of the same
   * answer: `ensureBoardState` returns early for `store-documentation` and for
   * every generated register BEFORE the filing loop, so on a workspace whose
   * only board is a section's register the row is never filed at all — and
   * where it does run, "which board" is decided by who opened what first.
   */
  const service = await read("app/lib/submission-service.ts");
  assert.match(service, /\.insert\(maintenanceGroupItems\)/);
  assert.match(
    service,
    /groupId: group\?\.id \?\? null,/,
    "the group is resolved before the row is written, not after",
  );

  for (const file of [
    "app/api/maintenance/route.ts",
    "app/api/report-job/route.ts",
    "app/api/forms/[token]/submit/route.ts",
    "app/api/board/items/route.ts",
  ]) {
    const source = codeOnly(await read(file));
    assert.ok(
      source.includes("boardId:"),
      `${file} must name the board it is filing onto rather than leaving it to be adopted`,
    );
  }

  /* And the adopt-the-unplaced loop must still be the thing being defended
     against, so this test keeps meaning something. */
  const board = await read("app/api/board/route.ts");
  assert.match(board, /if \(placed\.has\(request\.id\)\) continue;/);
});

/* ── 4. Stage, status and the SLA ──────────────────────────────────────── */

test("the group decides the stage, and the stage decides the status chip", async () => {
  /*
   * Only `createBoardItem` derived the status from the stage.
   * `/api/forms/[token]/submit` routed the stage by the configured group and
   * then pinned the status to "Pending Approval" regardless, so a form filing
   * into a Completed lane produced a job in that lane wearing the Pending
   * Approval chip. `/api/board/items` hard-coded `stage: "Incoming"` even when
   * the caller named a group whose `stage_key` was something else.
   */
  const service = codeOnly(await read("app/lib/submission-service.ts"));
  assert.match(service, /const stage: RequestStage = group\?\.stageKey \?\? desiredStage;/);
  assert.match(service, /status: statusForStage\(stage\)/);

  for (const [file, what] of DOORS) {
    const source = codeOnly(await read(file));
    assert.doesNotMatch(
      source,
      /stage: "Incoming",/,
      `${what} must not pin a stage the group disagrees with`,
    );
  }
});

test("every intake path writes a tier, a due date and a next-update date", async () => {
  /*
   * `/api/board/items` set NONE of the three, so every item raised from the
   * board was invisible to the overdue meter, the SLA report and the "needs an
   * update" tray — a job that could never be late because nothing knew when it
   * was due.
   */
  const service = codeOnly(await read("app/lib/submission-service.ts"));
  assert.match(service, /const rule = priorityRule\(priority\);/);
  assert.match(service, /tier: rule\.tier,/);
  assert.match(service, /dueAt,/);
  assert.match(service, /nextUpdateAt: dueAt,/);
});

/* ── 5. Option canonicalisation ────────────────────────────────────────── */

test("a priority reaches the column as a registry value, never as a raw string", async () => {
  /*
   * Two resolvers existed and the weaker one was on the doors that needed it
   * most. `configuredValue` matches an option's stable VALUE and nothing else,
   * while every form in the product shows LABELS — so on `/api/maintenance` and
   * `/api/report-job`, renaming "Urgent" made every subsequent submission fall
   * back to the workspace default and, because `priorityRule` keys on the
   * value, buy itself the 120-hour clock.
   *
   * `/api/board/items` was worse: `text(body.priority, 40) || "Medium"` wrote
   * any forty characters straight into a column the dashboards group by.
   */
  const service = codeOnly(await read("app/lib/submission-service.ts"));
  assert.match(service, /canonicalOptionValue\(options, text, fallback\)/);

  for (const [file, what] of DOORS) {
    const source = codeOnly(await read(file));
    assert.doesNotMatch(
      source,
      /configuredValue\(db, orgId, "priority"/,
      `${what} must resolve a priority by value OR label, not by value alone`,
    );
    assert.doesNotMatch(
      source,
      /priority: text\(body\.priority/,
      `${what} must not write an unvalidated string into the priority column`,
    );
  }
});

/* ── 6. Side effects ───────────────────────────────────────────────────── */

test("item_created is dispatched by every door, with the real board and group", async () => {
  /*
   * The event was raised by `/api/maintenance`, `/api/board/items` and
   * `createBoardItem`, and by NEITHER public door. So a workspace whose owner
   * had built "when an item is created, notify the duty coordinator" got it for
   * every job raised from inside the product and for none of the ones raised by
   * a member of the public standing in front of the fault.
   *
   * `/api/maintenance` also dispatched `itemCreatedEvent("maintenance", id,
   * null)` — the board key as a LITERAL and no group at all — so a rule scoped
   * to a group could never match a job raised there, and a workspace whose jobs
   * live on a section register saw the event attributed to a board the row is
   * not on.
   */
  for (const file of [
    "app/api/maintenance/route.ts",
    "app/api/report-job/route.ts",
    "app/api/forms/[token]/submit/route.ts",
    "app/api/board/items/route.ts",
  ]) {
    const source = codeOnly(await read(file));
    assert.match(source, /itemCreatedEvent\(/, `${file} must tell the board's rules`);
    assert.doesNotMatch(
      source,
      /itemCreatedEvent\("maintenance"/,
      `${file} must not name the board with a literal`,
    );
    assert.match(
      source,
      /submission\.group\?\.id \?\? null/,
      `${file} must report the group the row actually landed in`,
    );
  }
});

test("the operations email names the job, rather than a column that is always null", async () => {
  /*
   * `reference` is NULL on four of the five doors — every screen in the product
   * renders `reference ?? id` for exactly that reason — and both emailing
   * routes read `created.reference` raw, so every alert they have ever sent
   * carried the subject "New job — <site>" with no job named in it.
   */
  const service = await read("app/lib/submission-service.ts");
  assert.match(service, /displayReference: allocated\.request\.reference \?\? allocated\.request\.id/);

  for (const file of ["app/api/maintenance/route.ts", "app/api/report-job/route.ts"]) {
    const source = codeOnly(await read(file));
    assert.match(source, /reference: submission\.displayReference,/, `${file} must name the job`);
    assert.doesNotMatch(source, /reference: created\.reference/, `${file} must not read the raw column`);
  }
});

/* ── 7. What was deliberately NOT unified ──────────────────────────────── */

test("each door keeps its own authentication, which is the part that must differ", async () => {
  /*
   * The one thing a shared service must never absorb. A share token authorises
   * writing to ONE register in ONE workspace; a session with `board.edit`
   * authorises any board in the caller's own workspace; the public form
   * authorises nothing and is pinned to the primary tenant.
   */
  const service = await read("app/lib/submission-service.ts");
  for (const forbidden of [/scopedDb\(/, /scopedDbWithCapability\(/, /getSession\(/, /loadFormByToken\(/]) {
    assert.doesNotMatch(
      service,
      forbidden,
      "the service must be handed an organisation, never resolve one — a helper that " +
        "took 'the caller' as a parameter is a helper that can be talked into the wrong one",
    );
  }

  const maintenance = await read("app/api/maintenance/route.ts");
  assert.match(maintenance, /scopedDbWithCapability\(request, "board\.edit"\)/);
  const items = await read("app/api/board/items/route.ts");
  assert.match(items, /scopedDbWithCapability\(request, "board\.edit"\)/);
  const reportJob = await read("app/api/report-job/route.ts");
  assert.match(reportJob, /allowAnonymous: true/);
  assert.match(reportJob, /const orgId = PRIMARY_ORGANISATION_ID/);
  const submit = await read("app/api/forms/[token]/submit/route.ts");
  assert.match(submit, /loadFormByToken\(db, token\)/);
  assert.match(submit, /const boardKey = record\.boardId;/);
});

test("the share link keeps its mass-assignment filter, which nothing else needs", async () => {
  /*
   * THE STRONGEST BEHAVIOUR IN THE SET, and deliberately not moved. `answerFor`
   * refuses any answer to a question the form did not ASK — so a caller posting
   * straight to the endpoint cannot set the Priority, and therefore the SLA
   * tier and the due date, on a form whose Priority question the operator had
   * hidden. It is meaningless on the other four doors, whose fields are fixed.
   */
  const submit = await read("app/api/forms/[token]/submit/route.ts");
  assert.match(
    submit,
    /const answerFor = \(id: string, max = 400\) =>\s*\n\s*askedIds\.has\(id\) \? trimString\(answers\[id\], max\) : "";/,
    "an answer to a question the form did not ask is not an answer",
  );
  assert.match(submit, /const MAX_SUBMISSION_BYTES = 64 \* 1024;/);
  assert.match(submit, /const MAX_DECLARED_FILES = 40;/);
  assert.match(submit, /question\.showIf\.equals\.includes/, "conditionals still decide what was asked");
});

test("the board's own create keeps its MS- reference, and nothing else grows one", async () => {
  /*
   * DELIBERATELY PRESERVED. Every screen renders `reference ?? id`, so giving
   * the other four doors an `MS-yyyy-nnnn` would change what a new job is CALLED
   * beside 776 existing ones — a visible identity change with no defect behind
   * it. Taking it away from `/api/board/items` would break the `{ reference }`
   * its response has always carried.
   */
  const items = codeOnly(await read("app/api/board/items/route.ts"));
  assert.match(items, /const reference = await nextReference\(db, orgId, board\.id\);/);
  assert.match(items, /reference,/);

  for (const file of [
    "app/api/maintenance/route.ts",
    "app/api/report-job/route.ts",
    "app/api/forms/[token]/submit/route.ts",
  ]) {
    const source = codeOnly(await read(file));
    assert.doesNotMatch(
      source,
      /nextReference\(/,
      `${file} must not start allocating a second identifier for a job`,
    );
  }
});

test("a subitem's own status vocabulary survives the shared status map", async () => {
  /*
   * DELIBERATELY PRESERVED. Monday's SUBITEM board carries three labels —
   * Stuck, Working on it, Done — and the row menu opens a child on "Working on
   * it". `statusForStage` maps the PARENT board's four stages; applying it to a
   * subitem would rename every child the moment it was created. So an explicit
   * status wins on `/api/board/items` and the stage decides only when the
   * caller gives none.
   */
  const items = codeOnly(await read("app/api/board/items/route.ts"));
  assert.match(
    items,
    /\.\.\.\(text\(body\.status, 80\) \? \{ status: text\(body\.status, 80\) \} : \{\}\),/,
    "an explicit status must still be honoured",
  );
  const board = await read("app/(app)/portal/live-board.tsx");
  assert.match(board, /status: "Working on it",/, "and the caller that depends on it is still there");
});

/* ── 8. Evidence stays brokered ────────────────────────────────────────── */

test("an upload grant is minted only where nobody has a session, and only as a hash", async () => {
  /*
   * The bucket is PRIVATE and every read is brokered through `/api/files`, so
   * an object key must never become a bearer credential. The two anonymous
   * doors mint a single-use token, store only its SHA-256, and expire it in
   * thirty minutes; the two authenticated doors mint none, because a session
   * already covers what the grant would.
   */
  for (const file of ["app/api/report-job/route.ts", "app/api/forms/[token]/submit/route.ts"]) {
    const source = codeOnly(await read(file));
    assert.match(source, /publicUploadTokenHash: (await sha256\(uploadToken\)|uploadToken \? await sha256)/);
    assert.match(source, /30 \* 60 \* 1000/, "thirty minutes, not longer");
  }

  for (const file of ["app/api/maintenance/route.ts", "app/api/board/items/route.ts"]) {
    const source = codeOnly(await read(file));
    assert.doesNotMatch(
      source,
      /publicUploadTokenHash: await sha256/,
      `${file} is authenticated — a public grant would be a second, weaker credential`,
    );
  }
});
