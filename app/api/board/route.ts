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
import {
  isBoardNotFound,
  provisionDefaultStructure,
  resolveBoard,
  templateColumnCount,
} from "../../lib/board-registry";
import { seedStoreDocumentationBoard } from "../../../db/seed-store-documentation";
import {
  activityLog,
  attachments,
  maintenanceBoardCells,
  boards,
  maintenanceBoardColumns,
  maintenanceBoardOptions,
  maintenanceGroupItems,
  maintenanceGroups,
  maintenanceRequests,
  optionSets,
  optionValues,
} from "../../../db/schema";
import { invalidateOptionCache } from "../../lib/options-repository";
import { auditActor, changeDetail, recordAudit } from "../../lib/audit";
import { summariesFor } from "../../lib/column-types";
import { exposeRequest } from "../../lib/request-payload";
import {
  attachmentCountsByRequest,
  liveAttachmentRows,
  reconcileAttachmentCounts,
  withCountedAttachments,
} from "../../lib/attachment-counts";
import { PRIMARY_ORGANISATION_ID, anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../lib/tenant-db";
import { sampleSeedingAllowed } from "../../lib/tenant-access";
import { selectInChunks } from "../../lib/sql-batching";
import {
  RETENTION_DAYS,
  sendColumnToBin,
  sendGroupToBin,
  sendJobsToBin,
} from "../../lib/recycle-bin";
import { statusForStage } from "../../lib/stage-status";
import { listRetailSites } from "../../lib/sites-repository";
import {
  createBoardItem,
  duplicateBoardItems,
  findOrCreateArchivedGroup,
  moveItemsToGroup,
  setBoardCell,
} from "../../lib/board-mutations";
import {
  BOARD_COLUMN_TYPES,
  BOARD_DATE_ICON_IDS,
  dateDecorationValue as sharedDateDecorationValue,
  normalizeBoardCellValue,
} from "../../lib/board-cell-values";
import {
  automationContext,
  cellChangedEvent,
  dispatchAutomationEvents,
  itemCreatedEvent,
  itemMovedEvent,
  requestFieldEvents,
} from "../../lib/automations";

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

/*
 * The other half of the option mirror. /api/options (the registry the options
 * admin and the form builder write) mirrors every change onto
 * `maintenance_board_options`; the three board option actions below write the
 * chip store directly, so they mirror back onto `option_values` for the six
 * registry-backed columns — or a chip renamed on the board would drift from
 * the form that offers the same choice. One value, two stores, kept in step
 * from whichever side the edit came.
 */
const BOARD_COLUMN_TO_SET: Record<string, string> = {
  status: "maintenance_status",
  label: "maintenance_label",
  engineer: "engineer_required",
  priority: "priority",
  tier: "tier_level",
  /*
   * `storeLocation` is deliberately NOT here any more. It used to mirror onto
   * an option set of twenty-one hard-coded store spellings, which made that set
   * a second register of the estate — one the board could add a store to, in a
   * spelling no site answered to. Locations come from `sites` now, and the
   * register is the only place a store is created.
   */
};

async function mirrorRegistryOption(
  db: Awaited<ReturnType<typeof scopedDb>>["db"],
  orgId: string,
  columnKey: string,
  value: string,
  change:
    | {
        kind: "upsert";
        label: string;
        colourHex: string;
        textColour: string;
        active: boolean;
        position?: number;
      }
    | { kind: "remove" },
) {
  const setKey = BOARD_COLUMN_TO_SET[columnKey];
  if (!setKey) return;
  const [set] = await db
    .select({ id: optionSets.id })
    .from(optionSets)
    .where(and(eq(optionSets.organisationId, orgId), eq(optionSets.key, setKey)))
    .limit(1);
  if (!set) return;
  const [existing] = await db
    .select()
    .from(optionValues)
    .where(
      and(
        eq(optionValues.organisationId, orgId),
        eq(optionValues.optionSetId, set.id),
        eq(optionValues.value, value),
      ),
    )
    .limit(1);
  if (change.kind === "remove") {
    if (!existing) return;
    if (existing.system) {
      await db
        .update(optionValues)
        .set({ active: false, updatedAt: new Date().toISOString() })
        .where(eq(optionValues.id, existing.id));
    } else {
      await db.delete(optionValues).where(eq(optionValues.id, existing.id));
    }
  } else if (existing) {
    await db
      .update(optionValues)
      .set({
        label: change.label,
        colourHex: change.colourHex,
        textColour: change.textColour,
        active: change.active,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(optionValues.id, existing.id));
  } else {
    await db.insert(optionValues).values({
      id: `opt-${setKey}-${Date.now().toString(36)}`,
      organisationId: orgId,
      optionSetId: set.id,
      value,
      label: change.label,
      colourHex: change.colourHex,
      textColour: change.textColour,
      position: change.position ?? 999,
      isDone: false,
      isDefault: false,
      active: change.active,
      system: false,
    });
  }
  invalidateOptionCache(orgId, setKey);
}

/**
 * Which board this request is about — W02-06.
 *
 * THIS USED TO BE AN ALLOW-LIST OF TWO, AND FAILED SILENTLY.
 *
 * `BOARD_IDS.includes(raw) ? raw : DEFAULT_BOARD_ID` meant every key but
 * "maintenance" and "store-documentation" was answered with the JOB BOARD —
 * its columns, its groups and all of its rows — under whatever key the caller
 * asked for. A section with a register of its own therefore drew the job board,
 * and a row created "on" it was filed into a maintenance group. Nothing
 * errored; the response simply described a different board than the one that
 * was asked for, which is the substitution this codebase refuses elsewhere by
 * name ("a silent substitution is worse than a refusal").
 *
 * The question is now asked of the database, which is the only thing that knows
 * what boards this organisation has. `resolveBoard` throws `BoardNotFoundError`
 * for a key that is not one of them, and the callers turn that into a 404 —
 * the behaviour `isBoardNotFound` was added for and had no caller using.
 *
 * The two built-ins short-circuit: `maintenance` is materialised on demand by
 * `resolveBoard` itself, and both are asked for on nearly every request.
 */
async function boardIdFrom(
  request: Request,
  db: BoardDb,
  orgId: string,
): Promise<string> {
  const raw = (new URL(request.url).searchParams.get("board") ?? "").trim();
  if (!raw || BOARD_IDS.includes(raw as BoardId)) {
    return BOARD_IDS.includes(raw as BoardId) ? raw : DEFAULT_BOARD_ID;
  }
  const board = await resolveBoard(db, orgId, raw);
  return board.key;
}

/** A board this organisation has, but not one the product ships. */
function isGeneratedRegister(boardId: string) {
  return !BOARD_IDS.includes(boardId as BoardId);
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
]);
/** The board's own chip palette, used to colour the site-derived Location column. */
const SITE_CHIP_COLOURS = [
  "#579bfc", "#00c875", "#e2445c", "#a25ddc", "#ff642e",
  "#fdab3d", "#0086c0", "#bb3354", "#037f4c", "#ff158a",
];

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

// Shared with the automation engine — see app/lib/board-cell-values.ts.
const boardColumnTypes = BOARD_COLUMN_TYPES;

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

/**
 * The filter operators a column may store, as `matchesRule` in
 * views/view-model.ts implements them.
 *
 * DUPLICATED ON PURPOSE, and pinned by a test. view-model.ts is the browser's
 * filter engine and imports nothing, so it could be imported here — but that
 * would pull a module out of the client graph into an API route to read
 * thirteen strings, and the same trade was already made and documented for
 * `ROLE_RANK` in lib/permissions.ts. `boardFilterOperatorsMatchTheEngine` in
 * tests/batch-1a-board-controls.test.mjs fails if the two lists drift, so the
 * copy cannot rot.
 *
 * The server's job here is only to refuse an operator that does not exist. What
 * each one MEANS is decided in one place, by the engine.
 */
const BOARD_FILTER_OPERATORS = new Set([
  "any_of",
  "not_any_of",
  "is_empty",
  "is_not_empty",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "greater_than",
  "lower_than",
  "between",
  "within_the_last",
  "within_the_next",
]);

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

/**
 * The sort and filter a column carries, cleaned.
 *
 * These three fields are the board's ordered sort and its filter set, stored on
 * the columns they belong to — see `BoardColumnSettings` in lib/types.ts for
 * why they live there rather than on `board_views`. They are type-independent,
 * which is why they are lifted out of the three branches of `cleanSettings`
 * below; a status column and a date column store a sort priority identically.
 *
 * ANYTHING UNRECOGNISED DROPS OUT rather than being stored. A settings blob is
 * written from the browser, so a stray operator or a non-finite priority would
 * otherwise survive a round trip and be handed back to every reader of the
 * board as though the server had approved it.
 */
function cleanViewSettings(
  record: Record<string, unknown>,
): Pick<BoardColumnSettings, "sort" | "sortPriority" | "filter" | "filterJoin"> {
  const sort =
    record.sort === "asc" ? ("asc" as const) : record.sort === "desc" ? ("desc" as const) : undefined;
  // A priority without a sort orders nothing, so it is dropped with it.
  const rawPriority = Number(record.sortPriority);
  const sortPriority =
    sort && Number.isFinite(rawPriority)
      ? Math.min(Math.max(Math.trunc(rawPriority), 0), 50)
      : undefined;

  const rawFilter =
    record.filter && typeof record.filter === "object"
      ? (record.filter as Record<string, unknown>)
      : null;
  const operator = trimString(rawFilter?.operator, 24);
  const filter =
    rawFilter && BOARD_FILTER_OPERATORS.has(operator)
      ? {
          operator,
          // At most two operands — `between` is the only operator that takes a
          // second — each capped so a filter cannot become a payload.
          values: (Array.isArray(rawFilter.values) ? rawFilter.values : [])
            .slice(0, 2)
            .map((value) => trimString(value, 200)),
        }
      : undefined;

  const filterJoin =
    record.filterJoin === "or" ? ("or" as const) : record.filterJoin === "and" ? ("and" as const) : undefined;

  return {
    ...(sort ? { sort } : {}),
    ...(sortPriority !== undefined ? { sortPriority } : {}),
    ...(filter ? { filter } : {}),
    ...(filterJoin ? { filterJoin } : {}),
  };
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
  const view = cleanViewSettings(record);
  if (type === "status" || type === "dropdown") {
    const choices = cleanChoices(record.choices);
    return {
      choices: choices.length ? choices : defaultSettings(type).choices,
      wrap,
      ...view,
    };
  }
  if (type === "people") {
    const people = cleanChoices(record.people);
    return {
      people: people.length ? people : defaultSettings(type).people,
      wrap,
      ...view,
    };
  }
  return { wrap, ...view };
}

function parseSettings(value: string, type: BoardColumnType) {
  try {
    return cleanSettings(JSON.parse(value), type);
  } catch {
    return defaultSettings(type);
  }
}

type ColumnRow = typeof maintenanceBoardColumns.$inferSelect;

/**
 * The fields of a column an audit reader cares about.
 *
 * Width and sort are deliberately absent — see the note at the `update_column`
 * audit call for why a resize is not a structural change.
 */
function columnAuditShape(row: ColumnRow) {
  return {
    title: row.title,
    type: row.type,
    visible: row.visible !== false,
    pinned: row.pinned === true,
    summary: row.summary ?? null,
    position: row.position,
  };
}

/**
 * What to call this edit in one word, or null if it is not worth recording.
 *
 * Returns the FIRST structural difference rather than a list: the summary line
 * needs a verb, and the full before/after sits in the event's detail where a
 * reader can open it.
 */
function structuralColumnChange(before: ColumnRow, after: ColumnRow) {
  if (before.title !== after.title) return "Renamed";
  if (before.type !== after.type) return "Changed the type of";
  if ((before.visible !== false) !== (after.visible !== false)) {
    return after.visible === false ? "Hid" : "Showed";
  }
  if ((before.pinned === true) !== (after.pinned === true)) {
    return after.pinned === true ? "Pinned" : "Unpinned";
  }
  if ((before.summary ?? null) !== (after.summary ?? null)) return "Re-summarised";
  return null;
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
    // Carried so hiding a column survives a reload — see MaintenanceBoardColumn.
    visible: row.visible !== false,
    /*
     * `pinned` and `summary` have been columns on this table since Stage 1 and
     * writable through PATCH /api/board/columns for almost as long. Neither was
     * ever sent back, so the board could store a pin it had no way to draw and
     * the seed's own summary choices — "battery" on Status, "sum" on Cost of
     * Works — were written and then ignored by the strip that exists to honour
     * them. Returning them is the whole of what those two features needed.
     */
    pinned: row.pinned === true,
    summary: row.summary ?? null,
  };
}

