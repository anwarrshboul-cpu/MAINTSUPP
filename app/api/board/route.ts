import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  max,
  sql,
} from "drizzle-orm";
import { defaultBoardOptions } from "../../../db/seed-options";
import {
  maintenanceColumns,
  maintenanceGroups as maintenanceGroupSeeds,
  maintenanceOptions,
  maintenanceUiColumns,
} from "../../../db/monday-board-spec";
import { maintenanceRequests as sampleRequests } from "../../lib/mock-data";
import type {
  BoardColumnSettings,
  BoardColumnType,
  BoardOptionColumn,
  MaintenanceBoardColumn,
  MaintenanceBoardFilePreview,
  RequestStage,
} from "../../lib/types";
import {
  STORE_DOCUMENTATION_BOARD_ID,
  readNotRequiredSlots,
} from "../../lib/compliance-register";
import { getD1 } from "../../../db";
import { ensureDatabase } from "../../../db/init";
import { seedStoreDocumentationBoard } from "../../../db/seed-store-documentation";
import {
  activityLog,
  attachments,
  maintenanceBoardCells,
  maintenanceBoardColumns,
  maintenanceBoardOptions,
  maintenanceGroupItems,
  maintenanceGroups,
  maintenanceRequests,
} from "../../../db/schema";
import { auditActor, recordAudit } from "../../lib/audit";
import { exposeRequest } from "../../lib/request-payload";
import { PRIMARY_ORGANISATION_ID, anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../lib/tenant-db";
import { sampleSeedingAllowed } from "../../lib/tenant-access";
import { selectInChunks } from "../../lib/sql-batching";
import { RETENTION_DAYS, sendGroupToBin, sendJobsToBin } from "../../lib/recycle-bin";

/*
 * Which board a request is for.
 *
 * `board_id` has been a column on every board table since Stage 3, but this
 * route pinned it to the literal "maintenance", so the second board could be
 * seeded and never read. The board now comes from `?board=`, defaulting to
 * maintenance so every existing caller keeps working untouched.
 *
 * The allow-list matters: `board_id` reaches a WHERE clause, and an unchecked
 * value from the query string would let a caller address rows this route was
 * never meant to serve. Anything unrecognised falls back to the default rather
 * than erroring — a bad query param should not take the board down.
 */
const BOARD_IDS = ["maintenance", "store-documentation"] as const;
type BoardId = (typeof BOARD_IDS)[number];
const DEFAULT_BOARD_ID: BoardId = "maintenance";

function boardIdFrom(request: Request): BoardId {
  const raw = new URL(request.url).searchParams.get("board");
  return BOARD_IDS.includes(raw as BoardId) ? (raw as BoardId) : DEFAULT_BOARD_ID;
}
type BoardDb = Awaited<ReturnType<typeof scopedDb>>["db"];

function tenantSeedId(base: string, orgId: string) {
  return orgId === PRIMARY_ORGANISATION_ID ? base : `${base}-${orgId}`;
}

/*
 * Groups are seeded in exactly one place — `seedBoardStructure` in db/init.ts,
 * which `ensureDatabase()` runs before anything here touches the board.
 *
 * This module used to declare four of its own (`group-incoming`, `group-booked`,
 * `group-attention`, `group-completed`) at positions 0–3 and insert them here.
 * `seedBoardStructure` had already filled those positions, and the unique index
 * on (organisation_id, board_id, position) turned every one of those inserts
 * into a no-op, so the four names never reached a board. The list is gone rather
 * than repaired: two seeders writing one table is what produced the duplicate
 * columns this change set exists to remove.
 */

const groupColors = new Set([
  ...maintenanceGroupSeeds.map((group) => group.colour),
  "#579bfc",
  "#00c875",
  "#fdab3d",
  "#a25ddc",
  "#e2445c",
  "#0086c0",
  "#ff642e",
  "#037f4c",
]);
const optionColumns = new Set<BoardOptionColumn>([
  "tier",
  "engineer",
  "priority",
  "label",
  "status",
  "storeLocation",
]);
const optionColors = new Set([
  ...groupColors,
  "#ff008c",
  "#ff52bd",
  "#ffcb00",
  "#9cd326",
  "#61caf0",
  "#c32f56",
  "#333333",
  "#808080",
  "#b6b6b6",
  "#ff7575",
  "#e881e8",
  "#b18cfa",
  "#ff8f9a",
  "#7e3f98",
  "#9aafbf",
  "#d0bb39",
  "#7e4ecf",
  "#a9a4c7",
  "#d9ecfb",
  // Every colour the monday capture uses, so an admin editing a seeded chip can
  // pick the shade it already has instead of being forced onto a near-miss.
  ...Object.values(maintenanceOptions).flatMap((set) => set.map((entry) => entry.colour)),
  ...maintenanceGroupSeeds.map((group) => group.colour),
]);

const boardColumnTypes = new Set<BoardColumnType>([
  "status",
  "dropdown",
  "text",
  "long_text",
  "date",
  "people",
  "number",
  "files",
  "timeline",
  "checkbox",
  "email",
  "phone",
  "link",
  "subitems",
]);

const boardDateIconIds = new Set([
  "clock-green",
  "notice-green",
  "check-green",
  "arrow-green",
  "help-green",
  "clock-red",
  "warning-red",
  "back-red",
  "close-red",
  "bolt-blue",
  "warning-orange",
  "rocket-blue",
  "smile-grey",
  "important-grey",
]);

const boardColumnDefaults: Record<
  BoardColumnType,
  { title: string; width: number }
> = {
  status: { title: "Status", width: 170 },
  dropdown: { title: "Dropdown", width: 170 },
  text: { title: "Text", width: 180 },
  long_text: { title: "Long text", width: 260 },
  date: { title: "Date", width: 145 },
  people: { title: "People", width: 170 },
  number: { title: "Numbers", width: 135 },
  files: { title: "Files", width: 120 },
  timeline: { title: "Timeline", width: 205 },
  checkbox: { title: "Checkbox", width: 105 },
  email: { title: "Email", width: 210 },
  phone: { title: "Phone", width: 165 },
  link: { title: "Link", width: 220 },
  subitems: { title: "Subitems", width: 150 },
};

/**
 * The board's column set, read from the monday capture so there is exactly one
 * definition.
 */
const systemBoardColumns: Array<{
  key: string;
  title: string;
  type: BoardColumnType;
  width: number;
}> = [...maintenanceColumns, ...maintenanceUiColumns].map((column) => ({
  key: column.key,
  title: column.title,
  type: column.type as BoardColumnType,
  width: column.width,
}));

const defaultChoiceColors = [
  "#579bfc",
  "#00c875",
  "#fdab3d",
  "#a25ddc",
  "#e2445c",
  "#0086c0",
];

function validOptionColor(value: string) {
  return optionColors.has(value) || /^#[0-9a-f]{6}$/.test(value);
}

function trimString(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function defaultSettings(type: BoardColumnType): BoardColumnSettings {
  if (type === "status") {
    return {
      choices: [
        { id: "not-started", label: "Not started", color: "#b6b6b6" },
        { id: "working-on-it", label: "Working on it", color: "#fdab3d" },
        { id: "done", label: "Done", color: "#00c875" },
        { id: "stuck", label: "Stuck", color: "#e2445c" },
      ],
    };
  }
  if (type === "dropdown") {
    return {
      choices: [
        { id: "option-1", label: "Option 1", color: "#579bfc" },
        { id: "option-2", label: "Option 2", color: "#a25ddc" },
      ],
    };
  }
  if (type === "people") {
    return {
      people: [
        { id: "sample-coordinator-a", label: "Sample Coordinator A", color: "#579bfc" },
        { id: "sample-coordinator-b", label: "Sample Coordinator B", color: "#a25ddc" },
        { id: "sample-client-user", label: "Sample Client User", color: "#00c875" },
        { id: "saed", label: "Saed", color: "#fdab3d" },
      ],
    };
  }
  return {};
}

function cleanChoices(value: unknown) {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  return value
    .map((item, index) => {
      const record =
        item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : {};
      const label = trimString(record.label, 80);
      if (!label) return null;
      let id = trimString(record.id, 100)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      if (!id || used.has(id)) id = `choice-${index + 1}-${crypto.randomUUID()}`;
      used.add(id);
      const requestedColor = trimString(record.color, 12).toLowerCase();
      const color = validOptionColor(requestedColor)
        ? requestedColor
        : defaultChoiceColors[index % defaultChoiceColors.length];
      const requestedTextColor = trimString(record.textColor, 12).toLowerCase();
      const textColor =
        /^#[0-9a-f]{6}$/.test(requestedTextColor)
          ? requestedTextColor
          : "#ffffff";
      return { id, label, color, textColor };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 50);
}

function cleanSettings(
  value: unknown,
  type: BoardColumnType,
): BoardColumnSettings {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const wrap = record.wrap === true;
  if (type === "status" || type === "dropdown") {
    const choices = cleanChoices(record.choices);
    return {
      choices: choices.length ? choices : defaultSettings(type).choices,
      wrap,
    };
  }
  if (type === "people") {
    const people = cleanChoices(record.people);
    return {
      people: people.length ? people : defaultSettings(type).people,
      wrap,
    };
  }
  return { wrap };
}

function parseSettings(value: string, type: BoardColumnType) {
  try {
    return cleanSettings(JSON.parse(value), type);
  } catch {
    return defaultSettings(type);
  }
}

/**
 * What a freshly created row is called.
 *
 * The grid's button already reads "New store" on Store Documentation, so a row
 * landing as "New maintenance item" contradicts the control that created it —
 * and the Store column shows the row's title, so the wrong noun is the first
 * thing on screen. Maintenance keeps its exact wording; the board parity tests
 * read that string.
 */
function newItemTitle(boardId: BoardId) {
  return boardId === "store-documentation" ? "New store" : "New maintenance item";
}

function columnPayload(
  row: typeof maintenanceBoardColumns.$inferSelect,
): MaintenanceBoardColumn {
  const type = boardColumnTypes.has(row.type as BoardColumnType)
    ? (row.type as BoardColumnType)
    : "text";
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    type,
    position: row.position,
    width: row.width,
    settings: parseSettings(row.settings, type),
    system: row.system,
  };
}

function normalizeCellValue(type: BoardColumnType, value: unknown) {
  if (type === "files") return "";
  if (type === "checkbox") {
    return value === true || value === "true" ? "true" : "";
  }
  if (type === "number") {
    const text = trimString(value, 100);
    if (!text) return "";
    const number = Number(text.replaceAll(",", ""));
    if (!Number.isFinite(number)) throw new Error("Enter a valid number.");
    return String(number);
  }
  if (type === "date") {
    const text = trimString(value, 500);
    if (!text) return "";
    if (text.startsWith("{")) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error("Choose a valid date.");
      }
      const date = trimString(record.date, 10);
      const time = trimString(record.time, 5);
      const icon = trimString(record.icon, 40);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("Choose a valid date.");
      }
      if (time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        throw new Error("Choose a valid time.");
      }
      if (icon && !boardDateIconIds.has(icon)) {
        throw new Error("Choose a valid date icon.");
      }
      return JSON.stringify({ date, time, icon });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      throw new Error("Choose a valid date.");
    }
    return text;
  }
  if (type === "timeline") {
    const record =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : typeof value === "string"
          ? (JSON.parse(value || "{}") as Record<string, unknown>)
          : {};
    const start = trimString(record.start, 10);
    const end = trimString(record.end, 10);
    if (
      (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) ||
      (end && !/^\d{4}-\d{2}-\d{2}$/.test(end))
    ) {
      throw new Error("Choose valid timeline dates.");
    }
    return start || end ? JSON.stringify({ start, end }) : "";
  }
  return trimString(value, type === "long_text" ? 5000 : 1000);
}

