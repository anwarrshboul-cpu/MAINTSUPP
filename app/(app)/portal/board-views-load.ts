import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { BoardSummary, BoardView, ViewType } from "./board-view-types";

/**
 * The tab strip's READ path, and the one place that decides what a board says
 * when it cannot draw its tabs.
 *
 * WHY THIS IS ITS OWN FILE. It came out of `board-chrome.tsx`, which is held to
 * 500 lines, for the same reason `board-view-writes.ts` did — and it is the
 * matching half of that file. Between them they are the strip's two
 * conversations with `/api/board/views`: one asks, one changes. Both have to
 * agree about which board they are addressing and about how a refusal is
 * reported, and neither agreement survives being spread through a component's
 * closure.
 *
 * THE FAULT THIS ENCODES THE FIX FOR. This read `if (!response.ok) throw new
 * Error("Views could not be loaded.")`, threw the route's own answer away, and
 * showed that constant for every failure. On the live deployment the failure
 * behind it was the Supabase session pooler running out of clients, which is
 * momentary and worth retrying; the same sentence was also shown for a board
 * the organisation does not have, which is neither. An operator was given one
 * message for three unrelated conditions, none of which it named, and no way
 * to tell which one they were looking at. See `busyRefusal` in
 * `app/lib/tenant-db.ts` for the server half.
 */

/**
 * What went wrong, and whether doing it again could help.
 *
 * `retryable` is the SERVER'S `retry` flag rather than an inference from the
 * status code, because a 503 covers both "out of database connections, try
 * again" and "something threw and nobody knows what". Only the route can tell
 * those apart, and a Retry button on the second is a control that cannot work.
 */
export type BoardViewsError = { message: string; retryable: boolean };

export type BoardViewsState = {
  board: BoardSummary | null;
  views: BoardView[];
  types: ViewType[];
  /**
   * THE THIRD STATE, AND THE ONLY ONE THAT WAS NOT READABLE.
   *
   * A strip still loading and a board that legitimately has no tabs both draw
   * nothing, so the two were indistinguishable — which is half of why an
   * error here has been ambiguous for so long. Empty deliberately stays
   * silent rather than becoming a "no views yet" panel: the built-in Store
   * Documentation board holds no `board_views` rows on purpose and declares
   * its three tabs elsewhere, so a panel inviting somebody to create one
   * would be wrong exactly where it appeared.
   */
  loading: boolean;
  error: BoardViewsError | null;
  setError: Dispatch<SetStateAction<BoardViewsError | null>>;
  /** Re-ask. Used by Retry, and by every write that changed the strip. */
  refresh: () => void;
};

/**
 * Loads the tab strip for `boardId`, and seeds the active tab from what came
 * back.
 *
 * `setActiveKey` is passed in rather than owned here because the active tab is
 * written from four places — this load, creating a view, binning one, and the
 * remembered landing view — and only one of them is this hook.
 */
export function useBoardViews(
  boardId: string,
  setActiveKey: Dispatch<SetStateAction<string>>,
): BoardViewsState {
  const [board, setBoard] = useState<BoardSummary | null>(null);
  const [views, setViews] = useState<BoardView[]>([]);
  const [types, setTypes] = useState<ViewType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<BoardViewsError | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  useEffect(() => {
    /*
     * ASK THE ENDPOINT ABOUT ANY BOARD THAT HAS ONE.
     *
     * This read `boardId !== "maintenance"` and then `boardId !==
     * "store-documentation"`, and both spellings were the same mistake: which
     * boards have a tab strip decided by NAME. The first left a section's own
     * register with no tabs at all (W02-06); the second is the pattern
     * requirement C exists to remove, and it would have hidden the strip on a
     * Store-Documentation-template INSTANCE too, which does have views of its
     * own.
     *
     * The board answers for itself now: the built-in Store Documentation board
     * holds no `board_views` rows — it declares its three tabs in
     * `views/store-documentation-board.tsx` and would show two strips if this
     * drew a second — so the fetch returns `views: []` and the nav simply has
     * nothing to render. Same outcome on that board, by a property of the
     * board rather than by its key.
     *
     * An EMPTY board id is still refused here rather than sent: it is a section
     * with no register of its own, and `?board=` with nothing after it is what
     * the route 404s. Nothing is gained by making the round trip.
     */
    if (!boardId) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/board/views?board=${encodeURIComponent(boardId)}`);
        const payload = (await response.json().catch(() => ({}))) as {
          board: BoardSummary;
          views: BoardView[];
          types: ViewType[];
          error?: string;
          retry?: boolean;
        };
        if (cancelled) return;
        /*
         * THE SERVER'S REASON, NOT A CONSTANT. A full connection pool, a board
         * this organisation does not have and an ended session all arrive
         * here, and the sentence this used to show names none of them — nor
         * which of them the person reading it could do anything about.
         */
        if (!response.ok) {
          setError({
            message: payload.error ?? "Views could not be loaded.",
            retryable: payload.retry === true,
          });
          return;
        }
        setBoard(payload.board);
        setViews(payload.views);
        setTypes(payload.types);
        setActiveKey((current) => {
          if (current && payload.views.some((view) => view.key === current)) return current;
          const fallback = payload.views.find((view) => view.isDefault) ?? payload.views[0];
          return fallback?.key ?? "";
        });
        setError(null);
      } catch (cause) {
        // Nothing answered at all. A dropped connection is always worth one
        // more try, which is exactly what a refused board key is not.
        if (!cancelled) {
          setError({
            message: cause instanceof Error ? cause.message : "Something went wrong.",
            retryable: true,
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `boardId` gates the fetch above, so a board change must re-run it.
  }, [boardId, refreshToken, setActiveKey]);

  return { board, views, types, loading, error, setError, refresh };
}
