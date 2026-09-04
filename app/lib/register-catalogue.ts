/**
 * WORKSTREAM 5/6 — what a register's NATIVE columns are.
 *
 * A register column is one of two things, and the difference is the whole
 * design:
 *
 *   NATIVE  — a view onto a real, typed column on `sites` or `contractors`.
 *             The value lives on that row and is read and written through the
 *             entity's own API. The register row records only how the column is
 *             PRESENTED: its label, its order, its width, whether it is shown.
 *   CUSTOM  — a column somebody added. There is no field behind it, so its
 *             values live in `register_values`, keyed by entity.
 *
 * THE INVARIANT, stated once here because every other file depends on it: a
 * native column's value is NEVER copied into `register_values`. Two stores for
 * one fact is two answers to one question, and the register would start
 * disagreeing with the site record the first time anybody edited a site through
 * the ordinary form. `PATCH /api/registers/values` refuses a native key for
 * exactly this reason.
 *
 * WHY `field` IS camelCase. It is the name the entity's own API speaks —
 * `PATCH /api/sites { managerEmail }`, `PATCH /api/workspace { entity:
 * "contractor", data: { dayRatePence } }` — and the name `GET` hands back. So a
 * client holding a register column can read `row[column.nativeField]` and write
 * `{ [column.nativeField]: next }` with no mapping table of its own. The DB's
 * snake_case is drizzle's business and appears nowhere above the shim.
 *
 * WHAT IS DELIBERATELY ABSENT. `id`, `organisationId`, `legacyClientId`
 * (`client_id`), `slug`, `createdAt` and `updatedAt` are the machinery that
 * makes a row addressable; they are not facts about a site or a contractor and
 * a register that offered them would be offering to break itself. `position` is
 * excluded on the same grounds — it is the register's own row ordering, and a
 * column that reorders the thing displaying it is a loop. See
 * `EXCLUDED_NATIVE_FIELDS`, which a test pins.
 */

import { isColumnType, type ColumnTypeKey } from "./column-types";

/** The registers this engine serves. A third is a new entry, not a migration. */
export const REGISTER_KEYS = ["sites", "contractors"] as const;

export type RegisterKey = (typeof REGISTER_KEYS)[number];

export function isRegisterKey(value: unknown): value is RegisterKey {
  return typeof value === "string" && (REGISTER_KEYS as readonly string[]).includes(value);
}

/**
 * The types a register column may hold.
 *
 * A SUBSET of the board's registry rather than a second copy of it, because a
 * register is not a board: there are no subitems to count, no formula engine
 * reading sibling cells, and nothing to mirror from. Offering `formula` here
 * would be offering a column that can only ever be blank. `column-types.ts`
 * stays the one place that says what a type MEANS; this says which of those
 * meanings a register can honour.
 */
export const REGISTER_COLUMN_TYPES = [
  "text",
  "long_text",
  "number",
  "currency",
  "date",
  "checkbox",
  "email",
  "phone",
  "link",
  "single_select",
  "multi_select",
  "rating",
] as const satisfies readonly ColumnTypeKey[];

export type RegisterColumnType = (typeof REGISTER_COLUMN_TYPES)[number];

export function isRegisterColumnType(value: unknown): value is RegisterColumnType {
  return (
    typeof value === "string" &&
    isColumnType(value) &&
    (REGISTER_COLUMN_TYPES as readonly string[]).includes(value)
  );
}

/**
 * The width a column takes when nobody has dragged it.
 *
 * Same figures the board's `boardColumnDefaults` uses, for the plain reason
 * that a date is a date and reads at the same width on either surface. Not
 * imported from `app/api/board/route.ts`: that module pulls in the automation
 * engine, and a catalogue should not drag a dispatcher behind it.
 */
export function defaultWidthFor(type: RegisterColumnType): number {
  switch (type) {
    case "long_text":
      return 260;
    case "link":
      return 220;
    case "email":
      return 210;
    case "multi_select":
    case "single_select":
      return 170;
    case "phone":
      return 165;
    case "date":
      return 145;
    case "currency":
    case "number":
      return 135;
    case "rating":
      return 120;
    case "checkbox":
      return 105;
    default:
      return 180;
  }
}

