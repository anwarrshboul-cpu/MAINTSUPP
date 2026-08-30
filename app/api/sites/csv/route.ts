import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { sites } from "../../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../../lib/tenant-db";
import { csvResponse, parseCsvObjects, toCsv } from "../../../lib/csv";
import { siteWriteFailure } from "../route";
import { listOptionValues } from "../../../lib/options-repository";
import {
  cleanAddress,
  codeConflict,
  existingSiteCodes,
  generateSiteCode,
  junkReason,
  listSites,
  nextSitePosition,
  normaliseSiteName,
  recordAnomaly,
  resolveSiteByName,
  setSiteAliases,
  uniqueSlug,
} from "../../../lib/sites-repository";

/**
 * Column order is also the import template. Exporting, editing in Excel and
 * re-importing must round-trip without loss, so every writable field appears.
 */
const COLUMNS = [
  "name",
  "code",
  "site_type",
  "status",
  "address_line1",
  "address_line2",
  "city",
  "postcode",
  "country",
  "latitude",
  "longitude",
  // Writable through the Sites form and NOT previously in this template, so an
  // export/re-import round trip reset every non-UK site to 'UK'. See
  // `COLUMN_TARGETS` below for what the importer now does with it.
  "region",
  "manager_name",
  "manager_phone",
  "manager_email",
  "landlord",
  "managing_agent",
  "out_of_hours_contact",
  "access_method",
  "access_contact",
  "access_url",
  "access_notes",
  "opening_hours",
  "delivery_restrictions",
  "parking_notes",
  "key_alarm_notes",
  "lease_start",
  "lease_end",
  "break_clause",
  "rent_review",
  "service_charge_pounds",
  "monday_maintenance_name",
  "monday_compliance_name",
  "notes",
];

function cell(row: Record<string, string>, key: string) {
  return (row[key] ?? "").trim();
}

function optional(value: string) {
  return value.length ? value : null;
}

/**
 * Which stored columns each sheet column speaks for.
 *
 * Kept beside `COLUMNS` above, because the two are one table: a header that
 * exports but does not appear here can never be imported, and a header here
 * that `COLUMNS` does not emit cannot survive a round trip.
 *
 * `status` names only `status`. Its Stage 0 twins are handled separately in
 * `sheetUpdate` because they must not move when the status does not.
 */
const COLUMN_TARGETS: Record<string, readonly string[]> = {
  name: ["name"],
  code: ["code"],
  site_type: ["siteTypeValue", "type"],
  status: ["status"],
  address_line1: ["addressLine1"],
  address_line2: ["addressLine2"],
  city: ["city"],
  postcode: ["postcode"],
  country: ["country"],
  latitude: ["latitude"],
  longitude: ["longitude"],
  region: ["region"],
  manager_name: ["managerName", "manager"],
  manager_phone: ["managerPhone"],
  manager_email: ["managerEmail"],
  landlord: ["landlord"],
  managing_agent: ["managingAgent"],
  out_of_hours_contact: ["outOfHoursContact"],
  access_method: ["accessMethod"],
  access_contact: ["accessContact"],
  access_url: ["accessUrl"],
  access_notes: ["accessNotes"],
  opening_hours: ["openingHours"],
  delivery_restrictions: ["deliveryRestrictions"],
  parking_notes: ["parkingNotes"],
  key_alarm_notes: ["keyAlarmNotes"],
  lease_start: ["leaseStart"],
  lease_end: ["leaseEnd"],
  break_clause: ["breakClause"],
  rent_review: ["rentReview"],
  service_charge_pounds: ["serviceChargePence"],
  monday_maintenance_name: ["mondayMaintenanceName"],
  monday_compliance_name: ["mondayComplianceName"],
  notes: ["notes"],
};

const ADDRESS_HEADERS = ["address_line1", "address_line2", "city", "postcode"] as const;

