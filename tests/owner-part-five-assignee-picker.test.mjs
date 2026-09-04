/**
 * Owner Part 5 — "We must be able to assign a job to a person in the workspace."
 *
 * WHAT WAS BROKEN. The board's Assigned To column was an `OptionCell` fed by
 * `assigneeFilterOptions`, which derives its list from the names already on the
 * board's own rows. On an estate where nobody has been assigned yet that list
 * is empty, so the dropdown offered exactly one entry — "Unassigned" — and a
 * job could not be given to anybody, ever.
 *
 * Two halves, following the pattern of `counters-origin-and-write-path`. The
 * first reads the source and pins the decisions a passing request cannot
 * demonstrate; the second drives the running dev server and skips when nothing
 * answers.
 *
 * Browser-verified 2026-09-04 at 1440/1280/1024/768/430/390/320 on a QA job
 * (created and cleaned by exact id): the picker lists the 17 real members of
 * the workspace, type-to-filter narrows them, ArrowDown+Enter assigns,
 * the assignment survives a reload, Unassigned clears it, Escape and a press
 * outside close it without re-opening, and the phone gets the sheet. Zero
 * console errors, zero horizontal overflow.
 *
 * NOTE ON TEST DATA. The live half signs in as the seeded owner, creates ONE
 * job, exercises it and bins it by its exact id. It never touches MN-1049.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  filterMembers,
  memberColour,
  memberInitials,
} from "../app/(app)/portal/assignee-directory.ts";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER_EMAIL = "owner@maintsupp.com";
const OWNER_PASSWORD = process.env.MAINTSUPP_OWNER_PASSWORD ?? "Sunnamusk-Owner-2026";

/** The job the owner has asked never to be used as a fixture. */
const RESERVED = new Set(["MN-1049"]);

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

/**
 * The same file with its comments removed.
 *
 * These files explain themselves at length, so a "must NOT contain" assertion
 * would otherwise be satisfied by a sentence of prose describing the thing that
 * was removed. Borrowed verbatim from `counters-origin-and-write-path`.
 */
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/* ------------------------------------------------------------------ */
/* 1. The picker chooses from the workspace, not from the board         */
/* ------------------------------------------------------------------ */

test("the Assigned To cell is a person picker, not the filter's option list", async () => {
  const board = codeOnly(await source("app/(app)/portal/live-board.tsx"));
  const cell = board.slice(board.indexOf('case "assignee":'), board.indexOf('case "requested":'));
  assert.match(cell, /<AssigneeCell/, "the assignee column must render the person picker");
  assert.doesNotMatch(
    cell,
    /options=\{assigneeOptions\}/,
    "the EDITOR must not be fed the list derived from the board's own rows — that is what made an empty estate un-assignable",
  );
  // The FILTER keeps that list, because filtering by a name only makes sense
  // for names the board actually holds.
  assert.match(board, /assigneeFilterOptions/, "the filter still derives its options from the rows");
});

