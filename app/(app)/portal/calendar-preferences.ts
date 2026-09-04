"use client";

/**
 * The calendar's view state, kept where this product already keeps view
 * preferences, and the colour maths for an event chip.
 *
 * WHERE THE PREFERENCES LIVE, AND WHAT THAT COSTS
 *
 * There is no server-side store for arbitrary per-user settings. The three
 * that exist are narrow by design — `/api/dashboard-layout` records panel
 * order and hidden-ness, `/api/navigation` records nav order, and
 * `section_view_preferences` records which board tab a section lands on —
 * and none of them has a shape that fits "which date fields is this person
 * showing on the calendar". Widening one means changing an API route, a
 * migration and a serialiser for what is a client-side view choice.
 *
 * So this uses the mechanism the board already uses for collapsed groups, the
 * theme and the analytics sort direction: `localStorage` under a `maintsupp:`
 * key, read through `useSyncExternalStore`. Said plainly rather than implied:
 * THIS MAKES THE CHOICE PER PERSON PER BROWSER, NOT PER ACCOUNT. The same user
 * on a second device, or in a private window, gets the defaults back. That is
 * the tradeoff, and it is the same one `useStoredSortDirection` in
 * period-picker.tsx documents.
 *
 * WHY EVERY READ VALIDATES
 *
 * `localStorage` is writable by anything running on the origin, including the
 * user with devtools open and a stale value written by an older build. A read
 * that trusts what it finds is a read that can put an unknown source id into
 * the query, a 40,000-entry array into a filter, or `null` where a string was
 * expected. Every decoder below returns the default on anything it does not
 * recognise, drops values outside the known vocabulary, and caps both the
 * length of a list and the length of a string inside it.
 *
 * WHY THE COLOUR MATHS IS NOT HERE
 *
 * It is in `chip-ink.ts`, which already implements WCAG relative luminance and
 * the contrast ratio for the board's data-coloured chips, and which the
 * contrast test suite already imports. A second copy of that arithmetic is
 * exactly the duplication this codebase keeps recording that it removed, so
 * this file wraps it rather than restating it.
 */

