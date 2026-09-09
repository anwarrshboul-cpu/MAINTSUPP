/**
 * ONE INTAKE. Five doors.
 *
 * ── WHAT THIS EXISTS TO END ────────────────────────────────────────────────
 *
 * Five server paths minted a `maintenance_requests` row, and every one of them
 * had written its own answer to the same eight questions:
 *
 *   1. `POST /api/maintenance`                   session + `board.edit`
 *   2. `POST /api/forms/[token]/submit`          share token
 *   3. `POST /api/report-job`                    anonymous, the public website
 *   4. `POST /api/board/items`                   session + `board.edit`
 *   5. `createBoardItem()` (board-mutations)     session AND the automation engine
 *
 * Three of them carried a near-copy of `requestTitle`, two of which split on
 * `[.!?\n]` at 72 characters and one on `\n` at 80. Three allocated an id by
 * inserting on top of a SQL `MAX` with no conflict retry, so two people
 * submitting at the same second raced for one primary key and the loser got a
 * bare 503. Two wrote no placement at all and leaned on `ensureBoardState` to
 * file the row lazily on the next board load — which returns early for
 * `store-documentation` and for every generated register, so "later" could mean
 * never. Two canonicalised a priority by VALUE only while the form that feeds
 * them shows LABELS, so renaming "Urgent" silently bought every new urgent job
 * the 120-hour clock. One set no `tier`, no `dueAt` and no `nextUpdateAt` at
 * all, so items raised there were invisible to every SLA meter in the product.
 *
 * None of that is a difference between the doors. It is the same decision made
 * five times, four of them wrong in at least one respect.
 *
 * ── WHAT STAYS PER-PATH, AND WHY ───────────────────────────────────────────
 *
 * AUTHENTICATION AND AUTHORISATION ARE NOT UNIFIED and must never be. A share
 * token authorises writing to ONE register in ONE workspace; a session with
 * `board.edit` authorises writing to any board in the caller's own workspace;
 * the public form authorises nothing and is pinned to the primary tenant. Those
 * are genuinely different questions with genuinely different answers, and a
 * helper that took "the caller" as a parameter would be a helper that could be
 * talked into the wrong one. Each route resolves its own scope and hands this
 * module an organisation it has already earned the right to write to.
 *
 * So does VALIDATION OF THE QUESTION SET. The share-link route decides what was
 * asked from a stored form configuration, with `showIf` conditionals and a
 * mass-assignment filter that discards any answer to a question the form did
 * not ask. That filter is the strongest single behaviour in the set and it is
 * meaningless anywhere else — the other four doors have fixed fields.
 *
 * Everything after that point is one implementation, here.
 */

import { and, asc, eq, isNull, like, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  activityLog,
  maintenanceGroupItems,
  maintenanceGroups,
  maintenanceRequests,
  recycleBin,
  siteAliases,
  sites,
} from "../../db/schema";
import { jobReferenceNumber, nextJobReferenceNumber } from "./job-reference";
import { listOptionValues } from "./options-repository";
import { canonicalOptionValue, priorityRule } from "./priority-rules";
import {
  CANONICAL_REGISTER,
  registerScopeFilter,
  type RegisterScope,
} from "./register-scope";
import { unassignedSiteId } from "./site-reference";
import { normaliseSiteName } from "./sites-repository";
import { statusForStage } from "./stage-status";
import { submissionTitle } from "./submission-title";
import type { RequestStage } from "./types";

export type SubmissionDatabase = Awaited<ReturnType<typeof getDb>>;

type RequestRow = typeof maintenanceRequests.$inferSelect;
type PlacementRow = typeof maintenanceGroupItems.$inferSelect;

/* ── 1. What a job is called ──────────────────────────────────
 *
 * The rule itself is in `./submission-title.ts`, which imports NOTHING — the
 * raise-a-job dialog previews the derived title before you submit, and it is a
 * client component, so it has to be able to import the same function this
 * module calls without dragging drizzle and the schema into the browser bundle.
 * Re-exported here so a server caller that already has this module need not
 * know that. See that module's header for what the three old copies disagreed
 * about.
 */
