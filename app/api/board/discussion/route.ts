/**
 * `/api/board/discussion?board=` — the Board Discussion thread.
 *
 *   GET   the thread, shaped exactly like `/api/updates` so `UpdateThread`
 *         draws it unchanged: parents newest first, replies oldest first,
 *         likes counted and attributed.
 *   POST  an update or a reply. `board.edit`, the same capability that writes
 *         words on an item — see `/api/updates`.
 *
 * Rows live in `item_updates` under `request_id = "board:<boardId>"`; see
 * `discussion-store.ts` for why that is a reuse and not a hack. Likes go
 * through `PUT /api/updates`, which recognises the same prefix.
 *
 * Attachments are not accepted here. `/api/files` files a upload against a
 * job, and a board has no job to file it under; saying so beats a chip that
 * points nowhere.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { itemUpdateLikes, itemUpdates } from "../../../../db/schema";
import { resolveBoardId } from "../../../lib/automations/store";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";
import { discussionRequestId } from "./discussion-store";

export const dynamic = "force-dynamic";

type UpdateRow = typeof itemUpdates.$inferSelect;

function instantOf(value: string) {
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = Date.parse(normalised);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function expose(row: UpdateRow) {
  return {
    id: row.id,
    parentId: row.parentId,
    authorName: row.authorName,
    authorEmail: row.authorEmail,
    body: row.body,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    files: [] as never[],
  };
}

function unavailable(error: unknown) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  console.error("[/api/board/discussion]", error);
  return Response.json({ error: "The board discussion is temporarily unavailable." }, { status: 503 });
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor } = guard.scope;
    const boardId = await resolveBoardId(
      db,
      orgId,
      new URL(request.url).searchParams.get("board"),
    );
    const requestId = discussionRequestId(boardId);

    const rows = await db
      .select()
      .from(itemUpdates)
      .where(and(eq(itemUpdates.organisationId, orgId), eq(itemUpdates.requestId, requestId)))
      .orderBy(desc(itemUpdates.createdAt));

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
            and(eq(itemUpdateLikes.organisationId, orgId), inArray(itemUpdateLikes.updateId, updateIds)),
          )
      : [];
    const me = (actor.email ?? "").trim().toLowerCase();
    const likesByUpdate = new Map<string, { count: number; mine: boolean; names: string[] }>();
    for (const like of likeRows) {
      const entry = likesByUpdate.get(like.updateId) ?? { count: 0, mine: false, names: [] };
      entry.count += 1;
      if (me && like.actorEmail.trim().toLowerCase() === me) entry.mine = true;
      if (entry.names.length < 12) entry.names.push(like.actorName);
      likesByUpdate.set(like.updateId, entry);
    }
    const withLikes = (row: UpdateRow) => {
      const likes = likesByUpdate.get(row.id);
      return {
        ...expose(row),
        likeCount: likes?.count ?? 0,
        likedByMe: likes?.mine ?? false,
        likedBy: likes?.names ?? [],
      };
    };

    const parents = rows.filter((row) => !row.parentId).map(withLikes);
    const byParent = new Map<string, ReturnType<typeof withLikes>[]>();
    for (const row of rows) {
      if (!row.parentId) continue;
      const list = byParent.get(row.parentId) ?? [];
      list.push(withLikes(row));
      byParent.set(row.parentId, list);
    }
    for (const list of byParent.values()) {
      list.sort((left, right) => instantOf(left.createdAt) - instantOf(right.createdAt));
    }

    return Response.json({
      boardId,
      requestId,
      updates: parents.map((parent) => ({ ...parent, replies: byParent.get(parent.id) ?? [] })),
      total: rows.length,
      topLevel: parents.length,
      canPost: (await scopedDbWithCapability(request, "board.edit")).denied === undefined,
    });
  } catch (error) {
    return unavailable(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor } = guard.scope;

    let payload: Record<string, unknown>;
    try {
      payload = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Write an update." }, { status: 400 });
    }
    const boardId = await resolveBoardId(db, orgId, payload.board ?? payload.boardId);
    const requestId = discussionRequestId(boardId);
    const body = typeof payload.body === "string" ? payload.body.trim().slice(0, 8000) : "";
    const parentId =
      typeof payload.parentId === "string" && payload.parentId.trim() ? payload.parentId.trim() : null;
    if (!body) return Response.json({ error: "Write an update." }, { status: 400 });
    if (Array.isArray(payload.attachmentIds) && payload.attachmentIds.length) {
      return Response.json(
        { error: "Files cannot be attached to a board discussion — attach them to an item instead." },
        { status: 400 },
      );
    }
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
      if (!parent) return Response.json({ error: "That update is not on this board." }, { status: 400 });
    }

    const id = `upd_${crypto.randomUUID().replace(/-/g, "")}`;
    await db.insert(itemUpdates).values({
      id,
      organisationId: orgId,
      boardId,
      requestId,
      parentId,
      authorName: actor.displayName || actor.email,
      authorEmail: actor.email ?? null,
      body,
      createdAt: new Date().toISOString(),
    });
    return Response.json({ ok: true, id, attached: 0 });
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * DELETE ?id= — removes one board update (and its replies and likes).
 *
 * Item updates have no delete, and this one exists for one reason: a board
 * discussion is the one thread a tester posts into, and a test message that
 * cannot be taken down again is a test message the whole workspace reads
 * every morning. `board.edit`, scoped to the board's own thread.
 */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const url = new URL(request.url);
    const id = (url.searchParams.get("id") ?? "").trim();
    const boardId = await resolveBoardId(db, orgId, url.searchParams.get("board"));
    const requestId = discussionRequestId(boardId);
    if (!id) return Response.json({ error: "Name an update." }, { status: 400 });
    const [row] = await db
      .select({ id: itemUpdates.id })
      .from(itemUpdates)
      .where(and(eq(itemUpdates.id, id), eq(itemUpdates.organisationId, orgId), eq(itemUpdates.requestId, requestId)))
      .limit(1);
    if (!row) return Response.json({ error: "That update is not on this board." }, { status: 404 });
    const replies = await db
      .select({ id: itemUpdates.id })
      .from(itemUpdates)
      .where(and(eq(itemUpdates.parentId, id), eq(itemUpdates.organisationId, orgId)));
    const ids = [id, ...replies.map((reply) => reply.id)];
    await db
      .delete(itemUpdateLikes)
      .where(and(eq(itemUpdateLikes.organisationId, orgId), inArray(itemUpdateLikes.updateId, ids)));
    await db.delete(itemUpdates).where(and(eq(itemUpdates.organisationId, orgId), inArray(itemUpdates.id, ids)));
    return Response.json({ ok: true, removed: ids.length });
  } catch (error) {
    return unavailable(error);
  }
}
