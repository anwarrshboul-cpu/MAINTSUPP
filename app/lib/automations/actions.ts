/**
 * What a rule DOES, one function per action type.
 *
 * Every action goes through the same code the board's own routes use —
 * `board-mutations.ts` for items, groups and cells, `request-fields.ts` for a
 * job's own columns, `recycle-bin.ts` for deletion, `notifications.ts` for
 * email. Nothing here calls an API route, and nothing here invents a write
 * the board could not make itself.
 *
 * An action answers with a summary and, where it changed the board, the
 * events that change raises — which the engine dispatches at depth + 1 so
 * that rules can chain and the loop guard can stop them.
 *
 * Idempotent where it can be: setting a value that is already set is a
 * `noop`, recorded as success so the history says "already so" rather than
 * pretending to have worked.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import {
  itemUpdates,
  maintenanceBoardCells,
  maintenanceBoardColumns,
  maintenanceRequests,
  users,
} from "../../../db/schema";
import {
  createBoardGroup,
  createBoardItem,
  duplicateBoardItems,
  findGroup,
  findOrCreateArchivedGroup,
  moveItemsToGroup,
  placementOf,
  setBoardCell,
} from "../board-mutations";
import { normalizeBoardCellValue, dateOfCell } from "../board-cell-values";
import { sendNotification } from "../notifications";
import { sendJobsToBin } from "../recycle-bin";
import {
  SYSTEM_FIELD_BY_KEY,
  fieldAsText,
  isSystemColumnKey,
  requestFieldValues,
} from "../request-fields";
import type { BoardColumnType } from "../types";
import {
  cellChangedEvent,
  itemCreatedEvent,
  itemMovedEvent,
  requestFieldEvents,
  updateCreatedEvent,
} from "./events";
import {
  configNumber,
  configString,
  parseConfig,
  type ActionResult,
  type AutomationContext,
  type AutomationEvent,
  type AutomationRule,
} from "./types";

type RequestRow = typeof maintenanceRequests.$inferSelect;
type ColumnRow = typeof maintenanceBoardColumns.$inferSelect;

/** `yyyy-mm-dd` for a UTC instant offset by whole days. */
export function dayPlus(days: number, from = new Date()): string {
  const at = new Date(from.getTime() + days * 86_400_000);
  return at.toISOString().slice(0, 10);
}