export {
  SUBMISSION_TITLE_FALLBACK,
  SUBMISSION_TITLE_MAX,
  renderTitleTemplate,
  submissionTitle,
} from "./submission-title";

/* ── 2. Canonicalising an answer to an option registry value ───────────────
 *
 * TWO RESOLVERS EXISTED AND THE WEAKER ONE WAS ON THE PATHS THAT NEEDED IT
 * MOST.
 *
 * `configuredValue` (options-repository) matched the submitted string against
 * the option's stable VALUE and nothing else. `canonicalOptionValue`
 * (priority-rules) matches the value first and then the current LABEL.
 *
 * Every form in the product shows labels. So on `/api/maintenance` and
 * `/api/report-job`, which used `configuredValue`, renaming a priority's label
 * meant every subsequent submission arrived carrying a string the resolver did
 * not recognise and fell back to the workspace default — and because
 * `priorityRule` keys on the value, the fallback silently bought a 120-hour
 * clock for work somebody had marked urgent.
 *
 * One resolver, and it is the forgiving one. Falling back is still the last
 * resort rather than the second: a label that matches nothing at all — a
 * hostile POST, an option deleted mid-flight — must not become a stored value
 * every dashboard groups by.
 */
export async function canonicalSubmissionOption(
  db: SubmissionDatabase,
  organisationId: string,
  key: string,
  submitted: unknown,
  fallback: string,
): Promise<string> {
  const options = await listOptionValues(db, organisationId, key);
  const text = typeof submitted === "string" ? submitted.trim() : "";
  return canonicalOptionValue(options, text, fallback);
}

/* ── 3. Which site a submission is about ───────────────────────────────────
 *
 * FOUR STRATEGIES BECAME ONE, and the fuzzy one stopped being a privilege of
 * the caller least able to verify itself.
 *
 * What the five doors did:
 *
 *   /api/maintenance      exact name, or refuse with 400
 *   /api/forms/…/submit   exact name, or refuse — but only when asked at all
 *   /api/report-job       exact -> case-insensitive -> alias, never refuses
 *   /api/board/items      by id only, checked against the organisation
 *   createBoardItem       none; always `unassignedSiteId()`
 *
 * The alias step is what makes a renamed store still findable by the name it
 * carried last year, and it lived ONLY on the anonymous website form. The two
 * authenticated paths — which can show the caller a picker and let them correct
 * a mistake — were the strict ones. That is backwards, and it is why an
 * operator typing a store's old name into "raise a job" got "Choose a site from
 * this client workspace" while a stranger typing the same string got a match.
 *
 * So the LADDER is one ladder for everybody: exact, then case-insensitive, then
 * this organisation's own aliases. WHAT A CALLER DOES WHEN THE LADDER RUNS OUT
 * stays its own decision, because that genuinely differs: an authenticated
 * route with a picker in front of it refuses, so somebody standing there can
 * correct the name; the anonymous website form files the report with no site
 * and keeps the words the reporter typed, because turning away a shop with
 * water coming through the ceiling over a spelling is the worse failure.
 *
 * ── THE REGISTER SCOPE IS A SECURITY BOUNDARY ON THE PUBLIC DOORS ─────────
 *
 * `scope` defaults to `CANONICAL_REGISTER`, matching every other scoped read in
 * this codebase (see `app/lib/register-scope.ts`). An inbound caller with no
 * session names a location as free text and cannot name a register — they have
 * not seen one — so the only register they can mean is the workspace's own.
 * Unscoped, a submitted name matching a site inside somebody's custom Sites
 * section attached the submission to that private register. A caller that HAS
 * resolved a board of its own passes that board's scope explicitly.
 */
export type ResolvedSubmissionSite = { id: string; name: string } | null;

