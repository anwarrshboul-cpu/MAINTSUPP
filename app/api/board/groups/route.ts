import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { maintenanceGroupItems, maintenanceGroups } from "../../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../../lib/tenant-db";
import { RETENTION_DAYS, sendGroupToBin } from "../../../lib/recycle-bin";
import { resolveBoard } from "../../../lib/board-registry";

export const dynamic = "force-dynamic";

const HEX = /^#[0-9a-fA-F]{6}$/;

function text(value: unknown, max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function bad(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function unavailable(error?: unknown) {
  // A session that has ended is not an outage: 503 tells a browser to retry
  // something no amount of retrying will fix, and blames the workspace for
  // what a person fixes by signing in. See `anonymousRefusal`.
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  return Response.json({ error: "Board groups are temporarily unavailable." }, { status: 503 });
}

function newId() {
  return `grp_${crypto.randomUUID().replace(/-/g, "")}`;
}

async function countItems(
  db: Awaited<ReturnType<typeof scopedDb>>["db"],
  orgId: string,
  groupId: string,
) {
  const rows = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(maintenanceGroupItems)
    .where(
      and(
        eq(maintenanceGroupItems.organisationId, orgId),
        eq(maintenanceGroupItems.groupId, groupId),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

/** GET /api/board/groups — groups with live item counts. */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    const url = new URL(request.url);
    const board = await resolveBoard(db, orgId, url.searchParams.get("board") ?? undefined);

    const rows = await db
      .select()
      .from(maintenanceGroups)
      .where(
        and(
          eq(maintenanceGroups.organisationId, orgId),
          eq(maintenanceGroups.boardId, board.key),
          // Stage 23 — a group in the recycle bin is off the board.
          isNull(maintenanceGroups.deletedAt),
        ),
      )
      .orderBy(asc(maintenanceGroups.position));

    const counts = await db
      .select({
        groupId: maintenanceGroupItems.groupId,
        total: sql<number>`COUNT(*)`,
      })
      .from(maintenanceGroupItems)
      .where(eq(maintenanceGroupItems.organisationId, orgId))
      .groupBy(maintenanceGroupItems.groupId);

    const itemCount = new Map(counts.map((row) => [row.groupId, Number(row.total)]));

    return Response.json({
      board,
      groups: rows.map((row) => ({
        id: row.id,
        name: row.name,
        colour: row.color,
        position: row.position,
        collapsed: row.collapsed,
        archived: row.archived,
        description: row.description,
        stageKey: row.stageKey,
        items: itemCount.get(row.id) ?? 0,
      })),
    });
  } catch (error) {
    return unavailable(error);
  }
}

/** POST /api/board/groups — create a group. O3. */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const body = await request.json().catch(() => ({}));

    const name = text(body.name, 80);
    if (!name) return bad("A group name is required.");

    const board = await resolveBoard(db, orgId, text(body.board, 48) || undefined);
    const colour = HEX.test(text(body.colour, 7)) ? text(body.colour, 7) : "#579bfc";

    const [tail] = await db
      .select({ maxPosition: sql<number>`COALESCE(MAX(${maintenanceGroups.position}), -1)` })
      .from(maintenanceGroups)
      .where(
        and(
          eq(maintenanceGroups.organisationId, orgId),
          eq(maintenanceGroups.boardId, board.key),
          // Stage 23 — a group in the recycle bin is off the board.
          isNull(maintenanceGroups.deletedAt),
        ),
      );

    const id = newId();
    await db.insert(maintenanceGroups).values({
      id,
      organisationId: orgId,
      boardId: board.key,
      name,
      color: colour,
      description: text(body.description, 240) || null,
      position: Number(tail?.maxPosition ?? -1) + 1,
    });

    return Response.json({ id, name, colour }, { status: 201 });
  } catch (error) {
    return unavailable(error);
  }
}

/** PATCH /api/board/groups — rename, recolour, collapse, reorder, archive. */
export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const body = await request.json().catch(() => ({}));

    if (Array.isArray(body.order)) {
      for (const entry of body.order) {
        const id = text(entry?.id, 64);
        const position = Number(entry?.position);
        if (!id || !Number.isFinite(position)) continue;
        await db
          .update(maintenanceGroups)
          .set({ position, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(
            and(eq(maintenanceGroups.id, id), eq(maintenanceGroups.organisationId, orgId)),
          );
      }
      return Response.json({ ok: true });
    }

    const id = text(body.id, 64);
    if (!id) return bad("A group id is required.");

    const [existing] = await db
      .select()
      .from(maintenanceGroups)
      .where(
        and(
          eq(maintenanceGroups.id, id),
          eq(maintenanceGroups.organisationId, orgId),
          // Stage 23 — a group already in the bin is not found here. It is
          // restored from Trash, not edited or re-deleted in place.
          isNull(maintenanceGroups.deletedAt),
        ),
      );
    if (!existing) return bad("Group not found.", 404);

    const patch: Record<string, unknown> = { updatedAt: sql`CURRENT_TIMESTAMP` };
    if (typeof body.name === "string") {
      const name = text(body.name, 80);
      if (!name) return bad("Group name cannot be empty.");
      patch.name = name;
    }
    if (typeof body.colour === "string" && HEX.test(body.colour.trim())) {
      patch.color = body.colour.trim();
    }
    if (typeof body.collapsed === "boolean") patch.collapsed = body.collapsed;
    if (typeof body.archived === "boolean") patch.archived = body.archived;
    if (typeof body.description === "string") {
      patch.description = text(body.description, 240) || null;
    }

    await db
      .update(maintenanceGroups)
      .set(patch)
      .where(and(eq(maintenanceGroups.id, id), eq(maintenanceGroups.organisationId, orgId)));

    return Response.json({ ok: true });
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * DELETE /api/board/groups?id=…
 *
 * A group holding items is archived rather than deleted — the jobs inside carry
 * compliance evidence and must never be orphaned by a single click.
 */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor, identityEmail } = guard.scope;
    const url = new URL(request.url);
    const id = text(url.searchParams.get("id"), 64);
    const moveTo = text(url.searchParams.get("moveTo"), 64);
    if (!id) return bad("A group id is required.");

    const [existing] = await db
      .select()
      .from(maintenanceGroups)
      .where(
        and(
          eq(maintenanceGroups.id, id),
          eq(maintenanceGroups.organisationId, orgId),
          // Stage 23 — a group already in the bin is not found here. It is
          // restored from Trash, not edited or re-deleted in place.
          isNull(maintenanceGroups.deletedAt),
        ),
      );
    if (!existing) return bad("Group not found.", 404);

    const items = await countItems(db, orgId, id);

    if (items > 0 && !moveTo) {
      const alternatives = await db
        .select({ id: maintenanceGroups.id, name: maintenanceGroups.name })
        .from(maintenanceGroups)
        .where(
          and(
            eq(maintenanceGroups.organisationId, orgId),
            eq(maintenanceGroups.boardId, existing.boardId),
            eq(maintenanceGroups.archived, false),
            isNull(maintenanceGroups.deletedAt),
          ),
        )
        .orderBy(asc(maintenanceGroups.position));

      return Response.json(
        {
          error: "has-items",
          items,
          message: `"${existing.name}" holds ${items} item${items === 1 ? "" : "s"}. Choose where they should go.`,
          alternatives: alternatives.filter((group) => group.id !== id),
        },
        { status: 409 },
      );
    }

    if (items > 0) {
      await db
        .update(maintenanceGroupItems)
        .set({ groupId: moveTo, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(maintenanceGroupItems.organisationId, orgId),
            eq(maintenanceGroupItems.groupId, id),
          ),
        );
    }

    /*
     * Stage 23 — the group goes to the recycle bin instead of being destroyed.
     *
     * The items are already out of it: this route still refuses (409 has-items)
     * to bin a group holding jobs until a destination is chosen, and the block
     * above has just moved them there. So what a restore brings back is the
     * group itself — name, colour, description, stage key and the position it
     * held — which is exactly what a mis-click here used to cost permanently.
     */
    await sendGroupToBin(
      db,
      orgId,
      { email: identityEmail || actor.email, displayName: actor.displayName },
      id,
    );

    return Response.json({
      ok: true,
      moved: items,
      recycled: true,
      retentionDays: RETENTION_DAYS,
      message: `"${existing.name}" was moved to the recycle bin. It can be restored for ${RETENTION_DAYS} days.`,
    });
  } catch (error) {
    return unavailable(error);
  }
}
