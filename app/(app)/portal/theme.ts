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
  MOBILE_THEME_QUERY,
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
 * What "nothing has been chosen" means — DARK on a phone, the device
 * everywhere else.
 *
 * The owner's requirement is that the app is dark out of the box on a phone.
 * This is the same decision `theme-boot.ts` makes before paint, written the
 * same way against the same exported query, so the pre-paint stamp and the
 * value React reads afterwards cannot disagree — that disagreement is a
 * one-frame flash, and avoiding it is the entire reason the boot script exists.
 *
 * It is the DEFAULT that moves, not the resolution: `resolveTheme` is
 * untouched, an explicit "light" or "dark" is still read first and still wins,
 * and an explicit "system" still means the device on a phone. So the picker in
 * `theme-toggle.tsx` reads "Dark" on a fresh phone, which is the truth — the
 * page IS dark — rather than reading "System" beside a page that is ignoring
 * the system.
 */
export function defaultThemeChoice(): ThemeChoice {
  if (typeof window === "undefined" || !window.matchMedia) return "system";
  return window.matchMedia(MOBILE_THEME_QUERY).matches ? "dark" : "system";
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
 */
export function applyTheme(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  // Both, because the token blocks are on `:root` and the light skin is written
  // against `body[data-theme="light"]`.
  if (document.body) document.body.dataset.theme = resolved;
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
   * The width matters now too: with nothing stored, the default is dark below
   * the phone boundary and the device above it, so a window dragged across
   * that boundary changes the answer. A phone never fires this; a desktop
   * browser being resized would otherwise keep painting a stale default until
   * something else happened to re-read the store.
   */
  const width = window.matchMedia(MOBILE_THEME_QUERY);
  width.addEventListener("change", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
    media.removeEventListener("change", onChange);
    width.removeEventListener("change", onChange);
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

/** The stored choice — "system" | "light" | "dark" — for a picker's value. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, readThemeChoice, serverChoice);
}

/** What is painted right now, for an icon or a label. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, readResolved, serverResolved);
}

/*
 * The server cannot know any of it: the choice is in the visitor's browser, and
 * both the device preference and the viewport width are media queries. It
 * renders "system" and the first client render uses the same value, so the
 * markup matches; `useSyncExternalStore` then re-reads and re-renders with the
 * real choice. The DOM is already correct throughout, because the boot script
 * stamped it before paint — this is only what a picker shows.
 */
function serverChoice(): ThemeChoice {
  return "system";
}

function serverResolved(): ResolvedTheme {
  return "dark";
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