export async function resolveSubmissionSite(
  db: SubmissionDatabase,
  input: {
    organisationId: string;
    /** A site id the caller already holds — verified, never trusted. */
    siteId?: string | null;
    /** The name a reporter typed. Only consulted when no id was given. */
    location?: string | null;
    scope?: RegisterScope;
  },
): Promise<ResolvedSubmissionSite> {
  const scope = input.scope === undefined ? CANONICAL_REGISTER : input.scope;
  const siteId = (input.siteId ?? "").trim();

  /*
   * AN ID STILL HAS TO BE PROVED. `/api/board/items` length-checked it and then
   * looked it up, which was right; nothing else may skip the lookup, because a
   * caller supplying an id from another tenant would otherwise have every
   * site-joined report in the product reading across a tenancy boundary.
   *
   * The register scope is deliberately NOT applied to an id lookup: a caller
   * holding an id got it from a screen that showed it to them, and that screen
   * may legitimately be an instance's own site register. The organisation
   * filter is what stops it crossing a tenant.
   */
  if (siteId) {
    const [row] = await db
      .select({ id: sites.id, name: sites.name })
      .from(sites)
      .where(and(eq(sites.id, siteId), eq(sites.organisationId, input.organisationId)))
      .limit(1);
    return row ?? null;
  }

  const location = (input.location ?? "").trim();
  if (!location) return null;

  const [exact] = await db
    .select({ id: sites.id, name: sites.name })
    .from(sites)
    .where(
      and(
        eq(sites.name, location),
        eq(sites.organisationId, input.organisationId),
        registerScopeFilter(sites.boardId, scope),
      ),
    )
    .limit(1);
  if (exact) return exact;

  const [loose] = await db
    .select({ id: sites.id, name: sites.name })
    .from(sites)
    .where(
      and(
        eq(sites.organisationId, input.organisationId),
        registerScopeFilter(sites.boardId, scope),
        sql`lower(${sites.name}) = lower(${location})`,
      ),
    )
    .limit(1);
  if (loose) return loose;

  /*
   * A renamed site keeps its previous canonical name as an organisation-scoped
   * alias. `site_aliases` is unique on (organisation_id, normalised), so this
   * resolves to at most one site — and joining on `sites.organisationId` as
   * well as the alias's own means a submitted string can never reach another
   * tenant's row. The scope filter is applied to the SITE the alias points at,
   * because an alias is only a way of spelling a site and following one into an
   * instance would reach exactly the row the scope exists to protect.
   */
  const normalised = normaliseSiteName(location);
  if (!normalised) return null;
  const [alias] = await db
    .select({ id: sites.id, name: sites.name })
    .from(siteAliases)
    .innerJoin(sites, eq(sites.id, siteAliases.siteId))
    .where(
      and(
        eq(siteAliases.organisationId, input.organisationId),
        eq(siteAliases.normalised, normalised),
        eq(sites.organisationId, input.organisationId),
        registerScopeFilter(sites.boardId, scope),
      ),
    )
    .limit(1);
  return alias ?? null;
}

/* ── 4. Where the row lands ────────────────────────────────────────────────
 *
 * PLACEMENT IS PART OF CREATION.
 *
 * `maintenance_requests` carries no board id: a row's board is decided by its
 * `maintenance_group_items` placement (`boardKeyForRequest`). Two of the five
 * doors wrote none and relied on `ensureBoardState` in `/api/board` to file
 * every unplaced work order into `groups[0]` of whichever board somebody
 * happened to load next.
 *
 * That is not a lazy version of the same answer. `ensureBoardState` returns
 * early for `store-documentation` and for every generated register BEFORE the
 * filing loop, so on a workspace whose only board is a section's register the
 * row is never filed at all; and where it does run, "which board" is decided by
 * who opened what first rather than by where the job was raised.
 *
 * Resolving it here makes it deterministic and makes it survive nobody ever
 * loading a board.
 */
