import type { RequestStage } from "./types";

/**
 * Maps a stage onto the status chip a job takes when it is moved there.
 *
 * Every value must be a label the board actually carries. "Triage in progress"
 * was not one — it was among six statuses that existed only in this codebase,
 * so moving a job into Incoming set it to a chip that could not be rendered.
 *
 * Lived inline in `app/api/board/route.ts` until the automation engine needed
 * the same answer when it moves an item to a group: one map, read from both
 * the route and `app/lib/board-mutations.ts`, so the two cannot drift.
 */
export function statusForStage(stage: RequestStage) {
  return {
    Incoming: "Pending Approval",
    Booked: "Job Scheduled",
    Attention: "Waiting for decisions",
    Completed: "Job Completed",
  }[stage];
}