async function deleteFilesForColumn(db: BoardDb, orgId: string, columnId: string) {
  const fileRows = await db
    .select({
      id: attachments.id,
      objectKey: attachments.objectKey,
      requestId: attachments.requestId,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.boardColumnId, columnId),
        eq(attachments.organisationId, orgId),
      ),
    );
  if (!fileRows.length) return;
  const { env } = await import("cloudflare:workers");
  const runtimeEnv = env as unknown as { BUCKET?: R2Bucket };
  if (!runtimeEnv.BUCKET) {
    throw new Error("File storage is unavailable.");
  }
  await runtimeEnv.BUCKET.delete(fileRows.map((file) => file.objectKey));
  await db
    .delete(attachments)
    .where(
      and(
        eq(attachments.boardColumnId, columnId),
        eq(attachments.organisationId, orgId),
      ),
    );
  const removedByRequest = new Map<string, number>();
  for (const file of fileRows) {
    if (!file.requestId) continue;
    removedByRequest.set(
      file.requestId,
      (removedByRequest.get(file.requestId) ?? 0) + 1,
    );
  }
  for (const [requestId, removed] of removedByRequest) {
    await db
      .update(maintenanceRequests)
      .set({
        attachmentCount: sql`max(${maintenanceRequests.attachmentCount} - ${removed}, 0)`,
        generalAttachmentCount: sql`max(${maintenanceRequests.generalAttachmentCount} - ${removed}, 0)`,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(maintenanceRequests.id, requestId),
          eq(maintenanceRequests.organisationId, orgId),
        ),
      );
  }
}

function requestIdsFrom(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.requestIds)) return [];
  return Array.from(
    new Set(
      payload.requestIds
        .map((value) => trimString(value, 40))
        .filter(Boolean),
    ),
  ).slice(0, 100);
}

/**
 * Maps a stage onto the status chip a job takes when it is moved there.
 *
 * Every value must be a label the board actually carries. "Triage in progress"
 * was not one — it was among six statuses that existed only in this codebase,
 * so moving a job into Incoming set it to a chip that could not be rendered.
 */
function statusForStage(stage: RequestStage) {
  return {
    Incoming: "Pending Approval",
    Booked: "Job Scheduled",
    Attention: "Waiting for decisions",
    Completed: "Job Completed",
  }[stage];
}

async function seedRequestsIfEmpty(db: BoardDb, orgId: string) {
  const [result] = await db
    .select({ value: count() })
    .from(maintenanceRequests)
    .where(eq(maintenanceRequests.organisationId, orgId));
  if (result.value > 0) return;
  if (orgId !== PRIMARY_ORGANISATION_ID) return;
  if (!sampleSeedingAllowed()) return;
  for (const request of sampleRequests) {
    await db
      .insert(maintenanceRequests)
      .values({
        ...request,
        organisationId: orgId,
        createdByEmail: "seed@maintsupp.local",
      })
      .onConflictDoNothing();
  }
}

async function ensureBoardState(db: BoardDb, orgId: string, boardId: BoardId) {
  await ensureDatabase();

  // The Store Documentation board carries its own columns, groups and options
  // and has no maintenance requests to seed, so it takes a separate path rather
  // than making the block below conditional in six places.
  if (boardId === "store-documentation") {
    // The seeder speaks raw D1, matching `seedBoardStructure` in db/init.ts,
    // while this route holds a Drizzle handle. Reaching for D1 directly here is
    // cheaper than reshaping a seeder that init.ts also calls.
    await seedStoreDocumentationBoard(await getD1(), orgId);
    return;
  }

  await seedRequestsIfEmpty(db, orgId);

  /*
   * The seeding below runs on every board load, and after the first one it has
   * nothing left to do: every insert is `onConflictDoNothing` against a row
   * that already exists. Measured against Postgres, those no-ops were 97 of the
   * 152 statements a single `/api/board` request issued, and most of its time —
   * a round trip each, paid on every load by every user, for ever.
   *
   * Counting first turns 97 statements into 1. It is a count rather than a
   * process-level memo because a memo cannot see a row deleted by someone else,
   * and this seeding is what repairs that: if an option is removed the count
   * falls short and the loop runs again. Cheap, and still self-healing.
   */
  const seededOptions = await db
    .select({ id: maintenanceBoardOptions.id })
    .from(maintenanceBoardOptions)
    .where(
      and(
        eq(maintenanceBoardOptions.boardId, boardId),
        eq(maintenanceBoardOptions.organisationId, orgId),
      ),
    );
  if (seededOptions.length < defaultBoardOptions.length) {
    for (const item of defaultBoardOptions) {
      await db
        .insert(maintenanceBoardOptions)
        .values({
          id: tenantSeedId(`option-${item.columnKey}-${item.position}`, orgId),
          organisationId: orgId,
          boardId: boardId,
          ...item,
        })
        .onConflictDoNothing();
    }
  }

  const existingColumns = await db
    .select()
    .from(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.boardId, boardId),
        eq(maintenanceBoardColumns.organisationId, orgId),
      ),
    )
    .orderBy(asc(maintenanceBoardColumns.position));
  if (!existingColumns.some((column) => column.system)) {
    const customColumns = existingColumns.filter((column) => !column.system);
    for (const [index, column] of customColumns.entries()) {
      await db
        .update(maintenanceBoardColumns)
        .set({ position: (systemBoardColumns.length + index) * 1000 })
        .where(
          and(
            eq(maintenanceBoardColumns.id, column.id),
            eq(maintenanceBoardColumns.organisationId, orgId),
          ),
        );
    }
  }
  // Same reasoning as the options above, but free: `existingColumns` has
  // already been read, so the count costs no extra round trip.
  if (existingColumns.filter((column) => column.system).length < systemBoardColumns.length) {
    for (const [position, column] of systemBoardColumns.entries()) {
      await db
        .insert(maintenanceBoardColumns)
        .values({
          id: tenantSeedId(`column-system-${column.key}`, orgId),
          organisationId: orgId,
          boardId: boardId,
          key: column.key,
          title: column.title,
          type: column.type,
          position: position * 1000,
          width: column.width,
          settings: JSON.stringify({ wrap: false }),
          system: true,
        })
        .onConflictDoNothing();
    }
  }

  const groups = await db
    .select()
    .from(maintenanceGroups)
    .where(
      and(
        eq(maintenanceGroups.boardId, boardId),
        eq(maintenanceGroups.organisationId, orgId),
            isNull(maintenanceGroups.deletedAt),
        isNull(maintenanceGroups.deletedAt),
      ),
    )
    .orderBy(asc(maintenanceGroups.position));
  /*
   * STAGE 23 — `isNull(deletedAt)` HERE IS LOAD-BEARING, NOT DEFENSIVE.
   *
   * Everything below re-places any request that has no row in
   * `maintenance_group_items`, which is how an imported or orphaned job finds a
   * group. A job in the recycle bin has had its placement deleted on purpose —
   * that is what takes it off the board — so without this filter every soft
   * delete would be undone by the very next board load, silently and for ever.
   *
   * This was the single most dangerous read in the soft-delete change.
   */
  const requests = await db
    .select({
      id: maintenanceRequests.id,
      stage: maintenanceRequests.stage,
    })
    .from(maintenanceRequests)
    .where(
      and(
        eq(maintenanceRequests.organisationId, orgId),
        isNull(maintenanceRequests.deletedAt),
      ),
    );
  /*
   * READ EVERY BOARD'S PLACEMENTS, NOT JUST THIS ONE'S.
   *
   * `maintenance_group_items.request_id` is the PRIMARY KEY, so a work order
   * holds ONE placement across the whole workspace — which board it sits on is
   * a property of that single row, not a per-board fact. Asking "is this
   * request placed?" with a `board_id` filter therefore asks a narrower
   * question than the key answers.
   *
   * That mismatch had a cost. `requests` below is every live work order in the
   * organisation — there is no board column on `maintenance_requests` to filter
   * it by; placement is what decides the board (see `boardKeyForRequest`). So
   * loading the maintenance board found the 31 Store Documentation rows
   * apparently unplaced, and issued 31 INSERTs that every one conflicted on the
   * request_id key and were discarded by `onConflictDoNothing`. Correctly
   * discarded — filing sd-001 onto the maintenance board would be wrong — but
   * re-attempted on every board load by every user, for ever: 31 of the 82
   * statements a warm `/api/board` request issued, doing nothing.
   *
   * Reading placements board-wide makes the question match the key. Position
   * accounting stays per-board, because that is genuinely a per-board fact.
   */
  const placements = await db
    .select({
      requestId: maintenanceGroupItems.requestId,
      boardId: maintenanceGroupItems.boardId,
      groupId: maintenanceGroupItems.groupId,
      position: maintenanceGroupItems.position,
    })
    .from(maintenanceGroupItems)
    .where(eq(maintenanceGroupItems.organisationId, orgId));
  const placed = new Set(placements.map((item) => item.requestId));
  const nextPosition = new Map<string, number>();
  for (const group of groups) {
    const current = placements
      .filter((item) => item.boardId === boardId && item.groupId === group.id)
      .reduce((highest, item) => Math.max(highest, item.position), -1);
    nextPosition.set(group.id, current + 1);
  }

  for (const request of requests) {
    if (placed.has(request.id)) continue;
    const group =
      groups.find((item) => item.stageKey === request.stage) ?? groups[0];
    if (!group) continue;
    const position = nextPosition.get(group.id) ?? 0;
    nextPosition.set(group.id, position + 1);
    await db
      .insert(maintenanceGroupItems)
      .values({
        requestId: request.id,
        organisationId: orgId,
        boardId: boardId,
        groupId: group.id,
        position,
      })
      .onConflictDoNothing();
  }

  return db;
}

