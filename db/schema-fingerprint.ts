/**
 * THE MIGRATION FINGERPRINT — why the boot path may skip itself, and when it
 * may not.
 *
 * `ensureDatabase()` replays every `CREATE TABLE IF NOT EXISTS`, every guarded
 * `addColumn` and every `INSERT OR IGNORE` seed on the first request of each
 * cold instance. Measured on the development estate: **47 seconds** for that
 * first request, against 0.98s for every request after it, spread across
 * thirty stages with no single one dominating — the largest was 28% of the
 * total. Whoever opened the site while an instance was cold watched a blank
 * page for most of a minute.
 *
 * Replaying it is not wasted work in principle: it is what makes the migrations
 * additive and self-healing. It is wasted work only when NOTHING HAS CHANGED,
 * and the whole difficulty is saying that precisely enough to be trusted with a
 * client's database.
 *
 * ── WHAT THE FINGERPRINT COVERS ────────────────────────────────────────────
 *
 * Two things, because two things decide what the replay would do:
 *
 *   1. THE CODE. `SCHEMA_FINGERPRINT` below changes whenever any module that
 *      issues migration SQL changes. It is not maintained by hand and trusted —
 *      `tests/schema-fingerprint.test.mjs` recomputes it from those files and
 *      fails if the constant disagrees, so forgetting to bump it is a red
 *      suite, not a database that silently stops migrating. That test IS the
 *      mechanism; this constant on its own would be the hazard.
 *
 *   2. THE SET OF TENANTS. Several stages fan out with
 *      `INSERT … SELECT … FROM organisations WHERE status = 'active'`, giving
 *      every organisation its board, its status map, its meters and its
 *      reminder defaults. An organisation created at RUNTIME — `POST
 *      /api/context` with `action: "create_organisation"` does exactly that —
 *      arrives after those stages have run, and today the next cold start
 *      quietly completes it. A fingerprint that knew only about code would skip
 *      that repair for ever, and the new tenant would stay half-built with no
 *      error anywhere. So the count of active organisations is part of the
 *      fingerprint: add a tenant and the next boot replays in full, once.
 *
 * ── WHAT IT DELIBERATELY DOES NOT COVER ────────────────────────────────────
 *
 * Stages that REPAIR DRIFT rather than apply a migration keep running on every
 * boot, fingerprint or not. `repairOrphanedSectionBoards` is the clear case: it
 * reads live rows and fixes boards orphaned when a section is deleted, which is
 * something ordinary use can cause again tomorrow. Its effect is a function of
 * the DATA, not of the code, so "the code has not changed" says nothing about
 * whether it has work to do. `initialize()` names these explicitly rather than
 * inferring them, because the cost of getting that inference wrong is silent
 * data drift and the cost of being explicit is a line of code.
 *
 * ── FAILURE, AND WHY A PARTIAL RUN CANNOT BE RECORDED AS A WHOLE ONE ────────
 *
 * The fingerprint is written ONLY after every stage has resolved. A stage that
 * throws rejects `initialize()`, `ensureDatabase()` clears its memo so the next
 * request tries again, and nothing was stored — so the next boot replays
 * everything rather than trusting a half-applied schema. There is no code path
 * that records a fingerprint for a run that did not finish.
 *
 * ── CONCURRENCY ────────────────────────────────────────────────────────────
 *
 * Several cold instances can boot at once and all miss the fingerprint. They
 * then all replay, which is exactly what they all do today, and it is safe for
 * the same reason it is safe today: every statement in the replay is
 * idempotent. Recording the fingerprint is an upsert on a single-row table, so
 * the last writer wins with the same value. No lock is introduced, because a
 * lock across serverless instances would be a new distributed-systems problem
 * bought to save work that is already harmless.
 */

/**
 * A CHEAP, DETERMINISTIC HASH — FNV-1a, 32-bit, as hex.
 *
 * Not a cryptographic digest and not trying to be: nothing here defends against
 * an adversary choosing a collision, it only has to change when the source
 * changes. `crypto.subtle` is async and unavailable in some of the contexts
 * this module is read from; a handful of arithmetic per character is not.
 */
