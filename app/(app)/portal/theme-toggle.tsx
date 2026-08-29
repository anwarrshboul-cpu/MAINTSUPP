"use client";

import { useEffect, useRef } from "react";
import { Icon } from "../../components";
import {
  type ThemeChoice,
  readThemeChoice,
  setThemeChoice,
  useAppliedTheme,
  useThemeChoice,
} from "./theme";

export type { ThemeChoice };

/**
 * Colour theme control for the topbar.
 *
 * The board already carried a picker, but it kept its own copy of the state and
 * its own writer, so the two could disagree — measured: the topbar reading
 * "Light" while the board's select read "Dark", in the same document. Both now
 * read and write `theme.ts`, which is the only thing that touches the stored
 * key or the document.
 *
 * The default is "system": with nothing stored, the device decides, which is
 * what `prefers-color-scheme` is for. An explicit Light or Dark is stored and
 * beats the device until it is changed again.
 *
 * The choice is also mirrored to `users.theme_preference` through
 * `/api/account`, but ONLY when it changes — a mount used to PATCH the column
 * on every page load, which wrote the database for merely looking at a page.
 * That column is a record of the choice; it is not read back to apply anything,
 * because the device is the right place to decide how a browser paints. A
 * failed save is deliberately not surfaced: the theme is already applied
 * locally, and an error toast for a colour scheme is noise.
 */
export function ThemeToggle({ persist = true }: { persist?: boolean }) {
  const choice = useThemeChoice();
  // Reapplies on a cross-tab change or a device flip; the boot script has
  // already painted the right theme by the time this first runs.
  const resolved = useAppliedTheme();

  const lastPersisted = useRef<ThemeChoice | null>(null);

  /*
   * WHAT IS COMPARED IS THE STORE, NOT THE RENDERED VALUE — and that difference
   * is the whole reason a page load stopped writing the database.
   *
   * `useThemeChoice` is a `useSyncExternalStore`. During hydration it hands back
   * the SERVER snapshot ("system", because the server can see neither the
   * visitor's storage nor their viewport) and re-renders with the real value
   * immediately afterwards. To an effect watching `choice`, that correction is
   * indistinguishable from somebody picking a theme: it ran once with "system",
   * seeded the ref, then ran again with the real value and PATCHed.
   *
   * Measured on the running build, three loads with no interaction at all:
   * a clean phone (default "dark") PATCHed `{"themePreference":"dark"}`; a phone
   * with a stored "light" PATCHed `{"themePreference":"light"}`; a clean desktop
   * PATCHed nothing — because there and only there the server snapshot and the
   * real value happen to agree. So the bug was always present for anybody with
   * a stored preference, and making the phone default "dark" would have handed
   * it to every mobile visitor as well.
   *
   * Reading the store inside the effect fixes both: on arrival the ref is
   * seeded with what is ALREADY stored, so the hydration correction compares
   * equal and writes nothing. A real choice — from this select, from the
   * board's picker, or from the account panel, all of which go through the same
   * store — changes the stored value, so it still compares unequal and is still
   * mirrored. The mirror keeps working for every writer; only the page arriving
   * stopped counting as one.
   */
  useEffect(() => {
    if (!persist) return;
    const stored = readThemeChoice();
    // The first run is the page arriving, not somebody choosing. Recording it
    // would write the account row on every navigation.
    if (lastPersisted.current === null) {
      lastPersisted.current = stored;
      return;
    }
    if (lastPersisted.current === stored) return;
    lastPersisted.current = stored;
    // Debounced: flicking through the three options should not post three times.
    const timer = window.setTimeout(() => {
      void fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themePreference: stored }),
      }).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [choice, persist]);

  const label =
    choice === "system" ? "System" : choice === "dark" ? "Dark" : "Light";

  return (
    <label className="theme-toggle" title={`${label} theme`}>
      <Icon name={resolved === "dark" ? "moon" : "sun"} size={15} />
      <select
        aria-label="Colour theme"
        value={choice}
        onChange={(event) => setThemeChoice(event.target.value as ThemeChoice)}
      >
        <option value="system">System theme</option>
        <option value="light">Light theme</option>
        <option value="dark">Dark theme</option>
      </select>
    </label>
  );
}

export default ThemeToggle;
