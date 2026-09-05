/**
 * WHAT A MANUAL CALENDAR ITEM CAN BE — the three record types.
 *
 * `calendar_events.category` has existed since the table was created, is
 * validated by the route to 60 characters, round-trips through
 * `ManualEventDraft`, and defaults to `'Manual'`. Nothing in the product has
 * ever written it, so every item a person has made is a `'Manual'` with no
 * further meaning: a note, a booked visit and a certificate expiry all render
 * as the same teal chip saying the same nothing about what they are.
 *
 * This module is the vocabulary that column was waiting for. It is deliberately
 * a small pure table rather than a database of types:
 *
 *  - The KEY is what is stored. It is a plain string in a column that already
 *    accepts one, so this needs no migration and an older row keeps working —
 *    see `calendarItemType`, which reads an unknown value as a Note rather than
 *    dropping the item. A calendar that hides a record because it does not
 *    recognise its label is worse than one that draws it plainly.
 *  - The rest — label, description, icon, colour, and which fields the form
 *    should show — is presentation, and presentation belongs in code where it
 *    can be reviewed, not in a table somebody has to seed.
 *
 * WHAT IS NOT HERE, AND WHY. The Calendar brief asks a Planned visit to carry
 * assigned users, a contractor, a priority, a status and a response deadline,
 * and a Certificate to carry a reference, an issuing body, a renewal owner and
 * a renewal booking state. `calendar_events` has columns for none of them, and
 * inventing them would put a second, thinner copy of a job beside
 * `maintenance_requests` and a second compliance register beside the Store
 * Documentation board — the two duplications the brief is most explicit about
 * refusing. Those fields need an additive migration decided against the real
 * estate, which is recorded in the handover rather than guessed at here.
 *
 * What each type does get is the meaning of its own DATE, which is the field
 * the calendar is actually about, and that is enough to make the three
 * distinguishable on the grid and in a screen reader.
 */

/** The value written to `calendar_events.category`. */
export type CalendarItemTypeKey = "Note" | "Planned visit" | "Certificate";

export type CalendarItemType = {
  key: CalendarItemTypeKey;
  /** What the chooser and the chip call it. */
  label: string;
  /** One line, shown under the label in the chooser. */
  description: string;
  /**
   * The icon name, from the shared `Icon` set. Carried so the chip can say
   * what kind of thing it is without colour — the accessibility rule the
   * compliance scale is already held to.
   */
  icon: "message" | "calendar" | "shield";
  /**
   * The swatch written to `calendar_events.colour` when the person does not
   * choose one. Validated `#RRGGBB` by the route.
   */
  colour: string;
  /** What the start date MEANS for this type. Drives the field's label. */
  dateLabel: string;
  /** The end-date field's label, and whether it is offered at all. */
  endDateLabel: string | null;
  /** The free-text field's label — a note, a scope of works, or findings. */
  notesLabel: string;
  /** Placeholder for the free-text field, so an empty box suggests its use. */
  notesHint: string;
};

/**
 * The three, in the order the chooser offers them: cheapest first.
 *
 * A Note is creatable in seconds and is what most items are; a certificate is
 * the one with consequences. Ordering by effort rather than by importance is
 * what keeps the common case one tap away.
 */
export const CALENDAR_ITEM_TYPES: readonly CalendarItemType[] = [
  {
    key: "Note",
    label: "Note",
    description: "A comment or internal memo against a date.",
    icon: "message",
    colour: "#0f7f78",
    dateLabel: "Date",
    endDateLabel: "Ends on",
    notesLabel: "Note",
    notesHint: "What this is about.",
  },
  {
    key: "Planned visit",
    label: "Planned visit",
    description: "Scheduled attendance by an engineer or contractor.",
    icon: "calendar",
    colour: "#1b4662",
    dateLabel: "Visit date",
    endDateLabel: "Last day on site",
    notesLabel: "Scope of works and access",
    notesHint: "What is being done, who is attending, and how they get in.",
  },
  {
    key: "Certificate",
    label: "Certificate / compliance",
    description: "A document with an expiry date to renew before.",
    icon: "shield",
    /*
     * Amber, not the compliance register's red. This is the colour of a
     * certificate RECORD, not of how close it is to expiring — the proximity
     * scale is derived from the date by `calendarItemTypeColour` below, so a
     * fixed red here would say "expired" about something valid for two years.
     */
    colour: "#a8620a",
    /*
     * The start date IS the expiry date for this type. `calendar_events` has
     * one date column and this is the date that matters about a certificate —
     * the day the cover runs out is the day it must appear on the calendar.
     * Saying so in the label is what stops somebody entering the issue date.
     */
    dateLabel: "Expires on",
    endDateLabel: null,
    notesLabel: "Reference and findings",
    notesHint: "Certificate number, who issued it, and any remedials outstanding.",
  },
];

