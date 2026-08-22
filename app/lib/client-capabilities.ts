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
 * on every page load. The promise is memoised the same way `raise-ticket.tsx`
 * already memoises its own access read, and a REJECTED promise is dropped
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

export type CapabilityMap = Record<string, boolean>;

let pending: Promise<CapabilityMap> | null = null;

async function read(): Promise<CapabilityMap> {
  const response = await fetch("/api/context", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("The workspace context could not be read.");
  const payload = (await response.json()) as {
    context?: { capabilities?: CapabilityMap };
  };
  return payload.context?.capabilities ?? {};
}

/** The memoised read. Callers that only need the answer once can await this. */
export function fetchCapabilities(): Promise<CapabilityMap> {
  if (!pending) {
    pending = read().catch((error) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

/**
 * Forget the cached answer.
 *
 * Called after a client switch, because capabilities are per workspace and the
 * previous workspace's answer is not merely stale, it is about somewhere else.
 */
export function forgetCapabilities() {
  pending = null;
}

/**
 * `true`, `false`, or `null` while the answer is still in flight.
 *
 * Deliberately three-valued — see the header. A control that must not flicker
 * should render as enabled while `null` and let the server refuse; a control
 * whose absence is safer should render hidden.
 */
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
