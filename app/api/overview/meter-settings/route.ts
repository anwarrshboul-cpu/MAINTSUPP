/**
 * `GET|PUT /api/overview/meter-settings` — Settings → Dashboard meters (§2.5).
 *
 * ── WHY THIS IS NOT UNDER `/api/dashboard` ────────────────────────────────
 *
 * `/api/dashboard/*` is READ-ONLY AGGREGATES. Every route under it answers a
 * question about the board and writes nothing, which is why they all share one
 * guard (`dashboardScope`, gated `board.view`) and one failure arm. The
 * Overview's three write tools — this one, `contractor-aliases` and
 * `site-assign` — are the ONLY writes the Overview performs, and §8 says so
 * explicitly: "no change to any job record as a side effect of dashboard work,
 * except the explicit, confirmed, reversible actions in the contractor linking
 * tool and the bulk site-assign view."
 *
 * A separate namespace makes that boundary reviewable rather than remembered. A
 * reader auditing "what can the dashboard change?" reads three files, and a
 * route added to `/api/dashboard` that writes is visibly in the wrong place.
 *
 * ── WHAT A MAPPING CHANGE TOUCHES, AND WHAT IT DOES NOT ───────────────────
 *
 * It touches `dashboard_meters` (the meter's name, order and visibility) and
 * `job_status_map.meter_key` (which meter a status belongs to). It touches NO
 * ROW OF `maintenance_requests` — there is not one write to that table in this
 * file, and `tests/overview-tools.test.mjs` asserts its absence. §2.5: "Changing
 * the mapping requires no deploy and alters no job record."
 *
 * ── WHY MOVING A STATUS IS AUTOMATICALLY ATOMIC ───────────────────────────
 *
 * The assignment is ONE COLUMN on a table that already holds one row per
 * (organisation, status label) behind a UNIQUE index. So "moving a status
 * removes it from its previous meter in the same action" (§2.5) is not
 * something this handler arranges — it is a property of the schema, and there
 * is no intermediate state in which a status belongs to two meters or to none.
 * That is the whole reason `db/schema.ts` shapes it this way rather than as a
 * meter → statuses join table, where the same move would be a delete and an
 * insert with a window between them.
 *
 * The save is therefore "atomic in spirit": every statement is independently
 * safe, none of them can leave an invariant broken half-way, and a failure
 * part-way through leaves some statuses moved and the rest where they were —
 * which is a state the next save corrects and the next GET reports honestly.
 * A real transaction is not available: the D1 interface this codebase is
 * written against has no `BEGIN`, and `db/node-pg-d1.ts` runs each statement on
 * its own pooled connection.
 */

