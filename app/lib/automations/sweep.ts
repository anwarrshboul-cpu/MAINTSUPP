/**
 * Time-based rules — "when a date arrives", "every day".
 *
 * Nothing in this product runs on a clock. There is no scheduler, no cron
 * and no queue, and inventing one would be a lie about how the deployment
 * works. So time-based rules are evaluated by a SWEEP that runs when the
 * board is opened, at most once per workspace every ten minutes, and the UI
 * says exactly that beside every such rule.
 *
 * Two consequences worth knowing:
 *   · a rule fires the first time the board is opened on or after its day,
 *     not at midnight;
 *   · a board nobody opens is a board whose time-based rules do not run.
 *
 * Both are true of the product as built, and the note in the catalogue says
 * so in as many words.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import {
  automationRuns,
  boardAutomations,
  maintenanceBoardCells,
  maintenanceBoardColumns,
  maintenanceGroupItems,
  maintenanceRequests,
} from "../../../db/schema";
import { dateOfCell } from "../board-cell-values";
import { SYSTEM_FIELD_BY_KEY, fieldAsText, isSystemColumnKey } from "../request-fields";
import { dispatchAutomationEvent, newChain } from "./engine";
import {
  SWEEP_INTERVAL_MS,
  configNumber,
  configString,
  parseConfig,
  type AutomationContext,
  type AutomationRule,
} from "./types";

/** ISO week key, `2026-W34`, so weekly rules fire once per week. */
export function periodKey(every: string, at = new Date()): string {
  const day = at.toISOString().slice(0, 10);
  if (every !== "week") return day;
  const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The day a date rule fires for, given the day the column holds. */
export function fireDayFor(columnDay: string, when: string, days: number): string {
  const base = new Date(`${columnDay}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return "";
  const offset = when === "before" ? -Math.abs(days) : when === "after" ? Math.abs(days) : 0;
  return new Date(base.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
}

async function alreadyRan(ctx: AutomationContext, ruleId: string, dedupeKey: string) {
  const [row] = await ctx.db
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.organisationId, ctx.orgId),
        eq(automationRuns.automationId, ruleId),
        eq(automationRuns.dedupeKey, dedupeKey),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** `requestId → yyyy-mm-dd` for every live item on the board holding the column. */
async function datesFor(
  ctx: AutomationContext,
  boardId: string,
  column: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (isSystemColumnKey(column)) {
    const entry = SYSTEM_FIELD_BY_KEY[column];
    if (entry.type !== "date") return out;
    const rows = await ctx.db
      .select({ id: maintenanceRequests.id, value: sql<string | null>`${sql.identifier(snake(entry.field))}` })
      .from(maintenanceRequests)
      .innerJoin(
        maintenanceGroupItems,
        and(
          eq(maintenanceGroupItems.requestId, maintenanceRequests.id),
          eq(maintenanceGroupItems.organisationId, ctx.orgId),
          eq(maintenanceGroupItems.boardId, boardId),
        ),
      )
      .where(
        and(
          eq(maintenanceRequests.organisationId, ctx.orgId),
          isNull(maintenanceRequests.deletedAt),
          eq(maintenanceRequests.archived, false),
        ),
      );
    for (const row of rows) {
      const day = fieldAsText(row.value).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) out.set(row.id, day);
    }
    return out;
  }
  const [col] = await ctx.db
    .select({ id: maintenanceBoardColumns.id, type: maintenanceBoardColumns.type })
    .from(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.id, column),
        eq(maintenanceBoardColumns.boardId, boardId),
        eq(maintenanceBoardColumns.organisationId, ctx.orgId),
        isNull(maintenanceBoardColumns.deletedAt),
      ),
    )
    .limit(1);
  if (!col || col.type !== "date") return out;
  const cells = await ctx.db
    .select({ requestId: maintenanceBoardCells.requestId, value: maintenanceBoardCells.value })
    .from(maintenanceBoardCells)
    .innerJoin(
      maintenanceRequests,
      and(
        eq(maintenanceRequests.id, maintenanceBoardCells.requestId),
        eq(maintenanceRequests.organisationId, ctx.orgId),
        isNull(maintenanceRequests.deletedAt),
      ),
    )
    .where(
      and(
        eq(maintenanceBoardCells.organisationId, ctx.orgId),
        eq(maintenanceBoardCells.boardId, boardId),
        eq(maintenanceBoardCells.columnId, col.id),
      ),
    );
  for (const cell of cells) {
    const day = dateOfCell(cell.value);
    if (day) out.set(cell.requestId, day);
  }
  return out;
}

function snake(field: string) {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export type SweepOutcome = {
  swept: boolean;
  reason?: string;
  evaluated: number;
  fired: number;
};

/**
 * Evaluates every enabled time-based rule in the workspace.
 *
 * `force` ignores the ten-minute interval — for the explicit "check now"
 * endpoint — and nothing else does.
 */
export async function sweepTimeBasedRules(
  ctx: AutomationContext,
  options: { force?: boolean; now?: Date } = {},
): Promise<SweepOutcome> {
  const now = options.now ?? new Date();
  const rules = (
    await ctx.db
      .select()
      .from(boardAutomations)
      .where(
        and(eq(boardAutomations.organisationId, ctx.orgId), eq(boardAutomations.enabled, "on")),
      )
  ).filter((rule) => rule.triggerType === "date_arrives" || rule.triggerType === "every_period");

  if (!rules.length) return { swept: false, reason: "No time-based rules.", evaluated: 0, fired: 0 };

  if (!options.force) {
    const latest = rules
      .map((rule) => (rule.lastSweepAt ? Date.parse(rule.lastSweepAt) : 0))
      .reduce((max, value) => Math.max(max, value), 0);
    if (latest && now.getTime() - latest < SWEEP_INTERVAL_MS) {
      return {
        swept: false,
        reason: `Checked ${Math.round((now.getTime() - latest) / 60_000)} minutes ago; checked at most every ten.`,
        evaluated: 0,
        fired: 0,
      };
    }
  }

  let fired = 0;
  const today = now.toISOString().slice(0, 10);
  for (const rule of rules) {
    try {
      fired += await evaluateRule(ctx, rule, today, now);
    } catch (cause) {
      console.error("[automations] sweep failed for a rule", { rule: rule.id, cause });
    }
    await ctx.db
      .update(boardAutomations)
      .set({ lastSweepAt: now.toISOString() })
      .where(and(eq(boardAutomations.id, rule.id), eq(boardAutomations.organisationId, ctx.orgId)));
  }
  return { swept: true, evaluated: rules.length, fired };
}

async function evaluateRule(
  ctx: AutomationContext,
  rule: AutomationRule,
  today: string,
  now: Date,
): Promise<number> {
  const config = parseConfig(rule.triggerConfig);
  let fired = 0;

  if (rule.triggerType === "every_period") {
    const every = configString(config, "every") || "day";
    const key = periodKey(every, now);
    if (await alreadyRan(ctx, rule.id, key)) return 0;
    ctx.chain = newChain();
    fired += await dispatchAutomationEvent(ctx, {
      type: "period",
      boardId: rule.boardId,
      requestId: null,
      automationId: rule.id,
      dedupeKey: key,
      summary: every === "week" ? `weekly check (${key})` : `daily check (${key})`,
    });
    return fired;
  }

  const column = configString(config, "column");
  if (!column) return 0;
  const when = configString(config, "when") || "on";
  const days = configNumber(config, "days") ?? 0;
  const dates = await datesFor(ctx, rule.boardId, column);
  for (const [requestId, day] of dates) {
    if (fireDayFor(day, when, days) !== today) continue;
    const dedupeKey = `${requestId}:${day}`;
    if (await alreadyRan(ctx, rule.id, dedupeKey)) continue;
    const [item] = await ctx.db
      .select({ parentId: maintenanceRequests.parentId })
      .from(maintenanceRequests)
      .where(and(eq(maintenanceRequests.id, requestId), eq(maintenanceRequests.organisationId, ctx.orgId)))
      .limit(1);
    ctx.chain = newChain();
    fired += await dispatchAutomationEvent(ctx, {
      type: "date_arrived",
      boardId: rule.boardId,
      requestId,
      parentId: item?.parentId ?? null,
      automationId: rule.id,
      column,
      to: day,
      dedupeKey,
      summary: `${column} = ${day} (${when === "on" ? "today" : `${days} days ${when}`})`,
    });
  }
  return fired;
}

/** Whether a rule's trigger is one the sweep owns. */
export function isTimeBased(triggerType: string) {
  return triggerType === "date_arrives" || triggerType === "every_period";
}
