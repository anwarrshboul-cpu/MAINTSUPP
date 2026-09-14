/**
 * THE ASSET REGISTER AS A SPREADSHEET.
 *
 * ── WHY `finance/exports.ts` AND NOT `lib/csv.ts` ──────────────────────────
 *
 * This product has two CSV writers and they differ on exactly one thing that
 * matters here. `app/lib/csv.ts` — which the board, the site register and the
 * options export all use — quotes conditionally and does NO formula
 * neutralisation, so a cell beginning `=` or `@` reaches Excel as a formula.
 * `app/lib/finance/exports.ts` quotes every cell and prefixes the dangerous
 * starters with an apostrophe, while deliberately leaving a plain number alone
 * so `-1234.56` stays a negative figure rather than becoming text.
 *
 * An asset register is operator-typed free text from end to end — names, models,
 * part numbers, locations, supplier references, replacement notes — which is
 * precisely the input a formula-injection defence exists for. So it uses the
 * protected writer, as the compliance and reports exports already do.
 *
 * The unprotected writer is left exactly as it is. Changing `escapeCell` there
 * would alter the bytes of three existing exports that tests pin, and the
 * negative-number exception above shows the change is not the one-liner it
 * looks like. That is a real gap in those three and it is named here rather
 * than quietly widened into this one.
 *
 * ── SCOPE ──────────────────────────────────────────────────────────────────
 *
 * `data.export` is the capability, matching every other export in the product —
 * and note that a `client` HOLDS it by default, which is the point: a client
 * may download their own operational data. What they may not do is download
 * somebody else's, so the rows are narrowed by the tenant AND by the
 * membership's site restriction, and the filters the screen was showing are
 * applied so the file matches what the person was looking at.
 */

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { contractors, sites, units } from "../../../../db/schema";
import {
  anonymousRefusal,
  busyRefusal,
  scopedDbWithCapability,
} from "../../../lib/tenant-db";
import { auditActor, recordAudit } from "../../../lib/audit";
import { csvDocument, csvDownload } from "../../../lib/finance/exports";
import { assetKindLabel, parseSpecs, specsSummary } from "../../../lib/asset-model";

export const dynamic = "force-dynamic";

const HEADERS = [
  "Asset number",
  "Asset name",
  "Site",
  "Kind",
  "Category",
  "Status",
  "Manufacturer",
  "Model",
  "Part number",
  "Serial number",
  "Specification",
  "Colour / paint reference",
  "Supplier",
  "Supplier reference",
  "Location in site",
  "Quantity",
  "Installed",
  "Warranty expiry",
  "Last replaced",
  "Replacement part number",
  "Replacement model",
  "Replacement notes",
  "Replacement cost",
  "Updated",
] as const;