export type SubmissionGroup = {
  id: string;
  stageKey: RequestStage | null;
} | null;

/**
 * The group a new row belongs in on `boardId`.
 *
 * `preferredGroupId` wins when it names a live group ON THIS BOARD — the share
 * link's "Group for answers" setting, and the board's own "+ New item". Failing
 * that, the group whose `stage_key` matches the stage being written, which is
 * how a job raised as `Booked` lands in the Booked lane. Failing that, the
 * board's first lane — deliberately its first lane and not the literal
 * "Incoming", because a generated register has no group by that name and would
 * otherwise have nowhere to file.
 */
export async function resolveSubmissionGroup(
  db: SubmissionDatabase,
  input: {
    organisationId: string;
    boardId: string;
    preferredGroupId?: string | null;
    stage?: RequestStage | null;
  },
): Promise<SubmissionGroup> {
  const groups = (
    await db
      .select({
        id: maintenanceGroups.id,
        stageKey: maintenanceGroups.stageKey,
        archived: maintenanceGroups.archived,
      })
      .from(maintenanceGroups)
      .where(
        and(
          eq(maintenanceGroups.organisationId, input.organisationId),
          eq(maintenanceGroups.boardId, input.boardId),
          isNull(maintenanceGroups.deletedAt),
        ),
      )
      .orderBy(asc(maintenanceGroups.position))
  ).filter((group) => !group.archived);
  if (!groups.length) return null;

  const preferred = (input.preferredGroupId ?? "").trim();
  const chosen =
    (preferred ? groups.find((group) => group.id === preferred) : undefined) ??
    (input.stage ? groups.find((group) => group.stageKey === input.stage) : undefined) ??
    groups[0];
  return chosen
    ? { id: chosen.id, stageKey: (chosen.stageKey as RequestStage | null) ?? null }
    : null;
}

/** The next free position at the foot of a group. */
async function nextPosition(db: SubmissionDatabase, organisationId: string, groupId: string) {
  const [tail] = await db
    .select({
      maxPosition: sql<number>`COALESCE(MAX(${maintenanceGroupItems.position}), -1)`,
    })
    .from(maintenanceGroupItems)
    .where(
      and(
        eq(maintenanceGroupItems.organisationId, organisationId),
        eq(maintenanceGroupItems.groupId, groupId),
      ),
    );
  return Number(tail?.maxPosition ?? -1) + 1;
}

/* ── 5. The identifier ─────────────────────────────────────────────────────
 *
 * ONE ALLOCATOR. It used to be two, and the weaker one was on three doors.
 *
 * Paths 1, 2 and 3 each read `max(cast(substr(id, 4) as integer))` and inserted
 * on top of it, with no conflict handling of any kind. Two submissions in the
 * same second computed the same number, the second insert lost the primary key,
 * and the route's catch turned a lost race into "the maintenance database is
 * being prepared" — a 503 telling the browser to retry something a retry cannot
 * fix, on the one operation a person cannot work around.
 *
 * The SQL `MAX` was also a deployed-only outage waiting to happen. A reference
 * that is not `MN-<digits>` reaches the cast, and the dialects disagree:
 * SQLite yields 0 silently, Postgres raises `22P02 invalid input syntax`. An
 * imported estate is exactly where a non-`MN-` id turns up, and the throw
 * happens before any insert, so nobody could raise a job at all.
 *
 * `createBoardItem` had already solved both, in `board-mutations.ts`. This is
 * that solution, moved here so all five doors share it rather than one door
 * owning it. `tests/audit-s4-atomic-ids.test.mjs` pins its shape and now pins
 * it here.
 */

/**
 * How many consecutive ids the allocator will try before giving up.
 *
 * `nextJobNumber` reads a MAX rather than reserving from an atomic counter, so
 * simultaneous creates compute the same number and every insert after the first
 * loses the primary key. Rather than let that surface as a 503, the insert uses
 * `ON CONFLICT DO NOTHING` and walks to the next number when the row it wanted
 * was taken — so a burst of creates fans out across consecutive slots. Eight
 * covers far more simultaneous creators than a board ever has.
 */
