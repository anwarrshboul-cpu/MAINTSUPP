"use client";

import { useEffect, useRef } from "react";
import { Icon } from "../../components";
import {
  type ThemeChoice,
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

  useEffect(() => {
    if (!persist) return;
    // The first run is the page arriving, not somebody choosing. Recording it
    // would write the account row on every navigation.
    if (lastPersisted.current === null) {
      lastPersisted.current = choice;
      return;
    }
    if (lastPersisted.current === choice) return;
    lastPersisted.current = choice;
    // Debounced: flicking through the three options should not post three times.
    const timer = window.setTimeout(() => {
      void fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themePreference: choice }),
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
