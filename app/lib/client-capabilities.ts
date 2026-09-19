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
 * Whether this person is MAINTSUPP platform staff — `identity.platformAdmin`.
 *
 * WHY THIS IS NOT A CAPABILITY, AND SO NOT `useCapability`
 *
 * `can()` returns true for `super_admin` before it reads anything at all, so no
 * capability distinguishes the platform's own staff from a client company's most
 * senior role. `platformAdmin` comes from the `platform_admins` table by way of
 * `resolveTenantAccess`, which reads it from the database and never from the
 * request. It is the same value as `crossOrganisation`, and it is what makes a
 * Platform Super Admin's membership list every active organisation.
 *
 * `null` while it loads, read as "not answered" — and every caller must treat that
 * as "do not offer". Showing a door to the platform console and taking it away a
 * moment later is worse than showing it a moment late.
 *
 * THIS IS NOT THE ENFORCEMENT. `requirePlatformAdmin` in `app/lib/platform-guard.ts`
 * is, on the server, at every `/admin` route entry. Reading the same answer here is
 * only what stops the two disagreeing, so nobody is offered a console that will
 * turn them away.
 */
export function usePlatformAdmin(): boolean | null {
  const [platformAdmin, setPlatformAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchRuntimeContext()
      .then((context) => {
        if (cancelled) return;
        const identity = context.identity as { platformAdmin?: boolean } | undefined;
        /* A payload from before this field existed leaves it unanswered rather
           than answering "no", which is the same rule `capabilities` follows. */
        if (!identity || typeof identity.platformAdmin !== "boolean") return;
        setPlatformAdmin(identity.platformAdmin);
      })
      .catch(() => {
        // Unanswered. The server still decides.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return platformAdmin;
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