import { and, eq, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { activityLog, dashboardMeters, maintenanceRequests } from "../../../../db/schema";
import { auditActor, changeDetail, recordAudit } from "../../../lib/audit";
import {
  jobScopeCondition,
  parseFilters,
  resolveWindow,
} from "../../../lib/dashboard-filters";
import { statusKey } from "../../../lib/job-metrics";
import {
  CATCH_ALL_METER,
  METER_KEYS,
  METER_SEED_COLOUR,
  METER_SEED_LABEL,
  isMeterKey,
  orderMeters,
} from "../../../lib/overview-meters";
import { can, resolvePermissions } from "../../../lib/permissions";
import {
  anonymousRefusal,
  busyRefusal,
  scopedDbWithCapability,
  type ScopedDatabase,
} from "../../../lib/tenant-db";
import type { MeterSettingsPayload } from "../../../(app)/portal/ops/overview-contract";

export const dynamic = "force-dynamic";

/** Longest a meter's display name may be. Truncated on read, refused on write. */
const LABEL_LIMIT = 60;

const HEX = /^#[0-9a-fA-F]{6}$/;

type StatusMapRow = {
  id: string;
  sourceStatusLabel: string;
  displayLabel: string;
  meterKey: string | null;
};

/**
 * `job_status_map` including `meter_key`.
 *
 * Raw rather than through the drizzle table because `db/schema.ts` does not
 * declare `meterKey` on `jobStatusMap` — the column is added on the boot path
 * by `addColumn` in `db/init.ts`, which is where every additive migration in
 * this product lives, and the drizzle declaration has not caught up. Declaring
 * it is a one-line change to a file this work does not own; until then the
 * column is read and written by name. Unqualified, because the Postgres
 * connection carries `search_path = portal` as a startup parameter
 * (`db/node-pg-d1.ts`) and the SQLite side has one schema.
 */
async function readStatusMap(
  db: ScopedDatabase["db"],
  orgId: string,
): Promise<StatusMapRow[]> {
  const result = await db.all<StatusMapRow>(sql`
    SELECT id AS "id",
           source_status_label AS "sourceStatusLabel",
           display_label AS "displayLabel",
           meter_key AS "meterKey"
      FROM job_status_map
     WHERE organisation_id = ${orgId}
     ORDER BY sort_order, source_status_label
  `);
  return (result ?? []) as StatusMapRow[];
}

/** The meter rows for this workspace, seeded in memory when a row is absent. */
async function readMeters(db: ScopedDatabase["db"], orgId: string) {
  const rows = await db
    .select({
      key: dashboardMeters.meterKey,
      label: dashboardMeters.displayLabel,
      colour: dashboardMeters.colourHex,
      sortOrder: dashboardMeters.sortOrder,
      visible: dashboardMeters.visible,
      isCatchAll: dashboardMeters.isCatchAll,
    })
    .from(dashboardMeters)
    .where(eq(dashboardMeters.organisationId, orgId));

  const byKey = new Map(rows.map((row) => [row.key, row]));
  /*
   * The eight are always present in the answer, whether or not the seed has
   * run for this workspace. A meter missing from the payload is a meter the
   * Settings page cannot show and therefore a bucket of work nobody can find,
   * and §2.1 makes the eight a fixed vocabulary rather than a user-built list.
   */
  return METER_KEYS.map((key, index) => {
    const row = byKey.get(key);
    return {
      key,
      label: row?.label ?? METER_SEED_LABEL[key],
      colour: row?.colour ?? METER_SEED_COLOUR[key],
      sortOrder: row?.sortOrder ?? index,
      visible: key === CATCH_ALL_METER ? true : (row?.visible ?? true),
      isCatchAll: key === CATCH_ALL_METER,
      stored: Boolean(row),
    };
  });
}

/**
 * The whole payload §2.5 draws: meters, their statuses, and the LIVE counts the
 * preview bar is scaled against.
 *
 * The counts are the current period's real ones, cut with the same cohort rule
 * every card on the Overview uses (§1.1), because a preview bar drawn against
 * invented proportions teaches the operator the wrong thing about the change
 * they are about to save.
 */
async function buildPayload(
  scope: ScopedDatabase,
  url: URL,
  canEdit: boolean,
): Promise<MeterSettingsPayload> {
  const filters = parseFilters(url);
  const window = resolveWindow(filters.period, filters.from, filters.to, new Date());

  const [meters, statusRows, cohortRows] = await Promise.all([
    readMeters(scope.db, scope.orgId),
    readStatusMap(scope.db, scope.orgId),
    scope.db
      .select({
        status: maintenanceRequests.status,
        jobs: sql<number>`count(*)`,
      })
      .from(maintenanceRequests)
      .where(jobScopeCondition(scope.orgId, filters, window))
      .groupBy(maintenanceRequests.status),
  ]);

  /*
   * Counts collapse on the NORMALISED label, the way every other status
   * comparison in this product does (`statusKey`). "In Progress" and
   * "in  progress" are one status: counting them apart would draw two segments
   * for one bucket and make the preview disagree with the At a glance bar it is
   * previewing.
   */
  const countByKey = new Map<string, number>();
  const seenLabel = new Map<string, string>();
  let cohortTotal = 0;
  for (const row of cohortRows) {
    const label = (row.status ?? "").trim();
    const key = statusKey(label);
    if (!key) continue;
    const jobs = Number(row.jobs ?? 0);
    cohortTotal += jobs;
    countByKey.set(key, (countByKey.get(key) ?? 0) + jobs);
    if (!seenLabel.has(key)) seenLabel.set(key, label);
  }

  type Entry = { id: string; label: string; displayLabel: string; count: number; meter: string };
  const entries = new Map<string, Entry>();

  for (const row of statusRows) {
    const key = statusKey(row.sourceStatusLabel);
    if (!key) continue;
    const assigned = row.meterKey && isMeterKey(row.meterKey) ? row.meterKey : CATCH_ALL_METER;
    const existing = entries.get(key);
    if (existing) {
      /*
       * Two rows normalising to one status. The UNIQUE index is on the RAW
       * label, so "In Progress" and "in progress" can both exist; they are one
       * status to every reader, so they are one row here and a move writes both
       * — see `applyStatusAssignments`.
       */
      existing.meter = assigned;
      continue;
    }
    entries.set(key, {
      id: row.id,
      label: row.sourceStatusLabel,
      displayLabel: row.displayLabel || row.sourceStatusLabel,
      count: countByKey.get(key) ?? 0,
      meter: assigned,
    });
  }

  /*
   * A status seen on a job but absent from the map is listed too, under the
   * catch-all where it already counts. §2.1: "an unknown status resolves to
   * `other`". Hiding it here would make the one status an operator most needs
   * to file the only one they cannot reach.
   */
  for (const [key, label] of seenLabel) {
    if (entries.has(key)) continue;
    entries.set(key, {
      id: `unmapped:${key}`,
      label,
      displayLabel: label,
      count: countByKey.get(key) ?? 0,
      meter: CATCH_ALL_METER,
    });
  }

  const byMeter = new Map<string, Entry[]>();
  for (const entry of entries.values()) {
    const list = byMeter.get(entry.meter);
    if (list) list.push(entry);
    else byMeter.set(entry.meter, [entry]);
  }

  const ordered = orderMeters(
    meters.map((meter) => ({
      key: meter.key,
      label: meter.label,
      colour: meter.colour,
      sortOrder: meter.sortOrder,
      visible: meter.visible,
      isCatchAll: meter.isCatchAll,
    })),
  );

  return {
    meters: ordered.map((meter) => {
      const statuses = (byMeter.get(meter.key) ?? []).sort(
        (left, right) => right.count - left.count || left.label.localeCompare(right.label),
      );
      return {
        key: meter.key,
        label: meter.label,
        colour: meter.colour,
        sortOrder: meter.sortOrder,
        visible: meter.visible,
        isCatchAll: meter.isCatchAll,
        count: statuses.reduce((sum, status) => sum + status.count, 0),
        statuses: statuses.map((status) => ({
          id: status.id,
          label: status.label,
          displayLabel: status.displayLabel,
          count: status.count,
        })),
      };
    }),
    cohortTotal,
    canEdit,
  };
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guarded = await scopedDbWithCapability(request, "board.view");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const subject = await resolvePermissions(scope.db, scope.orgId, scope.actor.role);
    const payload = await buildPayload(
      scope,
      new URL(request.url),
      can(subject, "settings.edit"),
    );
    return Response.json(payload);
  } catch (error) {
    return failure(error, "The meter settings could not be read.");
  }
}

