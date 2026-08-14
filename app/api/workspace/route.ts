import { and, count, desc, eq, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import {
  activityLog,
  complianceDocuments,
  contractors,
  maintenanceRequests,
  memberships,
  plannedMaintenance,
  sites,
  units,
  users,
  workspaceSettings,
} from "../../../db/schema";
import { readComplianceRegister } from "../../lib/compliance-register";
import { PRIMARY_ORGANISATION_ID, anonymousRefusal, scopedDb } from "../../lib/tenant-db";
import { sampleSeedingAllowed } from "../../lib/tenant-access";
import {
  maintenanceRequests as sampleRequests,
  stores as sampleStores,
} from "../../lib/mock-data";
import type { ComplianceState, StoreRecord } from "../../lib/types";
import {
  defaultWorkspaceSettings,
  type WorkspaceActivity,
  type WorkspaceComplianceRecord,
  type WorkspaceContractor,
  type WorkspaceEntity,
  type WorkspaceMember,
  type WorkspacePlannedItem,
  type WorkspaceSettings,
  type WorkspaceSnapshot,
  type WorkspaceUnit,
} from "../../lib/workspace-data";
import {
  type Capability,
  requireCapability,
  resolvePermissions,
} from "../../lib/permissions";
import type { WorkspaceRole } from "../../lib/workspace-actor";

function text(value: unknown, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalText(value: unknown, max = 240) {
  const result = text(value, max);
  return result || null;
}

function numeric(value: unknown, fallback: number, min = 0, max = 1_000_000) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, min), max)
    : fallback;
}

function booleanValue(value: unknown, fallback = true) {
  if (typeof value === "boolean") return value;
  if (value === "false" || value === 0) return false;
  if (value === "true" || value === 1) return true;
  return fallback;
}

function stringArray(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return values
    .map((item) => text(item, 80))
    .filter(Boolean)
    .slice(0, 20);
}

function parseStringArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseObject<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as T)
      : fallback;
  } catch {
    return fallback;
  }
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 52) || "record";
}

function newId(prefix: string, label: string) {
  return `${prefix}-${slug(label)}-${crypto.randomUUID().slice(0, 8)}`;
}

function databaseError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  return process.env.NODE_ENV === "development"
    ? `Preview database error: ${message}`
    : "The shared workspace is temporarily unavailable.";
}

type WorkspaceDb = Awaited<ReturnType<typeof scopedDb>>["db"];