/**
 * The icon and the time a SYSTEM date column carries beside the job's own date.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A HOLE IN THE GUARD BELOW.
 *
 * The board's date cells offer a colour-coded marker — "On time", "Late",
 * "Waiting" — and a time of day. `maintenance_requests` has nowhere to put a
 * marker, so it is stored as a cell, which is correct: it is decoration ON a
 * value rather than the value. The DATE always goes to the field, through
 * `PATCH /api/maintenance`, and every other screen reads it there.
 *
 * WHAT WAS BROKEN. The cell was written carrying `{ date, time, icon }`, so
 * once `update_cell` learned to refuse a system column — correctly, because a
 * cell holding a contractor name shadowed the field and the register kept
 * saying nobody was assigned — every date edit on the board fired a second
 * request that came back 400 and put an error in front of the operator. The
 * date itself had already saved. All four system date columns did it.
 *
 * So the decoration is stored WITHOUT a date. Nothing about it can shadow
 * anything, which is what lets the guard admit it: a cell that cannot carry a
 * date cannot disagree with the field about one. `parseBoardDateMetadata` in
 * board-format.ts already falls back to the field's date when the metadata has
 * none, which is what makes this shape readable without any change to the cell.
 *
 * Returns the value to store, "" to clear it, or null when the payload is not a
 * decoration at all — in which case the caller refuses exactly as before.
 */
/*
 * The storage rules themselves live in app/lib/board-cell-values.ts, so a
 * rule (the automation engine) stores a cell through the board's own
 * validation. The route keeps its three refusals HERE, ahead of the shared
 * helper — only a date column has a marker; a decoration carrying a date is
 * not a decoration; the marker must be a real one — because they are the
 * route's own contract with `update_cell`, pinned by batch-1a, and must not
 * quietly depend on where the helper moves next. The helper applies the same
 * three rules again; agreeing twice costs nothing and disagreeing is caught.
 */
const boardDateIconIds = BOARD_DATE_ICON_IDS;

function dateDecorationValue(type: BoardColumnType, raw: unknown): string | null {
  if (type !== "date") return null;
  const text = trimString(raw, 200);
  if (text && text.startsWith("{")) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (trimString(record.date, 10)) return null;
    const icon = trimString(record.icon, 40);
    if (icon && !boardDateIconIds.has(icon)) {
      throw new Error("Choose a valid date icon.");
    }
  }
  return sharedDateDecorationValue(type, raw);
}