import { useCallback, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";

import {
  CHIP_INK_DARK,
  CHIP_INK_DEEP,
  CHIP_INK_LIGHT,
  chipInk,
  chipStyle,
  contrastRatio,
} from "./chip-ink";
import {
  CALENDAR_DATE_SOURCES,
  DEFAULT_CALENDAR_SOURCE_IDS,
  EMPTY_CALENDAR_FILTERS,
  type CalendarEvent,
  type CalendarFilters,
  type CalendarViewMode,
} from "./calendar-model";

/**
 * The ratio the whole product is held to for body-sized text, and the bar the
 * colour picker warns below. Chips render at 11-13px, so the large-text
 * allowance never applies.
 */
const AA = 4.5;

/* ── Storage keys ─────────────────────────────────────────────────────────── */

export const CALENDAR_MODE_KEY = "maintsupp:calendar:mode";
export const CALENDAR_SOURCES_KEY = "maintsupp:calendar:sources";
export const CALENDAR_FILTERS_KEY = "maintsupp:calendar:filters";
export const CALENDAR_COLOURS_KEY = "maintsupp:calendar:colours";

/* ── Colours ──────────────────────────────────────────────────────────────── */

export type CalendarColours = { job: string; compliance: string; manual: string };

/**
 * The default event colours, as concrete hex.
 *
 * They are hex and not `var(--navy-700)` because the whole point of the picker
 * is that a chosen colour is measured — `calendarInk` computes a luminance,
 * and a `var()` has no luminance until a browser resolves it. So each default
 * MIRRORS a token rather than replacing it, and the mirror is named here:
 *
 *   job        #1b4662  = --navy-700 (light), the `.calendar-event` left border
 *   compliance #6b3fa0  = --purple-600 (light), `.calendar-event--renewal`
 *
 * The other two calendar tones — `--orange-500` #f06b35 (urgent) and
 * `--teal-500` #12b5aa (booked visit) — stay with the states that own them and
 * are deliberately not offered as an entity default: they mean "this is late"
 * and "this is a visit", which is timing, not type.
 *
 * If either token's light value changes, this is the copy that has to follow,
 * which is why the mirror is written down rather than assumed.
 */
export const DEFAULT_CALENDAR_COLOURS: CalendarColours = {
  job: "#1b4662",
  compliance: "#6b3fa0",
  /*
   * W11 — the manual items. `--teal-600` #0f7f78 in light, and it is the one
   * entity default drawn from the tones the comment above reserved. The
   * reservation was for TIMING — "this is late", "this is a visit" — and a
   * manual item has no timing of its own to clash with it: it is never overdue
   * and never resolved. What it needs is to be unmistakable beside navy and
   * purple at chip size, which a teal is and a third blue would not be.
   */
  manual: "#0f7f78",
};

/** `#rgb` or `#rrggbb`. Anything else is not a colour this picker produced. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * A stored colour, normalised to `#rrggbb`, or the fallback.
 *
 * `<input type="color">` only ever emits `#rrggbb`, so anything else in
 * storage came from somewhere else and is not trusted onto the page — an
 * unparseable value would paint as `transparent`, which is how a chip ends up
 * with computed-for-navy white text on a white card.
 *
 * The three-digit form is expanded rather than rejected: it is a colour a
 * previous build could legitimately have written, and `<input type="color">`
 * refuses to display it, so every consumer downstream gets the six-digit form
 * and none of them has to know the short one exists.
 */
function colourOrFallback(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().toLowerCase();
  if (!HEX.test(trimmed)) return fallback;
  if (trimmed.length === 7) return trimmed;
  const [, r, g, b] = trimmed;
  return `#${r}${r}${g}${g}${b}${b}`;
}

/**
 * The label colour for a calendar chip on `background`.
 *
 * A thin wrapper over `chipInk`, which is where the WCAG luminance and the
 * ink choice actually live. The wrapper exists because the two callers differ
 * in one way: a board option chip carries a `text_color` imported from monday
 * that `chipInk` keeps when it is legible, whereas a calendar chip has no
 * stored preference at all — the ground is picked in this session's own
 * settings panel, so there is nothing to preserve and the better of the house
 * inks is always the right answer.
 *
 * An unparseable ground is substituted for the job default before measuring,
 * so this agrees with `calendarChipStyle`, which substitutes the same value
 * before painting. Measuring one colour and painting another is how a
 * "readable" ink lands on a ground it was never computed against.
 */
export function calendarInk(background: string): string {
  return chipInk(colourOrFallback(background, DEFAULT_CALENDAR_COLOURS.job));
}

/**
 * The best contrast any house ink manages on `background`, 1 to 21.
 *
 * `chipInk` returns the best ink available; it does not promise that ink
 * clears AA, because on a handful of mid-tone grounds no ink does — monday's
 * red, purple and blue sit almost exactly where white and dark ink are equally
 * bad. This is the number the picker warns on, so the three candidates are
 * measured in one place rather than restated at the call site.
 */
export function calendarBestContrast(background: string): number {
  const ground = colourOrFallback(background, DEFAULT_CALENDAR_COLOURS.job);
  return Math.max(
    contrastRatio(CHIP_INK_DARK, ground),
    contrastRatio(CHIP_INK_LIGHT, ground),
    contrastRatio(CHIP_INK_DEEP, ground),
  );
}

/** True when no available ink reads on this ground, so the picker must say so. */
export function calendarColourFails(background: string): boolean {
  return calendarBestContrast(background) < AA;
}

/**
 * The chip style for one event.
 *
 * Ground and ink come from `chipStyle`, so a calendar chip and a board chip
 * make the same decision from the same code. What the calendar adds is the
 * left border, which is the marker the existing `.calendar-event` already uses
 * to carry type — except that here the GROUND carries type, so the border
 * carries timing instead, and it does it in a way that survives a colour-blind
 * reader and a greyscale print:
 *
 *   overdue / due today   4px solid   — thick
 *   upcoming              2px solid   — the resting weight
 *   resolved / past       2px dashed  — broken, so "done" is a shape not a tint
 *
 * The border takes the INK colour rather than a darker shade of the ground,
 * because the ink is by construction the colour with the most contrast against
 * that ground: whatever the user picks, the edge stays visible.
 *
 * Nothing here reduces opacity. A 0.7 wash on a chip that measured 5:1 puts it
 * under AA again, and it would do it invisibly to the contrast suite, which
 * measures the pair and not what was painted over it.
 */
export function calendarChipStyle(
  event: CalendarEvent,
  colours: CalendarColours,
): CSSProperties {
  /* One lookup per entity, keyed rather than nested ternaries: a fourth kind
     would otherwise be a third condition in two places that must agree. */
  const chosen = colours[event.kind] ?? colours.job;
  const fallback = DEFAULT_CALENDAR_COLOURS[event.kind] ?? DEFAULT_CALENDAR_COLOURS.job;
  const { background, color } = chipStyle(colourOrFallback(chosen, fallback));
  const urgent = event.timing === "overdue" || event.timing === "due-today";
  const settled = event.timing === "resolved" || event.timing === "past";
  return {
    background,
    color,
    borderLeftStyle: settled ? "dashed" : "solid",
    borderLeftWidth: urgent ? 4 : 2,
    borderLeftColor: color,
  };
}

/**
 * The WCAG ratio, re-exported rather than reimplemented.
 *
 * `chip-ink.ts` owns it and the contrast test suite already measures the
 * board's palette with it. Callers in the calendar import it from here so they
 * do not have to know which file the maths lives in, but there is still only
 * one implementation.
 */
export { contrastRatio } from "./chip-ink";
export { CHIP_INK_DARK, CHIP_INK_DEEP, CHIP_INK_LIGHT } from "./chip-ink";

/* ── The store ────────────────────────────────────────────────────────────── */

/**
 * Same-tab writes are announced through this set; `storage` only fires in
 * OTHER tabs. Both feed one subscribe/snapshot pair, which is what
 * `useSyncExternalStore` wants.
 */
const listeners = new Set<() => void>();

/**
 * What was chosen this session, whether or not storage accepted it.
 *
 * Private browsing and a blocked-storage policy both make `setItem` throw.
 * Without this the controls would appear inert in those browsers: the click
 * would write nowhere and the next snapshot would read the default straight
 * back. Keyed by storage key, holding the already-decoded value so a read does
 * not re-parse on every render.
 */
const memory = new Map<string, unknown>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function announce() {
  for (const listener of listeners) listener();
}

/**
 * The last decode of each key, kept against the exact string it came from.
 *
 * THIS IS NOT AN OPTIMISATION. `useSyncExternalStore` compares snapshots by
 * identity and re-renders when they differ, so a `getSnapshot` that decodes
 * afresh on every call returns a new object every call, and three of the four
 * values here ARE objects. That is an infinite render loop, and React says so
 * ("The result of getSnapshot should be cached"). The existing
 * `useStoredSortDirection` never hit it because its value is a string.
 *
 * Keyed on the raw text, so a write from another tab — which changes the text —
 * produces a new reference and does re-render, while an unchanged store keeps
 * handing back the same one.
 */
const decoded = new Map<string, { raw: string; value: unknown }>();

/**
 * One key's value: the session's own choice, else what storage holds decoded
 * by `decode`, else the default.
 *
 * `decode` receives whatever `JSON.parse` produced — including `null`, a
 * number or an array where an object was expected — and is responsible for
 * returning something valid every time. It is never given a chance to throw
 * past this function.
 */
function readKey<T>(key: string, decode: (raw: unknown) => T, fallback: T): T {
  /*
   * A choice made in THIS tab wins over one made in another. That is the same
   * precedence `useStoredSortDirection` has, and it is what keeps the control
   * working at all when `setItem` throws; the cost is that a tab which has
   * already chosen ignores a later change from a second tab.
   */
  const remembered = memory.get(key);
  if (remembered !== undefined) return remembered as T;
  try {
    const saved = window.localStorage.getItem(key);
    if (saved === null) return fallback;
    const cached = decoded.get(key);
    if (cached && cached.raw === saved) return cached.value as T;
    const value = decode(JSON.parse(saved));
    decoded.set(key, { raw: saved, value });
    return value;
  } catch {
    // Absent, unparseable, or storage unavailable. The default still renders a
    // working calendar, which is the only thing this needs to guarantee.
    return fallback;
  }
}

function writeKey<T>(key: string, value: T) {
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Held in memory above, so the control still works for this session.
  }
  announce();
}