async function seedWorkspaceIfEmpty(db: WorkspaceDb, orgId: string) {
  await ensureDatabase();
  if (orgId !== PRIMARY_ORGANISATION_ID) return;
  if (!sampleSeedingAllowed()) return;
  const [siteCount] = await db
    .select({ value: count() })
    .from(sites)
    .where(eq(sites.organisationId, orgId));

  if (siteCount.value === 0) {
    for (const store of sampleStores) {
      // The Stage-2 fields are written here rather than left to the
      // `UPDATE sites SET manager_name = manager WHERE manager_name IS NULL`
      // backfill in db/init.ts. That backfill runs during `ensureDatabase()`,
      // which completes before this lazy seed ever inserts a row — so on a
      // freshly provisioned workspace every seeded site had a null
      // `manager_name`, `site_type_value`, `address_line1` and `slug`, and the
      // Sites screen (which reads the Stage-2 names) showed a dash in the
      // Manager column for every store.
      await db.insert(sites).values({
        id: store.id,
        organisationId: orgId,
        name: store.name,
        type: store.type,
        region: store.region,
        lifecycle: store.lifecycle,
        address: store.address,
        manager: store.manager,
        slug: slug(store.name),
        siteTypeValue: store.type,
        addressLine1: store.address,
        managerName: store.manager,
        status: store.lifecycle === "Current" ? "active" : "closed",
      }).onConflictDoNothing();

      for (const item of store.compliance) {
        await db.insert(complianceDocuments).values({
          id: `compliance-${slug(store.id)}-${slug(item.kind)}`,
          organisationId: orgId,
          siteId: store.id,
          kind: item.kind,
          status: item.state,
          expiryDate: item.expiry,
          attachmentId: null,
          notRequired: item.state === "Not required",
        }).onConflictDoNothing();
      }

      await db.insert(units).values([
        {
          id: `${store.id}-retail`,
          organisationId: orgId,
          siteId: store.id,
          name: `${store.name} — trading unit`,
          category: store.type,
          status: store.lifecycle === "Current" ? "Active" : "Inactive",
          notes: "Customer-facing operational unit",
        },
        {
          id: `${store.id}-services`,
          organisationId: orgId,
          siteId: store.id,
          name: `${store.name} — service assets`,
          category: "Asset group",
          status: store.lifecycle === "Current" ? "Active" : "Inactive",
          notes: "Shared mechanical, electrical and safety assets",
        },
      ]).onConflictDoNothing();
    }
  }

  const [contractorCount] = await db
    .select({ value: count() })
    .from(contractors)
    .where(eq(contractors.organisationId, orgId));
  if (contractorCount.value === 0) {
    const categoriesByContractor = new Map<string, Set<string>>();
    for (const request of sampleRequests) {
      if (!request.contractor) continue;
      const current = categoriesByContractor.get(request.contractor) ?? new Set<string>();
      current.add(request.category);
      categoriesByContractor.set(request.contractor, current);
    }
    for (const [name, categories] of categoriesByContractor) {
      await db.insert(contractors).values({
        id: `contractor-${slug(name)}`,
        organisationId: orgId,
        name,
        email: `ops@${slug(name)}.example`,
        serviceCategories: JSON.stringify(Array.from(categories)),
        coverageAreas: JSON.stringify(["UK"]),
        certifications: JSON.stringify(["Public liability verified"]),
        availability: "Available",
        rating: 4.5,
        active: true,
      }).onConflictDoNothing();
    }
  }

  const [plannedCount] = await db
    .select({ value: count() })
    .from(plannedMaintenance)
    .where(eq(plannedMaintenance.organisationId, orgId));
  if (plannedCount.value === 0) {
    const contractorRows = await db
      .select()
      .from(contractors)
      .where(eq(contractors.organisationId, orgId));
    const contractorIds = new Map(contractorRows.map((row) => [row.name, row.id]));
    for (const request of sampleRequests.filter((item) => item.dueAt && item.stage !== "Completed")) {
      await db.insert(plannedMaintenance).values({
        id: `planned-${request.id.toLowerCase()}`,
        organisationId: orgId,
        siteId: request.siteId,
        unitId: `${request.siteId}-services`,
        contractorId: request.contractor ? contractorIds.get(request.contractor) ?? null : null,
        title: request.title,
        category: request.category,
        frequency: "One-off",
        nextDueAt: request.dueAt!,
        lastCompletedAt: null,
        status: request.stage === "Booked" ? "Booked" : "Scheduled",
        reminderDays: request.priority === "Urgent" ? 1 : 7,
      }).onConflictDoNothing();
    }
  }

  const [userCount] = await db
    .select({ value: count() })
    .from(users)
    .where(eq(users.organisationId, orgId));
  if (userCount.value === 0) {
    for (const member of [
      { name: "Workspace Super Admin", email: "superadmin@test.maintsupp.com", role: "Super Admin" },
      { name: "Sample Admin", email: "sample-admin@maintsupp.local", role: "Admin" },
      { name: "Sample Client User", email: "sample-client@maintsupp.local", role: "Client" },
    ]) {
      await db.insert(users).values({
        id: `user-${slug(member.email)}`,
        organisationId: orgId,
        fullName: member.name,
        email: member.email,
        role: member.role,
        active: true,
      }).onConflictDoNothing();
    }
  }
  const memberRows = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.organisationId, orgId));
  for (const member of memberRows) {
    const role = member.role.toLowerCase() === "super admin"
      ? "super_admin"
      : member.role.toLowerCase() === "admin"
        ? "admin"
        : "client";
    await db.insert(memberships).values({
      id: `membership-${member.id}-${orgId}`,
      userId: member.id,
      organisationId: orgId,
      role,
      siteScope: null,
      approvalLimitPence: null,
      status: "active",
      acceptedAt: new Date().toISOString(),
    }).onConflictDoNothing();
  }

  await db.insert(workspaceSettings).values({
    legacyClientId: orgId,
    organisationId: orgId,
    settings: JSON.stringify(defaultWorkspaceSettings),
    updatedByEmail: "seed@maintsupp.local",
  }).onConflictDoNothing();
}