export const MAX_ITEM_ID_ATTEMPTS = 8;

/**
 * The next `MN-…` number.
 *
 * Stage 23 — DELIBERATELY UNFILTERED. Do not add `isNull(deletedAt)`. A job
 * sitting in the recycle bin still owns its id; excluding binned rows would
 * hand the same reference to a new job, and the collision would only surface
 * when somebody restored the old one — the worst possible moment.
 *
 * PRE-W14 — AND A JOB'S REFERENCE OUTLIVES THE JOB ROW.
 *
 * The `MAX` used to be taken over `maintenance_requests` alone, which is only
 * the table the reference is a PRIMARY KEY *of*. It is also the primary key of
 * `maintenance_group_items` and half of the unique key of `recycle_bin`, and a
 * row in either can outlive the request it names — a purge that removed the
 * request and left the placement, a bin entry whose job was later hard-deleted.
 * When that happens the MAX drops back below a reference that is still spoken
 * for, the allocator re-issues it, and the insert that collides is not the one
 * the retry below guards. Both were observed on the dev estate:
 * `maintenance_requests` topped out at MN-1157 while placements held MN-1162,
 * so no job could be created on the board at all until the leftovers were
 * removed by hand.
 *
 * So the floor is the highest reference ANY of those tables still holds.
 *
 * THE MAX IS TAKEN IN JAVASCRIPT, AND THAT IS NOT A PREFERENCE. Guarding the
 * cast in SQL needs an all-digits test and the obvious ones are not portable:
 * `~` is Postgres-only, `GLOB` is SQLite-only, and two-argument `trim(x, chars)`
 * means different things in each. Parsing in JS instead reuses
 * `jobReferenceNumber`, which is already strict, already tested, and already
 * the single definition of what a reference looks like.
 */
export async function nextJobNumber(db: SubmissionDatabase, organisationId: string) {
  const highest = (values: Array<{ reference: string | null }>) => {
    let top: number | null = null;
    for (const row of values) {
      const number = jobReferenceNumber(row.reference);
      if (number !== null && (top === null || number > top)) top = number;
    }
    return top;
  };

  const requestRows = await db
    .select({ reference: maintenanceRequests.id })
    .from(maintenanceRequests)
    .where(
      and(
        eq(maintenanceRequests.organisationId, organisationId),
        like(maintenanceRequests.id, "MN-%"),
      ),
    );

  const placementRows = await db
    .select({ reference: maintenanceGroupItems.requestId })
    .from(maintenanceGroupItems)
    .where(
      and(
        eq(maintenanceGroupItems.organisationId, organisationId),
        like(maintenanceGroupItems.requestId, "MN-%"),
      ),
    );

  const binRows = await db
    .select({ reference: recycleBin.entityId })
    .from(recycleBin)
    .where(
      and(
        eq(recycleBin.organisationId, organisationId),
        eq(recycleBin.entityType, "job"),
        like(recycleBin.entityId, "MN-%"),
      ),
    );

  /* The arithmetic lives in ./job-reference.ts so a test can RUN it; this
     function is only the three reads that feed it. */
  return nextJobReferenceNumber([
    highest(requestRows),
    highest(placementRows),
    highest(binRows),
  ]);
}

export type AllocatedSubmission = {
  request: RequestRow;
  placement: PlacementRow | null;
};