export type NativeColumnSeed = {
  /** The camelCase field on the entity. Doubles as the column key — see below. */
  field: string;
  title: string;
  type: RegisterColumnType;
  /** Omitted takes `defaultWidthFor(type)`. */
  width?: number;
  /**
   * Seeded hidden rather than omitted.
   *
   * Four kinds of field earn this: one superseded by a newer column and kept
   * only so old reads keep working (`type`, `lifecycle`, `manager`), one that
   * belongs to the import rather than to the business (`mondayMaintenanceName`),
   * one whose place is the archive control rather than a grid cell (`active`),
   * and — on Contractors — one that is simply not part of the DEFAULT
   * operational view. Hiding rather than dropping them means an operator who
   * does want the value can turn it on from the Columns panel, and nobody who
   * does not is made to scroll past it.
   *
   * WHAT `hidden` IS NOT. It is a SEED, read once by `ensureRegisterColumns`
   * when an organisation's register is first created. Changing a flag here
   * changes what a NEW workspace starts with and touches no existing one:
   * every organisation that has already seeded keeps whatever its operators
   * have shown and hidden since, which is the only behaviour that does not
   * quietly undo somebody's configuration on deploy.
   */
  hidden?: boolean;
  /**
   * The column that starts FROZEN at the left of the register.
   *
   * Stored in `register_columns.settings` as `{"pinned": true}` rather than in
   * a column of its own — there is no migration behind this flag and none is
   * wanted, because a pin is a per-organisation presentation choice living
   * beside the label, the width and the order that are already there.
   *
   * TWO RULES TRAVEL WITH IT, and both are enforced by the engine and the route
   * rather than by whoever writes this list:
   *
   *   AT MOST ONE PER REGISTER. Two frozen lanes is a table with no scrolling
   *   half left on a phone, so pinning one column unpins the other in the same
   *   write. A seed that named two would be a state the API can never produce.
   *
   *   PINNED IMPLIES SHOWN. A pinned column IS the frozen lane, so a column
   *   both pinned and hidden is a lane that renders nothing. `hidden` and
   *   `pinned` on one seed therefore contradict each other, and
   *   `seedNativeColumns` resolves it in favour of the pin rather than seeding
   *   a row the two write paths would immediately have to repair.
   *
   * Read once at seed, exactly like `hidden`. An organisation that has already
   * seeded keeps whatever it has pinned since — including nothing.
   */
  pinned?: boolean;
  /**
   * Drawn by the page rather than read from the row.
   *
   * Marks a column whose value is computed — a count over the jobs on screen,
   * not a field on the contractor. The grid pairs it with the `extraColumns`
   * entry carrying the same key and lets that renderer draw the cell.
   *
   * It exists so the distinction is testable rather than implied by a comment:
   * everything else about these columns is deliberately ordinary, because
   * ordinary is what makes them configurable.
   */
  measurement?: boolean;
};

/**
 * Fields no register may ever expose.
 *
 * Exported so the rule is testable rather than a habit — a field added to
 * `sites` next month is caught by the test that reads this, not by whoever
 * happens to review the diff.
 */
export const EXCLUDED_NATIVE_FIELDS = [
  "id",
  "organisationId",
  "legacyClientId",
  "slug",
  "position",
  "createdAt",
  "updatedAt",
] as const;

/**
 * SITES — 40 of the 47 columns on the table.
 *
 * Ordered the way somebody reads a site record: what it is called and where it
 * is, then who to ring, then how to get in, then how it runs, then the lease
 * and what it costs. The seven that are missing are `EXCLUDED_NATIVE_FIELDS`.
 */
