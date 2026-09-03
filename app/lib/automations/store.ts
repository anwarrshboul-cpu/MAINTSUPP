/**
 * Reading and writing rules — validation, the sentence, and the lookups the
 * sentence needs.
 *
 * A rule is validated against the catalogue before it is stored: the trigger
 * and the action must exist and be available, every required field must be
 * present, and every column, group and person it names must be on THIS
 * board in THIS workspace. The sentence is composed here from the stored
 * config and the board's real names, never trusted from the client.
 */

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  boardAutomations,
  maintenanceBoardColumns,
  maintenanceGroups,
} from "../../../db/schema";
import { SYSTEM_FIELD_BY_KEY, isSystemColumnKey } from "../request-fields";
import {
  COLUMN_KINDS,
  buildCatalog,
  catalogIndex,
  type AutomationCatalog,
  type CatalogField,
  type CatalogEnvironment,
} from "./catalog";
import { composeSentence, type SentenceResolver } from "./sentence";
import { configString, parseConfig, type AutomationRule, type Database } from "./types";
import { resolveBoard } from "../board-registry";

export const BOARD_IDS = ["maintenance", "store-documentation"] as const;
export type BoardId = (typeof BOARD_IDS)[number];

/**
 * Which board an automation or a discussion is about.
 *
 * THIS USED TO COERCE EVERY UNKNOWN KEY TO "maintenance", AND THAT WAS A WRITE.
 *
 * `normaliseBoardId` was a pure `includes ? raw : "maintenance"`, so a rule or a
 * comment created on a workspace section's own register was stored against the
 * canonical JOB BOARD — silently, with a 200 and the caller's own key echoed
 * back. It is the same silent substitution `boardIdFrom` in `/api/board` was
 * built on, found in the same audit and fixed the same way: ask the database
 * which boards this organisation actually has.
 *
 * Kept synchronous and total for the two built-ins, because every caller passes
 * one of them on the overwhelming majority of requests and a round trip for
 * "maintenance" would be paid on every board load. Anything else is resolved,
 * and `resolveBoard` throws `BoardNotFoundError` for a key this workspace does
 * not have — which the routes turn into a 404 rather than a write somewhere
 * else.
 */
export function isBuiltInBoardId(raw: unknown): raw is BoardId {
  return BOARD_IDS.includes(raw as BoardId);
}

export async function resolveBoardId(
  db: Database,
  organisationId: string,
  raw: unknown,
): Promise<string> {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return "maintenance";
  if (isBuiltInBoardId(key)) return key;
  const board = await resolveBoard(db, organisationId, key);
  return board.key;
}

export function catalogEnvironment(): CatalogEnvironment {
  const env = (globalThis as Record<string, unknown>).process as
    | { env?: Record<string, string | undefined> }
    | undefined;
  return { emailConfigured: Boolean(env?.env?.RESEND_API_KEY) };
}

export function currentCatalog(): AutomationCatalog {
  return buildCatalog(catalogEnvironment());
}

type ColumnRow = typeof maintenanceBoardColumns.$inferSelect;
type GroupRow = typeof maintenanceGroups.$inferSelect;

/** What the board has — columns and groups — for validation and naming. */
export async function boardVocabulary(db: Database, orgId: string, boardId: string) {
  const columns = await db
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
  const groups = await db
    .select()
    .from(maintenanceGroups)
    .where(
      and(
        eq(maintenanceGroups.boardId, boardId),
        eq(maintenanceGroups.organisationId, orgId),
        isNull(maintenanceGroups.deletedAt),
      ),
    )
    .orderBy(asc(maintenanceGroups.position));
  return { columns, groups };
}

/** A column by key (system) or id (custom). */
function findColumn(columns: ColumnRow[], key: string): ColumnRow | null {
  return (
    columns.find((column) => column.id === key) ??
    columns.find((column) => column.system && column.key === key) ??
    null
  );
}

/** Canonical handle for a column: the key for system columns, the id otherwise. */
function columnHandle(column: ColumnRow): string {
  return column.system && isSystemColumnKey(column.key) ? column.key : column.id;
}

