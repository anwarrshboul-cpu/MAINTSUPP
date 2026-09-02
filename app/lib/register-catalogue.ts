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
   * Three kinds of field earn this: one superseded by a newer column and kept
   * only so old reads keep working (`type`, `lifecycle`, `manager`), one that
   * belongs to the import rather than to the business (`mondayMaintenanceName`),
   * and one whose place is the archive control rather than a grid cell
   * (`active`). Hiding rather than dropping them means an operator who does
   * want the legacy value can turn it on, and nobody who does not is made to
   * scroll past it.
   */
  hidden?: boolean;
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
  { field: "mondayMaintenanceName", title: "monday maintenance name", type: "text", hidden: true },
  { field: "mondayComplianceName", title: "monday compliance name", type: "text", hidden: true },
];

/**
 * CONTRACTORS — 25 of the 29 columns on the table.
 *
 * The four missing are `id`, `organisationId`, `createdAt` and `updatedAt`.
 * Money is integer pence throughout, and the four cost fields are AGREED TERMS
 * rather than money spent — nothing sums them, here or anywhere.
 */
export const CONTRACTOR_NATIVE_COLUMNS: readonly NativeColumnSeed[] = [
  // Identity and contact.
  { field: "name", title: "Contractor", type: "text", width: 220 },
  { field: "contactName", title: "Contact", type: "text" },
  { field: "email", title: "Email", type: "email" },
  { field: "phone", title: "Phone", type: "phone" },
  { field: "whatsappNumber", title: "WhatsApp", type: "phone" },
  { field: "address", title: "Address", type: "text", width: 220 },
  { field: "postcode", title: "Postcode", type: "text", width: 120 },

  // What they do and whether they are free to do it.
  { field: "serviceCategories", title: "Services", type: "multi_select", width: 220 },
  { field: "coverageAreas", title: "Coverage", type: "multi_select" },
  { field: "certifications", title: "Certifications", type: "multi_select" },
  { field: "availability", title: "Availability", type: "single_select" },
  { field: "rating", title: "Rating", type: "rating" },

  // Agreed commercial terms.
  { field: "dayRatePence", title: "Day rate", type: "currency" },
  { field: "hourlyRatePence", title: "Hourly rate", type: "currency" },
  { field: "callOutCostPence", title: "Call-out", type: "currency" },
  { field: "otherCostPence", title: "Other cost", type: "currency" },
  { field: "otherCostLabel", title: "Other cost is for", type: "text" },
  { field: "paymentTerms", title: "Payment terms", type: "single_select" },
  // Points at the supplier record in the accounting system. There is
  // deliberately no bank column anywhere near this table.
  { field: "financeReference", title: "Finance reference", type: "text" },

  // Insurance. The expiry alone could say a date but never which cover it was
  // the end of, which is why the insurer and the policy sit beside it.
  { field: "insurerName", title: "Insurer", type: "text" },
  { field: "policyNumber", title: "Policy number", type: "text" },
  { field: "insuranceExpiry", title: "Insurance expiry", type: "date" },
  { field: "insuranceNotes", title: "Insurance notes", type: "long_text" },

  { field: "notes", title: "Notes", type: "long_text" },
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