const BY_KEY = new Map(CALENDAR_ITEM_TYPES.map((type) => [type.key, type]));

/**
 * The type a stored `category` means, never null.
 *
 * An unrecognised value — `'Manual'` on every item made before this existed, or
 * something a future version writes — reads as a Note. That is the honest
 * default: a Note is the type that claims the least about a record, and the
 * alternative is a calendar that silently omits rows whose label it has not
 * been taught. The raw value is still on the row and still round-trips, so
 * nothing is lost by drawing it plainly.
 */
export function calendarItemType(category: string | null | undefined): CalendarItemType {
  return (category && BY_KEY.get(category as CalendarItemTypeKey)) || CALENDAR_ITEM_TYPES[0];
}

/** Whether a stored category is one this version knows how to draw. */
export function isKnownCalendarItemType(category: string | null | undefined): boolean {
  return Boolean(category && BY_KEY.has(category as CalendarItemTypeKey));
}

/**
 * THE EXPIRY PROXIMITY SCALE — certificates only.
 *
 * The bands are the SAME numbers as `COMPLIANCE_REMINDER_DAYS` in
 * `calendar-model.ts` — 90, 60, 30, 14 — on purpose. The calendar already
 * derives a reminder marker at each of those distances, and a chip that
 * changed colour on a different ladder from the one the reminders fire on
 * would be two answers to "how urgent is this".
 *
 * A LOCAL THRESHOLD CONSTANT IS NOT ADDED HERE, and that is deliberate: this
 * repository has already had the bug where a compliance tile said "Due within
 * 30 days" while a 60-day window filled it, because a screen kept its own copy
 * of a number the policy owns. These are BANDS on the existing ladder, not a
 * new policy — nothing here decides when something is "due soon", which
 * remains `EXPIRY_DUE_SOON_DAYS` in `app/lib/expiry-status.ts` and is what the
 * compliance register and the store tracker read.
 */
export type CalendarExpiryBand = {
  colour: string;
  /** The word, so the state is readable with no colour at all. */
  label: string;
  /** Shown on the chip beside the icon: "90d", "14d", "OVERDUE". */
  badge: string;
};

export function certificateExpiryBand(daysRemaining: number): CalendarExpiryBand {
  if (daysRemaining < 0) {
    return { colour: "#7f1d1d", label: "Expired", badge: "EXPIRED" };
  }
  const badge = `${daysRemaining}d`;
  if (daysRemaining <= 14) return { colour: "#991b1b", label: "Urgent", badge };
  if (daysRemaining <= 30) return { colour: "#ef4444", label: "30-day window", badge };
  if (daysRemaining <= 60) return { colour: "#f97316", label: "60-day window", badge };
  if (daysRemaining <= 90) return { colour: "#eab308", label: "90-day window", badge };
  return { colour: "#64748b", label: "Valid", badge };
}

/**
 * The colour a manual item's chip should take.
 *
 * A certificate is coloured by how close its expiry is; everything else takes
 * the swatch the person chose, or its type's default. `daysRemaining` is passed
 * in rather than computed here so this module stays pure and free of "today",
 * which is what makes it testable at the exact boundaries — 91, 90, 61, 60, 31,
 * 30, 15, 14, 0 and −1 — where off-by-one errors in this kind of arithmetic
 * actually live.
 */
export function calendarItemTypeColour(
  category: string | null | undefined,
  chosenColour: string | null | undefined,
  daysRemaining: number | null,
): string {
  const type = calendarItemType(category);
  if (type.key === "Certificate" && daysRemaining !== null) {
    return certificateExpiryBand(daysRemaining).colour;
  }
  return chosenColour || type.colour;
}