/**
 * AN IMPORT MAY ONLY CHANGE THE COLUMNS ITS SHEET CARRIES.
 *
 * THE BUG THIS FIXES. `parseCsvObjects` keys each record by the headers the
 * uploaded file actually has, so a column the sheet omits is simply an absent
 * key — and `cell()` answers an absent key exactly as it answers a blank one,
 * with `""`. `optional("")` is `null`, `Number("")` is not finite so latitude
 * and longitude are `null`, and the update branch then wrote the WHOLE object.
 * So a narrow sheet — `name,address_line1,status`, the fewest columns
 * `junkReason` will accept — did not update three columns; it nulled every
 * optional field on every matched site, emptied its coordinates, and reset
 * `region` to 'UK'. The same destruction `preserveUnsent` was written to stop
 * on the form path, arriving by CSV.
 *
 * ABSENT AND BLANK STAY DIFFERENT. A sheet that carries `postcode` with an
 * empty cell is an admin clearing a postcode and still clears it; a sheet with
 * no `postcode` column at all says nothing about postcodes and changes none.
 * That is what makes an import a full statement about its own columns without
 * making it a full statement about the register.
 *
 * The INSERT branch is untouched. A new row has nothing to preserve and the
 * defaults are correct there, the same reasoning as POST /api/sites.
 */
function sheetUpdate(
  values: Record<string, unknown>,
  headers: Set<string>,
  existing: Record<string, unknown>,
) {
  const update: Record<string, unknown> = { updatedAt: values.updatedAt };
  for (const [header, targets] of Object.entries(COLUMN_TARGETS)) {
    if (!headers.has(header)) continue;
    for (const target of targets) update[target] = values[target];
  }

  /*
   * The Stage 0 twins move only when the status the sheet carries actually
   * differs from the one on record. `status` also carries 'other' and
   * 'international', which the closed/open derivation cannot express, and the
   * register already holds legacy rows recorded as `status='other'` with
   * `lifecycle='Closed'`. Re-deriving on a re-import would promote them. Same
   * rule as PATCH /api/sites.
   */
  if (headers.has("status") && values.status !== existing.status) {
    update.lifecycle = values.lifecycle;
    update.active = values.active;
  }

  /*
   * 'international' is the one status that also states a region, and the
   * "Europe" reporting group is keyed on `region`. It may SET Europe; it may
   * never reset a stored region to 'UK', which was the guess that flattened
   * every non-UK site on import.
   */
  if (!headers.has("region") && headers.has("status") && values.status === "international") {
    update.region = "Europe";
  }

  // `address` is the Stage 0 composite of the four columns above it. Rebuilt
  // from the MERGED row, so a sheet carrying only `city` does not drop the
  // house number, and left alone entirely by a sheet carrying none of them.
  if (ADDRESS_HEADERS.some((header) => headers.has(header))) {
    const merged = { ...existing, ...update };
    update.address = [merged.addressLine1, merged.addressLine2, merged.city, merged.postcode]
      .filter(Boolean)
      .join(", ")
      .slice(0, 300);
  }

  return update;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    /*
     * `data.export` decides something now.
     *
     * A CSV of the site register is the whole register in one file — names,
     * addresses, managers, access notes — leaving the product in a form nobody
     * can recall. "Download boards, sites and reports as CSV" is what the
     * matrix promised to control, and it controlled nothing.
     */
    const guard = await scopedDbWithCapability(request, "data.export");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const rows = await listSites(db, orgId, { includeInactive: true });
    const body = toCsv(
      COLUMNS,
      rows.map((site) => ({
        name: site.name,
        code: site.code ?? "",
        site_type: site.siteTypeValue ?? site.type,
        status: site.status,
        address_line1: site.addressLine1 ?? site.address,
        address_line2: site.addressLine2 ?? "",
        city: site.city ?? "",
        postcode: site.postcode ?? "",
        country: site.country,
        latitude: site.latitude ?? "",
        longitude: site.longitude ?? "",
        region: site.region,
        manager_name: site.managerName ?? "",
        manager_phone: site.managerPhone ?? "",
        manager_email: site.managerEmail ?? "",
        landlord: site.landlord ?? "",
        managing_agent: site.managingAgent ?? "",
        out_of_hours_contact: site.outOfHoursContact ?? "",
        access_method: site.accessMethod ?? "",
        access_contact: site.accessContact ?? "",
        access_url: site.accessUrl ?? "",
        access_notes: site.accessNotes ?? "",
        opening_hours: site.openingHours ?? "",
        delivery_restrictions: site.deliveryRestrictions ?? "",
        parking_notes: site.parkingNotes ?? "",
        key_alarm_notes: site.keyAlarmNotes ?? "",
        lease_start: site.leaseStart ?? "",
        lease_end: site.leaseEnd ?? "",
        break_clause: site.breakClause ?? "",
        rent_review: site.rentReview ?? "",
        service_charge_pounds:
          site.serviceChargePence === null ? "" : (site.serviceChargePence / 100).toFixed(2),
        monday_maintenance_name: site.mondayMaintenanceName ?? "",
        monday_compliance_name: site.mondayComplianceName ?? "",
        notes: site.notes ?? "",
      })),
    );
    const stamp = new Date().toISOString().slice(0, 10);
    return csvResponse(`maintsupp-sites-${stamp}.csv`, body);
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const failure = siteWriteFailure(error, "Sites could not be exported.");
    return Response.json({ error: failure.message }, { status: 503 });
  }
}

