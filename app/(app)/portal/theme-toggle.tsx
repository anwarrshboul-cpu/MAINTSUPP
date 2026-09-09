"use client";

import { useEffect, useRef } from "react";
import { Icon } from "../../components";
import {
  type ThemeChoice,
  adoptProfileTheme,
  readThemeChoice,
  setThemeChoice,
  useAppliedTheme,
  useThemeChoice,
} from "./theme";
import { THEME_PROFILE_KEY } from "./theme-boot";

export type { ThemeChoice };

/**
 * One reconciliation per page load, not per mount.
 *
 * The portal is a single-page app: `ThemeToggle` is mounted once in the topbar
 * and stays there, but React strict mode double-invokes effects in development
 * and a remount is always possible. A module-level flag makes the request
 * happen exactly once per hard load however many times the effect runs — which
 * is the right granularity, because a sign-in is a full page navigation and is
 * therefore the only thing that can change who the answer is about.
 */
let profileAsked = false;

/**
 * Read `users.theme_preference` back and let it win, ONCE per browser per
 * account.
 *
 * THE FAULT: the column had every writer and no reader. Both pickers and the
 * account panel PATCH it, and the comment below this used to say in as many
 * words that it "is not read back to apply anything". So a person who chose
 * Light on their laptop signed in on their phone and got the default, and the
 * row was a record of a decision it never enforced.
 *
 * THE MARKER IS AN ACCOUNT ID, NOT A BOOLEAN, and that is what keeps this from
 * being destructive. Seeing an id that is not the one stored means this browser
 * has never taken THIS person's preference — a new device, a cleared profile,
 * or a second person signing in on a shared machine — so the profile wins and
 * the id is recorded. Seeing the id already stored means the two are in sync
 * and the local mirror is left alone, so a theme picked here yesterday is not
 * quietly undone today by a value it already agreed with. That is the whole
 * difference between "the profile is authoritative on sign-in" and "the profile
 * overwrites your choice on every page view".
 *
 * Nothing here writes the server. This is the read half of a mirror; PATCHing
 * back a value that came FROM the row is the arrival write the effect below
 * exists to prevent, which is why the caller seeds `lastPersisted` BEFORE
 * adopting rather than after.
 */
async function profileChoice(): Promise<ThemeChoice | null> {
  if (profileAsked) return null;
  profileAsked = true;
  try {
    const response = await fetch("/api/account?scope=theme", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      theme?: { userId?: string | null; preference?: string | null };
    };
    const userId = payload.theme?.userId;
    const preference = payload.theme?.preference;
    if (!userId) return null;
    if (
      preference !== "system" &&
      preference !== "light" &&
      preference !== "dark"
    ) {
      return null;
    }
    // Storage can throw outright in Safari's private mode, and a colour scheme
    // is not worth an unhandled rejection on the boot path.
    if (window.localStorage.getItem(THEME_PROFILE_KEY) === userId) return null;
    window.localStorage.setItem(THEME_PROFILE_KEY, userId);
    return preference === readThemeChoice() ? null : preference;
  } catch {
    // Offline, signed out, or storage unavailable. The local choice stands,
    // which is the same answer this control gave before the column was read at
    // all — a failed reconciliation must never repaint the page.
    return null;
  }
}

/**
 * Colour theme control for the topbar.
 *
 * The board already carried a picker, but it kept its own copy of the state and
 * its own writer, so the two could disagree — measured: the topbar reading
 * "Light" while the board's select read "Dark", in the same document. Both now
 * read and write `theme.ts`, which is the only thing that touches the stored
 * key or the document.
 *
 * The default is "dark": with nothing stored, the portal paints dark on every
 * device. It was "system" on a desktop and dark only on a phone; see
 * `theme-boot.ts` for why that boundary went. Light and System are still real
 * choices and still beat the default — an explicit "system" is what hands the
 * decision back to `prefers-color-scheme`.
 *
 * The choice is mirrored to `users.theme_preference` through `/api/account`,
 * but ONLY when it changes — a mount used to PATCH the column on every page
 * load, which wrote the database for merely looking at a page. A failed save is
 * deliberately not surfaced: the theme is already applied locally, and an error
 * toast for a colour scheme is noise.
 *
 * The mirror now runs BOTH WAYS. The comment here used to say the column "is
 * not read back to apply anything, because the device is the right place to
 * decide how a browser paints" — which was a reasonable position while the
 * default followed the device, and became a defect the moment it stopped: with
 * a fixed default, a choice made on one device reached no other, and the column
 * recorded a decision it never enforced. `profileChoice()` above is the read
 * half, and it runs once per browser per account rather than on every load.
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

  /*
   * The other direction: what this person chose somewhere else.
   *
   * THE ORDER OF THE TWO LINES IN HERE IS THE WHOLE THING. `adoptProfileTheme`
   * writes the store, which re-renders this component and re-runs the effect
   * above; if `lastPersisted` still held the OLD value at that moment, that
   * effect would see a change and PATCH the account row with a value it had
   * just been given by the account row. Seeding the ref first makes the
   * comparison equal, so a reconciliation is silent — arriving still writes
   * nothing, which is the contract that effect exists to keep.
   *
   * Deliberately not gated on `choice`: this must fire once, on arrival, and
   * `profileChoice` holds its own module-level guard so a remount cannot ask
   * twice. `cancelled` only stops the write after an unmount; the request
   * itself is harmless and there is nothing to abort worth the code.
   */
  useEffect(() => {
    if (!persist) return;
    let cancelled = false;
    void profileChoice().then((adopted) => {
      if (cancelled || !adopted) return;
      lastPersisted.current = adopted;
      adoptProfileTheme(adopted);
    });
    return () => {
      cancelled = true;
    };
  }, [persist]);

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
