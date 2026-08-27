import { and, count, eq, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import {
  activityLog,
  maintenanceBoardOptions,
  maintenanceRequests,
  optionSets,
  optionValues,
  sites,
  units,
} from "../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../lib/tenant-db";
import { invalidateOptionCache, listOptionSets, listOptionValues } from "../../lib/options-repository";
import { csvResponse, parseCsvObjects, toCsv } from "../../lib/csv";

type ScopedDb = Awaited<ReturnType<typeof scopedDb>>["db"];

function text(value: unknown, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function boolish(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "1", "yes", "y"].includes(value.toLowerCase());
  return fallback;
}

/** Hex colours are validated so a bad paste cannot break every board cell. */
function colour(value: unknown, fallback: string) {
  const raw = text(value, 9);
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : fallback;
}

/**
 * M10 — referential guard. Counts live rows using an option value so the admin
 * sees the impact before deleting, and can reassign instead. Each option set
 * maps to the column that actually stores its value; a set with no mapping
 * reports zero and is safe to delete freely.
 */
async function usageCount(db: ScopedDb, orgId: string, key: string, value: string) {
  const tally = async (
    table: typeof maintenanceRequests | typeof sites | typeof units,
    column: ReturnType<typeof sql>,
  ) => {
    /*
     * Stage 23 — "live rows" now excludes anything in the recycle bin.
     *
     * This count is what tells an admin how much damage deleting an option
     * value would do. Counting binned jobs would block the deletion on rows
     * nobody can see, and the admin would have no way to find out why. Only
     * `maintenance_requests` carries the flag today, hence the narrowing;
     * `sites` and `units` retire rather than soft-delete.
     */
    const live =
      table === maintenanceRequests
        ? [isNull(maintenanceRequests.deletedAt)]
        : [];
    const [row] = await db
      .select({ total: count() })
      .from(table)
      .where(and(eq(table.organisationId, orgId), sql`${column} = ${value}`, ...live));
    return row?.total ?? 0;
  };

  switch (key) {
    case "maintenance_status":
      return tally(maintenanceRequests, sql`${maintenanceRequests.status}`);
    case "priority":
      return tally(maintenanceRequests, sql`${maintenanceRequests.priority}`);
    case "engineer_required":
      return tally(maintenanceRequests, sql`${maintenanceRequests.engineer}`);
    case "maintenance_label":
      return tally(maintenanceRequests, sql`${maintenanceRequests.category}`);
    case "site_type":
      return tally(sites, sql`${sites.siteTypeValue}`);
    case "site_status":
      return tally(sites, sql`${sites.status}`);
    case "unit_category":
      return tally(units, sql`${units.category}`);
    case "unit_status":
      return tally(units, sql`${units.status}`);
    default:
      return 0;
  }
}

/**
 * Reassignment rewrites the stored value on every affected row. Renaming a
 * label in place is preferred — it keeps history intact — but where a value is
 * genuinely being retired the rows must move somewhere valid rather than be
 * left pointing at a value that no longer exists.
 */
async function reassign(
  db: ScopedDb,
  orgId: string,
  key: string,
  from: string,
  to: string,
) {
  const stamp = new Date().toISOString();
  switch (key) {
    case "maintenance_status":
      await db.update(maintenanceRequests).set({ status: to, updatedAt: stamp })
        .where(and(eq(maintenanceRequests.organisationId, orgId), eq(maintenanceRequests.status, from)));
      return;
    case "priority":
      await db.update(maintenanceRequests).set({ priority: to, updatedAt: stamp })
        .where(and(eq(maintenanceRequests.organisationId, orgId), eq(maintenanceRequests.priority, from)));
      return;
    case "engineer_required":
      await db.update(maintenanceRequests).set({ engineer: to, updatedAt: stamp })
        .where(and(eq(maintenanceRequests.organisationId, orgId), eq(maintenanceRequests.engineer, from)));
      return;
    case "maintenance_label":
      await db.update(maintenanceRequests).set({ category: to, updatedAt: stamp })
        .where(and(eq(maintenanceRequests.organisationId, orgId), eq(maintenanceRequests.category, from)));
      return;
    case "site_type":
      await db.update(sites).set({ siteTypeValue: to, type: to, updatedAt: stamp })
        .where(and(eq(sites.organisationId, orgId), eq(sites.siteTypeValue, from)));
      return;
    case "site_status":
      await db.update(sites).set({ status: to, updatedAt: stamp })
        .where(and(eq(sites.organisationId, orgId), eq(sites.status, from)));
      return;
    case "unit_category":
      await db.update(units).set({ category: to, updatedAt: stamp })
        .where(and(eq(units.organisationId, orgId), eq(units.category, from)));
      return;
    case "unit_status":
      await db.update(units).set({ status: to, updatedAt: stamp })
        .where(and(eq(units.organisationId, orgId), eq(units.status, from)));
      return;
    default:
      return;
  }
}

/**
 * Which board column renders each option set. The same mapping the seed uses
 * (db/seed-options.ts), restated here because that file is provisioning-only
 * by rule — nothing in the app may import it.
 */
const SET_TO_BOARD_COLUMN: Record<string, string> = {
  maintenance_status: "status",
  maintenance_label: "label",
  engineer_required: "engineer",
  priority: "priority",
  tier_level: "tier",
  /*
   * `store_location` is deliberately absent. Mirroring it kept a twenty-one row
   * option set in step with the board as though it were the estate; the estate
   * is `sites`, and a store is created there or not at all.
   */
};

/**
 * Keeps the board's chip store in step with the registry.
 *
 * The board draws its chips from `maintenance_board_options`; this route — the
 * options admin and the form builder behind it — writes `option_values`. Two
 * stores, and until this mirror they drifted on the first rename: an admin
 * would rename "Urgent" here, the form and every selector would follow, and
 * the board's chips would keep the old word indefinitely. The registry is the
 * canonical copy by decision, so every write through this route lands on both,
 * in the same request, matched by the stable `value` the two stores share.
 */
async function mirrorBoardOption(
  db: ScopedDb,
  orgId: string,
  key: string,
  value: string,
  action:
    | { kind: "upsert"; label: string; colourHex: string; textColour: string; active: boolean; position?: number }
    | { kind: "remove" },
) {
  const columnKey = SET_TO_BOARD_COLUMN[key];
  if (!columnKey) return;
  const where = and(
    eq(maintenanceBoardOptions.organisationId, orgId),
    eq(maintenanceBoardOptions.columnKey, columnKey),
    eq(maintenanceBoardOptions.value, value),
  );
  const [existing] = await db.select().from(maintenanceBoardOptions).where(where).limit(1);

  if (action.kind === "remove") {
    if (!existing) return;
    /* Retire rather than delete when the seed would only recreate it. */
    if (existing.system) {
      await db
        .update(maintenanceBoardOptions)
        .set({ active: false, updatedAt: new Date().toISOString() })
        .where(eq(maintenanceBoardOptions.id, existing.id));
    } else {
      await db.delete(maintenanceBoardOptions).where(eq(maintenanceBoardOptions.id, existing.id));
    }
    return;
  }

  if (existing) {
    await db
      .update(maintenanceBoardOptions)
      .set({
        label: action.label,
        color: action.colourHex,
        textColor: action.textColour,
        active: action.active,
        ...(action.position !== undefined ? { position: action.position } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(maintenanceBoardOptions.id, existing.id));
  } else {
    await db.insert(maintenanceBoardOptions).values({
      id: `board-${key}-${Date.now().toString(36)}`,
      organisationId: orgId,
      boardId: "maintenance",
      columnKey,
      value,
      label: action.label,
      color: action.colourHex,
      textColor: action.textColour,
      active: action.active,
      system: false,
      position: action.position ?? 999,
    });
  }
}

async function setIdForKey(db: ScopedDb, orgId: string, key: string) {
  const [row] = await db
    .select({ id: optionSets.id })
    .from(optionSets)
    .where(and(eq(optionSets.organisationId, orgId), eq(optionSets.key, key)))
    .limit(1);
  if (!row) throw new Error(`No option set named "${key}" exists in this workspace.`);
  return row.id;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    const url = new URL(request.url);
    const key = url.searchParams.get("key");

    if (url.searchParams.get("format") === "csv" && key) {
      const values = await listOptionValues(db, orgId, key);
      const body = toCsv(
        ["value", "label", "colour_hex", "text_colour", "position", "is_done", "is_default", "active"],
        values.map((entry) => ({
          value: entry.value,
          label: entry.label,
          colour_hex: entry.colourHex,
          text_colour: entry.textColour,
          position: entry.position,
          is_done: entry.isDone ? "true" : "false",
          is_default: entry.isDefault ? "true" : "false",
          active: entry.active ? "true" : "false",
        })),
      );
      return csvResponse(`maintsupp-${key}.csv`, body);
    }

    if (key) {
      const values = await listOptionValues(db, orgId, key);
      const withUsage = await Promise.all(
        values.map(async (entry) => ({
          ...entry,
          usage: await usageCount(db, orgId, key, entry.value),
        })),
      );
      return Response.json({ key, values: withUsage });
    }

    return Response.json({ sets: await listOptionSets(db, orgId) });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const message = error instanceof Error ? error.message : "Options could not be loaded.";
    return Response.json({ error: message }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId } = guard.scope;
    const body = (await request.json()) as {
      key?: string;
      data?: Record<string, unknown>;
      csv?: string;
    };
    const key = text(body.key, 60);
    if (!key) throw new Error("An option set key is required.");
    const optionSetId = await setIdForKey(db, orgId, key);

    // M11 — bulk import. Existing values are updated in place, so a round-trip
    // through Excel never orphans the rows already pointing at them.
    if (typeof body.csv === "string") {
      const records = parseCsvObjects(body.csv);
      if (!records.length) throw new Error("The CSV contained no data rows.");
      let created = 0;
      let updated = 0;
      for (const [index, record] of records.entries()) {
        const value = (record.value ?? "").trim();
        if (!value) continue;
        const values = {
          label: (record.label ?? value).trim(),
          colourHex: colour(record.colour_hex, "#5c82af"),
          textColour: colour(record.text_colour, "#ffffff"),
          position: Number.isFinite(Number(record.position)) ? Number(record.position) : index,
          isDone: boolish(record.is_done),
          isDefault: boolish(record.is_default),
          active: boolish(record.active, true),
          updatedAt: new Date().toISOString(),
        };
        const [existing] = await db
          .select({ id: optionValues.id })
          .from(optionValues)
          .where(
            and(
              eq(optionValues.organisationId, orgId),
              eq(optionValues.optionSetId, optionSetId),
              eq(optionValues.value, value),
            ),
          )
          .limit(1);
        if (existing) {
          await db.update(optionValues).set(values).where(eq(optionValues.id, existing.id));
          updated += 1;
        } else {
          await db.insert(optionValues).values({
            id: `opt-${key}-${Date.now().toString(36)}-${index}`,
            organisationId: orgId,
            optionSetId,
            value,
            ...values,
          });
          created += 1;
        }
        await mirrorBoardOption(db, orgId, key, value, {
          kind: "upsert",
          label: values.label,
          colourHex: values.colourHex,
          textColour: values.textColour,
          active: values.active,
          position: values.position,
        });
      }
      invalidateOptionCache(orgId, key);
      return Response.json({ ok: true, created, updated });
    }

    const data = body.data ?? {};
    const value = text(data.value, 120);
    if (!value) throw new Error("An option value is required.");
    const id = `opt-${key}-${Date.now().toString(36)}`;
    await db.insert(optionValues).values({
      id,
      organisationId: orgId,
      optionSetId,
      value,
      label: text(data.label, 120) || value,
      colourHex: colour(data.colourHex, "#5c82af"),
      textColour: colour(data.textColour, "#ffffff"),
      position: Number(data.position) || 0,
      isDone: boolish(data.isDone),
      isDefault: boolish(data.isDefault),
      active: boolish(data.active, true),
      system: false,
    });
    await mirrorBoardOption(db, orgId, key, value, {
      kind: "upsert",
      label: text(data.label, 120) || value,
      colourHex: colour(data.colourHex, "#5c82af"),
      textColour: colour(data.textColour, "#ffffff"),
      active: boolish(data.active, true),
      position: Number(data.position) || undefined,
    });
    invalidateOptionCache(orgId, key);
    await db.insert(activityLog).values({
      id: `activity-option-${id}`,
      organisationId: orgId,
      entityType: "option_value",
      entityId: id,
      action: "created",
      actorEmail: actor.email,
      detail: JSON.stringify({ key, value }),
    });
    return Response.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The option could not be saved.";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const body = (await request.json()) as {
      key?: string;
      id?: string;
      data?: Record<string, unknown>;
      order?: string[];
    };
    const key = text(body.key, 60);
    if (!key) throw new Error("An option set key is required.");

    // Drag-reorder posts the full ordered list of IDs.
    if (Array.isArray(body.order)) {
      for (const [position, id] of body.order.entries()) {
        await db
          .update(optionValues)
          .set({ position, updatedAt: new Date().toISOString() })
          .where(and(eq(optionValues.id, id), eq(optionValues.organisationId, orgId)));
        /* The chip dropdown orders by the board copy's position — keep it in step. */
        const [row] = await db
          .select({ value: optionValues.value, label: optionValues.label, colourHex: optionValues.colourHex, textColour: optionValues.textColour, active: optionValues.active })
          .from(optionValues)
          .where(and(eq(optionValues.id, id), eq(optionValues.organisationId, orgId)))
          .limit(1);
        if (row) {
          await mirrorBoardOption(db, orgId, key, row.value, {
            kind: "upsert",
            label: row.label,
            colourHex: row.colourHex,
            textColour: row.textColour,
            active: row.active,
            position,
          });
        }
      }
      invalidateOptionCache(orgId, key);
      return Response.json({ ok: true });
    }

    const id = text(body.id, 120);
    if (!id) throw new Error("An option ID is required.");
    const data = body.data ?? {};
    const [existing] = await db
      .select()
      .from(optionValues)
      .where(and(eq(optionValues.id, id), eq(optionValues.organisationId, orgId)))
      .limit(1);
    if (!existing) return Response.json({ error: "Option not found." }, { status: 404 });

    // Renaming the label leaves `value` untouched, so "Plummer" can become
    // "Plumber" on screen without rewriting 744 stored job rows.
    await db
      .update(optionValues)
      .set({
        label: text(data.label, 120) || existing.label,
        colourHex: colour(data.colourHex, existing.colourHex),
        textColour: colour(data.textColour, existing.textColour),
        isDone: boolish(data.isDone, existing.isDone),
        isDefault: boolish(data.isDefault, existing.isDefault),
        active: boolish(data.active, existing.active),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(optionValues.id, id), eq(optionValues.organisationId, orgId)));

    await mirrorBoardOption(db, orgId, key, existing.value, {
      kind: "upsert",
      label: text(data.label, 120) || existing.label,
      colourHex: colour(data.colourHex, existing.colourHex),
      textColour: colour(data.textColour, existing.textColour),
      active: boolish(data.active, existing.active),
    });
    invalidateOptionCache(orgId, key);
    return Response.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The option could not be updated.";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const body = (await request.json()) as {
      key?: string;
      id?: string;
      reassignTo?: string;
      confirm?: boolean;
    };
    const key = text(body.key, 60);
    const id = text(body.id, 120);
    if (!key || !id) throw new Error("An option set key and option ID are required.");

    const [existing] = await db
      .select()
      .from(optionValues)
      .where(and(eq(optionValues.id, id), eq(optionValues.organisationId, orgId)))
      .limit(1);
    if (!existing) return Response.json({ error: "Option not found." }, { status: 404 });

    const usage = await usageCount(db, orgId, key, existing.value);
    const reassignTo = text(body.reassignTo, 120);

    if (usage > 0 && !reassignTo) {
      return Response.json(
        {
          error: `${usage} record${usage === 1 ? "" : "s"} still use "${existing.label}".`,
          requiresReassignment: true,
          usage,
        },
        { status: 409 },
      );
    }

    if (usage > 0 && reassignTo) {
      const values = await listOptionValues(db, orgId, key);
      if (!values.some((entry) => entry.value === reassignTo && entry.active)) {
        throw new Error("The replacement option is not an active value in this set.");
      }
      await reassign(db, orgId, key, existing.value, reassignTo);
    }

    // System-seeded values are deactivated rather than removed. The Stage 1
    // seed recreates them on the next boot, so deleting would be undone anyway.
    if (existing.system) {
      await db
        .update(optionValues)
        .set({ active: false, updatedAt: new Date().toISOString() })
        .where(eq(optionValues.id, id));
    } else {
      await db.delete(optionValues).where(eq(optionValues.id, id));
    }

    await mirrorBoardOption(db, orgId, key, existing.value, { kind: "remove" });
    invalidateOptionCache(orgId, key);
    return Response.json({ ok: true, id, reassigned: usage, deactivated: existing.system });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The option could not be removed.";
    return Response.json({ error: message }, { status: 400 });
  }
}
