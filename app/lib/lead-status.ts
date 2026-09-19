/**
 * Where an enquiry from the public website has got to — Master Specification §12.
 *
 * WHY THIS EXISTS AT ALL, WHICH IS THE WHOLE POINT OF THE PHASE.
 *
 * `leads.status` has been in the schema since Stage 1, `NOT NULL DEFAULT 'New'`,
 * and **nothing has ever written to it**. Measured on Staging: 8 leads, every one
 * of them still `"New"`, the oldest from 2026-08-29. The column was a promise of a
 * workflow that did not exist, so a lead that had been answered looked exactly like
 * one nobody had opened.
 *
 * NO MIGRATION, DELIBERATELY. The column already exists and already has the right
 * type and the right default; what was missing was a vocabulary, a write path and a
 * screen. Adding a column here would have moved the schema fingerprint for no gain
 * — and would have collided with the website-CMS branch, which is waiting on a
 * merge and already moves it.
 *
 * WHY THE VOCABULARY IS A CLOSED LIST AND NOT FREE TEXT.
 *
 * `status` is a `TEXT` column, so the database would accept anything. A free-text
 * status is a column that means something slightly different to everybody who
 * writes it, which makes both the filter and the count on the inbox screen lies.
 * The route narrows to this list, so a stored value is always one the screen knows
 * how to draw and how to total.
 *
 * `"New"` IS FIRST AND IS THE DATABASE DEFAULT, and that is load-bearing rather
 * than tidy: every one of the rows already stored carries it, so a vocabulary that
 * did not begin with it would have rendered the entire existing inbox as an unknown
 * state. A test asserts the two agree.
 */

export type LeadStatusKey =
  | "New"
  | "Contacted"
  | "Qualified"
  | "Quoted"
  | "Won"
  | "Lost"
  | "Spam";

export type LeadStatus = {
  key: LeadStatusKey;
  /** One line for whoever is working the inbox, not for a developer. */
  description: string;
  /**
   * Whether this is the end of the road for an enquiry.
   *
   * The screen totals open and closed separately, because "how many enquiries are
   * waiting on us" is the only number anybody actually opens this screen to see,
   * and a count that included every lead ever won would never go down.
   */
  closed: boolean;
};

/**
 * In the order an enquiry moves through them, then the two ways it ends.
 *
 * `Spam` is separate from `Lost` on purpose. A lost enquiry was real and is worth
 * counting against the ones that were won; a spam submission is not a lead at all,
 * and folding the two together would quietly corrupt the only ratio this screen
 * could ever be asked for. The honeypot in `POST /api/leads` catches the crude
 * attempts already, so anything reaching this state got through a human check.
 */
export const LEAD_STATUSES: readonly LeadStatus[] = [
  { key: "New", description: "Nobody has opened it yet.", closed: false },
  { key: "Contacted", description: "Someone has replied and is waiting to hear back.", closed: false },
  { key: "Qualified", description: "A real prospect with an estate worth quoting for.", closed: false },
  { key: "Quoted", description: "A price has gone out and the decision sits with them.", closed: false },
  { key: "Won", description: "They became a client.", closed: true },
  { key: "Lost", description: "A real enquiry that went nowhere.", closed: true },
  { key: "Spam", description: "Not an enquiry. Kept rather than deleted, so the count of real ones stays honest.", closed: true },
] as const;

export const LEAD_STATUS_KEYS: readonly string[] = LEAD_STATUSES.map((status) => status.key);

/** The state every row already in the database is in. See the header. */
export const DEFAULT_LEAD_STATUS: LeadStatusKey = "New";

/** Narrows an untrusted string, so a request cannot invent a status. */
export function isLeadStatus(value: unknown): value is LeadStatusKey {
  return typeof value === "string" && LEAD_STATUS_KEYS.includes(value);
}

/**
 * What a stored value means, tolerating one this build does not know.
 *
 * A row written before a status was retired — or by hand — must not break the
 * screen. It reads as itself, counted as open, because an unrecognised state is
 * one nobody has resolved and burying it in the closed total would hide work.
 */
export function leadStatus(value: string | null | undefined): LeadStatus {
  const known = LEAD_STATUSES.find((status) => status.key === value);
  if (known) return known;
  return {
    key: (value || DEFAULT_LEAD_STATUS) as LeadStatusKey,
    description: "A status this version does not recognise.",
    closed: false,
  };
}

/**
 * What this slice deliberately does NOT do.
 *
 * Stated once, travelled to the screen, and shown there — so the gaps are read by
 * the person working the inbox rather than discovered when they look for a button
 * that is not there.
 */
export const LEAD_OMISSIONS: readonly string[] = [
  "There is no notes field. A lead has no column for one, and adding it would move the schema fingerprint; the reason given when a status changes is recorded in the audit trail instead, and shown in the history beside each enquiry.",
  "A lead cannot be assigned to a person. Same reason — there is no column for it, and one inbox worked by a handful of staff does not yet need one.",
  "There is no CSV export. Reading the inbox is what was missing; exporting it is a separate decision about where customer contact details are allowed to go.",
  "Deleting a lead is not offered. Spam is a status rather than a deletion, so the count of real enquiries stays honest and nothing that arrived is silently gone.",
  "Nothing is emailed when a status changes. The submitter already got a confirmation on arrival; a second message every time staff move a card is not something they asked for.",
];
