"use client";

/**
 * The one source of truth for the colour theme, after first paint.
 *
 * Before this there were five: the topbar toggle, the board's private copy of
 * the same state, an unconditional `body.dataset.theme = "dark"` in
 * `portal-app.tsx`, another in `account-shell.tsx`, and the account theme panel
 * writing the raw choice (which put `data-theme="system"` — a value no
 * stylesheet matches — onto the document). They raced on every mount, and a
 * device theme change repainted the page dark while the control still read
 * "Light". All of them now go through the store below, so the two pickers
 * cannot hold different values and nothing can overwrite an explicit choice.
 *
 * `localStorage` is an external store, so it is read with the hook meant for
 * one rather than copied into state by an effect. The `getServerSnapshot`
 * values are what the server rendered, so hydration matches; React re-renders
 * with the real value immediately afterwards. The *page* does not wait for
 * that — `theme-boot.ts` has already stamped the attributes before paint.
 */

import { useEffect, useSyncExternalStore } from "react";
import {
  DEFAULT_THEME_CHOICE,
  THEME_COLOR_META_SELECTOR,
  THEME_MIGRATION_KEY,
  THEME_STORAGE_KEY,
} from "./theme-boot";

/** What the user picked. "system" means "ask the device". */
export type ThemeChoice = "system" | "light" | "dark";

/** What is actually painted, once "system" has been asked of the browser. */
export type ResolvedTheme = "light" | "dark";

function isChoice(value: unknown): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Private browsing throws on access, not on read. The session still gets a
    // working control through `memoryChoice` below.
    return null;
  }
}

/** The selection for this tab when storage is unavailable. */
let memoryChoice: ThemeChoice | null = null;

/**
 * Clears the value `live-board.tsx` used to write without being asked.
 *
 * See the long note in `theme-boot.ts`. Runs once per browser; the boot script
 * normally gets there first, and this is the path for anything that reaches the
 * store before the script has run (tests, a route rendered without the layout).
 */
function migrate(store: Storage) {
  try {
    if (store.getItem(THEME_MIGRATION_KEY) === "1") return;
    store.removeItem(THEME_STORAGE_KEY);
    store.setItem(THEME_MIGRATION_KEY, "1");
  } catch {
    // Nothing to migrate if we cannot write; the default stands.
  }
}

/**
 * What "nothing has been chosen" means — DARK, on every device.
 *
 * This was dark on a phone and the device everywhere else. The owner's
 * requirement is now that the signed-in portal is dark out of the box full
 * stop, so the width query is gone and the answer is a constant. It is the
 * SAME constant `theme-boot.ts` uses before paint, imported rather than
 * restated, so the pre-paint stamp and the value React reads afterwards cannot
 * disagree — that disagreement is a one-frame flash, and avoiding it is the
 * entire reason the boot script exists.
 *
 * There is deliberately no `window` guard left. There was one only because the
 * old body called `matchMedia`; a constant answers identically on the server,
 * which is what lets `serverChoice()` below be this same function and lets the
 * SSR snapshot finally agree with a fresh visitor's client state.
 *
 * It is the DEFAULT that moves, not the resolution: `resolveTheme` is
 * untouched, an explicit "light" or "dark" is still read first and still wins,
 * and an explicit "system" still resolves through `prefers-color-scheme`. So
 * the picker in `theme-toggle.tsx` reads "Dark" on a fresh browser, which is
 * the truth — the page IS dark — rather than reading "System" beside a page
 * that is ignoring the system.
 */
export function defaultThemeChoice(): ThemeChoice {
  return DEFAULT_THEME_CHOICE;
}

/** The stored choice, or the default above when nothing has been chosen. */
export function readThemeChoice(): ThemeChoice {
  const store = storage();
  if (!store) return memoryChoice ?? defaultThemeChoice();
  migrate(store);
  const stored = store.getItem(THEME_STORAGE_KEY);
  return isChoice(stored) ? stored : (memoryChoice ?? defaultThemeChoice());
}

/** "system" through the device; anything else through unchanged. */
export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice !== "system") return choice;
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readResolved(): ResolvedTheme {
  return resolveTheme(readThemeChoice());
}

/**
 * Stamps the document.
 *
 * `color-scheme` goes on with it so the browser's own furniture — scrollbars,
 * date pickers, the caret, form controls with no styling of their own — follows
 * the theme rather than staying dark under a light page.
 *
 * `<meta name="theme-color">` goes on with it for the same reason one step out:
 * the address bar and the overscroll gutter are painted by the BROWSER, from
 * that tag, and nothing else in the app can reach them. The layout renders two
 * tags and the browser takes the first whose `media` matches, so all that is
 * needed here is to enable or disable the light one — which keeps the two
 * colour literals in the markup instead of duplicated in script. Without this
 * the tint would follow the device rather than the choice, and a user who
 * picked Light on a dark phone would get a light page under a black bar.
 */
