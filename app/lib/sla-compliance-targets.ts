/**
 * THE OVERVIEW'S SLA COMPLIANCE TARGETS — versioned, per workspace, never
 * overwritten. Dashboard §4.4 and §9 item 25; owner decision 2026-09-23.
 *
 * The live Overview judges SLA as open jobs not yet past their due date, and
 * draws that against a TARGET: the Priority & SLA gauge's colour and the "SLA
 * Compliance by Priority Tier" bars' marker. That target was a constant — 95%,
 * `SLA_TARGET_ARC.good` — so no workspace could hold a priority to anything
 * else, and changing it meant a deploy. The owner chose (2026-09-23) to make
 * exactly that number configurable and versioned: which jobs count as within
 * SLA does not change, so no figure moves and the Jobs board still agrees; only
 * the line the figures are held to.
 *
 * ── WHERE IT LIVES ────────────────────────────────────────────────────────
 *
 * `sla_targets`, stage `compliance`, one row per key — `overall` (the gauge)
 * and the four priorities the bars draw — with the percentage in
 * `target_percent`. A row is NEVER edited: a change stamps `superseded_at` on
 * the current row and inserts the next `version`, in one transaction, so every
 * target a workspace has ever used is still there with the time it took effect
 * and who set it. `sla_targets_current_idx` (db/init.ts) allows one current row
 * per key, so two saves racing cannot both win.
 *
 * NO SEED. A key with no row is the shipped default, reported as such — the
 * editor says "default", and the first save writes version 1.
 *
 * Pure of `tenant-db` and of any request, like `contractor-alias-writes.ts`:
 * the route passes the scoped handle and the organisation, and
 * `tests/sla-compliance-targets.test.mjs` runs this against real SQLite.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { getDb } from "../../db";
import { activityLog, slaTargets } from "../../db/schema";
import { SLA_TARGET_ARC } from "./dashboard-policy";

type Db = Awaited<ReturnType<typeof getDb>>;

export const SLA_COMPLIANCE_STAGE = "compliance";

/** `overall` is the gauge; the rest are the bars, in the bars' own order. */
export const SLA_TARGET_KEYS = ["overall", "urgent", "medium", "low", "not_recorded"] as const;
export type SlaTargetKey = (typeof SLA_TARGET_KEYS)[number];
export type SlaPriorityKey = Exclude<SlaTargetKey, "overall">;

/** What ships, and what a key with no saved row still means. */
export const SLA_TARGET_DEFAULT_PERCENT = SLA_TARGET_ARC.good;
export const SLA_TARGET_MIN_PERCENT = 1;
export const SLA_TARGET_MAX_PERCENT = 100;

export type SlaTargetEntry = {
  key: SlaTargetKey;
  percent: number;
  /** "default" until somebody saves this key. */
  source: "default" | "workspace";
  version: number | null;
  effectiveFrom: string | null;
  updatedBy: string | null;
};

export type SlaComplianceTargets = {
  overall: number;
  byPriority: Record<SlaPriorityKey, number>;
  entries: SlaTargetEntry[];
};

type TargetRow = {
  id: string;
  priorityKey: string;
  targetPercent: number | null;
  version: number;
  effectiveFrom: string;
  updatedByEmail: string | null;
};

async function currentRows(db: Db, orgId: string): Promise<TargetRow[]> {
  return db
    .select({
      id: slaTargets.id,
      priorityKey: slaTargets.priorityKey,
      targetPercent: slaTargets.targetPercent,
      version: slaTargets.version,
      effectiveFrom: slaTargets.effectiveFrom,
      updatedByEmail: slaTargets.updatedByEmail,
    })
    .from(slaTargets)
    .where(
      and(
        eq(slaTargets.organisationId, orgId),
        eq(slaTargets.stage, SLA_COMPLIANCE_STAGE),
        sql`${slaTargets.supersededAt} is null`,
      ),
    );
}

function usable(percent: number | null | undefined): percent is number {
  return (
    typeof percent === "number" &&
    Number.isInteger(percent) &&
    percent >= SLA_TARGET_MIN_PERCENT &&
    percent <= SLA_TARGET_MAX_PERCENT
  );
}

function assemble(rows: TargetRow[]): SlaComplianceTargets {
  const byKey = new Map(rows.map((row) => [row.priorityKey, row]));
  const entries: SlaTargetEntry[] = SLA_TARGET_KEYS.map((key) => {
    const row = byKey.get(key);
    /* A row whose percentage is unusable is reported as the default rather
       than drawn: a marker at 0% or 140% is a broken chart, not a target. */
    if (!row || !usable(row.targetPercent)) {
      return { key, percent: SLA_TARGET_DEFAULT_PERCENT, source: "default", version: null, effectiveFrom: null, updatedBy: null };
    }
    return {
      key,
      percent: row.targetPercent,
      source: "workspace",
      version: row.version,
      effectiveFrom: row.effectiveFrom,
      updatedBy: row.updatedByEmail,
    };
  });
  const percent = (key: SlaTargetKey) => entries.find((entry) => entry.key === key)!.percent;
  return {
    overall: percent("overall"),
    byPriority: {
      urgent: percent("urgent"),
      medium: percent("medium"),
      low: percent("low"),
      not_recorded: percent("not_recorded"),
    },
    entries,
  };
}

