/**
 * WHICH LAYOUT A PHONE OPENS A BOARD IN — and the migration hole that made the
 * owner's phone open Jobs on the cards after the default was changed to the
 * table.
 *
 * THE BUG, exactly. `live-board.tsx` used to read one key,
 * `maintsupp:board:<id>:mobile-layout`, and honour ANY stored value before
 * consulting the product default. That is the right shape only while the
 * default never moves. It moved: until commit bebf419 the Jobs board opened on
 * the CARDS, and the only writer this repo has ever had is the Cards/Table
 * switch in `board-mobile-list.tsx`. So a phone that tapped "Cards" under the
 * old build — where tapping Cards meant "yes, stay where I already am" — wrote
 * the string "cards", and that string then outlived the default it was chosen
 * against. Reproduced in a browser against the running build: clean storage
 * lands on Table; the same build with `…:mobile-layout = "cards"` seeded lands
 * on Cards. Nothing was wrong with the default. The stored value was an
 * agreement with a build that no longer exists.
 *
 * THE KEY RECORDED NOTHING ABOUT WHICH DEFAULT IT WAS CHOSEN AGAINST, so there
 * is no way to tell a deliberate override from a tap that agreed with the
 * default of the day. That is the hole, and it is a hole in the key, not in the
 * reader — which is why the fix is a new key rather than a cleverer read.
 *
 * THE FIX. Preferences are versioned from here on. Only `…:mobile-layout:v2`
 * is an explicit, post-fix choice, and only a v2 value overrides the default.
 * The unversioned key is not consulted at all — it cannot be interpreted, so
 * interpreting it is guessing — and it is DELETED on the first read that finds
 * it. Deleting rather than leaving it is deliberate: nothing in the repo reads
 * or writes it any more (`grep -rn "mobile-layout"` reaches this file alone),
 * so a value left behind is a trap for the next person who greps the key and
 * assumes it is live, and it would sit on the owner's phone for years saying
 * "cards" to nobody. The removal is idempotent, so React's double-invoked
 * initialiser is harmless, and it is in a try/catch of its own so a storage
 * that refuses writes — private browsing, a locked-down WebView — cannot take
 * the read down with it.
 *
 * The cost of the reset is one tap for anybody who really did want cards on
 * Jobs, taken once. The cost of the alternative was the owner's phone opening
 * on the wrong layout and no way for the product to ever change its mind about
 * a default again.
 *
 * It lives in its own file because `live-board.tsx` is held to 6,000 lines by
 * `stage-eight-board-split.test.mjs` and sits a few lines under the ceiling.
 */

export type MobileLayout = "cards" | "grid";

/**
 * The versioned key. `v2` is the generation that knows what it means: a value
 * here was written by a build whose Jobs default was already the table, so it
 * is a real override rather than agreement with a default that has since moved.
 * The next default that moves gets `v3` and the same one-line migration.
 */
export function mobileLayoutKey(boardId: string) {
  return `maintsupp:board:${boardId}:mobile-layout:v2`;
}

/** The key written by builds before this file existed. Read by nothing. */
function legacyMobileLayoutKey(boardId: string) {
  return `maintsupp:board:${boardId}:mobile-layout`;
}

/**
 * What a board opens in when nobody has chosen: the TABLE on Jobs (the owner's
 * ask — a coordinator wants the columns), cards everywhere else, which is what
 * Stage 23 gave a 390px screen and what Store Documentation must keep.
 */
export function defaultMobileLayout(boardId: string): MobileLayout {
  return boardId === "maintenance" ? "grid" : "cards";
}

/**
 * `window` is absent during the server render and `localStorage` throws rather
 * than returning null when a browser has storage switched off, so every access
 * in this file goes through one guarded helper.
 */
function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The layout to open `boardId` in, paired with the board it was resolved for.
 *
 * The pair is the shape `live-board.tsx` holds in state: it compares the board
 * id during render so a board change re-resolves before anything is painted,
 * rather than an effect flashing the default for a frame.
 */
export function readMobileLayout(boardId: string): {
  boardId: string;
  layout: MobileLayout;
} {
  const store = storage();
  if (!store) return { boardId, layout: defaultMobileLayout(boardId) };

  let stored: string | null = null;
  try {
    stored = store.getItem(mobileLayoutKey(boardId));
  } catch {
    // Storage disabled mid-session. The default is still a correct answer.
  }

  // Whatever the old key holds, it is retired here — see the note at the top.
  try {
    if (store.getItem(legacyMobileLayoutKey(boardId)) !== null) {
      store.removeItem(legacyMobileLayoutKey(boardId));
    }
  } catch {
    // A store that will not delete is one we simply never read again.
  }

  if (stored === "cards" || stored === "grid") return { boardId, layout: stored };
  return { boardId, layout: defaultMobileLayout(boardId) };
}

/**
 * Remember a layout the reader chose by tapping Cards or Table.
 *
 * Only this writes, and only ever to the versioned key: a preference recorded
 * against the current default is the one thing the reader is allowed to keep.
 */
export function writeMobileLayout(boardId: string, layout: MobileLayout) {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(mobileLayoutKey(boardId), layout);
  } catch {
    // A preference that cannot be saved is still a preference for now.
  }
}
