/**
 * TWO ONE-OFF TIDY-UPS OF THE SUNNAMUSK REGISTER (owner's decisions, 2026-10-06).
 *
 * 1. "The sites have to match exactly the number of sites on monday — no extra,
 *    no less." Six stores (Cambridge, Derby, SJQ Edinburgh, Mall of
 *    Scandinavia, Nacka, Täby) were created on 2026-10-04 only so their old
 *    Maintenance-board jobs had somewhere to point; they have no Store
 *    Documentation row. A seventh, "Anwar test", is a test. The owner chose:
 *    hide them and KEEP their jobs. `retireUnlistedSites` takes each such
 *    site off the register; its jobs stay on the board with their store name
 *    (the `location` text monday gave them) and point at `site-unassigned`, the
 *    product's existing "no site" marker. Their photos stay on the jobs.
 *
 * 2. "One asset per site." Twenty placeholder assets ("<store> — trading
 *    unit", "<store> — service assets") were seeded for ten stores before any
 *    real asset existed. `retirePlaceholderAssets` moves them to the Recycle
 *    Bin (restorable for 30 days) and points the planned visits that named one
 *    at that store's own asset instead.
 *
 * BOTH ARE DRY RUNS UNLESS `apply` IS TRUE, and both refuse to touch anything
 * that carries real work: a site with an invoice, quote, planned visit,
 * calendar event, service record, certificate on file, fee override or an asset
 * of its own is reported and left alone. Platform staff only — see the
 * `/api/integrations/monday` actions that call them.
 */

import { and, eq, inArray, isNotNull, isNull, like, ne, or, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  attachments,
  calendarEvents,
  complianceDocuments,
  contractorSites,
  invoices,
  maintenanceRequests,
  plannedMaintenance,
  quotations,
  serviceInvoiceLines,
  siteAliases,
  siteFeeOverrides,
  siteGroupMembers,
  sites,
  units,
  unitServiceRecords,
} from "../../db/schema";
import { sendAssetToBin } from "./recycle-bin";
import { siteUnitId, SITE_UNIT_PREFIX } from "./site-unit-values";
import { readStoreDocumentation } from "./store-register-sync";

type Database = Awaited<ReturnType<typeof getDb>>;

export const UNASSIGNED_SITE = "site-unassigned";

export type RetiredSite = {
  id: string;
  name: string;
  jobs: number;
  photos: number;
  removed: boolean;
  keptBecause?: string;
};

