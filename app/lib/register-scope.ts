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

import { and, asc, eq, inArray, isNotNull, isNull, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { getDb } from "../../db";
import { boards, contractors, siteGroups, sites, workspaceSections } from "../../db/schema";
import { count } from "drizzle-orm";

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
export function registerScopeFilter(
  column: AnyColumn,
  scope: RegisterScope | RegisterScope[],
): SQL {
  if (Array.isArray(scope)) return registerScopesFilter(column, scope);
  return scope === null || scope === undefined
    ? (isNull(column) as SQL)
    : (eq(column, scope) as SQL);
}

/**
 * THE PREDICATE FOR SEVERAL NAMED REGISTERS AT ONCE — the management surface.
 *
 * ── WHY A SECOND SHAPE EXISTS AT ALL ──────────────────────────────────────
 *
 * Everything above is written for ONE register, because every screen in the
 * product looks at one: the canonical Sites page, an instance's Contractors
 * page. "Manage dashboard data" is the exception the model always implied and
 * never had. It is an INVENTORY of what this organisation holds, so a
 * contractor created inside "North Region Contractors" belongs on it exactly as
 * much as a canonical one — and until this existed it was invisible there,
 * which is the defect the owner photographed: three canonical contractors
 * listed, two custom-section ones missing entirely.
 *
 * ── WHY IT IS STILL ONE FUNCTION, NOT A HAND-ROLLED `or()` ────────────────
 *
 * The `x = NULL` trap does not go away when the list gets longer, it gets
 * worse: `inArray(column, [null, 'sec-abc'])` compiles, runs, and silently
 * drops every canonical row, because SQL `IN` compares with `=`. So the
 * canonical register has to be spelled `IS NULL` here too, and this is still
 * the only place in the codebase allowed to spell it. `registerScopeFilter`
 * above simply forwards an array here, which is what keeps the single entry
 * point — and keeps `tests/w2-scope-model.test.mjs`'s statement scan, which
 * looks for the literal `registerScopeFilter(` in every register statement,
 * meaningful rather than something a wider read can slip past.
 *
 * ── AN EMPTY LIST MATCHES NOTHING, WHICH IS THE WHOLE POINT ───────────────
 *
 * DEFAULT-DENY BY OMISSION, restated for the plural case. An organisation with
 * no Contractors instances asks for "every instance" and gets an empty list;
 * the naive `and(...[])` that would produce is TRUE, i.e. every register in the
 * table, which on this predicate means every row of every tenant's instance
 * this query's other filters did not happen to exclude. `1 = 0` is the honest
 * answer and is spelled identically in SQLite and Postgres.
 *
 * Duplicates and repeated NULLs are harmless — `IN` and `OR` both absorb them —
 * so callers may pass a list built by concatenation without deduplicating it.
 */
export function registerScopesFilter(column: AnyColumn, scopes: RegisterScope[]): SQL {
  const keys = scopes.filter((scope): scope is string => typeof scope === "string");
  const canonical = scopes.some((scope) => scope === null || scope === undefined);

  if (canonical && keys.length === 0) return isNull(column) as SQL;
  if (!canonical && keys.length === 0) return sql`1 = 0`;
  if (!canonical) return inArray(column, keys) as SQL;
  return or(isNull(column), inArray(column, keys)) as SQL;
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
      /* W2C — and whether the whole section is in the Recycle Bin, which is a
         different fact from being archived. See the refusal below. */
      deletedAt: workspaceSections.deletedAt,
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
  /*
   * W2C — A SECTION IN THE RECYCLE BIN, CHECKED FIRST AND SAID DIFFERENTLY.
   *
   * Deleting a section sets `archived_at` as well, so the archived refusal
   * below would already catch this — and would describe it wrongly. "Archived"
   * means somebody took it out of the sidebar and can put it back whenever;
   * this means the section, its register and everything on it are in the bin
   * with a thirty-day countdown running. A caller told the wrong one goes
   * looking in the wrong place.
   *
   * It is also the belt to that brace: if anything ever clears `archived_at`
   * without clearing `deleted_at`, the scope must still refuse.
   */
  if (section.deletedAt) {
    return {
      ok: false,
      status: 404,
      error: "That section is in the recycle bin. Restore it to use its register again.",
    };
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

/**
 * ONE INSTANCE OF A REGISTER, as the management surface needs to describe it.
 *
 * Three facts, and each is used for a different thing, which is why none of
 * them stands in for another:
 *
 *  · `scopeId` is the SCOPE — `boards.key`, the literal value the row's
 *    `board_id` holds. It is what a query filters on and what a record's
 *    provenance is derived FROM.
 *  · `sectionKey` is the LOOKUP KEY a mutation must carry, because
 *    `resolveRegisterScope` resolves a section key and deliberately refuses a
 *    bare board key — see `SCOPE_PARAM`.
 *  · `sectionDisplayName` is for a PERSON to read, and for nothing else. It is
 *    read live on every request so a renamed section relabels its records at
 *    once, and it is never compared, matched or routed on.
 */
export type RegisterInstance = {
  sectionKey: string;
  sectionDisplayName: string;
  scopeId: string;
};

/**
 * EVERY INSTANCE OF ONE REGISTER THAT THIS ORGANISATION OWNS — one query.
 *
 * ── WHY THIS IS A JOIN AND NOT A LOOP ─────────────────────────────────────
 *
 * The obvious implementation is to list the sections and then call
 * `resolveRegisterScope` once per section, which is a second query per section
 * — the N+1 the performance boundary rules out by name, on a screen an owner
 * opens constantly. The join answers "which sections of this template have a
 * board that still exists in this organisation" in one statement, and it
 * answers it with the same three checks `resolveRegisterScope` makes: the
 * organisation comes from the caller's session, the template must be the
 * register being asked about, and an archived section is not offered.
 *
 * The board is INNER JOINED rather than read from `surface_ref` alone, for the
 * reason `resolveRegisterScope` reads it back: a section whose board was purged
 * must not open a scope nothing can furnish. The `scopeId` returned is
 * `boards.key` AS THE DATABASE RETURNED IT, exactly as the single-section
 * resolver returns it — not the `surface_ref` string that was matched against.
 *
 * The organisation filter is on BOTH sides of the join. `boards.key` is unique
 * per organisation and not globally, so joining on the key alone would let a
 * section of this workspace pick up another tenant's board of the same key and
 * hand back a scope that reads that tenant's rows.
 *
 * ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────
 *
 * It returns the REGISTERS, never the rows. Handing the caller a list of scope
 * ids is what lets the rows come back in one `IN` query afterwards; fetching
 * rows per section here is the same N+1 wearing a different hat.
 */
export async function listRegisterInstances(
  db: ScopeDatabase,
  organisationId: string,
  register: RegisterTemplate,
): Promise<RegisterInstance[]> {
  const rows = await db
    .select({
      sectionKey: workspaceSections.key,
      sectionDisplayName: workspaceSections.label,
      scopeId: boards.key,
    })
    .from(workspaceSections)
    .innerJoin(
      boards,
      and(
        eq(boards.key, workspaceSections.surfaceRef),
        eq(boards.organisationId, organisationId),
      ),
    )
    .where(
      and(
        eq(workspaceSections.organisationId, organisationId),
        eq(workspaceSections.template, register),
        isNull(workspaceSections.archivedAt),
        isNotNull(workspaceSections.surfaceRef),
      ),
    )
    .orderBy(asc(workspaceSections.label));

  return rows.map((row) => ({
    sectionKey: row.sectionKey,
    sectionDisplayName: row.sectionDisplayName,
    scopeId: row.scopeId,
  }));
}

/**
 * WHERE ONE RECORD CAME FROM — enough to label it and enough to route a write.
 *
 * The owner's rule, in his words: derive it from the actual register scope id,
 * never from the record's name. Two instances may legitimately hold a
 * contractor called "John Ltd" and the canonical roster may hold a third; the
 * name tells you nothing about which register any of them is in, and the live
 * Preview data proves it — there are two contractors called "test" in one
 * organisation right now, one canonical and one inside a custom section.
 *
 * `sectionKey` is here because a LABEL IS NOT A SECURITY BOUNDARY. The screen
 * prints `sectionDisplayName`; every mutation carries `sectionKey`, which the
 * server re-resolves through `resolveRegisterScope` against the caller's own
 * organisation before it writes anything. The two are produced together so a
 * record can never be shown as belonging to one register and edited in another.
 */
export type RecordProvenance = {
  recordId: string;
  scopeId: RegisterScope;
  scopeType: "canonical" | "section";
  sectionKey: string | null;
  sectionDisplayName: string | null;
  isCustom: boolean;
};

/**
 * WHICH REGISTERS ONE REQUEST IS ASKING ABOUT, when it is asking for several.
 *
 * `?section=<key>` names ONE instance and is what every existing caller sends.
 * `?registers=custom` and `?registers=all` are the management surface, and they
 * exist because "Manage dashboard data" is an INVENTORY rather than a view of
 * one register: it has to list what this organisation holds, wherever it was
 * created. On the live Preview it listed three contractors and silently omitted
 * two that live inside a custom Contractors section — nothing on screen said
 * anything was missing, which is what makes that class of gap so expensive.
 *
 * `custom` is the spelling the manager uses, because the canonical registers
 * are already in the workspace snapshot it draws from and asking for them twice
 * would put two answers to "what is on the canonical register" on one screen.
 * `all` exists so the union can be asked for whole — by a test, or by a caller
 * with no snapshot to hand — rather than being hand-rolled at a call site.
 *
 * An unrecognised value is NOT an aggregate request. It falls through to null,
 * and the route then treats the request as whatever its `section` parameter
 * says — which for `/api/contractors` is a refusal. A typo must never widen a
 * read.
 */
export type RegistersRequest = "custom" | "all" | null;

export function registersRequest(url: URL): RegistersRequest {
  const raw = (url.searchParams.get("registers") ?? "").trim().toLowerCase();
  return raw === "custom" || raw === "all" ? raw : null;
}

/**
 * The scope list an aggregate request means, from the instances it may read.
 *
 * One line, in one place, because the difference between `custom` and `all` is
 * exactly one element and a route that spelled it itself would eventually spell
 * it differently. The canonical register goes FIRST for `all` so a caller that
 * prints the list in order shows the workspace's own register before the
 * sections that were added to it.
 */
export function aggregateScopes(
  request: Exclude<RegistersRequest, null>,
  instances: RegisterInstance[],
): RegisterScope[] {
  const keys = instances.map((instance) => instance.scopeId);
  return request === "all" ? [CANONICAL_REGISTER, ...keys] : keys;
}

/**
 * A provenance stamper, built once per request from the instances above.
 *
 * A closure over a Map rather than a lookup per row: the alternative is a scan
 * of the instance list for every record, which is the in-memory version of the
 * N+1 this whole shape exists to avoid.
 *
 * An unrecognised scope id is reported as a custom record with NO section — an
 * orphan, the state `scopedRegisterRows` exists to prevent. It is deliberately
 * not reported as canonical: a row carrying a board key is not in the canonical
 * register, and saying it was would invite an edit through the canonical door.
 */
export function registerProvenanceReader(instances: RegisterInstance[]) {
  const byScope = new Map(instances.map((instance) => [instance.scopeId, instance]));
  return (recordId: string, scopeId: string | null | undefined): RecordProvenance => {
    if (scopeId === null || scopeId === undefined) {
      return {
        recordId,
        scopeId: CANONICAL_REGISTER,
        scopeType: "canonical",
        sectionKey: null,
        sectionDisplayName: null,
        isCustom: false,
      };
    }
    const instance = byScope.get(scopeId) ?? null;
    return {
      recordId,
      scopeId,
      scopeType: "section",
      sectionKey: instance?.sectionKey ?? null,
      sectionDisplayName: instance?.sectionDisplayName ?? null,
      isCustom: true,
    };
  };
}


/**
 * A DESTROYED REGISTER'S ROWS, RETURNED TO THE CANONICAL ONE.
 *
 * The third option, and the only one that is not a trap.
 *
 *   · ORPHAN them — what happened before this existed. The board goes, the rows
 *     keep its key, and they are then reachable by nothing: the canonical
 *     register filters `board_id IS NULL` and no section resolves to that key
 *     any more. Observed during testing, and the row was not merely invisible —
 *     it still held its name against a unique id, so creating a site of the
 *     same name afterwards answered 409 for a row nobody could see.
 *   · CASCADE-DELETE them — ruled out by name: nothing that exists
 *     independently of a board may be deleted because a menu entry was removed.
 *     A site is real operational data whichever register it sits in, and jobs
 *     reference it.
 *   · REFUSE the purge while rows remain — which reads as the safe option and
 *     is a dead end. `DELETE /api/sites` CLOSES a site rather than removing it;
 *     the product has no hard delete, deliberately, because jobs point at the
 *     record. A Sites section that had ever held one site could then never be
 *     removed at all.
 *
 * So the rows come home — BUT ONLY WHEN THE CALLER ASKS FOR IT. `board_id` goes
 * back to NULL and they appear in the workspace's own register, where a person
 * can see them and decide.
 *
 * The confirmation is not ceremony. This was written to re-home
 * unconditionally, and within one test session it had quietly moved eight
 * fixture sites into the workspace's own register: routine teardown, purging a
 * section, adding rows to the main Sites screen with nobody told. That is a
 * smaller failure than orphaning them and it is still the wrong default,
 * because it moves a register's data on an act the operator described as
 * removing a menu entry. The purge therefore REFUSES first and says what is
 * there — the same shape as its refusals for items and for the bin — and does
 * this only when asked again with `rehome=1`, which is the `confirmDuplicate`
 * idiom this codebase already uses for exactly this kind of second look.
 */
export async function rehomeRegisterRows(
  db: ScopeDatabase,
  organisationId: string,
  boardKey: string,
) {
  const held = await scopedRegisterRows(db, organisationId, boardKey);
  if (held.total === 0) return held;

  for (const table of [sites, contractors, siteGroups]) {
    await db
      .update(table)
      .set({ boardId: CANONICAL_REGISTER })
      .where(and(eq(table.organisationId, organisationId), eq(table.boardId, boardKey)));
  }
  return held;
}

/**
 * WHAT A REGISTER STILL HOLDS, so destroying it cannot orphan anything.
 *
 * The section purge already refuses a register with items on it, and again with
 * items in its bin, and both refusals exist for the same reason: a board
 * destroyed underneath its rows leaves them reachable by nothing. Sites and
 * Contractors instances have exactly that shape and were not covered, because
 * their rows are not board-PLACED — they carry `board_id` directly, which
 * `deleteBoardStructure` does not clear and was never meant to.
 *
 * The failure was observed, not theorised: a Sites instance created during
 * testing was purged with a site in it, and the row survived carrying the key
 * of a board that no longer existed. It was then invisible to every register —
 * the canonical one filters `board_id IS NULL`, and no section resolved to that
 * key any more — while still holding its name against a unique id, so the next
 * attempt to create a site of the same name answered 409 for a row nobody could
 * see.
 *
 * Counted rather than cascaded ON PURPOSE. Deleting the rows here would be the
 * cascade the owner ruled out — "never cascade-delete shared canonical entities
 * merely because a section is permanently removed" — and a site is real
 * operational data whichever register it sits in. The operator empties the
 * register first, deliberately, exactly as they must for a board's items.
 */
export async function scopedRegisterRows(
  db: ScopeDatabase,
  organisationId: string,
  boardKey: string,
) {
  const tally = async (table: typeof sites | typeof contractors | typeof siteGroups) => {
    const [row] = await db
      .select({ total: count() })
      .from(table)
      .where(and(eq(table.organisationId, organisationId), eq(table.boardId, boardKey)));
    return Number(row?.total ?? 0);
  };

  const [siteRows, contractorRows, groupRows] = [
    await tally(sites),
    await tally(contractors),
    await tally(siteGroups),
  ];
  return {
    sites: siteRows,
    contractors: contractorRows,
    groups: groupRows,
    total: siteRows + contractorRows + groupRows,
  };
}
