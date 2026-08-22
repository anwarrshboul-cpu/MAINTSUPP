/**
 * `POST /api/board/csv` — the board as a file, and the only way to get one.
 *
 * W13-02. `data.export` is described in the capability matrix as "Download
 * boards, sites and reports as CSV". It decided the site register and decided
 * nothing about the board: `downloadBoardCsv` built the file in the browser out
 * of rows the page already held, so withdrawing the capability from a role took
 * away nothing. Moving the file's production behind this route is what makes
 * the switch mean what it says — the check is on the server, on the request
 * that produces the file, not on whether a button was drawn.
 *
 * WHAT THE CLIENT STILL DECIDES, AND WHY THAT IS RIGHT
 *
 * The caller sends the row ids it is showing, in the order it is showing them,
 * and the column ids it is drawing, in the order it is drawing them. Exporting
 * a filtered and sorted board therefore still produces exactly what is on the
 * screen, which is the whole point of the control. The server decides WHETHER,
 * and re-reads every value from the database rather than trusting anything in
 * the payload, so a crafted request can reorder and narrow its own export and
 * can neither widen it past this workspace nor invent a value in it.
 *
 * POST rather than GET with a query string: a board export can name 745 rows,
 * and a URL cannot carry them.
 */

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import {
  attachments,
  maintenanceBoardCells,
  maintenanceBoardColumns,
  maintenanceGroupItems,
  maintenanceRequests,
} from "../../../../db/schema";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";
import { auditActor, recordAudit } from "../../../lib/audit";
import { resolveBoard } from "../../../lib/board-registry";
import { boardCsvTable, type BoardCsvColumn } from "../../../lib/board-csv";
import { rowsToCsv, csvResponse } from "../../../lib/csv";
import { exposeRequest } from "../../../lib/request-payload";
import { customCellKey } from "../../../(app)/portal/board-format";
import { selectInChunks } from "../../../lib/sql-batching";

export const dynamic = "force-dynamic";

/** Hard ceiling on one export. Above this the answer is "narrow it first". */
const MAX_ROWS = 5000;

