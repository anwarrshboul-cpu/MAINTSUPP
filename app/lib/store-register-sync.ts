/**
 * THE SITE REGISTER FOLLOWS MONDAY'S STORE DOCUMENTATION BOARD.
 *
 * The owner's rule (2026-10-06): the Sunnamusk sites "have to match exactly the
 * number of the sites that are on monday.com — no extra, no less", with their
 * information taken from the Store Documentation board (1398027719), and the
 * assets "connected and synchronised based on the sites".
 *
 * Each live Store Documentation row (after it has been mirrored onto the
 * `store-documentation` board by the live sync) is one site:
 *
 *   monday Name           -> site name (and `monday_compliance_name`)
 *   monday Store Type     -> site type
 *   monday Store Address  -> site address
 *   monday group          -> status and site group
 *                              Current stores -> active
 *                              Europe         -> international
 *                              Other          -> active (office, warehouses)
 *                              Closed         -> closed
 *
 * ── A MONDAY CHANGE FLOWS IN; A PORTAL EDIT STANDS ─────────────────────────
 *
 * `sites.monday_snapshot` holds the values last applied. A field is written
 * only when monday's value differs from the snapshot — i.e. when somebody
 * changed it ON MONDAY. A store dragged into "London" in the portal therefore
 * stays in London until monday itself moves that store to another group, and a
 * manager's phone number typed into the portal is never touched at all (it is
 * not a monday field).
 *
 * ── WHAT IT NEVER DOES ─────────────────────────────────────────────────────
 *
 *  · It never deletes a site. A store removed from monday leaves its site in
 *    place, because its jobs and certificates hang off it; removing one is a
 *    decision for a person.
 *  · It never invents a store from a placeholder. monday's "Item 5" — a row
 *    with a generated name and no address — is skipped, as the owner decided.
 *  · It runs for the organisation the monday sync writes to and nowhere else:
 *    the other workspaces hold their own sites, which no monday board owns.
 *
 * After the sites, `reconcileSiteUnits` brings each site's own asset into line,
 * so one call keeps sites, groups and assets together.
 */

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  maintenanceBoardCells,
  maintenanceBoardColumns,
  maintenanceGroupItems,
  maintenanceGroups,
  maintenanceRequests,
  siteGroupMembers,
  siteGroups,
  sites,
} from "../../db/schema";
import { normaliseSiteName } from "./site-name-link";
import { isPlaceholderStore } from "./site-unit-values";
import { reconcileSiteUnits } from "./site-units";

type Database = Awaited<ReturnType<typeof getDb>>;

const BOARD = "store-documentation";

/** monday's group, by the key at the end of the seeded group id or by its name. */
type GroupKey = "topics" | "europe" | "closed" | "other";

const GROUP_BY_NAME: Record<string, GroupKey> = {
  "current stores": "topics",
  europe: "europe",
  closed: "closed",
  other: "other",
};

/** The site group each monday group lands in — the four seeded ones. */
const SITE_GROUP_SLUG: Record<GroupKey, string> = {
  topics: "current-stores",
  europe: "europe",
  closed: "closed",
  other: "other",
};

const STATUS_FOR_GROUP: Record<GroupKey, { status: string; active: boolean; lifecycle: string }> = {
  topics: { status: "active", active: true, lifecycle: "Current" },
  europe: { status: "international", active: true, lifecycle: "Current" },
  other: { status: "active", active: true, lifecycle: "Current" },
  closed: { status: "closed", active: false, lifecycle: "Closed" },
};

export type StoreDocumentationStore = {
  requestId: string;
  mondayId: string | null;
  name: string;
  type: string;
  address: string;
  group: GroupKey;
  siteId: string | null;
};

type Snapshot = { name?: string; type?: string; address?: string; group?: string };

export type StoreRegisterResult = {
  stores: number;
  skipped: string[];
  linked: number;
  created: number;
  updated: number;
  regrouped: number;
  notOnMonday: string[];
  units: { created: number; updated: number };
};

export { isPlaceholderStore };

/** monday exports leave a stray quote at either end of some addresses. */
function cleanText(value: string | null | undefined) {
  return (value ?? "").replace(/^[\s"']+|[\s"']+$/g, "").replace(/\s+/g, " ").trim();
}

function groupKeyFor(groupId: string, groupName: string): GroupKey {
  const suffix = groupId.split("-").pop() ?? "";
  if (suffix === "topics" || suffix === "europe" || suffix === "closed" || suffix === "other") {
    return suffix;
  }
  return GROUP_BY_NAME[groupName.trim().toLowerCase()] ?? "topics";
}

function parseSnapshot(raw: string | null | undefined): Snapshot {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" ? (value as Snapshot) : {};
  } catch {
    return {};
  }
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "store";
}

function codeFor(name: string, taken: Set<string>) {
  const initials = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase())
    .join("")
    .slice(0, 5) || "ST";
  let code = initials;
  let suffix = 2;
  while (taken.has(code)) {
    code = `${initials}${suffix}`;
    suffix += 1;
  }
  taken.add(code);
  return code;
}

