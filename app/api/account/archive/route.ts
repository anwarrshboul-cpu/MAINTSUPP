/**
 * Archive — everything in this workspace that has been archived, and what can
 * be brought back.
 *
 * monday's Archive lists archived boards, items and groups with a Restore
 * button on each. MAINTSUPP archives the same shapes, so this reads the four
 * tables that actually carry an `archived` flag:
 *
 *   maintenance_requests.archived / archived_at  — jobs
 *   maintenance_groups.archived                  — board groups
 *   boards.archived                              — boards
 *   teams.archived                               — teams
 *
 * Restore is offered only where this route can honestly perform it. Teams are
 * listed but not restorable here: `/api/teams` owns team lifecycle, and a
 * second writer flipping the same flag would be a lie about where the rule
 * lives. The UI sends the reader there instead of showing a button that
 * bypasses it.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import {
  boards,
  maintenanceGroups,
  maintenanceRequests,
  teams,
} from "../../../../db/schema";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";

/** The kinds this route will restore, and the table each one flips. */
const RESTORABLE = new Set(["job", "group", "board"]);

export async function GET(request: Request) {
  await ensureDatabase();
  try {
    const context = await scopedDb(request);
    const orgId = context.orgId;

    const [jobRows, groupRows, boardRows, teamRows] = await Promise.all([
      context.db
        .select({
          id: maintenanceRequests.id,
          title: maintenanceRequests.title,
          reference: maintenanceRequests.reference,
          stage: maintenanceRequests.stage,
          archivedAt: maintenanceRequests.archivedAt,
          updatedAt: maintenanceRequests.updatedAt,
        })
        .from(maintenanceRequests)
        .where(
          and(
            eq(maintenanceRequests.organisationId, orgId),
            eq(maintenanceRequests.archived, true),
            /*
             * Stage 23 — archived and deleted are different states, and a job
             * can be both: archive it, then delete it. It belongs in Trash at
             * that point, not on the Archive screen, or the same row offers two
             * Restore buttons that mean different things.
             */
            isNull(maintenanceRequests.deletedAt),
          ),
        )
        .orderBy(desc(maintenanceRequests.archivedAt))
        .limit(200),
      context.db
        .select({
          id: maintenanceGroups.id,
          name: maintenanceGroups.name,
          boardId: maintenanceGroups.boardId,
          updatedAt: maintenanceGroups.updatedAt,
        })
        .from(maintenanceGroups)
        .where(
          and(
            eq(maintenanceGroups.organisationId, orgId),
            eq(maintenanceGroups.archived, true),
            // Stage 23 — a group can be archived and then deleted. Once it is in
            // the bin it belongs to Trash, not to Archive.
            isNull(maintenanceGroups.deletedAt),
          ),
        )
        .orderBy(desc(maintenanceGroups.updatedAt))
        .limit(200),
      context.db
        .select({
          id: boards.id,
          name: boards.name,
          key: boards.key,
          updatedAt: boards.updatedAt,
        })
        .from(boards)
        .where(and(eq(boards.organisationId, orgId), eq(boards.archived, true)))
        .orderBy(desc(boards.updatedAt))
        .limit(200),
      context.db
        .select({
          id: teams.id,
          name: teams.name,
          slug: teams.slug,
          updatedAt: teams.updatedAt,
        })
        .from(teams)
        .where(and(eq(teams.organisationId, orgId), eq(teams.archived, true)))
        .orderBy(desc(teams.updatedAt))
        .limit(200),
    ]);

    return Response.json({
      archive: {
        groups: [
          {
            kind: "job",
            label: "Jobs",
            restorable: true,
            /** Only jobs record *when* they were archived. */
            timestamps: true,
            items: jobRows.map((row) => ({
              id: row.id,
              title: row.title,
              detail: row.reference ? `${row.reference} · ${row.stage}` : row.stage,
              archivedAt: row.archivedAt,
              updatedAt: row.updatedAt,
            })),
          },
          {
            kind: "group",
            label: "Board groups",
            restorable: true,
            timestamps: false,
            items: groupRows.map((row) => ({
              id: row.id,
              title: row.name,
              detail: `Board: ${row.boardId}`,
              archivedAt: null,
              updatedAt: row.updatedAt,
            })),
          },
          {
            kind: "board",
            label: "Boards",
            restorable: true,
            timestamps: false,
            items: boardRows.map((row) => ({
              id: row.id,
              title: row.name,
              detail: row.key,
              archivedAt: null,
              updatedAt: row.updatedAt,
            })),
          },
          {
            kind: "team",
            label: "Teams",
            restorable: false,
            timestamps: false,
            /** Why the Restore button is missing here rather than broken. */
            restoreNote:
              "Teams are restored from the Teams screen, which owns team membership and lifecycle.",
            restoreHref: "/dashboard/teams",
            items: teamRows.map((row) => ({
              id: row.id,
              title: row.name,
              detail: row.slug,
              archivedAt: null,
              updatedAt: row.updatedAt,
            })),
          },
        ],
        /**
         * Which tables carry an archive flag at all. Anything not listed cannot
         * be archived, which is worth stating: an empty Archive otherwise reads
         * as "nothing has happened" rather than "nothing here is archivable".
         */
        archivableEntities: [
          "maintenance_requests",
          "maintenance_groups",
          "boards",
          "teams",
        ],
      },
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "The archive could not be loaded.",
      },
      { status: 503 },
    );
  }
}

/** Restore one archived row — monday's per-row Restore button. */
export async function POST(request: Request) {
  await ensureDatabase();
  try {
    const context = await scopedDb(request);
    const payload = (await request.json()) as Record<string, unknown>;
    const kind = typeof payload.kind === "string" ? payload.kind : "";
    const id = typeof payload.id === "string" ? payload.id.slice(0, 80) : "";

    if (!RESTORABLE.has(kind) || !id) {
      return Response.json(
        { error: "That item cannot be restored from the archive." },
        { status: 400 },
      );
    }

    /*
     * Every update is filtered on the caller's organisation as well as the id,
     * so an id guessed from another workspace matches nothing — and `returning`
     * is what makes that visible. Without it a cross-tenant attempt updated zero
     * rows and still answered "restored", which reads like a success.
     */
    let touched: Array<{ id: string }> = [];
    if (kind === "job") {
      touched = await context.db
        .update(maintenanceRequests)
        .set({ archived: false, archivedAt: null, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(maintenanceRequests.id, id),
            eq(maintenanceRequests.organisationId, context.orgId),
          ),
        )
        .returning({ id: maintenanceRequests.id });
    } else if (kind === "group") {
      touched = await context.db
        .update(maintenanceGroups)
        .set({ archived: false, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(maintenanceGroups.id, id),
            eq(maintenanceGroups.organisationId, context.orgId),
          ),
        )
        .returning({ id: maintenanceGroups.id });
    } else {
      touched = await context.db
        .update(boards)
        .set({ archived: false, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(and(eq(boards.id, id), eq(boards.organisationId, context.orgId)))
        .returning({ id: boards.id });
    }

    if (!touched.length) {
      return Response.json(
        { error: "There is no archived item with that id in this workspace." },
        { status: 404 },
      );
    }

    return Response.json({ restored: { kind, id } });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "The item could not be restored.",
      },
      { status: 503 },
    );
  }
}