export function resolverFor(columns: ColumnRow[], groups: GroupRow[]): SentenceResolver {
  return {
    column: (key) => findColumn(columns, key)?.title ?? (isSystemColumnKey(key) ? key : "a column"),
    group: (id) => groups.find((group) => group.id === id)?.name ?? "a group",
    option: (column, value) => {
      const found = findColumn(columns, column);
      const settings = (found?.settings ? safeJson(found.settings) : {}) as {
        choices?: Array<{ id?: string; label?: string }>;
        people?: Array<{ id?: string; label?: string }>;
      };
      const choice = [...(settings.choices ?? []), ...(settings.people ?? [])].find(
        (entry) => entry.id === value || entry.label === value,
      );
      return choice?.label ?? value;
    },
    person: (id) => id,
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export type ValidationOutcome =
  | { ok: true; triggerConfig: Record<string, unknown>; actionConfig: Record<string, unknown>; name: string }
  | { ok: false; error: string };

function validateFields(
  fields: CatalogField[],
  config: Record<string, unknown>,
  columns: ColumnRow[],
  groups: GroupRow[],
  what: string,
): { ok: true; config: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = config[field.key];
    const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
    if (!text) {
      if (field.optional) continue;
      return { ok: false, error: `${what}: choose ${field.label}.` };
    }
    switch (field.kind) {
      case "status_column":
      case "date_column":
      case "people_column":
      case "number_column":
      case "column": {
        const column = findColumn(columns, text);
        if (!column) return { ok: false, error: `${what}: that column is not on this board.` };
        if (!COLUMN_KINDS[field.kind].includes(column.type)) {
          return { ok: false, error: `${what}: ${column.title} is not a ${field.label.toLowerCase()}.` };
        }
        if (column.type === "files" || column.type === "subitems") {
          return { ok: false, error: `${what}: ${column.title} cannot be used in a rule.` };
        }
        out[field.key] = columnHandle(column);
        break;
      }
      case "group": {
        if (!groups.some((group) => group.id === text)) {
          return { ok: false, error: `${what}: that group is not on this board.` };
        }
        out[field.key] = text;
        break;
      }
      case "choice": {
        if (!field.options?.some((option) => option.value === text)) {
          return { ok: false, error: `${what}: choose ${field.label}.` };
        }
        out[field.key] = text;
        break;
      }
      case "days":
      case "number": {
        const number = Number(text);
        if (!Number.isFinite(number)) return { ok: false, error: `${what}: ${field.label} must be a number.` };
        out[field.key] = field.kind === "days" ? Math.round(number) : number;
        break;
      }
      case "email": {
        if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(text) || text.length > 200) {
          return { ok: false, error: `${what}: enter a valid email address.` };
        }
        out[field.key] = text.toLowerCase();
        break;
      }
      case "long_text":
        out[field.key] = text.slice(0, 4000);
        break;
      default:
        out[field.key] = text.slice(0, 400);
    }
  }
  return { ok: true, config: out };
}

/**
 * Checks a rule against the catalogue and the board, and composes its name.
 *
 * `catalog` is passed in so tests can validate against a fixed environment.
 */
export function validateRule(
  catalog: AutomationCatalog,
  columns: ColumnRow[],
  groups: GroupRow[],
  input: {
    triggerType: string;
    triggerConfig: Record<string, unknown>;
    actionType: string;
    actionConfig: Record<string, unknown>;
  },
): ValidationOutcome {
  const index = catalogIndex(catalog);
  const trigger = index.trigger.get(input.triggerType);
  const action = index.action.get(input.actionType);
  if (!trigger) return { ok: false, error: "Choose what should happen first." };
  if (!action) return { ok: false, error: "Choose what should happen then." };
  if (!trigger.available) return { ok: false, error: `${trigger.label}: ${trigger.reason ?? "not available"}.` };
  if (!action.available) return { ok: false, error: `${action.label}: ${action.reason ?? "not available"}.` };
  if (trigger.itemless && action.needsItem) {
    return {
      ok: false,
      error: `"${trigger.label}" fires without an item, so it cannot ${action.label.toLowerCase()}. Choose an action that creates something instead.`,
    };
  }
  const triggerFields = validateFields(trigger.fields, input.triggerConfig, columns, groups, trigger.label);
  if (!triggerFields.ok) return triggerFields;
  const actionFields = validateFields(action.fields, input.actionConfig, columns, groups, action.label);
  if (!actionFields.ok) return actionFields;

  // Status columns narrow their value fields — the value must be one the
  // column offers, so a rule cannot be made for a chip that does not exist.
  const statusColumn = (cfg: Record<string, unknown>) => configString(cfg, "column") || "status";
  for (const [entry, cfg] of [
    [trigger, triggerFields.config],
    [action, actionFields.config],
  ] as const) {
    for (const field of entry.fields) {
      if (field.kind !== "status_value") continue;
      const value = configString(cfg, field.key);
      if (!value) continue;
      const column = findColumn(columns, statusColumn(cfg));
      if (column && column.type === "status") {
        // Board status chips live in the option store, not in settings; the
        // value is accepted as typed and resolved to a label for display.
        continue;
      }
      if (column && column.type === "dropdown") {
        const settings = safeJson(column.settings) as { choices?: Array<{ id?: string; label?: string }> };
        const ok = (settings.choices ?? []).some((choice) => choice.id === value || choice.label === value);
        if (!ok) return { ok: false, error: `${entry.label}: "${value}" is not a choice of ${column.title}.` };
      }
    }
  }

  const name = composeSentence(
    input.triggerType,
    triggerFields.config,
    input.actionType,
    actionFields.config,
    resolverFor(columns, groups),
  );
  return { ok: true, triggerConfig: triggerFields.config, actionConfig: actionFields.config, name };
}