function normalizeCellValue(type: BoardColumnType, raw: unknown): string {
  return normalizeBoardCellValue(type, raw);
}

/**
 * Every file filed under a column, destroyed with it.
 *
 * DELIBERATELY NOT FILTERED BY `liveAttachmentRows()`, unlike the two scans that
 * build the board's file cells. Those answer "what does this cell show", where a
 * superseded version is not a second document. This answers "what must be
 * destroyed when the column itself is destroyed", and the answer is everything:
 * filtering here would leave superseded versions and archived documents in the
 * table pointing at a column that no longer exists, and their R2 objects would
 * never be deleted by anything — an invisible row and a permanent storage leak,
 * both unreachable through any screen.
 */
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
  /*
   * A SET, not a count per request. The counters below are recomputed from the
   * rows that survive, so how many were removed is no longer information this
   * needs — only which jobs to recount.
   */
  const removedByRequest = new Set<string>();
  for (const file of fileRows) {
    if (!file.requestId) continue;
    removedByRequest.add(file.requestId);
  }
  /*
   * RECOUNTED, NOT DECREMENTED — and this one was wrong in a second way.
   *
   * It took `generalAttachmentCount` down by the number of rows removed
   * REGARDLESS OF THEIR KIND, on the assumption that a file filed under a board
   * column is always `general`. It is not: the monday import filed fault and
   * completion photographs under `issuePictures` and `completedPictures` with
   * their kinds intact, and `scripts/repair-attachment-kinds.mjs` restored the
   * kind on 2,915 more. Deleting such a column drove the general counter
   * negative-then-clamped and left the issue and completion counters claiming
   * photographs that had just been destroyed.
   *
   * Counting what is left needs to know none of that.
   */
  for (const requestId of removedByRequest) {
    await reconcileAttachmentCounts(db, orgId, requestId);
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

// `statusForStage` moved to app/lib/stage-status.ts so the automation engine
// and this route read one map. See the note there.

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

/*
 * What `ensureBoardState` already read, handed to `boardPayload` so it need not
 * ask twice.
 *
 * Seeding reads the board's columns and its groups to decide what is missing;
 * the payload then read both again, in queries word-for-word identical to the
 * ones seeding had just run — two extra round trips (~45ms against Supabase) for
 * rows already in memory. This carries them across.
 *
 * `null` means "do not reuse these": either seeding wrote something that makes
 * its own copy stale, or it took the Store Documentation path and never read
 * them. The payload then falls back to querying, which is what it always did.
 */
type BoardStateCache = {
  groups: Array<typeof maintenanceGroups.$inferSelect>;
  columns: Array<typeof maintenanceBoardColumns.$inferSelect>;
} | null;

/**
 * A TEMPLATE INSTANCE, KEPT IN STEP WITH THE TEMPLATE IT WAS BUILT FROM.
 *
 * The owner's requirement for W02-06 is parity with the original, not a
 * snapshot of it: "the SAME Jobs board engine and canonical DEFAULT structure".
 * A snapshot satisfies that on the day the section is created and quietly stops
 * satisfying it the first time a column is added to the product - the canonical
 * board picks the new column up from `seedBoardStructure` on its next boot, and
 * an instance seeded once would not.
 *
 * So an instance is re-provisioned when it is SHORT, through the same
 * `provisionDefaultStructure` that created it. Every statement in there is an
 * `INSERT OR IGNORE` / `onConflictDoNothing`, so a board that is already
 * complete is untouched, and a board missing the spec's newest column gains it
 * and nothing else.
 *
 * COUNT-GUARDED, and that is the whole cost on a normal load: one indexed
 * count, not 27 no-op inserts. The same self-healing shape the option seeding
 * below already uses, and for the same reason - a memo cannot see a row
 * somebody else deleted.
 *
 * `boards.template` is what decides, and NULL decides nothing. A register
 * created for a section before templates existed carries the generic six
 * columns and must keep them; converting one into a job board because its
 * `kind` happens to read "maintenance" is exactly the silent conversion the
 * owner ruled out.
 */
async function ensureTemplateStructure(db: BoardDb, orgId: string, boardId: string) {
  const [board] = await db
    .select({ template: boards.template })
    .from(boards)
    .where(and(eq(boards.organisationId, orgId), eq(boards.key, boardId)));
  const template = board?.template ?? null;
  if (!template) return;

  const expected = templateColumnCount(template);
  if (expected === 0) return;

  const [counted] = await db
    .select({ total: sql<number>`count(*)` })
    .from(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.organisationId, orgId),
        eq(maintenanceBoardColumns.boardId, boardId),
      ),
    );
  if (Number(counted?.total ?? 0) >= expected) return;

  await provisionDefaultStructure(db, orgId, boardId, template);
}

