import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import {
  attachments,
  itemUpdateLikes,
  itemUpdates,
  maintenanceRequests,
} from "../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../lib/tenant-db";
import {
  automationContext,
  dispatchAutomationEvents,
  updateCreatedEvent,
} from "../../lib/automations";
import { boardKeyForRequest } from "../../lib/board-registry";
import { isBoardDiscussionId } from "../board/discussion/discussion-store";

export const dynamic = "force-dynamic";

/**
 * The conversation on one job — monday's "Updates".
 *
 * `item_updates` has existed since Stage 3 and nothing has ever read it. The
 * drawer's Updates tab derived its thread from `activity_log` rows whose action
 * was `request.note_added`, which meant the 218 comments and 47 replies
 * imported from monday were invisible: the tab counted them correctly from
 * `comment_count` and then rendered "No detailed updates have been added yet"
 * — the counter right, the thread empty, and the empty state explaining the
 * absence as expected.
 *
 * REPLIES ARE CHILDREN, NOT A FLATTENED LIST. `parent_id` was already in the
 * schema and the import already uses it, so the nesting monday has survives to
 * the screen. Returned as a tree rather than assembled in the client, because
 * two clients assembling the same tree is how two clients come to disagree
 * about it.
 */

type UpdateRow = typeof itemUpdates.$inferSelect;

/**
 * `created_at` as an instant, whichever of the two shapes it is in.
 *
 * The importer writes ISO with a Z; a row written by the app takes the column
 * default and gets SQLite's CURRENT_TIMESTAMP, which is UTC with a space and no
 * zone marker. Left alone, `Date.parse` reads the second as LOCAL time, so two
 * comments a minute apart can sort an hour apart. The Z is added back before
 * parsing rather than guessing.
 */