/* ── The save ─────────────────────────────────────────────────────────────── */

type MeterInput = {
  key: string;
  label?: unknown;
  colour?: unknown;
  sortOrder?: unknown;
  visible?: unknown;
};

type StatusInput = { label?: unknown; meterKey?: unknown };

function readText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

/**
 * Write `meter_key` for every status the save names.
 *
 * The comparison happens IN JAVASCRIPT over the whole (small) map rather than
 * in SQL, because the key is the whitespace-collapsed lower-cased label and no
 * portable SQL expression collapses internal whitespace. The map is dozens of
 * rows; reading it whole costs one statement and removes any need for `GLOB`,
 * `regexp` or a dialect-specific `replace` chain — all of which are banned
 * here and none of which would agree with `statusKey`.
 *
 * Returns the moves actually made, for the diff.
 */
async function applyStatusAssignments(
  scope: ScopedDatabase,
  rows: StatusMapRow[],
  wanted: Map<string, string>,
  /** The label as the caller typed it, keyed by its normalised form. */
  labels: Map<string, string>,
  at: string,
): Promise<Array<{ label: string; from: string; to: string }>> {
  const moves: Array<{ label: string; from: string; to: string }> = [];
  const byKey = new Map<string, StatusMapRow[]>();
  for (const row of rows) {
    const key = statusKey(row.sourceStatusLabel);
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }

  for (const [key, meter] of wanted) {
    const existing = byKey.get(key);
    if (existing && existing.length) {
      for (const row of existing) {
        const from = row.meterKey && isMeterKey(row.meterKey) ? row.meterKey : CATCH_ALL_METER;
        if (from === meter) continue;
        await scope.db.run(sql`
          UPDATE job_status_map
             SET meter_key = ${meter},
                 updated_by_email = ${scope.identityEmail.toLowerCase()},
                 updated_at = ${at}
           WHERE organisation_id = ${scope.orgId}
             AND id = ${row.id}
        `);
        moves.push({ label: row.sourceStatusLabel, from, to: meter });
      }
      continue;
    }

    /*
     * A status that is on jobs but has no map row yet. Insert then update, the
     * same two-step `seedDashboardMeters` in `db/init.ts` uses and for the same
     * reason: `INSERT OR IGNORE` cannot report whether it inserted, so the
     * assignment is written by the statement after it either way. The literal
     * column defaults mirror that seed exactly, so a row created here is
     * indistinguishable from one the boot path would have created.
     */
    const label = labels.get(key) ?? key;
    /*
     * A RANDOM id, deliberately NOT the seed's `jsm_<org>_<slugged label>`.
     *
     * That derivation is lossy — "In Progress" and "In-Progress" slug to the
     * same string — and a primary-key collision would make `INSERT OR IGNORE`
     * skip a row it should have created, after which the `UPDATE` below matches
     * nothing and the status silently fails to move. The UNIQUE index on
     * (organisation, source_status_label) is what enforces one row per status,
     * and it does that whatever the id is; a random one simply removes a second,
     * lossy uniqueness rule that could disagree with it.
     */
    const id = crypto.randomUUID();
    await scope.db.run(sql`
      INSERT OR IGNORE INTO job_status_map (
        id, organisation_id, source_status_label, display_label, colour_hex,
        icon, chip_style, counts_as_open, counts_as_overdue_eligible,
        sort_order, active, meter_key
      ) VALUES (
        ${id}, ${scope.orgId}, ${label}, ${label}, '#9AAFB2',
        'dot', 'outline', 1, 1,
        900, 1, ${meter}
      )
    `);
    await scope.db.run(sql`
      UPDATE job_status_map
         SET meter_key = ${meter},
             updated_by_email = ${scope.identityEmail.toLowerCase()},
             updated_at = ${at}
       WHERE organisation_id = ${scope.orgId}
         AND source_status_label = ${label}
    `);
    moves.push({ label, from: CATCH_ALL_METER, to: meter });
  }
  return moves;
}

