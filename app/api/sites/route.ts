import { and, count, desc, eq, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import {
  activityLog,
  attachments,
  complianceDocuments,
  maintenanceRequests,
  siteGroupMembers,
  sites,
  units,
} from "../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../lib/tenant-db";
import { listOptionValues } from "../../lib/options-repository";
import {
  cleanAddress,
  existingSiteCodes,
  findDuplicateCandidates,
  addSiteAlias,
  generateSiteCode,
  getSite,
  junkReason,
  listSiteGroups,
  listSites,
  nameConflict,
  nextSitePosition,
  recordAnomaly,
  releaseSiteAlias,
  setSiteAliases,
  setSiteGroupMembership,
  uniqueSlug,
} from "../../lib/sites-repository";

/**
 * What a reader is told when Sites cannot load, and what a developer is told.
 *
 * THE BUG THIS REPLACES. The catch returned `error.message` verbatim, and the
 * Sites screen renders that string. Drizzle's wrapper message is the whole
 * failing statement, so a transient database fault painted this across the top
 * of the page:
 *
 *   Failed query: select "id", "name", "slug", "logo_url", … from
 *   "organisations" where "organisations"."status" = ?  params: active
 *
 * Two separate faults, both fixed here:
 *
 *  1. IT WAS UNDIAGNOSABLE. `DrizzleQueryError.message` is only ever the SQL;
 *     the REAL reason — "no such table", an I/O fault, a closed connection —
 *     is on `error.cause`, and reading `.message` alone threw it away. So the
 *     message named a query that is provably correct (the `organisations` DDL
 *     matches the model in every source, and that statement runs clean against
 *     the live database) while saying nothing about what actually failed. The
 *     cause is now unwrapped and included in development.
 *
 *  2. IT PUBLISHED THE SCHEMA. Column names and table names went to whoever
 *     opened the page, including an unauthenticated visitor on a shared link.
 *     Raw text is development-only now, matching `databaseError` in
 *     /api/maintenance, which is the house pattern for exactly this.
 *
 * The bootstrap case is called out separately because it is the one a reader
 * can act on: it resolves by itself, and "retry in a moment" is true advice.
 */
function sitesDatabaseError(error: unknown) {
  const top = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const combined = `${top} ${cause}`.trim();

  if (process.env.NODE_ENV === "development") {
    return cause ? `Sites database error: ${cause} — while running: ${top}` : `Sites database error: ${top}`;
  }
  if (combined.includes("no such table") || combined.includes("no such column")) {
    return "The workspace database is being prepared. Please retry in a moment.";
  }
  return "Sites are temporarily unavailable.";
}

function text(value: unknown, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalText(value: unknown, max = 240) {
  const result = text(value, max);
  return result.length ? result : null;
}

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Money is stored as integer pence. A float here loses a penny per rounding. */
function pence(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[,;\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function newId(name: string) {
  const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `site-${stem || "record"}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Values are validated against the option tables rather than a union type, so
 * an admin can add a fifth site type without a deploy. An unrecognised value is
 * rejected with the permitted list rather than silently coerced.
 */
async function validateOption(
  db: Awaited<ReturnType<typeof scopedDb>>["db"],
  orgId: string,
  key: string,
  candidate: string,
  required: boolean,
) {
  const values = await listOptionValues(db, orgId, key);
  const active = values.filter((entry) => entry.active);
  if (!candidate) {
    if (!required) return "";
    const fallback = active.find((entry) => entry.isDefault) ?? active[0];
    if (!fallback) throw new Error(`No ${key} options are configured for this workspace.`);
    return fallback.value;
  }
  const match = values.find((entry) => entry.value === candidate);
  if (!match) {
    throw new Error(
      `"${candidate}" is not a configured ${key.replace(/_/g, " ")}. Add it in Settings first.`,
    );
  }
  return match.value;
}

function sitePayload(data: Record<string, unknown>) {
  return {
    name: text(data.name, 120),
    code: optionalText(data.code, 40),
    siteTypeValue: text(data.siteTypeValue ?? data.type, 60),
    status: text(data.status, 40),
    addressLine1: text(data.addressLine1 ?? data.address, 300),
    addressLine2: optionalText(data.addressLine2, 300),
    city: optionalText(data.city, 120),
    postcode: optionalText(data.postcode, 20),
    country: text(data.country, 80) || "United Kingdom",
    latitude: optionalNumber(data.latitude),
    longitude: optionalNumber(data.longitude),
    region: text(data.region, 60) || "UK",
    managerName: optionalText(data.managerName ?? data.manager, 120),
    managerPhone: optionalText(data.managerPhone, 60),
    managerEmail: optionalText(data.managerEmail, 160),
    landlord: optionalText(data.landlord, 160),
    managingAgent: optionalText(data.managingAgent, 160),
    outOfHoursContact: optionalText(data.outOfHoursContact, 160),
    accessMethod: optionalText(data.accessMethod, 80),
    accessContact: optionalText(data.accessContact, 200),
    accessUrl: optionalText(data.accessUrl, 400),
    accessNotes: optionalText(data.accessNotes, 1000),
    openingHours: optionalText(data.openingHours, 400),
    deliveryRestrictions: optionalText(data.deliveryRestrictions, 400),
    parkingNotes: optionalText(data.parkingNotes, 400),
    keyAlarmNotes: optionalText(data.keyAlarmNotes, 400),
    leaseStart: optionalText(data.leaseStart, 20),
    leaseEnd: optionalText(data.leaseEnd, 20),
    breakClause: optionalText(data.breakClause, 200),
    rentReview: optionalText(data.rentReview, 200),
    serviceChargePence: pence(data.serviceCharge ?? data.serviceChargePence),
    annualBudgetPence: pence(data.annualBudget ?? data.annualBudgetPence),
    mondayMaintenanceName: optionalText(data.mondayMaintenanceName, 160),
    mondayComplianceName: optionalText(data.mondayComplianceName, 160),
    notes: optionalText(data.notes, 2000),
  };
}

type SitePayload = ReturnType<typeof sitePayload>;

/**
 * Which request keys each stored column may arrive under.
 *
 * This is a restatement of the `??` chains in `sitePayload` above and it has to
 * be kept beside them: adding a column there and forgetting it here means an
 * edit can no longer reach that column. The two are one table read twice, and
 * the compiler holds the shape — `Record<keyof SitePayload, …>` fails to build
 * the moment `sitePayload` gains a key this does not name.
 */
const PAYLOAD_SOURCES: Record<keyof SitePayload, readonly string[]> = {
  name: ["name"],
  code: ["code"],
  siteTypeValue: ["siteTypeValue", "type"],
  status: ["status"],
  addressLine1: ["addressLine1", "address"],
  addressLine2: ["addressLine2"],
  city: ["city"],
  postcode: ["postcode"],
  country: ["country"],
  latitude: ["latitude"],
  longitude: ["longitude"],
  region: ["region"],
  managerName: ["managerName", "manager"],
  managerPhone: ["managerPhone"],
  managerEmail: ["managerEmail"],
  landlord: ["landlord"],
  managingAgent: ["managingAgent"],
  outOfHoursContact: ["outOfHoursContact"],
  accessMethod: ["accessMethod"],
  accessContact: ["accessContact"],
  accessUrl: ["accessUrl"],
  accessNotes: ["accessNotes"],
  openingHours: ["openingHours"],
  deliveryRestrictions: ["deliveryRestrictions"],
  parkingNotes: ["parkingNotes"],
  keyAlarmNotes: ["keyAlarmNotes"],
  leaseStart: ["leaseStart"],
  leaseEnd: ["leaseEnd"],
  breakClause: ["breakClause"],
  rentReview: ["rentReview"],
  serviceChargePence: ["serviceCharge", "serviceChargePence"],
  annualBudgetPence: ["annualBudget", "annualBudgetPence"],
  mondayMaintenanceName: ["mondayMaintenanceName"],
  mondayComplianceName: ["mondayComplianceName"],
  notes: ["notes"],
};

/**
 * AN EDIT MAY ONLY CHANGE WHAT IT CARRIED.
 *
 * THE BUG THIS FIXES, stated plainly because it was silently destroying data on
 * real sites. `sitePayload` builds EVERY column from the request body, and the
 * builders answer a missing key the same way they answer a cleared one:
 * `optionalText(undefined)` is `null`, `optionalNumber(undefined)` is `null`,
 * and `text(undefined, 60) || "UK"` is the literal `"UK"`. PATCH then wrote the
 * whole object. So a column the editor does not render was not "left alone" —
 * it was overwritten with the default on every save.
 *
 * Three columns were being hit. `region` reverted to "UK" — the Sites form has
 * never had a region field, so opening any site outside the default region and
 * pressing Save quietly relabelled it. `latitude` and `longitude` were nulled,
 * and unlike a name nobody notices coordinates going missing until a map is
 * empty. The comment on the rename branch below says the full-payload path is
 * "right for the Sites form (it sends everything)"; the form does not send
 * everything, and this closes the gap between that sentence and the code.
 *
 * ABSENT AND CLEARED STAY DIFFERENT, which is the whole discipline. A key the
 * caller did not send at all (`undefined`) keeps what is stored. A key sent as
 * `""` or `null` is somebody emptying a field on purpose and still clears it,
 * exactly as before — otherwise a user could never delete a postcode.
 *
 * POST is untouched. A new row has nothing to preserve, and the defaults are
 * correct there.
 */
function preserveUnsent<Row extends Record<string, unknown>>(
  payload: SitePayload,
  data: Record<string, unknown>,
  existing: Row,
): { [K in keyof SitePayload]: SitePayload[K] | (K extends keyof Row ? Row[K] : never) } {
  const merged = { ...payload } as Record<string, unknown>;
  for (const [column, sources] of Object.entries(PAYLOAD_SOURCES)) {
    if (sources.some((source) => data[source] !== undefined)) continue;
    merged[column] = existing[column];
  }
  /*
   * The return type is the UNION of what the builders produce and what the row
   * holds, rather than `SitePayload`, because those differ where a column is
   * nullable in storage but non-null out of `text()` — `address_line1` and
   * `site_type_value` both are. Typing this as `SitePayload` would have been
   * one cast and would have hidden exactly the two nulls the callers below now
   * have to answer for.
   */
  return merged as { [K in keyof SitePayload]: SitePayload[K] | (K extends keyof Row ? Row[K] : never) };
}

async function logChange(
  db: Awaited<ReturnType<typeof scopedDb>>["db"],
  orgId: string,
  siteId: string,
  action: string,
  actorEmail: string,
  detail: Record<string, unknown>,
) {
  await db.insert(activityLog).values({
    id: `activity-site-${siteId}-${Date.now().toString(36)}`,
    organisationId: orgId,
    entityType: "site",
    entityId: siteId,
    action,
    actorEmail,
    detail: JSON.stringify(detail).slice(0, 4000),
  });
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (id) {
      const site = await getSite(db, orgId, id);
      if (!site) return Response.json({ error: "Site not found." }, { status: 404 });
      const [jobs, assets, documents, groups, files, activity] = await Promise.all([
        db
          .select()
          .from(maintenanceRequests)
          .where(
            and(
              eq(maintenanceRequests.organisationId, orgId),
              eq(maintenanceRequests.siteId, id),
              // Stage 23 — a site's job history excludes anything in the bin.
              isNull(maintenanceRequests.deletedAt),
            ),
          )
          .orderBy(desc(maintenanceRequests.requestedAt))
          .limit(200),
        db
          .select()
          .from(units)
          .where(and(eq(units.organisationId, orgId), eq(units.siteId, id))),
        db
          .select()
          .from(complianceDocuments)
          .where(
            and(
              eq(complianceDocuments.organisationId, orgId),
              eq(complianceDocuments.siteId, id),
            ),
          ),
        db
          .select({ siteGroupId: siteGroupMembers.siteGroupId })
          .from(siteGroupMembers)
          .where(
            and(
              eq(siteGroupMembers.organisationId, orgId),
              eq(siteGroupMembers.siteId, id),
            ),
          ),
        db
          .select()
          .from(attachments)
          .where(and(eq(attachments.organisationId, orgId), eq(attachments.siteId, id)))
          .orderBy(desc(attachments.createdAt))
          .limit(200),
        db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.organisationId, orgId),
              eq(activityLog.entityType, "site"),
              eq(activityLog.entityId, id),
            ),
          )
          .orderBy(desc(activityLog.createdAt))
          .limit(100),
      ]);
      return Response.json({
        site,
        jobs,
        jobCount: jobs.length,
        units: assets,
        compliance: documents,
        files,
        activity,
        groupIds: groups.map((entry) => entry.siteGroupId),
      });
    }

    const [rows, groups, siteTypes, statuses] = await Promise.all([
      listSites(db, orgId, { includeInactive: true }),
      listSiteGroups(db, orgId),
      listOptionValues(db, orgId, "site_type"),
      listOptionValues(db, orgId, "site_status"),
    ]);
    return Response.json({ sites: rows, groups, siteTypes, statuses });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: sitesDatabaseError(error) }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId } = guard.scope;
    const body = (await request.json()) as {
      data?: Record<string, unknown>;
      confirmDuplicate?: boolean;
    };
    const payload = sitePayload(body.data ?? {});

    if (!payload.name) throw new Error("A site name is required.");
    const address = cleanAddress(payload.addressLine1);
    if (!address.value) throw new Error("A first line of address is required.");

    const junk = junkReason(payload.name, address.value);
    if (junk) throw new Error(junk);

    // X6 — warn, do not block. Two centres can legitimately share a name.
    const duplicates = await findDuplicateCandidates(db, orgId, payload.name);
    if (duplicates.length && !body.confirmDuplicate) {
      return Response.json(
        {
          error: "A similar site already exists.",
          requiresConfirmation: true,
          duplicates,
        },
        { status: 409 },
      );
    }

    const siteTypeValue = await validateOption(db, orgId, "site_type", payload.siteTypeValue, true);
    const status = await validateOption(db, orgId, "site_status", payload.status, true);

    const id = newId(payload.name);
    const slug = await uniqueSlug(db, orgId, payload.name);
    // The owner has no existing store-code convention, so one is generated and
    // stored. It stays editable afterwards like any other field.
    const code = payload.code ?? generateSiteCode(payload.name, await existingSiteCodes(db, orgId));
    const position = await nextSitePosition(db, orgId);

    await db.insert(sites).values({
      id,
      organisationId: orgId,
      ...payload,
      code,
      addressLine1: address.value,
      siteTypeValue,
      status,
      slug,
      position,
      active: status !== "closed",
      // The Stage 0 columns are kept in step until Stage 3 retires them, so
      // screens that still read `type`, `lifecycle` and `address` keep working.
      type: siteTypeValue,
      lifecycle: status === "closed" ? "Closed" : "Current",
      address: [address.value, payload.addressLine2, payload.city, payload.postcode]
        .filter(Boolean)
        .join(", ")
        .slice(0, 300),
      manager: payload.managerName,
    });

    if (address.changed) {
      await recordAnomaly(db, orgId, {
        batchId: "manual-entry",
        entityType: "site",
        entityId: id,
        sourceName: payload.name,
        kind: "address_cleaned",
        field: "address_line1",
        originalValue: payload.addressLine1,
        appliedValue: address.value,
        detail: "Stray quotation marks were removed from the address.",
      });
    }

    await setSiteAliases(db, orgId, id, [
      ...stringList(body.data?.aliases),
      ...(payload.mondayMaintenanceName ? [payload.mondayMaintenanceName] : []),
      ...(payload.mondayComplianceName ? [payload.mondayComplianceName] : []),
    ]);
    await setSiteGroupMembership(db, orgId, id, stringList(body.data?.groupIds));
    await logChange(db, orgId, id, "created", actor.email, { name: payload.name });

    return Response.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The site could not be created.";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId } = guard.scope;
    const body = (await request.json()) as {
      id?: string;
      data?: Record<string, unknown>;
      confirmDuplicate?: boolean;
      rename?: unknown;
    };
    const id = text(body.id, 120);
    if (!id) throw new Error("A site ID is required.");

    const existing = await getSite(db, orgId, id);
    if (!existing) return Response.json({ error: "Site not found." }, { status: 404 });

    /*
     * A NAME-ONLY rename, for callers that hold the site's identity and
     * nothing else — the form builder's Location editor. The full-payload
     * branch below rewrites every field with whatever was sent, which is right
     * for the Sites form (it sends everything) and destructive for anyone
     * else: a rename that had to travel as a full payload would null the
     * thirty fields the caller did not have. Same duplicate check, same
     * slug refresh, same audit trail; jobs and compliance rows reference the
     * site by ID, so nothing else needs rewriting.
     */
    if (typeof body.rename === "string") {
      const nextName = text(body.rename, 120);
      if (!nextName) throw new Error("A site name is required.");
      if (nextName !== existing.name) {
        /*
         * A name that already resolves elsewhere cannot be taken.
         * `findDuplicateCandidates` only warns, and only about site names; an
         * ALIAS pointing at another site is a hard conflict, because
         * `site_aliases` is uniquely indexed on (organisation_id, normalised)
         * and the alias insert below would be rejected — leaving the rename
         * applied and its history lost.
         */
        const conflict = await nameConflict(db, orgId, nextName, id);
        if (conflict?.kind === "alias") {
          return Response.json(
            {
              error:
                "That name is already recorded as a former name of another site. Remove it there first.",
              conflictSiteId: conflict.siteId,
            },
            { status: 409 },
          );
        }
        const duplicates = await findDuplicateCandidates(db, orgId, nextName, id);
        if (duplicates.length && !body.confirmDuplicate) {
          return Response.json(
            { error: "A similar site already exists.", requiresConfirmation: true, duplicates },
            { status: 409 },
          );
        }
        await db
          .update(sites)
          .set({
            name: nextName,
            slug: await uniqueSlug(db, orgId, nextName, id),
            updatedAt: new Date().toISOString(),
          })
          .where(and(eq(sites.id, id), eq(sites.organisationId, orgId)));

        /*
         * The previous name survives as an organisation-scoped alias, so every
         * job, compliance row and import that recorded the old spelling still
         * resolves. Additive: two renames leave both earlier names resolving.
         * `releaseSiteAlias` runs first because renaming back to a name this
         * site once had must retire it as an alias, rather than leave the
         * register saying one string is both the current name and a historic
         * spelling of it.
         */
        await releaseSiteAlias(db, orgId, id, nextName);
        const recorded = await addSiteAlias(db, orgId, id, existing.name, "rename");

        await logChange(db, orgId, id, "renamed", actor.email, {
          from: existing.name,
          to: nextName,
          aliasRecorded: recorded.ok ? recorded.created : false,
          aliasSkipped: recorded.ok ? null : recorded.reason,
        });
      }
      return Response.json({ ok: true, id, name: nextName });
    }

    const sent = body.data ?? {};
    const payload = preserveUnsent(sitePayload(sent), sent, existing);
    if (!payload.name) throw new Error("A site name is required.");
    // `addressLine1` is nullable in storage even though the form insists on it,
    // and preservation can hand back that null for a caller that sent no
    // address at all. The check two lines down is what still refuses to save.
    const address = cleanAddress(payload.addressLine1 ?? "");
    if (!address.value) throw new Error("A first line of address is required.");

    if (payload.name !== existing.name) {
      // A name another site already answers to by alias is a hard conflict, not
      // a warning — the alias insert below would be rejected by the unique
      // index and the rename would be left half-applied.
      const conflict = await nameConflict(db, orgId, payload.name, id);
      if (conflict?.kind === "alias") {
        return Response.json(
          {
            error:
              "That name is already recorded as a former name of another site. Remove it there first.",
            conflictSiteId: conflict.siteId,
          },
          { status: 409 },
        );
      }
      const duplicates = await findDuplicateCandidates(db, orgId, payload.name, id);
      if (duplicates.length && !body.confirmDuplicate) {
        return Response.json(
          { error: "A similar site already exists.", requiresConfirmation: true, duplicates },
          { status: 409 },
        );
      }
    }

    /*
     * `?? ""` because `site_type_value` is nullable in storage and preservation
     * can hand back that null for a legacy row that never had one. Empty is the
     * "not stated" case `validateOption` already answers, with the workspace's
     * default option rather than a rejection.
     */
    const siteTypeValue = await validateOption(db, orgId, "site_type", payload.siteTypeValue ?? "", true);
    const status = await validateOption(db, orgId, "site_status", payload.status ?? "", true);
    const slug =
      payload.name === existing.name && existing.slug
        ? existing.slug
        : await uniqueSlug(db, orgId, payload.name, id);

    await db
      .update(sites)
      .set({
        ...payload,
        addressLine1: address.value,
        siteTypeValue,
        status,
        slug,
        active: status !== "closed",
        type: siteTypeValue,
        lifecycle: status === "closed" ? "Closed" : "Current",
        address: [address.value, payload.addressLine2, payload.city, payload.postcode]
          .filter(Boolean)
          .join(", ")
          .slice(0, 300),
        manager: payload.managerName,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(sites.id, id), eq(sites.organisationId, orgId)));

    /*
     * The same rule on the full-payload path. It recorded nothing at all unless
     * the caller happened to send an `aliases` array, so a rename from the Sites
     * form lost the old name while the identical rename from the Location editor
     * kept it. The alias comes from the rename itself, never from a field the
     * caller may not have sent — and it runs BEFORE `setSiteAliases` so the
     * hand-typed list ("manual") and this row ("rename") occupy different slots
     * and cannot delete one another.
     */
    if (payload.name !== existing.name) {
      await releaseSiteAlias(db, orgId, id, payload.name);
      await addSiteAlias(db, orgId, id, existing.name, "rename");
    }

    if (Array.isArray(body.data?.aliases) || typeof body.data?.aliases === "string") {
      await setSiteAliases(db, orgId, id, [
        ...stringList(body.data?.aliases),
        ...(payload.mondayMaintenanceName ? [payload.mondayMaintenanceName] : []),
        ...(payload.mondayComplianceName ? [payload.mondayComplianceName] : []),
      ]);
    }
    if (body.data?.groupIds !== undefined) {
      await setSiteGroupMembership(db, orgId, id, stringList(body.data.groupIds));
    }
    await logChange(db, orgId, id, "updated", actor.email, { name: payload.name });

    return Response.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The site could not be updated.";
    return Response.json({ error: message }, { status: 400 });
  }
}

/**
 * Sites are archived, never deleted. Jobs, compliance documents and assets all
 * reference the site; deleting the row would orphan legally significant
 * records. Archiving sets the status to closed and hides it from selectors.
 */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId } = guard.scope;
    const body = (await request.json()) as { id?: string };
    const id = text(body.id, 120);
    if (!id) throw new Error("A site ID is required.");

    const existing = await getSite(db, orgId, id);
    if (!existing) return Response.json({ error: "Site not found." }, { status: 404 });

    const [openJobs] = await db
      .select({ total: count() })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          eq(maintenanceRequests.siteId, id),
          // Stage 23 — `retainedJobs` tells the caller what survives closing a
          // site. Jobs in the bin are not retained; they are on their way out.
          isNull(maintenanceRequests.deletedAt),
        ),
      );

    await db
      .update(sites)
      .set({
        status: "closed",
        lifecycle: "Closed",
        active: false,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(sites.id, id), eq(sites.organisationId, orgId)));

    await logChange(db, orgId, id, "archived", actor.email, {
      name: existing.name,
      retainedJobs: openJobs?.total ?? 0,
    });

    return Response.json({ ok: true, id, retainedJobs: openJobs?.total ?? 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The site could not be archived.";
    return Response.json({ error: message }, { status: 400 });
  }
}
