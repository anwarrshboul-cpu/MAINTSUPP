/**
 * §38 — VERSION HISTORY, the database half. Append-only: every function here
 * inserts or reads; nothing updates or deletes a `config_versions` row.
 *
 *   ensureConfigBaseline  — before the FIRST versioned write of a setting, a
 *                           version 1 holding the state as it was, because that
 *                           is the only moment it still exists.
 *   recordConfigVersion   — after a write: a new version, unless the state is
 *                           identical to the latest (a Save that changed
 *                           nothing is not history). A restore always records.
 *   listConfigVersions    — newest first, WITHOUT the snapshot.
 *   loadRestoreSnapshot   — one version's state, for the setting's own save
 *                           route to write back.
 *
 * Numbering under concurrency follows `allocateSubmission`: read the highest
 * number once, then try the next few with `ON CONFLICT DO NOTHING`; an empty
 * answer means somebody else took that number, so take the one after. Two
 * near-simultaneous saves may be numbered in a different order from their
 * writes — which is why "current" is decided by comparing a version's digest
 * with the live state, never by assuming the newest is it.
 *
 * Recording is BEST-EFFORT, like `recordAudit`: the setting has already been
 * saved when it runs, and telling the person their save failed because its
 * history row did not write would be untrue. A failure is logged loudly.
 */

import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { configVersions } from "../../db/schema";
import { canonicalJson, type ChangeKind, type VersionSubject } from "./config-versions-model";

type Database = Awaited<ReturnType<typeof getDb>>;

export type VersionTarget = {
  /** null = installation-wide. */
  organisationId: string | null;
  subject: VersionSubject;
  key: string;
};

export type VersionActor = { email?: string | null; userId?: string | null };

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function stateDigest(snapshot: unknown) {
  return sha256(canonicalJson(snapshot));
}

function whereTarget(target: VersionTarget) {
  return and(
    target.organisationId === null ? isNull(configVersions.organisationId) : eq(configVersions.organisationId, target.organisationId),
    eq(configVersions.subjectType, target.subject),
    eq(configVersions.subjectKey, target.key),
  );
}

async function latest(db: Database, target: VersionTarget) {
  const [row] = await db
    .select({ versionNo: configVersions.versionNo, digest: configVersions.digest, snapshot: configVersions.snapshot })
    .from(configVersions)
    .where(whereTarget(target))
    .orderBy(desc(configVersions.versionNo))
    .limit(1);
  return row ?? null;
}

