/**
 * WHICH REGISTER A ROW BELONGS TO — one model, for all four templates.
 *
 * W2 asks that a section created from the Contractors or Sites template be a
 * real, empty, independent instance of that register. That is a DATA question
 * before it is a screen question: the rows have to be told apart in the
 * database, because every other way of telling them apart is a lie the server
 * can be talked out of.
 *
 * ── THE MODEL, AND WHY IT IS NOT A NEW ONE ────────────────────────────────
 *
 * The product already answers "which register does this row belong to" twelve
 * times over: `maintenance_groups`, `maintenance_group_items`,
 * `maintenance_board_columns`, `maintenance_board_cells`,
 * `maintenance_board_options`, `board_views`, `form_configurations`,
 * `board_automations`, `automation_runs`, `item_updates`, `item_activity` and
 * `recycle_bin` all carry `board_id`, holding a key out of `boards`. A Jobs
 * instance and a Store Documentation instance are already scoped that way —
 * their rows are `maintenance_requests` placed on a board by
 * `maintenance_group_items.board_id`.
 *
 * So Sites and Contractors do not need a scope model invented for them. They
 * need the SAME column, because they are the two registers whose rows are not
 * board-placed and so were never given one. `sites.board_id` and
 * `contractors.board_id` hold the key of the board that owns the row, exactly
 * as the other twelve do, and `templateStructure()` is what decides which
 * template a board was built from. One column name, one meaning, four
 * templates.
 *
 * ── WHY NULL IS THE CANONICAL REGISTER ─────────────────────────────────────
 *
 * NULL means "the workspace's own Sites/Contractors screen" — the register that
 * was there before instances existed.
 *
 * It is not an invented sentinel. `builtInSectionBoard("stores")` and
 * `builtInSectionBoard("contractors")` in the sections catalogue ALREADY return
 * `null`, because those two screens genuinely have no board behind them —
 * `SECTION_SURFACES` records `boardKey: null` for both. The column simply
 * persists the answer the product already gives.
 *
 * It is also the only value that makes the migration a no-op. `db/init.ts` is
 * additive: guarded `addColumn`, no rewrite, no backfill. A nullable TEXT
 * column with no default leaves all 31 of the client's real site rows and every
 * contractor row reading NULL, which this module defines as canonical — so
 * every existing row stays exactly where it was, without a single UPDATE
 * touching the client's estate. A sentinel like `'canonical'` would need one,
 * and any write path that had not been taught the sentinel would then insert
 * NULL and drop a row into a register nothing can see.
 *
 * ── THE RULE THAT MAKES NULL SAFE ─────────────────────────────────────────
 *
 * `x = NULL` is never true in SQL, in either dialect. So a scope filter has to
 * be written two ways, and a caller who forgets is the whole risk. That is why
 * `registerScopeFilter` exists and why nothing may hand-roll it: it is the one
 * place that turns a scope into a predicate, and it always produces one.
 *
 * DEFAULT-DENY BY OMISSION. Every scoped function in this codebase defaults its
 * scope to `CANONICAL_REGISTER`. Omitting the argument therefore selects the
 * canonical register — `board_id IS NULL` — and never "everything". There is no
 * query anywhere that reads across scopes, and no way to write one by
 * forgetting an argument. A caller who wants an instance's rows has to name the
 * instance, and naming it goes through `resolveRegisterScope` below.
 *
 * ── HOW A SCOPE IS RESOLVED FROM A REQUEST ────────────────────────────────
 *
 * The owner's constraint, in his words: "Scoping must be server/database-side —
 * no fetch-all-then-filter-in-React. No display-name-based isolation. No
 * route-string-based isolation. No fallback to maintenance."
 *
 * `resolveRegisterScope` is what honours it. The request carries a SECTION KEY,
 * which is a lookup key and nothing more — the same standing an id has. What
 * comes back as the scope is a value read out of the `boards` row:
 *
 *   1. the organisation comes from the SESSION (`scopedDb`), never the request;
 *   2. the section is looked up in `workspace_sections` WITHIN that
 *      organisation, and must not be archived;
 *   3. the section's `template` must be the register this endpoint serves — a
 *      Jobs section has no Sites register and asking for one is a 404, not an
 *      empty list;
 *   4. `surface_ref` — the board key the sections API wrote at create time — is
 *      resolved against `boards` WITHIN that organisation;
 *   5. the scope is `boards.key` AS THE DATABASE RETURNED IT.
 *
 * A section key that does not resolve is a REFUSAL. It never falls back to the
 * canonical register and never falls back to maintenance: a silent substitution
 * is how `boardIdFrom` used to answer every unknown key with the job board, and
 * it is the defect W02-06 was written to close. Absent parameter — no `section`
 * at all — is the canonical register, which is what every existing caller means
 * and what every existing caller will keep getting.
 *
 * Nothing here consults a display name, a slug, a label or a URL path segment.
 * Renaming a section cannot move a row, because `renameBoard` deliberately
 * leaves `boards.key` alone; two sections may carry the same label and still
 * hold different registers.
 */

import { and, eq, isNull, type AnyColumn, type SQL } from "drizzle-orm";
import type { getDb } from "../../db";
import { boards, workspaceSections } from "../../db/schema";

type ScopeDatabase = Awaited<ReturnType<typeof getDb>>;

/**
 * The board key that owns a register row, or NULL for the canonical register.
 *
 * A string here is always a `boards.key` — `sec-<12hex>` for an instance, or a
 * built-in key. It is never a section key, never a label and never a slug.
 */
export type RegisterScope = string | null;

/** The workspace's own Sites/Contractors register. See the header. */
export const CANONICAL_REGISTER: RegisterScope = null;