function text(value: unknown, max = 64) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function unavailable(error?: unknown) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  console.error("[/api/board/csv]", error);
  return Response.json(
    { error: "The board could not be exported." },
    { status: 503 },
  );
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    /*
     * The gate. Identical in shape to the one on `GET /api/sites/csv`, which is
     * the point: one capability, enforced the same way wherever a CSV is
     * produced, rather than a rule that happens to be applied on one screen.
     */
    const guard = await scopedDbWithCapability(request, "data.export");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor, identityEmail, session } = guard.scope;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const board = await resolveBoard(db, orgId, text(body.board, 48) || undefined);

    const requestedIds = Array.isArray(body.requestIds)
      ? body.requestIds
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, MAX_ROWS)
      : null;

    /*
     * Which rows. An explicit list is honoured IN THE ORDER GIVEN — that is how
     * the sort on screen survives into the file — but only for rows this
     * workspace holds and has not binned, which the query below decides rather
     * than the payload. With no list, the whole board, in its stored order.
     */
    let ids: string[];
    if (requestedIds) {
      const found = await selectInChunks(requestedIds, (chunk) =>
        db
          .select({ id: maintenanceRequests.id })
          .from(maintenanceRequests)
          .where(
            and(
              eq(maintenanceRequests.organisationId, orgId),
              isNull(maintenanceRequests.deletedAt),
              inArray(maintenanceRequests.id, chunk),
            ),
          ),
      );
      const allowed = new Set(found.map((row) => row.id));
      ids = requestedIds.filter((id) => allowed.has(id));
    } else {
      const placements = await db
        .select({ requestId: maintenanceGroupItems.requestId })
        .from(maintenanceGroupItems)
        .innerJoin(
          maintenanceRequests,
          eq(maintenanceRequests.id, maintenanceGroupItems.requestId),
        )
        .where(
          and(
            eq(maintenanceGroupItems.organisationId, orgId),
            eq(maintenanceGroupItems.boardId, board.key),
            isNull(maintenanceRequests.deletedAt),
          ),
        )
        .orderBy(asc(maintenanceGroupItems.position))
        .limit(MAX_ROWS);
      ids = placements.map((row) => row.requestId);
    }

    const columnRows = await db
      .select()
      .from(maintenanceBoardColumns)
      .where(
        and(
          eq(maintenanceBoardColumns.organisationId, orgId),
          eq(maintenanceBoardColumns.boardId, board.key),
          isNull(maintenanceBoardColumns.deletedAt),
        ),
      )
      .orderBy(asc(maintenanceBoardColumns.position));

    /*
     * Which columns, and in what order. The caller's list wins where it names
     * columns this board actually has; anything else is dropped rather than
     * invented. With no list, every visible column in board order — the Group
     * control excepted, because "which group is this in" is a control rather
     * than a value and monday's own export omits it.
     */
    const requestedColumnIds = Array.isArray(body.columnIds)
      ? body.columnIds.filter((value): value is string => typeof value === "string")
      : null;
    const byId = new Map(columnRows.map((row) => [row.id, row]));
    const chosen = requestedColumnIds
      ? requestedColumnIds
          .map((id) => byId.get(id))
          .filter((row): row is (typeof columnRows)[number] => Boolean(row))
      : columnRows.filter((row) => row.visible !== false && row.key !== "move");

    const columns: BoardCsvColumn[] = chosen.map((row) => ({
      key: row.system ? row.key : null,
      column: {
        id: row.id,
        key: row.key,
        title: row.title,
        type: row.type as BoardCsvColumn["column"]["type"],
        position: row.position,
        width: row.width,
        settings: (() => {
          try {
            return JSON.parse(row.settings || "{}");
          } catch {
            return {};
          }
        })(),
        system: row.system,
        visible: row.visible !== false,
      },
    }));

    const [requestRows, cellRows, attachmentRows] = await Promise.all([
      selectInChunks(ids, (chunk) =>
        db
          .select()
          .from(maintenanceRequests)
          .where(
            and(
              eq(maintenanceRequests.organisationId, orgId),
              inArray(maintenanceRequests.id, chunk),
            ),
          ),
      ),
      selectInChunks(ids, (chunk) =>
        db
          .select({
            requestId: maintenanceBoardCells.requestId,
            columnId: maintenanceBoardCells.columnId,
            value: maintenanceBoardCells.value,
          })
          .from(maintenanceBoardCells)
          .where(
            and(
              eq(maintenanceBoardCells.organisationId, orgId),
              eq(maintenanceBoardCells.boardId, board.key),
              inArray(maintenanceBoardCells.requestId, chunk),
            ),
          ),
      ),
      selectInChunks(ids, (chunk) =>
        db
          .select({
            requestId: attachments.requestId,
            boardColumnId: attachments.boardColumnId,
          })
          .from(attachments)
          .where(
            and(
              eq(attachments.organisationId, orgId),
              inArray(attachments.requestId, chunk),
            ),
          ),
      ),
    ]);

    const byRequestId = new Map(requestRows.map((row) => [row.id, row]));
    const requests = ids
      .map((id) => byRequestId.get(id))
      .filter((row): row is (typeof requestRows)[number] => Boolean(row))
      .map((row) => exposeRequest(row));

    const cells: Record<string, string> = {};
    for (const cell of cellRows) {
      cells[customCellKey(cell.requestId, cell.columnId)] = cell.value;
    }

    const fileCounts: Record<string, number> = {};
    for (const file of attachmentRows) {
      // An attachment with no board column belongs to the job's own evidence
      // tabs rather than to a Files cell, so it is not counted by any column.
      if (!file.boardColumnId || !file.requestId) continue;
      const key = customCellKey(file.requestId, file.boardColumnId);
      fileCounts[key] = (fileCounts[key] ?? 0) + 1;
    }

    /*
     * Children are counted from the rows this export actually loaded, so a
     * Subitems figure under-reports rather than over-reports when a selection
     * excludes a job's children — which is the honest direction for a count of
     * "how many of these are here".
     */
    const subitemCounts: Record<string, number> = {};
    for (const row of requestRows) {
      if (!row.parentId) continue;
      subitemCounts[row.parentId] = (subitemCounts[row.parentId] ?? 0) + 1;
    }

    const { headers, rows } = boardCsvTable({
      boardId: board.key,
      columns,
      requests,
      cells,
      fileCounts,
      subitemCounts,
    });

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor({ actor, identityEmail, session }),
      action: "data.exported",
      entityType: "board",
      entityId: board.key,
      summary: `Exported ${rows.length} row${rows.length === 1 ? "" : "s"} from ${board.name} as CSV.`,
      detail: { board: board.key, rows: rows.length, columns: headers.length },
      request,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    return csvResponse(
      `maintsupp-${board.key}-${stamp}.csv`,
      rowsToCsv(headers, rows),
    );
  } catch (error) {
    return unavailable(error);
  }
}
