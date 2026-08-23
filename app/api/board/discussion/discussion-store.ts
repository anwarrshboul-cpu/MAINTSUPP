/**
 * Board Discussion — the conversation on the board itself, as opposed to on
 * one item.
 *
 * REUSES `item_updates`, DELIBERATELY. The panel that draws an item's
 * updates — `update-thread.tsx`, with its replies, likes, mentions and
 * rendering — is the one the owner approved against monday's, and a second
 * updates table would mean a second thread component or a thread drawn from
 * two stores. Instead the board's thread is a set of `item_updates` rows
 * whose `request_id` is `board:<boardId>`: a value no job can ever have, so
 * the rows never appear on an item, and the item routes' "the job must exist
 * and not be in the bin" lookups never find them either.
 *
 * `isBoardDiscussionId` is what the likes route uses to accept a thumb on a
 * board update, which would otherwise fail its join to `maintenance_requests`.
 */

const PREFIX = "board:";

export function discussionRequestId(boardId: string) {
  return `${PREFIX}${boardId}`;
}

export function isBoardDiscussionId(requestId: string) {
  return requestId.startsWith(PREFIX);
}

export function boardIdOfDiscussion(requestId: string): string | null {
  return isBoardDiscussionId(requestId) ? requestId.slice(PREFIX.length) : null;
}