export const SITE_NATIVE_COLUMNS: readonly NativeColumnSeed[] = [
  // Identity.
  { field: "name", title: "Site", type: "text", width: 220 },
  { field: "code", title: "Code", type: "text", width: 110 },
  { field: "siteTypeValue", title: "Type", type: "single_select" },
  { field: "status", title: "Status", type: "single_select" },
  { field: "active", title: "Active", type: "checkbox", hidden: true },

  // Placement.
  { field: "addressLine1", title: "Address line 1", type: "text", width: 220 },
  { field: "addressLine2", title: "Address line 2", type: "text", width: 200 },
  { field: "city", title: "City", type: "text", width: 150 },
  { field: "postcode", title: "Postcode", type: "text", width: 120 },
  { field: "country", title: "Country", type: "text", width: 150 },
  { field: "region", title: "Region", type: "text", width: 130 },
  { field: "latitude", title: "Latitude", type: "number" },
  { field: "longitude", title: "Longitude", type: "number" },

  // Contacts.
  { field: "managerName", title: "Manager", type: "text" },
  { field: "managerPhone", title: "Manager phone", type: "phone" },
  { field: "managerEmail", title: "Manager email", type: "email" },
  { field: "landlord", title: "Landlord", type: "text" },
  { field: "managingAgent", title: "Managing agent", type: "text" },
  { field: "outOfHoursContact", title: "Out of hours", type: "text" },

  // Access. Four fields because the monday `Access Request` column mixed
  // emails, portal URLs, phone numbers and "N/A" into one cell.
  { field: "accessMethod", title: "Access method", type: "text" },
  { field: "accessContact", title: "Access contact", type: "text" },
  { field: "accessUrl", title: "Access link", type: "link" },
  { field: "accessNotes", title: "Access notes", type: "long_text" },

  // Operating detail.
  { field: "openingHours", title: "Opening hours", type: "text" },
  { field: "deliveryRestrictions", title: "Delivery restrictions", type: "long_text" },
  { field: "parkingNotes", title: "Parking", type: "long_text" },
  { field: "keyAlarmNotes", title: "Keys and alarm", type: "long_text" },

  // Lease and money. Both money fields are INTEGER PENCE on the row; the
  // `currency` type is what tells a cell to divide by 100 rather than print a
  // six-figure number for a £1,234.56 service charge.
  { field: "leaseStart", title: "Lease start", type: "date" },
  { field: "leaseEnd", title: "Lease end", type: "date" },
  { field: "breakClause", title: "Break clause", type: "text" },
  { field: "rentReview", title: "Rent review", type: "text" },
  { field: "serviceChargePence", title: "Service charge", type: "currency" },
  { field: "annualBudgetPence", title: "Annual budget", type: "currency" },

  { field: "notes", title: "Notes", type: "long_text" },

  // Superseded and import-only, seeded hidden. `type` and `lifecycle` are the
  // Stage 0 columns kept so existing reads keep working; `siteTypeValue` and
  // `status` above are their replacements. `manager` is the free-text
  // predecessor of `managerName`.
  { field: "type", title: "Type (legacy)", type: "text", hidden: true },
  { field: "lifecycle", title: "Lifecycle (legacy)", type: "text", hidden: true },
  { field: "manager", title: "Manager (legacy)", type: "text", hidden: true },
  { field: "address", title: "Address (legacy)", type: "text", hidden: true },
  { field: "mondayMaintenanceName", title: "Maintenance board name", type: "text", hidden: true },
  { field: "mondayComplianceName", title: "Compliance board name", type: "text", hidden: true },
];

/**
 * CONTRACTORS — 25 of the 29 columns on the table.
 *
 * The four missing are `id`, `organisationId`, `createdAt` and `updatedAt`.
 * Money is integer pence throughout, and the four cost fields are AGREED TERMS
 * rather than money spent — nothing sums them, here or anywhere.
 *
 * ── WHY ALMOST ALL OF THEM SEED HIDDEN ───────────────────────────────────
 *
 * All twenty-five used to seed SHOWN, and the owner's first act on the live
 * register was to hide twenty-five of them one at a time — twenty-five
 * `hidden_at` stamps spread over five and a half minutes on Staging. That is
 * not a preference the product should make somebody express by hand: a
 * contractor record has twenty-five fields and an operational screen has room
 * for about six, so the DEFAULT has to be the six and the rest has to be one
 * press away in the Columns panel.
 *
 * WHAT STAYS SHOWN, and why it is only `contactName` and `availability`. The
 * Contractors page draws six figures beside the register that are NOT register
 * columns — assigned, completed, completion rate, open urgent, documents and
 * spend (see `ExtraColumn` in `app/(app)/portal/contractor-register.tsx`) — and
 * the grid draws the contractor's identity in a pinned lane of its own. So the
 * default view is already seven lanes wide before a single native column is on
 * it.
 *
 * `contactName` earns the eighth because it is no longer just a field: W13 made
 * it the lane the actionable contact block is drawn in, so hiding it by default
 * would be a roster with no telephone number anywhere on it. The reasoning is
 * written beside the entry itself.
 *
 * `availability` earns the ninth because it is the one field that changes which
 * contractor a coordinator rings NEXT, and it is a single short word per row.
 *
 * AND `name` SEEDS PINNED RATHER THAN HIDDEN, which is the same decision
 * arrived at from the other end. The register has always drawn the
 * contractor's identity in a frozen lane at the left — that lane exists
 * because a register whose `name` column had been hidden showed rows with no
 * identity on them at all — and while that lane was hard-coded structure, a
 * `name` column shown as well would have printed the same string twice on one
 * row, so `name` had to seed hidden to keep it off the table.
 *
 * The lane is now the pinned column itself: `settings.pinned` says which
 * column freezes, the grid draws THAT column in the lane instead of in the
 * scrolling run, and the string is printed once either way. So `name` seeds
 * shown-and-pinned. A column that is pinned and hidden would be a frozen lane
 * with nothing in it, which is why the two flags cannot both be set — see
 * `NativeColumnSeed.pinned`.
 *
 * None of this touches an organisation that has already seeded. See
 * `NativeColumnSeed.hidden`.
 */
