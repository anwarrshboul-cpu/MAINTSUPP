/**
 * Where a contractor's application to join the network has got to — Master
 * Specification §12 (forms and leads), for the /contractors form.
 *
 * `contractor_applications.status` has been `NOT NULL DEFAULT 'New'` since the
 * table was made, and nothing has ever read the table at all: the intake route
 * wrote a row and an email, and the row was unreachable from then on. This is the
 * vocabulary the inbox at /admin/applications moves a row through.
 *
 * NO MIGRATION, DELIBERATELY — the same call `lead-status.ts` made. The column
 * exists with the right type and the right default; what was missing was a
 * vocabulary, a write path and a screen.
 *
 * A CLOSED LIST, because the column is TEXT and would accept anything, and a
 * free-text status makes the inbox's filter and totals untrue. `"New"` is first
 * and is the database default, so every row already stored reads as a state the
 * screen knows.
 */

export type ApplicationStatusKey = "New" | "In review" | "Approved" | "Declined" | "Spam";

export type ApplicationStatus = {
  key: ApplicationStatusKey;
  /** One line for whoever is working the inbox. */
  description: string;
  /** The end of the road — the inbox totals open and closed separately. */
  closed: boolean;
};

export const APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  { key: "New", description: "Nobody has opened it yet.", closed: false },
  {
    key: "In review",
    description: "Being vetted — insurance, references and the areas they cover.",
    closed: false,
  },
  {
    key: "Approved",
    description:
      "Accepted into the network. Adding them to a workspace's contractor register is a separate step.",
    closed: true,
  },
  { key: "Declined", description: "A real application that is not going ahead.", closed: true },
  {
    key: "Spam",
    description: "Not an application. Kept rather than deleted, so the count of real ones stays honest.",
    closed: true,
  },
] as const;

export const APPLICATION_STATUS_KEYS: readonly string[] = APPLICATION_STATUSES.map((status) => status.key);

/** The state every row already in the database is in. */
export const DEFAULT_APPLICATION_STATUS: ApplicationStatusKey = "New";

/** Narrows an untrusted string, so a request cannot invent a status. */
export function isApplicationStatus(value: unknown): value is ApplicationStatusKey {
  return typeof value === "string" && APPLICATION_STATUS_KEYS.includes(value);
}

/** What a stored value means, tolerating one this build does not know (read as open). */
export function applicationStatus(value: string | null | undefined): ApplicationStatus {
  const known = APPLICATION_STATUSES.find((status) => status.key === value);
  if (known) return known;
  return {
    key: (value || DEFAULT_APPLICATION_STATUS) as ApplicationStatusKey,
    description: "A status this version does not recognise.",
    closed: false,
  };
}

/** What this inbox deliberately does NOT do — printed on the screen, not restated there. */
export const APPLICATION_OMISSIONS: readonly string[] = [
  "Approving an application does not add the company to any workspace's contractor register. Which clients a contractor works for is a decision made in that workspace, not here.",
  "There is no notes field; the reason given when a status changes is recorded in the audit trail instead.",
  "An application cannot be assigned to a person, and there is no CSV export — the rows carry other companies' contact details.",
  "Deleting an application is not offered. Spam is a status, so nothing that arrived is silently gone.",
  "Nothing is emailed to the applicant when a status changes.",
];