async function boardPayload(db: BoardDb, orgId: string, boardId: BoardId) {
  await ensureBoardState(db, orgId, boardId);
  const groups = await db
    .select()
    .from(maintenanceGroups)
    .where(and(eq(maintenanceGroups.boardId, boardId), eq(maintenanceGroups.organisationId, orgId),
            isNull(maintenanceGroups.deletedAt),))
    .orderBy(asc(maintenanceGroups.position));
  const items = await db
    .select()
    .from(maintenanceGroupItems)
    .where(and(eq(maintenanceGroupItems.boardId, boardId), eq(maintenanceGroupItems.organisationId, orgId)))
    .orderBy(asc(maintenanceGroupItems.groupId), asc(maintenanceGroupItems.position));
  const options = await db
    .select()
    .from(maintenanceBoardOptions)
    .where(and(eq(maintenanceBoardOptions.boardId, boardId), eq(maintenanceBoardOptions.organisationId, orgId)))
    .orderBy(
      asc(maintenanceBoardOptions.columnKey),
      asc(maintenanceBoardOptions.position),
    );
  const columnRows = await db
    .select()
    .from(maintenanceBoardColumns)
    .where(and(eq(maintenanceBoardColumns.boardId, boardId), eq(maintenanceBoardColumns.organisationId, orgId)))
    .orderBy(asc(maintenanceBoardColumns.position));
  const cells = await db
    .select({
      requestId: maintenanceBoardCells.requestId,
      columnId: maintenanceBoardCells.columnId,
      value: maintenanceBoardCells.value,
    })
    .from(maintenanceBoardCells)
    .where(and(eq(maintenanceBoardCells.boardId, boardId), eq(maintenanceBoardCells.organisationId, orgId)));
  /*
   * Counts AND the first few files per cell, in one pass.
   *
   * This was a `COUNT(*)` grouped by cell, which is all a paperclip-and-number
   * cell needed. Drawing monday's thumbnails needs the files themselves, and
   * the obvious way to get them — a fetch per cell — is 744 requests on a board
   * that already renders 744 rows.
   *
   * So the rows are selected once, ordered, and grouped in memory. The whole
   * table is 2,915 rows carrying four small columns; that is far cheaper than
   * the round trips, and it keeps the board a single query the way every other
   * part of this payload is.
   *
   * `objectKey`, `uploadedByEmail` and the rest are deliberately not selected.
   * The board payload is the widest response this app sends and a chip needs
   * five fields to draw: an id (the inline and download URLs are `/api/files/
   * <id>`, derived on the client so the storage path never reaches the DOM), a
   * type and a name for the glyph and the label, and `byteSize` + `createdAt`
   * for what the chip announces and what the viewer prints. `objectKey` in
   * particular must never enter this projection.
   *
   * SCOPED TO THIS BOARD'S COLUMNS.
   *
   * This asked for every attachment in the organisation that carries any board
   * column at all, so a 25-column board was served the other board's 1,060
   * preview groups to find its own 53. Every board paid for every board. The
   * filter is `inArray(boardColumnId, <this board's column ids>)`, chunked
   * because `IN (…)` has a variable limit, and it is what pays for the two
   * extra fields above several times over.
   *
   * Chunking is by COLUMN, so every attachment in one cell lands in the same
   * chunk and the `createdAt` ordering the preview depends on survives the
   * concatenation. Chunking by request id would not have that property.
   */
  const boardColumnIds = columnRows.map((column) => column.id);
  const attachmentRows = await selectInChunks(boardColumnIds, (chunk) =>
    db
      .select({
        id: attachments.id,
        requestId: attachments.requestId,
        columnId: attachments.boardColumnId,
        contentType: attachments.contentType,
        originalName: attachments.originalName,
        byteSize: attachments.byteSize,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .where(
        and(
          isNotNull(attachments.boardColumnId),
          eq(attachments.organisationId, orgId),
          inArray(attachments.boardColumnId, chunk),
        ),
      )
      .orderBy(asc(attachments.createdAt)),
  );

  const grouped = new Map<
    string,
    {
      requestId: string;
      columnId: string;
      count: number;
      preview: MaintenanceBoardFilePreview[];
    }
  >();
  for (const row of attachmentRows) {
    if (!row.requestId || !row.columnId) continue;
    const key = `${row.requestId}::${row.columnId}`;
    let entry = grouped.get(key);
    if (!entry) {
      entry = { requestId: row.requestId, columnId: row.columnId, count: 0, preview: [] };
      grouped.set(key, entry);
    }
    entry.count += 1;
    // Four, because the cell draws three tiles and a "+N" — the fourth is what
    // tells the client whether the overflow badge is needed without a second ask.
    if (entry.preview.length < 4) {
      entry.preview.push({
        id: row.id,
        contentType: row.contentType,
        originalName: row.originalName,
        byteSize: row.byteSize,
        createdAt: row.createdAt,
      });
    }
  }
  /*
   * THE TWO PICTURE COLUMNS ARE DEFINED BY EVIDENCE KIND, NOT BY COLUMN ID.
   *
   * Everything above keys on `board_column_id`, which is right for a file
   * column an admin added: you drop a file into a cell and the cell remembers
   * which one. "Pictures of Maintenance Issue" and "Picture of completed works"
   * do not work that way. They are the two ends of the evidence flow, and every
   * path that files evidence tags it with a KIND and leaves the column null —
   * the request form's `uploadEvidenceFile({ kind: "issue" })`, the contractor's
   * job link, the Fix Tracker's completion upload, the evidence manager. The
   * cells agree: `systemCell` opens them with `onOpenFiles("issue")` and
   * `onOpenFiles("completion")`, never by column.
   *
   * So the count and the cell disagreed. A job raised through the form with two
   * photographs showed "2 photos" on its Fix Tracker card, opened to two
   * photographs from the grid — and the grid cell itself read "Add", because
   * `board_column_id IS NULL` on all nine attachments in this workspace.
   *
   * Kind-filed evidence is therefore gathered separately and filed under the
   * matching column, so the number on the cell is the number behind it. Only
   * `boardColumnId IS NULL` rows are read here: an attachment that names a
   * column has already been counted above, and must not be counted twice.
   */
  const kindColumns = new Map(
    columnRows
      .filter((column) => column.key === "issuePictures" || column.key === "completedPictures")
      .map((column) => [column.key === "issuePictures" ? "issue" : "completion", column.id]),
  );
  if (kindColumns.size) {
    const kindRows = await db
      .select({
        id: attachments.id,
        requestId: attachments.requestId,
        kind: attachments.kind,
        contentType: attachments.contentType,
        originalName: attachments.originalName,
        byteSize: attachments.byteSize,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .where(
        and(
          eq(attachments.organisationId, orgId),
          isNull(attachments.boardColumnId),
          inArray(attachments.kind, [...kindColumns.keys()]),
        ),
      )
      .orderBy(asc(attachments.createdAt));
    for (const row of kindRows) {
      const columnId = kindColumns.get(row.kind);
      if (!row.requestId || !columnId) continue;
      const key = `${row.requestId}::${columnId}`;
      let entry = grouped.get(key);
      if (!entry) {
        entry = { requestId: row.requestId, columnId, count: 0, preview: [] };
        grouped.set(key, entry);
      }
      entry.count += 1;
      if (entry.preview.length < 4) {
        entry.preview.push({
          id: row.id,
          contentType: row.contentType,
          originalName: row.originalName,
          byteSize: row.byteSize,
          createdAt: row.createdAt,
        });
      }
    }
  }
  const fileCounts = [...grouped.values()];
  /*
   * The rows themselves.
   *
   * `items` carries only placement — which group a row sits in and at what
   * position — so a board served without this holds 32 placements pointing at
   * nothing and renders empty. The maintenance board never noticed because the
   * dashboard fetches its rows separately and hands them to the grid; Store
   * Documentation has no such second source, and came up blank with all 31
   * stores sitting in the database.
   *
   * Scoped to the ids this board actually places, so a board's payload never
   * carries another board's rows, and chunked because `IN (…)` has a variable
   * limit that a 700-row board would exceed.
   */
  const placedIds = items.map((item) => item.requestId);
  /*
   * Stage 23. `placedIds` already excludes binned jobs — a soft delete removes
   * the placement, which is what these ids come from — so this filter is belt
   * and braces rather than the load-bearing one. It is here because a reader
   * checking "does the board show deleted rows?" should find the answer in the
   * query that fetches the rows, not have to reason about a join two functions
   * away.
   */
  const requestRows = await selectInChunks(placedIds, (chunk) =>
    db
      .select()
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          inArray(maintenanceRequests.id, chunk),
          isNull(maintenanceRequests.deletedAt),
        ),
      ),
  );

  /*
   * The one compliance fact the board cannot hold.
   *
   * Store Documentation's Compliance Tracker tab is driven off this payload and
   * nothing else, which is right — the board is the record. But "this store does
   * not need a sprinkler report" has no board column; it lives in
   * `compliance_documents.not_required`, set from Manage register. Without it
   * here the tab offers a "Not required" filter that can never match anything,
   * and Westfield Stratford's fire alarm and water hygiene read "Missing" on the
   * tab while /dashboard/compliance — which does read the override — calls them
   * "Not required". The same flag, two answers, one tab apart.
   *
   * Only for this board: it is a compliance concept, and asking for it on the
   * 744-row maintenance board would be four queries spent on nothing.
   */
  const notRequired =
    boardId === STORE_DOCUMENTATION_BOARD_ID
      ? await readNotRequiredSlots(db, orgId)
      : [];

  return {
    groups,
    items,
    options,
    columns: columnRows.map(columnPayload),
    cells,
    fileCounts,
    notRequired,
    requests: requestRows.map(exposeRequest),
  };
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    /*
     * `board.view` decides something now.
     *
     * The capability has existed in the catalogue since the matrix was built,
     * described to the administrator as "open the job, site and documentation
     * boards for this workspace" — and nothing read it. Revoking it hid the
     * sidebar entry and left this route answering in full to anyone who typed
     * the URL, so the matrix was describing a boundary the product did not
     * have.
     */
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    return Response.json(await boardPayload(db, orgId, boardIdFrom(request)));
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      { error: "The live board is temporarily unavailable." },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    // `identityEmail` and `session` are pulled through for the audit trail:
    // together they distinguish a signed-in action from one taken under the
    // testing role switcher, which a reader cannot tell apart otherwise.
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId, identityEmail, session } = guard.scope;
    const payload = (await request.json()) as Record<string, unknown>;
    const action = trimString(payload.action, 40);
    const boardId = boardIdFrom(request);
    await ensureBoardState(db, orgId, boardId);

    if (action === "create_group") {
      const name = trimString(payload.name, 80);
      if (name.length < 2) {
        return Response.json(
          { error: "Enter a group name." },
          { status: 400 },
        );
      }
      const [last] = await db
        .select({ value: max(maintenanceGroups.position) })
        .from(maintenanceGroups)
        .where(and(eq(maintenanceGroups.boardId, boardId), eq(maintenanceGroups.organisationId, orgId),
            isNull(maintenanceGroups.deletedAt),));
      const requestedColor = trimString(payload.color, 12).toLowerCase();
      const [group] = await db
        .insert(maintenanceGroups)
        .values({
          id: `group-${crypto.randomUUID()}`,
          organisationId: orgId,
          boardId: boardId,
          name,
          color: groupColors.has(requestedColor)
            ? requestedColor
            : "#579bfc",
          stageKey: null,
          position: Number(last.value ?? -1) + 1,
        })
        .returning();
      return Response.json({ group }, { status: 201 });
    }

    if (action === "create_item") {
      const groupId = trimString(payload.groupId, 80);
      const [group] = await db
        .select()
        .from(maintenanceGroups)
        .where(
          and(
            eq(maintenanceGroups.boardId, boardId),
            eq(maintenanceGroups.id, groupId),
            eq(maintenanceGroups.organisationId, orgId),
            isNull(maintenanceGroups.deletedAt),
          ),
        )
        .limit(1);
      if (!group) {
        return Response.json({ error: "Group not found." }, { status: 404 });
      }

      /*
       * Stage 23 — DELIBERATELY UNFILTERED. Do not add `isNull(deletedAt)`.
       *
       * This is the `MN-…` id generator, and a job sitting in the recycle bin
       * still owns its id. Excluding binned rows would hand the same reference
       * to a new job, and the collision would only surface when somebody
       * restored the old one — the worst possible moment to discover it.
       */
      const [latest] = await db
        .select({
          maxNumber: sql<number>`coalesce(max(cast(substr(${maintenanceRequests.id}, 4) as integer)), 1048)`,
        })
        .from(maintenanceRequests)
        .where(eq(maintenanceRequests.organisationId, orgId));
      const [last] = await db
        .select({ value: max(maintenanceGroupItems.position) })
        .from(maintenanceGroupItems)
        .where(and(eq(maintenanceGroupItems.groupId, group.id), eq(maintenanceGroupItems.organisationId, orgId)));
      const id = `MN-${Number(latest.maxNumber ?? 1048) + 1}`;
      const requestedAt = new Date().toISOString();
      const stage =
        (group.stageKey as RequestStage | null) ?? ("Incoming" as const);
      const [created] = await db
        .insert(maintenanceRequests)
        .values({
          id,
          organisationId: orgId,
          siteId: "site-unassigned",
          source: "Manual",
          title: newItemTitle(boardId),
          description: newItemTitle(boardId),
          location: "Choose a location",
          requester: actor.displayName || actor.email,
          contact: "Not provided",
          category: "Other",
          engineer: "Handyman",
          tier: 3,
          priority: "Medium",
          stage,
          status: statusForStage(stage),
          contractor: null,
          assignee: null,
          requestedAt,
          dueAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
          completedAt: null,
          nextUpdateAt: null,
          cost: null,
          attachmentCount: 0,
          issueAttachmentCount: 0,
          completedAttachmentCount: 0,
          generalAttachmentCount: 0,
          commentCount: 0,
          createdByEmail: actor.email,
        })
        .returning();
      const [item] = await db
        .insert(maintenanceGroupItems)
        .values({
          requestId: id,
          organisationId: orgId,
          boardId: boardId,
          groupId: group.id,
          position: Number(last.value ?? -1) + 1,
        })
        .returning();

      await db.insert(activityLog).values({
        id: crypto.randomUUID(),
        organisationId: orgId,
        entityType: "maintenance_request",
        entityId: id,
        action: "request.created_inline",
        actorEmail: actor.email,
        detail: JSON.stringify({ groupId: group.id }),
      });
      return Response.json({ request: created, item }, { status: 201 });
    }

    if (action === "create_column") {
      const type = trimString(payload.type, 30) as BoardColumnType;
      if (!boardColumnTypes.has(type)) {
        return Response.json(
          { error: "Choose a supported column type." },
          { status: 400 },
        );
      }
      const [columnCount] = await db
        .select({ value: count() })
        .from(maintenanceBoardColumns)
        .where(
          and(
            eq(maintenanceBoardColumns.boardId, boardId),
            eq(maintenanceBoardColumns.system, false),
            eq(maintenanceBoardColumns.organisationId, orgId),
          ),
        );
      if (Number(columnCount.value) >= 40) {
        return Response.json(
          { error: "This board has reached the 40 custom-column limit." },
          { status: 409 },
        );
      }
      const existingColumns = await db
        .select({ title: maintenanceBoardColumns.title })
        .from(maintenanceBoardColumns)
        .where(and(eq(maintenanceBoardColumns.boardId, boardId), eq(maintenanceBoardColumns.organisationId, orgId)));
      const existingTitles = new Set(
        existingColumns.map((column) => column.title.toLowerCase()),
      );
      const requestedTitle =
        trimString(payload.title, 80) || boardColumnDefaults[type].title;
      let title = requestedTitle;
      let suffix = 2;
      while (existingTitles.has(title.toLowerCase())) {
        title = `${requestedTitle} ${suffix}`;
        suffix += 1;
      }
      const orderedColumns = await db
        .select()
        .from(maintenanceBoardColumns)
        .where(and(eq(maintenanceBoardColumns.boardId, boardId), eq(maintenanceBoardColumns.organisationId, orgId)))
        .orderBy(asc(maintenanceBoardColumns.position));
      for (const [index, column] of orderedColumns.entries()) {
        const position = index * 1000;
        if (column.position === position) continue;
        await db
          .update(maintenanceBoardColumns)
          .set({ position })
          .where(and(eq(maintenanceBoardColumns.id, column.id), eq(maintenanceBoardColumns.organisationId, orgId)));
        column.position = position;
      }
      const afterColumnId = trimString(payload.afterColumnId, 100);
      const afterIndex = orderedColumns.findIndex(
        (column) => column.id === afterColumnId,
      );
      const position =
        afterIndex >= 0
          ? orderedColumns[afterIndex].position + 500
          : orderedColumns.length * 1000;
      const id = `column-${crypto.randomUUID()}`;
      const [created] = await db
        .insert(maintenanceBoardColumns)
        .values({
          id,
          organisationId: orgId,
          boardId: boardId,
          key: `custom-${crypto.randomUUID()}`,
          title,
          type,
          position,
          width: boardColumnDefaults[type].width,
          settings: JSON.stringify(defaultSettings(type)),
          system: false,
        })
        .returning();
      return Response.json(
        { column: columnPayload(created) },
        { status: 201 },
      );
    }

    if (action === "duplicate_column") {
      const columnId = trimString(payload.columnId, 100);
      const [source] = await db
        .select()
        .from(maintenanceBoardColumns)
        .where(
          and(
            eq(maintenanceBoardColumns.boardId, boardId),
            eq(maintenanceBoardColumns.id, columnId),
            eq(maintenanceBoardColumns.organisationId, orgId),
          ),
        )
        .limit(1);
      if (!source) {
        return Response.json({ error: "Column not found." }, { status: 404 });
      }
      if (source.system) {
        return Response.json(
          { error: "System columns cannot be duplicated." },
          { status: 400 },
        );
      }
      const [columnCount] = await db
        .select({ value: count() })
        .from(maintenanceBoardColumns)
        .where(
          and(
            eq(maintenanceBoardColumns.boardId, boardId),
            eq(maintenanceBoardColumns.system, false),
            eq(maintenanceBoardColumns.organisationId, orgId),
          ),
        );
      if (Number(columnCount.value) >= 40) {
        return Response.json(
          { error: "This board has reached the 40 custom-column limit." },
          { status: 409 },
        );
      }
      const orderedColumns = await db
        .select()
        .from(maintenanceBoardColumns)
        .where(and(eq(maintenanceBoardColumns.boardId, boardId), eq(maintenanceBoardColumns.organisationId, orgId)))
        .orderBy(asc(maintenanceBoardColumns.position));
      for (const [index, column] of orderedColumns.entries()) {
        const position = index * 1000;
        if (column.position === position) continue;
        await db
          .update(maintenanceBoardColumns)
          .set({ position })
          .where(and(eq(maintenanceBoardColumns.id, column.id), eq(maintenanceBoardColumns.organisationId, orgId)));
        column.position = position;
      }
      const sourceIndex = orderedColumns.findIndex(
        (column) => column.id === source.id,
      );
      const position =
        sourceIndex >= 0
          ? orderedColumns[sourceIndex].position + 500
          : orderedColumns.length * 1000;
      const id = `column-${crypto.randomUUID()}`;
      const [created] = await db
        .insert(maintenanceBoardColumns)
        .values({
          id,
          organisationId: orgId,
          boardId: boardId,
          key: `custom-${crypto.randomUUID()}`,
          title: `${source.title} copy`.slice(0, 80),
          type: source.type,
          position,
          width: source.width,
          settings: source.settings,
          system: false,
        })
        .returning();
      const sourceCells = await db
        .select()
        .from(maintenanceBoardCells)
        .where(and(eq(maintenanceBoardCells.columnId, source.id), eq(maintenanceBoardCells.organisationId, orgId)));
      const duplicatedCells: Array<{
        requestId: string;
        columnId: string;
        value: string;
      }> = [];
      for (const sourceCell of sourceCells) {
        const [cell] = await db
          .insert(maintenanceBoardCells)
          .values({
            id: `cell-${crypto.randomUUID()}`,
            organisationId: orgId,
            boardId: boardId,
            requestId: sourceCell.requestId,
            columnId: id,
            value: sourceCell.value,
          })
          .returning();
        duplicatedCells.push({
          requestId: cell.requestId,
          columnId: cell.columnId,
          value: cell.value,
        });
      }
      return Response.json(
        { column: columnPayload(created), cells: duplicatedCells },
        { status: 201 },
      );
    }

    if (action === "create_option") {
      const columnKey = trimString(payload.columnKey, 30) as BoardOptionColumn;
      const label = trimString(payload.label, 80);
      if (!optionColumns.has(columnKey) || label.length < 1) {
        return Response.json(
          { error: "Choose a supported column and enter a label." },
          { status: 400 },
        );
      }
      const existing = await db
        .select({
          value: maintenanceBoardOptions.value,
          label: maintenanceBoardOptions.label,
        })
        .from(maintenanceBoardOptions)
        .where(
          and(
            eq(maintenanceBoardOptions.boardId, boardId),
            eq(maintenanceBoardOptions.columnKey, columnKey),
            eq(maintenanceBoardOptions.organisationId, orgId),
          ),
        );
      if (
        existing.some(
          (item) =>
            item.label.toLowerCase() === label.toLowerCase() ||
            item.value.toLowerCase() === label.toLowerCase(),
        )
      ) {
        return Response.json(
          { error: "That label already exists." },
          { status: 409 },
        );
      }
      const [last] = await db
        .select({ value: max(maintenanceBoardOptions.position) })
        .from(maintenanceBoardOptions)
        .where(
          and(
            eq(maintenanceBoardOptions.boardId, boardId),
            eq(maintenanceBoardOptions.columnKey, columnKey),
            eq(maintenanceBoardOptions.organisationId, orgId),
          ),
        );
      const position = Number(last.value ?? -1) + 1;
      const value =
        columnKey === "tier"
          ? String(
              Math.max(
                1,
                ...existing.map((item) => Number(item.value) || 0),
              ) + 1,
            )
          : label;
      const requestedColor = trimString(payload.color, 12).toLowerCase();
      const [created] = await db
        .insert(maintenanceBoardOptions)
        .values({
          id: `option-${crypto.randomUUID()}`,
          organisationId: orgId,
          boardId: boardId,
          columnKey,
          value,
          label,
          color: validOptionColor(requestedColor)
            ? requestedColor
            : "#579bfc",
          textColor: requestedColor === "#d9ecfb" ? "#456579" : "#ffffff",
          active: true,
          system: false,
          position,
        })
        .returning();
      return Response.json({ option: created }, { status: 201 });
    }

    if (action === "duplicate_items") {
      const requestIds = requestIdsFrom(payload);
      if (!requestIds.length) {
        return Response.json(
          { error: "Select at least one item to duplicate." },
          { status: 400 },
        );
      }
      // Stage 23 — a job in the recycle bin cannot be duplicated. Restore it
      // first; duplicating one would put a copy on the board while the original
      // stayed invisible in the bin.
      const sourceRows = await selectInChunks(requestIds, (chunk) =>
        db
          .select()
          .from(maintenanceRequests)
          .where(
            and(
              inArray(maintenanceRequests.id, chunk),
              eq(maintenanceRequests.organisationId, orgId),
              isNull(maintenanceRequests.deletedAt),
            ),
          ),
      );
      const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
      const sourceItems = await selectInChunks(requestIds, (chunk) =>
        db
          .select()
          .from(maintenanceGroupItems)
          .where(and(inArray(maintenanceGroupItems.requestId, chunk), eq(maintenanceGroupItems.organisationId, orgId))),
      );
      const itemByRequest = new Map(
        sourceItems.map((item) => [item.requestId, item]),
      );
      const sourceCells = await selectInChunks(requestIds, (chunk) =>
        db
          .select()
          .from(maintenanceBoardCells)
          .where(and(inArray(maintenanceBoardCells.requestId, chunk), eq(maintenanceBoardCells.organisationId, orgId))),
      );
      /*
       * Stage 23 — DELIBERATELY UNFILTERED. Do not add `isNull(deletedAt)`.
       *
       * This is the `MN-…` id generator, and a job sitting in the recycle bin
       * still owns its id. Excluding binned rows would hand the same reference
       * to a new job, and the collision would only surface when somebody
       * restored the old one — the worst possible moment to discover it.
       */
      const [latest] = await db
        .select({
          maxNumber: sql<number>`coalesce(max(cast(substr(${maintenanceRequests.id}, 4) as integer)), 1048)`,
        })
        .from(maintenanceRequests)
        .where(eq(maintenanceRequests.organisationId, orgId));
      let nextNumber = Number(latest.maxNumber ?? 1048) + 1;
      const nextPositions = new Map<string, number>();
      const createdRequests: Array<typeof maintenanceRequests.$inferSelect> = [];
      const createdItems: Array<typeof maintenanceGroupItems.$inferSelect> = [];
      const createdCells: Array<{
        requestId: string;
        columnId: string;
        value: string;
      }> = [];

      for (const sourceId of requestIds) {
        const source = sourceById.get(sourceId);
        if (!source) continue;
        const sourceItem = itemByRequest.get(sourceId);
        const groupId = sourceItem?.groupId ?? tenantSeedId("group-incoming", orgId);
        let position = nextPositions.get(groupId);
        if (position === undefined) {
          const [last] = await db
            .select({ value: max(maintenanceGroupItems.position) })
            .from(maintenanceGroupItems)
            .where(and(eq(maintenanceGroupItems.groupId, groupId), eq(maintenanceGroupItems.organisationId, orgId)));
          position = Number(last.value ?? -1) + 1;
        }
        nextPositions.set(groupId, position + 1);
        const id = `MN-${nextNumber}`;
        nextNumber += 1;
        const now = new Date().toISOString();
        const [created] = await db
          .insert(maintenanceRequests)
          .values({
            id,
            organisationId: orgId,
            siteId: source.siteId,
            source: source.source,
            title: `${source.title} (copy)`.slice(0, 180),
            description: source.description,
            location: source.location,
            requester: source.requester,
            contact: source.contact,
            category: source.category,
            engineer: source.engineer,
            tier: source.tier,
            priority: source.priority,
            stage: source.stage,
            status: source.status,
            contractor: source.contractor,
            assignee: source.assignee,
            requestedAt: source.requestedAt,
            dueAt: source.dueAt,
            completedAt: source.completedAt,
            nextUpdateAt: source.nextUpdateAt,
            cost: source.cost,
            approvedBy: source.approvedBy,
            invoice: source.invoice,
            attachmentCount: 0,
            issueAttachmentCount: 0,
            completedAttachmentCount: 0,
            generalAttachmentCount: 0,
            formUrl: null,
            publicUploadTokenHash: null,
            publicUploadTokenExpiresAt: null,
            commentCount: 0,
            createdByEmail: actor.email,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const [item] = await db
          .insert(maintenanceGroupItems)
          .values({
            requestId: id,
            organisationId: orgId,
            boardId: boardId,
            groupId,
            position,
          })
          .returning();
        for (const sourceCell of sourceCells.filter(
          (cell) => cell.requestId === sourceId,
        )) {
          const [cell] = await db
            .insert(maintenanceBoardCells)
            .values({
              id: `cell-${crypto.randomUUID()}`,
              organisationId: orgId,
              boardId: boardId,
              requestId: id,
              columnId: sourceCell.columnId,
              value: sourceCell.value,
            })
            .returning();
          createdCells.push({
            requestId: cell.requestId,
            columnId: cell.columnId,
            value: cell.value,
          });
        }
        await db.insert(activityLog).values({
          id: crypto.randomUUID(),
          organisationId: orgId,
          entityType: "maintenance_request",
          entityId: id,
          action: "request.duplicated",
          actorEmail: actor.email,
          detail: JSON.stringify({ sourceRequestId: sourceId, groupId }),
        });
        createdRequests.push(created);
        createdItems.push(item);
      }
      return Response.json(
        { requests: createdRequests, items: createdItems, cells: createdCells },
        { status: 201 },
      );
    }

    if (action === "move_items" || action === "archive_items") {
      const requestIds = requestIdsFrom(payload);
      if (!requestIds.length) {
        return Response.json(
          { error: "Select at least one item." },
          { status: 400 },
        );
      }

      let group =
        action === "move_items"
          ? (
              await db
                .select()
                .from(maintenanceGroups)
                .where(and(eq(maintenanceGroups.id, trimString(payload.groupId, 80)), eq(maintenanceGroups.organisationId, orgId)))
                .limit(1)
            )[0]
          : (
              await db
                .select()
                .from(maintenanceGroups)
                .where(
                  and(
                    eq(maintenanceGroups.boardId, boardId),
                    eq(maintenanceGroups.name, "Archived"),
                    eq(maintenanceGroups.organisationId, orgId),
            isNull(maintenanceGroups.deletedAt),
                  ),
                )
                .limit(1)
            )[0];

      if (!group && action === "archive_items") {
        const [lastGroup] = await db
          .select({ value: max(maintenanceGroups.position) })
          .from(maintenanceGroups)
          .where(and(eq(maintenanceGroups.boardId, boardId), eq(maintenanceGroups.organisationId, orgId),
            isNull(maintenanceGroups.deletedAt),));
        [group] = await db
          .insert(maintenanceGroups)
          .values({
            id: `group-${crypto.randomUUID()}`,
            organisationId: orgId,
            boardId: boardId,
            name: "Archived",
            color: "#808080",
            stageKey: null,
            position: Number(lastGroup.value ?? -1) + 1,
          })
          .returning();
      }
      if (!group) {
        return Response.json({ error: "Group not found." }, { status: 404 });
      }

      const [last] = await db
        .select({ value: max(maintenanceGroupItems.position) })
        .from(maintenanceGroupItems)
        .where(and(eq(maintenanceGroupItems.groupId, group.id), eq(maintenanceGroupItems.organisationId, orgId)));
      let position = Number(last.value ?? -1) + 1;
      const movedItems: Array<typeof maintenanceGroupItems.$inferSelect> = [];
      const updatedRequests: Array<typeof maintenanceRequests.$inferSelect> = [];

      for (const requestId of requestIds) {
        const [existing] = await db
          .select()
          .from(maintenanceGroupItems)
          .where(and(eq(maintenanceGroupItems.requestId, requestId), eq(maintenanceGroupItems.organisationId, orgId)))
          .limit(1);
        if (!existing) continue;
        const [item] = await db
          .update(maintenanceGroupItems)
          .set({
            groupId: group.id,
            position,
            updatedAt: new Date().toISOString(),
          })
          .where(and(eq(maintenanceGroupItems.requestId, requestId), eq(maintenanceGroupItems.organisationId, orgId)))
          .returning();
        position += 1;
        movedItems.push(item);

        if (group.stageKey) {
          const stage = group.stageKey as RequestStage;
          const [updated] = await db
            .update(maintenanceRequests)
            .set({
              stage,
              status: statusForStage(stage),
              completedAt:
                stage === "Completed" ? new Date().toISOString() : null,
              updatedAt: new Date().toISOString(),
            })
            .where(and(eq(maintenanceRequests.id, requestId), eq(maintenanceRequests.organisationId, orgId)))
            .returning();
          if (updated) updatedRequests.push(updated);
        }
        await db.insert(activityLog).values({
          id: crypto.randomUUID(),
          organisationId: orgId,
          entityType: "maintenance_request",
          entityId: requestId,
          action:
            action === "archive_items"
              ? "request.archived"
              : "request.group_changed",
          actorEmail: actor.email,
          detail: JSON.stringify({ groupId: group.id, groupName: group.name }),
        });
      }
      return Response.json({
        group,
        items: movedItems,
        requests: updatedRequests,
      });
    }

    if (action === "delete_items") {
      const requestIds = requestIdsFrom(payload);
      if (!requestIds.length) {
        return Response.json(
          { error: "Select at least one item to delete." },
          { status: 400 },
        );
      }
      /*
       * STAGE 23 — THIS USED TO BE THE HARD DELETE, AND IS NOW THE BIN.
       *
       * Until Stage 23 this block deleted the R2 objects, the attachments, the
       * placements, the cells, the `activity_log` history and finally the job
       * rows themselves. Nothing survived it, which is exactly what the Trash
       * screen said at the time.
       *
       * The owner asked for monday's behaviour — thirty days of backup, and a
       * place to find deleted things — so the destruction moved to
       * `DELETE /api/trash`, behind `data.delete` and a second deliberate act.
       * What happens here now is a soft delete: the job keeps its row, its
       * cells, its files and its history, loses only its placement, and gains a
       * `recycle_bin` entry holding the group and position it was sitting at.
       *
       * Losing the placement is what takes it off the board. Every board read
       * joins through `maintenance_group_items`, so all of them exclude a binned
       * job without being changed — see `app/lib/recycle-bin.ts`.
       */
      const binned = await sendJobsToBin(
        db,
        orgId,
        { email: identityEmail || actor.email, displayName: actor.displayName },
        requestIds,
      );

      if (!binned.length) {
        return Response.json(
          { error: "Those items are not on this board, or are already in the bin." },
          { status: 404 },
        );
      }

      /*
       * Still audited, and still audited after the fact.
       *
       * The action is no longer irreversible, but the audit trail is what the
       * Trash screen's deletion history reads from and it must not develop a
       * hole at the exact moment deleting became recoverable. `board.items_deleted`
       * is kept as the verb so existing history and new history read alike; the
       * detail says where they went.
       */
      await recordAudit({
        db,
        organisationId: orgId,
        actor: auditActor({ actor, identityEmail, session }),
        action: "board.items_deleted",
        entityType: "maintenance_request",
        summary: `Moved ${binned.length} board item${binned.length === 1 ? "" : "s"} from ${boardId} to the recycle bin.`,
        detail: {
          board: boardId,
          requestIds: binned,
          recoverable: true,
          retentionDays: RETENTION_DAYS,
        },
        request,
      });

      return Response.json({
        deletedIds: binned,
        recycled: true,
        retentionDays: RETENTION_DAYS,
        message: `${binned.length} item${binned.length === 1 ? "" : "s"} moved to the recycle bin. They can be restored for ${RETENTION_DAYS} days.`,
      });
    }

    return Response.json({ error: "Unknown board action." }, { status: 400 });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      { error: "The board change could not be saved." },
      { status: 503 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId, identityEmail } = guard.scope;
    const payload = (await request.json()) as Record<string, unknown>;
    const action = trimString(payload.action, 40);
    const boardId = boardIdFrom(request);
    await ensureBoardState(db, orgId, boardId);

    if (action === "rename_group") {
      const groupId = trimString(payload.groupId, 80);
      const name = trimString(payload.name, 80);
      if (!groupId || name.length < 2) {
        return Response.json(
          { error: "A group and a valid name are required." },
          { status: 400 },
        );
      }
      const [group] = await db
        .update(maintenanceGroups)
        .set({ name, updatedAt: new Date().toISOString() })
        .where(and(eq(maintenanceGroups.id, groupId), eq(maintenanceGroups.organisationId, orgId)))
        .returning();
      if (!group) {
        return Response.json({ error: "Group not found." }, { status: 404 });
      }
      return Response.json({ group });
    }

    if (action === "update_group") {
      const groupId = trimString(payload.groupId, 80);
      const requestedColor = trimString(payload.color, 12).toLowerCase();
      if (!groupId || !groupColors.has(requestedColor)) {
        return Response.json(
          { error: "Choose a valid group color." },
          { status: 400 },
        );
      }
      const [group] = await db
        .update(maintenanceGroups)
        .set({ color: requestedColor, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(maintenanceGroups.boardId, boardId),
            eq(maintenanceGroups.id, groupId),
            eq(maintenanceGroups.organisationId, orgId),
          ),
        )
        .returning();
      if (!group) {
        return Response.json({ error: "Group not found." }, { status: 404 });
      }
      return Response.json({ group });
    }

    if (action === "move_group") {
      const groupId = trimString(payload.groupId, 80);
      const direction = trimString(payload.direction, 10);
      if (!groupId || (direction !== "up" && direction !== "down")) {
        return Response.json(
          { error: "Choose a group and movement direction." },
          { status: 400 },
        );
      }
      const groups = await db
        .select()
        .from(maintenanceGroups)
        .where(and(eq(maintenanceGroups.boardId, boardId), eq(maintenanceGroups.organisationId, orgId),
            isNull(maintenanceGroups.deletedAt),))
        .orderBy(asc(maintenanceGroups.position));
      const index = groups.findIndex((group) => group.id === groupId);
      const neighbourIndex = direction === "up" ? index - 1 : index + 1;
      if (index < 0) {
        return Response.json({ error: "Group not found." }, { status: 404 });
      }
      if (neighbourIndex < 0 || neighbourIndex >= groups.length) {
        return Response.json(
          { error: `This group is already ${direction === "up" ? "first" : "last"}.` },
          { status: 409 },
        );
      }
      const selected = groups[index];
      const neighbour = groups[neighbourIndex];
      const temporaryPosition =
        Math.min(...groups.map((group) => group.position)) - 1000;
      const now = new Date().toISOString();
      await db
        .update(maintenanceGroups)
        .set({ position: temporaryPosition, updatedAt: now })
        .where(and(eq(maintenanceGroups.id, selected.id), eq(maintenanceGroups.organisationId, orgId)));
      await db
        .update(maintenanceGroups)
        .set({ position: selected.position, updatedAt: now })
        .where(and(eq(maintenanceGroups.id, neighbour.id), eq(maintenanceGroups.organisationId, orgId)));
      await db
        .update(maintenanceGroups)
        .set({ position: neighbour.position, updatedAt: now })
        .where(and(eq(maintenanceGroups.id, selected.id), eq(maintenanceGroups.organisationId, orgId)));
      const reordered = await db
        .select()
        .from(maintenanceGroups)
        .where(and(eq(maintenanceGroups.boardId, boardId), eq(maintenanceGroups.organisationId, orgId),
            isNull(maintenanceGroups.deletedAt),))
        .orderBy(asc(maintenanceGroups.position));
      return Response.json({ groups: reordered });
    }

    if (action === "sort_group") {
      const groupId = trimString(payload.groupId, 80);
      const requestIds = requestIdsFrom(payload);
      const groupItems = await db
        .select()
        .from(maintenanceGroupItems)
        .where(
          and(
            eq(maintenanceGroupItems.boardId, boardId),
            eq(maintenanceGroupItems.groupId, groupId),
            eq(maintenanceGroupItems.organisationId, orgId),
          ),
        );
      if (!groupItems.length && !requestIds.length) {
        return Response.json({ items: [] });
      }
      const validIds = new Set(groupItems.map((item) => item.requestId));
      if (
        requestIds.length !== groupItems.length ||
        requestIds.some((requestId) => !validIds.has(requestId))
      ) {
        return Response.json(
          { error: "The group changed while it was being sorted. Try again." },
          { status: 409 },
        );
      }
      const sortedItems: Array<typeof maintenanceGroupItems.$inferSelect> = [];
      for (const [position, requestId] of requestIds.entries()) {
        const [item] = await db
          .update(maintenanceGroupItems)
          .set({ position, updatedAt: new Date().toISOString() })
          .where(and(eq(maintenanceGroupItems.requestId, requestId), eq(maintenanceGroupItems.organisationId, orgId)))
          .returning();
        if (item) sortedItems.push(item);
      }
      return Response.json({ items: sortedItems });
    }

    if (action === "delete_group") {
      const groupId = trimString(payload.groupId, 80);
      const targetGroupId = trimString(payload.targetGroupId, 80);
      if (!groupId || !targetGroupId || groupId === targetGroupId) {
        return Response.json(
          { error: "Choose a different destination group." },
          { status: 400 },
        );
      }
      const [group] = await db
        .select()
        .from(maintenanceGroups)
        .where(
          and(
            eq(maintenanceGroups.boardId, boardId),
            eq(maintenanceGroups.id, groupId),
            eq(maintenanceGroups.organisationId, orgId),
            isNull(maintenanceGroups.deletedAt),
          ),
        )
        .limit(1);
      const [target] = await db
        .select()
        .from(maintenanceGroups)
        .where(
          and(
            eq(maintenanceGroups.boardId, boardId),
            eq(maintenanceGroups.id, targetGroupId),
            eq(maintenanceGroups.organisationId, orgId),
            isNull(maintenanceGroups.deletedAt),
          ),
        )
        .limit(1);
      if (!group || !target) {
        return Response.json({ error: "Group not found." }, { status: 404 });
      }
      const sourceItems = await db
        .select()
        .from(maintenanceGroupItems)
        .where(and(eq(maintenanceGroupItems.groupId, group.id), eq(maintenanceGroupItems.organisationId, orgId)))
        .orderBy(asc(maintenanceGroupItems.position));
      const [last] = await db
        .select({ value: max(maintenanceGroupItems.position) })
        .from(maintenanceGroupItems)
        .where(and(eq(maintenanceGroupItems.groupId, target.id), eq(maintenanceGroupItems.organisationId, orgId)));
      let position = Number(last.value ?? -1) + 1;
      const movedItems: Array<typeof maintenanceGroupItems.$inferSelect> = [];
      const updatedRequests: Array<typeof maintenanceRequests.$inferSelect> = [];
      for (const sourceItem of sourceItems) {
        const [item] = await db
          .update(maintenanceGroupItems)
          .set({
            groupId: target.id,
            position,
            updatedAt: new Date().toISOString(),
          })
          .where(and(eq(maintenanceGroupItems.requestId, sourceItem.requestId), eq(maintenanceGroupItems.organisationId, orgId)))
          .returning();
        position += 1;
        if (item) movedItems.push(item);
        if (target.stageKey) {
          const stage = target.stageKey as RequestStage;
          const [updated] = await db
            .update(maintenanceRequests)
            .set({
              stage,
              status: statusForStage(stage),
              completedAt:
                stage === "Completed" ? new Date().toISOString() : null,
              updatedAt: new Date().toISOString(),
            })
            .where(and(eq(maintenanceRequests.id, sourceItem.requestId), eq(maintenanceRequests.organisationId, orgId)))
            .returning();
          if (updated) updatedRequests.push(updated);
        }
      }
      /*
       * Stage 23 — the group goes to the recycle bin, not to nothing.
       *
       * Its items have just been re-parented to `target` above, so what is
       * recovered by a restore is the group itself: its name, colour, stage key,
       * description and the position it held. That is the part a person actually
       * loses by mis-clicking here, and it used to be unrecoverable.
       */
      await sendGroupToBin(
        db,
        orgId,
        { email: identityEmail || actor.email, displayName: actor.displayName },
        group.id,
      );
      return Response.json({
        deleted: true,
        recycled: true,
        retentionDays: RETENTION_DAYS,
        groupId: group.id,
        targetGroup: target,
        items: movedItems,
        requests: updatedRequests,
      });
    }

    if (action === "update_cell") {
      const requestId = trimString(payload.requestId, 40);
      const columnId = trimString(payload.columnId, 100);
      const [column] = await db
        .select()
        .from(maintenanceBoardColumns)
        .where(
          and(
            eq(maintenanceBoardColumns.boardId, boardId),
            eq(maintenanceBoardColumns.id, columnId),
            eq(maintenanceBoardColumns.organisationId, orgId),
          ),
        )
        .limit(1);
      const [workOrder] = await db
        .select({ id: maintenanceRequests.id })
        .from(maintenanceRequests)
        .where(and(eq(maintenanceRequests.id, requestId), eq(maintenanceRequests.organisationId, orgId)))
        .limit(1);
      if (!column || !workOrder) {
        return Response.json(
          { error: "The row or column no longer exists." },
          { status: 404 },
        );
      }
      const type = column.type as BoardColumnType;
      if (!boardColumnTypes.has(type) || type === "files") {
        return Response.json(
          { error: "This column cannot be edited as a regular cell." },
          { status: 400 },
        );
      }
      let value = "";
      try {
        value = normalizeCellValue(type, payload.value);
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof Error ? error.message : "Enter a valid value.",
          },
          { status: 400 },
        );
      }
      if (!value) {
        await db
          .delete(maintenanceBoardCells)
          .where(
            and(
              eq(maintenanceBoardCells.boardId, boardId),
              eq(maintenanceBoardCells.requestId, requestId),
              eq(maintenanceBoardCells.columnId, columnId),
              eq(maintenanceBoardCells.organisationId, orgId),
            ),
          );
        return Response.json({ cell: { requestId, columnId, value: "" } });
      }
      const now = new Date().toISOString();
      const [cell] = await db
        .insert(maintenanceBoardCells)
        .values({
          id: `cell-${crypto.randomUUID()}`,
          organisationId: orgId,
          boardId: boardId,
          requestId,
          columnId,
          value,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            maintenanceBoardCells.organisationId,
            maintenanceBoardCells.boardId,
            maintenanceBoardCells.requestId,
            maintenanceBoardCells.columnId,
          ],
          set: { value, updatedAt: now },
        })
        .returning();
      return Response.json({
        cell: {
          requestId: cell.requestId,
          columnId: cell.columnId,
          value: cell.value,
        },
      });
    }

    if (action === "update_column") {
      const columnId = trimString(payload.columnId, 100);
      const [existing] = await db
        .select()
        .from(maintenanceBoardColumns)
        .where(
          and(
            eq(maintenanceBoardColumns.boardId, boardId),
            eq(maintenanceBoardColumns.id, columnId),
            eq(maintenanceBoardColumns.organisationId, orgId),
          ),
        )
        .limit(1);
      if (!existing) {
        return Response.json({ error: "Column not found." }, { status: 404 });
      }
      const type = existing.type as BoardColumnType;
      const values: Partial<typeof maintenanceBoardColumns.$inferInsert> = {
        updatedAt: new Date().toISOString(),
      };
      const title = trimString(payload.title, 80);
      if (title) values.title = title;
      if (payload.settings !== undefined) {
        values.settings = JSON.stringify(
          cleanSettings(payload.settings, type),
        );
      }
      const width = Number(payload.width);
      if (Number.isInteger(width) && width >= 90 && width <= 600) {
        values.width = width;
      }
      const [column] = await db
        .update(maintenanceBoardColumns)
        .set(values)
        .where(and(eq(maintenanceBoardColumns.id, columnId), eq(maintenanceBoardColumns.organisationId, orgId)))
        .returning();
      return Response.json({ column: columnPayload(column) });
    }

    if (action === "clear_column" || action === "delete_column") {
      const columnId = trimString(payload.columnId, 100);
      const [existing] = await db
        .select()
        .from(maintenanceBoardColumns)
        .where(
          and(
            eq(maintenanceBoardColumns.boardId, boardId),
            eq(maintenanceBoardColumns.id, columnId),
            eq(maintenanceBoardColumns.organisationId, orgId),
          ),
        )
        .limit(1);
      if (!existing) {
        return Response.json({ error: "Column not found." }, { status: 404 });
      }
      if (existing.system) {
        return Response.json(
          { error: "System columns cannot be cleared or deleted." },
          { status: 400 },
        );
      }
      await deleteFilesForColumn(db, orgId, columnId);
      await db
        .delete(maintenanceBoardCells)
        .where(and(eq(maintenanceBoardCells.columnId, columnId), eq(maintenanceBoardCells.organisationId, orgId)));
      if (action === "delete_column") {
        await db
          .delete(maintenanceBoardColumns)
          .where(and(eq(maintenanceBoardColumns.id, columnId), eq(maintenanceBoardColumns.organisationId, orgId)));
      }
      return Response.json({
        cleared: true,
        deleted: action === "delete_column",
        columnId,
      });
    }

    if (action === "move_item") {
      const requestId = trimString(payload.requestId, 40);
      const groupId = trimString(payload.groupId, 80);
      const beforeRequestId = trimString(payload.beforeRequestId, 40) || null;
      const [group] = await db
        .select()
        .from(maintenanceGroups)
        .where(
          and(
            eq(maintenanceGroups.boardId, boardId),
            eq(maintenanceGroups.id, groupId),
            eq(maintenanceGroups.organisationId, orgId),
            isNull(maintenanceGroups.deletedAt),
          ),
        )
        .limit(1);
      if (!group) {
        return Response.json({ error: "Group not found." }, { status: 404 });
      }

      const [existingItem] = await db
        .select()
        .from(maintenanceGroupItems)
        .where(
          and(
            eq(maintenanceGroupItems.boardId, boardId),
            eq(maintenanceGroupItems.requestId, requestId),
            eq(maintenanceGroupItems.organisationId, orgId),
          ),
        )
        .limit(1);
      if (!existingItem) {
        return Response.json({ error: "Item not found." }, { status: 404 });
      }

      const targetRows = await db
        .select()
        .from(maintenanceGroupItems)
        .where(
          and(
            eq(maintenanceGroupItems.boardId, boardId),
            eq(maintenanceGroupItems.groupId, groupId),
            eq(maintenanceGroupItems.organisationId, orgId),
          ),
        )
        .orderBy(asc(maintenanceGroupItems.position));
      const targetIds = targetRows
        .map((row) => row.requestId)
        .filter((id) => id !== requestId);
      if (beforeRequestId) {
        const targetIndex = targetIds.indexOf(beforeRequestId);
        if (targetIndex < 0) {
          return Response.json(
            { error: "The selected drop position is no longer available." },
            { status: 409 },
          );
        }
        targetIds.splice(targetIndex, 0, requestId);
      } else {
        targetIds.push(requestId);
      }

      const now = new Date().toISOString();
      const changedItems: Array<typeof maintenanceGroupItems.$inferSelect> = [];
      if (existingItem.groupId !== groupId) {
        const sourceRows = await db
          .select()
          .from(maintenanceGroupItems)
          .where(
            and(
              eq(maintenanceGroupItems.boardId, boardId),
              eq(maintenanceGroupItems.groupId, existingItem.groupId),
              eq(maintenanceGroupItems.organisationId, orgId),
            ),
          )
          .orderBy(asc(maintenanceGroupItems.position));
        for (const [position, row] of sourceRows
          .filter((row) => row.requestId !== requestId)
          .entries()) {
          const [updated] = await db
            .update(maintenanceGroupItems)
            .set({ position, updatedAt: now })
            .where(and(eq(maintenanceGroupItems.requestId, row.requestId), eq(maintenanceGroupItems.organisationId, orgId)))
            .returning();
          if (updated) changedItems.push(updated);
        }
      }

      for (const [position, id] of targetIds.entries()) {
        const [updated] = await db
          .update(maintenanceGroupItems)
          .set({ groupId, position, updatedAt: now })
          .where(and(eq(maintenanceGroupItems.requestId, id), eq(maintenanceGroupItems.organisationId, orgId)))
          .returning();
        if (updated) changedItems.push(updated);
      }
      const item = changedItems.find((row) => row.requestId === requestId);
      if (!item) {
        return Response.json(
          { error: "The item could not be reordered." },
          { status: 500 },
        );
      }

      let updatedRequest = null;
      if (existingItem.groupId !== groupId && group.stageKey) {
        const stage = group.stageKey as RequestStage;
        [updatedRequest] = await db
          .update(maintenanceRequests)
          .set({
            stage,
            status: statusForStage(stage),
            completedAt:
              stage === "Completed" ? new Date().toISOString() : null,
            updatedAt: new Date().toISOString(),
          })
          .where(and(eq(maintenanceRequests.id, requestId), eq(maintenanceRequests.organisationId, orgId)))
          .returning();
      }

      await db.insert(activityLog).values({
        id: crypto.randomUUID(),
        organisationId: orgId,
        entityType: "maintenance_request",
        entityId: requestId,
        action:
          existingItem.groupId === groupId
            ? "request.reordered"
            : "request.group_changed",
        actorEmail: actor.email,
        detail: JSON.stringify({
          groupId,
          groupName: group.name,
          beforeRequestId,
        }),
      });
      return Response.json({
        item,
        items: changedItems,
        request: updatedRequest,
      });
    }

    if (action === "update_option") {
      const optionId = trimString(payload.optionId, 100);
      const label = trimString(payload.label, 80);
      const requestedColor = trimString(payload.color, 12).toLowerCase();
      const active =
        typeof payload.active === "boolean" ? payload.active : undefined;
      if (!optionId) {
        return Response.json(
          { error: "A label is required." },
          { status: 400 },
        );
      }
      const values: Partial<typeof maintenanceBoardOptions.$inferInsert> = {
        updatedAt: new Date().toISOString(),
      };
      if (label) values.label = label;
      if (validOptionColor(requestedColor)) {
        values.color = requestedColor;
        values.textColor =
          requestedColor === "#d9ecfb" ? "#456579" : "#ffffff";
      }
      if (active !== undefined) values.active = active;
      const [option] = await db
        .update(maintenanceBoardOptions)
        .set(values)
        .where(and(eq(maintenanceBoardOptions.id, optionId), eq(maintenanceBoardOptions.organisationId, orgId)))
        .returning();
      if (!option) {
        return Response.json({ error: "Label not found." }, { status: 404 });
      }
      return Response.json({ option });
    }

    if (action === "delete_option") {
      const optionId = trimString(payload.optionId, 100);
      const [existing] = await db
        .select()
        .from(maintenanceBoardOptions)
        .where(and(eq(maintenanceBoardOptions.id, optionId), eq(maintenanceBoardOptions.organisationId, orgId)))
        .limit(1);
      if (!existing) {
        return Response.json({ error: "Label not found." }, { status: 404 });
      }
      if (existing.system) {
        return Response.json(
          { error: "Default labels can be deactivated but not deleted." },
          { status: 409 },
        );
      }
      await db
        .delete(maintenanceBoardOptions)
        .where(and(eq(maintenanceBoardOptions.id, optionId), eq(maintenanceBoardOptions.organisationId, orgId)));
      return Response.json({ deleted: true, optionId });
    }

    return Response.json({ error: "Unknown board action." }, { status: 400 });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      { error: "The board change could not be saved." },
      { status: 503 },
    );
  }
}