async function loadItem(
  ctx: AutomationContext,
  requestId: string,
): Promise<RequestRow | null> {
  const [row] = await ctx.db
    .select()
    .from(maintenanceRequests)
    .where(
      and(
        eq(maintenanceRequests.id, requestId),
        eq(maintenanceRequests.organisationId, ctx.orgId),
        isNull(maintenanceRequests.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function loadColumn(
  ctx: AutomationContext,
  boardId: string,
  columnId: string,
): Promise<ColumnRow | null> {
  const [row] = await ctx.db
    .select()
    .from(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.id, columnId),
        eq(maintenanceBoardColumns.boardId, boardId),
        eq(maintenanceBoardColumns.organisationId, ctx.orgId),
        isNull(maintenanceBoardColumns.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Sets one of the job's own columns through the same normaliser the
 * maintenance route uses, and reports the events the change raises.
 */
async function setSystemField(
  ctx: AutomationContext,
  boardId: string,
  item: RequestRow,
  key: string,
  raw: unknown,
  label: string,
): Promise<ActionResult> {
  if (!isSystemColumnKey(key)) throw new Error(`"${key}" is not a column on this board.`);
  const entry = SYSTEM_FIELD_BY_KEY[key];
  const current = fieldAsText(item[entry.field as keyof RequestRow]);
  const wanted = raw === null ? "" : fieldAsText(raw);
  if (current === wanted || (entry.type === "date" && current.slice(0, 10) === wanted.slice(0, 10) && wanted)) {
    return { summary: `${label} already ${wanted || "empty"}`, noop: true };
  }
  const values = requestFieldValues({ [entry.field]: raw });
  if (!(entry.field in values)) {
    throw new Error(`${label}: "${wanted}" is not a value this column accepts.`);
  }
  const [updated] = await ctx.db
    .update(maintenanceRequests)
    .set({ ...values, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(maintenanceRequests.id, item.id),
        eq(maintenanceRequests.organisationId, ctx.orgId),
      ),
    )
    .returning();
  if (!updated) throw new Error("The item no longer exists.");
  return {
    summary: `${label} set to ${wanted || "empty"}`,
    events: requestFieldEvents(boardId, item, updated),
  };
}

async function setCustomCell(
  ctx: AutomationContext,
  boardId: string,
  item: RequestRow,
  column: ColumnRow,
  raw: unknown,
): Promise<ActionResult> {
  const type = column.type as BoardColumnType;
  if (column.system) throw new Error(`${column.title} is a field on the job; name it by its key.`);
  if (type === "files" || type === "subitems") {
    throw new Error(`${column.title} cannot be set by a rule.`);
  }
  const value = normalizeBoardCellValue(type, raw);
  const { before, after } = await setBoardCell(ctx.db, ctx.orgId, boardId, item.id, column.id, value);
  if (before === after) return { summary: `${column.title} already ${after || "empty"}`, noop: true };
  const event = cellChangedEvent(boardId, item.id, item.parentId ?? null, column.id, type, before, after);
  return { summary: `${column.title} set to ${after || "empty"}`, events: event ? [event] : [] };
}

/** Resolves a configured column to either a system key or a custom column row. */
async function resolveColumn(
  ctx: AutomationContext,
  boardId: string,
  key: string,
): Promise<{ system: true; key: string; label: string } | { system: false; column: ColumnRow }> {
  if (isSystemColumnKey(key)) {
    const [column] = await ctx.db
      .select({ title: maintenanceBoardColumns.title })
      .from(maintenanceBoardColumns)
      .where(
        and(
          eq(maintenanceBoardColumns.key, key),
          eq(maintenanceBoardColumns.boardId, boardId),
          eq(maintenanceBoardColumns.organisationId, ctx.orgId),
        ),
      )
      .limit(1);
    return { system: true, key, label: column?.title ?? key };
  }
  const column = await loadColumn(ctx, boardId, key);
  if (!column) throw new Error(`The column "${key}" is no longer on this board.`);
  if (column.system && isSystemColumnKey(column.key)) {
    return { system: true, key: column.key, label: column.title };
  }
  return { system: false, column };
}

async function setColumn(
  ctx: AutomationContext,
  boardId: string,
  item: RequestRow,
  key: string,
  raw: unknown,
): Promise<ActionResult> {
  const target = await resolveColumn(ctx, boardId, key);
  return target.system
    ? setSystemField(ctx, boardId, item, target.key, raw, target.label)
    : setCustomCell(ctx, boardId, item, target.column, raw);
}

/** The current `yyyy-mm-dd` held by a date column, system or custom. */
async function currentDate(
  ctx: AutomationContext,
  boardId: string,
  item: RequestRow,
  key: string,
): Promise<{ label: string; day: string }> {
  const target = await resolveColumn(ctx, boardId, key);
  if (target.system) {
    const entry = SYSTEM_FIELD_BY_KEY[target.key as keyof typeof SYSTEM_FIELD_BY_KEY];
    return { label: target.label, day: fieldAsText(item[entry.field as keyof RequestRow]).slice(0, 10) };
  }
  const [cell] = await ctx.db
    .select({ value: maintenanceBoardCells.value })
    .from(maintenanceBoardCells)
    .where(
      and(
        eq(maintenanceBoardCells.organisationId, ctx.orgId),
        eq(maintenanceBoardCells.boardId, boardId),
        eq(maintenanceBoardCells.requestId, item.id),
        eq(maintenanceBoardCells.columnId, target.column.id),
      ),
    )
    .limit(1);
  return { label: target.column.title, day: dateOfCell(cell?.value ?? "") };
}

const REQUIRED_KEYS = new Set(["name", "status", "priority", "engineer", "label", "tier", "location", "description", "requester", "requested"]);

export async function executeAction(
  ctx: AutomationContext,
  rule: AutomationRule,
  event: AutomationEvent,
): Promise<ActionResult> {
  const config = parseConfig(rule.actionConfig);
  const boardId = rule.boardId;
  const type = rule.actionType;

  // Item-less actions first — they must not require an event with an item.
  if (type === "create_item") {
    const groupId = configString(config, "groupId");
    const title = configString(config, "title");
    if (!groupId) throw new Error("Create item needs a group.");
    const created = await createBoardItem(ctx.db, ctx.orgId, boardId, ctx.actor, groupId, { title });
    if (!created) throw new Error("The group for the new item is no longer on this board.");
    return {
      summary: `created ${created.request.id} "${created.request.title}" in ${created.group.name}`,
      events: [itemCreatedEvent(boardId, created.request.id, null, created.group.id)],
    };
  }
  if (type === "create_group") {
    const name = configString(config, "name");
    if (name.length < 2) throw new Error("Create group needs a name.");
    const group = await createBoardGroup(ctx.db, ctx.orgId, boardId, name);
    return { summary: `created group "${group.name}"` };
  }
  if (type === "notify_person") {
    const to = configString(config, "to");
    const message = configString(config, "message") || rule.name;
    const item = event.requestId ? await loadItem(ctx, event.requestId) : null;
    const subject = item ? `${item.title} — ${rule.name}` : rule.name;
    const result = await sendNotification(ctx.db, {
      organisationId: ctx.orgId,
      channel: "email",
      event: "automation",
      subjectType: item ? "job" : "system",
      subjectId: item?.id ?? rule.id,
      to,
      subject,
      body: `<p>${escapeHtml(message.replaceAll("{name}", item?.title ?? ""))}</p>`,
      text: message.replaceAll("{name}", item?.title ?? ""),
    });
    if (result.status === "sent") return { summary: `emailed ${to}` };
    if (result.status === "skipped") return { summary: `email to ${to} not sent`, skipped: result.error ?? "Email delivery is not configured." };
    throw new Error(result.error ?? "The email could not be sent.");
  }

  if (!event.requestId) {
    return { summary: "", skipped: "This action needs an item and the trigger fired without one." };
  }
  const item = await loadItem(ctx, event.requestId);
  if (!item) {
    return { summary: "", skipped: "The item is no longer on the board." };
  }

  switch (type) {
    case "change_column_value": {
      const column = configString(config, "column");
      if (!column) throw new Error("Change column value needs a column.");
      return setColumn(ctx, boardId, item, column, config.value ?? "");
    }
    case "change_status": {
      const column = configString(config, "column") || "status";
      const value = configString(config, "value");
      if (!value) throw new Error("Change status needs a value.");
      return setColumn(ctx, boardId, item, column, value);
    }
    case "set_date": {
      const column = configString(config, "column");
      if (!column) throw new Error("Set date needs a date column.");
      const days = configNumber(config, "days") ?? 0;
      return setColumn(ctx, boardId, item, column, dayPlus(days));
    }
    case "push_date": {
      const column = configString(config, "column");
      const days = configNumber(config, "days") ?? 0;
      if (!column) throw new Error("Push date needs a date column.");
      const { label, day } = await currentDate(ctx, boardId, item, column);
      if (!day) return { summary: `${label} is empty, nothing to push`, noop: true };
      const base = new Date(`${day}T00:00:00.000Z`);
      if (Number.isNaN(base.getTime())) return { summary: `${label} holds no readable date`, noop: true };
      return setColumn(ctx, boardId, item, column, dayPlus(days, base));
    }
    case "move_to_group": {
      const groupId = configString(config, "groupId");
      if (!groupId) throw new Error("Move item needs a group.");
      const group = await findGroup(ctx.db, ctx.orgId, boardId, groupId);
      if (!group) throw new Error("That group is no longer on this board.");
      const placement = await placementOf(ctx.db, ctx.orgId, boardId, item.id);
      if (placement?.groupId === group.id) {
        return { summary: `already in ${group.name}`, noop: true };
      }
      return moveResult(boardId, item, await moveItemsToGroup(ctx.db, ctx.orgId, boardId, ctx.actor, group, [item.id]));
    }
    case "archive_item": {
      const group = await findOrCreateArchivedGroup(ctx.db, ctx.orgId, boardId);
      const placement = await placementOf(ctx.db, ctx.orgId, boardId, item.id);
      if (placement?.groupId === group.id) return { summary: "already archived", noop: true };
      return moveResult(
        boardId,
        item,
        await moveItemsToGroup(ctx.db, ctx.orgId, boardId, ctx.actor, group, [item.id], true),
      );
    }
    case "create_subitem": {
      const title = configString(config, "title") || "Subitem";
      const placement = await placementOf(ctx.db, ctx.orgId, boardId, item.id);
      if (!placement) throw new Error("The item has no group to put a subitem in.");
      const created = await createBoardItem(ctx.db, ctx.orgId, boardId, ctx.actor, placement.groupId, {
        title,
        parentId: item.id,
      });
      if (!created) throw new Error("The item's group is no longer on this board.");
      return {
        summary: `created subitem ${created.request.id} "${title}"`,
        events: [itemCreatedEvent(boardId, created.request.id, item.id, placement.groupId)],
      };
    }
    case "replace_assignee": {
      const person = configString(config, "person");
      if (!person) throw new Error("Replace assignee needs a person.");
      return setSystemField(ctx, boardId, item, "assignee", person, "Assigned To");
    }
    case "clear_assignees":
      return setSystemField(ctx, boardId, item, "assignee", null, "Assigned To");
    case "assign_item_creator": {
      const email = (item.createdByEmail ?? "").trim().toLowerCase();
      if (!email) return { summary: "", skipped: "The item's creator is not recorded." };
      const [user] = await ctx.db
        .select({ fullName: users.fullName, email: users.email })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`)
        .limit(1);
      const name = user?.fullName?.trim() || user?.email || email;
      return setSystemField(ctx, boardId, item, "assignee", name, "Assigned To");
    }
    case "create_update": {
      const body = (configString(config, "body") || rule.name).replaceAll("{name}", item.title).slice(0, 8000);
      const id = `upd_${crypto.randomUUID().replace(/-/g, "")}`;
      await ctx.db.insert(itemUpdates).values({
        id,
        organisationId: ctx.orgId,
        boardId,
        requestId: item.id,
        parentId: null,
        authorName: "Automation",
        authorEmail: ctx.actor.email ?? null,
        body,
        createdAt: new Date().toISOString(),
      });
      await ctx.db
        .update(maintenanceRequests)
        .set({
          commentCount: sql`(SELECT COUNT(*) FROM item_updates u WHERE u.request_id = ${item.id})`,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(eq(maintenanceRequests.id, item.id), eq(maintenanceRequests.organisationId, ctx.orgId)),
        );
      return {
        summary: `posted update "${body.slice(0, 60)}"`,
        events: [updateCreatedEvent(boardId, item.id, item.parentId ?? null)],
      };
    }
    case "clear_column_value": {
      const column = configString(config, "column");
      if (!column) throw new Error("Clear column value needs a column.");
      const target = await resolveColumn(ctx, boardId, column);
      if (target.system && REQUIRED_KEYS.has(target.key)) {
        return { summary: "", skipped: `${target.label} is required on every item and cannot be cleared.` };
      }
      return target.system
        ? setSystemField(ctx, boardId, item, target.key, null, target.label)
        : setCustomCell(ctx, boardId, item, target.column, "");
    }
    case "delete_item": {
      const binned = await sendJobsToBin(ctx.db, ctx.orgId, ctx.actor, [item.id]);
      if (!binned.length) return { summary: "already in the recycle bin", noop: true };
      return { summary: `moved ${item.id} to the recycle bin` };
    }
    case "duplicate_item": {
      const outcome = await duplicateBoardItems(ctx.db, ctx.orgId, boardId, ctx.actor, [item.id]);
      const copy = outcome.requests[0];
      if (!copy) throw new Error("The item could not be duplicated.");
      return {
        summary: `duplicated as ${copy.id}`,
        events: [itemCreatedEvent(boardId, copy.id, copy.parentId ?? null, outcome.items[0]?.groupId)],
      };
    }
    case "set_number": {
      const column = configString(config, "column") || "cost";
      const value = configNumber(config, "value");
      if (value === null) throw new Error("Set number needs a number.");
      return setColumn(ctx, boardId, item, column, value);
    }
    default:
      return { summary: "", skipped: `"${type}" is not an action this board can perform.` };
  }
}

function moveResult(
  boardId: string,
  item: RequestRow,
  outcome: Awaited<ReturnType<typeof moveItemsToGroup>>,
): ActionResult {
  const events: AutomationEvent[] = [];
  if (outcome.movedFrom.length) {
    events.push(itemMovedEvent(boardId, item.id, item.parentId ?? null, outcome.group.id, outcome.group.name));
  }
  const updated = outcome.requests[0];
  if (updated) events.push(...requestFieldEvents(boardId, item, updated));
  return { summary: `moved to ${outcome.group.name}`, events };
}

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
