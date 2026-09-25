/**
 * THE COMPLIANCE EXPIRY TIMELINE'S FIGURES — over the page's own sites.
 *
 * What falls due in each of the next twelve months, and what has already
 * expired, counted from the register records the shell already holds.
 *
 * ── WHY IT IS SCOPED HERE (2026-09-25) ─────────────────────────────────────
 *
 * Every other figure on the Compliance page answers inside the header's
 * portfolio: `/api/compliance/metrics`, `/summary` and `/records` all resolve
 * `resolveDashboardPortfolio(db, orgId, portfolio, siteScope)` — the portfolio's
 * member sites ∩ the member's own sites — and count only register rows on those
 * sites. The timeline was handed the workspace snapshot's records whole, so on a
 * portfolio with no sites it still said "199 certificates due" and "71 already
 * expired": the workspace's figures under a header naming somewhere else.
 *
 * It now counts over the SAME resolved set, taken from the Compliance block's
 * own payload (`CpMetrics.portfolio.siteIds`) rather than resolved a second
 * time, so the two cannot disagree and the page makes no extra request. The
 * snapshot is already confined to the member's sites (`confineSnapshot` in
 * `/api/workspace`), and this can only narrow it further — never widen it.
 */

import { complianceDay, expiryStatus } from "./expiry-status";
import { memberSiteSet, withinMemberScope } from "./member-site-scope";

/**
 * Where the timeline's sites come from, as the Compliance block reports them.
 *
 * `loading`: the block has not answered yet, so which sites the page is about is
 * not known — nothing is counted rather than the whole workspace for a moment.
 * `failed`: the block could not read this selection. `ready`: `siteIds` is the
 * resolved set (`null`: no narrowing); `pending` is true while the block is
 * reading a newly chosen portfolio and these are still the previous one's.
 */
export type ExpiryTimelineScope =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; siteIds: readonly string[] | null; pending: boolean; portfolioChosen: boolean };

export type ExpiryTimelineSlot = { key: string; label: string; count: number };

export type ExpiryTimeline = {
  /** The next twelve Europe/London months, this one first, zeros included. */
  slots: ExpiryTimelineSlot[];
  /** Records `expiryStatus` calls lapsed today. */
  expired: number;
  /** Records falling due inside the twelve slots. */
  total: number;
};

/**
 * The payload's site list, read back as a scope.
 *
 * Dashboard payloads carry the DRILL copy of the resolved list (`drillSiteIds`
 * in `job-metrics.ts`): `[]` means nothing to narrow (the resolver's `null`),
 * and a portfolio that resolved to no sites is `[NO_SITE_IN_SCOPE]`, a sentinel
 * no record carries — so it filters to nothing, as it must.
 */
export function scopeFromPayloadSiteIds(siteIds: readonly string[] | null | undefined): readonly string[] | null {
  return siteIds && siteIds.length > 0 ? siteIds : null;
}

/**
 * The records on the scope's sites — the same predicate the register's routes
 * apply to `register.entries`. `null` keeps every record; a record with no site
 * is outside any narrowed scope (`withinMemberScope`).
 */
export function recordsInScope<T extends { siteId: string | null | undefined }>(
  records: readonly T[],
  siteIds: readonly string[] | null,
): T[] {
  const allowed = memberSiteSet(siteIds);
  return allowed ? records.filter((record) => withinMemberScope(allowed, record.siteId)) : [...records];
}

/**
 * Twelve months forward from `now`, counted with the register's day and the
 * register's classifier.
 *
 * Months are Europe/London months and "expired" is `expiryStatus`'s verdict, the
 * one every compliance surface prints — so a certificate due today counts as due,
 * not lapsed, exactly as the register says "Expires today". A record with no
 * readable expiry is counted nowhere.
 */
export function expiryTimeline(records: readonly { expiry: string | null | undefined }[], now: Date): ExpiryTimeline {
  const [thisYear, thisMonth] = complianceDay(now).split("-").map(Number);
  const slots: ExpiryTimelineSlot[] = [];
  for (let offset = 0; offset < 12; offset += 1) {
    const date = new Date(Date.UTC(thisYear, thisMonth - 1 + offset, 1));
    slots.push({
      key: `${date.getUTCFullYear()}-${date.getUTCMonth()}`,
      label: date.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }),
      count: 0,
    });
  }
  const index = new Map(slots.map((slot) => [slot.key, slot]));

  let expired = 0;
  for (const record of records) {
    const status = expiryStatus(record.expiry, now);
    if (status.date === null || status.daysRemaining === null) continue;
    if (status.daysRemaining < 0) {
      expired += 1;
      continue;
    }
    const [year, month] = status.date.split("-").map(Number);
    const slot = index.get(`${year}-${month - 1}`);
    if (slot) slot.count += 1;
  }
  const total = slots.reduce((sum, slot) => sum + slot.count, 0);
  return { slots, expired, total };
}
