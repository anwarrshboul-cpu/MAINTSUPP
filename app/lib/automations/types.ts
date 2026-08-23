/**
 * The shapes the automation engine passes around.
 *
 * An EVENT is something that just happened to the board, raised by the route
 * that did it after its own write succeeded. The engine matches events to
 * rules; a rule never sees the HTTP request, only the event.
 */

import type { getDb } from "../../../db";
import type { boardAutomations } from "../../../db/schema";

export type Database = Awaited<ReturnType<typeof getDb>>;

export type AutomationEventType =
  /** A column's value changed — system field or custom cell. `column` is the board key or column id. */
  | "column_changed"
  /** A new item, or a subitem when `parentId` is set. */
  | "item_created"
  /** The item changed group. */
  | "item_moved"
  /** An update was posted on the item. */
  | "update_created"
  /** Raised by the sweep for one date rule and one item. */
  | "date_arrived"
  /** Raised by the sweep for one recurring rule. */
  | "period";

export type AutomationEvent = {
  type: AutomationEventType;
  boardId: string;
  requestId: string | null;
  /** Set when the item is a subitem; drives the subitem triggers. */
  parentId?: string | null;
  /** Board column key (system) or column id (custom). */
  column?: string;
  /** The column's board type, so status triggers only match status-type columns. */
  columnType?: string;
  from?: string | null;
  to?: string | null;
  groupId?: string | null;
  /** Time-based events are addressed to one rule. */
  automationId?: string;
  /** Keeps a sweep from firing the same rule twice for the same day. */
  dedupeKey?: string;
  /** One line for the run history. */
  summary?: string;
};

export type AutomationActor = {
  email: string | null;
  displayName: string | null;
  role?: string | null;
  userId?: string | null;
};

export type AutomationRule = typeof boardAutomations.$inferSelect;

/**
 * The loop guard's memory for one originating request.
 *
 * Created at depth 0 and threaded through every nested dispatch. `seen`
 * holds `${ruleId}:${requestId}` so a rule that already fired for an item in
 * this chain cannot fire for it again; `runs` is the hard cap.
 */
export type ChainState = {
  id: string;
  runs: number;
  seen: Set<string>;
  /** Rules per board, loaded once per chain. */
  rules: Map<string, AutomationRule[]>;
};

export type AutomationContext = {
  db: Database;
  orgId: string;
  actor: AutomationActor;
  request?: Request | null;
  chain?: ChainState;
};

export type ActionResult = {
  summary: string;
  /** The value was already what the action would have set. Recorded as success. */
  noop?: boolean;
  /** Recorded as skipped with this reason — the action could not apply here. */
  skipped?: string;
  /** Follow-up events. The engine dispatches them at depth + 1. */
  events?: AutomationEvent[];
};

export const MAX_DEPTH = 3;
export const MAX_RUNS_PER_CHAIN = 20;
export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export function parseConfig(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function configString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

export function configNumber(config: Record<string, unknown>, key: string): number | null {
  const value = config[key];
  const number = typeof value === "number" ? value : Number(typeof value === "string" ? value : NaN);
  return Number.isFinite(number) ? number : null;
}