export function fingerprintOf(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    /* The FNV prime, by shifts, so the multiply stays inside 32 bits. */
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The files whose content decides what the replay would do.
 *
 * `tests/schema-fingerprint.test.mjs` reads exactly this list, in this order,
 * and recomputes the constant below. Adding a module that issues migration SQL
 * means adding it here — and if you forget, the test that proves the constant
 * matches will not protect the module you forgot, so the list is part of the
 * contract rather than a convenience.
 */
export const FINGERPRINTED_SOURCES: readonly string[] = [
  /* What the migrations SAY. */
  "db/init.ts",
  "db/schema.ts",
  "db/demo-workspace.ts",
  /* Holds the intake workspace's fixed id and its four seed statements. Changing
     that id decides which workspace the seed creates AND which one the public
     enquiry path writes to, so it is a migration change in every sense. */
  "db/website-leads-workspace.ts",
  "db/seed-board-structure.ts",
  "db/seed-store-documentation.ts",
  "db/seed-options.ts",
  "db/monday-board-spec.ts",
  "db/legacy-memberships.ts",
  /*
   * And what actually REACHES the database, which is not the same thing.
   *
   * The portal writes SQLite and the deployed database is Postgres, so
   * `sqlite-to-postgres.ts` decides what a `CREATE TABLE` or an
   * `INSERT OR IGNORE` becomes on the way. A fix in that translator — the
   * `BOOLEAN_COLUMNS` trap is the standing example — corrects a statement this
   * file has already run, and correcting it is worth nothing if the replay is
   * skipped because the migration text did not change. Including the two
   * drivers costs one full replay after a driver change; excluding them costs a
   * fix that silently never applies.
   */
  "db/sqlite-to-postgres.ts",
  "db/node-pg-d1.ts",
  "db/node-d1.ts",
];

/**
 * THE SCHEMA GENERATIONS — every fingerprint this codebase has shipped, oldest
 * first. A build's GENERATION is its position in this list (1-based), and its
 * fingerprint is the last entry.
 *
 * WHY A FINGERPRINT ALONE WAS NOT ENOUGH. A fingerprint says "different"; it
 * cannot say "newer". Measured on Production on 2026-09-23: an old Production
 * deployment (#90) was opened at its own URL, saw a fingerprint that was not
 * its own, replayed ITS older migration set over the newer database and
 * overwrote the stored state with its own fingerprint — and the current build's
 * next cold instance, seeing a stranger's fingerprint in turn, replayed
 * everything again. Two 340-statement replays in one minute, two requests lost
 * to the 60-second limit. Every superseded Production deployment shares the
 * Production database, and every one of them could do it.
 *
 * With an order, the rule is simple: a build that finds a HIGHER generation
 * recorded is the older one, and it touches nothing — no replay, no repair, no
 * write (`decideSchemaBoot`). A build that finds a lower one migrates and
 * records its own, and the write itself refuses to lower the number, so two
 * builds racing at a deploy cannot leave the older one's record behind.
 *
 * APPEND ONLY. `tests/schema-fingerprint.test.mjs` recomputes the fingerprint
 * of the sources and fails unless it equals the LAST entry. When it fails, add
 * the printed value as a NEW last entry. Never edit or remove an entry: the
 * position is the generation, and renumbering one would let an older build
 * believe it is newer.
 */
export const SCHEMA_GENERATIONS: readonly string[] = [
  /* 1 — `71d3eda` (#105), the last build before generations existed. Such
     builds know only the legacy `migrations` row below. */
  "a7bcc17c",
  /* 2 — the generation guard itself; it changes `db/init.ts` and the driver. */
  "e043666b",
];

/** This build's generation: its position in `SCHEMA_GENERATIONS`. */
export const SCHEMA_GENERATION: number = SCHEMA_GENERATIONS.length;

/**
 * THE CURRENT MIGRATION FINGERPRINT — the last generation's.
 *
 * Recomputed and asserted by `tests/schema-fingerprint.test.mjs`. When that
 * test fails it is telling you the migrations changed and the list did not —
 * APPEND the value it prints to `SCHEMA_GENERATIONS`. Do not "fix" it by
 * relaxing the test: the test is the only thing standing between a changed
 * migration and a database that thinks it is already up to date.
 */
export const SCHEMA_FINGERPRINT: string = SCHEMA_GENERATIONS[SCHEMA_GENERATIONS.length - 1] as string;

/**
 * The LEGACY row: written by every build before generations existed, and read
 * by nothing from generation 2 on. Left in place rather than removed, because
 * a superseded pre-generation deployment still writes it when woken, and a
 * rollback to one would want to find its own value there.
 */
export const SCHEMA_STATE_KEY = "migrations";

/**
 * The row generation-aware builds read and write. A different key from the
 * legacy one on purpose: a pre-generation build, which cannot be changed any
 * more, only ever writes `migrations`, so from generation 2 on it can no
 * longer overwrite what the current build relies on.
 */
export const SCHEMA_GENERATION_KEY = "schema_generation";

/** Six digits, so the stored value's first six characters compare as a number. */
const GENERATION_WIDTH = 6;

/**
 * The stored value for a completed run at a given generation:
 * `000002:<fingerprint>:orgs=<stamp>`. The fixed-width prefix lets the write
 * refuse a downgrade in SQL — `CAST(substr(value, 1, 6) AS INTEGER) <= ?` —
 * with no parsing, identically in SQLite and Postgres.
 */
export function schemaGenerationValue(
  generation: number,
  codeFingerprint: string,
  activeOrganisations: string,
): string {
  return `${String(generation).padStart(GENERATION_WIDTH, "0")}:${schemaStateValue(codeFingerprint, activeOrganisations)}`;
}

export interface StoredSchemaGeneration {
  generation: number;
  fingerprint: string;
  organisations: string;
}

/** The stored value, or null when there is none or it is not one this code wrote. */
export function parseSchemaGenerationValue(value: unknown): StoredSchemaGeneration | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{6}):([0-9a-f]{8}):orgs=(.*)$/.exec(value);
  if (!match) return null;
  return { generation: Number(match[1]), fingerprint: match[2] as string, organisations: match[3] as string };
}