/**
 * The query parameter a caller names an instance with.
 *
 * `section`, not `board`, and that is deliberate. A board key names a register
 * directly; a section key names the thing the owner created, and the section
 * row is where `template` lives — which is the check in step 3 above. Accepting
 * a bare board key would skip it, and a Sites endpoint pointed at a Jobs board
 * would happily write sites into a Jobs register's scope.
 */
export const SCOPE_PARAM = "section";

/**
 * The predicate for one scope, in SQL. The ONLY place a scope becomes a filter.
 *
 * `IS NULL` for the canonical register, `= <key>` for an instance. Hand-rolling
 * `eq(column, scope)` is the bug this function exists to make impossible: with
 * `scope` null that compiles, runs, matches nothing, and an instance register
 * silently reads empty while the canonical one silently reads everything.
 *
 * Both spellings are identical in SQLite and Postgres, so one call serves the
 * D1 path and the Supabase path — the constraint `db/sqlite-to-postgres.ts`
 * puts on every statement in this codebase. `board_id` is TEXT in both and is
 * not in `BOOLEAN_COLUMNS`, so no coercion applies to it.
 */
export function registerScopeFilter(column: AnyColumn, scope: RegisterScope): SQL {
  return scope === null || scope === undefined
    ? (isNull(column) as SQL)
    : (eq(column, scope) as SQL);
}

/** Which register an endpoint serves. Matches the template keys in the catalogue. */
export type RegisterTemplate = "sites" | "contractors";

export type ScopeResolution =
  | { ok: true; scope: RegisterScope; sectionKey: string | null }
  | { ok: false; status: number; error: string };

/**
 * Whether a caller asked for an instance at all.
 *
 * Trimmed and length-capped before it ever reaches a query. A section key is at
 * most `section:` plus a 48-character slug (`MAX_SLUG` in the sections
 * catalogue), so anything longer is not one and is not worth a round trip.
 */
export function scopeRequestKey(url: URL): string | null {
  const raw = url.searchParams.get(SCOPE_PARAM);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64) return null;
  return trimmed;
}

/**
 * The scope a request may read and write, resolved from the session and the
 * database — never from the request's own strings.
 *
 * See the header for the five steps and why each one is there. The refusals are
 * deliberately distinguishable: "no such section" and "that section is a Jobs
 * board" are different facts about the workspace and a caller is entitled to be
 * told which one it hit, exactly as `resolveContractorLink` distinguishes
 * `unknown` from `ambiguous`.
 */
export async function resolveRegisterScope(
  db: ScopeDatabase,
  organisationId: string,
  url: URL,
  register: RegisterTemplate,
): Promise<ScopeResolution> {
  const sectionKey = scopeRequestKey(url);

  /* No parameter is the canonical register. Every caller that predates
     instances lands here, unchanged, and reads exactly the rows it read
     before — because every existing row carries NULL. */
  if (!sectionKey) return { ok: true, scope: CANONICAL_REGISTER, sectionKey: null };

  const [section] = await db
    .select({
      key: workspaceSections.key,
      template: workspaceSections.template,
      surfaceRef: workspaceSections.surfaceRef,
      archivedAt: workspaceSections.archivedAt,
    })
    .from(workspaceSections)
    .where(
      and(
        eq(workspaceSections.organisationId, organisationId),
        eq(workspaceSections.key, sectionKey),
      ),
    )
    .limit(1);

  /* A REFUSAL, NOT THE CANONICAL REGISTER. A section key that names nothing in
     the caller's own organisation is either a stale link or a probe, and
     answering it with the workspace's real estate is the silent substitution
     this whole model exists to prevent. */
  if (!section) {
    return { ok: false, status: 404, error: "That section does not exist in this workspace." };
  }
  if (section.archivedAt) {
    return { ok: false, status: 404, error: "That section has been archived." };
  }

  /*
   * The template is the register's IDENTITY, and it is checked before the
   * board. A section created from Jobs has a register, and it is not this one;
   * without this check a Sites write aimed at a Jobs board would be accepted,
   * land in that board's scope, and be invisible to every screen for ever.
   *
   * NULL template means a legacy section — a second door onto one of the
   * product's own screens, created before templates existed. It owns no
   * register of its own, so it has no scope to offer.
   */
  if (section.template !== register) {
    return {
      ok: false,
      status: 404,
      error:
        section.template === null
          ? "That section is a second door onto a built-in screen, not a register of its own."
          : `That section holds a ${section.template} register, not a ${register} one.`,
    };
  }

  const boardKey = (section.surfaceRef ?? "").trim();
  if (!boardKey) {
    return { ok: false, status: 409, error: "That section has no register of its own." };
  }

  /*
   * The board is read back rather than trusted. `surface_ref` is written by the
   * sections API and is not caller-supplied, but reading it proves the board
   * still exists in THIS organisation — a section whose board was purged must
   * refuse rather than open a scope nothing can furnish.
   */
  const [board] = await db
    .select({ key: boards.key })
    .from(boards)
    .where(and(eq(boards.organisationId, organisationId), eq(boards.key, boardKey)))
    .limit(1);

  if (!board) {
    return { ok: false, status: 404, error: "That section's register no longer exists." };
  }

  /* `board.key`, not `boardKey` and not the URL — the value the database
     returned for a row in the caller's own organisation. */
  return { ok: true, scope: board.key, sectionKey: section.key };
}

/** The refusal as a Response, for the routes that want one line. */
export function scopeRefusal(resolution: ScopeResolution): Response | null {
  return resolution.ok
    ? null
    : Response.json({ error: resolution.error }, { status: resolution.status });
}