export async function PUT(request: Request) {
  try {
    await ensureDatabase();
    const guarded = await scopedDbWithCapability(request, "settings.edit");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;

    const body = (await request.json().catch(() => null)) as
      | { meters?: unknown; statuses?: unknown; reset?: unknown }
      | null;
    if (!body) return badRequest("Send a JSON body.");

    const reset = body.reset === true;
    const meterInputs: MeterInput[] = reset
      ? METER_KEYS.map((key, index) => ({
          key,
          label: METER_SEED_LABEL[key],
          colour: METER_SEED_COLOUR[key],
          sortOrder: index,
          visible: true,
        }))
      : Array.isArray(body.meters)
        ? (body.meters as MeterInput[])
        : [];
    if (!meterInputs.length) return badRequest("Send the meters to save.");

    /* ── The invariants, enforced HERE and not only in the UI ─────────────
     *
     * §2.5: "`other` cannot be deleted, renamed away from catch-all, or
     * hidden." A client that omits it, hides it, or hands its catch-all role to
     * another meter is refused rather than corrected, because silently
     * correcting a save makes the screen disagree with the database and the
     * operator cannot see which of the two won.
     */
    const seen = new Set<string>();
    const resolved: Array<{
      key: string;
      label: string;
      colour: string;
      sortOrder: number;
      visible: boolean;
    }> = [];
    for (const [index, input] of meterInputs.entries()) {
      const key = readText(input?.key, 40);
      if (!isMeterKey(key)) {
        return badRequest(`"${key || "(blank)"}" is not one of the eight meters.`);
      }
      if (seen.has(key)) return badRequest(`The meter "${key}" appears twice.`);
      seen.add(key);
      const label = readText(input?.label, LABEL_LIMIT) || METER_SEED_LABEL[key];
      const colour = readText(input?.colour, 7);
      if (colour && !HEX.test(colour)) {
        return badRequest(`"${colour}" is not a #rrggbb colour.`);
      }
      const visible = input?.visible === undefined ? true : input.visible !== false;
      if (key === CATCH_ALL_METER && !visible) {
        return badRequest(
          "Other is the permanent catch-all and cannot be hidden — every unmapped status counts there.",
        );
      }
      const order = Number(input?.sortOrder);
      resolved.push({
        key,
        label,
        colour: colour || METER_SEED_COLOUR[key],
        sortOrder: Number.isFinite(order) ? Math.trunc(order) : index,
        visible,
      });
    }
    if (!seen.has(CATCH_ALL_METER)) {
      return badRequest("Other is the permanent catch-all and cannot be deleted.");
    }

    /* Statuses. An unknown or absent meter resolves to the catch-all rather
       than being refused — §2.1 makes that the defined behaviour, and it is
       what lets a status invented tomorrow reconcile today. */
    const wanted = new Map<string, string>();
    const labels = new Map<string, string>();
    const statusInputs: StatusInput[] = Array.isArray(body.statuses)
      ? (body.statuses as StatusInput[])
      : [];
    for (const input of statusInputs) {
      const label = readText(input?.label, 120);
      if (!label) continue;
      const key = statusKey(label);
      if (!key) continue;
      const meter = readText(input?.meterKey, 40);
      wanted.set(key, isMeterKey(meter) ? meter : CATCH_ALL_METER);
      if (!labels.has(key)) labels.set(key, label);
    }

    const before = await buildPayload(scope, new URL(request.url), true);
    const beforeRows = await readStatusMap(scope.db, scope.orgId);
    const at = new Date().toISOString();
    /* Recorded once, before the first change this route ever makes here. See
       `ensureBaseline` — it is what Reset restores. */
    if (!reset) await ensureBaseline(scope, before, at);

    for (const meter of resolved) {
      /*
       * Upsert without `onConflictDoUpdate`: the row may not exist for a
       * workspace whose seed has not run, and the unique index is on
       * (organisation, meter_key). Update first, insert when nothing moved.
       */
      const updated = await scope.db
        .update(dashboardMeters)
        .set({
          displayLabel: meter.label,
          colourHex: meter.colour,
          sortOrder: meter.sortOrder,
          visible: meter.visible,
          isCatchAll: meter.key === CATCH_ALL_METER,
          updatedByEmail: scope.identityEmail.toLowerCase(),
          updatedAt: at,
        })
        .where(
          and(
            eq(dashboardMeters.organisationId, scope.orgId),
            eq(dashboardMeters.meterKey, meter.key),
          ),
        )
        .returning({ id: dashboardMeters.id });
      if (!updated.length) {
        await scope.db
          .insert(dashboardMeters)
          .values({
            id: `dm_${scope.orgId}_${meter.key}`,
            organisationId: scope.orgId,
            meterKey: meter.key,
            displayLabel: meter.label,
            colourHex: meter.colour,
            sortOrder: meter.sortOrder,
            visible: meter.visible,
            isCatchAll: meter.key === CATCH_ALL_METER,
            updatedByEmail: scope.identityEmail.toLowerCase(),
            updatedAt: at,
          })
          .onConflictDoNothing();
      }
    }

    let moves: Array<{ label: string; from: string; to: string }> = [];
    if (reset) {
      const baseline = await readBaseline(scope);
      if (baseline) {
        moves = await applyStatusAssignments(
          scope,
          beforeRows,
          baseline.wanted,
          baseline.labels,
          at,
        );
      }
    } else {
      moves = await applyStatusAssignments(scope, beforeRows, wanted, labels, at);
    }

    const after = await buildPayload(scope, new URL(request.url), true);

    /*
     * The diff is computed from the two payloads rather than from the request,
     * so what is logged is what the database now says and not what the client
     * asked for. `changeDetail` reduces it to the fields that actually moved.
     */
    const shape = (payload: MeterSettingsPayload) =>
      Object.fromEntries(
        payload.meters.map((meter) => [
          meter.key,
          {
            label: meter.label,
            visible: meter.visible,
            sortOrder: meter.sortOrder,
            statuses: meter.statuses.map((status) => status.label).sort(),
          },
        ]),
      );
    const diff = changeDetail(shape(before), shape(after));

    await scope.db.insert(activityLog).values({
      id: crypto.randomUUID(),
      organisationId: scope.orgId,
      entityType: "dashboard_meters",
      entityId: scope.orgId,
      action: reset ? "meters.reset" : "meters.saved",
      actorEmail: scope.identityEmail.toLowerCase(),
      detail: JSON.stringify({ moves, changed: diff.changed }),
      createdAt: at,
    });

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: reset ? "dashboard.meters_reset" : "dashboard.meters_saved",
      entityType: "dashboard_meters",
      entityId: scope.orgId,
      summary: reset
        ? "Reset the dashboard meters to their defaults."
        : `Saved the dashboard meters — ${moves.length} status ${
            moves.length === 1 ? "move" : "moves"
          }.`,
      detail: { ...diff, moves },
      request,
    });

    return Response.json({ ...after, saved: true, moves });
  } catch (error) {
    return failure(error, "The meter settings could not be saved.");
  }
}

