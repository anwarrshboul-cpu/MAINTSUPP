/**
 * Which `MN-…` reference may be issued next — the PURE half.
 *
 * Split from `board-mutations.ts` for the reason `contractor-comment-log.ts` is
 * split from `contractor-comments.ts`: that module reaches the database, and
 * reaching the database pulls `board-registry` -> `chatgpt-auth` ->
 * `next/headers` into the graph, which a `node --test` process cannot resolve.
 * Everything here is numbers in and a number out, and it imports nothing — so
 * the rule can be tested by RUNNING it rather than by reading it.
 *
 * WHY THE RULE IS NOT "one more than the highest job".
 *
 * `MN-…` is the primary key of `maintenance_requests`, the primary key of
 * `maintenance_group_items`, and half the unique key of `recycle_bin`. A row in
 * either of the latter two can outlive the job it names — a purge that removed
 * the request and left the placement, a bin entry whose job was later
 * hard-deleted. When that happens, a ceiling taken over jobs alone drops back
 * BELOW a reference that is still spoken for, and the allocator re-issues it.
 *
 * The insert that then collides is not the one the create path retries, so the
 * failure surfaced as a bare 503 with the real cause swallowed:
 *
 *   · a surviving placement  ->  `create_item`  503
 *   · a surviving bin entry  ->  `delete_items` 503
 *
 * Observed on the dev estate: `maintenance_requests` topped out at MN-1157
 * while placements still held MN-1162, and no job could be created on the board
 * at all until the leftovers were removed by hand.
 *
 * So the floor is the highest reference ANY of those tables still holds. The
 * product no longer depends on a cleanup script having been run;
 * `scripts/repair-orphaned-placements.mjs` goes back to being a tidy-up rather
 * than a prerequisite.
 *
 * WHAT THIS DOES NOT DO. It does not renumber anything, and it never lowers the
 * ceiling — skipping a reference is free, reusing one is an outage. Gaps in the
 * `MN-…` sequence are expected and always have been: a deleted job keeps its
 * number.
 *
 * WHY THE READS THAT FEED IT ARE BOUNDED, AND WHY THAT IS NOT A SQL `MAX`.
 *
 * Those three reads used to be unbounded: every `MN-%` row in all three tables,
 * ~1,600 of them on production, on EVERY created job — including the anonymous
 * public intake at `/api/report-job`, against a pooler with a hard client cap.
 * They are now a top-N window each, ordered `length(reference) DESC, reference
 * DESC`, and `JOB_REFERENCE_WINDOW` below carries the reasoning for the shape
 * and the size. The reads themselves stay in `nextJobNumber`, which is where
 * the database is.
 */

/**
 * The first reference this product ever issues.
 *
 * 1048 rather than 0 because the monday import that seeded this estate ended at
 * MN-1048, so the first locally created job is MN-1049. Lowering it would hand
 * a new job an imported job's number.
 */
export const JOB_REFERENCE_FLOOR = 1048;

/**
 * The numeric part of an `MN-…` reference, or null if it does not carry one.
 *
 * Deliberately strict. `recycle_bin.entity_id` also holds group, column and
 * board-view ids, and a loose parse of one of those would inflate the ceiling
 * and skip a block of references for no reason.
 */