/** What the client is shown for one rule. */
export function exposeRule(rule: AutomationRule) {
  return {
    id: rule.id,
    boardId: rule.boardId,
    name: rule.name,
    triggerType: rule.triggerType,
    triggerConfig: parseConfig(rule.triggerConfig),
    actionType: rule.actionType,
    actionConfig: parseConfig(rule.actionConfig),
    enabled: rule.enabled === "on",
    importance: rule.importance,
    description: rule.description,
    createdBy: rule.createdBy,
    runCount: rule.runCount,
    lastRunAt: rule.lastRunAt,
    lastSweepAt: rule.lastSweepAt,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    timeBased: rule.triggerType === "date_arrives" || rule.triggerType === "every_period",
  };
}

export async function listRules(db: Database, orgId: string, boardId: string): Promise<AutomationRule[]> {
  return db
    .select()
    .from(boardAutomations)
    .where(and(eq(boardAutomations.organisationId, orgId), eq(boardAutomations.boardId, boardId)))
    .orderBy(desc(boardAutomations.createdAt));
}

export async function findRule(db: Database, orgId: string, id: string): Promise<AutomationRule | null> {
  const [rule] = await db
    .select()
    .from(boardAutomations)
    .where(and(eq(boardAutomations.id, id), eq(boardAutomations.organisationId, orgId)))
    .limit(1);
  return rule ?? null;
}

export const IMPORTANCE = ["minor", "major", "critical"] as const;

export function normaliseImportance(raw: unknown): (typeof IMPORTANCE)[number] | null {
  return IMPORTANCE.includes(raw as never) ? (raw as (typeof IMPORTANCE)[number]) : null;
}

/** A handful of ready-made rules, built from the catalogue. Real, and few. */
export function templatesFor(boardId: string) {
  if (boardId !== "maintenance") return [];
  return [
    {
      key: "completed-to-done",
      title: "Close the loop on completed jobs",
      triggerType: "status_changes",
      triggerConfig: { column: "status", to: "Job Completed" },
      actionType: "set_date",
      actionConfig: { column: "completed", days: 0 },
      blurb: "When Status becomes Job Completed, set Date Completed to today.",
    },
    {
      key: "new-item-note",
      title: "Welcome every new item",
      triggerType: "item_created",
      triggerConfig: {},
      actionType: "create_update",
      actionConfig: { body: "{name} was added to the board." },
      blurb: "When an item is created, post an update on it.",
    },
    {
      key: "assigned-set-next-update",
      title: "Ask for an update three days after assignment",
      triggerType: "person_assigned",
      triggerConfig: { column: "assignee" },
      actionType: "set_date",
      actionConfig: { column: "nextUpdate", days: 3 },
      blurb: "When someone is assigned, set Next Update to three days from today.",
    },
    {
      key: "due-today-priority",
      title: "Raise the priority on the due date",
      triggerType: "date_arrives",
      triggerConfig: { column: "dueDate", when: "on", days: 0 },
      actionType: "change_status",
      actionConfig: { column: "priority", value: "High" },
      blurb: "When Due Date arrives, set Priority to High.",
    },
  ];
}

/** Columns and groups in the shape the builder's pickers want. */
export function exposeVocabulary(columns: ColumnRow[], groups: GroupRow[]) {
  return {
    columns: columns
      .filter((column) => column.type !== "files" && column.type !== "subitems")
      .map((column) => ({
        handle: columnHandle(column),
        id: column.id,
        key: column.key,
        title: column.title,
        type: column.type,
        system: column.system,
        settings: safeJson(column.settings),
      })),
    groups: groups.map((group) => ({ id: group.id, name: group.name, color: group.color, stageKey: group.stageKey })),
    systemFields: Object.keys(SYSTEM_FIELD_BY_KEY),
  };
}
