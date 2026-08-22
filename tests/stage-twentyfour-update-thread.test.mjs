import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const ROUTE = "app/api/updates/route.ts";
const DRAWER = "app/(app)/portal/portal-app.tsx";
/*
 * The panel moved out of the drawer.
 *
 * Stage 24 built the thread inline in `portal-app.tsx`; Stage 27 rebuilt it
 * against monday's own panel and it lives in its own module now. The drawer
 * still owns the DATA — the fetch, the counts, the like bookkeeping, the
 * upload-then-post — and every assertion about that is still read from DRAWER
 * below. What moved is the drawing, and the assertions that describe drawing
 * moved with it rather than being deleted: each of the six Stage 24 defects is
 * still pinned here, at its new address.
 */
const PANEL = "app/(app)/portal/update-thread.tsx";
const CSS = "app/(app)/portal/update-thread.css";
const CAPTURE = "db/monday-export/api-pull/comments.json";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/**
 * Stage 24 — the job drawer's Updates tab against monday's Updates panel.
 *
 * Six things were wrong with this panel, and every one of them was invisible in
 * a screenshot of a single comment. They only show up against the corpus: 314
 * rows in `item_updates` spanning 2023 to 2026, 47 imported replies, 53
 * comments carrying a file.
 *
 *   1  THE THREAD WAS UPSIDE DOWN. The route ordered `asc(createdAt)` while
 *      monday returns every item's `updates` array newest first — see the
 *      capture, which is the authority here and is re-checked below rather than
 *      quoted. On the Solihull job that put the newest comment, the one that
 *      says what is happening now, 2,379px down a 2,604px scroller.
 *
 *   2  THERE WAS NO REPLY CONTROL. `parentId` had been read and validated by
 *      the POST since the route was written, and 47 replies were on screen, but
 *      the only caller never sent it and no card had a button. Replies could be
 *      read and never written.
 *
 *   3  A COMMENT DID NOT APPEAR UNTIL THE DRAWER WAS RE-MOUNTED. The save
 *      handler called `loadActivities()` — the audit log — and never
 *      `loadUpdates()`, which was reachable from the mount effect and nowhere
 *      else. The toast said "Comment added", the box cleared, the thread did
 *      not move. The tab counted `request.commentCount` from the board's row
 *      snapshot while the header counted the fetched thread, so the two read 5
 *      and 6.
 *
 *   4  THE YEAR WAS DROPPED. `formatDate(value, true)` puts `year: "numeric"`
 *      in its else branch only, so both comment call sites rendered
 *      "21 Jul, 15:04" for a 2023 row. A three-year-old comment was visually
 *      identical to yesterday's.
 *
 *   5  A COMMENT COULD NOT CARRY A FILE. The read path was complete and 53
 *      imported comments use it, but nothing in the app could ever write
 *      `attachments.update_id`.
 *
 *   8  THE SECTION BORROWED THE ACTIVITY LOG'S STATES. A failed activity fetch
 *      drew "The update history could not be loaded" above a thread that had
 *      loaded, with a Try again that re-fetched the wrong thing; and a thread
 *      that genuinely failed was blanked to `[]` and shown as "No detailed
 *      updates have been added yet".
 *
 * The assertions below fail if any of those six comes back. The live ones talk
 * to a running dev server and skip when nothing is listening, the same bargain
 * the Stage 23 suites make — and they only READ. Nothing here writes a row.
 */

/* ── 1. Newest first, and the capture is why ─────────────────────────────── */

async function capture() {
  try {
    return JSON.parse(await read(CAPTURE));
  } catch {
    return null; // The raw pull is a development artefact.
  }
}

