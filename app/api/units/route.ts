import { and, asc, desc, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import {
  activityLog,
  attachments,
  sites,
  unitServiceRecords,
  units,
} from "../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../lib/tenant-db";
import { listOptionValues } from "../../lib/options-repository";

type ScopedDb = Awaited<ReturnType<typeof scopedDb>>["db"];

function text(value: unknown, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalText(value: unknown, max = 240) {
  const result = text(value, max);
  return result.length ? result : null;
}

function pence(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function wholeNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/** ISO date only. Service and warranty dates carry no time component. */
function isoDate(value: unknown) {
  const raw = text(value, 30);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function addMonths(from: string, months: number) {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

async function validateOption(
  db: ScopedDb,
  orgId: string,
  key: string,
  candidate: string,
) {
  const values = await listOptionValues(db, orgId, key);
  if (!candidate) {
    const fallback = values.find((entry) => entry.active && entry.isDefault)
      ?? values.find((entry) => entry.active);
    return fallback?.value ?? "";
  }
  const match = values.find((entry) => entry.value === candidate);
  if (!match) {
    throw new Error(
      `"${candidate}" is not a configured ${key.replace(/_/g, " ")}. Add it in Settings first.`,
    );
  }
  return match.value;
}

async function assertSite(db: ScopedDb, orgId: string, siteId: string) {
  const [site] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.id, siteId), eq(sites.organisationId, orgId)))
    .limit(1);
  if (!site) throw new Error("The selected site does not belong to this workspace.");
  return site.id;
}

function unitPayload(data: Record<string, unknown>) {
  return {
    name: text(data.name, 140),
    category: text(data.category, 80),
    status: text(data.status, 40),
    manufacturer: optionalText(data.manufacturer, 100),
    model: optionalText(data.model, 100),
    serialNumber: optionalText(data.serialNumber, 100),
    assetTag: optionalText(data.assetTag, 60),
    locationInSite: optionalText(data.locationInSite, 160),
    installedAt: isoDate(data.installedAt),
    warrantyExpiry: isoDate(data.warrantyExpiry),
    purchasePricePence: pence(data.purchasePrice ?? data.purchasePricePence),
    supplier: optionalText(data.supplier, 160),
    lastServicedAt: isoDate(data.lastServicedAt),
    serviceIntervalMonths: wholeNumber(data.serviceIntervalMonths),
    notes: optionalText(data.notes, 1000),
  };
}

async function logChange(
  db: ScopedDb,
  orgId: string,
  unitId: string,
  action: string,
  actorEmail: string,
  detail: Record<string, unknown>,
) {
  await db.insert(activityLog).values({
    id: `activity-unit-${unitId}-${Date.now().toString(36)}`,
    organisationId: orgId,
    entityType: "unit",
    entityId: unitId,
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
    const siteId = url.searchParams.get("siteId");
    const id = url.searchParams.get("id");

    if (id) {
      const [unit] = await db
        .select()
        .from(units)
        .where(and(eq(units.id, id), eq(units.organisationId, orgId)))
        .limit(1);
      if (!unit) return Response.json({ error: "Unit not found." }, { status: 404 });
      const [history, files] = await Promise.all([
        db
          .select()
          .from(unitServiceRecords)
          .where(
            and(
              eq(unitServiceRecords.organisationId, orgId),
              eq(unitServiceRecords.unitId, id),
            ),
          )
          .orderBy(desc(unitServiceRecords.performedAt)),
        db
          .select()
          .from(attachments)
          .where(and(eq(attachments.organisationId, orgId), eq(attachments.unitId, id))),
      ]);
      return Response.json({ unit, history, files });
    }

    const rows = await db
      .select()
      .from(units)
      .where(
        siteId
          ? and(eq(units.organisationId, orgId), eq(units.siteId, siteId))
          : eq(units.organisationId, orgId),
      )
      .orderBy(asc(units.position), asc(units.name));

    const [categories, statuses] = await Promise.all([
      listOptionValues(db, orgId, "unit_category"),
      listOptionValues(db, orgId, "unit_status"),
    ]);
    return Response.json({ units: rows, categories, statuses });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const message = error instanceof Error ? error.message : "Units could not be loaded.";
    return Response.json({ error: message }, { status: 503 });
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
      serviceRecord?: Record<string, unknown>;
      unitId?: string;
    };

    // A service visit is posted against an existing unit and appends to the
    // timeline rather than overwriting the previous "last serviced" value.
    if (body.serviceRecord) {
      const unitId = text(body.unitId, 120);
      if (!unitId) throw new Error("A unit is required to record a service visit.");
      const [unit] = await db
        .select()
        .from(units)
        .where(and(eq(units.id, unitId), eq(units.organisationId, orgId)))
        .limit(1);
      if (!unit) throw new Error("The unit does not belong to this workspace.");

      const performedAt = isoDate(body.serviceRecord.performedAt) ??
        new Date().toISOString().slice(0, 10);
      const id = `svc-${unitId}-${Date.now().toString(36)}`;
      await db.insert(unitServiceRecords).values({
        id,
        organisationId: orgId,
        unitId,
        siteId: unit.siteId,
        performedAt,
        serviceType: text(body.serviceRecord.serviceType, 80) || "Service",
        contractorId: optionalText(body.serviceRecord.contractorId, 120),
        contractorName: optionalText(body.serviceRecord.contractorName, 160),
        requestId: optionalText(body.serviceRecord.requestId, 120),
        outcome: optionalText(body.serviceRecord.outcome, 200),
        costPence: pence(body.serviceRecord.cost),
        notes: optionalText(body.serviceRecord.notes, 1000),
        recordedByEmail: actor.email,
      });

      const interval = unit.serviceIntervalMonths;
      await db
        .update(units)
        .set({
          lastServicedAt: performedAt,
          nextServiceDueAt: interval ? addMonths(performedAt, interval) : unit.nextServiceDueAt,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(units.id, unitId), eq(units.organisationId, orgId)));

      await logChange(db, orgId, unitId, "service recorded", actor.email, { performedAt });
      return Response.json({ ok: true, id });
    }

    const data = body.data ?? {};
    const payload = unitPayload(data);
    if (!payload.name) throw new Error("A unit name is required.");
    const siteId = await assertSite(db, orgId, text(data.siteId, 120));

    const category = await validateOption(db, orgId, "unit_category", payload.category);
    const status = await validateOption(db, orgId, "unit_status", payload.status);
    const id = `unit-${payload.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    await db.insert(units).values({
      id,
      organisationId: orgId,
      siteId,
      ...payload,
      category,
      status,
      nextServiceDueAt:
        payload.lastServicedAt && payload.serviceIntervalMonths
          ? addMonths(payload.lastServicedAt, payload.serviceIntervalMonths)
          : isoDate(data.nextServiceDueAt),
    });

    await logChange(db, orgId, id, "created", actor.email, { name: payload.name, siteId });
    return Response.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The unit could not be created.";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId } = guard.scope;
    const body = (await request.json()) as { id?: string; data?: Record<string, unknown> };
    const id = text(body.id, 120);
    if (!id) throw new Error("A unit ID is required.");
    const data = body.data ?? {};
    const payload = unitPayload(data);
    if (!payload.name) throw new Error("A unit name is required.");

    const siteId = await assertSite(db, orgId, text(data.siteId, 120));
    const category = await validateOption(db, orgId, "unit_category", payload.category);
    const status = await validateOption(db, orgId, "unit_status", payload.status);

    await db
      .update(units)
      .set({
        ...payload,
        siteId,
        category,
        status,
        nextServiceDueAt:
          payload.lastServicedAt && payload.serviceIntervalMonths
            ? addMonths(payload.lastServicedAt, payload.serviceIntervalMonths)
            : isoDate(data.nextServiceDueAt),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(units.id, id), eq(units.organisationId, orgId)));

    await logChange(db, orgId, id, "updated", actor.email, { name: payload.name });
    return Response.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The unit could not be updated.";
    return Response.json({ error: message }, { status: 400 });
  }
}

/** Units are retired, not deleted, so their service history survives. */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId } = guard.scope;
    const body = (await request.json()) as { id?: string };
    const id = text(body.id, 120);
    if (!id) throw new Error("A unit ID is required.");

    await db
      .update(units)
      .set({ status: "Retired", updatedAt: new Date().toISOString() })
      .where(and(eq(units.id, id), eq(units.organisationId, orgId)));
    await logChange(db, orgId, id, "retired", actor.email, {});
    return Response.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The unit could not be retired.";
    return Response.json({ error: message }, { status: 400 });
  }
}
