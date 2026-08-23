/**
 * The engine: an event comes in, the rules that match it run, and every one
 * of them — run, failed or skipped — is written down.
 *
 * THREE PROMISES THIS MODULE KEEPS
 *
 * 1. IT NEVER THROWS. `dispatchAutomationEvent` is called after a route's own
 *    write has succeeded, and a rule that fails must not turn that success
 *    into a 503. Every failure is caught, recorded as a failed run, audited,
 *    and swallowed. One rule failing does not stop the next.
 *
 * 2. IT CANNOT LOOP. A rule that changes a status raises a status event; a
 *    second rule on that event may change it back. Three guards, all in
 *    `guard()`: nested events stop at `MAX_DEPTH`, a rule fires at most once
 *    per item per originating request, and a chain fires at most
 *    `MAX_RUNS_PER_CHAIN` rules in total. Each refusal is a `skipped` row
 *    with the reason, so the history explains why a rule did not run.
 *
 * 3. IT STAYS INSIDE ONE WORKSPACE AND ONE BOARD. Rules are read by
 *    `(organisation_id, board_id)` and every action writes through helpers
 *    that filter on the organisation. The event names a board; nothing in
 *    the event can name a workspace.
 */

import { and, eq, sql } from "drizzle-orm";
import { automationRuns, boardAutomations } from "../../../db/schema";
import { recordAudit } from "../audit";
import { executeAction } from "./actions";
import {
  MAX_DEPTH,
  MAX_RUNS_PER_CHAIN,
  configString,
  parseConfig,
  type ActionResult,
  type AutomationContext,
  type AutomationEvent,
  type AutomationRule,
  type ChainState,
} from "./types";

export function newChain(): ChainState {
  return {
    id: `chain_${crypto.randomUUID().replace(/-/g, "")}`,
    runs: 0,
    seen: new Set(),
    rules: new Map(),
  };
}

async function enabledRules(ctx: AutomationContext, boardId: string): Promise<AutomationRule[]> {
  const chain = ctx.chain!;
  const cached = chain.rules.get(boardId);
  if (cached) return cached;
  const rows = await ctx.db
    .select()
    .from(boardAutomations)
    .where(
      and(
        eq(boardAutomations.organisationId, ctx.orgId),
        eq(boardAutomations.boardId, boardId),
        eq(boardAutomations.enabled, "on"),
      ),
    );
  chain.rules.set(boardId, rows);
  return rows;
}

/** Whether a rule's trigger is satisfied by an event. Pure, and tested as such. */
export function ruleMatches(rule: Pick<AutomationRule, "id" | "triggerType" | "triggerConfig">, event: AutomationEvent): boolean {
  const config = parseConfig(rule.triggerConfig);
  const column = configString(config, "column");
  switch (rule.triggerType) {
    case "status_changes": {
      if (event.type !== "column_changed") return false;
      if (event.column !== (column || "status")) return false;
      if (event.columnType && !["status", "dropdown"].includes(event.columnType)) return false;
      if ((event.from ?? "") === (event.to ?? "")) return false;
      const from = configString(config, "from");
      const to = configString(config, "to");
      if (from && (event.from ?? "") !== from) return false;
      if (to && (event.to ?? "") !== to) return false;
      return true;
    }
    case "column_changes":
      return event.type === "column_changed" && !!column && event.column === column;
    case "person_assigned": {
      if (event.type !== "column_changed") return false;
      if (event.column !== (column || "assignee")) return false;
      if (!event.to) return false;
      const person = configString(config, "person");
      return !person || event.to === person || event.to.split(",").map((v) => v.trim()).includes(person);
    }
    case "name_changes":
      return event.type === "column_changed" && event.column === "name";
    case "item_created":
      return event.type === "item_created" && !event.parentId;
    case "subitem_created":
      return event.type === "item_created" && !!event.parentId;
    case "subitem_column_changes":
      return (
        event.type === "column_changed" && !!event.parentId && (!column || event.column === column)
      );
    case "item_moved_to_group": {
      if (event.type !== "item_moved") return false;
      const groupId = configString(config, "groupId");
      return !groupId || event.groupId === groupId;
    }
    case "update_created":
      return event.type === "update_created";
    case "date_arrives":
      return event.type === "date_arrived" && event.automationId === rule.id;
    case "every_period":
      return event.type === "period" && event.automationId === rule.id;
    default:
      return false;
  }
}

/** The loop guard. Returns the reason to skip, or null to proceed. */
export function guard(
  chain: Pick<ChainState, "runs" | "seen">,
  ruleId: string,
  requestId: string | null,
  depth: number,
): string | null {
  if (depth >= MAX_DEPTH) {
    return `Stopped: this change was itself caused by automations ${depth} deep (limit ${MAX_DEPTH}).`;
  }
  if (chain.runs >= MAX_RUNS_PER_CHAIN) {
    return `Stopped: ${MAX_RUNS_PER_CHAIN} automations already ran for this change.`;
  }
  const key = `${ruleId}:${requestId ?? "-"}`;
  if (chain.seen.has(key)) {
    return "Stopped: this automation already ran for this item during this change.";
  }
  return null;
}

