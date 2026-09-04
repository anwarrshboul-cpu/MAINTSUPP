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