export interface SchemaBuild {
  generation: number;
  fingerprint: string;
}

export type SchemaBootAction = "migrate" | "current" | "newer-schema";

export interface SchemaBootDecision {
  action: SchemaBootAction;
  /** One line for the log: why this boot does what it does. No data. */
  reason: string;
}

/**
 * WHAT A BOOT MAY DO, decided from the stored generation and this build's.
 *
 *   - nothing recorded                    → migrate (a first boot, or the first
 *                                           boot since generations existed)
 *   - a HIGHER generation recorded        → newer-schema: this build is the
 *                                           older one and must touch nothing
 *   - a lower generation recorded         → migrate
 *   - same generation, other fingerprint  → migrate (two builds that share a
 *                                           number — Preview branches on
 *                                           Staging — behave as before)
 *   - same generation and fingerprint     → current, unless the tenant set
 *                                           changed, which re-runs the fan-out
 *
 * The tenant stamp is read ONLY in the last case, the one place it can change
 * the answer. It is a function the caller supplies, and a failure in it is
 * thrown, not swallowed: an unreadable stamp is not evidence that the schema
 * needs rebuilding, and treating it as such is how one transient read became a
 * 340-statement replay.
 */
export async function decideSchemaBoot(
  stored: StoredSchemaGeneration | null,
  build: SchemaBuild,
  readOrganisations: () => Promise<string>,
): Promise<SchemaBootDecision> {
  if (!stored) {
    return { action: "migrate", reason: `no schema generation recorded; this build is generation ${build.generation}` };
  }
  if (stored.generation > build.generation) {
    return {
      action: "newer-schema",
      reason: `the database is at schema generation ${stored.generation} and this build is generation ${build.generation}; an older build changes nothing`,
    };
  }
  if (stored.generation < build.generation) {
    return {
      action: "migrate",
      reason: `schema generation ${stored.generation} is recorded; this build brings generation ${build.generation}`,
    };
  }
  if (stored.fingerprint !== build.fingerprint) {
    return {
      action: "migrate",
      reason: `generation ${build.generation} is recorded with other migrations (${stored.fingerprint}, this build ${build.fingerprint})`,
    };
  }
  if ((await readOrganisations()) !== stored.organisations) {
    return { action: "migrate", reason: "the set of active organisations changed since the last run" };
  }
  return { action: "current", reason: `schema generation ${build.generation} is current` };
}

/**
 * The stored value for a completed run.
 *
 * The tenant count travels with the code fingerprint rather than in a column of
 * its own so that "is this database up to date" stays a single string
 * comparison, and so a future dimension can be added the same way.
 */
export function schemaStateValue(codeFingerprint: string, activeOrganisations: string): string {
  return `${codeFingerprint}:orgs=${activeOrganisations}`;
}
