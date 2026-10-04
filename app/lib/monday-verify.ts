/**
 * STORE DOCUMENTATION, COMPARED WITH MONDAY (owner audit, 2026-10-04).
 *
 * Read-only. Reads Sunnamusk's Store Documentation board live from monday and
 * the same stores from MAINTSUPP, and reports every difference:
 *
 *   - stores: on monday and not here, here and not on monday, renamed, moved
 *     between groups;
 *   - certificate files, per slot: the names and sizes monday holds against the
 *     live files here (current version, not archived), and whether each file
 *     here actually has its bytes in storage;
 *   - expiry dates, per slot: monday's date against the cell the compliance
 *     register reads.
 *
 * Nothing is written. The fix for a difference is the ordinary sync (which
 * copies what is missing and refreshes cells) — this only says whether one is
 * needed, and exactly where.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../../db";
import { storeDocumentationCertificates } from "../../db/monday-board-spec";
import {
  attachments,
  maintenanceBoardCells,
  maintenanceBoardColumns,
  maintenanceGroupItems,
  maintenanceGroups,
  maintenanceRequests,
} from "../../db/schema";
import { dateOnlyValue } from "./expiry-status";
import { boardItemIds, fetchMondayItems, mondaySyncConfig } from "./monday-live-sync";

type Database = Awaited<ReturnType<typeof getDb>>;

export type StoreDocDifference = {
  store: string;
  slot?: string;
  kind:
    | "store_missing_here"
    | "store_not_on_monday"
    | "store_renamed"
    | "store_group_differs"
    | "file_missing_here"
    | "file_not_on_monday"
    | "file_bytes_missing"
    | "date_differs";
  monday?: string | null;
  here?: string | null;
};

export async function verifyStoreDocumentation(db: Database) {
  const config = mondaySyncConfig();
  const orgId = config.organisationId;
  const ids = await boardItemIds(config.storeDocBoardId, null);
  const items = (await fetchMondayItems(ids)).filter((item) => !item.state || item.state === "active");

  const rows = await db
    .select({
      id: maintenanceRequests.id,
      title: maintenanceRequests.title,
      externalId: maintenanceRequests.externalId,
      deletedAt: maintenanceRequests.deletedAt,
      groupName: maintenanceGroups.name,
    })
    .from(maintenanceRequests)
    .innerJoin(maintenanceGroupItems, eq(maintenanceGroupItems.requestId, maintenanceRequests.id))
    .leftJoin(maintenanceGroups, eq(maintenanceGroups.id, maintenanceGroupItems.groupId))
    .where(and(eq(maintenanceRequests.organisationId, orgId), eq(maintenanceGroupItems.boardId, "store-documentation")));
  const live = rows.filter((row) => !row.deletedAt);
  const rowByExternal = new Map(live.filter((row) => row.externalId).map((row) => [String(row.externalId), row]));

  const columns = await db
    .select({ id: maintenanceBoardColumns.id, key: maintenanceBoardColumns.key, title: maintenanceBoardColumns.title })
    .from(maintenanceBoardColumns)
    .where(and(eq(maintenanceBoardColumns.organisationId, orgId), eq(maintenanceBoardColumns.boardId, "store-documentation")));
  const columnByKey = new Map(columns.map((column) => [column.key, column]));

  const requestIds = live.map((row) => row.id);
  const files = requestIds.length
    ? await db
        .select({
          requestId: attachments.requestId,
          columnId: attachments.boardColumnId,
          name: attachments.originalName,
          size: attachments.byteSize,
          objectKey: attachments.objectKey,
          isCurrent: attachments.isCurrent,
        })
        .from(attachments)
        .where(and(eq(attachments.organisationId, orgId), inArray(attachments.requestId, requestIds), isNull(attachments.archivedAt)))
    : [];
  const cells = requestIds.length
    ? await db
        .select({ requestId: maintenanceBoardCells.requestId, columnId: maintenanceBoardCells.columnId, value: maintenanceBoardCells.value })
        .from(maintenanceBoardCells)
        .where(and(eq(maintenanceBoardCells.organisationId, orgId), eq(maintenanceBoardCells.boardId, "store-documentation"), inArray(maintenanceBoardCells.requestId, requestIds)))
    : [];
  const cellValue = new Map(cells.map((cell) => [`${cell.requestId}|${cell.columnId}`, cell.value]));

  const { env } = await import("cloudflare:workers");
  const bucket = (env as unknown as { BUCKET?: R2Bucket }).BUCKET;

  const differences: StoreDocDifference[] = [];
  const totals = { stores: items.length, storesHere: live.length, filesOnMonday: 0, filesHere: 0, datesOnMonday: 0, datesHere: 0 };
  const seen = new Set<string>();

  for (const item of items) {
    const row = rowByExternal.get(String(item.id));
    if (!row) {
      differences.push({ store: item.name, kind: "store_missing_here" });
      continue;
    }
    seen.add(row.id);
    if (row.title.trim() !== item.name.trim()) differences.push({ store: item.name, kind: "store_renamed", monday: item.name, here: row.title });
    const mondayGroup = item.group?.title?.trim() ?? "";
    if ((row.groupName ?? "").trim().toLowerCase() !== mondayGroup.toLowerCase()) {
      differences.push({ store: item.name, kind: "store_group_differs", monday: mondayGroup, here: row.groupName });
    }
    const assetById = new Map((item.assets ?? []).map((asset) => [String(asset.id), asset]));
    const valueByTitle = new Map((item.column_values ?? []).map((value) => [(value.column?.title ?? "").trim().toLowerCase(), value]));

    for (const slot of storeDocumentationCertificates) {
      const fileColumn = columnByKey.get(slot.fileColumn);
      if (!fileColumn) continue;
      /* monday's files in this slot */
      const mondayValue = valueByTitle.get(fileColumn.title.trim().toLowerCase());
      const mondayFiles: string[] = [];
      try {
        const parsed = mondayValue?.value ? (JSON.parse(mondayValue.value) as { files?: Array<{ assetId?: number | string }> }) : {};
        for (const file of parsed.files ?? []) {
          const asset = assetById.get(String(file.assetId));
          if (asset?.name) mondayFiles.push(`${asset.name}|${asset.file_size ?? "?"}`);
        }
      } catch {
        /* unreadable cell: treated as no files */
      }
      const hereFiles = files.filter((file) => file.requestId === row.id && file.columnId === fileColumn.id && file.isCurrent !== false);
      totals.filesOnMonday += mondayFiles.length;
      totals.filesHere += hereFiles.length;
      const hereKeys = hereFiles.map((file) => `${file.name}|${file.size}`);
      for (const key of mondayFiles) {
        const index = hereKeys.indexOf(key);
        if (index === -1) {
          const [name, size] = key.split("|");
          const megabytes = Number(size) > 0 ? ` (${(Number(size) / 1048576).toFixed(1)} MB)` : "";
          differences.push({ store: item.name, slot: slot.label, kind: "file_missing_here", monday: `${name}${megabytes}` });
        }
        else hereKeys.splice(index, 1);
      }
      for (const key of hereKeys) differences.push({ store: item.name, slot: slot.label, kind: "file_not_on_monday", here: key.split("|")[0] });
      if (bucket) {
        for (const file of hereFiles) {
          if (!(await bucket.head(file.objectKey))) differences.push({ store: item.name, slot: slot.label, kind: "file_bytes_missing", here: file.name });
        }
      }

      /* the expiry date */
      if (slot.expiryColumn) {
        const expiryColumn = columnByKey.get(slot.expiryColumn);
        if (!expiryColumn) continue;
        const mondayDate = dateOnlyValue(valueByTitle.get(expiryColumn.title.trim().toLowerCase())?.text ?? "") || null;
        const hereDate = dateOnlyValue(cellValue.get(`${row.id}|${expiryColumn.id}`)) || null;
        if (mondayDate) totals.datesOnMonday += 1;
        if (hereDate) totals.datesHere += 1;
        if (mondayDate !== hereDate) differences.push({ store: item.name, slot: slot.label, kind: "date_differs", monday: mondayDate, here: hereDate });
      }
    }
  }
  for (const row of live) {
    if (!seen.has(row.id)) differences.push({ store: row.title, kind: "store_not_on_monday", here: row.externalId ?? "(no monday id)" });
  }
  return { ok: differences.length === 0, totals, differences };
}