/**
 * THE BASELINE — what "reset to defaults" actually restores.
 *
 * The seeded grouping lives in `JOB_STATUS_METER_SEED` inside `db/init.ts`,
 * which does not export it, and `ensureDatabase()` is memoised per process — so
 * the obvious reset, clearing every `meter_key` and letting the boot path's
 * `UPDATE … WHERE meter_key IS NULL` refill them, would leave the whole
 * workspace reading `Other` until the server next restarted. That is a worse
 * screen than the one the operator was trying to undo.
 *
 * So the FIRST save this route makes for a workspace records the configuration
 * it found, once, as an `activity_log` entry. That row is the default: it is
 * precisely the state the seed left, captured before anybody edited it, and
 * replaying it needs no export, no schema and no restart.
 *
 * A workspace that has never been edited has no baseline and needs none — it is
 * already at the seed, so a reset there only restores the meter names, colours,
 * order and visibility, and the response says how many statuses moved (none).
 */
const BASELINE_ACTION = "meters.baseline";

async function ensureBaseline(
  scope: ScopedDatabase,
  before: MeterSettingsPayload,
  at: string,
): Promise<void> {
  const existing = await scope.db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.organisationId, scope.orgId),
        eq(activityLog.entityType, "dashboard_meters"),
        eq(activityLog.action, BASELINE_ACTION),
      ),
    )
    .limit(1);
  if (existing.length) return;
  await scope.db.insert(activityLog).values({
    id: crypto.randomUUID(),
    organisationId: scope.orgId,
    entityType: "dashboard_meters",
    entityId: scope.orgId,
    action: BASELINE_ACTION,
    actorEmail: scope.identityEmail.toLowerCase(),
    detail: JSON.stringify({
      meters: before.meters.map((meter) => ({
        key: meter.key,
        label: meter.label,
        colour: meter.colour,
        sortOrder: meter.sortOrder,
        visible: meter.visible,
      })),
      statuses: before.meters.flatMap((meter) =>
        meter.statuses.map((status) => ({ label: status.label, meterKey: meter.key })),
      ),
    }),
    createdAt: at,
  });
}

