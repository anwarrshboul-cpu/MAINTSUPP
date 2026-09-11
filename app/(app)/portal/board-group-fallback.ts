/**
 * THE GROUP A ROW IS DRAWN IN — never none.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 *
 * The board buckets rows by their placement's `group_id` and then draws the
 * buckets of its live groups. A placement can name a group the board no longer
 * draws: binning a group flags the group and leaves its placements pointing at
 * it (`sendGroupToBin`), `move_items` checks a target group's organisation but
 * not its board, and deleting a group re-parents to a `moveTo` nobody validates.
 * The server says as much — "a placement in a group that has been binned …
 * exist[s] on the live board today" (`compactBoard` in `api/board/route.ts`).
 *
 * Such a row was bucketed under an id no drawn group reads, so it vanished: not
 * filtered, not deleted, still counted by every aggregate, and invisible on the
 * one screen that could fix it. The old expression fell back to the stage and
 * the first group only when the placement was MISSING — a stale id is not
 * missing, so it never fell through.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * A placement counts only when its group is one of the groups this board is
 * drawing. Otherwise the row is drawn exactly where the server files a row that
 * has no placement at all (`ensureBoardState`): the group whose stage matches
 * the row's stage, else the first group. So a row whose group vanished is
 * treated precisely as a row that never had one — the board's existing
 * semantics, not a new one — and every affordance keeps working: it drags out
 * (`move_item` finds the placement by board and row, whatever group it names,
 * and re-files it, which also repairs the stale id), "add item below" creates
 * in a real group, and the drawer's move list offers real groups.
 *
 * Nothing is written by drawing. The stored placement is untouched until a
 * person moves the row.
 */

type DrawnGroup = { id: string; stageKey?: string | null };

export function drawnGroupId(
  placedGroupId: string | null | undefined,
  stage: string | null | undefined,
  groups: readonly DrawnGroup[],
): string | undefined {
  if (placedGroupId && groups.some((group) => group.id === placedGroupId)) return placedGroupId;
  return groups.find((group) => group.stageKey === stage)?.id ?? groups[0]?.id;
}