/**
 * The shared hook shape. `decode` and `fallback` must be stable across
 * renders — every caller below passes module-level constants — because they
 * are the identity `useSyncExternalStore` re-subscribes on.
 */
function useStored<T>(
  key: string,
  decode: (raw: unknown) => T,
  fallback: T,
): [T, (next: T) => void] {
  const read = useCallback(() => readKey(key, decode, fallback), [key, decode, fallback]);
  // The server has no storage, so it renders the default and the first client
  // render agrees with it. Nothing to hydrate around.
  const readOnServer = useCallback(() => fallback, [fallback]);
  const value = useSyncExternalStore(subscribe, read, readOnServer);
  const choose = useCallback((next: T) => writeKey(key, next), [key]);
  return [value, choose];
}

/* ── View mode ────────────────────────────────────────────────────────────── */

const MODES: readonly CalendarViewMode[] = ["month", "week", "day"];
const DEFAULT_MODE: CalendarViewMode = "month";

/**
 * Anything outside the three modes is a mode this build cannot render.
 *
 * The four decoders are exported for one reason: they are the validation on a
 * store any script on the origin can write, and validation nothing exercises
 * is validation that quietly stops matching the vocabulary it guards. They are
 * not part of the component API — callers use the hooks.
 */
export function decodeCalendarMode(raw: unknown): CalendarViewMode {
  return typeof raw === "string" && (MODES as readonly string[]).includes(raw)
    ? (raw as CalendarViewMode)
    : DEFAULT_MODE;
}

export function useCalendarViewMode(): [CalendarViewMode, (next: CalendarViewMode) => void] {
  return useStored(CALENDAR_MODE_KEY, decodeCalendarMode, DEFAULT_MODE);
}