async function recordRun(
  ctx: AutomationContext,
  rule: AutomationRule,
  event: AutomationEvent,
  depth: number,
  status: "success" | "failed" | "skipped",
  actionSummary: string | null,
  error: string | null,
) {
  const now = new Date().toISOString();
  try {
    await ctx.db.insert(automationRuns).values({
      id: `run_${crypto.randomUUID().replace(/-/g, "")}`,
      organisationId: ctx.orgId,
      automationId: rule.id,
      boardId: rule.boardId,
      requestId: event.requestId ?? null,
      status,
      triggerSummary: (event.summary ?? event.type).slice(0, 400),
      actionSummary: actionSummary?.slice(0, 400) ?? null,
      error: error?.slice(0, 800) ?? null,
      depth,
      chainId: ctx.chain?.id ?? null,
      dedupeKey: event.dedupeKey ?? null,
      actorEmail: ctx.actor.email ?? null,
      createdAt: now,
    });
    if (status !== "skipped") {
      await ctx.db
        .update(boardAutomations)
        .set({
          runCount: sql`${boardAutomations.runCount} + 1`,
          lastRunAt: now,
        })
        .where(
          and(eq(boardAutomations.id, rule.id), eq(boardAutomations.organisationId, ctx.orgId)),
        );
    }
  } catch (cause) {
    console.error("[automations] could not record a run", { rule: rule.id, status, cause });
  }
  await recordAudit({
    db: ctx.db,
    organisationId: ctx.orgId,
    actor: { userId: ctx.actor.userId ?? null, email: ctx.actor.email, role: ctx.actor.role ?? null },
    action: `automation.${status === "success" ? "ran" : status}`,
    entityType: "board_automation",
    entityId: rule.id,
    summary:
      status === "success"
        ? `Automation "${rule.name}" ran${event.requestId ? ` on ${event.requestId}` : ""}: ${actionSummary ?? ""}`.trim()
        : status === "failed"
          ? `Automation "${rule.name}" failed${event.requestId ? ` on ${event.requestId}` : ""}: ${error ?? ""}`
          : `Automation "${rule.name}" skipped${event.requestId ? ` on ${event.requestId}` : ""}: ${error ?? ""}`,
    detail: {
      board: rule.boardId,
      trigger: event.summary ?? event.type,
      depth,
      chainId: ctx.chain?.id ?? null,
      requestId: event.requestId ?? null,
    },
    request: ctx.request ?? null,
  });
}

/**
 * Runs every enabled rule on the event's board that the event satisfies.
 *
 * Resolves to the number of rules that actually ran. Never rejects.
 */
export async function dispatchAutomationEvent(
  ctx: AutomationContext,
  event: AutomationEvent,
  depth = 0,
): Promise<number> {
  let ran = 0;
  try {
    if (!ctx.chain) ctx.chain = newChain();
    const chain = ctx.chain;
    const rules = await enabledRules(ctx, event.boardId);
    for (const rule of rules) {
      let matched = false;
      try {
        matched = ruleMatches(rule, event);
      } catch {
        matched = false;
      }
      if (!matched) continue;

      const refusal = guard(chain, rule.id, event.requestId ?? null, depth);
      if (refusal) {
        await recordRun(ctx, rule, event, depth, "skipped", null, refusal);
        continue;
      }
      chain.seen.add(`${rule.id}:${event.requestId ?? "-"}`);
      chain.runs += 1;

      let result: ActionResult;
      try {
        result = await executeAction(ctx, rule, event);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "The action failed.";
        await recordRun(ctx, rule, event, depth, "failed", null, message);
        continue;
      }
      if (result.skipped) {
        await recordRun(ctx, rule, event, depth, "skipped", result.summary || null, result.skipped);
        continue;
      }
      ran += 1;
      await recordRun(
        ctx,
        rule,
        event,
        depth,
        "success",
        result.noop ? `${result.summary} (no change needed)` : result.summary,
        null,
      );
      for (const next of result.events ?? []) {
        ran += await dispatchAutomationEvent(ctx, next, depth + 1);
      }
    }
  } catch (cause) {
    // The originating write has already succeeded. Nothing here may undo that.
    console.error("[automations] dispatch failed", { event: event.type, cause });
  }
  return ran;
}

/** Dispatches several events from one write, sharing one chain. */
export async function dispatchAutomationEvents(
  ctx: AutomationContext,
  events: AutomationEvent[],
  depth = 0,
): Promise<number> {
  let ran = 0;
  for (const event of events) ran += await dispatchAutomationEvent(ctx, event, depth);
  return ran;
}
