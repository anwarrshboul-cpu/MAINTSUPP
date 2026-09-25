/**
 * The platform console Overview's arithmetic — kept apart from the screen so it
 * can be run and tested without a browser (visual pass, round 2, 2026-09-25).
 *
 * Nothing here fetches. Every function takes what an existing API already sent
 * and reshapes it for one panel; none of them invents a figure.
 */

/** One day's bar on the enquiries chart. */
export type DayCount = { day: string; count: number };

/**
 * A stamp as the APIs send them: D1's `YYYY-MM-DD HH:MM:SS` (UTC, no zone) or an
 * ISO string. Returns epoch milliseconds, or null for anything unreadable.
 */
export function parseStamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` for the UTC day an instant falls on. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * ENQUIRIES RECEIVED PER DAY, for the last `days` days ending today (UTC).
 *
 * Owner answer 5A: this is the one chart the Overview draws in place of the
 * reference's "Analytics & Leads", and it counts ENQUIRIES — rows the public form
 * wrote — not visits. Every day in the window is present, with zero where
 * nothing arrived, so a quiet week reads as quiet rather than as missing data.
 * A stamp outside the window, or one that cannot be read, is not counted.
 */
export function enquiriesByDay(stamps: readonly string[], now: number, days = 30): DayCount[] {
  const today = Date.parse(`${utcDay(now)}T00:00:00Z`);
  const first = today - (days - 1) * DAY_MS;
  const counts = new Map<string, number>();
  for (let offset = 0; offset < days; offset += 1) counts.set(utcDay(first + offset * DAY_MS), 0);
  for (const stamp of stamps) {
    const at = parseStamp(stamp);
    if (at === null) continue;
    const day = utcDay(at);
    const current = counts.get(day);
    if (current !== undefined) counts.set(day, current + 1);
  }
  return [...counts.entries()].map(([day, count]) => ({ day, count }));
}

/** The total and the busiest day of a `DayCount` series — what the chart says in words. */
export function summariseDays(series: readonly DayCount[]): { total: number; busiest: DayCount | null } {
  let total = 0;
  let busiest: DayCount | null = null;
  for (const entry of series) {
    total += entry.count;
    if (entry.count > 0 && (!busiest || entry.count > busiest.count)) busiest = entry;
  }
  return { total, busiest };
}

export type PageState = "draft" | "scheduled" | "live" | "ended";

/** One row of the Overview's page list. */
export type PageRow = {
  key: string;
  title: string;
  address: string;
  kind: "built-in" | "cms";
  state: PageState;
  /** When it last changed, where the API says; null for built-in copy never edited. */
  changedAt: string | null;
  href: string;
};

/**
 * THE WEBSITE'S PAGES, as one list: the pages that ship with the site (whose words
 * are edited under Website copy, and which are always live) first, then the pages
 * written in the CMS, most recently changed first.
 *
 * `builtInChangedAt` is the copy document's own save time — one document holds
 * the words of all the built-in pages, so it is the same for each and null while
 * nothing has been saved.
 */
export function websitePageRows(
  builtIn: ReadonlyArray<{ key: string; label: string; path: string }>,
  builtInChangedAt: string | null,
  cms: ReadonlyArray<{ id: string; slug: string; title: string; state: PageState; updatedAt: string }>,
): PageRow[] {
  const shipped: PageRow[] = builtIn.map((page) => ({
    key: `built-in:${page.key}`,
    title: page.label,
    address: page.path,
    kind: "built-in",
    state: "live",
    changedAt: builtInChangedAt,
    href: "/admin/copy",
  }));
  const written: PageRow[] = [...cms]
    .sort((a, b) => (parseStamp(b.updatedAt) ?? 0) - (parseStamp(a.updatedAt) ?? 0))
    .map((page) => ({
      key: `cms:${page.id}`,
      title: page.title,
      address: `/p/${page.slug}`,
      kind: "cms",
      state: page.state,
      changedAt: page.updatedAt,
      href: "/admin/pages",
    }));
  return [...shipped, ...written];
}

/** Counts of CMS pages by state, for the page panel's summary line. */
export function pageStateCounts(
  pages: ReadonlyArray<{ state: PageState }>,
): Record<PageState, number> {
  const counts: Record<PageState, number> = { draft: 0, scheduled: 0, live: 0, ended: 0 };
  for (const page of pages) counts[page.state] += 1;
  return counts;
}

/**
 * The label a choice token carries for its current value — "Soft (MAINTSUPP
 * default)" rather than "soft". Falls back to the raw value when the payload
 * sends no matching choice.
 */
export function choiceLabel(
  value: string,
  choices: ReadonlyArray<{ key: string; label: string }> | null | undefined,
): string {
  return choices?.find((choice) => choice.key === value)?.label ?? value;
}