type ImportOutcome = {
  created: number;
  updated: number;
  skipped: Array<{ row: number; name: string; reason: string }>;
  cleaned: Array<{ row: number; name: string; field: string; from: string; to: string }>;
};

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "data.import");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId } = guard.scope;
    const body = (await request.json()) as { csv?: string; dryRun?: boolean };
    const csv = typeof body.csv === "string" ? body.csv : "";
    if (!csv.trim()) throw new Error("No CSV content was supplied.");

    const dryRun = body.dryRun !== false;
    const records = parseCsvObjects(csv);
    if (!records.length) throw new Error("The CSV contained no data rows.");

    /*
     * The headers the uploaded sheet actually has. `parseCsvObjects` gives
     * every record the same key set — the file's own header row — so the first
     * record names them, and this is what tells an ABSENT column from a BLANK
     * cell further down. Read once rather than per row.
     */
    const headers = new Set(Object.keys(records[0]));

    const [siteTypes, statuses] = await Promise.all([
      listOptionValues(db, orgId, "site_type"),
      listOptionValues(db, orgId, "site_status"),
    ]);
    const typeValues = new Set(siteTypes.map((entry) => entry.value));
    const statusValues = new Set(statuses.map((entry) => entry.value));
    const defaultType = siteTypes.find((e) => e.isDefault)?.value ?? siteTypes[0]?.value ?? "";
    const defaultStatus = statuses.find((e) => e.isDefault)?.value ?? "active";

    const batchId = `csv-${Date.now().toString(36)}`;
    const outcome: ImportOutcome = { created: 0, updated: 0, skipped: [], cleaned: [] };
    const seenInFile = new Set<string>();
    const seenCodesInFile = new Set<string>();

    for (const [index, record] of records.entries()) {
      const rowNumber = index + 2; // header is row 1
      const name = cell(record, "name");
      const rawAddress = cell(record, "address_line1");
      const address = cleanAddress(rawAddress);

      // X13 — placeholders never become sites.
      const junk = junkReason(name, address.value);
      if (junk) {
        outcome.skipped.push({ row: rowNumber, name: name || "(blank)", reason: junk });
        if (!dryRun) {
          await recordAnomaly(db, orgId, {
            batchId,
            entityType: "site",
            sourceName: name,
            kind: "junk_row_rejected",
            detail: junk,
          });
        }
        continue;
      }

      const key = normaliseSiteName(name);
      if (seenInFile.has(key)) {
        outcome.skipped.push({
          row: rowNumber,
          name,
          reason: "The same site appears more than once in this file.",
        });
        continue;
      }
      seenInFile.add(key);

      // X12 — log the correction rather than applying it silently.
      if (address.changed) {
        outcome.cleaned.push({
          row: rowNumber,
          name,
          field: "address_line1",
          from: rawAddress,
          to: address.value,
        });
      }

      const rawType = cell(record, "site_type");
      const rawStatus = cell(record, "status");
      if (rawType && !typeValues.has(rawType)) {
        outcome.skipped.push({
          row: rowNumber,
          name,
          reason: `"${rawType}" is not a configured site type. Add it in Settings, then re-import.`,
        });
        continue;
      }
      if (rawStatus && !statusValues.has(rawStatus)) {
        outcome.skipped.push({
          row: rowNumber,
          name,
          reason: `"${rawStatus}" is not a configured site status.`,
        });
        continue;
      }

      const siteTypeValue = rawType || defaultType;
      const status = rawStatus || defaultStatus;
      const serviceChargePounds = cell(record, "service_charge_pounds");
      const parsedCharge = serviceChargePounds ? Number(serviceChargePounds) : NaN;

      const values = {
        name,
        code: optional(cell(record, "code")),
        siteTypeValue,
        status,
        addressLine1: address.value,
        addressLine2: optional(cell(record, "address_line2")),
        city: optional(cell(record, "city")),
        postcode: optional(cell(record, "postcode")),
        country: cell(record, "country") || "United Kingdom",
        latitude: Number.isFinite(Number(cell(record, "latitude")))
          && cell(record, "latitude") ? Number(cell(record, "latitude")) : null,
        longitude: Number.isFinite(Number(cell(record, "longitude")))
          && cell(record, "longitude") ? Number(cell(record, "longitude")) : null,
        managerName: optional(cell(record, "manager_name")),
        managerPhone: optional(cell(record, "manager_phone")),
        managerEmail: optional(cell(record, "manager_email")),
        landlord: optional(cell(record, "landlord")),
        managingAgent: optional(cell(record, "managing_agent")),
        outOfHoursContact: optional(cell(record, "out_of_hours_contact")),
        accessMethod: optional(cell(record, "access_method")),
        accessContact: optional(cell(record, "access_contact")),
        accessUrl: optional(cell(record, "access_url")),
        accessNotes: optional(cell(record, "access_notes")),
        openingHours: optional(cell(record, "opening_hours")),
        deliveryRestrictions: optional(cell(record, "delivery_restrictions")),
        parkingNotes: optional(cell(record, "parking_notes")),
        keyAlarmNotes: optional(cell(record, "key_alarm_notes")),
        leaseStart: optional(cell(record, "lease_start")),
        leaseEnd: optional(cell(record, "lease_end")),
        breakClause: optional(cell(record, "break_clause")),
        rentReview: optional(cell(record, "rent_review")),
        serviceChargePence: Number.isFinite(parsedCharge) ? Math.round(parsedCharge * 100) : null,
        mondayMaintenanceName: optional(cell(record, "monday_maintenance_name")),
        mondayComplianceName: optional(cell(record, "monday_compliance_name")),
        notes: optional(cell(record, "notes")),
        type: siteTypeValue,
        lifecycle: status === "closed" ? "Closed" : "Current",
        active: status !== "closed",
        // The sheet's own answer wins. The derivation stays as the fallback a
        // NEW row needs when the template carries no region column.
        region: cell(record, "region") || (status === "international" ? "Europe" : "UK"),
        // Four parts, matching POST/PATCH /api/sites. This dropped
        // `address_line2` and the other writer keeps it, so the same site read
        // back a shorter address after an import than after a form save.
        address: [
          address.value,
          cell(record, "address_line2"),
          cell(record, "city"),
          cell(record, "postcode"),
        ]
          .filter(Boolean)
          .join(", ")
          .slice(0, 300),
        manager: optional(cell(record, "manager_name")),
        updatedAt: new Date().toISOString(),
      };

      // X11 — match on canonical name, either monday name, or a stored alias,
      // so a re-import updates the existing site rather than duplicating it.
      const existing =
        (await resolveSiteByName(db, orgId, name)) ??
        (values.mondayMaintenanceName
          ? await resolveSiteByName(db, orgId, values.mondayMaintenanceName)
          : null) ??
        (values.mondayComplianceName
          ? await resolveSiteByName(db, orgId, values.mondayComplianceName)
          : null);

      /*
       * A code is an identity, and this importer used to be the way around that.
       *
       * `seenInFile` deduplicates NAMES and always has; nothing checked codes,
       * and nothing here called `codeConflict`. So a single two-row sheet naming
       * one code twice created two sites wearing it — no concurrency needed —
       * and `resolveSiteByName`, which matches on code and returns the first row
       * it finds, then had no way to say which shop a job meant.
       *
       * Checked AFTER `existing` is resolved, and excluding it, because this
       * importer updates as well as creates: a re-import of a sheet a site was
       * built from carries that site's own code back, and must not be refused
       * for colliding with itself.
       *
       * The row is SKIPPED with a reason rather than failing the import — one
       * bad cell in a sheet of thirty should not discard the other twenty-nine,
       * which is how the name guard above already behaves. The unique index on
       * (organisation_id, code) is the backstop underneath both.
       */
      const codeCell = cell(record, "code").trim();
      if (codeCell) {
        const codeKey = codeCell.toLowerCase();
        if (seenCodesInFile.has(codeKey)) {
          outcome.skipped.push({
            row: rowNumber,
            name,
            reason: `The code "${codeCell}" appears more than once in this file.`,
          });
          continue;
        }
        const holder = await codeConflict(db, orgId, codeCell, existing?.id ?? "");
        if (holder) {
          outcome.skipped.push({
            row: rowNumber,
            name,
            reason: `Another site already uses the code "${codeCell}".`,
          });
          continue;
        }
        seenCodesInFile.add(codeKey);
      }

      if (existing) {
        outcome.updated += 1;
        if (!dryRun) {
          await db
            .update(sites)
            .set(sheetUpdate(values, headers, existing))
            .where(and(eq(sites.id, existing.id), eq(sites.organisationId, orgId)));
          if (address.changed) {
            await recordAnomaly(db, orgId, {
              batchId,
              entityType: "site",
              entityId: existing.id,
              sourceName: name,
              kind: "address_cleaned",
              field: "address_line1",
              originalValue: rawAddress,
              appliedValue: address.value,
            });
          }
          await setSiteAliases(
            db,
            orgId,
            existing.id,
            [values.mondayMaintenanceName, values.mondayComplianceName].filter(
              (entry): entry is string => Boolean(entry),
            ),
            "csv",
          );
        }
        continue;
      }

      outcome.created += 1;
      if (!dryRun) {
        const id = `site-${normaliseSiteName(name).slice(0, 40)}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        await db.insert(sites).values({
          id,
          organisationId: orgId,
          slug: await uniqueSlug(db, orgId, name),
          position: await nextSitePosition(db, orgId),
          ...values,
          // A blank code column in the sheet gets a generated one rather than
          // leaving the site without an operational reference.
          code: values.code ?? generateSiteCode(name, await existingSiteCodes(db, orgId)),
        });
        if (address.changed) {
          await recordAnomaly(db, orgId, {
            batchId,
            entityType: "site",
            entityId: id,
            sourceName: name,
            kind: "address_cleaned",
            field: "address_line1",
            originalValue: rawAddress,
            appliedValue: address.value,
          });
        }
        await setSiteAliases(
          db,
          orgId,
          id,
          [values.mondayMaintenanceName, values.mondayComplianceName].filter(
            (entry): entry is string => Boolean(entry),
          ),
          "csv",
        );
      }
    }

    return Response.json({
      ok: true,
      dryRun,
      batchId,
      importedBy: actor.email,
      ...outcome,
    });
  } catch (error) {
    const failure = siteWriteFailure(error, "The CSV could not be imported.");
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}