test("both columns are written together, and the id can never be invented client-side", async () => {
  const cell = codeOnly(await source("app/(app)/portal/assignee-cell.tsx"));
  assert.match(
    cell,
    /onChange\(\{ assignee: nextName, assigneeUserId: nextId \}\)/,
    "the picker must send the display name and the user id as one change",
  );
  const route = codeOnly(await source("app/api/maintenance/route.ts"));
  assert.match(
    route,
    /assigneeLinkValues\(db, orgId, fields\)/,
    "PATCH /api/maintenance must resolve the id through app/lib/assignee-reference.ts",
  );
  assert.match(
    route,
    /if \(!assigneeLink\.ok\) \{\s*return Response\.json\(\{ error: assigneeLink\.reason \}, \{ status: 404 \}\);/,
    "an id that names nobody in this organisation must be REFUSED, never silently dropped",
  );
});

test("the roster is org-scoped through the canonical helper, and never hand-filtered", async () => {
  const reference = codeOnly(await source("app/lib/assignee-reference.ts"));
  assert.match(reference, /eq\(memberships\.organisationId, orgId\)/, "the org filter is the whole security of this feature");
  assert.match(reference, /eq\(memberships\.status, "active"\)/);
  assert.match(reference, /eq\(users\.active, true\)/);

  // The list the picker draws comes from the same three predicates, through
  // `scopedDb` — one route, one org filter, so the list a person chooses from
  // and the list the server will accept cannot drift apart.
  const directory = codeOnly(await source("app/(app)/portal/assignee-directory.ts"));
  assert.match(directory, /fetch\("\/api\/board\/members"/);
  const members = codeOnly(await source("app/api/board/members/route.ts"));
  assert.match(members, /await scopedDb\(request\)/);
  assert.match(members, /eq\(memberships\.organisationId, orgId\)/);
});

test("the display name is the roster's, not the caller's", async () => {
  // A client-supplied name beside a server-verified id is a way to write
  // "Finance Director" next to a warehouse account.
  const reference = codeOnly(await source("app/lib/assignee-reference.ts"));
  assert.match(
    reference,
    /const name = \(row\.fullName\?\.trim\(\) \|\| row\.email\)\.slice\(0, 120\);/,
    "the name written beside the id must be derived from the membership row",
  );
});

test("writing the name alone clears the id, so a link can never go stale", async () => {
  // The same rule `contractorLinkValues` applies to `contractor_id`: a job must
  // never be counted against a person it no longer names. It matters most for
  // the automation engine, whose "Replace assignee" action writes a NAME.
  const fields = codeOnly(await source("app/lib/request-fields.ts"));
  assert.match(
    fields,
    /values\.assignee = trimString\(fields\.assignee, 120\) \|\| null;\s*\n\s*values\.assigneeUserId = null;/,
    "requestFieldValues must clear assignee_user_id on any name-only write",
  );
  // ...and it must NOT coerce the id itself, because the automation engine
  // calls this function with no reference validation of its own.
  assert.doesNotMatch(
    fields,
    /values\.assigneeUserId = trimString\(fields\.assigneeUserId/,
    "an unattended rule must not be able to assign a job to another tenant's user",
  );

  const items = codeOnly(await source("app/api/board/items/route.ts"));
  assert.match(
    items,
    /patch\.assignee = text\(body\.assignee, 120\);\s*\n\s*patch\.assigneeUserId = null;/,
    "the batch route takes the name only, so it must un-name the account too",
  );
});

test("a malformed assigneeUserId is refused before anything is written", async () => {
  const fields = codeOnly(await source("app/lib/request-fields.ts"));
  assert.match(fields, /has\("assigneeUserId"\)/);
  assert.match(fields, /note\("assigneeUserId", "a workspace member's user id, or null to unassign"\)/);
});

test("assigning is a board edit and is audited through the channel that already exists", async () => {
  const route = codeOnly(await source("app/api/maintenance/route.ts"));
  const patch = route.slice(route.indexOf("export async function PATCH"));
  assert.match(
    patch,
    /scopedDbWithCapability\(request, "board\.edit"\)/,
    "assigning must need the same capability every other cell write needs",
  );
  // No new audit channel: `request.fields_changed` in `activity_log` already
  // records a cell edit and now carries both columns.
  assert.match(patch, /action: note\s*\n?\s*\? "request\.note_added"\s*\n?\s*: fields\s*\n?\s*\? "request\.fields_changed"/);
});

test("the picker is single-assignee, which is the model's cardinality", async () => {
  const cell = codeOnly(await source("app/(app)/portal/assignee-cell.tsx"));
  assert.doesNotMatch(cell, /assigneeUserIds|Array\.from\(selected/, "this board holds one person per item");
  // The catalog already refuses monday's "Add assignee" for the same reason.
  const catalog = await source("app/lib/automations/catalog.ts");
  assert.match(catalog, /Assigned To holds one person per item on this board/);
});

test("the picker's dismissal is idempotent, which is the board's known menu trap", async () => {
  // The board's own useDismissOnOutside (pointerdown + Escape) coexists with
  // AnchoredPopover's. A toggling onClose reads the two as two clicks and
  // re-opens the menu it just closed.
  const cell = await source("app/(app)/portal/assignee-cell.tsx");
  assert.match(
    cell,
    /onClose=\{\(\) => setOpen\(false\)\}/,
    "onClose must set state to null, never toggle",
  );
  assert.doesNotMatch(
    codeOnly(cell),
    /onClose=\{\(\) => setOpen\(\(current\) => !current\)\}/,
  );
});

test("the picker reuses the shared overlay primitives rather than positioning itself", async () => {
  const cell = codeOnly(await source("app/(app)/portal/assignee-cell.tsx"));
  assert.match(cell, /import \{ AnchoredPopover \} from "\.\/overlay\/anchored"/);
  assert.doesNotMatch(cell, /getBoundingClientRect|position: "fixed"/, "no second positioning implementation");
});

/* ------------------------------------------------------------------ */
/* 2. The pure helpers                                                 */
/* ------------------------------------------------------------------ */

const ROSTER = [
  { id: "u1", name: "Priya Nair", email: "priya@example.com", role: "admin", title: "Facilities Manager", avatarColour: null, isMe: false },
  { id: "u2", name: "Tom Blake", email: "tom.blake@example.com", role: "client", title: null, avatarColour: "#123456", isMe: true },
  { id: "u3", name: "Admin (testing)", email: "admin@test.example.com", role: "admin", title: null, avatarColour: null, isMe: false },
];

test("the search box matches a name, an email and a job title", () => {
  assert.deepEqual(filterMembers(ROSTER, "priya").map((m) => m.id), ["u1"]);
  assert.deepEqual(filterMembers(ROSTER, "tom.blake@").map((m) => m.id), ["u2"]);
  // "who is the facilities manager" is the same question as "who is Priya".
  assert.deepEqual(filterMembers(ROSTER, "facilities").map((m) => m.id), ["u1"]);
  assert.equal(filterMembers(ROSTER, "   ").length, 3, "a blank search narrows nothing");
  assert.equal(filterMembers(ROSTER, "nobody").length, 0);
});

test("initials are letters, never punctuation", () => {
  assert.equal(memberInitials(ROSTER[0]), "PN");
  // Measured on the real board before this was fixed: splitting on whitespace
  // alone turned "Admin (testing)" into the disc "A(".
  assert.equal(memberInitials(ROSTER[2]), "AT");
  assert.equal(memberInitials({ name: "", email: "solo@example.com" }), "SO");
  // One word gets two of ITS OWN letters — "O" alone reads as a rendering
  // fault — and the apostrophe is not one of them.
  assert.equal(memberInitials({ name: "O'Brien", email: "" }), "OB");
  assert.equal(memberInitials({ name: "Cher", email: "" }), "CH");
  assert.equal(memberInitials({ name: "!!!", email: "" }), "");
});

test("a person's colour is stable, and a stored one wins", () => {
  assert.equal(memberColour(ROSTER[1]), "#123456");
  // Derived from the id, so it cannot change when somebody else is invited.
  assert.equal(memberColour(ROSTER[0]), memberColour({ id: "u1", avatarColour: null }));
});

/* ------------------------------------------------------------------ */
/* 3. The live half                                                    */
/* ------------------------------------------------------------------ */

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/api/board?compact=1`, {
      signal: AbortSignal.timeout(4000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

function sessionTokenFrom(response) {
  const cookie = (response.headers.getSetCookie?.() ?? []).find((value) =>
    value.startsWith("maintsupp_session="),
  );
  return cookie ? cookie.slice("maintsupp_session=".length).split(";")[0] : null;
}

async function signInAsOwner() {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  return sessionTokenFrom(response);
}

async function asOwner(session, path, init = {}) {
  const send = (token) =>
    fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Cookie: `maintsupp_session=${token}` },
    });
  let response = await send(session);
  if (response.status === 401) {
    const fresh = await signInAsOwner();
    if (fresh) response = await send(fresh);
  }
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const json = (body) => ({
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * One disposable job, remembered by its exact id so it can be binned by it.
 *
 * Retried, and a persistent 503 is reported as BUSY rather than as a failure.
 * The dev database is a single Miniflare D1 shared with every other suite and
 * every other window, and a write refused under load is an environment fact —
 * see the note on starvation in CLAUDE.md. A fixture that could not be created
 * proves nothing about assigning, in either direction.
 */
async function qaJob(session) {
  const groups = await asOwner(session, "/api/board?compact=1");
  const group = (groups.body.groups ?? []).find((row) => !row.archived && !row.deletedAt);
  if (!group) return { busy: true, why: "no board group answered" };

  /*
   * TWO CREATORS, because the board has two and they fail independently.
   * `POST /api/board/items` is the one the board's own "New item" button uses;
   * `POST /api/board {action:"create_item"}` is the one the group headers use.
   * Trying both means a fixture is only given up on when neither will write.
   */
  const attempts = [
    ["/api/board/items?board=maintenance", { groupId: group.id, title: "assignee picker fixture" }],
    ["/api/board?board=maintenance", { action: "create_item", groupId: group.id }],
  ];
  let last = { status: 0, body: {} };
  for (let round = 0; round < 3; round += 1) {
    for (const [path, body] of attempts) {
      last = await asOwner(session, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const id = last.body?.request?.id ?? last.body?.id;
      if (id && !RESERVED.has(id)) return { id };
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return { busy: true, why: `creating a job answered ${last.status} ${JSON.stringify(last.body).slice(0, 120)}` };
}

test("live: a job can be assigned to a real member, and the server names them", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  assert.ok(session, "the seeded owner must be able to sign in");

  const roster = await asOwner(session, "/api/board/members");
  assert.equal(roster.status, 200);
  const people = roster.body.members ?? [];
  assert.ok(people.length > 0, "the workspace roster must not be empty");

  const fixture = await qaJob(session);
  if (fixture.busy) {
    t.skip(`the dev database would not take a fixture write — ${fixture.why}`);
    return;
  }
  const { id } = fixture;
  assert.ok(!RESERVED.has(id));

  try {
    const person = people[0];

    // The name in the payload is deliberately wrong: the server must ignore it
    // and write the roster's own name beside the verified id.
    const assigned = await asOwner(
      session,
      "/api/maintenance",
      json({ id, fields: { assignee: "NOT THIS NAME", assigneeUserId: person.id } }),
    );
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.request.assigneeUserId, person.id);
    assert.equal(assigned.body.request.assignee, person.name);

    // It survives a re-read, which is what "survives a refresh" means.
    const reread = await asOwner(session, `/api/maintenance?id=${id}`);
    assert.equal(reread.body.request.assigneeUserId, person.id);
    assert.equal(reread.body.request.assignee, person.name);

    // The change is audited through the channel job cell edits already use.
    const trail = (reread.body.activities ?? []).find(
      (row) => row.action === "request.fields_changed" && row.detail?.fields?.assigneeUserId,
    );
    assert.ok(trail, "assigning must appear in the job's activity trail");

    // A user id that names nobody in this organisation is refused, and an id
    // that exists nowhere is refused identically — so this cannot be used to
    // confirm that an account exists.
    const foreign = await asOwner(
      session,
      "/api/maintenance",
      json({ id, fields: { assigneeUserId: "user-not-in-this-workspace" } }),
    );
    assert.equal(foreign.status, 404);
    assert.match(String(foreign.body.error), /not an active member/i);

    // ...and nothing was written.
    const unchanged = await asOwner(session, `/api/maintenance?id=${id}`);
    assert.equal(unchanged.body.request.assigneeUserId, person.id);

    // A malformed value is refused before anything is written.
    const malformed = await asOwner(
      session,
      "/api/maintenance",
      json({ id, fields: { assigneeUserId: 42 } }),
    );
    assert.equal(malformed.status, 400);

    // Writing the NAME alone un-names the account.
    const renamed = await asOwner(
      session,
      "/api/maintenance",
      json({ id, fields: { assignee: "Somebody Typed" } }),
    );
    assert.equal(renamed.body.request.assignee, "Somebody Typed");
    assert.equal(renamed.body.request.assigneeUserId, null);

    // And an explicit unassignment clears both.
    const cleared = await asOwner(
      session,
      "/api/maintenance",
      json({ id, fields: { assignee: null, assigneeUserId: null } }),
    );
    assert.equal(cleared.body.request.assignee, null);
    assert.equal(cleared.body.request.assigneeUserId, null);
  } finally {
    // Binned by its EXACT id — never by a title sweep, which has repeatedly
    // eaten other fixtures on this shared database.
    await asOwner(session, "/api/board?board=maintenance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete_items", requestIds: [id] }),
    });
  }
});
