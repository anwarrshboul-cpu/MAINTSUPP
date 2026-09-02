"use client";

/**
 * W06-04 — ONE CONFIRMATION FOR TAKING A CONTRACTOR OFF THE ROSTER, WHEREVER
 * IT IS DONE FROM.
 *
 * THE OWNER-APPROVED POLICY FIRST, because it decides what this file is.
 * A contractor is NEVER hard-deleted. There is no purge verb on
 * `/api/workspace`, this module does not offer one, and one must not be added:
 * every job, document, performance figure and audit line in the product points
 * at a contractor row, and removing it would silently detach four years of
 * history from the only record that says who did the work. "Remove a
 * contractor" therefore means take them off the ACTIVE ROSTER, and the
 * criterion — a confirmation before permanently removing one — is met by
 * confirming that, on every door that reaches it.
 *
 * THERE ARE TWO SUCH DOORS AND THEY BEHAVED DIFFERENTLY.
 *
 *  · The Archive button asked `window.confirm("Archive this record? It will
 *    remain in the activity history.")` — a sentence that does not name the
 *    contractor, does not say they leave the assignment list, and describes
 *    what survives as "the activity history" when what actually survives is
 *    every job, document and performance figure they have.
 *  · Unticking "Active contractor" and pressing Save asked NOTHING AT ALL, and
 *    writes the identical `active: false` through
 *    `PATCH /api/workspace { entity: "contractor" }`. `assignableContractors`
 *    in workspace-data-manager.tsx filters on `active` alone, so that one
 *    unticked box removes them from the planned-work select just as completely
 *    as the Archive button does — with no dialog and no undo.
 *
 * A confirmation that guards one of two doors is not a confirmation. So the
 * words live here and both doors call them, which also means the promise can
 * only be corrected in one place. This is the same shape, and for the same
 * reasons, as `sites/site-closure.ts`; the two are deliberately siblings rather
 * than one generic helper, because the consequences they describe are
 * different and a shared sentence would have to stop naming either.
 *
 * WHAT THE SENTENCE HAS TO SAY, and why each part is load-bearing:
 *
 *  · THE NAME. "Archive this record?" is the dialog people click through. The
 *    Manage-data drawer is a list of eight registers and it is genuinely easy
 *    to be looking at a different row than you think you are.
 *
 *  · THAT THEY LEAVE THE ACTIVE ROSTER. This is the consequence nobody expects
 *    from a tick box sitting two rows under an Availability select that already
 *    offers the word "Inactive". They are two different questions and only this
 *    one takes the contractor out of the assignment list.
 *
 *  · THAT THE HISTORY SURVIVES. This is the half that stops the OPPOSITE
 *    mistake. A coordinator who does not know that jobs, documents, performance
 *    and audit are all kept will leave a contractor nobody uses on the live
 *    roster for fear of losing the record of what they did.
 *
 * WHAT DOES NOT ASK. Availability — Available, Limited, Unavailable — is the
 * day-to-day answer to "can they take work this week" and removes nobody from
 * anything; `assignableContractors` deliberately ignores it, because a
 * contractor who is busy today is a perfectly good choice for March. Prompting
 * on an ordinary availability change would be the fastest way to teach people
 * to click through this dialog without reading it.
 */

/** The sentence both roster-exit paths show, naming the contractor. */
export function contractorRosterExitMessage(name: string) {
  const subject = name.trim() || "this contractor";
  return (
    `Take ${subject} off the active contractor roster?\n\n` +
    "They stop being offered when assigning work, and disappear from the " +
    "contractor selection lists.\n\n" +
    "Nothing is deleted: their jobs, documents, performance history and audit " +
    "trail are all kept, and they can be put back on the roster at any time."
  );
}

/**
 * Ask, and answer whether the caller may proceed.
 *
 * `window.confirm` for the reason `site-closure.ts` gives: this is initiated
 * from inside the Manage-data modal, and a second in-page dialog nested in that
 * one is a focus trap fighting a focus trap. The browser's own dialog is
 * keyboard dismissable, announced, and cannot be lost behind a scrim.
 *
 * CANCEL MUST COST NOTHING. Every caller returns before its request when this
 * is false — no fetch, no optimistic state change, no toast, and the editor is
 * left open with the user's edit intact so a mis-click costs nothing but the
 * click. That is asserted in
 * `tests/workstream-six-contractor-commercial.test.mjs`.
 */
export function confirmContractorRosterExit(name: string) {
  if (typeof window === "undefined") return false;
  return window.confirm(contractorRosterExitMessage(name));
}

/**
 * Whether a save is about to take this contractor off the roster.
 *
 * The transition, never the state. Re-saving a contractor who is ALREADY off
 * the roster must go straight through: asking about something that is not
 * happening is how people learn to click Yes without reading, and it would fire
 * on every edit of every archived contractor in the register.
 *
 * `stored` is undefined while creating, and a new contractor cannot be leaving
 * a roster they were never on.
 */
export function leavesContractorRoster(
  stored: { active: boolean } | undefined | null,
  nextActive: boolean,
): boolean {
  return Boolean(stored?.active) && !nextActive;
}