async function ensureBoardState(
  db: BoardDb,
  orgId: string,
  /* Any board this organisation has — see `boardIdFrom`, which no longer
     narrows to the two the product ships. */
  boardId: string,
): Promise<BoardStateCache> {
  await ensureDatabase();

  // The Store Documentation board carries its own columns, groups and options
  // and has no maintenance requests to seed, so it takes a separate path rather
  // than making the block below conditional in six places.
  if (boardId === "store-documentation") {
    // The seeder speaks raw D1, matching `seedBoardStructure` in db/init.ts,
    // while this route holds a Drizzle handle. Reaching for D1 directly here is
    // cheaper than reshaping a seeder that init.ts also calls.
    await seedStoreDocumentationBoard(await getD1(), orgId);
    return null;
  }

  /*
   * A register generated for a workspace section brings its own structure and
   * must be left alone — W02-06.
   *
   * Everything below this line is the MAINTENANCE board's: 26 domain columns
   * from `monday-board-spec`, its option sets, and `seedRequestsIfEmpty`, which
   * invents sample jobs into an empty board. Running any of it against a
   * section's register would furnish "CCTV" with Tier Level and Engineer
   * Required and then fill it with maintenance samples — a data model nobody
   * asked for, on a board that already has the one it was created with.
   *
   * It would also not even work: the column seeder's ids come from
   * `tenantSeedId("column-system-<key>", orgId)`, which does not name the
   * board, so on a second board every insert collides with the first board's
   * row and is discarded. The result would be an empty board and no error.
   * `createBoard` provisions a generated register once, keyed on the board.
   */
  if (isGeneratedRegister(boardId)) {
    await ensureTemplateStructure(db, orgId, boardId);
    return null;
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
        isNull(maintenanceBoardColumns.deletedAt),
      ),
    )
    .orderBy(asc(maintenanceBoardColumns.position));
  let columnsRewritten = false;
  if (!existingColumns.some((column) => column.system)) {
    const customColumns = existingColumns.filter((column) => !column.system);
    columnsRewritten = customColumns.length > 0;
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
  /*
   * ASK BY KEY, NOT BY THE `system` FLAG.
   *
   * The guard here counted `existingColumns.filter(c => c.system)` and reseeded
   * whenever that was short of `systemBoardColumns.length`. On the live board it
   * is permanently short: `seedBoardStructure` in db/init.ts had already written
   * all 26 columns under ids of the form `seed-<org>-maintenance-<key>`, and it
   * flags only four of them `system` (name, status, subitems, move). So the
   * count read 4 < 26 on every single load and ran the loop — 26 INSERTs whose
   * every row conflicted on `maintenance_board_columns_key_idx` and was
   * discarded. Measured against Supabase: 26 of the 51 statements a warm
   * `GET /api/board` issued, and ~630ms of its ~1.9s of SQL, achieving nothing.
   *
   * `key` is the right question because `key` is what the unique index is on —
   * (organisation_id, board_id, key). A column present under that index is a
   * column this seeder cannot insert, whatever its `system` flag says. The loop
   * is still self-healing: delete a column and its key goes missing, so the next
   * load puts it back. It just no longer asks 26 times a load for columns that
   * are already there.
   */
  const existingColumnKeys = new Set(existingColumns.map((column) => column.key));
  const missingSystemColumns = systemBoardColumns.filter(
    (column) => !existingColumnKeys.has(column.key),
  );
  if (missingSystemColumns.length) {
    for (const [position, column] of systemBoardColumns.entries()) {
      if (existingColumnKeys.has(column.key)) continue;
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

  // Only when seeding left both untouched. A rewritten position or a freshly
  // inserted column makes the copy above stale, and a stale column list is a
  // board drawn with the wrong headers.
  return columnsRewritten || missingSystemColumns.length
    ? null
    : { groups, columns: existingColumns };
}

async function boardPayload(
  db: BoardDb,
  orgId: string,
  boardId: string,
  // Named `include` rather than `options`, which in this function already means
  // the board's status and dropdown choices.
  include: { requests: boolean } = { requests: true },
) {
  const seeded = await ensureBoardState(db, orgId, boardId);
  const groups =
    seeded?.groups ??
    (await db
      .select()
      .from(maintenanceGroups)
      .where(and(eq(maintenanceGroups.boardId, boardId), eq(maintenanceGroups.organisationId, orgId),
            isNull(maintenanceGroups.deletedAt),))
      .orderBy(asc(maintenanceGroups.position)));
  const items = await db
    .select()
    .from(maintenanceGroupItems)
    .where(and(eq(maintenanceGroupItems.boardId, boardId), eq(maintenanceGroupItems.organisationId, orgId)))
    .orderBy(asc(maintenanceGroupItems.groupId), asc(maintenanceGroupItems.position));
  const storedOptions = await db
    .select()
    .from(maintenanceBoardOptions)
    .where(and(eq(maintenanceBoardOptions.boardId, boardId), eq(maintenanceBoardOptions.organisationId, orgId)))
    .orderBy(
      asc(maintenanceBoardOptions.columnKey),
      asc(maintenanceBoardOptions.position),
    );
  /*
   * The Location column is drawn from the site register, not from the chip
   * store.
   *
   * Those chips were twenty-one captured monday spellings, and they behaved as
   * a second estate: a store could be added to the board in a spelling no site
   * answered to, and after canonicalisation the two lists would simply have
   * disagreed. The register is the estate now, so the column offers what a
   * person can actually be standing in — open, and retail. Closed stores, the
   * office, the warehouses and anything unverified stay canonical Sites and
   * stay out of the picker.
   *
   * The stored chips for this column are ignored rather than deleted: they are
   * still the historical record of what the board once offered.
   */
  const retailSites = await listRetailSites(db, orgId);
  const options = [
    ...storedOptions.filter((option) => option.columnKey !== "storeLocation"),
    ...retailSites.map((site, index) => ({
      id: `site-option-${site.id}`,
      organisationId: orgId,
      legacyClientId: "sunnamusk-uk",
      boardId,
      columnKey: "storeLocation" as const,
      value: site.name,
      label: site.name,
      /*
       * Picked by position from the board's own palette rather than stored on
       * the site: a colour is how the board draws a chip, not a fact about a
       * shop, and deriving it keeps the register free of presentation.
       */
      colour: SITE_CHIP_COLOURS[index % SITE_CHIP_COLOURS.length],
      textColour: "#ffffff",
      position: index,
      createdAt: site.createdAt,
      updatedAt: site.updatedAt,
    })),
  ];
  const columnRows =
    seeded?.columns ??
    (await db
      .select()
      .from(maintenanceBoardColumns)
      .where(
        and(
          eq(maintenanceBoardColumns.boardId, boardId),
          eq(maintenanceBoardColumns.organisationId, orgId),
          isNull(maintenanceBoardColumns.deletedAt),
        ),
      )
      .orderBy(asc(maintenanceBoardColumns.position)));
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
        /*
         * W7 BUG 3 — THE CELL MUST NOT KEEP CALLING IT BY ITS UPLOAD NAME.
         *
         * Rename a document in Documents and the register redraws under the new
         * title, while the board cell it is linked to still read `IMG_7560.jpeg`
         * — because this projection sent `original_name` and nothing else, so the
         * chip had no other name available to draw. One document, two names, on
         * two screens the same person moves between.
         *
         * The TITLE is carried, not a resolved display string, and the two are
         * not the same choice. `documentName` in views/document-register.ts is
         * the ONE rule that decides what a document is called (`title` when set,
         * the filename otherwise); resolving it here would put a second copy of
         * that rule on the server, free to drift. Sending both facts lets the
         * client apply the single rule it already owns — and keeps
         * `original_name` present, which the chip still needs: its type glyph
         * falls back to the extension when R2 stored `application/octet-stream`,
         * and a prose title has no extension to fall back to.
         */
        title: attachments.title,
        byteSize: attachments.byteSize,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .where(
        and(
          isNotNull(attachments.boardColumnId),
          eq(attachments.organisationId, orgId),
          inArray(attachments.boardColumnId, chunk),
          /*
           * THE CELL COUNTS WHAT THE COUNTER COUNTS — and for a while it did not.
           *
           * Workstream 7 gave documents version lineage and an archive flag, and
           * filtered them in `/api/files` and in `reconcileAttachmentCounts`. This
           * scan is a THIRD reader of the same table and was left out, so a
           * certificate replaced twice drew three thumbnails in its cell while
           * the counter beside it said one, and an archived certificate stayed
           * visible and openable on the board after it had left every other
           * screen. Measured on MN-1050: the cell went 1, 2, 3 across three
           * versions.
           *
           * That is precisely the contradiction the note below this query exists
           * to record having fixed once already — "the number on the cell is the
           * number behind it" — reintroduced through a different door. The
           * predicate is imported rather than restated so a fourth reader cannot
           * disagree with the other three.
           */
          liveAttachmentRows(),
        ),
      )
      /*
       * `id` IS THE TIEBREAK, AND IT IS NOT DECORATION.
       *
       * `created_at` is stored to the second, and the monday import wrote whole
       * cells inside one second — `2026-08-08T09:18:17.000Z` covers four files
       * on the same row. `ORDER BY created_at` alone therefore leaves Postgres
       * free to return those four in any order it likes, and it does: measured
       * across two runs of the same build in different processes, 332 of the
       * 1,007 file cells came back with a different preview, and 107 of them
       * with a different SET of files — the four thumbnails a cell draws were
       * an arbitrary four of the six or eight it holds, re-drawn differently on
       * every load.
       *
       * Ordering by (created_at, id) does not change what any cell contains or
       * how many files it reports. It fixes which four the preview shows, so a
       * board drawn twice draws the same thumbnails, and so a payload can be
       * compared before and after a change at all.
       */
      .orderBy(asc(attachments.createdAt), asc(attachments.id)),
  );

  /*
   * The preview row as this route sends it: the shared shape plus the document
   * title, which is `null` for the great majority that were never named.
   *
   * Declared here rather than widened in app/lib/types.ts because the client
   * half of this fix (the chip in portal/cells/file-cell.tsx and the compact
   * decoder in portal/board-model.ts) is a separate change; the shared
   * interface is widened there, alongside the code that reads the field.
   */
  type BoardFilePreview = MaintenanceBoardFilePreview & { title: string | null };

  const grouped = new Map<
    string,
    {
      requestId: string;
      columnId: string;
      count: number;
      preview: BoardFilePreview[];
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
        title: row.title,
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
        // The same reason as the column-filed scan above: a renamed photograph
        // must not keep announcing itself by the name the phone gave it.
        title: attachments.title,
        byteSize: attachments.byteSize,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .where(
        and(
          eq(attachments.organisationId, orgId),
          isNull(attachments.boardColumnId),
          inArray(attachments.kind, [...kindColumns.keys()]),
          // The same rule as the column-filed scan above: a superseded version is
          // not a second photograph, and an archived one is not on the board.
          liveAttachmentRows(),
        ),
      )
      /*
       * The id tiebreak matters here for exactly the reason documented above
       * for the column-filed scan: phone uploads land several rows inside one
       * second, and without it two loads of the same board could disagree
       * about which photograph is "first".
       */
      .orderBy(asc(attachments.createdAt), asc(attachments.id));
    /*
     * A MERGE, NOT AN APPEND. A cell can hold both column-filed rows (the
     * monday import) and kind-filed rows (the app's own uploads), and this
     * loop used to push the kind rows AFTER the column rows regardless of
     * date — so a mixed cell's preview was two sorted runs glued together,
     * not a chronological strip, and the hover overflow list (which sorts
     * globally) would disagree with the tiles about which files are hidden.
     * Each source contributes its own oldest four, so the union's true oldest
     * four are guaranteed to be among the at-most-eight collected — sorting
     * the merged handful and re-capping yields the correct global order.
     */
    const mixed = new Set<string>();
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
      if (entry.preview.length < 8) {
        entry.preview.push({
          id: row.id,
          contentType: row.contentType,
          originalName: row.originalName,
          title: row.title,
          byteSize: row.byteSize,
          createdAt: row.createdAt,
        });
        mixed.add(key);
      }
    }
    for (const key of mixed) {
      const entry = grouped.get(key);
      if (!entry) continue;
      entry.preview.sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.id < right.id
            ? -1
            : 1
          : left.createdAt < right.createdAt
            ? -1
            : 1,
      );
      entry.preview.length = Math.min(entry.preview.length, 4);
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
  /*
   * NOT ASKED FOR AT ALL WHEN THE CALLER ALREADY HAS THE ROWS.
   *
   * `live-board.tsx` — the grid on the Jobs tab — never reads `requests` from
   * this payload. It is handed its rows as a prop: the portal loads them from
   * `/api/maintenance`, and Store Documentation loads them itself and passes
   * them down. The only reader of this key is
   * `views/store-documentation-board.tsx`, which fetches this route directly for
   * its Compliance Tracker and Calendar tabs.
   *
   * So on the maintenance board it was 745 rows, 756 KB of JSON and nine chunked
   * SELECTs (~240ms against Supabase) that were parsed and thrown away. The grid
   * asks with `?compact=1`, which says "I have the rows"; every other caller is
   * untouched and still gets them.
   */
  const requestRows = include.requests
    ? await selectInChunks(placedIds, (chunk) =>
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
      )
    : [];

  /*
   * THE FOUR COUNTERS ON A REQUEST ROW ARE RECOUNTED BEFORE THEY ARE SENT.
   *
   * `issue_attachment_count` and its siblings are denormalised and drift. On
   * the preview workspace, job MN-1055 reported three issue photographs, one
   * completion and one general — five — against three rows in `attachments`,
   * only one of which was an issue photograph. The public job page, which
   * counts rows, showed the truth; the board's number was the lie.
   *
   * The counters are not repaired here, they are OVERRULED here: `db/init.ts`
   * still carries a boot-time back-fill that sets the issue counter to the
   * undifferentiated total whenever a job has attachments and no issue-kind
   * row, so a row corrected in the database goes wrong again on the next cold
   * start. Counting at the point of reading is the only place the answer
   * cannot be re-broken behind us. See `app/lib/attachment-counts.ts`.
   *
   * Only asked for when the payload actually carries request rows —
   * `?compact=1` says "I have the rows" and this would be one aggregate query
   * spent on nothing.
   */
  const countedAttachments = include.requests
    ? await attachmentCountsByRequest(db, orgId, placedIds, {
        /*
         * The SAME two columns `kindColumns` above is built from, so the number
         * on the request row and the number on the cell are the same number
         * arrived at the same way. Reused rather than re-queried: this function
         * already holds every column of this board.
         */
        issue: kindColumns.get("issue") ?? null,
        completion: kindColumns.get("completion") ?? null,
      })
    : new Map();

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
    requests: requestRows.map((row) =>
      exposeRequest(withCountedAttachments(row, countedAttachments, row.id)),
    ),
  };
}

