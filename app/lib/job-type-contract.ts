/**
 * THE JOB TYPE WIRE CONTRACT — shapes and constants only, ZERO imports.
 *
 * A job's type is the id of a `job_type_config` row (`maintenance_requests
 * .job_type_id`), or null for "Unclassified". This module is what the browser,
 * the routes and the Reports builder share, so it imports nothing: a client
 * component may read it without reaching drizzle, and `node --test` loads it
 * directly. The same arrangement as `compliance-dash-contract.ts`.
 *
 * ── THREE KINDS OF TYPE ───────────────────────────────────────────────────
 *
 *   · the three DEFAULTS, each with a stable `code` — reactive, planned,
 *     project — seeded per organisation with fixed ids (`jt_<org>_<code>`).
 *     Reports' Reactive / Planned / Projects KPIs are these codes, so a rename
 *     moves the words and never the figures;
 *   · CUSTOM types an administrator adds: `code` null, grouped by Reports as
 *     "Other" beside the three, never dropped;
 *   · UNCLASSIFIED: a job with no type. Not a row — null on the job — and every
 *     job that existed before this dimension is one, because nothing ever
 *     recorded a type to backfill from.
 */

/** The stable meanings of the three default types. */
export const JOB_TYPE_CODES = ["reactive", "planned", "project"] as const;
export type JobTypeCode = (typeof JOB_TYPE_CODES)[number];

/** A drill / URL token for jobs with no type. */
export const UNCLASSIFIED_JOB_TYPE = "__unclassified__";
/** A drill / URL token for every custom (code-less) type together. */
export const OTHER_JOB_TYPES = "__other__";

export const UNCLASSIFIED_LABEL = "Unclassified";
export const OTHER_JOB_TYPES_LABEL = "Other";

/** One job type, as the API and the Reports builder carry it. */
export type JobType = {
  /** Stable. What a job stores. Survives every rename. */
  id: string;
  /** reactive / planned / project for the seeded defaults; null for a custom type. */
  code: JobTypeCode | null;
  /** Display only. May be renamed. */
  label: string;
  /** Optional accent; the defaults take the Reports palette by code when null. */
  colourHex: string | null;
  sortOrder: number;
  /** False once deactivated: hidden from NEW selection, kept on every job that has it. */
  active: boolean;
};

export function isJobTypeCode(value: unknown): value is JobTypeCode {
  return typeof value === "string" && (JOB_TYPE_CODES as readonly string[]).includes(value);
}

/**
 * The code a URL token names, for links written before types had ids: the
 * Reports drill used `type=reactive|planned|projects`, and a bookmark of one
 * must keep opening the same jobs. `projects` is the old plural.
 */
export function legacyJobTypeCode(token: string): JobTypeCode | null {
  const value = token.trim().toLowerCase();
  if (value === "projects") return "project";
  return isJobTypeCode(value) ? value : null;
}

/**
 * The job type ids one drill token selects, against an organisation's types:
 *
 *   · a type id           → that type
 *   · reactive / planned / project / projects → the type with that code
 *   · `__other__`         → every custom (code-less) type
 *   · `__unclassified__`  → jobs with no type (returned as `null` in the set)
 *
 * An unknown token selects nothing rather than everything, so a stale or
 * hand-edited URL can never widen a list.
 */
export function jobTypeIdsForToken(token: string, types: readonly JobType[]): Set<string | null> {
  const value = token.trim();
  if (!value) return new Set();
  if (value === UNCLASSIFIED_JOB_TYPE) return new Set([null]);
  if (value === OTHER_JOB_TYPES) return new Set(types.filter((type) => type.code === null).map((type) => type.id));
  const byId = types.find((type) => type.id === value);
  if (byId) return new Set([byId.id]);
  const code = legacyJobTypeCode(value);
  if (code) return new Set(types.filter((type) => type.code === code).map((type) => type.id));
  return new Set();
}