export function applyTheme(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  // Both, because the token blocks are on `:root` and the light skin is written
  // against `body[data-theme="light"]`.
  if (document.body) document.body.dataset.theme = resolved;
  const tint = document.querySelector(THEME_COLOR_META_SELECTOR);
  // Absent on any route that does not load the app layout, which is every
  // marketing and public page. Missing it must not throw here.
  if (tint) tint.setAttribute("media", resolved === "light" ? "all" : "not all");
}

/*
 * `storage` events only fire in *other* tabs, so same-tab writes are announced
 * through this listener set. The device's own preference is part of the same
 * subscription: when the choice is "system", a change to
 * `prefers-color-scheme` changes the resolved value and every subscriber has to
 * hear about it.
 */
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);
  /*
   * The viewport width used to be subscribed to as well, because the default
   * was dark below `(max-width: 760px)` and the device above it, so a window
   * dragged across that boundary changed the answer. The default is now a
   * constant, so nothing about the answer depends on the width and that
   * listener would only wake every subscriber on a resize to re-read a value
   * that cannot have moved. Removed with the query it used.
   */
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
    media.removeEventListener("change", onChange);
  };
}

/**
 * Record a deliberate choice.
 *
 * The ONLY writer of the storage key. Nothing writes it on mount, on load, or
 * from an effect — that is what made every visitor carry an explicit "dark"
 * they never picked, and it is why the default could not follow the device.
 */
export function setThemeChoice(next: ThemeChoice) {
  memoryChoice = next;
  const store = storage();
  if (store) {
    try {
      store.setItem(THEME_STORAGE_KEY, next);
      // A real choice supersedes the migration; mark it done so the one-off
      // clear can never run over the top of it.
      store.setItem(THEME_MIGRATION_KEY, "1");
    } catch {
      // Keep the in-memory selection when storage is unavailable.
    }
  }
  applyTheme(resolveTheme(next));
  emit();
}

/**
 * Adopt the choice this person made on ANOTHER device.
 *
 * `users.theme_preference` is written by every picker in the app and was then
 * read back by nothing at all — `theme-toggle.tsx` said so in as many words —
 * so a user who chose Light on their laptop got the default on their phone and
 * the column was a write-only record of a decision it never enforced. This is
 * the read-back half, called once per browser per account from
 * `theme-toggle.tsx`, which owns the marker and the request.
 *
 * It goes through `setThemeChoice` on purpose rather than writing the key
 * itself. The value IS a deliberate choice — made by this same person, through
 * one of these same pickers, on a different device — so it deserves the same
 * treatment: stored, applied, announced to every subscriber, and marked so the
 * one-off migration can never land on top of it. Keeping one writer of the
 * storage key is also what stops this becoming the next `live-board.tsx`.
 */
export function adoptProfileTheme(choice: ThemeChoice) {
  setThemeChoice(choice);
}

/** The stored choice — "system" | "light" | "dark" — for a picker's value. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, readThemeChoice, serverChoice);
}

/** What is painted right now, for an icon or a label. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, readResolved, serverResolved);
}

/*
 * THE SSR SNAPSHOT NOW AGREES WITH THE DEFAULT, AND THAT IS THE CHANGE.
 *
 * The server still cannot know the stored choice — it is in the visitor's
 * browser — so this can only ever be a guess at the commonest case, and the
 * question is which case that is. It used to be "system", for two reasons that
 * were both about the OLD default: a literal "dark" here would have made the
 * device irrelevant on a desktop, where an absent preference meant
 * `prefers-color-scheme`; and it would have been a guaranteed hydration
 * correction for every desktop visitor, since "system" was what the client
 * actually computed there.
 *
 * Neither survives the default becoming dark unconditionally. An absent
 * preference no longer consults the device at all, so nothing here can make the
 * device irrelevant — `resolveTheme` still asks it, and only for an explicit
 * "system". And the value a fresh visitor's client computes is now "dark", so
 * "system" here would be the mismatch: the server would render the picker
 * reading "System theme" and React would correct it to "Dark" a frame later,
 * on every first visit, which is exactly the correction this snapshot exists to
 * avoid. Returning the default instead makes the two agree for the common case
 * and leaves the uncommon one (a stored value that differs) as the single
 * re-render it always was.
 *
 * It is `defaultThemeChoice()` rather than a second literal so there is one
 * declaration of the default in this file, not two that can drift apart. And
 * the resolved snapshot is derived from it for the same reason: "dark" was
 * previously right by coincidence — `resolveTheme("system")` off-DOM happens to
 * answer "dark" — and a coincidence is not a contract.
 *
 * Neither value reaches the document. The boot script stamped the real theme
 * before paint and `applyTheme` runs from an effect with the real store value;
 * this is only what a picker shows during the hydration render.
 */
function serverChoice(): ThemeChoice {
  return defaultThemeChoice();
}

function serverResolved(): ResolvedTheme {
  return resolveTheme(serverChoice());
}

/**
 * Keeps the document in step with the store.
 *
 * The boot script has already applied the right value, so on a first paint this
 * writes what is already there. It earns its place afterwards: a choice made in
 * another tab, or the device flipping while the choice is "system".
 */
export function useAppliedTheme(): ResolvedTheme {
  const resolved = useResolvedTheme();
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);
  return resolved;
}