type BoardPayload = Awaited<ReturnType<typeof boardPayload>>;

/**
 * The same board, with the repeated identifiers sent once.
 *
 * WHY THIS EXISTS. The board's three big lists — `cells`, `fileCounts`,
 * `items` — are mostly not data. Measured on the live maintenance board:
 * `cells` was 8,565 rows at 187 bytes each, of which 55 bytes were the column
 * id (`seed-org_000000000000000000000001-maintenance-issuePictures`, 57
 * characters, one of only 26 distinct values), 38 were the request id, and 36
 * were the property names `requestId`/`columnId`/`value` repeated 8,565 times.
 * The median cell VALUE is ten characters. So 1,568 KB of `cells` carried about
 * 90 KB of board content, and `items` repeated `organisationId`,
 * `legacyClientId` and `boardId` — three constants — on all 745 rows.
 *
 * WHAT IT DOES. Every repeated identifier becomes an index into a table sent
 * once, and every row becomes a positional array instead of an object. Nothing
 * is dropped or rounded: `decodeCompactBoard` in live-board.tsx rebuilds the
 * exact objects the legacy shape sent, which is why the two can be compared row
 * for row.
 *
 * WHY IT IS OPT-IN. `views/store-documentation-model.ts` reads this route's
 * legacy shape directly, and it is not part of this change. A caller that does
 * not ask for `?compact=1` gets byte-identical JSON to before.
 *
 * The index tables are built from what the payload actually references rather
 * than from `columns` and `groups` alone: a cell whose column has been deleted,
 * or a placement in a group that has been binned, still has to survive the round
 * trip. Both exist on the live board today.
 */