/** Every live Store Documentation row, read off the mirrored board. */
export async function readStoreDocumentation(
  db: Database,
  organisationId: string,
): Promise<StoreDocumentationStore[]> {
  const rows = await db
    .select({
      requestId: maintenanceRequests.id,
      mondayId: maintenanceRequests.externalId,
      title: maintenanceRequests.title,
      siteId: maintenanceRequests.siteId,
      groupId: maintenanceGroupItems.groupId,
      groupName: maintenanceGroups.name,
      position: maintenanceGroupItems.position,
    })
    .from(maintenanceRequests)
    .innerJoin(maintenanceGroupItems, eq(maintenanceGroupItems.requestId, maintenanceRequests.id))
    .innerJoin(maintenanceGroups, eq(maintenanceGroups.id, maintenanceGroupItems.groupId))
    .where(
      and(
        eq(maintenanceRequests.organisationId, organisationId),
        eq(maintenanceGroupItems.boardId, BOARD),
        isNull(maintenanceRequests.deletedAt),
        isNull(maintenanceRequests.parentId),
        eq(maintenanceRequests.archived, false),
        isNull(maintenanceGroups.deletedAt),
      ),
    )
    .orderBy(asc(maintenanceGroups.position), asc(maintenanceGroupItems.position));
  if (!rows.length) return [];

  const columns = await db
    .select({ id: maintenanceBoardColumns.id, key: maintenanceBoardColumns.key })
    .from(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.organisationId, organisationId),
        eq(maintenanceBoardColumns.boardId, BOARD),
        inArray(maintenanceBoardColumns.key, ["storeType", "storeAddress"]),
      ),
    );
  const keyByColumn = new Map(columns.map((column) => [column.id, column.key]));
  const cells = columns.length
    ? await db
        .select({
          requestId: maintenanceBoardCells.requestId,
          columnId: maintenanceBoardCells.columnId,
          value: maintenanceBoardCells.value,
        })
        .from(maintenanceBoardCells)
        .where(
          and(
            eq(maintenanceBoardCells.organisationId, organisationId),
            inArray(
              maintenanceBoardCells.columnId,
              columns.map((column) => column.id),
            ),
          ),
        )
    : [];
  const values = new Map<string, { storeType?: string; storeAddress?: string }>();
  for (const cell of cells) {
    const key = keyByColumn.get(cell.columnId);
    if (key !== "storeType" && key !== "storeAddress") continue;
    const entry = values.get(cell.requestId) ?? {};
    entry[key] = cell.value;
    values.set(cell.requestId, entry);
  }

  return rows.map((row) => {
    const cell = values.get(row.requestId) ?? {};
    return {
      requestId: row.requestId,
      mondayId: row.mondayId ? String(row.mondayId) : null,
      name: cleanText(row.title),
      type: cleanText(cell.storeType) || "",
      address: cleanText(cell.storeAddress),
      group: groupKeyFor(row.groupId, row.groupName),
      siteId: row.siteId && row.siteId !== "site-unassigned" ? row.siteId : null,
    };
  });
}

/**
 * Bring the organisation's sites, site groups and site units into line with its
 * Store Documentation board. Idempotent: a second run with nothing changed on
 * monday writes nothing.
 */