function instantOf(value: string) {
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = Date.parse(normalised);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** What a caller may see. Deliberately not the whole row. */
function expose(row: UpdateRow) {
  return {
    id: row.id,
    parentId: row.parentId,
    authorName: row.authorName,
    // The email is kept because the drawer colours an avatar from it, but it is
    // an author's address on a job the caller can already read — not a
    // directory. Nothing else about the author is exposed.
    authorEmail: row.authorEmail,
    body: row.body,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
  };
}

export async function GET(request: Request) {
  await ensureDatabase();

  /*
   * Wrapped because `scopedDb` throws for a caller with no session, and an
   * uncaught throw here is a 500 — "the server is broken" for somebody whose
   * session has simply ended. Every other read route already answers 401.
   */
  let db: Awaited<ReturnType<typeof scopedDb>>["db"];
  let orgId: string;
  let actor: Awaited<ReturnType<typeof scopedDb>>["actor"];
  try {
    ({ db, orgId, actor } = await scopedDb(request));
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      { error: "The comment thread is temporarily unavailable." },
      { status: 503 },
    );
  }

  const requestId = new URL(request.url).searchParams.get("requestId")?.trim();
  if (!requestId) {
    return Response.json({ error: "A job id is required." }, { status: 400 });
  }

  /*
   * Confirm the job belongs to this workspace before reading its thread.
   *
   * `item_updates` carries its own `organisation_id`, so filtering on that
   * alone would be safe — but a caller who can name a job id they cannot see
   * would still learn whether it exists from an empty list versus a 404. One
   * lookup removes the difference.
   */
  const [job] = await db
    .select({ id: maintenanceRequests.id })
    .from(maintenanceRequests)
    .where(
      and(
        eq(maintenanceRequests.id, requestId),
        eq(maintenanceRequests.organisationId, orgId),
        /*
         * Stage 23 — a job in the recycle bin is a 404 here, deliberately the
         * same 404 a job from another workspace gets. Comments cannot be read
         * from or added to something that is on its way out, and the caller
         * cannot tell "deleted" from "never existed".
         */
        isNull(maintenanceRequests.deletedAt),
      ),
    )
    .limit(1);
  if (!job) {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }

  const rows = await db
    .select()
    .from(itemUpdates)
    .where(
      and(
        eq(itemUpdates.organisationId, orgId),
        eq(itemUpdates.requestId, requestId),
      ),
    )
    /*
     * NEWEST COMMENT FIRST, which is what monday does and what the capture
     * proves.
     *
     * `db/monday-export/api-pull/comments.json` returns each item's `updates`
     * array newest first — every one of the 23 maintenance items that has more
     * than one update is in descending `created_at`, none ascending. Item
     * 1220379822 reads 2023-09-13 -> 2023-09-07 -> 2023-09-07 -> 2023-08-31 ->
     * 2023-08-10 -> 2023-08-04 -> 2023-07-21.
     *
     * This was `asc`, so the drawer showed the same thread upside down: on the
     * Solihull job the newest comment — the one that says what is happening now
     * — sat 2,379px down a 2,604px scroller, under eight older ones. A thread
     * you have to scroll to the bottom of to learn the current state is a
     * thread nobody reads.
     *
     * REPLIES ARE NOT REVERSED WITH IT. Inside a parent, monday keeps the
     * conversation oldest first (9 of the 10 multi-reply threads in the capture
     * are ascending) and so does this route — see the explicit sort below,
     * which is deliberately not left to inherit this ORDER BY.
     *
     * Sorted through `datetime()` rather than on the raw column because
     * `created_at` holds two shapes: the importer writes ISO
     * ("2026-08-04T12:52:20.000Z", 265 rows) and a row written by the app takes
     * the column default, which is SQLite's CURRENT_TIMESTAMP
     * ("2026-08-09 08:27:34", 43 rows). A plain string sort puts every
     * space-separated row before every T-separated one on the same date,
     * because " " < "T" — so on the day a comment is added the newest could
     * land under an older one. `datetime()` reads both and returns one shape.
     */
    .orderBy(sql`datetime(${itemUpdates.createdAt}) DESC`);

  /*
   * The files attached to those comments.
   *
   * monday's updates carry their own assets and they belong to the comment —
   * a quote PDF, a photo of the part. One query for the whole thread rather
   * than one per comment: a job with twelve comments would otherwise be twelve
   * round trips to draw one panel.
   *
   * Only what is needed to draw a chip. No object key, no uploader.
   */
  const fileRows = await db
    .select({
      id: attachments.id,
      updateId: attachments.updateId,
      originalName: attachments.originalName,
      contentType: attachments.contentType,
      byteSize: attachments.byteSize,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.organisationId, orgId),
        eq(attachments.requestId, requestId),
        isNotNull(attachments.updateId),
      ),
    );

  const filesByUpdate = new Map<string, Array<Record<string, unknown>>>();
  for (const file of fileRows) {
    if (!file.updateId) continue;
    const list = filesByUpdate.get(file.updateId) ?? [];
    list.push({
      id: file.id,
      name: file.originalName,
      contentType: file.contentType,
      byteSize: file.byteSize,
      // Derived here so the storage path never reaches the browser.
      url: `/api/files/${file.id}`,
      thumbUrl: `/api/files/${file.id}?thumb=1`,
    });
    filesByUpdate.set(file.updateId, list);
  }

  /*
   * The likes on the whole thread, in one query.
   *
   * Every row for these updates rather than a GROUP BY, because the panel needs
   * three things from them and only one is a number: the count, whether the
   * reader is among them, and the names behind the count for the hover. A
   * COUNT(*) would answer the first and force a second query for the rest.
   *
   * Bounded by the thread — a job's updates, not a workspace's — so the row
   * count here is on the order of the comments on one job.
   */
  const updateIds = rows.map((row) => row.id);
  const likeRows = updateIds.length
    ? await db
        .select({
          updateId: itemUpdateLikes.updateId,
          actorEmail: itemUpdateLikes.actorEmail,
          actorName: itemUpdateLikes.actorName,
        })
        .from(itemUpdateLikes)
        .where(
          and(
            eq(itemUpdateLikes.organisationId, orgId),
            inArray(itemUpdateLikes.updateId, updateIds),
          ),
        )
    : [];

  /*
   * Compared lower-cased, on both sides.
   *
   * The write path stores whatever the session carries and the addresses in
   * this workspace are not consistently cased — an actor signed in as
   * `Anwar@…` would otherwise see their own like as somebody else's, and the
   * thumb would sit hollow next to a count of one that was theirs.
   */
  const me = (actor.email ?? "").trim().toLowerCase();
  const likesByUpdate = new Map<string, { count: number; mine: boolean; names: string[] }>();
  for (const like of likeRows) {
    const entry = likesByUpdate.get(like.updateId) ?? { count: 0, mine: false, names: [] };
    entry.count += 1;
    if (me && like.actorEmail.trim().toLowerCase() === me) entry.mine = true;
    // Capped: the hover is a list of people, and past a dozen it is a paragraph.
    if (entry.names.length < 12) entry.names.push(like.actorName);
    likesByUpdate.set(like.updateId, entry);
  }

  const withFiles = (row: UpdateRow) => {
    const likes = likesByUpdate.get(row.id);
    return {
      ...expose(row),
      files: filesByUpdate.get(row.id) ?? [],
      likeCount: likes?.count ?? 0,
      likedByMe: likes?.mine ?? false,
      likedBy: likes?.names ?? [],
    };
  };

  const parents = rows.filter((row) => !row.parentId).map(withFiles);
  const byParent = new Map<string, ReturnType<typeof withFiles>[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const list = byParent.get(row.parentId) ?? [];
    list.push(withFiles(row));
    byParent.set(row.parentId, list);
  }
  /*
   * A reply list runs oldest first, and says so here rather than depending on
   * the query above.
   *
   * The parent list is newest first because that is monday's thread order; a
   * conversation UNDER one comment is the opposite — it reads as a sequence,
   * question then answer, and reversing it makes the answer precede the
   * question. Sorting explicitly means changing the top-level ORDER BY can
   * never silently flip the replies with it, which is exactly what would have
   * happened had this been left to inherit.
   */
  for (const list of byParent.values()) {
    list.sort((left, right) => instantOf(left.createdAt) - instantOf(right.createdAt));
  }

  return Response.json({
    requestId,
    updates: parents.map((parent) => ({
      ...parent,
      replies: byParent.get(parent.id) ?? [],
    })),
    // Both, because they answer different questions: how many bubbles to draw,
    // and how many things were said.
    total: rows.length,
    topLevel: parents.length,
  });
}

