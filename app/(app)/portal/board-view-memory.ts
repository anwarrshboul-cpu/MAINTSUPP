/**
 * Which view a section opens on, and remembering the one you left.
 *
 * monday lands you on a board's default view until you have used the board,
 * and on the tab you were last on after that. `board_views.is_default` already
 * covered the first half; nothing covered the second — no table, no endpoint,
 * not even a localStorage key.
 *
 * The resolution order lives on the server, in `/api/workspace-sections/view`:
 * your remembered view, then the section's workspace default, then
 * `board_views.is_default`, then the first tab. Each layer is skipped when the
 * view it names no longer exists, so deleting a view lands everybody on the
 * default rather than on a missing tab. This module is the browser's half —
 * two calls and the rules about when they may fire.
 *
 * Keyed by SECTION, not by board. Two sections can read the same board, and
 * landing somewhere different is the entire reason for adding the second one.
 *
 * It lives in its own file because `board-chrome.tsx` is held to 500 lines by
 * `stage-eight-board-split.test.mjs`, and a preference that talks to the
 * network is exactly the kind of thing that belongs outside the component.
 */

/** Where a landing view came from, so the two can be told apart. */
export type ViewMemorySource = "user" | "workspace" | "board" | "first";

/**
 * The view this section should open on, or null to leave the board's own
 * choice alone.
 *
 * Answers null on every failure. The board has already applied its default by
 * the time this resolves, so there is nothing to undo and nothing to report —
 * a preference that cannot be read is not an error the reader can act on.
 */
export async function fetchLandingView(
  section: string,
): Promise<{ view: string; source: ViewMemorySource } | null> {
  try {
    const response = await fetch(
      `/api/workspace-sections/view?section=${encodeURIComponent(section)}`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      view?: string | null;
      source?: ViewMemorySource;
    };
    if (!payload.view) return null;
    return { view: payload.view, source: payload.source ?? "first" };
  } catch {
    return null;
  }
}

/**
 * Records the tab somebody moved to.
 *
 * Fire and forget, deliberately: it is a preference, it grants nothing, and a
 * failed write must never make a tab click feel broken. `scope: "workspace"`
 * is the owner setting where everyone lands; without it the memory is the
 * caller's own and needs nothing beyond membership.
 */
export function rememberLandingView(
  section: string,
  view: string,
  scope?: "workspace",
) {
  void fetch("/api/workspace-sections/view", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(scope ? { section, view, scope } : { section, view }),
  }).catch(() => undefined);
}
