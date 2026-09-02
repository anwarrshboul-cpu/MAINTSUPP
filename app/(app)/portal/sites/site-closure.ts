"use client";

/**
 * W05-05 — ONE CONFIRMATION FOR CLOSING A SITE, WHEREVER IT IS CLOSED FROM.
 *
 * There are two user-reachable ways to take a site off the active register and
 * they used to behave differently. The Sites register asks "Close X? Its jobs
 * and certificates are kept." The Manage-data drawer's Lifecycle select asks
 * NOTHING AT ALL: choose Closed, press Save, and `PATCH /api/workspace` writes
 * the identical `{ status: 'closed', active: false, lifecycle: 'Closed' }` that
 * the register's Close button writes — no dialog, no undo, no mention that the
 * site is about to disappear from every location picker in the product.
 *
 * A confirmation that only guards one of the two doors is not a confirmation.
 * So the words live here and both doors call them, which also means the promise
 * can only be corrected in one place.
 *
 * WHAT THE SENTENCE HAS TO SAY, and why each part is load-bearing:
 *
 *  · THE NAME. "Close this record?" is the dialog people click through. The
 *    drawer in particular is a list of eight registers and it is genuinely easy
 *    to be looking at a different row than you think you are.
 *
 *  · THAT IT LEAVES THE ACTIVE REGISTER. This is the consequence nobody expects
 *    from a field called "Lifecycle": `listRetailSites` stops offering the site,
 *    so Report-a-Job, the board's Location column and the public form all lose
 *    it. Somebody closing a shop that is merely being refitted needs to know
 *    that before they press Save, not afterwards.
 *
 *  · THAT THE HISTORY SURVIVES. This is the half that stops the OPPOSITE
 *    mistake. A closure is an archive, never a delete — jobs, documents,
 *    compliance records and assets all stay exactly where they are, and a
 *    manager who does not know that will keep a dead store on the live register
 *    for fear of losing four years of certificates.
 *
 * `data.delete` — the permanent purge — is a different capability, a different
 * verb and a different dialog. This one is only ever about closing.
 */

/** The sentence both closure paths show, naming the site it is about to close. */
export function siteClosureMessage(name: string) {
  const subject = name.trim() || "this site";
  return (
    `Close ${subject}?\n\n` +
    "It leaves the active site register, so it is no longer offered when raising " +
    "or assigning work.\n\n" +
    "Nothing is deleted: its jobs, documents, compliance records and assets are " +
    "all kept, and the site can be reopened."
  );
}

/**
 * Ask, and answer whether the caller may proceed.
 *
 * `window.confirm` for the same reason the register already used it: a closure
 * is initiated from two very different screens, one of which is itself a modal
 * dialog, and a second nested in-page dialog inside the Manage-data modal is a
 * focus trap fighting a focus trap. The browser's own dialog is keyboard
 * dismissable, announced, and cannot be missed behind a scrim.
 *
 * CANCEL MUST COST NOTHING. Every caller returns before its fetch when this is
 * false — no request, no optimistic state change, no toast. That is asserted in
 * `tests/workstream-five-site-state-and-profile.test.mjs`.
 */
export function confirmSiteClosure(name: string) {
  if (typeof window === "undefined") return false;
  return window.confirm(siteClosureMessage(name));
}
