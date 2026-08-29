/**
 * WHICH LAYOUT A PHONE OPENS A BOARD IN — and why the answer no longer comes
 * out of storage at all.
 *
 * THE FIRST BUG, kept here because it is half the argument for the second fix.
 *
 * `live-board.tsx` used to read one key, `maintsupp:board:<id>:mobile-layout`,
 * and honour ANY stored value before consulting the product default. That is
 * the right shape only while the default never moves. It moved: until commit
 * bebf419 the Jobs board opened on the CARDS, and the only writer this repo has
 * ever had is the Cards/Table switch in `board-mobile-list.tsx`. So a phone
 * that tapped "Cards" under the old build — where tapping Cards meant "yes,
 * stay where I already am" — wrote the string "cards", and that string then
 * outlived the default it was chosen against. THE KEY RECORDED NOTHING ABOUT
 * WHICH DEFAULT IT WAS CHOSEN AGAINST, so there was no way to tell a deliberate
 * override from a tap that agreed with the default of the day. The answer at
 * the time was to version the key: only `…:mobile-layout:v2` was an explicit,
 * post-fix choice, and only a v2 value overrode the default.
 *
 * WHAT CHANGED AGAIN, and why versioning was not enough.
 *
 * The owner's requirement, stated repeatedly and taken literally: on a PHONE,
 * entering a board shows the TABLE. Every time. A first visit, a trip to
 * Overview and back, a reload, a browser closed overnight and reopened, a
 * brand-new profile with nothing stored, and on EVERY board — Store
 * Documentation included, which the per-board default used to exclude.
 *
 * Tapping "Cards" still works, and still lasts exactly as long as the reader
 * stays in the section. What it must not do is survive the next entry. Once
 * that is the rule, a stored preference has nothing left to express: the only
 * value it could hold is one the next read is required to ignore. So the
 * preference stops being PERSISTED rather than being persisted and then
 * overruled. A key that nothing may honour is a key that lies to the next
 * person who greps it — which is precisely the trap the unversioned key set —
 * and a `:v3` would be worse than nothing, because a version number promises a
 * generation of stored choices that this build never writes.
 *
 * The choice therefore lives in `live-board.tsx`'s component state and nowhere
 * else. That is not a shortcut; it is the mechanism. A remount IS a fresh
 * entry, so "navigate away and back", "switch board", "reload" and "reopen the
 * browser" all reset to the table without any of them being special-cased, and
 * without a single storage read that could disagree with the others.
 *
 * BOTH OLD KEYS ARE RETIRED — the unversioned one and `:v2` — and deleted on
 * the first read that finds them. Deleting rather than leaving them is the same
 * decision taken for the same reason as last time: nothing in the repo reads or
 * writes either (`grep -rn "mobile-layout"` reaches this file alone), so a
 * value left behind would sit on the owner's phone for years saying "cards" to
 * nobody. The removal is idempotent, so React's double-invoked initialiser is
 * harmless, and it is inside its own try/catch so a storage that refuses writes
 * — private browsing, a locked-down WebView — cannot take the read down with
 * it.
 *
 * DESKTOP IS UNTOUCHED, and cannot be touched from here. `live-board.tsx` gates
 * the Cards/Table switch AND the cards themselves behind `isMobile`
 * (`matchMedia("(max-width: 760px)")`), and the grid's `hidden` attribute is
 * `(isMobile && mobileLayout === "cards") || gridReplaced`. Above 760px this
 * value is never read by anything: desktop showed the table before this change
 * and shows the table after it, with no switch to change it.
 *
 * It lives in its own file because `live-board.tsx` is held to 6,000 lines by
 * `stage-eight-board-split.test.mjs` and sits a few lines under the ceiling.
 */

export type MobileLayout = "cards" | "grid";

/** The key written by builds before this file existed. Read by nothing. */
function legacyMobileLayoutKey(boardId: string) {
  return `maintsupp:board:${boardId}:mobile-layout`;
}

/**
 * The versioned key this file used to read and write. Also read by nothing now
 * — see the header: a stored layout cannot survive an entry, so there is
 * nothing left for it to say.
 */
function retiredMobileLayoutKey(boardId: string) {
  return `maintsupp:board:${boardId}:mobile-layout:v2`;
}

/**
 * What a board opens in on a phone: the TABLE, on every board, every time.
 *
 * No board argument, deliberately. A per-board default is what let Store
 * Documentation open on the cards while Jobs opened on the table, and the
 * requirement is one answer for the whole product.
 */
export function defaultMobileLayout(): MobileLayout {
  return "grid";
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
 * rather than an effect flashing a layout for a frame. The answer is now a
 * constant, but the pair stays — it is what makes the board-change reset
 * happen during render instead of after it.
 *
 * What this still READS, it deletes. See the header.
 */
export function readMobileLayout(boardId: string): {
  boardId: string;
  layout: MobileLayout;
} {
  const store = storage();
  if (store) {
    try {
      if (store.getItem(legacyMobileLayoutKey(boardId)) !== null) {
        store.removeItem(legacyMobileLayoutKey(boardId));
      }
      if (store.getItem(retiredMobileLayoutKey(boardId)) !== null) {
        store.removeItem(retiredMobileLayoutKey(boardId));
      }
    } catch {
      // A store that will not delete is one we simply never read again.
    }
  }
  return { boardId, layout: defaultMobileLayout() };
}