/**
 * Insert the row and its placement together, walking past a lost id race.
 *
 * `base` is read once; each retry tries `base + attempt` rather than re-reading
 * the MAX, because a re-read can still see the losing value before the winner's
 * row is visible and hand back the same number again. Walking a fixed offset
 * means every attempt targets a definitively different id, so N simultaneous
 * creates fan out across N consecutive slots instead of all queuing behind one.
 *
 * A taken id is detected with `onConflictDoNothing().returning()` — the conflict
 * becomes an empty result, never an exception — because that is how every other
 * writer in this codebase treats a lost insert race, and because the D1 adapters
 * do not guarantee a typed constraint error that could be told apart from a real
 * failure.
 *
 * THE PLACEMENT IS PART OF THE ALLOCATION, not a step after it. The reference is
 * a key in more than one table, and a create is only safe once the row AND its
 * placement are both down. Inserting the request, declaring victory, and
 * discovering the placement was taken is exactly how `create_item` came to
 * answer a bare 503.
 *
 * THE CATCH IS A DIFFERENT CASE ENTIRELY. A conflict is an empty result and
 * means "walk on"; anything that THROWS is a real failure — a lost connection, a
 * constraint this insert did not name — and for that the request row is already
 * committed and has no placement. The board route files an unplaced row into the
 * default board's first group, so letting the error out on its own would put a
 * job on the JOB BOARD belonging to nobody. Six appeared that way while this was
 * first built, which is why `stage-two-section-registers.test.mjs` pins these
 * three lines. Undo the row, then rethrow the ORIGINAL error: the caller needs
 * the real cause, not "could not allocate a job id".
 */
export async function allocateSubmission(
  db: SubmissionDatabase,
  input: {
    organisationId: string;
    boardId: string;
    /** Null means "write no placement" — a caller whose board has no groups. */
    groupId: string | null;
    position?: number;
    /** Everything the row carries except its id. */
    values: Record<string, unknown>;
  },
): Promise<AllocatedSubmission> {
  const base = await nextJobNumber(db, input.organisationId);
  const position =
    input.position ??
    (input.groupId ? await nextPosition(db, input.organisationId, input.groupId) : 0);

  let created: RequestRow | undefined;
  let placed: PlacementRow | undefined;
  for (let attempt = 0; attempt < MAX_ITEM_ID_ATTEMPTS; attempt++) {
    const id = `MN-${base + attempt}`;
    const [row] = await db
      .insert(maintenanceRequests)
      .values({ id, organisationId: input.organisationId, ...input.values } as never)
      .onConflictDoNothing()
      .returning();
    if (!row) continue;

    if (!input.groupId) {
      created = row;
      break;
    }

    let placement: PlacementRow | undefined;
    try {
      const rows = await db
        .insert(maintenanceGroupItems)
        .values({
          requestId: id,
          organisationId: input.organisationId,
          boardId: input.boardId,
          groupId: input.groupId,
          position,
        })
        .onConflictDoNothing()
        .returning();
      placement = rows[0];
    } catch (error) {
      await db
        .delete(maintenanceRequests)
        .where(
          and(
            eq(maintenanceRequests.id, id),
            eq(maintenanceRequests.organisationId, input.organisationId),
          ),
        )
        .catch(() => undefined);
      throw error;
    }

    if (placement) {
      created = row;
      placed = placement;
      break;
    }

    /*
     * The reference was free in `maintenance_requests` and taken in the
     * placements table. Undo the row we just made and walk on — leaving it
     * would strand an unplaced row, which the board files onto the default
     * board belonging to nobody. Best-effort, as above.
     */
    await db
      .delete(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.id, id),
          eq(maintenanceRequests.organisationId, input.organisationId),
        ),
      )
      .catch(() => undefined);
  }

  if (!created || (input.groupId && !placed)) {
    throw new Error("Could not allocate a job id; too many simultaneous creates.");
  }
  return { request: created, placement: placed ?? null };
}

/* ── 6. The whole submission ───────────────────────────────────────────────*/

export type SubmissionActor = {
  email: string | null;
  displayName: string | null;
};