export function jobReferenceNumber(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = /^MN-(\d+)$/.exec(value.trim());
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * How many candidate references ONE bounded read brings back, per table.
 *
 * THE ORDER THE WINDOW IS TAKEN IN. `length(reference) DESC, reference DESC`,
 * which is descending NUMERIC order for an unpadded `MN-<digits>`: a longer
 * digit run is always the larger number, and within one length the characters
 * compare position by position, so lexical order IS numeric order. That is the
 * half a plain text `MAX()` gets wrong — it answers `MN-999` over `MN-1000`.
 *
 * It also needs no cast, which is the point. The shape this replaced,
 * `max(cast(substr(id, 4) as integer))`, threw `22P02 invalid input syntax` on
 * Postgres the moment one id was not `MN-<digits>` while SQLite quietly cast
 * the same row to 0 — a fault that could not fail locally and could not do
 * anything but fail deployed. `length()` and `>` are total functions on text in
 * both dialects; neither can throw on any row, however malformed.
 *
 * WHY A WINDOW RATHER THAN `LIMIT 1`. `LIKE 'MN-%'` is the only shape filter
 * the two dialects share — Postgres' `~` is Postgres-only, SQLite's `GLOB` is
 * SQLite-only, and there is no portable all-digits test — so a row matching the
 * LIKE without being `MN-<digits>` still reaches the ordering, and it sorts
 * ABOVE the true maximum. Measured, and identical on Postgres 17.6 under
 * `en_US.UTF-8` and on SQLite under BINARY:
 *
 *   MN-1272-copy > MN-0000001 > MN-draft > MN-1300 > MN-127a > MN-1279 > …
 *
 * At `LIMIT 1` the answer there is `MN-1272-copy`, which parses to nothing, and
 * the ceiling collapses to the floor — every live reference re-issued, which is
 * the outage this module exists to prevent, reintroduced as an optimisation.
 * With a window those rows are simply read, parsed to null and ignored, and the
 * highest well-formed row in the window is the answer.
 *
 * 32 because the estate holds ZERO rows of that kind today — measured across
 * all three tables locally (129 + 130 + 80 candidates) and on staging — so the
 * window would have to be wrong 32 times over before it lost the maximum, and
 * 32 is still 4% of what the unbounded read moved.
 */
export const JOB_REFERENCE_WINDOW = 32;

/**
 * The bound a read is widened to when a FULL window told us nothing at all.
 *
 * Effectively "all of them", and deliberately so. A full window carrying no
 * well-formed reference is the one result a bounded read cannot conclude
 * anything from, and the two ways out of it are not symmetric: reading the rest
 * costs one slow query on a shape that has never occurred, while concluding
 * "this table holds none" hands a new job a reference another table still
 * holds. Cheap and occasionally slow beats fast and occasionally wrong on the
 * one operation a person cannot work around.
 */
export const JOB_REFERENCE_RESCAN_WINDOW = 100_000;

/**
 * The highest well-formed reference in a candidate window, or null for none.
 *
 * The MAXIMUM over the window, not its first parseable row. Those are the same
 * value for every reference this product mints, because the ordering above puts
 * them in numeric order — they differ only for a zero-padded suffix like
 * `MN-0001`, which sorts by its padded LENGTH and so arrives out of place. The
 * estate holds none and `formatJobReference` cannot mint one, but a maximum
 * costs one comparison per row and removes the assumption entirely.
 */
export function highestJobReference(
  values: ReadonlyArray<string | null | undefined>,
): number | null {
  let top: number | null = null;
  for (const value of values) {
    const number = jobReferenceNumber(value);
    if (number !== null && (top === null || number > top)) top = number;
  }
  return top;
}

/**
 * Did a bounded read come back FULL and carrying no reference at all?
 *
 * The one answer that means "ask again for more", rather than "this table holds
 * none". A SHORT window is conclusive however empty it is — the read asked for
 * more rows than existed, so it saw every candidate there was.
 */
export function jobReferenceWindowInconclusive(
  values: ReadonlyArray<string | null | undefined>,
  limit: number = JOB_REFERENCE_WINDOW,
): boolean {
  return values.length >= limit && highestJobReference(values) === null;
}

/**
 * The next reference, given the highest number each table still holds.
 *
 * Nulls mean "that table holds none", which is not the same as zero — an empty
 * workspace must still start at the floor rather than at 1.
 */
export function nextJobReferenceNumber(
  maxima: ReadonlyArray<number | null | undefined>,
): number {
  let highest = JOB_REFERENCE_FLOOR;
  for (const value of maxima) {
    const number = typeof value === "number" && Number.isFinite(value) ? value : null;
    if (number !== null && number > highest) highest = number;
  }
  return highest + 1;
}

/** `1049` -> `"MN-1049"`. One spelling, so no caller builds it by hand. */
export function formatJobReference(number: number): string {
  return `MN-${number}`;
}