/**
 * Adds a comment, or a reply to one.
 *
 * The app's existing "Add an update" composer wrote to `activity_log` and
 * incremented `comment_count`. That is why the two disagreed: one writer put
 * text in the audit log, another put text in `item_updates`, and the counter
 * was maintained by whichever ran last. This is the single writer.
 */
export async function POST(request: Request) {
  await ensureDatabase();

  const guard = await scopedDbWithCapability(request, "board.edit");
  if (guard.denied) return guard.denied;
  const { db, orgId, actor } = guard.scope;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Send a comment." }, { status: 400 });
  }

  const requestId = typeof payload.requestId === "string" ? payload.requestId.trim() : "";
  const body = typeof payload.body === "string" ? payload.body.trim().slice(0, 8000) : "";
  const parentId =
    typeof payload.parentId === "string" && payload.parentId.trim()
      ? payload.parentId.trim()
      : null;
  /*
   * Files this comment is claiming, uploaded a moment ago through
   * `/api/files`.
   *
   * Ids only — the bytes are already in R2 and the row already exists on the
   * job. All this route does is say which comment they belong to, which is the
   * one thing nothing in the app could do: `attachments.update_id` is read by
   * the GET above and by the drawer's chips, 53 imported rows carry it, and no
   * writer ever set it. Capped so a caller cannot hand over an unbounded list.
   */
  const attachmentIds = Array.isArray(payload.attachmentIds)
    ? payload.attachmentIds
        .filter((value): value is string => typeof value === "string" && !!value.trim())
        .map((value) => value.trim())
        .slice(0, 20)
    : [];

  if (!requestId || !body) {
    return Response.json({ error: "A job and a comment are required." }, { status: 400 });
  }

  const [job] = await db
    .select({ id: maintenanceRequests.id })
    .from(maintenanceRequests)
    .where(
      and(
        eq(maintenanceRequests.id, requestId),
        eq(maintenanceRequests.organisationId, orgId),
        /*
         * Stage 23 — a job in the recycle bin is a 404 here, deliberately the
         * same 404 a job from another workspace gets. Comments cannot be read
         * from or added to something that is on its way out, and the caller
         * cannot tell "deleted" from "never existed".
         */
        isNull(maintenanceRequests.deletedAt),
      ),
    )
    .limit(1);
  if (!job) {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }

  // A reply must hang off a comment on THIS job, or a caller could thread their
  // words under someone else's conversation.
  if (parentId) {
    const [parent] = await db
      .select({ id: itemUpdates.id })
      .from(itemUpdates)
      .where(
        and(
          eq(itemUpdates.id, parentId),
          eq(itemUpdates.organisationId, orgId),
          eq(itemUpdates.requestId, requestId),
        ),
      )
      .limit(1);
    if (!parent) {
      return Response.json(
        { error: "That comment is not on this job." },
        { status: 400 },
      );
    }
  }

  const id = `upd_${crypto.randomUUID().replace(/-/g, "")}`;
  /*
   * THE BOARD THE JOB IS ACTUALLY ON, resolved from its placement.
   *
   * This wrote the literal "maintenance". `maintenance_requests` carries no
   * board id - membership is `maintenance_group_items.board_id` - so the
   * literal was right only while every commentable row was on the job board.
   * Since W02-06 a section has a register of its own, and a comment left on one
   * of its rows was filed under `board_id = 'maintenance'`: invisible in the
   * instance's own updates feed, and present in the job board's. A leak in both
   * directions, from one word.
   *
   * `boardKeyForRequest` is the same resolution `attachment-counts.ts` and the
   * job-link route already use, so all three agree about where a row lives.
   */
  const boardId = await boardKeyForRequest(db, orgId, requestId);
  await db.insert(itemUpdates).values({
    id,
    organisationId: orgId,
    boardId,
    requestId,
    parentId,
    authorName: actor.displayName || actor.email,
    authorEmail: actor.email ?? null,
    body,
  });

  /*
   * The comment first, then its files — in that order, deliberately.
   *
   * The alternative, stamping before the comment exists, leaves a row pointing
   * at an `update_id` that was never written if the insert above fails. This
   * way the worst case is an upload that stays on the job as ordinary evidence:
   * still in the Files tab, still attributable, still deletable — visible,
   * rather than a dangling reference.
   *
   * Scoped to this workspace, this job, and to rows nobody has claimed yet, so
   * a caller cannot move somebody else's file onto their comment or re-parent a
   * file that already belongs to an earlier one. `update_id` is only ever set,
   * never cleared, and no row is deleted.
   */
  let attached = 0;
  if (attachmentIds.length) {
    const claimed = await db
      .update(attachments)
      .set({ updateId: id })
      .where(
        and(
          eq(attachments.organisationId, orgId),
          eq(attachments.requestId, requestId),
          isNull(attachments.updateId),
          inArray(attachments.id, attachmentIds),
        ),
      )
      .returning({ id: attachments.id });
    attached = claimed.length;
  }

  /*
   * Recomputed, never incremented.
   *
   * The importer sets this from a COUNT. If this route incremented instead, a
   * re-import would silently zero out whatever the app had added — two writers
   * on one denormalised column with no reconciler, which is exactly how
   * `issue_attachment_count` came to read 2,281 with no rows behind it.
   */
  await db
    .update(maintenanceRequests)
    .set({
      commentCount: sql`(SELECT COUNT(*) FROM item_updates u WHERE u.request_id = ${requestId})`,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(maintenanceRequests.id, requestId),
        eq(maintenanceRequests.organisationId, orgId),
      ),
    );

  // The comment is written and counted; now the board's rules may react to it.
  await dispatchAutomationEvents(automationContext(guard.scope, request), [
    updateCreatedEvent(boardId, requestId, null),
  ]);

  // `attached` is reported rather than assumed: if a file was claimed by an
  // earlier comment the caller should be able to see that fewer landed than
  // were offered.
  return Response.json({ ok: true, id, attached });
}

