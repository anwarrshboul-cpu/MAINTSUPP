/**
 * The board's shareable address, and the small navigation helpers the board
 * actions use.
 *
 * Pure functions first — `boardLink` and `viewFromSearch` are the two halves
 * of "Copy link": one writes `?view=` onto the board's own path, the other
 * reads it back when the page opens. They take their inputs as arguments so
 * `tests/ui-batch-board-actions.test.mjs` can run them without a window.
 */

/**
 * The absolute URL for THIS board and THIS view.
 *
 * Built from the page's own path rather than from a route table: the path
 * the person is looking at is, by definition, the board-context URL — the
 * job board at `/dashboard/jobs`, Store Documentation at its own section
 * route, a workspace section at `/dashboard/s/<slug>`. Only `view` is kept
 * in the query; anything else in the address (a one-shot `?manage=` or a
 * stale `?next=`) is not part of "where the board is".
 */
export function boardLink(origin: string, pathname: string, viewKey: string | null | undefined): string {
  const url = new URL(pathname || "/", origin);
  url.search = "";
  if (viewKey) url.searchParams.set("view", viewKey);
  return url.toString();
}

/** The `view` a link asked for, or null. Trimmed and capped so it cannot be abused as a payload. */
export function viewFromSearch(search: string): string | null {
  try {
    const value = new URLSearchParams(search).get("view");
    const trimmed = value?.trim() ?? "";
    return trimmed && trimmed.length <= 80 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * A full navigation to a dashboard route.
 *
 * Deliberately a page load rather than `history.pushState`: the account area
 * (`/dashboard/account/trash`) is a separate Next route the portal's popstate
 * listener cannot draw, and that listener keys nested sections off their
 * first segment, so `/dashboard/admin/roles` would land on Users. A load
 * resolves every route the way a typed address does.
 */
export function navigateTo(path: string) {
  if (!path.startsWith("/")) return;
  window.location.assign(path);
}

/** The dashboard destinations the board's ⋯ menu offers. One place, so the tests can pin them. */
export const BOARD_ROUTES = {
  activityLog: "/dashboard/audit",
  permissions: "/dashboard/admin/roles",
  archive: "/dashboard/account/archive",
  trash: "/dashboard/account/trash",
  recycleBin: "/dashboard/recycle-bin",
  importItems: "/dashboard?manage=import",
} as const;
