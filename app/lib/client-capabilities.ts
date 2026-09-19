"use client";

/**
 * What the signed-in person may do, read once and shared by every control.
 *
 * `/api/context` now returns `capabilities` — the workspace's overrides merged
 * with the built-in defaults, computed by the same `can()` every route enforces
 * with. This is the browser's cache of that answer.
 *
 * ONE FETCH, NOT ONE PER BUTTON. The board draws four export controls, the
 * ticket dialog asks about `board.edit`, and a column menu asks again per
 * column; each mounting its own request would be a dozen identical round trips
 * on every page load.
 *
 * THAT MEMO NOW LIVES IN `app/lib/runtime-context.ts`, one level up. It used to
 * live here, which was correct as far as it went and still fetched
 * `/api/context` a second time on every dashboard load, because `portal-app`
 * memoised the same endpoint separately for the rest of the payload. Sharing
 * one promise is what removes the duplicate; a rejected read is still dropped
 * rather than cached, so one transient failure does not permanently disable
 * every control on the page.
 *
 * THIS IS NOT THE ENFORCEMENT. Hiding a control is a courtesy; the rule lives
 * on the server, on the request that does the thing — `POST /api/board/csv`
 * holds `data.export`, `/api/board` holds `board.edit`, `/api/audit` holds
 * `audit.read`. Reading the same answer here is what stops the two disagreeing,
 * so a person is never shown a button that will refuse them.
 *
 * UNKNOWN, NOT FALSE, WHILE IT LOADS. `null` from `useCapability` means "not
 * answered yet", and a caller decides what to draw in the meantime. Treating an
 * unanswered question as a denial would flash every control off on each page
 * load, which reads as a permissions bug.
 */

import { useEffect, useState } from "react";
import { governingModule } from "./portal-modules.ts";
import { fetchRuntimeContext, forgetRuntimeContext } from "./runtime-context";

export type CapabilityMap = Record<string, boolean>;

/** The memoised read. Callers that only need the answer once can await this. */
export function fetchCapabilities(): Promise<CapabilityMap> {
  return fetchRuntimeContext().then(
    (context) => (context.capabilities as CapabilityMap | undefined) ?? {},
  );
}

/**
 * Forget the cached answer.
 *
 * Called after a client switch, because capabilities are per workspace and the
 * previous workspace's answer is not merely stale, it is about somewhere else.
 */
export function forgetCapabilities() {
  forgetRuntimeContext();
}

/**
 * `true`, `false`, or `null` while the answer is still in flight.
 *
 * Deliberately three-valued — see the header. A control that must not flicker
 * should render as enabled while `null` and let the server refuse; a control
 * whose absence is safer should render hidden.
 */
/**
 * Whether a section key's module is switched on for this workspace AND reachable
 * by this person — Master Specification §19, from the one answer the server
 * resolved.
 *
 * WHY THIS EXISTS BESIDE `useCapability` RATHER THAN INSIDE IT
 *
 * A capability is about the person; a module is about the workspace. Both happen
 * to arrive in the same payload, and a control that needs the second would
 * otherwise have to ask for `modules` itself — and
 * `tests/shared-context-and-navigation-reads.test.mjs` forbids a second direct
 * read of `/api/context` for exactly the reason that test was written: two
 * readers of one endpoint fetched it twice on every dashboard load.
 *
 * `null` WHILE IT LOADS, and every caller must read it as "not answered". The
 * sidebar has the same rule for the same reason: treating an unanswered question
 * as "switched off" would empty the navigation on every page load, which reads as
 * the product having lost half of itself.
 *
 * `governingModule` follows the aliases, so a second door answers for the room it
 * opens — `units` for Assets, and the account `trash` panel for the Recycle Bin.
 */
export function useModuleAvailable(sectionKey: string): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchRuntimeContext()
      .then((context) => {
        if (cancelled) return;
        const listed = context.modules;
        /* Not answered — an older payload, or a read that has not landed. The
           caller decides, and every caller today keeps the control visible. */
        if (!Array.isArray(listed)) return;
        const governing = governingModule(sectionKey);
        setAvailable(!governing || listed.includes(governing));
      })
      .catch(() => {
        // Leave it unanswered, exactly as `useCapability` does.
      });
    return () => {
      cancelled = true;
    };
  }, [sectionKey]);
  return available;
}

export function useCapability(capability: string): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchCapabilities()
      .then((capabilities) => {
        if (!cancelled) setAllowed(capabilities[capability] === true);
      })
      .catch(() => {
        // Leave it unanswered. The server still decides, and a failed context
        // read is not evidence that this person may not do the thing.
      });
    return () => {
      cancelled = true;
    };
  }, [capability]);
  return allowed;
}