test("monday returns a thread newest first, on every multi-update item", async (t) => {
  const pulled = await capture();
  if (!pulled) {
    t.skip("no api-pull/comments.json on this machine");
    return;
  }

  let checked = 0;
  for (const item of pulled.maintenance ?? []) {
    const updates = item.updates ?? [];
    if (updates.length < 2) continue;
    checked += 1;
    const times = updates.map((update) => Date.parse(update.created_at));
    for (let index = 1; index < times.length; index += 1) {
      assert.ok(
        times[index - 1] >= times[index],
        `item ${item.id} update ${updates[index].id} breaks descending order — ` +
          "the capture is the authority and it is newest first",
      );
    }
  }
  assert.ok(checked >= 20, `expected the multi-update items, saw ${checked}`);
});

test("a reply list inside a parent runs oldest first", async (t) => {
  const pulled = await capture();
  if (!pulled) {
    t.skip("no api-pull/comments.json on this machine");
    return;
  }

  // The counter-example that keeps the two orders apart: a conversation UNDER
  // one comment reads as a sequence, question then answer, so reversing it with
  // the parents would put the answer before the question. Item 2737219844
  // update 603582051 is the five-reply thread named in the investigation.
  let longest = null;
  for (const item of pulled.maintenance ?? []) {
    for (const update of item.updates ?? []) {
      const replies = update.replies ?? [];
      if (!longest || replies.length > longest.length) longest = replies;
    }
  }
  assert.ok(longest && longest.length >= 4, "expected a multi-reply thread");
  const times = longest.map((reply) => Date.parse(reply.created_at));
  for (let index = 1; index < times.length; index += 1) {
    assert.ok(
      times[index - 1] <= times[index],
      "replies inside a parent are ascending in the capture",
    );
  }
});

