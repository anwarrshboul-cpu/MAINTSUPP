"use client";

/**
 * `GET /api/navigation`, read once per page load and shared.
 *
 * TWO CALLERS ASKED THE SAME QUESTION TWICE. `portal-app.tsx` fetched it for
 * `sections` — the workspace's own sidebar entries — and `sidebar-nav.tsx`
 * fetched it for `arrangement`, `locked` and the three permission flags. One
 * response already carries all of that; the route's own comment says the
 * sections are returned "rather than left to a second request". There were two
 * requests anyway, because neither caller knew about the other. Measured cold
 * on 18 Sept 2026: 1,278ms and 1,178ms, for the same bytes.
 *
 * THE `?sections=` PARAMETER WAS THE REASON THEY LOOKED DIFFERENT, AND IT IS
 * NOT ONE. It feeds `requestCatalogue`, which affects exactly one field of the
 * response — `layout`, the pre-merged sidebar. Neither browser caller reads
 * `layout`; `sidebar-nav.tsx` does not even declare it on its response type,
 * because it re-resolves the arrangement against its own live catalogue. So
 * the two requests differed in a field nobody consumed, and one plain request
 * serves both. A caller that ever does want `layout` should fetch it
 * deliberately rather than quietly re-introduce the duplicate.
 *
 * `force` IS FOR WRITES, NOT FOR PAINTS. Saving an arrangement, deleting one,
 * or adding a workspace section makes the cached answer wrong rather than
 * stale, so those paths pass it. First paint never does.
 */

export type NavigationPayload = {
  arrangement?: { workspace?: unknown; user?: unknown };
  locked?: unknown;
  canEditDefault?: boolean;
  canEditOwn?: boolean;
  canCustomise?: boolean;
  sections?: unknown[];
};

let pending: Promise<NavigationPayload> | null = null;

async function read(): Promise<NavigationPayload> {
  const response = await fetch("/api/navigation", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("The navigation layout could not be loaded.");
  return (await response.json()) as NavigationPayload;
}

/** The memoised read. Every caller on a page shares one round trip. */
export function fetchNavigation(options?: { force?: boolean }): Promise<NavigationPayload> {
  if (options?.force) pending = null;
  if (!pending) {
    pending = read().catch((error: unknown) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

/** Forget the cached answer — see `force` in the header. */
export function forgetNavigation() {
  pending = null;
}