/** Integer pence as `1234.56`, with no float in the conversion. */
function pounds(pence: number | null): string {
  if (pence === null || pence === undefined) return "";
  const sign = pence < 0 ? "-" : "";
  const abs = Math.abs(pence);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function text(value: unknown, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * A repeated query parameter as a bounded, de-duplicated list.
 *
 * Capped at 60 values so a hand-made URL cannot turn one export into a query
 * carrying hundreds of bound variables — D1's limit is around a hundred, and
 * this product has already met it once on the contractor register.
 */
function list(values: string[], max: number) {
  return [...new Set(values.map((value) => text(value, max)).filter(Boolean))].slice(0, 60);
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "data.export");
    if (guard.denied) return guard.denied;
    const { db, orgId, siteScope } = guard.scope;

    const url = new URL(request.url);
    /*
     * REPEATED PARAMETERS, never comma-joined — the convention the filter bar
     * uses, and the only one that survives a value containing a comma. "OR
     * within a dimension, AND across dimensions", exactly as the screen reads.
     *
     * This used to read one value per dimension, so choosing two kinds on the
     * screen silently exported all four. A filter bar whose export ignores half
     * of it is worse than one with no export at all.
     */
    const siteIds = list(url.searchParams.getAll("siteId"), 120);
    const kinds = list(url.searchParams.getAll("kind"), 40);
    const categories = list(url.searchParams.getAll("category"), 80);
    const statuses = list(url.searchParams.getAll("status"), 40);

    /*
     * The sites named in the query INTERSECT the member's restriction; they
     * never replace it. Asking only for stores outside the scope produces an
     * empty file, which is the honest answer, rather than widening.
     */
    const wanted =
      siteScope && siteScope.length
        ? siteIds.filter((id) => siteScope.includes(id))
        : siteIds;
    if (siteIds.length && !wanted.length) {
      return csvDownload("assets.csv", csvDocument(HEADERS, []));
    }

    const rows = await db
      .select({
        asset: units,
        siteName: sites.name,
        supplierName: contractors.name,
      })
      .from(units)
      /*
       * One join rather than a lookup per row: an export of several hundred
       * assets making one query each is the N+1 this product has already paid
       * for once on the contractors register.
       *
       * BOTH joins carry the organisation, not just the id. Neither column has
       * a foreign key behind it — `supplier_contractor_id` says so in the
       * schema, deliberately, so a deactivated contractor cannot take the asset
       * with it — and this estate was populated by an import. A row holding
       * another tenant's id is not something to rely on being impossible, and
       * the cost of the extra predicate is nothing.
       */
      .leftJoin(sites, and(eq(sites.id, units.siteId), eq(sites.organisationId, orgId)))
      .leftJoin(
        contractors,
        and(
          eq(contractors.id, units.supplierContractorId),
          eq(contractors.organisationId, orgId),
        ),
      )
      .where(
        and(
          eq(units.organisationId, orgId),
          isNull(units.deletedAt),
          wanted.length ? inArray(units.siteId, wanted) : undefined,
          kinds.length ? inArray(units.kind, kinds) : undefined,
          categories.length ? inArray(units.category, categories) : undefined,
          statuses.length ? inArray(units.status, statuses) : undefined,
          siteScope && siteScope.length ? inArray(units.siteId, siteScope) : undefined,
        ),
      )
      .orderBy(asc(sites.name), asc(units.name));

    const body = csvDocument(
      HEADERS,
      rows.map(({ asset, siteName, supplierName }) => [
        asset.assetNumber ?? "",
        asset.name,
        siteName ?? "",
        assetKindLabel(asset.kind),
        asset.category ?? "",
        asset.status ?? "",
        asset.manufacturer ?? "",
        asset.model ?? "",
        asset.partNumber ?? "",
        asset.serialNumber ?? "",
        /* The typed specifications are appended to the prose one, so a
           spreadsheet reader sees everything the detail screen shows without a
           column per possible measurement. */
        [asset.specification ?? "", specsSummary(parseSpecs(asset.specs))]
          .filter(Boolean)
          .join(" · "),
        [asset.colour ?? "", asset.colourCode ?? "", asset.paintReference ?? ""]
          .filter(Boolean)
          .join(" · "),
        supplierName ?? asset.supplier ?? "",
        asset.supplierReference ?? "",
        asset.locationInSite ?? "",
        asset.quantity ?? "",
        asset.installedAt ?? "",
        asset.warrantyExpiry ?? "",
        asset.lastReplacedAt ?? "",
        asset.replacementPartNumber ?? "",
        asset.replacementModel ?? "",
        asset.replacementNotes ?? "",
        pounds(asset.replacementCostPence),
        asset.updatedAt ?? "",
      ]),
    );

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor(guard.scope),
      action: "data.exported",
      entityType: "asset",
      summary: `Exported ${rows.length} asset${rows.length === 1 ? "" : "s"} as CSV.`,
      detail: { rows: rows.length, sites: wanted, kinds, categories, statuses },
      request,
    });

    return csvDownload("assets.csv", body);
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const busy = busyRefusal(error, "The asset export could not be produced.");
    if (busy) return busy;
    console.error("asset export failed", error);
    return Response.json(
      { error: "The asset export could not be produced." },
      { status: 503 },
    );
  }
}
