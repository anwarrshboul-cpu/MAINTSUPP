/**
 * The tab strip's write path, and the one place that decides WHICH BOARD a
 * view write is about.
 *
 * WHY THIS IS ITS OWN FILE. It came out of `board-chrome.tsx`, which is held to
 * 500 lines — the same reason `board-view-pane.tsx`, `board-tab-glyph.tsx` and
 * `board-actions/view-menus.tsx` are their own files. But it is not an
 * arbitrary slice taken to make room: adding, renaming, reordering and binning
 * a view are the four operations that have to agree with each other about the
 * board, and until this existed that agreement was spread across a component's
 * closure and a route's argument defaults, where it was wrong for months
 * without anything failing.
 *
 * THE BUG THIS ENCODES THE FIX FOR. `POST /api/board/views` read the board from
 * the JSON BODY while `GET` read it from `?board=`. The chrome has always put
 * it in the query string, so `body.board` was absent on every create, the
 * route's `resolveBoard` default took over, and a view added from a custom
 * section's register was written to the CANONICAL JOB BOARD. Proven on the
 * running server: a Calendar added on board `sec-f47167fe0157` appeared as a
 * twelfth tab on `maintenance` while the section's own strip still showed one.
 *
 * The route now reads the query string on all four verbs, and this is the
 * client half of that contract: every view write goes through here, so there is
 * no second place to forget the board.
 */

/** What the strip does with a write that failed: show the server's sentence. */
export type BoardViewWrite =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * One view write, scoped to `boardId`.
 *
 * `query` carries whatever the verb needs in the URL itself — DELETE addresses
 * the view by `?id=`. The board is appended rather than merged into the body
 * because the query string is what the route reads first, and a caller that
 * cannot see this function should still be able to tell from a network log
 * which board a write was aimed at.
 */
export async function writeBoardView(
  boardId: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
  query = "",
): Promise<BoardViewWrite> {
  const scoped = `${query ? `${query}&` : "?"}board=${encodeURIComponent(boardId)}`;
  const response = await fetch(`/api/board/views${scoped}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return { ok: false, error: String(payload.error ?? "That did not work.") };
  }
  return { ok: true, payload };
}