export async function reconcileStoreRegister(
  db: Database,
  organisationId: string,
): Promise<StoreRegisterResult> {
  const result: StoreRegisterResult = {
    stores: 0,
    skipped: [],
    linked: 0,
    created: 0,
    updated: 0,
    regrouped: 0,
    notOnMonday: [],
    units: { created: 0, updated: 0 },
  };
  const stores = await readStoreDocumentation(db, organisationId);
  if (!stores.length) return result;

  const siteRows = await db
    .select()
    .from(sites)
    .where(and(eq(sites.organisationId, organisationId), isNull(sites.boardId)));
  const byId = new Map(siteRows.map((row) => [row.id, row]));
  const byName = new Map<string, string>();
  for (const row of siteRows) {
    for (const name of [row.mondayComplianceName, row.name]) {
      const key = name ? normaliseSiteName(name) : "";
      if (key && !byName.has(key)) byName.set(key, row.id);
    }
  }
  const takenCodes = new Set(siteRows.map((row) => row.code).filter((code): code is string => Boolean(code)));
  let nextPosition = siteRows.reduce((top, row) => Math.max(top, row.position ?? 0), -1) + 1;

  const groupRows = await db
    .select({ id: siteGroups.id, slug: siteGroups.slug })
    .from(siteGroups)
    .where(and(eq(siteGroups.organisationId, organisationId), isNull(siteGroups.boardId)));
  const groupIdBySlug = new Map(groupRows.map((row) => [row.slug, row.id]));
  const seededGroupIds = new Set(
    Object.values(SITE_GROUP_SLUG)
      .map((slug) => groupIdBySlug.get(slug))
      .filter((id): id is string => Boolean(id)),
  );

  const now = new Date().toISOString();
  const seen = new Set<string>();
  for (const store of stores) {
    if (!store.name || isPlaceholderStore(store)) {
      result.skipped.push(store.name || store.requestId);
      continue;
    }
    result.stores += 1;

    /* 1. Find the site: the row's own link, then the name monday uses. */
    let siteId =
      (store.siteId && byId.has(store.siteId) ? store.siteId : null) ??
      byName.get(normaliseSiteName(store.name)) ??
      null;
    const state = STATUS_FOR_GROUP[store.group];
    const type = store.type || "Kiosk";

    if (!siteId) {
      /* 2. A store monday has and the portal does not: create it. */
      siteId = `site-${slugify(store.name)}-${Math.random().toString(36).slice(2, 8)}`;
      await db.insert(sites).values({
        id: siteId,
        organisationId,
        name: store.name,
        type,
        siteTypeValue: type,
        region: store.group === "europe" ? "Europe" : "UK",
        lifecycle: state.lifecycle,
        status: state.status,
        active: state.active,
        address: store.address,
        addressLine1: store.address || null,
        slug: `${slugify(store.name)}-${siteId.slice(-6)}`,
        code: codeFor(store.name, takenCodes),
        position: nextPosition,
        mondayComplianceName: store.name,
        mondaySnapshot: JSON.stringify({
          name: store.name,
          type: store.type,
          address: store.address,
          group: store.group,
        }),
      });
      nextPosition += 1;
      result.created += 1;
      const groupId = groupIdBySlug.get(SITE_GROUP_SLUG[store.group]);
      if (groupId) {
        await db
          .insert(siteGroupMembers)
          .values({
            id: `sgm-${SITE_GROUP_SLUG[store.group]}-${siteId}`,
            organisationId,
            siteGroupId: groupId,
            siteId,
          })
          .onConflictDoNothing();
      }
    } else {
      /* 3. An existing site: apply only what changed on monday. */
      const site = byId.get(siteId)!;
      const before = parseSnapshot(site.mondaySnapshot);
      const firstLink = !site.mondaySnapshot;
      const patch: Partial<typeof sites.$inferInsert> = {};
      if (site.mondayComplianceName !== store.name) patch.mondayComplianceName = store.name;
      if (before.type !== store.type && store.type) {
        if ((site.siteTypeValue ?? site.type) !== store.type) {
          patch.siteTypeValue = store.type;
          patch.type = store.type;
        }
      }
      if (before.address !== store.address && store.address) {
        if ((site.addressLine1 ?? site.address) !== store.address) {
          patch.address = store.address;
          patch.addressLine1 = store.address;
        }
      }
      /*
       * The status follows the monday group when the group changed on monday.
       * On the FIRST link it follows too, but only towards closed or open —
       * the register already decided international/other with care, and the
       * three legacy `other` rows are not monday's to reopen.
       */
      const groupChanged = before.group !== store.group;
      if (groupChanged) {
        const statusDiffers =
          site.status !== state.status &&
          !(firstLink && site.status === "other" && store.group !== "closed");
        if (statusDiffers) {
          patch.status = state.status;
          patch.active = state.active;
          patch.lifecycle = state.lifecycle;
        }
      }
      const snapshot = JSON.stringify({
        name: store.name,
        type: store.type,
        address: store.address,
        group: store.group,
      });
      if (Object.keys(patch).length || site.mondaySnapshot !== snapshot) {
        await db
          .update(sites)
          .set({
            ...patch,
            mondaySnapshot: snapshot,
            ...(Object.keys(patch).length ? { updatedAt: now } : {}),
          })
          .where(and(eq(sites.id, siteId), eq(sites.organisationId, organisationId)));
        if (Object.keys(patch).length) result.updated += 1;
        if (firstLink) result.linked += 1;
      }

      /* The group, when monday moved the store between its groups. */
      if (groupChanged && !firstLink) {
        const target = groupIdBySlug.get(SITE_GROUP_SLUG[store.group]);
        if (target) {
          await db
            .delete(siteGroupMembers)
            .where(
              and(
                eq(siteGroupMembers.organisationId, organisationId),
                eq(siteGroupMembers.siteId, siteId),
                inArray(siteGroupMembers.siteGroupId, [...seededGroupIds]),
              ),
            );
          await db
            .insert(siteGroupMembers)
            .values({
              id: `sgm-${SITE_GROUP_SLUG[store.group]}-${siteId}`,
              organisationId,
              siteGroupId: target,
              siteId,
            })
            .onConflictDoNothing();
          result.regrouped += 1;
        }
      }
    }

    /* 4. The Store Documentation row points at its site. */
    if (store.siteId !== siteId) {
      await db
        .update(maintenanceRequests)
        .set({ siteId })
        .where(
          and(
            eq(maintenanceRequests.id, store.requestId),
            eq(maintenanceRequests.organisationId, organisationId),
          ),
        );
    }
    seen.add(siteId);
  }

  result.notOnMonday = siteRows.filter((row) => !seen.has(row.id)).map((row) => row.name);
  result.units = await reconcileSiteUnits(db, organisationId);
  return result;
}
