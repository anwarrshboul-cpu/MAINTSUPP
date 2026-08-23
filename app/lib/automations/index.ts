/**
 * Board automations — the public surface.
 *
 * Routes that write to the board import `automationContext` and
 * `dispatchAutomationEvents` from here, after their own write has succeeded;
 * the event builders in `events.ts` turn a before/after pair into the events
 * a rule can match. Everything else is the engine's own business.
 */

export { dispatchAutomationEvent, dispatchAutomationEvents, ruleMatches, guard, newChain } from "./engine";
export { sweepTimeBasedRules, isTimeBased } from "./sweep";
export {
  cellChangedEvent,
  itemCreatedEvent,
  itemMovedEvent,
  requestFieldEvents,
  updateCreatedEvent,
} from "./events";
export type { AutomationContext, AutomationEvent, AutomationActor } from "./types";

import type { ScopedDatabase } from "../tenant-db";
import type { AutomationContext } from "./types";

/**
 * The engine's view of a route's scope.
 *
 * `identityEmail` is preferred over `actor.email` for the same reason the
 * audit trail prefers it: it is the identity the request was answered as,
 * and a run recorded against a demo identity should say so.
 */
export function automationContext(
  scope: Pick<ScopedDatabase, "db" | "orgId" | "actor"> &
    Partial<Pick<ScopedDatabase, "identityEmail" | "session">>,
  request?: Request | null,
): AutomationContext {
  return {
    db: scope.db,
    orgId: scope.orgId,
    actor: {
      email: scope.identityEmail || scope.actor.email || null,
      displayName: scope.actor.displayName || null,
      role: scope.actor.role,
      userId: scope.session?.user.id ?? null,
    },
    request: request ?? null,
  };
}
