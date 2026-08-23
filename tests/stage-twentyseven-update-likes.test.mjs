/**
 * Stage 27 — `👍 Like` on an update, which monday has and this product did not.
 *
 * `db/monday-export/UPDATES-PANEL-CAPTURE.md` is the authority and lists it as
 * item 3 of what was missing. The feature is small on screen — a thumb, a word
 * and a number — and almost all of the ways it can be wrong are invisible in a
 * screenshot of one liked comment. This file exists for those.
 *
 * THE FOUR THINGS THAT WOULD OTHERWISE GO WRONG
 *
 *  1  A COUNTER INSTEAD OF ROWS. The panel draws three things and only one of
 *     them is a number: the count, whether YOU are among them (the thumb is
 *     filled if you are) and who the others were (the names on the hover). A
 *     column on `item_updates` answers the first and forces a second query for
 *     the rest — and it is the `issue_attachment_count` shape: two writers, no
 *     reconciler, drift. It is a row per person and the count is a COUNT.
 *
 *  2  A DOUBLE TAP INFLATING IT. The pair (update, email) is the PRIMARY KEY,
 *     so two taps that cross in flight cannot become two rows. That is asserted
 *     against the runtime DDL, not only the Drizzle schema, because nothing in
 *     the request boot path runs the migrations.
 *
 *  3  AN ANONYMOUS LIKE. An actor with no address would take the empty-string
 *     slot in that key, and the SECOND such actor would arrive to find they had
 *     already liked everything the first ever liked.
 *
 *  4  THE CLIENT DECIDING THE NEW COUNT. It cannot: somebody else may have
 *     liked the same comment in the same second. The server answers with the
 *     number it just read, and the panel takes it.
 *
 * The live assertions talk to a running dev server and skip when nothing is
 * listening. They TOGGLE — like, then unlike — so the workspace is left exactly
 * as it was found; the read between the two is what proves the write.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const ROUTE = "app/api/updates/route.ts";
const SCHEMA = "db/schema.ts";
const INIT = "db/init.ts";
const PANEL = "app/(app)/portal/update-thread.tsx";
const DRAWER = "app/(app)/portal/portal-app.tsx";
const CSS = "app/(app)/portal/update-thread.css";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/* ── 1. A row per person, not a counter ──────────────────────────────────── */

test("a like is a row, and the pair is the primary key", async () => {
  const schema = await read(SCHEMA);

  const table = schema.slice(
    schema.indexOf("export const itemUpdateLikes = sqliteTable("),
    schema.indexOf("export const itemActivity"),
  );
  assert.ok(table.length > 200, "itemUpdateLikes moved; fix this test");
  assert.match(table, /"item_update_likes"/);
  assert.match(
    table,
    /primaryKey\(\{ columns: \[table\.updateId, table\.actorEmail\] \}\)/,
    "liking twice must be idempotent in storage, not merely in the client",
  );
  assert.match(table, /actorName: text\("actor_name"\)\.notNull\(\)/, "the hover needs a name");
  assert.match(
    table,
    /index\("item_update_likes_update_idx"\)\.on\(table\.organisationId, table\.updateId\)/,
  );
});

test("the runtime bootstrap creates the table, not only the migration", async () => {
  const init = await read(INIT);

  /*
   * Nothing in the request path runs `drizzle/`. A table that exists only as a
   * migration is a table the panel 500s on — which is exactly how Stage 15's
   * `board_views` took the whole tab strip down.
   */
  assert.match(init, /CREATE TABLE IF NOT EXISTS item_update_likes/);
  assert.match(init, /PRIMARY KEY \(update_id, actor_email\)/);
  assert.match(init, /CREATE INDEX IF NOT EXISTS item_update_likes_update_idx/);
});

test("no counter column was added to item_updates", async () => {
  const schema = await read(SCHEMA);

  const table = schema.slice(
    schema.indexOf("export const itemUpdates = sqliteTable("),
    schema.indexOf("export const itemUpdateLikes"),
  );
  for (const drifty of ["likeCount", "like_count", "likes"]) {
    assert.ok(
      !table.includes(drifty),
      `item_updates gained ${drifty} — two writers and no reconciler is the bug this avoided`,
    );
  }
});

/* ── 2. The route ────────────────────────────────────────────────────────── */