export type CreateSubmissionInput = {
  organisationId: string;
  /** The register the job is raised on. Decides placement and the group set. */
  boardId: string;
  /** Null for the two anonymous doors — nobody signed in, so nobody is credited. */
  actor?: SubmissionActor | null;
  /** "Portal form" / "Website form" / "Shared form" / "board" / "Manual". */
  source: string;

  explicitTitle?: string | null;
  titleTemplate?: string | null;
  description: string;
  location?: string;
  requester?: string;
  contact?: string;
  category?: string;

  /** Raw answers. Canonicalised against the organisation's registry here. */
  priority?: unknown;
  engineer?: unknown;
  /** Used when the registry has no active values at all. */
  priorityFallback?: string;
  engineerFallback?: string;

  siteId?: string | null;
  requestedAt?: string | null;
  preferredGroupId?: string | null;
  /**
   * The stage this door raises jobs at when no group was named — "Incoming" for
   * every current caller. It picks the LANE as well as the column value, so a
   * job raised as Incoming lands in the Incoming lane rather than in whatever
   * lane happens to sit first. When a group IS named, the group wins: a lane
   * and the stage on the rows in it must not be able to disagree.
   */
  stage?: RequestStage | null;
  parentId?: string | null;
  publicUploadTokenHash?: string | null;
  publicUploadTokenExpiresAt?: string | null;

  /**
   * Columns this door owns that the others do not — the duplicate path's
   * inherited fields, a board create's free-text columns. Applied LAST, so a
   * caller can override a derived value it genuinely knows better.
   */
  overrides?: Record<string, unknown>;

  /**
   * Extra keys for the audit row's `detail`, merged over the standard ones.
   *
   * The share-link route records which FORM a submission came through, which
   * nothing else can know and which is the only way to answer "where did these
   * forty jobs come from" after a link has been regenerated. Kept as an
   * explicit hook rather than letting each door write its own audit row,
   * because two doors writing the audit differently is how `activity_log` and
   * `item_activity` came to hold half the story each.
   */
  activityDetail?: Record<string, unknown>;
};

export type CreatedSubmission = {
  request: RequestRow;
  placement: PlacementRow | null;
  group: SubmissionGroup;
  /** The canonical values actually written, so a caller need not re-derive them. */
  priority: string;
  engineer: string;
  stage: RequestStage;
  /**
   * What to call this job to a human.
   *
   * `reference` is NULL on four of the five doors — only the board's own create
   * allocates an `MS-yyyy-nnnn` — and `/api/maintenance` put `created.reference`
   * straight into the operations email, so every alert it has ever sent had the
   * subject "New job — <site>" with no job in it. Every screen in the product
   * already renders `reference ?? id`; this is that same rule, said once, for
   * the surfaces that are not screens.
   */
  displayReference: string;
};

/**
 * Create one work order, with its placement, from any door.
 *
 * The caller has already decided that it is allowed to write to
 * `organisationId`. Everything after that — the title, the canonical option
 * values, the SLA, the stage and its status chip, the id, the placement and the
 * audit row — is decided here so that five doors cannot answer it five ways.
 */