async function readWorkspace(db: WorkspaceDb, orgId: string): Promise<WorkspaceSnapshot> {
  await seedWorkspaceIfEmpty(db, orgId);
  const [
    siteRows,
    unitRows,
    contractorRows,
    plannedRows,
    userRows,
    settingsRows,
    requestRows,
    activities,
    register,
  ] = await Promise.all([
    db.select().from(sites).where(eq(sites.organisationId, orgId)).orderBy(sites.name),
    db.select().from(units).where(eq(units.organisationId, orgId)).orderBy(units.name),
    db.select().from(contractors).where(eq(contractors.organisationId, orgId)).orderBy(contractors.name),
    db.select().from(plannedMaintenance).where(eq(plannedMaintenance.organisationId, orgId)).orderBy(plannedMaintenance.nextDueAt),
    db.select().from(users).where(eq(users.organisationId, orgId)).orderBy(users.fullName),
    db.select().from(workspaceSettings).where(eq(workspaceSettings.organisationId, orgId)).limit(1),
    // Stage 23 — feeds the open-jobs-per-site tally. Binned jobs are not open.
    db
      .select()
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          isNull(maintenanceRequests.deletedAt),
        ),
      ),
    db.select().from(activityLog).where(eq(activityLog.organisationId, orgId)).orderBy(desc(activityLog.createdAt)).limit(60),
    readComplianceRegister(db, orgId),
  ]);

  const openJobsBySite = new Map<string, number>();
  for (const request of requestRows) {
    if (request.stage !== "Completed") {
      openJobsBySite.set(request.siteId, (openJobsBySite.get(request.siteId) ?? 0) + 1);
    }
  }
  const siteNameById = new Map(siteRows.map((site) => [site.id, site.name]));
  const contractorNameById = new Map(contractorRows.map((item) => [item.id, item.name]));

  /*
   * ── The compliance register ────────────────────────────────────────────
   *
   * Read off the Store Documentation board, with `compliance_documents` as the
   * override layer. The rules and the reasons are in
   * app/lib/compliance-register.ts, which the compliance digest calls too — one
   * derivation, so a screen and an email cannot disagree about whether a fire
   * alarm certificate has lapsed.
   */
  const compliance: WorkspaceComplianceRecord[] = register.entries.map((entry) => ({
    id: entry.id,
    siteId: entry.siteId,
    siteName: entry.siteName,
    kind: entry.kind,
    state: entry.state,
    expiry: entry.expiry,
    fileCount: entry.fileCount,
    siteType: entry.siteType,
    siteAddress: entry.siteAddress,
  }));

  const stores: StoreRecord[] = siteRows.map((site) => ({
    id: site.id,
    name: site.name,
    type: site.siteTypeValue ?? site.type,
    region: site.region,
    status: site.status,
    lifecycle: site.lifecycle,
    address: site.address,
    manager: site.manager ?? "Unassigned",
    openRequests: openJobsBySite.get(site.id) ?? 0,
    annualBudgetPence: site.annualBudgetPence ?? null,
    compliance: register.bySite.get(site.id) ?? [],
  }));

  const unitsPayload: WorkspaceUnit[] = unitRows.map((unit) => {
    const site = stores.find((item) => item.id === unit.siteId);
    return {
      id: unit.id,
      siteId: unit.siteId,
      siteName: siteNameById.get(unit.siteId) ?? "Unknown site",
      name: unit.name,
      category: unit.category,
      manufacturer: unit.manufacturer,
      model: unit.model,
      serialNumber: unit.serialNumber,
      status: unit.status,
      notes: unit.notes,
      openJobs: openJobsBySite.get(unit.siteId) ?? 0,
      compliance: site
        ? getOverallCompliance(site)
        : "Missing",
    };
  });

  const contractorsPayload: WorkspaceContractor[] = contractorRows.map((contractor) => {
    const assigned = requestRows.filter((request) => request.contractor === contractor.name);
    return {
      id: contractor.id,
      name: contractor.name,
      email: contractor.email,
      phone: contractor.phone,
      serviceCategories: parseStringArray(contractor.serviceCategories),
      coverageAreas: parseStringArray(contractor.coverageAreas),
      certifications: parseStringArray(contractor.certifications),
      insuranceExpiry: contractor.insuranceExpiry,
      availability: contractor.availability,
      rating: contractor.rating,
      active: contractor.active,
      assignedJobs: assigned.length,
      completedJobs: assigned.filter((request) => request.stage === "Completed").length,
      urgentJobs: assigned.filter((request) => request.priority === "Urgent" && request.stage !== "Completed").length,
      spend: assigned.reduce((sum, request) => sum + (request.cost ?? 0), 0),
    };
  });

  const plannedPayload: WorkspacePlannedItem[] = plannedRows.map((item) => ({
    id: item.id,
    siteId: item.siteId,
    siteName: siteNameById.get(item.siteId) ?? "Unknown site",
    unitId: item.unitId,
    contractorId: item.contractorId,
    contractorName: item.contractorId ? contractorNameById.get(item.contractorId) ?? null : null,
    title: item.title,
    category: item.category,
    frequency: item.frequency,
    nextDueAt: item.nextDueAt,
    lastCompletedAt: item.lastCompletedAt,
    status: item.status,
    reminderDays: item.reminderDays,
  }));

  const team: WorkspaceMember[] = userRows.map((member) => ({
    id: member.id,
    name: member.fullName ?? member.email.split("@")[0],
    email: member.email,
    role: member.role,
    active: member.active,
    lastActive: member.active ? "Shared workspace" : "Access paused",
  }));

  const storedSettings = parseObject<Partial<WorkspaceSettings>>(
    settingsRows[0]?.settings ?? null,
    {},
  );
  const settings: WorkspaceSettings = {
    alerts: { ...defaultWorkspaceSettings.alerts, ...storedSettings.alerts },
    slas: { ...defaultWorkspaceSettings.slas, ...storedSettings.slas },
    /*
     * Filtered to strings rather than spread. This value reaches a WHERE-free
     * comparison in the close gate, and a stored `null` or a number arriving
     * from an older settings row would silently match nothing — a gate that
     * quietly stops gating is worse than one that was never built.
     */
    completionEvidenceCategories: Array.isArray(
      storedSettings.completionEvidenceCategories,
    )
      ? storedSettings.completionEvidenceCategories
          .filter((value): value is string => typeof value === "string" && !!value.trim())
          .map((value) => value.trim())
      : defaultWorkspaceSettings.completionEvidenceCategories,
  };

  const activity: WorkspaceActivity[] = activities.map((item) => ({
    id: item.id,
    entityType: item.entityType,
    entityId: item.entityId,
    action: item.action,
    actorEmail: item.actorEmail,
    detail: parseObject<Record<string, unknown>>(item.detail, {}),
    createdAt: item.createdAt,
  }));

  return { stores, compliance, units: unitsPayload, contractors: contractorsPayload, planned: plannedPayload, team, settings, activity };
}

