/**
 * WHAT A SITE ROW HAS TO SAY BEYOND ITS REGISTRY FIELDS.
 *
 * The Sites page listed Code, Type, Status, Town and Manager, and rarely any
 * two of those change in a year. Nothing on it told you which store had 26 open
 * jobs, which was 70% compliant or which had spent £26,756 — all of which this
 * product already knows. This module is that half: the operational payload,
 * counted in the database, that turns a registry into a screen worth opening.
 *
 * The open-job counts come from `job-metrics.ts` and the compliance figures
 * from `compliance-status.ts`, which is what stops the Sites page disagreeing
 * with the Overview or the Compliance register about the same store.
 *
 * ── PLACEHOLDER VALUES ARE NOT VALUES ─────────────────────────────────────
 *
 * Seed data reached production. Managers read `Sample Manager F` and
 * `Sample Manager C`, and contractor contacts read `ops@climate-response.example`
 * — the `.example` TLD is reserved by RFC 2606 and cannot receive mail, so the
 * address on screen is guaranteed not to work. Rendering either as though it
 * were real is worse than rendering it as missing: somebody phones a manager
 * who does not exist, or emails an address that bounces into nothing.
 *
 * Both are detected HERE, once, so the Sites list, the site detail, the
 * contractor register and the compliance responsibility line all treat them the
 * same way.
 */

import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { maintenanceRequests } from "../../db/schema";
import { closedJobSql } from "./dashboard-aggregates";
import { jobsBoardCondition } from "./dashboard-filters";
import { complianceCompletion, type ComplianceCompletion } from "./compliance-status";
import { selectInChunks } from "./sql-batching";
import { mailtoHref } from "./contact-links";
import type { ComplianceState } from "./types";

type Database = Awaited<ReturnType<typeof getDb>>;

/* ── Placeholders ─────────────────────────────────────────────────────────── */

/**
 * A seeded manager name, matched on the pattern the seeder writes.
 *
 * Anchored at the start and case-insensitive, because the only thing that can
 * be said with confidence about `Sample Manager F` is how it was generated. A
 * looser match — anything containing "sample" — would erase a real person at a
 * store called Sample Works, and a tighter one would miss the next letter the
 * seeder reaches.
 */
export function isPlaceholderManager(value: string | null | undefined): boolean {
  return /^sample manager\b/i.test((value ?? "").trim());
}

/**
 * A contact address that cannot receive mail.
 *
 * `.example`, `.test`, `.invalid` and `.localhost` are reserved by RFC 2606 and
 * RFC 6761 precisely so that they can never resolve. An address ending in one
 * is not a contact detail somebody forgot to update; it is a value that is
 * guaranteed to fail, and showing it as a mailto link invites somebody to send
 * mail into nothing.
 */
export function isUnreachableEmail(value: string | null | undefined): boolean {
  const email = (value ?? "").trim();
  if (!email.includes("@")) return false;
  /*
   * Delegated, not re-tested. `contact-links` decides whether a value may
   * become something a user can act on, and this is the same question asked
   * from the server: a second copy of the pattern here could accept an address
   * the browser refuses to link, and the row would then report a contact that
   * the drawer beside it refuses to offer.
   */
  return mailtoHref(email) === null;
}

/** The real manager name, or null when the register only holds a placeholder. */
export function realManagerName(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const value = (candidate ?? "").trim();
    if (!value) continue;
    if (isPlaceholderManager(value)) continue;
    return value;
  }
  return null;
}

/* ── Field completeness ───────────────────────────────────────────────────── */

/**
 * The registry fields a site row surfaces, and which of them are actually set.
 *
 * The list is short on purpose: it is the fields somebody has to fill in for
 * the row to be useful, not every column on the table. A placeholder manager
 * counts as MISSING, which is the whole point — it looked complete and was not.
 */
export const SITE_DETAIL_FIELDS = ["code", "type", "town", "postcode", "manager"] as const;

export type SiteDetailField = (typeof SITE_DETAIL_FIELDS)[number];

export type SiteCompleteness = {
  missing: SiteDetailField[];
  /** True when every field in `SITE_DETAIL_FIELDS` carries a real value. */
  complete: boolean;
};

export function siteCompleteness(site: {
  code?: string | null;
  siteTypeValue?: string | null;
  type?: string | null;
  city?: string | null;
  postcode?: string | null;
  managerName?: string | null;
  manager?: string | null;
}): SiteCompleteness {
  const missing: SiteDetailField[] = [];
  const set = (value: string | null | undefined) => Boolean((value ?? "").trim());
  if (!set(site.code)) missing.push("code");
  if (!set(site.siteTypeValue) && !set(site.type)) missing.push("type");
  if (!set(site.city)) missing.push("town");
  if (!set(site.postcode)) missing.push("postcode");
  if (!realManagerName(site.managerName, site.manager)) missing.push("manager");
  return { missing, complete: missing.length === 0 };
}

/* ── Operational counts ───────────────────────────────────────────────────── */

export type SiteMetrics = {
  openJobs: number;
  urgentOpen: number;
  totalJobs: number;
  spend: number;
  compliance: ComplianceCompletion;
};