export const CONTRACTOR_NATIVE_COLUMNS: readonly NativeColumnSeed[] = [
  // Identity. The name and the archived badge, drawn in the grid's frozen
  // lane — `name` IS that lane, and it seeds pinned, which is what puts a
  // column in it. The actionable phone/WhatsApp/email block used to be the
  // second half of this cell and is now the `contactName` column below, so the
  // three standalone contact fields still do not seed onto the table: they are
  // the sortable-text form of facts the block already shows.
  { field: "name", title: "Contractor", type: "text", width: 220, pinned: true },

  /*
   * W13 — CONTACT DETAILS, SECOND AND SHOWN.
   *
   * The owner's review of /dashboard/contractors asked for two things about the
   * front of this register: the first column is who they are, and the second is
   * how to reach them. This is the second one, and both halves of it are a
   * change from what was here.
   *
   * IT MOVED UP, past the six measurements. Seeded after them it landed
   * eighth, so on a fresh register "how do I ring them" sat behind five counts
   * and a percentage — and a count is what you read when you are auditing a
   * roster, not when you are standing in a shop with a broken freezer.
   *
   * IT SEEDS SHOWN, where every other contact field still seeds hidden. That is
   * not an inconsistency: `email`, `phone` and `whatsappNumber` are seeded
   * hidden because they are the SORTABLE TEXT form of three facts, for a reader
   * who wants one of them as a column. This one is the lane the grid draws the
   * whole actionable block in — the contact person, the tappable telephone, the
   * WhatsApp row and the mailto, from `ContractorContact` — so hiding it by
   * default would leave a register with no way to reach anybody on it. See
   * `contactRegisterColumn` in `app/(app)/portal/contractor-register.tsx`.
   *
   * THE BLOCK USED TO BE PART OF THE IDENTITY LANE, which is why this column
   * was ever hidden: drawing both would have printed the contact person's name
   * twice on every row. The identity lane is now the name and the archived
   * badge, and the block rides with THIS column, so the two no longer collide.
   *
   * `width: 220` because the widest thing in the stack is an email address, and
   * 220 is what the standalone Email column takes for the same reason.
   */
  { field: "contactName", title: "Contact details", type: "text", width: 220 },

  /*
   * THE MEASUREMENTS, declared here so their ORDER belongs to the operator.
   *
   * These six are not stored fields — they are counts and sums over the jobs
   * the Contractors page has already loaded, and `portal-app.tsx` renders each
   * one through an `extraColumns` entry keyed by the same string as `field`
   * below. The grid matches them by key and lets that renderer draw the cell,
   * so a percentage still prints as "0%" and a total still prints as money.
   *
   * WHY THEY ARE IN THE CATALOGUE AT ALL. Until they were, the register's own
   * columns could be reordered and hidden and these could not: they trailed the
   * table in the page's declaration order, `reorderRegisterColumns` silently
   * dropped any key with no row behind it, and the Columns panel could not list
   * what it had no record of. A column the reader can see and cannot move is a
   * worse answer than one that is simply absent.
   *
   * `nativeField` is set, like every other native column, so the panel treats
   * them as built-in: renameable, resizable, hideable, and never deletable.
   * Nothing writes them — the grid only edits CUSTOM cells inline, and
   * `/api/registers/values` refuses a native key outright — so the read-only
   * nature of a measurement is enforced by the same rule that protects
   * `postcode`, rather than by a second concept.
   *
   * `type: "text"` throughout because the extra's renderer owns the formatting.
   * The type here decides only the fallback in `formatRegisterCell`, which is
   * reached only if the renderer is ever absent, and "—" is the right answer
   * then rather than a raw pence integer.
   */
  { field: "assigned", title: "Assigned", type: "text", width: 120, measurement: true },
  { field: "completed", title: "Completed", type: "text", width: 120, measurement: true },
  { field: "completion", title: "Completion rate", type: "text", width: 150, measurement: true },
  { field: "urgent", title: "Open urgent", type: "text", width: 135, measurement: true },
  { field: "documents", title: "Documents", type: "text", width: 130, measurement: true },
  { field: "spend", title: "Spend", type: "text", width: 120, measurement: true },
  /* `contactName` used to be here, seeded hidden. It is now the second column
     of the register and shown — the reasoning is written beside it above. */
  { field: "email", title: "Email", type: "email", hidden: true },
  { field: "phone", title: "Phone", type: "phone", hidden: true },
  { field: "whatsappNumber", title: "WhatsApp", type: "phone", hidden: true },
  { field: "address", title: "Address", type: "text", width: 220, hidden: true },
  { field: "postcode", title: "Postcode", type: "text", width: 120, hidden: true },

  // What they do and whether they are free to do it. `availability` is the
  // one native column the default view keeps: it is what decides which
  // contractor gets rung next, and it is a single short word per row.
  { field: "serviceCategories", title: "Services", type: "multi_select", width: 220, hidden: true },
  { field: "coverageAreas", title: "Coverage", type: "multi_select", hidden: true },
  { field: "certifications", title: "Certifications", type: "multi_select", hidden: true },
  { field: "availability", title: "Availability", type: "single_select" },
  { field: "rating", title: "Rating", type: "rating", hidden: true },

  // Agreed commercial terms. Reference material for a negotiation rather than
  // something read across a roster, so they live in the Columns panel.
  { field: "dayRatePence", title: "Day rate", type: "currency", hidden: true },
  { field: "hourlyRatePence", title: "Hourly rate", type: "currency", hidden: true },
  { field: "callOutCostPence", title: "Call-out", type: "currency", hidden: true },
  { field: "otherCostPence", title: "Other cost", type: "currency", hidden: true },
  { field: "otherCostLabel", title: "Other cost is for", type: "text", hidden: true },
  { field: "paymentTerms", title: "Payment terms", type: "single_select", hidden: true },
  // Points at the supplier record in the accounting system. There is
  // deliberately no bank column anywhere near this table.
  { field: "financeReference", title: "Finance reference", type: "text", hidden: true },

  // Insurance. The expiry alone could say a date but never which cover it was
  // the end of, which is why the insurer and the policy sit beside it.
  { field: "insurerName", title: "Insurer", type: "text", hidden: true },
  { field: "policyNumber", title: "Policy number", type: "text", hidden: true },
  { field: "insuranceExpiry", title: "Insurance expiry", type: "date", hidden: true },
  { field: "insuranceNotes", title: "Insurance notes", type: "long_text", hidden: true },

  { field: "notes", title: "Notes", type: "long_text", hidden: true },
  { field: "active", title: "Active", type: "checkbox", hidden: true },
];

/** The native columns a register starts with, in seeded order. */
export function nativeCatalogue(register: RegisterKey): readonly NativeColumnSeed[] {
  return register === "sites" ? SITE_NATIVE_COLUMNS : CONTRACTOR_NATIVE_COLUMNS;
}

/**
 * Every native field one register owns, for the "is this key native?" check
 * that both write routes have to make before they touch anything.
 *
 * Built from the catalogue rather than declared twice, so a field added above
 * cannot be forgotten here.
 */
export function nativeFields(register: RegisterKey): Set<string> {
  return new Set(nativeCatalogue(register).map((column) => column.field));
}