test("the route orders top-level comments newest first", async () => {
  const source = await read(ROUTE);

  assert.match(
    source,
    /\.orderBy\(sql`datetime\(\$\{itemUpdates\.createdAt\}\) DESC`\)/,
    "the thread must come back newest first, which is what the capture shows",
  );
  assert.doesNotMatch(
    source,
    /orderBy\(asc\(itemUpdates\.createdAt\)\)/,
    "ascending is the defect: it put the newest comment at the bottom",
  );

  /*
   * Sorted through `datetime()`, not on the raw column.
   *
   * `created_at` holds two shapes — the importer's ISO with a Z, and SQLite's
   * CURRENT_TIMESTAMP for a row the app writes. A plain string sort puts every
   * space-separated row before every T-separated one on the same date, because
   * " " < "T", so on the day a comment is added the newest could land under an
   * older one.
   */
  assert.match(source, /datetime\(/, "both created_at shapes have to sort together");
});

test("replies are sorted ascending explicitly, not by inheriting the query", async () => {
  const source = await read(ROUTE);

  const sortBlock = source.slice(source.indexOf("for (const list of byParent.values())"));
  assert.match(
    sortBlock.slice(0, 200),
    /list\.sort\(\(left, right\) => instantOf\(left\.createdAt\) - instantOf\(right\.createdAt\)\)/,
    "the reply list says ascending itself, so flipping the parents cannot flip it",
  );

  // `instantOf` is what makes that sort honest across the two stored shapes.
  assert.match(
    source,
    /function instantOf\(value: string\)/,
    "a reply written by the app and one written by the importer must compare",
  );
  assert.match(
    source,
    /\$\{value\.replace\(" ", "T"\)\}Z/,
    "CURRENT_TIMESTAMP is UTC with no zone marker; Date.parse would read it local",
  );
});

/* ── 2. There is a Reply control, and it reaches the API ─────────────────── */

test("every comment card carries a Reply button, replies included", async () => {
  const panel = await read(PANEL);

  // Two of them: the parent's, and the one on each reply. Stage 24 gave the
  // control to parents only; the capture says monday puts it on both.
  const buttons = panel.split('<Icon name="reply" size={14} />').length - 1;
  assert.equal(buttons, 2, `expected Reply on a card and on a reply, found ${buttons}`);

  assert.match(
    panel,
    /setReplyingUnder\(update\.id\)/,
    "Reply names the comment it answers",
  );
  assert.match(
    panel,
    /const \[replyingUnder, setReplyingUnder\] = useState<string \| null>\(null\)/,
    "one open reply box at a time, as monday does it",
  );
  assert.match(
    panel,
    /\{replyingUnder === update\.id && \(/,
    "the box opens inside the card it belongs to",
  );
  /*
   * A reply's Reply posts under the SAME parent and seeds the mention. monday's
   * threads are one level deep, and the data model has no second level either —
   * a control that appeared to nest would write a row that could not be drawn.
   */
  assert.match(panel, /\?\.focus\(`@\$\{reply\.authorName\} `\)/);

  // The button and its box need styling that exists.
  const css = await read(CSS);
  for (const rule of [
    ".update-action",
    ".update-composer--reply",
    ".update-composer__tools",
    ".update-composer__files",
  ]) {
    assert.ok(css.includes(rule), `${rule} has no styling`);
  }
});

test("the composer's parentId reaches the POST body", async () => {
  const drawer = await read(DRAWER);

  // `addRequestNote` posted `{ requestId, body }` and nothing else, so the
  // route's `parentId` branch was unreachable from the app.
  const poster = drawer.slice(
    drawer.indexOf("const addRequestNote = async"),
    drawer.indexOf("const addRequestNote = async") + 1800,
  );
  assert.match(poster, /parentId: options\.parentId \?\? null/, "a reply is a comment with a parent");
  assert.match(poster, /attachmentIds: options\.attachmentIds \?\? \[\]/);

  // And the reply box is what supplies it.
  const panel = await read(PANEL);
  assert.match(
    panel,
    /await post\(body, update\.id, files\)/,
    "the reply box submits under the card it is open in",
  );
  assert.match(
    panel,
    /onSubmit=\{\(body, files\) => post\(body, null, files\)\}/,
    "and the top composer posts a parentless update",
  );
});

test("the drawer's onAddUpdate contract carries the parent and the files", async () => {
  const drawer = await read(DRAWER);

  const signature = drawer.slice(drawer.indexOf("onAddUpdate: ("), drawer.indexOf("onAddUpdate: (") + 240);
  assert.match(signature, /parentId\?: string \| null/);
  assert.match(signature, /attachmentIds\?: string\[\]/);
  assert.match(signature, /=> Promise<void>/);
});

test("the route still refuses a parent that is not on this job", async () => {
  const source = await read(ROUTE);

  // Untouched by Stage 24 and re-pinned here, because the new caller makes it
  // reachable: a caller could otherwise thread their words under someone
  // else's conversation.
  const guard = source.slice(source.indexOf("if (parentId) {"));
  assert.match(guard.slice(0, 700), /eq\(itemUpdates\.organisationId, orgId\)/);
  assert.match(guard.slice(0, 700), /eq\(itemUpdates\.requestId, requestId\)/);
  assert.match(guard.slice(0, 900), /That comment is not on this job\./);
});

/* ── 3. A saved comment appears without re-mounting the drawer ───────────── */

test("saving a comment re-reads the thread", async () => {
  const drawer = await read(DRAWER);

  const submit = drawer.slice(
    drawer.indexOf("const submitComment = useCallback("),
    drawer.indexOf("const stageOrder: RequestStage[]"),
  );
  assert.match(submit, /await onAddUpdate\(body, \{ parentId, attachmentIds \}\)/);
  assert.match(
    submit,
    /await loadUpdates\(\)/,
    "without this the POST succeeded and the thread never changed",
  );
  assert.match(
    submit,
    /await loadActivities\(\)/,
    "the Activity Log is a second reader and still needs telling",
  );

  // The composer must go through it rather than calling onAddUpdate directly.
  // It is the panel's `onSubmit` now, so there is one path and no second
  // caller that could skip the re-read.
  assert.match(
    drawer,
    /onSubmit=\{submitComment\}/,
    "the panel writes through the drawer's own submit, not straight to the API",
  );
  const panel = await read(PANEL);
  assert.doesNotMatch(
    panel,
    /fetch\("\/api\/updates", \{\s*method: "POST"/,
    "the panel must not learn to POST a comment behind the drawer's back",
  );
});

test("the Updates tab counts the thread it fetched, not the board's snapshot", async () => {
  const drawer = await read(DRAWER);

  assert.match(
    drawer,
    /const threadCount = updates\.reduce\(/,
    "one number for the tab and the header",
  );
  assert.match(
    drawer,
    /const commentCount = updatesLoaded \? threadCount : request\.commentCount/,
    "the row snapshot is the fallback for the moment before the thread answers",
  );
  assert.match(drawer, /Updates \/ \{commentCount\}/);
  assert.doesNotMatch(
    drawer,
    /Updates \/ \{request\.commentCount\}/,
    "reading the snapshot is what made the tab and the header disagree after a post",
  );
  assert.match(drawer, /\{threadCount\} shown/);
});

test("a failed save keeps the draft instead of clearing the box", async () => {
  const drawer = await read(DRAWER);

  // `addRequestNote` used to `setToast(...)` and return normally, so the
  // drawer's `await onAddUpdate(...)` resolved, its catch never ran, and it
  // cleared the box on a save that had failed — the caller's words gone.
  const poster = drawer.slice(
    drawer.indexOf("const addRequestNote = async"),
    drawer.indexOf("const addRequestNote = async") + 2400,
  );
  assert.match(
    poster,
    /throw new Error\(payload\.error \?\? "That comment could not be saved\."\)/,
    "a failed write has to reach the drawer's catch",
  );
});

/* ── 4. The year is back, and the visible form is relative ───────────────── */

test("comment times are relative on the card and exact, with the year, on hover", async () => {
  const drawer = await read(DRAWER);
  const panel = await read(PANEL);

  /*
   * The pair is `shortRelativeTime` and `exactMoment` now.
   *
   * Stage 24's `formatRelativeTime` said "11 days ago"; monday says `11d`, and
   * at the size this panel draws — a bold name, the time, Like and Reply all on
   * one line — the long form wrapped that line on a phone. The bug being
   * guarded is unchanged and is the reason the terse form is safe: the exact
   * instant, WITH THE YEAR, is still on the hover of the same element.
   */
  assert.match(panel, /export function shortRelativeTime\(value: string \| null, now: number\)/);
  assert.match(panel, /function exactMoment\(value: string \| null\)/);

  const exact = panel.slice(
    panel.indexOf("function exactMoment"),
    panel.indexOf("function exactMoment") + 600,
  );
  /*
   * The year is the whole point on a 2023–2026 archive. It used to be an
   * `Intl` option spelled out here; the thread now writes its dates through
   * app/lib/format-date.ts like every other screen, and `formatLongDate` is the
   * form that carries the year in words — "24 November 2026". Asserting the
   * call rather than the option keeps the property and stops this failing on
   * the next legitimate move of where the option is written.
   */
  assert.match(exact, /formatLongDate\(/, "the year is the whole point on a 2023–2026 archive");
  const shared = await read("app/lib/format-date.ts");
  assert.match(
    shared.slice(shared.indexOf("  long:")),
    /^ {2}long: \{ day: "numeric", month: "long", year: "numeric" \},/m,
    "and formatLongDate must actually carry it",
  );

  // Both comment call sites — the parent card and the reply card — pair them.
  const pairings = [...panel.matchAll(
    /title=\{exactMoment\((update|reply)\.createdAt\)\}/g,
  )].map((match) => match[1]);
  assert.deepEqual(
    pairings.sort(),
    ["reply", "update"],
    "a reply needs the year as much as a parent does",
  );
  const visible = [...panel.matchAll(/shortRelativeTime\((update|reply)\.createdAt, now\)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(visible.sort(), ["reply", "update"]);

  // And no card time comes from the shared formatter, which drops the year.
  assert.doesNotMatch(panel, /formatDate\(/);

  /*
   * And the COMMENT CARDS must no longer use the shared formatter, which drops
   * the year whenever it is asked for a time.
   *
   * Scoped to the Updates section on purpose. The Activity Log below it draws
   * `formatDate(entry.createdAt, true)` over its own `entry`, and should: an
   * audit entry is read against today, a comment against a three-year archive.
   * A whole-file assertion here would demand a change to a section this stage
   * never touched.
   */
  const section = updatesSection(drawer);
  assert.doesNotMatch(section, /formatDate\(entry\.createdAt, true\)/);
  assert.doesNotMatch(section, /formatDate\(reply\.createdAt, true\)/);
  assert.doesNotMatch(section, /\{formatDate\(/, "no comment time comes from the shared formatter");
});

test("the shared formatDate is left exactly as it was", async () => {
  const drawer = await read(DRAWER);

  // Twelve other call sites depend on its current shape, which is why the
  // comment cards got their own formatter rather than this one being widened.
  const shared = drawer.slice(
    drawer.indexOf("function formatDate(value: string | null, includeTime = false)"),
  );
  const body = shared.slice(0, shared.indexOf("\n}\n") + 3);
  assert.match(body, /includeTime/, "the shared formatter still takes its flag");
  assert.ok(
    drawer.split("formatDate(").length - 1 >= 10,
    "the shared formatter still has its other callers — nothing was removed",
  );
});

test("a relative time ticks rather than going stale", async () => {
  const drawer = await read(DRAWER);

  const body = drawer.slice(drawer.indexOf("function RequestDrawer("));
  assert.match(
    body.slice(0, 4000),
    /const now = useCurrentTime\(\)/,
    "'2 months ago' is only honest if something re-renders it",
  );
});

test("both stored timestamp shapes are read as UTC", async () => {
  const panel = await read(PANEL);

  /*
   * `item_updates.created_at` holds ISO with a Z for the 265 imported rows and
   * SQLite's CURRENT_TIMESTAMP — UTC, a space, no zone marker — for every row
   * the app writes. `Date.parse` reads the second as LOCAL time, so a comment
   * saved a minute ago renders as `1h` in Britain in summer.
   *
   * BOTH readers have to do it. They are separate functions here, and a fix
   * applied to one of them is the shape this bug would come back in.
   */
  // Read with the explanations stripped: both functions carry a comment about
  // this very bug, and a raw search would find the description and call the
  // fix present.
  const code = withoutComments(panel);
  for (const helper of ["shortRelativeTime", "exactMoment"]) {
    const body = code.slice(
      code.indexOf(`function ${helper}(`),
      code.indexOf(`function ${helper}(`) + 420,
    );
    assert.match(body, /\^\\d\{4\}-\\d\{2\}-\\d\{2\} \\d\{2\}:\\d\{2\}:\\d\{2\}\$/, helper);
    assert.match(body, /\$\{value\.replace\(" ", "T"\)\}Z/, helper);
  }
});

/* ── 5. A comment can carry a file ───────────────────────────────────────── */

test("the composer has a file picker and holds the choice until save", async () => {
  const drawer = await read(DRAWER);
  const panel = await read(PANEL);

  assert.match(panel, /<input\s+ref=\{picker\}\s+type="file"/);
  assert.match(panel, /aria-label="Attach a file"/, "the paperclip, which is one of monday's four");
  assert.match(panel, /const \[files, setFiles\] = useState<File\[\]>\(\[\]\)/);

  // Uploaded on save, not on pick, so cancelling costs nothing. The upload
  // stayed with the drawer: it is the half that talks to `/api/files`.
  const submit = drawer.slice(
    drawer.indexOf("const submitComment = useCallback("),
    drawer.indexOf("const stageOrder: RequestStage[]"),
  );
  assert.match(submit, /await uploadEvidenceFile\(\{/);
  assert.match(submit, /attachmentIds\.push\(uploaded\.file\.id\)/);

  // A sent comment drops its pending files rather than leaving them for the
  // next one to adopt — and only AFTER the submit resolves, because `post`
  // rethrows and a cleared box on a failed save is a lost comment.
  const send = panel.slice(panel.indexOf("const send = async ()"), panel.indexOf("const send = async ()") + 400);
  assert.ok(
    send.indexOf("await onSubmit(body, files)") < send.indexOf("setFiles([])"),
    "the box must not be emptied before the write has succeeded",
  );
  assert.match(send, /setFiles\(\[\]\)/);
});

test("the route stamps update_id only on unclaimed files on this job", async () => {
  const source = await read(ROUTE);

  assert.match(source, /const attachmentIds = Array\.isArray\(payload\.attachmentIds\)/);
  assert.match(source, /\.slice\(0, 20\)/, "a caller must not hand over an unbounded list");

  const claim = source.slice(source.indexOf("if (attachmentIds.length) {"));
  assert.match(claim.slice(0, 600), /\.set\(\{ updateId: id \}\)/);
  assert.match(claim.slice(0, 600), /eq\(attachments\.organisationId, orgId\)/);
  assert.match(claim.slice(0, 600), /eq\(attachments\.requestId, requestId\)/);
  assert.match(
    claim.slice(0, 600),
    /isNull\(attachments\.updateId\)/,
    "a file already on an earlier comment must not be re-parented",
  );
  assert.match(claim.slice(0, 600), /inArray\(attachments\.id, attachmentIds\)/);

  /*
   * THE COMMENT IS INSERTED FIRST. Stamping before the comment exists leaves a
   * row pointing at an `update_id` that was never written if the insert fails.
   * This way the worst case is an upload that stays on the job as ordinary
   * evidence — visible, rather than a dangling reference.
   */
  assert.ok(
    source.indexOf("await db.insert(itemUpdates)") < source.indexOf("if (attachmentIds.length) {"),
    "the comment must exist before anything is stamped onto it",
  );

  // Nothing is deleted and update_id is only ever set.
  assert.doesNotMatch(source, /\.delete\(attachments\)/);
  assert.doesNotMatch(source, /updateId: null/);
});

test("the comment count is recomputed from a COUNT, never incremented", async () => {
  const source = await read(ROUTE);

  assert.match(
    source,
    /commentCount: sql`\(SELECT COUNT\(\*\) FROM item_updates u WHERE u\.request_id = \$\{requestId\}\)`/,
    "two writers on one denormalised column with no reconciler is the old bug",
  );
  assert.doesNotMatch(source, /commentCount: sql`.*\+ 1`/);
});

/* ── 8. The Updates section owns its three states ────────────────────────── */

function updatesSection(drawer) {
  const from = drawer.indexOf('<span className="drawer-label">Update thread</span>');
  const to = drawer.indexOf('<span className="drawer-label">Activity history</span>');
  assert.ok(from > 0 && to > from, "could not find the Updates section");
  return drawer.slice(from, to);
}

/**
 * The same slice with its explanations removed.
 *
 * Every one of these fixes carries a comment naming the thing it replaced —
 * "these read `activitiesLoading`", "the second 'Loading updates…' is gone" —
 * so a search of the raw text finds the defect described and calls it present.
 * Stripping the comments is what makes these assertions about the code.
 */
function withoutComments(source) {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("the Updates section reads its own loading, error and empty states", async () => {
  const drawer = await read(DRAWER);
  const panel = await read(PANEL);

  // The three states are the panel's, and they are fed the thread's own flags.
  assert.match(panel, /\{loading && updates\.length === 0 && \(/);
  assert.match(panel, /\{error && \(/);
  assert.match(panel, /onClick=\{\(\) => void onReload\(\)\}/, "Try again must retry the thread");
  assert.match(panel, /\{!loading && !error && updates\.length === 0 && \(/);

  // The thread is gated on the error too, or the box and the thread render at
  // the same time — which is what happened.
  assert.match(panel, /\{!error &&\s*updates\.map\(\(update\) => \(/);

  const section = updatesSection(drawer);
  assert.match(section, /loading=\{updatesLoading\}/);
  assert.match(section, /error=\{updatesError\}/);
  assert.match(section, /onReload=\{loadUpdates\}/);

  /*
   * And neither of them may reach for the Activity Log's.
   *
   * A failed ACTIVITY fetch used to draw "The update history could not be
   * loaded" above a thread that had loaded perfectly well, with a Try again
   * that re-fetched the wrong thing. The section is four props wide now, which
   * is what makes that mistake hard to make again — but the check is kept,
   * because the props are passed by name and the wrong name would still bind.
   */
  const code = withoutComments(section) + withoutComments(panel);
  for (const borrowed of ["activitiesLoading", "activitiesError", "loadActivities()"]) {
    assert.ok(
      !code.includes(borrowed),
      `the Updates panel still borrows ${borrowed} from the Activity Log`,
    );
  }
});

test("a thread that fails to load says so instead of reading as empty", async () => {
  const drawer = await read(DRAWER);

  const loader = drawer.slice(
    drawer.indexOf("const loadUpdates = useCallback("),
    drawer.indexOf("const loadUpdates = useCallback(") + 1400,
  );
  assert.match(loader, /setUpdatesError\(null\)/, "a retry clears the previous failure");
  assert.match(loader, /setUpdatesError\("The update thread could not be loaded\."\)/);
  assert.match(
    loader,
    /setUpdatesLoaded\(false\)/,
    "a failed fetch must not be counted as an answer, or the tab would read 0",
  );
});

test("there is exactly one 'Loading updates…' banner", async () => {
  const drawer = await read(DRAWER);

  // There were two: the Activity Log's state at the top of the section and the
  // section's own at the bottom, so a loaded thread could appear between two
  // banners saying it had not arrived. Counted on the rendered string rather
  // than the words, which also appear in the comments explaining the removal.
  const panel = await read(PANEL);
  const banners =
    drawer.split(">Loading updates…<").length - 1 + (panel.split(">Loading updates…<").length - 1);
  assert.equal(banners, 1, `expected one loading banner, found ${banners}`);

  // And the one that stayed is the panel's, reading the panel's own state.
  assert.match(withoutComments(panel), /\{loading && updates\.length === 0 && \(/);
});

test("the Activity Log keeps the states the Updates section stopped borrowing", async () => {
  const drawer = await read(DRAWER);
  const from = drawer.indexOf('<span className="drawer-label">Activity history</span>');
  const section = drawer.slice(from, from + 3000);

  // REMOVE NOTHING: the fix moved the Updates section off these, it did not
  // take them away from the section that owns them.
  assert.match(section, /\{activitiesLoading && \(/);
  assert.match(section, /\{activitiesError && \(/);
  assert.match(section, /void loadActivities\(\)/);
  assert.match(section, /Loading activity…/);
});

/* ── Nothing was removed ─────────────────────────────────────────────────── */

test("the drawer keeps every capability it had", async () => {
  const drawer = await read(DRAWER);
  const panel = await read(PANEL);
  const both = drawer + panel;

  /*
   * The class names changed; the capabilities may not.
   *
   * This test used to name `drawer-update-card` and friends, which was the
   * right check while the panel was drawn inline and the wrong one the moment
   * it moved — a rename would have failed it while nothing was missing, and it
   * would have gone on passing if the whole panel had been deleted from the
   * drawer, because the string still appeared in the module nobody rendered.
   * So it asks for the things themselves, across both files, and separately
   * pins that the drawer actually mounts the panel.
   */
  assert.match(drawer, /<UpdateThread$/m, "the drawer has to RENDER it, not merely import it");
  for (const survivor of [
    "update-composer",
    "update-panel",
    "update-card",
    "update-file",
    "Update thread",
    "Activity history",
  ]) {
    assert.ok(both.includes(survivor), `${survivor} was removed`);
  }
  // The empty state kept its job and lost its apology: it now says where the
  // first update goes.
  assert.match(panel, /No updates yet\. The box above is where the first one goes\./);
});

test("the footer buttons still reach the composer, which is no longer theirs", async () => {
  const drawer = await read(DRAWER);
  const panel = await read(PANEL);

  /*
   * "Write an update" and "Add update" put the cursor in the box.
   *
   * They held `composerRef` — a `RefObject<HTMLTextAreaElement>` on a textarea
   * the drawer rendered itself. That textarea is the panel's now, along with
   * its draft and its file list, so the ref would have gone on pointing at
   * null and the two buttons would have switched tab and done nothing else:
   * a control that half-works, which is worse than one that is missing.
   */
  assert.match(panel, /composerRef\?: \(handle: ComposerHandle \| null\) => void;/);
  assert.match(panel, /handleRef=\{composerRef\}/, "the TOP composer is the one handed up");
  assert.match(drawer, /composerRef=\{setComposerHandle\}/);

  const presses = [...drawer.matchAll(/composerHandle\.current\?\.focus\(\)/g)].length;
  assert.equal(presses, 2, `expected both footer buttons to focus the box, found ${presses}`);
  assert.doesNotMatch(
    drawer,
    /useRef<HTMLTextAreaElement>\(null\)/,
    "the drawer must not keep a ref to a textarea it no longer renders",
  );
});

test("an update with no words still draws, because it is a picture", async () => {
  const panel = await read(PANEL);

  // Three of monday's updates are photographs with no caption. An empty <p>
  // would draw its padding above the image and read as a rendering fault.
  assert.match(panel, /\{update\.body && <UpdateBody body=\{update\.body\} \/>\}/);
  assert.match(panel, /\{reply\.body && <UpdateBody body=\{reply\.body\} \/>\}/);
});

/* ── Live, read-only, against a running dev server ───────────────────────── */

async function signIn() {
  try {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (!response.ok) return null;
    return (response.headers.getSetCookie?.() ?? [])
      .map((raw) => raw.split(";")[0])
      .join("; ");
  } catch {
    return null;
  }
}

const SOLIHULL = "req_595e9db270eb4905bfda236ddeef6429";

test("the live thread comes back newest first with ascending replies", async (t) => {
  const cookie = await signIn();
  if (!cookie) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }

  const response = await fetch(`${BASE_URL}/api/updates?requestId=${SOLIHULL}`, {
    headers: { Accept: "application/json", cookie },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.updates.length >= 2, "expected the Solihull thread");

  const parents = payload.updates.map((update) => Date.parse(update.createdAt));
  for (let index = 1; index < parents.length; index += 1) {
    assert.ok(
      parents[index - 1] >= parents[index],
      "the live route must answer newest first, as the capture does",
    );
  }

  for (const parent of payload.updates) {
    const replies = parent.replies.map((reply) =>
      Date.parse(reply.createdAt.replace(" ", "T").replace(/(\d{2}:\d{2}:\d{2})$/, "$1Z")),
    );
    for (let index = 1; index < replies.length; index += 1) {
      assert.ok(
        replies[index - 1] <= replies[index],
        "a conversation under one comment reads oldest first",
      );
    }
  }
});

test("the live route refuses a job from outside the session's workspace", async (t) => {
  const cookie = await signIn();
  if (!cookie) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }

  const response = await fetch(`${BASE_URL}/api/updates?requestId=req_does_not_exist`, {
    headers: { Accept: "application/json", cookie },
  });
  assert.equal(response.status, 404, "an unknown job and a foreign one answer alike");
});

test("a caller with no session is refused rather than 500ing", async () => {
  const source = await read(ROUTE);

  /*
   * Asserted on the source rather than over HTTP.
   *
   * `demoIdentityAllowed()` in tenant-access.ts hands a development server's
   * anonymous caller the demo identity on purpose, so a live request here
   * answers 200 on this machine and 401 in production. That would make the
   * test a statement about which machine it ran on. What matters is that the
   * route still routes a session failure to `anonymousRefusal` — a 401 — and
   * not to an uncaught throw, which is a 500 reading "the server is broken" to
   * somebody whose session has simply ended.
   */
  const guard = source.slice(source.indexOf("try {"), source.indexOf("const requestId ="));
  assert.match(guard, /const refusal = anonymousRefusal\(error\)/);
  assert.match(guard, /if \(refusal\) return refusal/);
  assert.match(guard, /status: 503/, "anything else is unavailable, not broken");
});