/**
 * `👍 Like` — on, or off.
 *
 * A TOGGLE THE SERVER DECIDES, not one the client asserts. The obvious shape,
 * `{ liked: true }` from the browser, loses a race the moment the same person
 * has the job open twice: two panels both believing the thumb is hollow both
 * send `true`, and the second is a no-op that leaves one of them drawn wrong
 * forever. Here the row's presence is read and inverted inside the request, so
 * whichever arrives second flips whatever the first left behind, and both are
 * told what the truth now is.
 *
 * Gated on `board.view`, not `board.edit`. Liking says nothing about a job — it
 * changes no column, no stage, no cost — and a client who can read the thread
 * can acknowledge that they have read it. Writing WORDS still needs
 * `board.edit`, which is what POST above holds.
 */
export async function PUT(request: Request) {
  await ensureDatabase();

  const guard = await scopedDbWithCapability(request, "board.view");
  if (guard.denied) return guard.denied;
  const { db, orgId, actor } = guard.scope;

  /*
   * An email is required, and its absence is refused rather than filled in.
   *
   * The primary key is (update, email), so an actor with no address would take
   * the empty-string slot — and the SECOND such actor would silently "already"
   * have liked everything the first did. There is no anonymous like.
   */
  const email = (actor.email ?? "").trim();
  if (!email) {
    return Response.json(
      { error: "Sign in with an email address to like an update." },
      { status: 403 },
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Name an update." }, { status: 400 });
  }
  const updateId = typeof payload.updateId === "string" ? payload.updateId.trim() : "";
  if (!updateId) {
    return Response.json({ error: "Name an update." }, { status: 400 });
  }

  /*
   * The update must be in this workspace, on a job that is not in the bin.
   *
   * `item_updates` carries `organisation_id`, so that alone would keep the
   * write inside the tenant — but a like on a comment attached to a deleted job
   * would be a row nobody can ever see or remove, and the join costs one query.
   */
  let [target] = await db
    .select({ id: itemUpdates.id })
    .from(itemUpdates)
    .innerJoin(
      maintenanceRequests,
      and(
        eq(maintenanceRequests.id, itemUpdates.requestId),
        eq(maintenanceRequests.organisationId, orgId),
        isNull(maintenanceRequests.deletedAt),
      ),
    )
    .where(and(eq(itemUpdates.id, updateId), eq(itemUpdates.organisationId, orgId)))
    .limit(1);
  /*
   * A Board Discussion update has no job behind it — its `request_id` is
   * `board:<boardId>` (see app/api/board/discussion) — so the join above
   * cannot find it. The same workspace check applies; the bin check has
   * nothing to apply to.
   */
  if (!target) {
    const [boardUpdate] = await db
      .select({ id: itemUpdates.id, requestId: itemUpdates.requestId })
      .from(itemUpdates)
      .where(and(eq(itemUpdates.id, updateId), eq(itemUpdates.organisationId, orgId)))
      .limit(1);
    if (boardUpdate && isBoardDiscussionId(boardUpdate.requestId)) target = { id: boardUpdate.id };
  }
  if (!target) {
    return Response.json({ error: "That update is not on this board." }, { status: 404 });
  }

  const [existing] = await db
    .select({ updateId: itemUpdateLikes.updateId })
    .from(itemUpdateLikes)
    .where(
      and(
        eq(itemUpdateLikes.updateId, updateId),
        eq(itemUpdateLikes.actorEmail, email),
        eq(itemUpdateLikes.organisationId, orgId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .delete(itemUpdateLikes)
      .where(
        and(
          eq(itemUpdateLikes.updateId, updateId),
          eq(itemUpdateLikes.actorEmail, email),
          eq(itemUpdateLikes.organisationId, orgId),
        ),
      );
  } else {
    await db
      .insert(itemUpdateLikes)
      .values({
        updateId,
        organisationId: orgId,
        actorEmail: email,
        actorName: actor.displayName || email,
      })
      /* Two taps that cross in flight both find no row and both insert. The
         pair is the primary key, so the second would be a constraint error —
         a 500 for a double-click. Ignored instead: the state it wanted is the
         state that exists. */
      .onConflictDoNothing();
  }

  /*
   * The count is read back rather than adjusted by one.
   *
   * The client is about to draw this number, and the whole point of deciding
   * the toggle on the server is that it may not be the number the client
   * predicted — somebody else may have liked it in between.
   */
  const [tally] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(itemUpdateLikes)
    .where(
      and(
        eq(itemUpdateLikes.updateId, updateId),
        eq(itemUpdateLikes.organisationId, orgId),
      ),
    );

  return Response.json({
    ok: true,
    updateId,
    liked: !existing,
    likeCount: Number(tally?.count ?? 0),
  });
}