function getOverallCompliance(store: StoreRecord): ComplianceState {
  const states = store.compliance.map((item) => item.state);
  if (states.includes("Expired")) return "Expired";
  if (states.includes("Missing")) return "Missing";
  if (states.includes("Expiring soon")) return "Expiring soon";
  return "Compliant";
}

async function logChange(db: WorkspaceDb, orgId: string, entity: WorkspaceEntity, id: string, action: string, actorEmail: string, detail: Record<string, unknown>) {
  await db.insert(activityLog).values({
    id: crypto.randomUUID(),
    organisationId: orgId,
    entityType: `workspace_${entity}`,
    entityId: id,
    action,
    actorEmail,
    detail: JSON.stringify(detail),
  });
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    return Response.json({ workspace: await readWorkspace(db, orgId) });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: databaseError(error) }, { status: 503 });
  }
}


/**
 * The capability each workspace entity demands.
 *
 * This route writes sites, units, contractors, planned work, compliance
 * records, workspace settings AND user membership — including deactivating a
 * colleague, which invalidates their sessions. One blanket capability would
 * therefore either lock admins out of the site register or hand the user table
 * to anyone who can edit a site. The mapping is per entity for that reason.
 */
const WORKSPACE_CAPABILITY: Record<string, Capability> = {
  site: "sites.edit",
  unit: "sites.edit",
  compliance: "sites.edit",
  contractor: "sites.edit",
  planned: "sites.edit",
  settings: "settings.edit",
  member: "users.edit",
};

