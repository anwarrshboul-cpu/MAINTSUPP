import { and, count, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import {
  activityLog,
  complianceDocuments,
  contractors,
  maintenanceBoardColumns,
  maintenanceRequests,
  memberships,
  plannedMaintenance,
  sites,
  units,
  users,
  workspaceSettings,
} from "../../../db/schema";
// The one table of Store Documentation slots. The register keys off it too; a
// second copy here is how the calendar and the board would drift apart.
import { storeDocumentationCertificates } from "../../../db/monday-board-spec";
import {
  STORE_DOCUMENTATION_BOARD_ID,
  readComplianceRegister,
} from "../../lib/compliance-register";
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

/**
 * A day rate, in pence.
 *
 * The form asks for pounds because that is what a rate card says, and the
 * column stores pence because that is what every other money column here
 * stores. An empty box is not a rate of zero — it means nobody has recorded
 * one — so it stays null and the register prints a dash rather than "£0.00",
 * which would read as "they work for free".
 */
function ratePence(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const pounds = Number(value);
  if (!Number.isFinite(pounds) || pounds < 0) return null;
  return Math.round(pounds * 100);
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
    openJobRows,
    contractorJobRows,
    activities,
    register,
    documentationColumnRows,
  ] = await Promise.all([
    db.select().from(sites).where(eq(sites.organisationId, orgId)).orderBy(sites.name),
    db.select().from(units).where(eq(units.organisationId, orgId)).orderBy(units.name),
    db.select().from(contractors).where(eq(contractors.organisationId, orgId)).orderBy(contractors.name),
    db.select().from(plannedMaintenance).where(eq(plannedMaintenance.organisationId, orgId)).orderBy(plannedMaintenance.nextDueAt),
    db.select().from(users).where(eq(users.organisationId, orgId)).orderBy(users.fullName),
    db.select().from(workspaceSettings).where(eq(workspaceSettings.organisationId, orgId)).limit(1),
    /*
     * ── Two tallies, not the whole job table ────────────────────────────────
     *
     * This was `db.select().from(maintenanceRequests)` — every column of every
     * live job in the workspace, 776 rows and ~950KB out of Postgres — read so
     * that the fourteen lines below it could produce one count per site and
     * four numbers per contractor. The rows were then discarded; they never
     * reached the browser, which is why this route's RESPONSE is 146KB and its
     * cost looked unexplained from the outside.
     *
     * Measured with `PG_D1_TRACE=1` against Supabase: that select was the
     * slowest statement in the request at 512ms of a 798ms total, and the
     * request is on the Dashboard Overview's critical path — the compliance
     * donut, the compliance percentage and "Active units" all wait for it.
     * Postgres answers the same question with two GROUP BYs over an index in a
     * fraction of that, and the aggregates are ~40 rows rather than 776.
     *
     * The grouping is on the WHOLE stored value in both queries, and that is
     * deliberate. This board carries eleven monday status strings — "Waiting
     * for parts", "Quote Received (waiting for Approval)" — and an earlier
     * attempt to match them by substring swallowed 54 of 59 open jobs. Nothing
     * here matches a prefix, a substring or a pattern: `stage` is compared with
     * `=` and `<>` against the exact values the loop used, and `contractor` is
     * grouped by identity, exactly as `request.contractor === contractor.name`
     * compared it.
     *
     * Stage 23 — binned jobs are not open, so both keep the `deletedAt` filter.
     */
    db
      .select({ siteId: maintenanceRequests.siteId, open: count() })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          isNull(maintenanceRequests.deletedAt),
          ne(maintenanceRequests.stage, "Completed"),
        ),
      )
      .groupBy(maintenanceRequests.siteId),
    /*
     * `case when … then 1 else 0 end` and `coalesce`, rather than Postgres'
     * `count(*) filter (where …)`: this application also runs on SQLite when
     * `PG_D1` is unset, `db/sqlite-to-postgres.ts` translates one dialect into
     * the other, and FILTER is not in the SQLite subset it accepts. Both
     * constructs here are spelled identically by both engines, as is the
     * `<>` inequality.
     */
    db
      .select({
        contractor: maintenanceRequests.contractor,
        assigned: count(),
        completed: sql<number>`sum(case when ${maintenanceRequests.stage} = ${"Completed"} then 1 else 0 end)`,
        urgent: sql<number>`sum(case when ${maintenanceRequests.priority} = ${"Urgent"} and ${maintenanceRequests.stage} <> ${"Completed"} then 1 else 0 end)`,
        spend: sql<number>`coalesce(sum(${maintenanceRequests.cost}), 0)`,
      })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          isNull(maintenanceRequests.deletedAt),
        ),
      )
      .groupBy(maintenanceRequests.contractor),
    db.select().from(activityLog).where(eq(activityLog.organisationId, orgId)).orderBy(desc(activityLog.createdAt)).limit(60),
    readComplianceRegister(db, orgId),
    /*
     * The Store Documentation board's own columns, id and key only.
     *
     * Two dozen rows on an indexed pair, read so a compliance record can carry
     * the id of the cell its expiry lives in — see `expiryColumnId`. Deleted
     * columns are excluded, so a slot whose column has been removed from the
     * board resolves to null and the calendar refuses the edit honestly instead
     * of posting an id `update_cell` would 404 on.
     */
    db
      .select({
        id: maintenanceBoardColumns.id,
        columnKey: maintenanceBoardColumns.key,
      })
      .from(maintenanceBoardColumns)
      .where(
        and(
          eq(maintenanceBoardColumns.organisationId, orgId),
          eq(maintenanceBoardColumns.boardId, STORE_DOCUMENTATION_BOARD_ID),
          isNull(maintenanceBoardColumns.deletedAt),
        ),
      ),
  ]);

  /*
   * Keyed by site id, and a job with no site contributes to none of them.
   *
   * `site_id` is nullable now, so this grouped a `null` key alongside the real
   * ones — and every unattached job in the estate would have been counted
   * against whichever site that key happened to reach. An unattached job is not
   * open work at any site; it is work whose site nobody has established yet,
   * and it is surfaced as that rather than folded into a store's figures.
   */
  const openJobsBySite = new Map<string, number>(
    openJobRows
      .filter((row): row is typeof row & { siteId: string } => Boolean(row.siteId))
      .map((row) => [row.siteId, Number(row.open)]),
  );
  /*
   * Keyed by the contractor name exactly as stored on the job. Jobs with no
   * contractor group under `null`, which no contractor's name can equal — the
   * same rows the old `request.contractor === contractor.name` filter dropped.
   */
  const jobsByContractor = new Map(
    contractorJobRows
      .filter((row): row is typeof row & { contractor: string } => row.contractor !== null)
      .map((row) => [row.contractor, row]),
  );
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
   *
   * `itemId`, `slotKey` and `expiryColumnKey` carry the record's PROVENANCE out
   * with it. The register has always known which board row and which slot a
   * document came from; this payload used to drop that on the floor, which was
   * harmless while every screen only read the register. The calendar writes:
   * moving a certificate expiry there has to reach the same cell the Store
   * Documentation board writes, or the next `readComplianceRegister` recomputes
   * the state from the untouched board cell and the operator watches their edit
   * disappear on the next refresh. So the column key travels WITH the record
   * rather than being re-derived from `kind` by whoever happens to need it.
   */
  const expiryColumnBySlot = new Map(
    storeDocumentationCertificates.map((slot) => [slot.key, slot.expiryColumn]),
  );
  const columnIdByKey = new Map(
    (documentationColumnRows as Array<{ id: string; columnKey: string }>).map(
      (column) => [column.columnKey, column.id],
    ),
  );
  const compliance: WorkspaceComplianceRecord[] = register.entries.map((entry) => {
    const expiryColumnKey = entry.slotKey
      ? (expiryColumnBySlot.get(entry.slotKey) ?? null)
      : null;
    return {
      id: entry.id,
      siteId: entry.siteId,
      siteName: entry.siteName,
      kind: entry.kind,
      state: entry.state,
      expiry: entry.expiry,
      fileCount: entry.fileCount,
      siteType: entry.siteType,
      siteAddress: entry.siteAddress,
      itemId: entry.itemId,
      slotKey: entry.slotKey,
      /*
       * Null for the three slots the board tracks no expiry on — RAMS, the Fire
       * Risk Assessment and the store Drawing — and for a register-only row,
       * which has no slot at all.
       */
      expiryColumnKey,
      /*
       * And null again when that column is not on this organisation's board —
       * a workspace that has never seeded Store Documentation, or one where the
       * column was deleted. The calendar reads this, not the key, to decide
       * whether the expiry is writable.
       */
      expiryColumnId: expiryColumnKey
        ? (columnIdByKey.get(expiryColumnKey) ?? null)
        : null,
    };
  });

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
    // No jobs carrying this name is a real answer — zeroes, not an absent row.
    const tally = jobsByContractor.get(contractor.name);
    return {
      id: contractor.id,
      name: contractor.name,
      email: contractor.email,
      phone: contractor.phone,
      // The person, the place, what was agreed and what it costs — see the
      // note on the `contractors` table for why the row could not hold them.
      contactName: contractor.contactName,
      address: contractor.address,
      notes: contractor.notes,
      dayRatePence: contractor.dayRatePence,
      serviceCategories: parseStringArray(contractor.serviceCategories),
      coverageAreas: parseStringArray(contractor.coverageAreas),
      certifications: parseStringArray(contractor.certifications),
      insuranceExpiry: contractor.insuranceExpiry,
      availability: contractor.availability,
      rating: contractor.rating,
      active: contractor.active,
      assignedJobs: Number(tally?.assigned ?? 0),
      completedJobs: Number(tally?.completed ?? 0),
      urgentJobs: Number(tally?.urgent ?? 0),
      spend: Number(tally?.spend ?? 0),
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
    /*
     * An object or nothing. The branches below ask `"key" in data` before
     * writing a column, and `in` throws a TypeError on a primitive, so a body
     * whose `data` was a string or a number answered with a V8 message about
     * the `in` operator instead of a refusal. An array is not a record either.
     */
    const rawData = payload.data;
    const data = rawData && typeof rawData === "object" && !Array.isArray(rawData) ? rawData : {};
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
      // Before the insert, so a refusal writes nothing. See `referenceRefusal`.
      const badReference = await referencesRefusal(db, orgId, [{ kind: "site", value: siteId }]);
      if (badReference) return badReference;
      id = newId("compliance", `${siteId}-${kind}`);
      const state = text(data.state, 40) || "Missing";
      await db.insert(complianceDocuments).values({ id, organisationId: orgId, siteId, kind, status: state, expiryDate: optionalText(data.expiry, 40), notRequired: state === "Not required" });
    } else if (entity === "unit") {
      const name = text(data.name, 140);
      const siteId = text(data.siteId, 100);
      if (!name || !siteId) throw new Error("A unit name and site are required.");
      // Before the insert, so a refusal writes nothing. See `referenceRefusal`.
      const badReference = await referencesRefusal(db, orgId, [{ kind: "site", value: siteId }]);
      if (badReference) return badReference;
      id = newId("unit", name);
      await db.insert(units).values({ id, organisationId: orgId, siteId, name, category: text(data.category, 80) || "Asset", manufacturer: optionalText(data.manufacturer, 100), model: optionalText(data.model, 100), serialNumber: optionalText(data.serialNumber, 100), status: text(data.status, 40) || "Active", notes: optionalText(data.notes, 500) });
    } else if (entity === "contractor") {
      const name = text(data.name, 140);
      if (!name) throw new Error("A contractor name is required.");
      id = newId("contractor", name);
      await db.insert(contractors).values({ id, organisationId: orgId, name, email: optionalText(data.email, 160), phone: optionalText(data.phone, 80), contactName: optionalText(data.contactName, 140), address: optionalText(data.address, 240), notes: optionalText(data.notes, 2000), dayRatePence: ratePence(data.dayRate), serviceCategories: JSON.stringify(stringArray(data.serviceCategories)), coverageAreas: JSON.stringify(stringArray(data.coverageAreas)), certifications: JSON.stringify(stringArray(data.certifications)), insuranceExpiry: optionalText(data.insuranceExpiry, 40), availability: text(data.availability, 60) || "Available", rating: numeric(data.rating, 0, 0, 5), active: booleanValue(data.active) });
    } else if (entity === "planned") {
      const title = text(data.title, 160);
      const siteId = text(data.siteId, 100);
      const nextDueAt = text(data.nextDueAt, 40);
      if (!title || !siteId || !nextDueAt) throw new Error("A title, site and next due date are required.");
      /*
       * `unitId` and `contractorId` are optional — `referencesRefusal` skips a
       * null, which is what "No linked unit" and "No contractor" send.
       */
      const unitId = optionalText(data.unitId, 100);
      const contractorId = optionalText(data.contractorId, 100);
      // Before the insert, so a refusal writes nothing. See `referenceRefusal`.
      const badReference = await referencesRefusal(db, orgId, [
        { kind: "site", value: siteId },
        { kind: "unit", value: unitId },
        { kind: "contractor", value: contractorId },
      ]);
      if (badReference) return badReference;
      id = newId("planned", title);
      await db.insert(plannedMaintenance).values({ id, organisationId: orgId, siteId, unitId, contractorId, title, category: text(data.category, 80) || "Planned maintenance", frequency: text(data.frequency, 60) || "Annual", nextDueAt, lastCompletedAt: optionalText(data.lastCompletedAt, 40), status: text(data.status, 40) || "Scheduled", reminderDays: numeric(data.reminderDays, 30, 0, 365) });
    } else if (entity === "member") {
      const name = text(data.name, 120);
      const email = text(data.email, 180).toLowerCase();
      if (!name || !email.includes("@")) throw new Error("A name and valid email are required.");
      /*
       * Before the insert, so a refusal writes nothing. The `|| "Client"` below
       * still covers an omitted role; this refuses a supplied one that is not a
       * role, which on a new member is the value the seed above would otherwise
       * turn into a membership. See `MEMBER_ROLES` for what that does and does
       * not close.
       */
      const badRole = memberRoleRefusal(data);
      if (badRole) return badRole;
      const badAccess = memberActiveRefusal(data);
      if (badAccess) return badAccess;
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

/**
 * Include a column in an UPDATE only when the caller actually sent it.
 *
 * THE BUG THIS EXISTS FOR. Every PATCH branch below builds its `set` from
 * `text(data.x)` unconditionally, and `text` turns a missing key into "". The
 * manage form always posts a whole record so the screens never noticed — but
 * anything sending a partial update, which is the obvious way to use a PATCH,
 * silently blanked every field it did not mention. Deactivating a contractor
 * with `{ active: false }` erased their name, email, phone, trades and
 * coverage, leaving a nameless row in the register.
 */
function supplied<T>(
  data: Record<string, unknown>,
  key: string,
  read: (value: unknown) => T,
): Record<string, T> {
  return key in data ? { [key]: read(data[key]) } : {};
}

/**
 * Resolve one reference to a row THIS organisation owns, or refuse.
 *
 * `siteId`, `unitId` and `contractorId` arrived trimmed and length-capped and
 * nothing more, so a caller could file a unit, a compliance record or a
 * planned visit in their OWN tenant against ANOTHER tenant's site, unit or
 * contractor id. The row lands in the actor's organisation and its reference
 * then points across the tenant boundary, which corrupts every site-joined
 * report and every compliance count on both sides of it.
 *
 * The database does not catch this in any configuration. Three of these
 * columns have no foreign key in the runtime DDL at all — `compliance_documents
 * .site_id` (db/init.ts), `planned_maintenance.unit_id` and `.contractor_id` —
 * and SQLite runs with `foreign_keys` OFF, which is its default and is never
 * turned on here. Where the key does exist it only catches an id that exists
 * nowhere; another tenant's real site satisfies it perfectly.
 *
 * Same shape as the site check on `POST /api/board/items`: one
 * organisation-scoped SELECT, 404 on a miss.
 *
 * 404 for BOTH a nonexistent id and one belonging to another organisation, with
 * a byte-identical body. A 403 for the second would be an existence oracle:
 * site ids here are `store-<slug of the store name>-<8 hex>`, so confirming an
 * id exists confirms the STORE NAME to a stranger in another tenant. One query
 * carrying both predicates makes the two cases indistinguishable by
 * construction rather than by policy, so no later edit can re-separate them.
 */
async function referenceRefusal(
  db: WorkspaceDb,
  orgId: string,
  kind: "site" | "unit" | "contractor",
  value: string,
): Promise<Response | null> {
  /*
   * Spelled out per table rather than parameterised over one: drizzle's
   * `.from()` does not take a union of table types, and three explicit selects
   * read more honestly than a cast that hides which table is being asked.
   */
  const rows =
    kind === "site"
      ? await db
          .select({ id: sites.id })
          .from(sites)
          .where(and(eq(sites.id, value), eq(sites.organisationId, orgId)))
          .limit(1)
      : kind === "unit"
        ? await db
            .select({ id: units.id })
            .from(units)
            .where(and(eq(units.id, value), eq(units.organisationId, orgId)))
            .limit(1)
        : await db
            .select({ id: contractors.id })
            .from(contractors)
            .where(and(eq(contractors.id, value), eq(contractors.organisationId, orgId)))
            .limit(1);
  if (rows.length > 0) return null;
  const label = kind === "site" ? "Site" : kind === "unit" ? "Unit" : "Contractor";
  return Response.json({ error: `${label} not found.` }, { status: 404 });
}

/**
 * Every reference on one record, checked before anything is written.
 *
 * An absent or empty value is SKIPPED, not refused. `unit_id` and
 * `contractor_id` are nullable and the manage form sends "" for them
 * deliberately — "No linked unit" and "No contractor" are the first option in
 * both selects — so refusing "" would make every planned visit without a
 * contractor unsavable. Required references are non-empty-checked at their own
 * call site, where the message can name the missing field.
 *
 * Sequential rather than `Promise.all` so the first bad reference is the one
 * reported, which is the one the operator has to fix.
 */
async function referencesRefusal(
  db: WorkspaceDb,
  orgId: string,
  references: Array<{ kind: "site" | "unit" | "contractor"; value: string | null }>,
): Promise<Response | null> {
  for (const reference of references) {
    if (!reference.value) continue;
    const refusal = await referenceRefusal(db, orgId, reference.kind, reference.value);
    if (refusal) return refusal;
  }
  return null;
}

/**
 * A NOT NULL text column, refused when the caller explicitly sends it empty.
 *
 * `supplied` fixes omission. It does not fix `{ name: "" }`, and "" satisfies
 * NOT NULL, so an explicit blank still reaches the column. The POST branches
 * already refuse exactly these fields, so this is PATCH agreeing with POST
 * about one rule rather than inventing a new one.
 *
 * A refusal rather than a silent ignore: ignoring would answer 200 and the
 * dashboard would toast "Shared workspace updated" over an edit that did
 * nothing. It is unreachable from the real UI — every one of these fields is
 * `required` in the manage form — so it only ever answers an API caller, which
 * is exactly who should be told.
 */
function requiredTextRefusal(
  data: Record<string, unknown>,
  key: string,
  max: number,
  message: string,
): Response | null {
  if (!(key in data)) return null;
  return text(data[key], max) ? null : Response.json({ error: message }, { status: 400 });
}

/**
 * The roles the Team tab can express, refused when it is sent anything else.
 *
 * `users.role` had no allow-list on either verb, so a caller holding
 * `users.edit` could store any string at all — and the tab prints that string
 * straight back, so "Owner", "" or a paragraph of markup became a role this
 * workspace appears to have. These three are the whole set: the manage form's
 * select offers exactly them, `ROLE_LABEL` in the invitation tokens writes
 * exactly them, and `seedWorkspaceIfEmpty` above maps exactly them onto the
 * three membership roles.
 *
 * The column is a LABEL, not authority. Access comes from `memberships`, and
 * `/api/admin/users` is what changes that — behind a rank check, a
 * no-self-promotion rule and a last-super-admin guard-rail this route has none
 * of. Writing "Super Admin" here renames somebody on a screen.
 *
 * The create is guarded as well as the edit, but be clear about what that does
 * and does not buy. `seedWorkspaceIfEmpty` above derives a membership from this
 * label for a member who has none yet, so on a NEW member the label briefly
 * becomes authority — and "Super Admin" is a legitimate entry here, so this
 * list stops a typo reaching that mapping and does not stop somebody choosing
 * the top of it. Closing that properly means the seed not deriving authority
 * from a display column at all, which is a change to the seed and not to this
 * check. An edit cannot reach the mapping either way: the membership already
 * exists by then and the insert leaves it alone.
 *
 * It is also narrower than it looks. The seed returns early outside the primary
 * organisation and outside development, so in production nothing derives a
 * membership from this column and the label really is only a label.
 */
const MEMBER_ROLES = ["Super Admin", "Admin", "Client"];

function memberRoleRefusal(data: Record<string, unknown>): Response | null {
  if (!("role" in data)) return null;
  return MEMBER_ROLES.includes(text(data.role, 60))
    ? null
    : Response.json(
        { error: `A member's role must be ${MEMBER_ROLES.join(", ")}.` },
        { status: 400 },
      );
}

/**
 * A member's access, refused when it is sent something that is not an answer.
 *
 * `booleanValue` falls back to TRUE for anything it cannot read, so `null`,
 * `"no"`, `[]` and the string `"0"` all RESTORED access to somebody whose
 * access had been withdrawn — while the number `0` correctly withdrew it.
 * Reactivating is a privilege-relevant act: withdrawing access through the
 * archive verb below needs `users.deactivate`, and restoring it on the admin
 * route sits behind a rank check, so it must not happen here by accident under
 * plain `users.edit`.
 *
 * The accepted set is exactly what `booleanValue` can read, so a caller
 * already sending `"true"` or `1` is unaffected and only genuinely ambiguous
 * values are refused — the same treatment `role` and `email` get above rather
 * than a silent guess.
 */
function memberActiveRefusal(data: Record<string, unknown>): Response | null {
  if (!("active" in data)) return null;
  const value = data.active;
  const readable =
    typeof value === "boolean" || value === "true" || value === "false" || value === 0 || value === 1;
  return readable
    ? null
    : Response.json({ error: "A member's access must be true or false." }, { status: 400 });
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const { actor, authenticated, db, orgId } = await scopedDb(request);
    await seedWorkspaceIfEmpty(db, orgId);
    const payload = await request.json() as { entity?: WorkspaceEntity; id?: string; data?: Record<string, unknown> };
    const entity = payload.entity;
    const id = text(payload.id, 120);
    /*
     * An object or nothing. The branches below ask `"key" in data` before
     * writing a column, and `in` throws a TypeError on a primitive, so a body
     * whose `data` was a string or a number answered with a V8 message about
     * the `in` operator instead of a refusal. An array is not a record either.
     */
    const rawData = payload.data;
    const data = rawData && typeof rawData === "object" && !Array.isArray(rawData) ? rawData : {};
    if (!entity || !id) return Response.json({ error: "A record type and ID are required." }, { status: 400 });
    const refusal = await authoriseWorkspaceWrite(db, orgId, actor, authenticated, entity);
    if (refusal) return refusal;
    if (entity === "site") {
      /*
       * Only what was sent — see `supplied`. `name`, `type`, `region`,
       * `lifecycle` and `address` are all NOT NULL on `sites`, and "" satisfies
       * NOT NULL, so the unconditional `text(data.x)` this replaces turned any
       * partial PATCH into a blanked row: a caller sending `{ lifecycle:
       * "Closed" }` erased the site's name, type, region and address and left a
       * nameless entry in the register — the one identifier `resolveSiteByName`,
       * the importer's index, Report-a-Job and the shared-form submit path all
       * key on. The manage form posts every field of the record, so nothing on
       * screen changes.
       *
       * `type`, `region` and `lifecycle` deliberately get no fallback even
       * though they are NOT NULL: the code this replaces wrote whatever arrived
       * including "", all three are fixed-option selects, and adding a default
       * would change behaviour for the full payloads the form sends.
       */
      const badName = requiredTextRefusal(data, "name", 120, "A site name is required.");
      if (badName) return badName;
      const badAddress = requiredTextRefusal(data, "address", 300, "A site address is required.");
      if (badAddress) return badAddress;
      /*
       * `lifecycle` is the only closed/open control this form has, and archiving
       * now writes all three state columns, so writing `lifecycle` alone would
       * leave a site the Sites screen still calls closed and this tab could
       * never reopen. `app/api/sites/route.ts` keeps the trio in step from the
       * other direction — it derives `lifecycle` and `active` from `status` —
       * and this is the same rule read backwards.
       *
       * Reopening only clears an actually-closed site. `status` also carries
       * 'international' and 'other', which are open states this form cannot
       * express, so forcing 'active' on every save would quietly flatten them.
       */
      let lifecycleState = {};
      if ("lifecycle" in data) {
        if (text(data.lifecycle, 40) === "Closed") {
          lifecycleState = { status: "closed", active: false };
        } else {
          const [current] = await db
            .select({ status: sites.status })
            .from(sites)
            .where(and(eq(sites.id, id), eq(sites.organisationId, orgId)))
            .limit(1);
          if (current?.status === "closed") lifecycleState = { status: "active", active: true };
        }
      }
      await db.update(sites).set({
        ...supplied(data, "name", (value) => text(value, 120)),
        ...supplied(data, "type", (value) => text(value, 40)),
        ...supplied(data, "region", (value) => text(value, 40)),
        ...supplied(data, "lifecycle", (value) => text(value, 40)),
        ...lifecycleState,
        ...supplied(data, "address", (value) => text(value, 300)),
        ...supplied(data, "manager", (value) => optionalText(value, 120)),
        updatedAt: new Date().toISOString(),
      }).where(and(eq(sites.id, id), eq(sites.organisationId, orgId)));
    } else if (entity === "compliance") {
      const state = text(data.state, 40) || "Missing";
      /*
       * Reference validation only. The UPDATE below names every column
       * unconditionally on purpose — the calendar's compliance PATCH sends all
       * four keys and depends on the full replace — so it is left exactly as it
       * was. See tests/acceptance-correction-one-calendar-data.test.mjs.
       */
      /*
       * Required UNCONDITIONALLY, unlike every other branch's guard. Those
       * branches only write a column when it was sent, so an omitted key is
       * harmless; this UPDATE names `site_id` and `kind` whatever arrives, so
       * OMITTING them is the request that does the damage — a
       * `{ state: "Valid" }` PATCH would answer 200 while blanking the
       * document's site and its requirement name. Refusing the partial keeps
       * the full replace the calendar depends on and closes the hole it opens.
       */
      if (!text(data.siteId, 100)) {
        return Response.json({ error: "A site is required." }, { status: 400 });
      }
      if (!text(data.kind, 120)) {
        return Response.json({ error: "A requirement is required." }, { status: 400 });
      }
      const badReference = await referencesRefusal(db, orgId, [
        { kind: "site", value: text(data.siteId, 100) },
      ]);
      if (badReference) return badReference;
      await db.update(complianceDocuments).set({ siteId: text(data.siteId, 100), kind: text(data.kind, 120), status: state, expiryDate: optionalText(data.expiry, 40), notRequired: state === "Not required", updatedAt: new Date().toISOString() }).where(and(eq(complianceDocuments.id, id), eq(complianceDocuments.organisationId, orgId)));
    } else if (entity === "unit") {
      /*
       * Only what was sent — see `supplied`. `siteId`, `name`, `category` and
       * `status` are NOT NULL, so a partial PATCH used to blank them, and a
       * blanked `site_id` detaches the unit from its site entirely. Validating
       * the site while the same statement could silently empty it would be
       * incoherent, so both land together.
       */
      const badName = requiredTextRefusal(data, "name", 140, "A unit name is required.");
      if (badName) return badName;
      const badSite = requiredTextRefusal(data, "siteId", 100, "A site is required.");
      if (badSite) return badSite;
      // Before the update, so a refusal writes nothing. See `referenceRefusal`.
      const badReference = await referencesRefusal(db, orgId, [
        { kind: "site", value: "siteId" in data ? text(data.siteId, 100) : null },
      ]);
      if (badReference) return badReference;
      await db.update(units).set({
        ...supplied(data, "siteId", (value) => text(value, 100)),
        ...supplied(data, "name", (value) => text(value, 140)),
        ...supplied(data, "category", (value) => text(value, 80)),
        ...supplied(data, "manufacturer", (value) => optionalText(value, 100)),
        ...supplied(data, "model", (value) => optionalText(value, 100)),
        ...supplied(data, "serialNumber", (value) => optionalText(value, 100)),
        ...supplied(data, "status", (value) => text(value, 40)),
        ...supplied(data, "notes", (value) => optionalText(value, 500)),
        updatedAt: new Date().toISOString(),
      }).where(and(eq(units.id, id), eq(units.organisationId, orgId)));
    } else if (entity === "contractor") {
      await db.update(contractors).set({
        // Only what was sent — see `supplied`. A partial PATCH used to blank
        // every column it did not mention.
        ...supplied(data, "name", (value) => text(value, 140)),
        ...supplied(data, "email", (value) => optionalText(value, 160)),
        ...supplied(data, "phone", (value) => optionalText(value, 80)),
        ...supplied(data, "contactName", (value) => optionalText(value, 140)),
        ...supplied(data, "address", (value) => optionalText(value, 240)),
        ...supplied(data, "notes", (value) => optionalText(value, 2000)),
        // The form's key is `dayRate` in pounds; the column is pence.
        ...("dayRate" in data ? { dayRatePence: ratePence(data.dayRate) } : {}),
        ...supplied(data, "serviceCategories", (value) => JSON.stringify(stringArray(value))),
        ...supplied(data, "coverageAreas", (value) => JSON.stringify(stringArray(value))),
        ...supplied(data, "certifications", (value) => JSON.stringify(stringArray(value))),
        ...supplied(data, "insuranceExpiry", (value) => optionalText(value, 40)),
        ...supplied(data, "availability", (value) => text(value, 60)),
        ...supplied(data, "rating", (value) => numeric(value, 0, 0, 5)),
        ...supplied(data, "active", booleanValue),
        updatedAt: new Date().toISOString(),
      }).where(and(eq(contractors.id, id), eq(contractors.organisationId, orgId)));
    } else if (entity === "planned") {
      /*
       * Only what was sent — see `supplied`. Every column here except `unitId`,
       * `contractorId` and `lastCompletedAt` is NOT NULL, so a partial PATCH
       * used to strip a scheduled visit of its title, category, frequency AND
       * next due date, which takes it off the calendar entirely. As with units,
       * validating the references while the same statement could silently empty
       * them would be incoherent, so both land together.
       */
      const badTitle = requiredTextRefusal(data, "title", 160, "A planned task title is required.");
      if (badTitle) return badTitle;
      const badSite = requiredTextRefusal(data, "siteId", 100, "A site is required.");
      if (badSite) return badSite;
      const badDue = requiredTextRefusal(data, "nextDueAt", 40, "A next due date is required.");
      if (badDue) return badDue;
      /*
       * `unitId` and `contractorId` are nullable and "" is how the form says
       * "none", so `referencesRefusal` skips an empty value — clearing a
       * contractor still works.
       */
      const badReference = await referencesRefusal(db, orgId, [
        { kind: "site", value: "siteId" in data ? text(data.siteId, 100) : null },
        { kind: "unit", value: "unitId" in data ? optionalText(data.unitId, 100) : null },
        { kind: "contractor", value: "contractorId" in data ? optionalText(data.contractorId, 100) : null },
      ]);
      if (badReference) return badReference;
      await db.update(plannedMaintenance).set({
        ...supplied(data, "siteId", (value) => text(value, 100)),
        ...supplied(data, "unitId", (value) => optionalText(value, 100)),
        ...supplied(data, "contractorId", (value) => optionalText(value, 100)),
        ...supplied(data, "title", (value) => text(value, 160)),
        ...supplied(data, "category", (value) => text(value, 80)),
        ...supplied(data, "frequency", (value) => text(value, 60)),
        ...supplied(data, "nextDueAt", (value) => text(value, 40)),
        ...supplied(data, "lastCompletedAt", (value) => optionalText(value, 40)),
        ...supplied(data, "status", (value) => text(value, 40)),
        ...supplied(data, "reminderDays", (value) => numeric(value, 30, 0, 365)),
        updatedAt: new Date().toISOString(),
      }).where(and(eq(plannedMaintenance.id, id), eq(plannedMaintenance.organisationId, orgId)));
    } else if (entity === "member") {
      /*
       * Only what was sent — see `supplied`. `users.email` is NOT NULL and
       * UNIQUE and `users.role` is NOT NULL, so the unconditional
       * `text(data.x)` this replaces turned any partial PATCH into a wrecked
       * account: pausing somebody with `{ active: false }` blanked their email
       * to "", which the unique index accepts exactly once — so the SECOND
       * member paused that way answered 400 with a raw constraint error — and
       * blanked their role and their name alongside it.
       *
       * `active` was worse than the text columns rather than better.
       * `booleanValue` falls back to TRUE, so a PATCH that mentioned only the
       * name silently RESTORED access to somebody whose access had been
       * withdrawn. It is the one field here where the fallback is the opposite
       * of what the caller asked for.
       *
       * The payload key is `name` and the column is `fullName`, so that one
       * cannot go through `supplied`, which spreads the key it is given — the
       * same reason `dayRate` is spelled out in the contractor branch above.
       */
      const badName = requiredTextRefusal(data, "name", 120, "A member name is required.");
      if (badName) return badName;
      /*
       * The rule the create above already applies. A member with no working
       * address is one nobody can invite, notify or send a reset to, and the
       * column is this workspace's only unique handle on a person. Conditional
       * on the key being present, because an omitted `email` now means "leave
       * it" rather than ""; "" fails `includes("@")` too, so one check covers
       * the blank and the malformed alike.
       */
      if ("email" in data && !text(data.email, 180).includes("@")) {
        return Response.json({ error: "A valid email is required." }, { status: 400 });
      }
      // Before the update, so a refusal writes nothing. See `memberRoleRefusal`.
      const badRole = memberRoleRefusal(data);
      if (badRole) return badRole;
      const badAccess = memberActiveRefusal(data);
      if (badAccess) return badAccess;
      await db.update(users).set({
        ...("name" in data ? { fullName: text(data.name, 120) } : {}),
        ...supplied(data, "email", (value) => text(value, 180).toLowerCase()),
        ...supplied(data, "role", (value) => text(value, 60)),
        ...supplied(data, "active", booleanValue),
        updatedAt: new Date().toISOString(),
      }).where(and(eq(users.id, id), eq(users.organisationId, orgId)));
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
    /*
     * All three state columns, in the order `DELETE /api/sites` writes them.
     * Archiving here used to set `lifecycle` alone, leaving `status` at
     * 'active' and `active` at true, so an archived site stayed in every
     * surface that filters on those two — `app/lib/form-options.ts` offers it
     * on the public Location dropdown, the Sites screen files it under Active
     * and still shows a Close button, and the options tally counts it against
     * 'active'. 'closed' is the seeded site_status option, and this is the
     * literal `app/api/sites/route.ts` already writes.
     */
    if (entity === "site") await db.update(sites).set({ status: "closed", lifecycle: "Closed", active: false, updatedAt: new Date().toISOString() }).where(and(eq(sites.id, id), eq(sites.organisationId, orgId)));
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