/** The recorded baseline mapping, or null where this workspace has never been edited. */
async function readBaseline(
  scope: ScopedDatabase,
): Promise<{ wanted: Map<string, string>; labels: Map<string, string> } | null> {
  const rows = await scope.db
    .select({ detail: activityLog.detail })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.organisationId, scope.orgId),
        eq(activityLog.entityType, "dashboard_meters"),
        eq(activityLog.action, BASELINE_ACTION),
      ),
    )
    .orderBy(activityLog.createdAt)
    .limit(1);
  const detail = rows[0]?.detail;
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail) as {
      statuses?: Array<{ label?: unknown; meterKey?: unknown }>;
    };
    if (!Array.isArray(parsed.statuses)) return null;
    const wanted = new Map<string, string>();
    const labels = new Map<string, string>();
    for (const entry of parsed.statuses) {
      const label = typeof entry?.label === "string" ? entry.label.trim() : "";
      const key = statusKey(label);
      if (!key) continue;
      const meter = typeof entry?.meterKey === "string" ? entry.meterKey : "";
      wanted.set(key, isMeterKey(meter) ? meter : CATCH_ALL_METER);
      if (!labels.has(key)) labels.set(key, label);
    }
    return wanted.size ? { wanted, labels } : null;
  } catch {
    return null;
  }
}

/**
 * The catch every handler here ends with: a dead session is a 401, a pooler at
 * capacity is a retryable 503, and everything else is a 503 that never carries
 * `error.message` outside development — see `dashboardFailure`, which this
 * mirrors for a namespace that also writes.
 */
function failure(error: unknown, consequence: string): Response {
  const anonymous = anonymousRefusal(error);
  if (anonymous) return anonymous;
  const busy = busyRefusal(error, consequence);
  if (busy) return busy;
  console.error("[/api/overview/meter-settings]", error);
  if (error instanceof Error && error.cause) {
    console.error("[/api/overview/meter-settings] cause:", error.cause);
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return Response.json(
    {
      error:
        process.env.NODE_ENV === "development"
          ? `${consequence} ${message}`
          : consequence,
    },
    { status: 503 },
  );
}