/**
 * Authorises one workspace write.
 *
 * Returns a Response to send, or null to proceed. Two separate questions, and
 * the order matters: are you anyone at all, and then may you do this.
 *
 * The `authenticated` check is the one that mattered most. In production every
 * identity candidate is dropped for a request with no session, and the actor
 * falls back to the `client` role scoped to the PRIMARY organisation — so an
 * unauthenticated stranger reached this route as a client of the live tenant
 * and these writes answered 200. Deactivating the owner was among them.
 */
async function authoriseWorkspaceWrite(
  db: Awaited<ReturnType<typeof scopedDb>>["db"],
  orgId: string,
  actor: { role: string },
  authenticated: boolean,
  entity: string | undefined,
  intent: "write" | "deactivate" = "write",
): Promise<Response | null> {
  if (!authenticated) {
    return Response.json({ error: "Sign in to make this change." }, { status: 401 });
  }
  const capability =
    intent === "deactivate"
      ? "users.deactivate"
      : WORKSPACE_CAPABILITY[entity ?? ""];
  if (!capability) {
    return Response.json({ error: "Unknown record type." }, { status: 400 });
  }
  const subject = await resolvePermissions(db, orgId, actor.role as WorkspaceRole);
  return requireCapability(subject, capability);
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const { actor, authenticated, db, orgId } = await scopedDb(request);
    await seedWorkspaceIfEmpty(db, orgId);
    const payload = await request.json() as { entity?: WorkspaceEntity; data?: Record<string, unknown> };
    const entity = payload.entity;
    const data = payload.data ?? {};
    const refusal = await authoriseWorkspaceWrite(db, orgId, actor, authenticated, entity);
    if (refusal) return refusal;
    let id = "";

    if (entity === "site") {
      const name = text(data.name, 120);
      if (!name || !text(data.address, 300)) throw new Error("A site name and address are required.");
      id = newId("store", name);
      await db.insert(sites).values({ id, organisationId: orgId, name, type: text(data.type, 40) || "Kiosk", region: text(data.region, 40) || "UK", lifecycle: text(data.lifecycle, 40) || "Current", address: text(data.address, 300), manager: optionalText(data.manager, 120) });
    } else if (entity === "compliance") {
      const siteId = text(data.siteId, 100);
      const kind = text(data.kind, 120);
      if (!siteId || !kind) throw new Error("A site and requirement are required.");
      id = newId("compliance", `${siteId}-${kind}`);
      const state = text(data.state, 40) || "Missing";
      await db.insert(complianceDocuments).values({ id, organisationId: orgId, siteId, kind, status: state, expiryDate: optionalText(data.expiry, 40), notRequired: state === "Not required" });
    } else if (entity === "unit") {
      const name = text(data.name, 140);
      const siteId = text(data.siteId, 100);
      if (!name || !siteId) throw new Error("A unit name and site are required.");
      id = newId("unit", name);
      await db.insert(units).values({ id, organisationId: orgId, siteId, name, category: text(data.category, 80) || "Asset", manufacturer: optionalText(data.manufacturer, 100), model: optionalText(data.model, 100), serialNumber: optionalText(data.serialNumber, 100), status: text(data.status, 40) || "Active", notes: optionalText(data.notes, 500) });
    } else if (entity === "contractor") {
      const name = text(data.name, 140);
      if (!name) throw new Error("A contractor name is required.");
      id = newId("contractor", name);
      await db.insert(contractors).values({ id, organisationId: orgId, name, email: optionalText(data.email, 160), phone: optionalText(data.phone, 80), serviceCategories: JSON.stringify(stringArray(data.serviceCategories)), coverageAreas: JSON.stringify(stringArray(data.coverageAreas)), certifications: JSON.stringify(stringArray(data.certifications)), insuranceExpiry: optionalText(data.insuranceExpiry, 40), availability: text(data.availability, 60) || "Available", rating: numeric(data.rating, 0, 0, 5), active: booleanValue(data.active) });
    } else if (entity === "planned") {
      const title = text(data.title, 160);
      const siteId = text(data.siteId, 100);
      const nextDueAt = text(data.nextDueAt, 40);
      if (!title || !siteId || !nextDueAt) throw new Error("A title, site and next due date are required.");
      id = newId("planned", title);
      await db.insert(plannedMaintenance).values({ id, organisationId: orgId, siteId, unitId: optionalText(data.unitId, 100), contractorId: optionalText(data.contractorId, 100), title, category: text(data.category, 80) || "Planned maintenance", frequency: text(data.frequency, 60) || "Annual", nextDueAt, lastCompletedAt: optionalText(data.lastCompletedAt, 40), status: text(data.status, 40) || "Scheduled", reminderDays: numeric(data.reminderDays, 30, 0, 365) });
    } else if (entity === "member") {
      const name = text(data.name, 120);
      const email = text(data.email, 180).toLowerCase();
      if (!name || !email.includes("@")) throw new Error("A name and valid email are required.");
      id = newId("user", email);
      await db.insert(users).values({ id, organisationId: orgId, fullName: name, email, role: text(data.role, 60) || "Client", active: booleanValue(data.active) });
    } else if (entity === "settings") {
      id = orgId;
      const settings = data as unknown as WorkspaceSettings;
      await db.insert(workspaceSettings).values({ legacyClientId: orgId, organisationId: orgId, settings: JSON.stringify(settings), updatedByEmail: actor.email, updatedAt: new Date().toISOString() }).onConflictDoUpdate({ target: workspaceSettings.organisationId, set: { settings: JSON.stringify(settings), updatedByEmail: actor.email, updatedAt: new Date().toISOString() } });
    } else {
      return Response.json({ error: "Unsupported workspace record." }, { status: 400 });
    }

    await logChange(db, orgId, entity, id, "created", actor.email, data);
    return Response.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The record could not be created.";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const { actor, authenticated, db, orgId } = await scopedDb(request);
    await seedWorkspaceIfEmpty(db, orgId);
    const payload = await request.json() as { entity?: WorkspaceEntity; id?: string; data?: Record<string, unknown> };
    const entity = payload.entity;
    const id = text(payload.id, 120);
    const data = payload.data ?? {};
    if (!entity || !id) return Response.json({ error: "A record type and ID are required." }, { status: 400 });
    const refusal = await authoriseWorkspaceWrite(db, orgId, actor, authenticated, entity);
    if (refusal) return refusal;
    if (entity === "site") {
      await db.update(sites).set({ name: text(data.name, 120), type: text(data.type, 40), region: text(data.region, 40), lifecycle: text(data.lifecycle, 40), address: text(data.address, 300), manager: optionalText(data.manager, 120), updatedAt: new Date().toISOString() }).where(and(eq(sites.id, id), eq(sites.organisationId, orgId)));
    } else if (entity === "compliance") {
      const state = text(data.state, 40) || "Missing";
      await db.update(complianceDocuments).set({ siteId: text(data.siteId, 100), kind: text(data.kind, 120), status: state, expiryDate: optionalText(data.expiry, 40), notRequired: state === "Not required", updatedAt: new Date().toISOString() }).where(and(eq(complianceDocuments.id, id), eq(complianceDocuments.organisationId, orgId)));
    } else if (entity === "unit") {
      await db.update(units).set({ siteId: text(data.siteId, 100), name: text(data.name, 140), category: text(data.category, 80), manufacturer: optionalText(data.manufacturer, 100), model: optionalText(data.model, 100), serialNumber: optionalText(data.serialNumber, 100), status: text(data.status, 40), notes: optionalText(data.notes, 500), updatedAt: new Date().toISOString() }).where(and(eq(units.id, id), eq(units.organisationId, orgId)));
    } else if (entity === "contractor") {
      await db.update(contractors).set({ name: text(data.name, 140), email: optionalText(data.email, 160), phone: optionalText(data.phone, 80), serviceCategories: JSON.stringify(stringArray(data.serviceCategories)), coverageAreas: JSON.stringify(stringArray(data.coverageAreas)), certifications: JSON.stringify(stringArray(data.certifications)), insuranceExpiry: optionalText(data.insuranceExpiry, 40), availability: text(data.availability, 60), rating: numeric(data.rating, 0, 0, 5), active: booleanValue(data.active), updatedAt: new Date().toISOString() }).where(and(eq(contractors.id, id), eq(contractors.organisationId, orgId)));
    } else if (entity === "planned") {
      await db.update(plannedMaintenance).set({ siteId: text(data.siteId, 100), unitId: optionalText(data.unitId, 100), contractorId: optionalText(data.contractorId, 100), title: text(data.title, 160), category: text(data.category, 80), frequency: text(data.frequency, 60), nextDueAt: text(data.nextDueAt, 40), lastCompletedAt: optionalText(data.lastCompletedAt, 40), status: text(data.status, 40), reminderDays: numeric(data.reminderDays, 30, 0, 365), updatedAt: new Date().toISOString() }).where(and(eq(plannedMaintenance.id, id), eq(plannedMaintenance.organisationId, orgId)));
    } else if (entity === "member") {
      await db.update(users).set({ fullName: text(data.name, 120), email: text(data.email, 180).toLowerCase(), role: text(data.role, 60), active: booleanValue(data.active), updatedAt: new Date().toISOString() }).where(and(eq(users.id, id), eq(users.organisationId, orgId)));
    } else if (entity === "settings") {
      const settings = data as unknown as WorkspaceSettings;
      await db.insert(workspaceSettings).values({ legacyClientId: orgId, organisationId: orgId, settings: JSON.stringify(settings), updatedByEmail: actor.email, updatedAt: new Date().toISOString() }).onConflictDoUpdate({ target: workspaceSettings.organisationId, set: { settings: JSON.stringify(settings), updatedByEmail: actor.email, updatedAt: new Date().toISOString() } });
    } else {
      return Response.json({ error: "Unsupported workspace record." }, { status: 400 });
    }

    await logChange(db, orgId, entity, id, "updated", actor.email, data);
    return Response.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The record could not be updated.";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const { actor, authenticated, db, orgId } = await scopedDb(request);
    await seedWorkspaceIfEmpty(db, orgId);
    const payload = await request.json() as { entity?: WorkspaceEntity; id?: string };
    const entity = payload.entity;
    const id = text(payload.id, 120);
    if (!entity || !id) return Response.json({ error: "A record type and ID are required." }, { status: 400 });
    const refusal = await authoriseWorkspaceWrite(
      db,
      orgId,
      actor,
      authenticated,
      entity,
      entity === "member" ? "deactivate" : "write",
    );
    if (refusal) return refusal;
    if (entity === "site") await db.update(sites).set({ lifecycle: "Closed", updatedAt: new Date().toISOString() }).where(and(eq(sites.id, id), eq(sites.organisationId, orgId)));
    else if (entity === "compliance") await db.update(complianceDocuments).set({ status: "Not required", notRequired: true, updatedAt: new Date().toISOString() }).where(and(eq(complianceDocuments.id, id), eq(complianceDocuments.organisationId, orgId)));
    else if (entity === "unit") await db.update(units).set({ status: "Retired", updatedAt: new Date().toISOString() }).where(and(eq(units.id, id), eq(units.organisationId, orgId)));
    else if (entity === "contractor") await db.update(contractors).set({ active: false, availability: "Inactive", updatedAt: new Date().toISOString() }).where(and(eq(contractors.id, id), eq(contractors.organisationId, orgId)));
    else if (entity === "planned") await db.update(plannedMaintenance).set({ status: "Cancelled", updatedAt: new Date().toISOString() }).where(and(eq(plannedMaintenance.id, id), eq(plannedMaintenance.organisationId, orgId)));
    else if (entity === "member") await db.update(users).set({ active: false, updatedAt: new Date().toISOString() }).where(and(eq(users.id, id), eq(users.organisationId, orgId)));
    else return Response.json({ error: "This record cannot be archived." }, { status: 400 });

    await logChange(db, orgId, entity, id, "archived", actor.email, {});
    return Response.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The record could not be archived.";
    return Response.json({ error: message }, { status: 400 });
  }
}