/* ── Date sources ─────────────────────────────────────────────────────────── */

const KNOWN_SOURCE_IDS: readonly string[] = CALENDAR_DATE_SOURCES.map(
  (source) => source.id,
);

const DEFAULT_SOURCES: string[] = [...DEFAULT_CALENDAR_SOURCE_IDS];

/**
 * The stored source list.
 *
 * An id that is not in `CALENDAR_DATE_SOURCES` is dropped rather than kept:
 * it is either a field an older build offered, or something typed into
 * devtools, and either way handing it to the query is handing it an unknown
 * column name. Order follows the declared order so the list cannot be used to
 * smuggle in duplicates or a 10,000-entry array — the result is at most one
 * entry per known source.
 *
 * AN EMPTY ARRAY IS A LEGAL VALUE and must round-trip. Unticking every source
 * is a thing a user can do, the parent renders a "no date source selected"
 * state for it, and falling back to the default here would silently undo the
 * choice on every reload.
 */
export function decodeCalendarSources(raw: unknown): string[] {
  if (!Array.isArray(raw)) return DEFAULT_SOURCES;
  const wanted = new Set(raw.filter((id): id is string => typeof id === "string"));
  return KNOWN_SOURCE_IDS.filter((id) => wanted.has(id));
}

export function useCalendarSources(): [string[], (next: string[]) => void] {
  const [value, choose] = useStored(CALENDAR_SOURCES_KEY, decodeCalendarSources, DEFAULT_SOURCES);
  // Written through the same validator the reader uses, so a caller that hands
  // over an unknown id cannot put one into storage for the next session.
  const set = useCallback((next: string[]) => choose(decodeCalendarSources(next)), [choose]);
  return [value, set];
}

/* ── Filters ──────────────────────────────────────────────────────────────── */

/**
 * Caps for a browser-writable list. A workspace with more than 60 sites cannot
 * have all of them selected at once, which is a limit on the FILTER and not on
 * the data — 60 selected facets already means the facet is doing nothing, and
 * an uncapped array here is an uncapped array in the query the parent builds.
 */
const MAX_FILTER_VALUES = 60;
const MAX_VALUE_LENGTH = 200;

const FILTER_KEYS = [
  "sites",
  "statuses",
  "priorities",
  "contractors",
  "jobTypes",
  "complianceTypes",
] as const satisfies readonly (keyof CalendarFilters)[];

/** One facet's list: strings only, trimmed, length-capped, deduped, count-capped. */
function decodeValues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const value = entry.trim().slice(0, MAX_VALUE_LENGTH);
    if (!value) continue;
    seen.add(value);
    if (seen.size >= MAX_FILTER_VALUES) break;
  }
  return [...seen];
}

export function decodeCalendarFilters(raw: unknown): CalendarFilters {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return EMPTY_CALENDAR_FILTERS;
  }
  const source = raw as Record<string, unknown>;
  const next = {} as CalendarFilters;
  for (const key of FILTER_KEYS) next[key] = decodeValues(source[key]);
  return next;
}

export function useCalendarFilters(): [CalendarFilters, (next: CalendarFilters) => void] {
  const [value, choose] = useStored(
    CALENDAR_FILTERS_KEY,
    decodeCalendarFilters,
    EMPTY_CALENDAR_FILTERS,
  );
  const set = useCallback(
    (next: CalendarFilters) => choose(decodeCalendarFilters(next)),
    [choose],
  );
  return [value, set];
}

/* ── Colours ──────────────────────────────────────────────────────────────── */

/**
 * The stored colours. Each half is validated on its own, so a corrupt `job`
 * does not cost the user the `compliance` colour they also chose.
 */
export function decodeCalendarColours(raw: unknown): CalendarColours {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_CALENDAR_COLOURS;
  }
  const source = raw as Record<string, unknown>;
  return {
    job: colourOrFallback(source.job, DEFAULT_CALENDAR_COLOURS.job),
    compliance: colourOrFallback(
      source.compliance,
      DEFAULT_CALENDAR_COLOURS.compliance,
    ),
    /* Absent from anything stored before W11, which is every reader's saved
       preference — so the fallback is not an edge case, it is the normal path
       for a while, and it has to be the default rather than "". */
    manual: colourOrFallback(source.manual, DEFAULT_CALENDAR_COLOURS.manual),
  };
}

export function useCalendarColours(): [CalendarColours, (next: CalendarColours) => void] {
  const [value, choose] = useStored(
    CALENDAR_COLOURS_KEY,
    decodeCalendarColours,
    DEFAULT_CALENDAR_COLOURS,
  );
  const set = useCallback((next: CalendarColours) => choose(decodeCalendarColours(next)), [choose]);
  return [value, set];
}