test("a like is refused without a session, and without an address", async () => {
  const route = await read(ROUTE);
  const put = route.slice(route.indexOf("export async function PUT(request: Request)"));

  assert.match(
    put,
    /scopedDbWithCapability\(request, "board\.view"\)/,
    "reading the board is the right bar for liking a comment on it",
  );
  assert.match(put, /if \(guard\.denied\) return guard\.denied;/);
  assert.match(
    put,
    /Sign in with an email address to like an update\./,
    "an actor with no address would take the empty-string slot in the key",
  );
  assert.match(put.slice(0, 1400), /status: 403/);
});

test("the like is confined to the workspace, and to a job that is not binned", async () => {
  const route = await read(ROUTE);
  const put = route.slice(route.indexOf("export async function PUT(request: Request)"));

  /*
   * `let [target]`, not `const`, since the UI batch: the board Discussion
   * (board-actions/board-discussion.tsx) reuses this table with
   * `request_id = "board:<boardId>"`, and PUT falls back to that board-level
   * row when no job joins. The workspace and not-binned guards below are
   * unchanged — they are what this test is for.
   */
  const start = put.search(/(?:const|let) \[target\]/);
  const lookup = put.slice(start, put.indexOf("const [existing]"));
  assert.ok(start >= 0, "the PUT handler must look the target update up first");
  assert.match(lookup, /eq\(maintenanceRequests\.organisationId, orgId\)/);
  assert.match(
    lookup,
    /isNull\(maintenanceRequests\.deletedAt\)/,
    "a like on a comment attached to a deleted job is a row nobody can see or remove",
  );
  assert.match(lookup, /eq\(itemUpdates\.organisationId, orgId\)/);
  assert.match(put, /That update is not on this board\./);
});

test("the toggle is delete-or-insert, and a crossing double tap is not an error", async () => {
  const route = await read(ROUTE);
  const put = route.slice(route.indexOf("export async function PUT(request: Request)"));

  assert.match(put, /\.delete\(itemUpdateLikes\)/);
  assert.match(put, /\.insert\(itemUpdateLikes\)/);
  assert.match(
    put,
    /\.onConflictDoNothing\(\)/,
    "two taps that cross in flight both find no row; the second must not 500",
  );
  // The read and the delete are keyed on the same person; the TALLY is not,
  // because it counts everybody's likes and not the caller's.
  assert.equal(
    (put.match(/eq\(itemUpdateLikes\.actorEmail, email\)/g) ?? []).length,
    2,
    "the read and the delete must agree about whose like this is",
  );
  const tally = put.slice(put.indexOf("const [tally]"));
  assert.doesNotMatch(
    tally.slice(0, 500),
    /actorEmail/,
    "a count filtered by the caller can only ever be 0 or 1",
  );
});

test("the count that comes back is counted, not predicted", async () => {
  const route = await read(ROUTE);
  const put = route.slice(route.indexOf("export async function PUT(request: Request)"));

  assert.match(put, /select\(\{ count: sql<number>`COUNT\(\*\)` \}\)/);
  assert.match(put, /likeCount: Number\(tally\?\.count \?\? 0\)/);
  assert.match(put, /liked: !existing/);
  // Nothing anywhere adds one to a stored number.
  assert.doesNotMatch(route, /likeCount: .*\+ 1/);
});

test("the reader's own like is recognised whatever the address is cased as", async () => {
  const route = await read(ROUTE);

  /*
   * The addresses in this workspace are not consistently cased, and the write
   * path stores whatever the session carries. Compared raw, somebody signed in
   * as `Anwar@…` sees their own like as somebody else's: a hollow thumb beside
   * a count of one that is theirs.
   */
  assert.match(route, /const me = \(actor\.email \?\? ""\)\.trim\(\)\.toLowerCase\(\);/);
  assert.match(route, /like\.actorEmail\.trim\(\)\.toLowerCase\(\) === me/);
});

test("the hover's list of names is bounded", async () => {
  const route = await read(ROUTE);

  // Past a dozen the hover is a paragraph, and the payload grows with the
  // popularity of a comment rather than with the size of the thread.
  assert.match(route, /if \(entry\.names\.length < 12\) entry\.names\.push\(like\.actorName\);/);
});