/** Sites on the canonical register that no live Store Documentation row names. */
export async function retireUnlistedSites(
  db: Database,
  organisationId: string,
  options: { apply: boolean },
): Promise<{ apply: boolean; storeDocumentationStores: number; sites: RetiredSite[] }> {
  const stores = await readStoreDocumentation(db, organisationId);
  const listed = new Set(stores.map((store) => store.siteId).filter((id): id is string => Boolean(id)));
  /* Without Store Documentation there is nothing to compare against: retire nothing. */
  if (!listed.size) return { apply: options.apply, storeDocumentationStores: 0, sites: [] };

  const candidates = (
    await db
      .select({ id: sites.id, name: sites.name })
      .from(sites)
      .where(and(eq(sites.organisationId, organisationId), isNull(sites.boardId)))
  ).filter((site) => !listed.has(site.id));

  const report: RetiredSite[] = [];
  for (const site of candidates) {
    const count = async (rows: Promise<Array<{ n: number }>>) => Number((await rows)[0]?.n ?? 0);
    const n = sql<number>`count(*)`;
    const blockers: Array<[string, number]> = [
      ["invoices", await count(db.select({ n }).from(invoices).where(and(eq(invoices.organisationId, organisationId), eq(invoices.siteId, site.id))))],
      ["quotes", await count(db.select({ n }).from(quotations).where(and(eq(quotations.organisationId, organisationId), eq(quotations.siteId, site.id))))],
      ["planned visits", await count(db.select({ n }).from(plannedMaintenance).where(and(eq(plannedMaintenance.organisationId, organisationId), eq(plannedMaintenance.siteId, site.id))))],
      ["calendar events", await count(db.select({ n }).from(calendarEvents).where(and(eq(calendarEvents.organisationId, organisationId), eq(calendarEvents.siteId, site.id))))],
      ["service records", await count(db.select({ n }).from(unitServiceRecords).where(and(eq(unitServiceRecords.organisationId, organisationId), eq(unitServiceRecords.siteId, site.id))))],
      ["invoice lines", await count(db.select({ n }).from(serviceInvoiceLines).where(and(eq(serviceInvoiceLines.organisationId, organisationId), eq(serviceInvoiceLines.siteId, site.id))))],
      ["fee overrides", await count(db.select({ n }).from(siteFeeOverrides).where(and(eq(siteFeeOverrides.organisationId, organisationId), eq(siteFeeOverrides.siteId, site.id))))],
      [
        "certificates on file",
        await count(
          db
            .select({ n })
            .from(complianceDocuments)
            .where(
              and(
                eq(complianceDocuments.organisationId, organisationId),
                eq(complianceDocuments.siteId, site.id),
                or(isNotNull(complianceDocuments.expiryDate), isNotNull(complianceDocuments.attachmentId)),
              ),
            ),
        ),
      ],
      [
        "assets of its own",
        await count(
          db
            .select({ n })
            .from(units)
            .where(and(eq(units.organisationId, organisationId), eq(units.siteId, site.id), ne(units.id, siteUnitId(site.id)))),
        ),
      ],
    ];
    const jobs = await count(
      db.select({ n }).from(maintenanceRequests).where(and(eq(maintenanceRequests.organisationId, organisationId), eq(maintenanceRequests.siteId, site.id))),
    );
    const photos = await count(
      db.select({ n }).from(attachments).where(and(eq(attachments.organisationId, organisationId), eq(attachments.siteId, site.id))),
    );
    const blocking = blockers.filter(([, total]) => total > 0);
    if (blocking.length) {
      report.push({
        ...site,
        jobs,
        photos,
        removed: false,
        keptBecause: blocking.map(([what, total]) => `${total} ${what}`).join(", "),
      });
      continue;
    }
    if (options.apply) {
      /* The jobs and their photos stay; only the link to the site goes. */
      await db
        .update(maintenanceRequests)
        .set({ siteId: UNASSIGNED_SITE })
        .where(and(eq(maintenanceRequests.organisationId, organisationId), eq(maintenanceRequests.siteId, site.id)));
      await db
        .update(attachments)
        .set({ siteId: null })
        .where(and(eq(attachments.organisationId, organisationId), eq(attachments.siteId, site.id)));
      await db.delete(siteAliases).where(and(eq(siteAliases.organisationId, organisationId), eq(siteAliases.siteId, site.id)));
      await db.delete(siteGroupMembers).where(and(eq(siteGroupMembers.organisationId, organisationId), eq(siteGroupMembers.siteId, site.id)));
      await db.delete(contractorSites).where(and(eq(contractorSites.organisationId, organisationId), eq(contractorSites.siteId, site.id)));
      /* Empty certificate slots only — a slot with a date or a file blocked above. */
      await db
        .delete(complianceDocuments)
        .where(and(eq(complianceDocuments.organisationId, organisationId), eq(complianceDocuments.siteId, site.id)));
      await db.delete(units).where(and(eq(units.organisationId, organisationId), eq(units.id, siteUnitId(site.id))));
      await db.delete(sites).where(and(eq(sites.organisationId, organisationId), eq(sites.id, site.id)));
    }
    report.push({ ...site, jobs, photos, removed: options.apply });
  }
  return { apply: options.apply, storeDocumentationStores: listed.size, sites: report };
}

const PLACEHOLDER_NOTES = [
  "Customer-facing operational unit",
  "Shared mechanical, electrical and safety assets",
];

/** The seeded "<store> — trading unit" / "— service assets" rows, to the Recycle Bin. */
export async function retirePlaceholderAssets(
  db: Database,
  organisationId: string,
  actor: { email: string | null; displayName: string | null },
  options: { apply: boolean },
): Promise<{ apply: boolean; assets: Array<{ id: string; name: string; plannedVisitsMoved: number; binned: boolean }> }> {
  const rows = await db
    .select({ id: units.id, name: units.name, siteId: units.siteId, notes: units.notes })
    .from(units)
    .where(
      and(
        eq(units.organisationId, organisationId),
        isNull(units.deletedAt),
        or(like(units.id, "%-retail"), like(units.id, "%-services")),
        inArray(units.notes, PLACEHOLDER_NOTES),
      ),
    );
  const placeholders = rows.filter(
    (row) => !row.id.startsWith(SITE_UNIT_PREFIX) && (row.id === `${row.siteId}-retail` || row.id === `${row.siteId}-services`),
  );
  const out: Array<{ id: string; name: string; plannedVisitsMoved: number; binned: boolean }> = [];
  for (const row of placeholders) {
    const visits = await db
      .select({ id: plannedMaintenance.id })
      .from(plannedMaintenance)
      .where(and(eq(plannedMaintenance.organisationId, organisationId), eq(plannedMaintenance.unitId, row.id)));
    let binned = false;
    if (options.apply) {
      if (visits.length) {
        await db
          .update(plannedMaintenance)
          .set({ unitId: siteUnitId(row.siteId) })
          .where(and(eq(plannedMaintenance.organisationId, organisationId), eq(plannedMaintenance.unitId, row.id)));
      }
      binned = await sendAssetToBin(db, organisationId, actor, row.id);
    }
    out.push({ id: row.id, name: row.name, plannedVisitsMoved: visits.length, binned });
  }
  return { apply: options.apply, assets: out };
}