function compactBoard(payload: BoardPayload) {
  const table = () => {
    const ids: string[] = [];
    const index = new Map<string, number>();
    return {
      ids,
      ref(id: string) {
        let at = index.get(id);
        if (at === undefined) {
          at = ids.length;
          ids.push(id);
          index.set(id, at);
        }
        return at;
      },
    };
  };

  const columnTable = table();
  // Seeded in `columns` order so a column index is also its position in the
  // grid, which makes the encoding readable when someone dumps the JSON.
  for (const column of payload.columns) columnTable.ref(column.id);
  const rowTable = table();
  const groupTable = table();
  for (const group of payload.groups) groupTable.ref(group.id);
  const mimeTable = table();

  return {
    /*
     * The version marker. A client that finds no `compact` key is looking at
     * the legacy shape and must not try to decode it — which is what happens if
     * a cached older response is replayed against newer client code.
     */
    compact: 1 as const,
    groups: payload.groups,
    options: payload.options,
    columns: payload.columns,
    notRequired: payload.notRequired,
    /*
     * The index tables. These are the SAME array objects the `ref` calls below
     * push onto, so they are complete by the time this object is serialised
     * even though they appear before the lists that fill them.
     */
    columnIds: columnTable.ids,
    groupIds: groupTable.ids,
    mimeTypes: mimeTable.ids,
    rowIds: rowTable.ids,
    items: payload.items.map(
      (item) =>
        [rowTable.ref(item.requestId), groupTable.ref(item.groupId), item.position] as const,
    ),
    cells: payload.cells.map(
      (cell) =>
        [rowTable.ref(cell.requestId), columnTable.ref(cell.columnId), cell.value] as const,
    ),
    fileCounts: payload.fileCounts.map(
      (entry) =>
        [
          rowTable.ref(entry.requestId),
          columnTable.ref(entry.columnId),
          entry.count,
          /*
           * SLOT 6 IS THE TITLE, AND IT IS PRESENT ONLY WHEN THERE IS ONE.
           *
           * This encoding is positional and versioned (`compact: 1`), so a new
           * field is a wire change and has to degrade in BOTH directions. It
           * does: an older decoder destructures five names and ignores a sixth
           * element, and a newer decoder reading a cached older payload gets
           * `undefined` — which `documentName` already treats as "no title",
           * falling back to the filename exactly as it does for the great
           * majority of rows. No marker bump is needed for either.
           *
           * Emitted only when set rather than as a trailing `null`, because
           * almost no attachment on the maintenance board has a title and this
           * list is the widest thing the payload sends — the whole reason the
           * compact encoding exists is that four bytes times every preview row
           * is not free.
           */
          entry.preview.map((file) =>
            file.title
              ? ([
                  file.id,
                  mimeTable.ref(file.contentType),
                  file.originalName,
                  file.byteSize,
                  file.createdAt,
                  file.title,
                ] as const)
              : ([
                  file.id,
                  mimeTable.ref(file.contentType),
                  file.originalName,
                  file.byteSize,
                  file.createdAt,
                ] as const),
          ),
        ] as const,
    ),
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
    /*
     * `?compact=1` means "I am the grid": send the interned encoding and skip
     * the rows, which this caller already holds. Everything else — including
     * anything hitting the URL by hand — gets exactly what it got before.
     */
    const compact = new URL(request.url).searchParams.get("compact") === "1";
    const payload = await boardPayload(db, orgId, await boardIdFrom(request, db, orgId), {
      requests: !compact,
    });
    return Response.json(compact ? compactBoard(payload) : payload);
  } catch (error) {
    /* A board this organisation does not have is a bad REQUEST, not an outage.
       Without this the generic handler below answers 503 "temporarily
       unavailable", telling the browser to retry a request no retry can fix —
       which is the case `isBoardNotFound` was written for. */
    if (isBoardNotFound(error)) {
      return Response.json({ error: error.message }, { status: 404 });
    }
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
    /*
     * A body that is not a JSON object is a bad request, not an outage. The
     * unguarded read let broken JSON throw — and a body of literal `null`
     * parse — straight through every action into the 503 at the bottom.
     */
    const payload = (await request.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!payload || typeof payload !== "object") {
      return Response.json(
        { error: "The request body must be a JSON object." },
        { status: 400 },
      );
    }
    const action = trimString(payload.action, 40);
    const boardId = await boardIdFrom(request, db, orgId);
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
      await recordAudit({
        db,
        organisationId: orgId,
        actor: auditActor({ actor, identityEmail, session }),
        action: "board.group_created",
        entityType: "maintenance_group",
        entityId: group.id,
        summary: `Created the "${group.name}" group on ${boardId}.`,
        detail: { board: boardId, color: group.color, position: group.position },
        request,
      });
      return Response.json({ group }, { status: 201 });
    }

    if (action === "create_item") {
      const groupId = trimString(payload.groupId, 80);
      // The write itself lives in `board-mutations.ts`, shared with the
      // automation engine so a rule's "create item" is this exact operation.
      const created = await createBoardItem(db, orgId, boardId, actor, groupId);
      if (!created) {
        return Response.json({ error: "Group not found." }, { status: 404 });
      }
      await dispatchAutomationEvents(automationContext(guard.scope, request), [
        itemCreatedEvent(boardId, created.request.id, null, created.group.id),
      ]);
      return Response.json({ request: created.request, item: created.item }, { status: 201 });
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
            isNull(maintenanceBoardColumns.deletedAt),
          ),
        );
      if (Number(columnCount.value) >= 40) {
        return Response.json(
          { error: "This board has reached the 40 custom-column limit." },
          { status: 409 },
        );
      }
      /*
       * DELIBERATELY UNFILTERED — binned columns count here, as they do in the
       * key scan in /api/board/columns. A column in the bin keeps its title, and
       * a board that ends up with two "Colour" columns the moment one is
       * restored is a board nobody can read. The new one takes "Colour 2".
       */
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
        .where(
          and(
            eq(maintenanceBoardColumns.boardId, boardId),
            eq(maintenanceBoardColumns.organisationId, orgId),
            isNull(maintenanceBoardColumns.deletedAt),
          ),
        )
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
      await recordAudit({
        db,
        organisationId: orgId,
        actor: auditActor({ actor, identityEmail, session }),
        action: "board.column_created",
        entityType: "maintenance_board_column",
        entityId: created.id,
        summary: `Added the "${created.title}" ${type} column to ${boardId}.`,
        detail: { board: boardId, ...columnAuditShape(created) },
        request,
      });
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
            isNull(maintenanceBoardColumns.deletedAt),
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
            isNull(maintenanceBoardColumns.deletedAt),
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
        .where(
          and(
            eq(maintenanceBoardColumns.boardId, boardId),
            eq(maintenanceBoardColumns.organisationId, orgId),
            isNull(maintenanceBoardColumns.deletedAt),
          ),
        )
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
      if (created) {
        await mirrorRegistryOption(db, orgId, columnKey, created.value, {
          kind: "upsert",
          label: created.label,
          colourHex: created.color,
          textColour: created.textColor,
          active: true,
          position,
        });
      }
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
      // Stage 23 — a job in the recycle bin cannot be duplicated; the helper
      // reads live rows only. See `duplicateBoardItems`.
      const outcome = await duplicateBoardItems(db, orgId, boardId, actor, requestIds);
      /*
       * Nothing copied means every id was foreign, invented, or in the bin.
       * This used to answer 201 with three empty arrays — a silent no-op that
       * read as success, and the one place where the Stage 23 "cannot be
       * duplicated" promise was only a comment. Refuse like delete_items does.
       */
      if (!outcome.requests.length) {
        return Response.json(
          { error: "Those items are not on this board, or are in the recycle bin." },
          { status: 404 },
        );
      }
      await dispatchAutomationEvents(
        automationContext(guard.scope, request),
        outcome.requests.map((created, index) =>
          itemCreatedEvent(boardId, created.id, created.parentId ?? null, outcome.items[index]?.groupId),
        ),
      );
      return Response.json(
        { requests: outcome.requests, items: outcome.items, cells: outcome.cells },
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

      const group =
        action === "move_items"
          ? (
              await db
                .select()
                .from(maintenanceGroups)
                .where(and(eq(maintenanceGroups.id, trimString(payload.groupId, 80)), eq(maintenanceGroups.organisationId, orgId)))
                .limit(1)
            )[0]
          : await findOrCreateArchivedGroup(db, orgId, boardId);
      if (!group) {
        return Response.json({ error: "Group not found." }, { status: 404 });
      }

      const outcome = await moveItemsToGroup(
        db,
        orgId,
        boardId,
        actor,
        group,
        requestIds,
        action === "archive_items",
      );
      /*
       * Nothing moved means no id named a row this organisation has on the
       * board — foreign, invented, or binned (a binned job has no placement).
       * Answering 200 with empty arrays here read as success for a request
       * that did nothing; refuse the way delete_items refuses.
       */
      if (!outcome.items.length) {
        return Response.json(
          { error: "Those items are not on this board, or are in the recycle bin." },
          { status: 404 },
        );
      }
      /*
       * Told after the fact, never before: the move has been written, and a
       * rule that fails cannot undo it. A group with a stage also changed the
       * Status chip, and that is its own event.
       */
      const events = outcome.movedFrom.map((moved) =>
        itemMovedEvent(boardId, moved.requestId, null, group.id, group.name),
      );
      for (const change of outcome.statusChanges) {
        events.push({
          type: "column_changed",
          boardId,
          requestId: change.requestId,
          column: "status",
          columnType: "status",
          from: change.from,
          to: change.to,
          summary: `status: ${change.from} → ${change.to}`,
        });
      }
      await dispatchAutomationEvents(automationContext(guard.scope, request), events);
      return Response.json({
        group,
        items: outcome.items,
        requests: outcome.requests,
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
    /* A board this organisation does not have is a bad REQUEST, not an outage.
       Without this the generic handler below answers 503 "temporarily
       unavailable", telling the browser to retry a request no retry can fix —
       which is the case `isBoardNotFound` was written for. */
    if (isBoardNotFound(error)) {
      return Response.json({ error: error.message }, { status: 404 });
    }
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
    // `session` joins the other two for the audit trail: an event whose email
    // has no user id behind it was performed under the testing role switcher,
    // and a reader has to be able to tell those apart. See `auditActor`.
    const { actor, db, orgId, identityEmail, session } = guard.scope;
    // Same guard as POST: broken JSON and a literal-`null` body are 400s,
    // not the 503 the bottom catch would turn the resulting throw into.
    const payload = (await request.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!payload || typeof payload !== "object") {
      return Response.json(
        { error: "The request body must be a JSON object." },
        { status: 400 },
      );
    }
    const action = trimString(payload.action, 40);
    const boardId = await boardIdFrom(request, db, orgId);
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
      const [before] = await db
        .select({ name: maintenanceGroups.name })
        .from(maintenanceGroups)
        .where(and(eq(maintenanceGroups.id, groupId), eq(maintenanceGroups.organisationId, orgId)))
        .limit(1);
      const [group] = await db
        .update(maintenanceGroups)
        .set({ name, updatedAt: new Date().toISOString() })
        .where(and(eq(maintenanceGroups.id, groupId), eq(maintenanceGroups.organisationId, orgId)))
        .returning();
      if (!group) {
        return Response.json({ error: "Group not found." }, { status: 404 });
      }
      if (before && before.name !== group.name) {
        await recordAudit({
          db,
          organisationId: orgId,
          actor: auditActor({ actor, identityEmail, session }),
          action: "board.group_renamed",
          entityType: "maintenance_group",
          entityId: group.id,
          summary: `Renamed the "${before.name}" group to "${group.name}" on ${boardId}.`,
          detail: { board: boardId, ...changeDetail({ name: before.name }, { name: group.name }) },
          request,
        });
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
      const [beforeColour] = await db
        .select({ color: maintenanceGroups.color })
        .from(maintenanceGroups)
        .where(
          and(
            eq(maintenanceGroups.boardId, boardId),
            eq(maintenanceGroups.id, groupId),
            eq(maintenanceGroups.organisationId, orgId),
          ),
        )
        .limit(1);
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
      if (beforeColour && beforeColour.color !== group.color) {
        await recordAudit({
          db,
          organisationId: orgId,
          actor: auditActor({ actor, identityEmail, session }),
          action: "board.group_updated",
          entityType: "maintenance_group",
          entityId: group.id,
          summary: `Recoloured the "${group.name}" group on ${boardId}.`,
          detail: {
            board: boardId,
            ...changeDetail({ color: beforeColour.color }, { color: group.color }),
          },
          request,
        });
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
      await recordAudit({
        db,
        organisationId: orgId,
        actor: auditActor({ actor, identityEmail, session }),
        action: "board.group_reordered",
        entityType: "maintenance_group",
        entityId: selected.id,
        summary: `Moved the "${selected.name}" group ${direction} on ${boardId}.`,
        detail: {
          board: boardId,
          direction,
          order: reordered.map((entry) => ({ id: entry.id, name: entry.name })),
        },
        request,
      });
      return Response.json({ groups: reordered });
    }

    if (action === "sort_group") {
      const groupId = trimString(payload.groupId, 80);
      const requestIds = requestIdsFrom(payload);
      /*
       * The group must be this organisation's before anything else is said
       * about it. Without this, a foreign group id with an empty sort order
       * fell into the empty-group early return below and was answered 200 —
       * a no-op, but one that read as success against somebody else's id.
       */
      const [sortTarget] = await db
        .select({ id: maintenanceGroups.id })
        .from(maintenanceGroups)
        .where(
          and(
            eq(maintenanceGroups.id, groupId),
            eq(maintenanceGroups.organisationId, orgId),
          ),
        )
        .limit(1);
      if (!sortTarget) {
        return Response.json({ error: "Group not found." }, { status: 404 });
      }
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
      await recordAudit({
        db,
        organisationId: orgId,
        actor: auditActor({ actor, identityEmail, session }),
        action: "board.group_deleted",
        entityType: "maintenance_group",
        entityId: group.id,
        summary: `Moved the "${group.name}" group on ${boardId} to the recycle bin; its items went to "${target.name}".`,
        detail: {
          board: boardId,
          movedTo: { id: target.id, name: target.name },
          movedItems: movedItems.length,
          recoverable: true,
          retentionDays: RETENTION_DAYS,
        },
        request,
      });
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
            isNull(maintenanceBoardColumns.deletedAt),
          ),
        )
        .limit(1);
      const [workOrder] = await db
        .select({ id: maintenanceRequests.id, parentId: maintenanceRequests.parentId })
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
      /*
       * A SYSTEM COLUMN IS A FIELD ON THE JOB, NOT A CELL.
       *
       * Contractor, Status, Priority and the rest are columns on
       * `maintenance_requests`; the board draws them from the request, and every
       * other screen — the contractor register, the scorecard, exports, the
       * calendar — reads the same field. Writing one here stored a row in
       * `maintenance_board_cells` that shadowed the field without setting it, so
       * assigning a contractor on the board left `request.contractor` null and
       * the register kept saying nobody was assigned, with the board insisting
       * otherwise. Nothing in the UI does this — `saveCustomCell` is for custom
       * columns, as its name says — but the route accepted it, and a silent
       * divergence between the board and every other page is the worst possible
       * way to find that out.
       *
       * `PATCH /api/maintenance` with `{ id, fields }` is where a job's own
       * fields are set, and it is what the board itself calls.
       */
      let value = "";
      try {
        if (column.system && column.key === "name") {
          /*
           * THE NAME COLUMN IS THE ONE SYSTEM COLUMN WHOSE CELL *IS* THE VALUE.
           *
           * The refusal below exists because a system cell SHADOWS the job
           * field it draws — assigning a contractor on the board while
           * `request.contractor` stayed null. The name column shadows nothing:
           * `boardItemName` (board-ordering.ts) reads the CELL first and only
           * falls back to the title or the arrival form where no cell exists,
           * which is precisely how renaming a row is meant to work — "The Name
           * cell still wins where one exists", as that file puts it.
           *
           * Without this branch every rename surface was dead: the grid editor
           * and the mobile sheet both save through here, took a 400, reverted,
           * and showed the developer hint below as a toast. There is not one
           * name cell in the database on any board, because none has ever been
           * allowed to land.
           */
          value = normalizeCellValue(type, payload.value);
        } else if (column.system) {
          /*
           * The ONE thing a system column may store as a cell: the marker and
           * the time of day a date column draws beside the job's own date. It
           * carries no date of its own, so it cannot shadow the field — see
           * `dateDecorationValue`. Everything else is refused, as before.
           */
          const decoration = dateDecorationValue(type, payload.value);
          if (decoration === null) {
            return Response.json(
              {
                error:
                  "That column is a field on the job. Use PATCH /api/maintenance with { id, fields } so every other screen sees the change.",
              },
              { status: 400 },
            );
          }
          value = decoration;
        } else {
          value = normalizeCellValue(type, payload.value);
        }
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof Error ? error.message : "Enter a valid value.",
          },
          { status: 400 },
        );
      }
      // One writer for cells — `setBoardCell` — shared with the automation
      // engine, which needs the previous value so the change can be named.
      const { before, after } = await setBoardCell(db, orgId, boardId, requestId, columnId, value);
      let ran = 0;
      if (!column.system) {
        const event = cellChangedEvent(
          boardId,
          requestId,
          workOrder.parentId ?? null,
          columnId,
          type,
          before,
          after,
        );
        if (event) {
          ran = await dispatchAutomationEvents(
            automationContext(guard.scope, request),
            [event],
          );
        }
      }
      /*
       * `after` is the value THIS request wrote. A rule that ran because of it
       * may have written other cells on the same row — Change status, Set date,
       * Move to group all do — and the board cannot know which from a response
       * that names one cell. So say that rules ran and let the grid refetch;
       * an ordinary edit, which is nearly every edit, still says nothing extra
       * and costs nothing. See the same treatment in /api/maintenance PATCH.
       */
      return Response.json({
        cell: { requestId, columnId, value: after },
        ...(ran > 0 ? { automationsRan: ran } : {}),
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
            isNull(maintenanceBoardColumns.deletedAt),
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
      /*
       * Hiding a column is a saved decision, not a browser-session one. The
       * board used to keep it in a `useState<Set<string>>`, so an operator who
       * hid ten certificate columns to read the other two got all twelve back
       * on the next reload. The `visible` field has been on the table since
       * Stage 1 and simply had no writer.
       */
      if (typeof payload.visible === "boolean") {
        values.visible = payload.visible;
      }
      /*
       * Freezing a column against the left edge, and which summary its group
       * footer runs. Both were already columns on this table with a validated
       * writer on /api/board/columns and no writer here, which is the route the
       * grid actually calls — so neither could be set from the board.
       */
      if (typeof payload.pinned === "boolean") {
        values.pinned = payload.pinned;
      }
      if (payload.summary !== undefined) {
        const summary = trimString(payload.summary, 24);
        // Validated against the column's own type, exactly as
        // PATCH /api/board/columns does — a `sum` on a status column would be a
        // stored instruction the footer could not carry out.
        if (summary && !summariesFor(existing.type).includes(summary as never)) {
          return Response.json(
            { error: `A ${existing.type} column cannot be summarised by "${summary}".` },
            { status: 400 },
          );
        }
        values.summary = summary || null;
      }
      const [column] = await db
        .update(maintenanceBoardColumns)
        .set(values)
        .where(and(eq(maintenanceBoardColumns.id, columnId), eq(maintenanceBoardColumns.organisationId, orgId)))
        .returning();
      /*
       * Audited — but not every keystroke of it.
       *
       * A column being renamed, hidden, pinned or re-summarised is a change to
       * the shape of the board that everybody in the workspace sees, and W13-05
       * asks for those to be attributable. A width drag and a sort direction
       * are not: they fire many times a minute, they are per-column preferences
       * rather than structure, and logging them would bury the events somebody
       * is actually looking for. `structuralColumnChange` decides.
       */
      const structural = structuralColumnChange(existing, column);
      if (structural) {
        await recordAudit({
          db,
          organisationId: orgId,
          actor: auditActor({ actor, identityEmail, session }),
          action: "board.column_updated",
          entityType: "maintenance_board_column",
          entityId: column.id,
          summary: `${structural} the "${column.title}" column on ${boardId}.`,
          detail: {
            board: boardId,
            ...changeDetail(columnAuditShape(existing), columnAuditShape(column)),
          },
          request,
        });
      }
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
            isNull(maintenanceBoardColumns.deletedAt),
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
      /*
       * TWO VERBS THAT USED TO SHARE A BODY.
       *
       * "Clear" empties a column and keeps it: the files go, the values go, the
       * column stays. It is destructive on purpose and stays that way.
       *
       * "Delete" now takes the column off the board and keeps everything it was
       * holding — which means it must NOT run the two lines above. Deleting the
       * files here would have made the column recoverable and its attachments
       * not, which is the worst of the three possible answers.
       */
      if (action === "clear_column") {
        await deleteFilesForColumn(db, orgId, columnId);
        await db
          .delete(maintenanceBoardCells)
          .where(and(eq(maintenanceBoardCells.columnId, columnId), eq(maintenanceBoardCells.organisationId, orgId)));
      } else {
        const binned = await sendColumnToBin(
          db,
          orgId,
          auditActor({ actor, identityEmail, session }),
          columnId,
        );
        if (!binned.ok) {
          return Response.json({ error: binned.error }, { status: 409 });
        }
      }
      await recordAudit({
        db,
        organisationId: orgId,
        actor: auditActor({ actor, identityEmail, session }),
        action: action === "delete_column" ? "board.column_deleted" : "board.column_cleared",
        entityType: "maintenance_board_column",
        entityId: columnId,
        summary:
          action === "delete_column"
            ? `Moved the "${existing.title}" column on ${boardId} to the recycle bin, keeping its values.`
            : `Cleared every value in the "${existing.title}" column on ${boardId}.`,
        detail: {
          board: boardId,
          ...columnAuditShape(existing),
          /*
           * Deleting a column IS recoverable now — the row and every cell it
           * owns stay behind a `deleted_at`, and the bin holds the arrangement
           * needed to put it back. Clearing one is not, and never was: it
           * destroys the values and keeps the column, which is a different
           * verb with a different promise.
           */
          recoverable: action === "delete_column",
          ...(action === "delete_column" ? { retentionDays: RETENTION_DAYS } : {}),
        },
        request,
      });
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
      let requestBefore: typeof maintenanceRequests.$inferSelect | undefined;
      if (existingItem.groupId !== groupId && group.stageKey) {
        const stage = group.stageKey as RequestStage;
        [requestBefore] = await db
          .select()
          .from(maintenanceRequests)
          .where(and(eq(maintenanceRequests.id, requestId), eq(maintenanceRequests.organisationId, orgId)))
          .limit(1);
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
      if (existingItem.groupId !== groupId) {
        await dispatchAutomationEvents(automationContext(guard.scope, request), [
          itemMovedEvent(boardId, requestId, requestBefore?.parentId ?? null, group.id, group.name),
          ...(updatedRequest ? requestFieldEvents(boardId, requestBefore, updatedRequest) : []),
        ]);
      }
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
      await mirrorRegistryOption(db, orgId, option.columnKey, option.value, {
        kind: "upsert",
        label: option.label,
        colourHex: option.color,
        textColour: option.textColor,
        active: option.active,
      });
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
      await mirrorRegistryOption(db, orgId, existing.columnKey, existing.value, {
        kind: "remove",
      });
      return Response.json({ deleted: true, optionId });
    }

    return Response.json({ error: "Unknown board action." }, { status: 400 });
  } catch (error) {
    /* A board this organisation does not have is a bad REQUEST, not an outage.
       Without this the generic handler below answers 503 "temporarily
       unavailable", telling the browser to retry a request no retry can fix —
       which is the case `isBoardNotFound` was written for. */
    if (isBoardNotFound(error)) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      { error: "The board change could not be saved." },
      { status: 503 },
    );
  }
}
