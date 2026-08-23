/**
 * `/api/board/settings?board=` — the board's own record: its name and what it
 * calls an item.
 *
 *   GET    `board.view`     name, item noun, key
 *   PATCH  `settings.edit`  rename the board; change the item terminology
 *
 * `settings.edit` rather than `board.edit` because a board's name is a
 * workspace-wide fact every colleague sees in the sidebar and the header —
 * the same reasoning `/api/workspace-sections` applies to the section
 * default. The row is `boards`, resolved through `resolveBoard` so the
 * implicit maintenance board is materialised on first use exactly as the
 * item routes do.
 */

import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { boards } from "../../../../db/schema";
import { auditActor, changeDetail, recordAudit } from "../../../lib/audit";
import { normaliseBoardId } from "../../../lib/automations/store";
import { resolveBoard } from "../../../lib/board-registry";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function unavailable(error: unknown) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  console.error("[/api/board/settings]", error);
  return Response.json({ error: "Board settings are temporarily unavailable." }, { status: 503 });
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const key = normaliseBoardId(new URL(request.url).searchParams.get("board"));
    const board = await resolveBoard(db, orgId, key);
    const canEdit = (await scopedDbWithCapability(request, "settings.edit")).denied === undefined;
    return Response.json({
      board: { id: board.id, key: board.key, name: board.name, itemNoun: board.itemNoun },
      canEdit,
    });
  } catch (error) {
    return unavailable(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "settings.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor, identityEmail, session } = guard.scope;
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const key = normaliseBoardId(payload.board ?? payload.boardId);
    const board = await resolveBoard(db, orgId, key);

    const changes: Partial<typeof boards.$inferInsert> = {};
    if (typeof payload.name === "string") {
      const name = text(payload.name, 80);
      if (name.length < 2) return Response.json({ error: "Give the board a name." }, { status: 400 });
      changes.name = name;
    }
    if (typeof payload.itemNoun === "string") {
      const noun = text(payload.itemNoun, 30);
      if (!noun) return Response.json({ error: "Say what an item is called." }, { status: 400 });
      changes.itemNoun = noun;
    }
    if (!Object.keys(changes).length) return Response.json({ error: "Nothing to change." }, { status: 400 });

    const [updated] = await db
      .update(boards)
      .set({ ...changes, updatedAt: new Date().toISOString() })
      .where(and(eq(boards.id, board.id), eq(boards.organisationId, orgId)))
      .returning();

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor({ actor, identityEmail, session }),
      action: "board.settings_changed",
      entityType: "board",
      entityId: board.id,
      summary: changes.name
        ? `Renamed the board "${board.name}" to "${updated.name}".`
        : `Changed what the "${board.name}" board calls an item to "${updated.itemNoun}".`,
      detail: changeDetail(
        { name: board.name, itemNoun: board.itemNoun },
        { name: updated.name, itemNoun: updated.itemNoun },
      ),
      request,
    });
    return Response.json({
      board: { id: updated.id, key: updated.key, name: updated.name, itemNoun: updated.itemNoun },
    });
  } catch (error) {
    return unavailable(error);
  }
}