/** The targets in effect now for one workspace — what the live card draws. */
export async function readSlaComplianceTargets(db: Db, orgId: string): Promise<SlaComplianceTargets> {
  return assemble(await currentRows(db, orgId));
}

/** Every version this workspace has saved, newest first — the editor's history. */
export async function slaComplianceTargetHistory(db: Db, orgId: string, limit = 40) {
  return db
    .select({
      key: slaTargets.priorityKey,
      percent: slaTargets.targetPercent,
      version: slaTargets.version,
      effectiveFrom: slaTargets.effectiveFrom,
      supersededAt: slaTargets.supersededAt,
      updatedBy: slaTargets.updatedByEmail,
      note: slaTargets.note,
    })
    .from(slaTargets)
    .where(and(eq(slaTargets.organisationId, orgId), eq(slaTargets.stage, SLA_COMPLIANCE_STAGE)))
    .orderBy(desc(slaTargets.effectiveFrom), desc(slaTargets.version))
    .limit(limit);
}

/**
 * A request body's targets, checked. Unknown keys are refused rather than
 * dropped — a typo'd key saved as nothing would read as a save that happened.
 */
export function parseSlaTargetInput(
  input: unknown,
): { ok: true; values: Partial<Record<SlaTargetKey, number>> } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Send the targets as an object of whole percentages." };
  }
  const values: Partial<Record<SlaTargetKey, number>> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(SLA_TARGET_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `"${key}" is not an SLA target. Use ${SLA_TARGET_KEYS.join(", ")}.` };
    }
    if (!usable(value as number)) {
      return {
        ok: false,
        error: `The ${key} target must be a whole percentage from ${SLA_TARGET_MIN_PERCENT} to ${SLA_TARGET_MAX_PERCENT}.`,
      };
    }
    values[key as SlaTargetKey] = value as number;
  }
  if (Object.keys(values).length === 0) return { ok: false, error: "Name at least one target to change." };
  return { ok: true, values };
}

export type SlaTargetChange = { key: SlaTargetKey; from: number; to: number; version: number };

/**
 * Save new targets as new VERSIONS — the current row superseded, the next one
 * inserted, and an activity row naming every change, all in one batch. A key
 * whose value equals the target already in effect writes nothing, so saving
 * the form unchanged leaves no trace. Returns the changes and the targets now
 * in effect.
 */
export async function saveSlaComplianceTargets(
  db: Db,
  orgId: string,
  values: Partial<Record<SlaTargetKey, number>>,
  actor: string,
  at: string,
  note: string | null = null,
): Promise<{ changes: SlaTargetChange[]; targets: SlaComplianceTargets }> {
  const rows = await currentRows(db, orgId);
  const before = assemble(rows);
  const byKey = new Map(rows.map((row) => [row.priorityKey, row]));
  const statements: BatchItem<"sqlite">[] = [];
  const changes: SlaTargetChange[] = [];

  for (const key of SLA_TARGET_KEYS) {
    const to = values[key];
    if (to === undefined) continue;
    const from = before.entries.find((entry) => entry.key === key)!.percent;
    if (to === from) continue;
    const current = byKey.get(key);
    const version = (current?.version ?? 0) + 1;
    if (current) {
      statements.push(
        db
          .update(slaTargets)
          .set({ supersededAt: at })
          .where(and(eq(slaTargets.id, current.id), sql`${slaTargets.supersededAt} is null`)),
      );
    }
    statements.push(
      db.insert(slaTargets).values({
        id: crypto.randomUUID(),
        organisationId: orgId,
        stage: SLA_COMPLIANCE_STAGE,
        priorityKey: key,
        /* NOT NULL on the ladder's column; no reader of this stage consults it. */
        targetMinutes: 0,
        targetPercent: to,
        basis: "percent",
        version,
        effectiveFrom: at,
        note,
        updatedByEmail: actor,
        updatedAt: at,
      }),
    );
    changes.push({ key, from, to, version });
  }

  if (changes.length === 0) return { changes, targets: before };

  statements.push(
    db.insert(activityLog).values({
      id: crypto.randomUUID(),
      organisationId: orgId,
      entityType: "sla_targets",
      entityId: SLA_COMPLIANCE_STAGE,
      action: "sla_targets.updated",
      actorEmail: actor,
      detail: JSON.stringify({ changes, note }),
      createdAt: at,
    }),
  );

  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return { changes, targets: await readSlaComplianceTargets(db, orgId) };
}