export async function createSubmission(
  db: SubmissionDatabase,
  input: CreateSubmissionInput,
): Promise<CreatedSubmission> {
  const priority = await canonicalSubmissionOption(
    db,
    input.organisationId,
    "priority",
    input.priority,
    input.priorityFallback ?? "Medium",
  );
  /*
   * `engineer` is NOT NULL on the board. An unanswered question falls back to
   * "Other", which is a real label in the Engineer Required option set rather
   * than an empty chip the board cannot draw.
   */
  const engineer = await canonicalSubmissionOption(
    db,
    input.organisationId,
    "engineer_required",
    input.engineer,
    input.engineerFallback ?? "Other",
  );

  /*
   * The group decides the STAGE, and the stage decides the status chip.
   *
   * Only `createBoardItem` did this. The share-link route routed the stage by
   * the configured group and then pinned the status to "Pending Approval"
   * regardless, so a form configured to file into "Completed" produced a job in
   * the Completed lane wearing the Pending Approval chip. `/api/board/items`
   * hard-coded stage "Incoming" even when the caller named a group whose
   * `stage_key` was something else. One map, `statusForStage`, read once.
   */
  const desiredStage: RequestStage = input.stage ?? "Incoming";
  const group = await resolveSubmissionGroup(db, {
    organisationId: input.organisationId,
    boardId: input.boardId,
    preferredGroupId: input.preferredGroupId,
    stage: desiredStage,
  });
  const stage: RequestStage = group?.stageKey ?? desiredStage;

  /*
   * The SLA clock and the tier come from `priorityRule`, keyed on the canonical
   * VALUE — see app/lib/priority-rules.ts for why label-string comparisons had
   * to go before labels became editable. `/api/board/items` set NO tier, NO
   * dueAt and NO nextUpdateAt, so every item raised from the board was invisible
   * to the overdue meter, the SLA report and the "needs an update" tray.
   */
  const rule = priorityRule(priority);
  const now = Date.now();
  const dueAt = new Date(now + rule.dueHours * 60 * 60 * 1000).toISOString();

  const parsedRequested = input.requestedAt ? new Date(input.requestedAt) : null;
  const requestedAt =
    parsedRequested && !Number.isNaN(parsedRequested.getTime())
      ? parsedRequested.toISOString()
      : new Date(now).toISOString();

  const location = input.location ?? "";
  const title = submissionTitle({
    explicit: input.explicitTitle,
    template: input.titleTemplate,
    templateValues: {
      site: location,
      location,
      category: input.category ?? "",
      priority,
      engineer,
      requester: input.requester ?? "",
      contact: input.contact ?? "",
      source: input.source,
    },
    description: input.description,
  });

  const values: Record<string, unknown> = {
    /*
     * No site, said as no site — in the strongest way the database underneath
     * can express. `site_id` is still NOT NULL on an existing SQLite database
     * and cannot be relaxed in place, so `unassignedSiteId()` returns NULL where
     * the column allows one and the long-standing sentinel where it does not.
     * A literal `null` written on the SQLite path raises `NOT NULL constraint
     * failed` and takes the whole submission down.
     */
    siteId: input.siteId ?? unassignedSiteId(),
    source: input.source,
    title,
    description: input.description,
    location,
    requester: input.requester ?? "",
    contact: input.contact ?? "",
    category: input.category || "Other",
    engineer,
    tier: rule.tier,
    priority,
    stage,
    status: statusForStage(stage),
    contractor: null,
    assignee: null,
    parentId: input.parentId ?? null,
    requestedAt,
    dueAt,
    completedAt: null,
    nextUpdateAt: dueAt,
    cost: null,
    attachmentCount: 0,
    issueAttachmentCount: 0,
    completedAttachmentCount: 0,
    generalAttachmentCount: 0,
    publicUploadTokenHash: input.publicUploadTokenHash ?? null,
    publicUploadTokenExpiresAt: input.publicUploadTokenExpiresAt ?? null,
    commentCount: 0,
    createdByEmail: input.actor?.email ?? null,
    ...(input.overrides ?? {}),
  };

  const allocated = await allocateSubmission(db, {
    organisationId: input.organisationId,
    boardId: input.boardId,
    groupId: group?.id ?? null,
    values,
  });

  await db.insert(activityLog).values({
    id: crypto.randomUUID(),
    organisationId: input.organisationId,
    entityType: "maintenance_request",
    entityId: allocated.request.id,
    action: "request.created",
    actorEmail: input.actor?.email ?? null,
    detail: JSON.stringify({
      source: input.source,
      board: input.boardId,
      group: group?.id ?? null,
      priority,
      location,
      ...(input.activityDetail ?? {}),
    }),
  });

  return {
    request: allocated.request,
    placement: allocated.placement,
    group,
    priority,
    engineer,
    stage,
    displayReference: allocated.request.reference ?? allocated.request.id,
  };
}