async function insertNext(
  db: Database,
  target: VersionTarget,
  values: { kind: ChangeKind; snapshot: string; digest: string; summary: string; restoredFrom: number | null; actor: VersionActor },
) {
  const [{ top }] = await db
    .select({ top: sql<number | string | null>`coalesce(max(${configVersions.versionNo}), 0)` })
    .from(configVersions)
    .where(whereTarget(target));
  const base = Number(top ?? 0);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const versionNo = base + 1 + attempt;
    const [inserted] = await db
      .insert(configVersions)
      .values({
        id: `cfv_${crypto.randomUUID().replace(/-/g, "")}`,
        organisationId: target.organisationId,
        subjectType: target.subject,
        subjectKey: target.key,
        versionNo,
        changeKind: values.kind,
        snapshot: values.snapshot,
        digest: values.digest,
        summary: values.summary.slice(0, 400),
        restoredFromVersion: values.restoredFrom,
        actorEmail: values.actor.email?.toLowerCase() ?? null,
        actorUserId: values.actor.userId ?? null,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .returning({ versionNo: configVersions.versionNo });
    if (inserted) return inserted.versionNo;
  }
  throw new Error("Could not allocate a version number after 5 attempts.");
}

/** Version 1 = the state before history began, written once, just before the first versioned write. */
export async function ensureConfigBaseline(db: Database, target: VersionTarget, snapshot: unknown, actor: VersionActor) {
  try {
    if (await latest(db, target)) return;
    const text = canonicalJson(snapshot);
    await insertNext(db, target, {
      kind: "baseline",
      snapshot: text,
      digest: await sha256(text),
      summary: "How it was before version history began.",
      restoredFrom: null,
      actor,
    });
  } catch (error) {
    console.error("[config-versions] the baseline could not be recorded:", error instanceof Error ? error.name : "error");
  }
}

/**
 * A new version after a write. Returns its number, or null when nothing was
 * recorded (an identical save, or a failure — which is logged).
 */
export async function recordConfigVersion(
  db: Database,
  target: VersionTarget,
  input: { snapshot: unknown; summary: string; kind?: ChangeKind; restoredFrom?: number | null; actor: VersionActor },
): Promise<number | null> {
  try {
    const text = canonicalJson(input.snapshot);
    const digest = await sha256(text);
    const kind = input.kind ?? (input.restoredFrom ? "restored" : "saved");
    const previous = await latest(db, target);
    if (kind === "saved" && previous?.digest === digest) return null;
    return await insertNext(db, target, {
      kind,
      snapshot: text,
      digest,
      summary: input.summary,
      restoredFrom: input.restoredFrom ?? null,
      actor: input.actor,
    });
  } catch (error) {
    console.error("[config-versions] a version could not be recorded:", error instanceof Error ? error.name : "error");
    return null;
  }
}

/** The previous version's state, for a summary of what changed. */
export async function latestSnapshot(db: Database, target: VersionTarget): Promise<unknown | null> {
  try {
    const row = await latest(db, target);
    return row ? JSON.parse(row.snapshot) : null;
  } catch {
    return null;
  }
}

/** Newest first, `limit` at a time, never the snapshot. `current` marks the versions equal to the live state. */
export async function listConfigVersions(
  db: Database,
  target: VersionTarget,
  options: { limit?: number; before?: number | null; liveDigest?: string | null } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const rows = await db
    .select({
      versionNo: configVersions.versionNo,
      changeKind: configVersions.changeKind,
      summary: configVersions.summary,
      restoredFromVersion: configVersions.restoredFromVersion,
      actorEmail: configVersions.actorEmail,
      createdAt: configVersions.createdAt,
      digest: configVersions.digest,
    })
    .from(configVersions)
    .where(and(whereTarget(target), options.before ? lt(configVersions.versionNo, options.before) : undefined))
    .orderBy(desc(configVersions.versionNo))
    .limit(limit + 1);
  return {
    versions: rows.slice(0, limit).map((row) => ({
      version: row.versionNo,
      kind: row.changeKind as ChangeKind,
      summary: row.summary,
      restoredFromVersion: row.restoredFromVersion ?? null,
      actorEmail: row.actorEmail ?? null,
      createdAt: row.createdAt,
      current: options.liveDigest ? row.digest === options.liveDigest : false,
    })),
    hasMore: rows.length > limit,
  };
}

/** One version's state, or why it cannot be restored. Scoped to the target's workspace. */
export async function loadRestoreSnapshot(
  db: Database,
  target: VersionTarget,
  version: number,
): Promise<{ ok: true; snapshot: unknown } | { ok: false; status: number; error: string }> {
  const [row] = await db
    .select({ snapshot: configVersions.snapshot, changeKind: configVersions.changeKind })
    .from(configVersions)
    .where(and(whereTarget(target), eq(configVersions.versionNo, version)))
    .limit(1);
  if (!row) return { ok: false, status: 404, error: `There is no version ${version} of this setting here.` };
  if (row.changeKind === "deleted") {
    return { ok: false, status: 409, error: `Version ${version} records a deletion; restore the version before it.` };
  }
  return { ok: true, snapshot: JSON.parse(row.snapshot) };
}

/**
 * §38b — the keys (page slugs) whose LATEST version is a deletion: what the
 * "Deleted pages" list offers to bring back. Installation-wide subjects only.
 */
export async function listDeletedKeys(db: Database, subject: VersionSubject) {
  const rows = await db
    .select({ key: configVersions.subjectKey, versionNo: configVersions.versionNo, changeKind: configVersions.changeKind, createdAt: configVersions.createdAt, actorEmail: configVersions.actorEmail })
    .from(configVersions)
    .where(and(isNull(configVersions.organisationId), eq(configVersions.subjectType, subject)))
    .orderBy(desc(configVersions.versionNo));
  const latestByKey = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latestByKey.has(row.key)) latestByKey.set(row.key, row);
  return [...latestByKey.values()]
    .filter((row) => row.changeKind === "deleted")
    .map((row) => ({ key: row.key, deletedAt: row.createdAt, deletedBy: row.actorEmail ?? null, version: row.versionNo }));
}