test("the thread's likes are read in one query, bounded by the thread", async () => {
  const route = await read(ROUTE);

  assert.match(route, /inArray\(itemUpdateLikes\.updateId, updateIds\)/);
  assert.match(
    route,
    /const likeRows = updateIds\.length/,
    "an empty thread must not send `IN ()` to D1",
  );
});

/* ── 3. The panel ────────────────────────────────────────────────────────── */

test("the thumb says whether it is pressed, and the count hides at zero", async () => {
  const panel = await read(PANEL);

  const button = panel.slice(panel.indexOf("function LikeButton("), panel.indexOf("/* ---", panel.indexOf("function LikeButton(")));
  assert.match(button, /aria-pressed=\{update\.likedByMe\}/, "assistive tech needs the state too");
  assert.match(button, /update\.likedByMe \? " is-liked" : ""/);
  assert.match(
    button,
    /\{update\.likeCount > 0 && <b>\{update\.likeCount\}<\/b>\}/,
    "a bare 0 beside every comment is noise",
  );
  assert.match(button, /update\.likedBy\.length \? update\.likedBy\.join\(", "\) : null/);

  const css = await read(CSS);
  assert.ok(css.includes(".update-like"), ".update-like has no styling");
});

test("a like is applied in place — it does not re-fetch the thread", async () => {
  const panel = await read(PANEL);
  const drawer = await read(DRAWER);

  /*
   * `loadUpdates()` is right for a comment: the server assigns its id and its
   * timestamp and the panel has to learn them. A like changes two numbers the
   * server has just returned, and re-reading the thread for it would remount
   * every card — an open `… See more`, a half-typed reply, and the page a
   * reader had scrolled to inside an embedded PDF, all thrown away by a thumb.
   */
  assert.match(panel, /onLikeChange\(updateId, payload\.liked \?\? false, payload\.likeCount \?\? 0\)/);
  assert.match(drawer, /onLikeChange=\{applyLike\}/);
  assert.match(drawer, /const applyLike = useCallback\(/);
  assert.doesNotMatch(
    panel.slice(panel.indexOf("const toggleLike"), panel.indexOf("const toggleLike") + 900),
    /onReload\(\)/,
    "a like must not reload the thread",
  );

  // And `likedBy` is adjusted with the count, or the hover goes on naming the
  // old set until something else reloads.
  const apply = drawer.slice(drawer.indexOf("const applyLike = useCallback("), drawer.indexOf("const applyLike = useCallback(") + 1200);
  assert.match(apply, /likedByMe: liked/);
  assert.match(apply, /entry\.likedBy\.filter\(\(name\) => name !== me\)/);
  assert.match(apply, /replies: update\.replies\.map\(touch\)/, "a reply can be liked too");
});

test("a like that did not save leaves the thumb where it was", async () => {
  const panel = await read(PANEL);

  /*
   * There is no optimistic flip. The count that stays on screen is the
   * server's, so a failed request simply does not move — rather than showing a
   * filled thumb over a like that was never stored.
   */
  const from = panel.indexOf("const toggleLike");
  // Bounded at the next declaration, or the slice runs into `post` below it and
  // reads that function's `setPosting` as this one's.
  const toggle = panel.slice(from, panel.indexOf("const post = useCallback(", from));
  assert.ok(toggle.length > 200 && toggle.length < 1200, "toggleLike moved; fix this test");
  assert.match(toggle, /if \(!response\.ok\) return;/);
  assert.doesNotMatch(
    toggle,
    /setUpdates|useState|set[A-Z]\w*\(/,
    "nothing is flipped before the answer",
  );
});

/* ── 4. Live, against a running dev server ───────────────────────────────── */

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/api/updates?requestId=probe`, {
      signal: AbortSignal.timeout(4000),
    });
    return response.status !== 0;
  } catch {
    return false;
  }
}

async function signIn() {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) return null;
  return (response.headers.getSetCookie?.() ?? []).map((raw) => raw.split(";")[0]).join("; ");
}

/** A job with a thread, and the newest update on it. */
async function anUpdate(cookie) {
  const jobs = await fetch(`${BASE_URL}/api/maintenance?limit=300`, { headers: { cookie } });
  if (!jobs.ok) return null;
  const payload = await jobs.json();
  const rows = payload.requests ?? payload.items ?? [];
  for (const row of rows) {
    if ((row.commentCount ?? 0) < 1) continue;
    const thread = await fetch(`${BASE_URL}/api/updates?requestId=${row.id}`, {
      headers: { cookie },
    });
    if (!thread.ok) continue;
    const { updates = [] } = await thread.json();
    if (updates.length) return { requestId: row.id, update: updates[0] };
  }
  return null;
}

test("live: a caller with no session is answered, not crashed into", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const response = await fetch(`${BASE_URL}/api/updates`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ updateId: "upd_whatever" }),
  });

  /*
   * NOT asserted: that this is a refusal.
   *
   * On a dev server it is not one, and that is deliberate rather than a hole
   * this feature opened. `demoIdentityAllowed()` in app/lib/tenant-access.ts is
   * `NODE_ENV !== "production"`, so with no session the role cookie decides the
   * actor and an absent cookie means super admin — the same affordance that
   * lets `curl /api/maintenance` return 775 rows on a laptop, documented at
   * length there and confined to non-production. A like therefore goes as far
   * as any other board write does here, and lands on the update lookup: 404.
   *
   * What IS asserted is the part that holds in both environments: the route
   * answers rather than throwing, and it does not silently accept an update
   * that does not exist.
   */
  assert.notEqual(response.status, 500, "a signed-out caller is not a crash");
  assert.notEqual(response.status, 200, "an update that does not exist was not liked");
});

test("the like path is gated by the same guard as every other board write", async () => {
  const route = await read(ROUTE);
  const put = route.slice(route.indexOf("export async function PUT(request: Request)"));

  // Which is what makes the production behaviour of the test above someone
  // else's job — `resolveTenantAccess` — rather than this route's own.
  assert.match(put, /scopedDbWithCapability\(request, "board\.view"\)/);
  assert.doesNotMatch(
    put.slice(0, 600),
    /process\.env/,
    "the route must not decide for itself who counts as signed in",
  );
});

test("live: an update from outside the workspace is a 404, not a like", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const cookie = await signIn();
  if (!cookie) {
    t.skip("the seeded owner could not sign in");
    return;
  }
  const response = await fetch(`${BASE_URL}/api/updates`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ updateId: "upd_not_a_real_update" }),
  });
  assert.equal(response.status, 404);
});

test("live: the thumb goes on and comes back off, and the thread agrees", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const cookie = await signIn();
  if (!cookie) {
    t.skip("the seeded owner could not sign in");
    return;
  }
  const found = await anUpdate(cookie);
  if (!found) {
    t.skip("no job in this workspace has an update to like");
    return;
  }

  const { requestId, update } = found;
  const before = update.likeCount ?? 0;
  const like = () =>
    fetch(`${BASE_URL}/api/updates`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ updateId: update.id, requestId }),
    }).then((response) => response.json());

  const on = await like();
  try {
    assert.equal(on.ok, true);
    assert.equal(on.liked, !update.likedByMe);
    assert.equal(on.likeCount, update.likedByMe ? before - 1 : before + 1);

    // The READ path has to agree with the write, which is the half a unit test
    // of the handler cannot see: the GET builds its own tally.
    const thread = await fetch(`${BASE_URL}/api/updates?requestId=${requestId}`, {
      headers: { cookie },
    });
    const { updates } = await thread.json();
    const seen = updates.find((entry) => entry.id === update.id);
    assert.equal(seen.likeCount, on.likeCount, "the thread reports the tally the toggle returned");
    assert.equal(seen.likedByMe, on.liked, "and knows it was this reader");
    if (on.liked) {
      assert.ok(seen.likedBy.length > 0, "the hover needs a name behind the number");
    }

    // Idempotent in storage: the same call twice does not make two rows.
    const off = await like();
    assert.equal(off.liked, !on.liked);
    assert.equal(off.likeCount, before, "the count comes back to where it started");
  } finally {
    // Leave the workspace exactly as it was found, whatever failed above.
    const settled = await fetch(`${BASE_URL}/api/updates?requestId=${requestId}`, {
      headers: { cookie },
    });
    const { updates = [] } = await settled.json();
    const now = updates.find((entry) => entry.id === update.id);
    if (now && (now.likeCount ?? 0) !== before) await like();
  }
});