const EMPTY_COMPLETION: ComplianceCompletion = {
  satisfied: 0,
  applicable: 0,
  notRequired: 0,
  total: 0,
  percent: 0,
  scored: false,
  /* A site absent from the register has no requirements at all, which is not
     the same as having requirements nobody has claimed. `total: 0` with
     `excluded: 0` is what lets a screen say "No requirements set" here and
     "Not yet confirmed" for a site that has twelve of them and no answers. */
  excluded: 0,
  counts: {
    Compliant: 0,
    "Expiring soon": 0,
    Expired: 0,
    Missing: 0,
    "Not required": 0,
  },
};

/**
 * Open, urgent, total and spend per site, in ONE aggregate.
 *
 * The alternative — and what the register did — is to fetch every job and count
 * them in the browser. On this estate that is a thousand rows to draw ten
 * meters. `GROUP BY site_id` returns one row per site with four numbers on it.
 *
 * Sites with no jobs get a zero rather than being absent, because a site with
 * no work is an ANSWER and a site missing from the list is a bug. The caller
 * passes the ids it wants and gets every one of them back.
 */
export async function loadSiteMetrics(
  db: Database,
  orgId: string,
  siteIds: readonly string[],
  /* `dutyHolder` is declared, not merely tolerated. Structural typing let the
     narrower shape compile while the real `ComplianceItem[]` carried the field
     through to `complianceCompletion` at runtime — so the score was right and
     the signature was quietly lying about what this function depends on. */
  complianceBySite: ReadonlyMap<
    string,
    Array<{ state: ComplianceState; dutyHolder?: string | null }>
  >,
): Promise<Map<string, SiteMetrics>> {
  const out = new Map<string, SiteMetrics>();
  for (const id of siteIds) {
    out.set(id, {
      openJobs: 0,
      urgentOpen: 0,
      totalJobs: 0,
      spend: 0,
      compliance: complianceBySite.has(id)
        ? complianceCompletion(complianceBySite.get(id)!)
        : EMPTY_COMPLETION,
    });
  }
  if (!siteIds.length) return out;

  /*
   * CHUNKED, BECAUSE THE ESTATE OUTGREW THE STATEMENT.
   *
   * `IN (…)` binds one variable per element, and this statement carries
   * thirteen others of its own — four closed-stage strings twice over, three
   * priority strings, the organisation and the archived flag. At 89 sites that
   * is 102 variables and D1 refuses the lot:
   *
   *   D1_ERROR: too many SQL variables at offset 885
   *
   * The whole site register then answers 503 rather than one site's meter
   * reading zero, because `GET /api/sites?id=` needs this aggregate before it
   * can render anything. Measured on the development estate, which has
   * accumulated 87 sites of fixture residue — one more site was enough to cross
   * the line, and nothing in the code got worse to make that happen. That is
   * the whole hazard of an unchunked `IN`: it is correct right up until an
   * ordinary day's data makes it fail, and the failure is total.
   *
   * `selectInChunks` is the helper this repository already reaches for, for
   * this exact reason — see `attachment-counts.ts` and `board-mutations.ts`.
   * `GROUP BY site_id` makes the split free: each chunk returns whole rows for
   * its own sites, so concatenating them needs no merge step.
   */
  const rows = await selectInChunks(siteIds, (chunk) =>
    db
      .select({
        siteId: maintenanceRequests.siteId,
        totalJobs: count(),
        openJobs: sql<number>`sum(case when not ${closedJobSql} then 1 else 0 end)`,
        urgentOpen: sql<number>`sum(case when not ${closedJobSql} and lower(trim(${maintenanceRequests.priority})) in ${["urgent", "critical", "p1"]} then 1 else 0 end)`,
        spend: sql<number>`coalesce(sum(${maintenanceRequests.cost}), 0)`,
      })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          isNull(maintenanceRequests.deletedAt),
          eq(maintenanceRequests.archived, false),
          isNull(maintenanceRequests.parentId),
          // Binds nothing (see `jobsBoardCondition`), so the count below stands.
          jobsBoardCondition(),
          inArray(maintenanceRequests.siteId, chunk),
        ),
      )
      .groupBy(maintenanceRequests.siteId),
    /*
     * NOT the default 90, and the arithmetic is the reason. `SQL_VARIABLE_CHUNK`
     * is documented as leaving "a comfortable margin under the 100-variable
     * floor for the handful of other bound values in the same statement" —
     * organisation, board, flags. This statement carries THIRTEEN of them, so
     * 90 ids would bind 103 and reintroduce the very failure being fixed, one
     * chunk at a time and with a comment claiming it was safe. 80 leaves seven
     * spare on top of the thirteen.
     */
    80,
  );

  for (const row of rows) {
    const id = (row.siteId ?? "").trim();
    const current = out.get(id);
    if (!current) continue;
    current.totalJobs = Number(row.totalJobs ?? 0);
    current.openJobs = Number(row.openJobs ?? 0);
    current.urgentOpen = Number(row.urgentOpen ?? 0);
    current.spend = Number(row.spend ?? 0);
  }
  return out;
}
