import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";


export const sites = sqliteTable(
  "sites",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    legacyClientId: text("client_id").notNull().default("sunnamusk-uk"),
    name: text("name").notNull(),
    // `type` and `lifecycle` are the Stage 0 columns. They are retained so existing
    // reads keep working; `siteTypeValue` and `status` are the Stage 2 replacements
    // and are kept in step by the repository until Stage 3 retires the originals.
    type: text("type").notNull(),
    region: text("region").notNull().default("UK"),
    lifecycle: text("lifecycle").notNull().default("Current"),
    address: text("address").notNull(),
    manager: text("manager"),

    // X1 — identity and placement
    slug: text("slug"),
    code: text("code"),
    siteTypeValue: text("site_type_value"),
    status: text("status").notNull().default("active"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    postcode: text("postcode"),
    country: text("country").notNull().default("United Kingdom"),
    latitude: real("latitude"),
    longitude: real("longitude"),
    position: integer("position").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),

    // X2 — contacts
    managerName: text("manager_name"),
    managerPhone: text("manager_phone"),
    managerEmail: text("manager_email"),
    landlord: text("landlord"),
    managingAgent: text("managing_agent"),
    outOfHoursContact: text("out_of_hours_contact"),

    // X3 — access, split into four fields because the monday `Access Request`
    // column mixed emails, portal URLs, phone numbers and "N/A" in one cell.
    accessMethod: text("access_method"),
    accessContact: text("access_contact"),
    accessUrl: text("access_url"),
    accessNotes: text("access_notes"),

    // X4 — operating detail
    openingHours: text("opening_hours"),
    deliveryRestrictions: text("delivery_restrictions"),
    parkingNotes: text("parking_notes"),
    keyAlarmNotes: text("key_alarm_notes"),

    // X5 — lease. Money is stored in integer pence, never a float.
    leaseStart: text("lease_start"),
    leaseEnd: text("lease_end"),
    breakClause: text("break_clause"),
    rentReview: text("rent_review"),
    serviceChargePence: integer("service_charge_pence"),

    /*
     * What this site is expected to spend on maintenance in a year, in pence.
     *
     * Per SITE rather than per portfolio, because that is the level the
     * business actually sets one at and because a portfolio figure is then
     * just the sum — going the other way, splitting one number across ten
     * stores, would be invention. A portfolio with some sites unset reports
     * partial cover rather than pretending the missing ones are zero.
     *
     * Pence, like `service_charge_pence`, so money is never a float.
     * NULL means "no budget set", which is different from a budget of zero and
     * is displayed differently.
     */
    annualBudgetPence: integer("annual_budget_pence"),

    // X11 — monday name reconciliation. Both boards describe the same sites
    // under different names; the importer matches on either.
    mondayMaintenanceName: text("monday_maintenance_name"),
    mondayComplianceName: text("monday_compliance_name"),

    notes: text("notes"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("sites_organisation_idx").on(table.organisationId),
    index("sites_lifecycle_idx").on(table.lifecycle),
    index("sites_organisation_status_idx").on(table.organisationId, table.status),
    index("sites_organisation_position_idx").on(table.organisationId, table.position),
    uniqueIndex("sites_organisation_slug_idx").on(table.organisationId, table.slug),
    // A code identifies a site to job intake — `resolveSiteByName` matches on it
    // and returns the first row that does — so two sites may not share one. The
    // application check gives the friendly 409; this is what actually holds the
    // invariant against a concurrent create or an import that bypasses the check.
    // NULL is distinct from NULL under UNIQUE, so uncoded sites are unaffected.
    uniqueIndex("sites_organisation_code_idx").on(table.organisationId, table.code),
  ],
);

// X11 — unlimited additional aliases beyond the two named monday columns, so
// that U9 can resolve any historic spelling to one canonical site.
export const siteAliases = sqliteTable(
  "site_aliases",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    siteId: text("site_id").notNull().references(() => sites.id),
    alias: text("alias").notNull(),
    normalised: text("normalised").notNull(),
    source: text("source").notNull().default("manual"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("site_aliases_site_idx").on(table.siteId),
    uniqueIndex("site_aliases_organisation_normalised_idx").on(
      table.organisationId,
      table.normalised,
    ),
  ],
);

// X14 — unlimited admin-managed reporting groups. A site may belong to several
// (a region and a portfolio), so membership is a join, not a column.
export const siteGroups = sqliteTable(
  "site_groups",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    kind: text("kind").notNull().default("region"),
    colourHex: text("colour_hex").notNull().default("#12B4A8"),
    position: integer("position").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("site_groups_organisation_slug_idx").on(table.organisationId, table.slug),
    index("site_groups_organisation_position_idx").on(table.organisationId, table.position),
  ],
);

export const siteGroupMembers = sqliteTable(
  "site_group_members",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    siteGroupId: text("site_group_id").notNull().references(() => siteGroups.id),
    siteId: text("site_id").notNull().references(() => sites.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("site_group_members_pair_idx").on(table.siteGroupId, table.siteId),
    index("site_group_members_site_idx").on(table.siteId),
  ],
);

// X12/X13 — every import-time correction and every rejected placeholder is
// recorded here rather than applied silently. Compliance and site data are
// legally significant, so nothing is auto-corrected without a visible trail.
export const importAnomalies = sqliteTable(
  "import_anomalies",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    batchId: text("batch_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    sourceName: text("source_name"),
    kind: text("kind").notNull(),
    field: text("field"),
    originalValue: text("original_value"),
    appliedValue: text("applied_value"),
    detail: text("detail"),
    resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
    resolvedBy: text("resolved_by"),
    resolvedAt: text("resolved_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("import_anomalies_organisation_idx").on(table.organisationId),
    index("import_anomalies_batch_idx").on(table.batchId),
    index("import_anomalies_resolved_idx").on(table.organisationId, table.resolved),
  ],
);

export const organisations = sqliteTable("organisations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logoUrl: text("logo_url"),
  primaryColour: text("primary_colour").notNull().default("#12B4A8"),
  planTier: text("plan_tier").notNull().default("development"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    email: text("email").notNull().unique(),
    fullName: text("full_name"),
    role: text("role").notNull().default("client_user"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("users_organisation_idx").on(table.organisationId)],
);

export const units = sqliteTable(
  "units",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    siteId: text("site_id").notNull().references(() => sites.id),
    name: text("name").notNull(),
    category: text("category").notNull(),
    manufacturer: text("manufacturer"),
    model: text("model"),
    serialNumber: text("serial_number"),
    status: text("status").notNull().default("Active"),
    notes: text("notes"),

    // W5 — asset register detail
    assetTag: text("asset_tag"),
    locationInSite: text("location_in_site"),
    installedAt: text("installed_at"),
    warrantyExpiry: text("warranty_expiry"),
    purchasePricePence: integer("purchase_price_pence"),
    supplier: text("supplier"),
    lastServicedAt: text("last_serviced_at"),
    nextServiceDueAt: text("next_service_due_at"),
    serviceIntervalMonths: integer("service_interval_months"),
    position: integer("position").notNull().default(0),

    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("units_organisation_idx").on(table.organisationId),
    index("units_site_idx").on(table.siteId),
    index("units_next_service_idx").on(table.organisationId, table.nextServiceDueAt),
  ],
);

// W5 — service history. One row per visit, so a unit's record is a timeline
// rather than a single overwritten "last serviced" field.
export const unitServiceRecords = sqliteTable(
  "unit_service_records",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    unitId: text("unit_id").notNull().references(() => units.id),
    siteId: text("site_id").notNull().references(() => sites.id),
    performedAt: text("performed_at").notNull(),
    serviceType: text("service_type").notNull().default("Service"),
    contractorId: text("contractor_id"),
    contractorName: text("contractor_name"),
    requestId: text("request_id"),
    outcome: text("outcome"),
    costPence: integer("cost_pence"),
    notes: text("notes"),
    recordedByEmail: text("recorded_by_email"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("unit_service_unit_idx").on(table.unitId, table.performedAt),
    index("unit_service_organisation_idx").on(table.organisationId),
  ],
);

export const contractors = sqliteTable(
  "contractors",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    /*
     * A second number, because WhatsApp is how a lot of these trades actually
     * answer. It is deliberately NOT derived from `phone`: a contractor's
     * landline is not on WhatsApp, and the office number they answer calls on
     * is often not the mobile the coordinator messages. Copying one into the
     * other would produce a button that opens on "the phone number shared via
     * url is invalid", which is worse than no button.
     *
     * Nullable and additive — every existing row reads NULL, which is "no
     * WhatsApp", and every screen behaves exactly as it did before. Stored as
     * typed; `app/lib/contact-links.ts` decides whether what was typed can be
     * resolved to an international number, and refuses rather than guessing a
     * country code.
     */
    whatsappNumber: text("whatsapp_number"),
    /*
     * The person, as distinct from the company. "Call Apex Electrical" is not
     * an instruction anybody can follow at 7am with water coming through a
     * ceiling; "call Dan at Apex" is.
     */
    contactName: text("contact_name"),
    address: text("address"),
    notes: text("notes"),
    /** Pence, like every other money column here, so nothing has to round. */
    dayRatePence: integer("day_rate_pence"),
    /*
     * The rest of the agreed commercial terms. All pence, all nullable: a
     * contractor you have only a day rate for reads NULL for the others and
     * every screen draws exactly what it drew before.
     *
     * These are AGREED TERMS, not money spent. Nothing sums them into a
     * dashboard: without days worked, hours worked or call-outs used, adding
     * a day rate to an hourly rate would invent a number nobody owes. Actual
     * contractor spend is summed from real job cost attributed through
     * `maintenance_requests.contractor_id` — see the Reports surface.
     */
    callOutCostPence: integer("call_out_cost_pence"),
    hourlyRatePence: integer("hourly_rate_pence"),
    otherCostPence: integer("other_cost_pence"),
    /** What the "other" cost is for; without it the number is unreadable. */
    otherCostLabel: text("other_cost_label"),
    /*
     * "Payment details", in the only shape that is safe to hold here. Terms
     * are an option-backed string ("30 days", "On completion"); the finance
     * reference points at the supplier record in the accounting system that
     * already holds the bank details under its own controls.
     *
     * There is deliberately no account number, sort code, IBAN or card column.
     * This repository is public, and a stolen accounting reference buys an
     * attacker nothing, which is not true of a sort code.
     */
    paymentTerms: text("payment_terms"),
    financeReference: text("finance_reference"),
    /*
     * Who the insurance is with, and under which policy. `insuranceExpiry`
     * alone could say a date but never which cover it was the end of.
     */
    insurerName: text("insurer_name"),
    policyNumber: text("policy_number"),
    insuranceNotes: text("insurance_notes"),
    /** The contractor's own postcode. `address` is one free-text line and
     * nothing ever parsed one out of it. */
    postcode: text("postcode"),
    serviceCategories: text("service_categories").notNull().default("[]"),
    coverageAreas: text("coverage_areas").notNull().default("[]"),
    certifications: text("certifications").notNull().default("[]"),
    insuranceExpiry: text("insurance_expiry"),
    availability: text("availability").notNull().default("Available"),
    rating: real("rating"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("contractors_organisation_idx").on(table.organisationId)],
);

export const maintenanceRequests = sqliteTable(
  "maintenance_requests",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    legacyClientId: text("client_id").notNull().default("sunnamusk-uk"),
    /*
     * Nullable — a job whose site is not yet known has no site. Still no
     * foreign key: an existing SQLite database cannot be relaxed in place, so
     * it keeps its sentinels, and a constraint only one dialect could carry
     * would put the two permanently out of step on a table where they currently
     * match column for column.
     */
    siteId: text("site_id"),
    source: text("source").notNull().default("Portal form"),
    title: text("title").notNull(),
    reference: text("reference"),
    /**
     * The row's id on the system it was imported from — monday's item id.
     *
     * The only stable thing to match a re-import on. Titles are not unique on a
     * real board: the Maintenance board names every form submission "Incoming
     * form answer", so matching by title folded 713 distinct jobs onto the rows
     * already present. Null for anything created in the app rather than
     * imported.
     */
    externalId: text("external_id"),
    completionRequestedAt: text("completion_requested_at"),
    completionRequestedBy: text("completion_requested_by"),
    completionNote: text("completion_note"),
    /**
     * The contractor's signature at completion — Stage 23, K.
     *
     * A PNG data URL, and deliberately not an `attachments` row: a signature
     * is a few kilobytes, it is not evidence of the work, and filing it as an
     * attachment would put it in the photo columns, the media viewer and the
     * client's evidence pack. Bounded server-side.
     */
    completionSignature: text("completion_signature"),
    completionSignedAt: text("completion_signed_at"),
    completionSignedBy: text("completion_signed_by"),
    blockedReason: text("blocked_reason"),
    notifiedAt: text("notified_at"),
    notifyAttempts: integer("notify_attempts").notNull().default(0),
    parentId: text("parent_id"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    archivedAt: text("archived_at"),
    /**
     * Stage 23 — the recycle bin. NULL means the row is live.
     *
     * This column reverses a decision this schema previously made on purpose:
     * that every delete is a real DELETE and nothing is recoverable. The owner
     * asked for monday's behaviour instead — "when someone deleted something we
     * should have backup for 30 days" — so a deleted job now keeps its row, its
     * cells, its attachments and its history, and `recycle_bin` holds the
     * placement needed to put it back. See `recycleBin` below.
     *
     * EVERY read of this table that is not the bin itself must exclude rows
     * where this is set, or the board silently keeps showing deleted jobs.
     */
    deletedAt: text("deleted_at"),
    deletedBy: text("deleted_by"),
    description: text("description").notNull(),
    location: text("location").notNull(),
    requester: text("requester").notNull(),
    contact: text("contact").notNull(),
    category: text("category").notNull(),
    engineer: text("engineer").notNull(),
    tier: integer("tier").notNull().default(2),
    priority: text("priority").notNull().default("Medium"),
    stage: text("stage").notNull().default("Incoming"),
    status: text("status").notNull().default("Pending Approval"),
    contractor: text("contractor"),
    /*
     * The canonical reference beside the legacy text above, which is never
     * touched. The text records who was named on the job; this records who they
     * are in the register. Removing a contractor drops the reference and keeps
     * the name, so a completed job never disappears because somebody tidied.
     */
    contractorId: text("contractor_id").references(() => contractors.id, {
      onDelete: "set null",
    }),
    assignee: text("assignee"),
    requestedAt: text("requested_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    dueAt: text("due_at"),
    completedAt: text("completed_at"),
    nextUpdateAt: text("next_update_at"),
    cost: real("cost"),
    approvedBy: text("approved_by"),
    invoice: text("invoice"),
    attachmentCount: integer("attachment_count").notNull().default(0),
    issueAttachmentCount: integer("issue_attachment_count")
      .notNull()
      .default(0),
    completedAttachmentCount: integer("completed_attachment_count")
      .notNull()
      .default(0),
    generalAttachmentCount: integer("general_attachment_count")
      .notNull()
      .default(0),
    formUrl: text("form_url"),
    publicUploadTokenHash: text("public_upload_token_hash"),
    publicUploadTokenExpiresAt: text("public_upload_token_expires_at"),
    commentCount: integer("comment_count").notNull().default(0),
    createdByEmail: text("created_by_email"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("maintenance_organisation_stage_idx").on(table.organisationId, table.stage),
    index("maintenance_site_idx").on(table.siteId),
    index("maintenance_contractor_idx").on(table.organisationId, table.contractorId),
    index("maintenance_priority_idx").on(table.priority),
    // Kept in step with db/init.ts, which is what actually runs: CREATE INDEX
    // IF NOT EXISTS matches on name, so an index declared only here can never
    // be applied to a database the bootstrap has already touched.
    index("maintenance_org_archived_created_idx").on(
      table.organisationId,
      table.archived,
      table.createdAt,
    ),
    index("maintenance_org_requested_idx").on(
      table.organisationId,
      table.requestedAt,
    ),
  ],
);

export const plannedMaintenance = sqliteTable(
  "planned_maintenance",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    legacyClientId: text("client_id").notNull().default("sunnamusk-uk"),
    siteId: text("site_id").notNull().references(() => sites.id),
    unitId: text("unit_id").references(() => units.id),
    contractorId: text("contractor_id").references(() => contractors.id),
    title: text("title").notNull(),
    category: text("category").notNull(),
    frequency: text("frequency").notNull(),
    nextDueAt: text("next_due_at").notNull(),
    lastCompletedAt: text("last_completed_at"),
    status: text("status").notNull().default("Scheduled"),
    reminderDays: integer("reminder_days").notNull().default(30),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("planned_maintenance_organisation_idx").on(table.organisationId),
    index("planned_maintenance_site_idx").on(table.siteId),
    index("planned_maintenance_due_idx").on(table.nextDueAt),
  ],
);

export const quotations = sqliteTable(
  "quotations",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    requestId: text("request_id").notNull().references(() => maintenanceRequests.id),
    contractorId: text("contractor_id").references(() => contractors.id),
    amount: real("amount").notNull(),
    status: text("status").notNull().default("Awaiting approval"),
    attachmentId: text("attachment_id"),
    submittedAt: text("submitted_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    approvedAt: text("approved_at"),
  },
  (table) => [
    index("quotations_organisation_idx").on(table.organisationId),
    index("quotations_request_idx").on(table.requestId),
  ],
);

export const invoices = sqliteTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    requestId: text("request_id").notNull().references(() => maintenanceRequests.id),
    contractorId: text("contractor_id").references(() => contractors.id),
    invoiceNumber: text("invoice_number"),
    amount: real("amount").notNull(),
    status: text("status").notNull().default("Awaiting payment"),
    dueAt: text("due_at"),
    paidAt: text("paid_at"),
    attachmentId: text("attachment_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("invoices_organisation_idx").on(table.organisationId),
    index("invoices_request_idx").on(table.requestId),
  ],
);

export const systemNotifications = sqliteTable(
  "system_notifications",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    userEmail: text("user_email").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    event: text("event").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    readAt: text("read_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("system_notifications_organisation_idx").on(table.organisationId),
    index("system_notifications_user_idx").on(table.userEmail, table.readAt),
    index("system_notifications_entity_idx").on(table.entityType, table.entityId),
  ],
);

export const leads = sqliteTable(
  "leads",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    name: text("name").notNull(),
    company: text("company").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    siteRange: text("site_range").notNull(),
    services: text("services").notNull(),
    regions: text("regions").notNull(),
    challenge: text("challenge").notNull(),
    status: text("status").notNull().default("New"),
    notifiedAt: text("notified_at"),
    notifyAttempts: integer("notify_attempts").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("leads_organisation_idx").on(table.organisationId),
    index("leads_created_idx").on(table.createdAt),
  ],
);

/**
 * An application from the public /contractors page.
 *
 * SEPARATE FROM `leads`, and the reason is not tidiness. A lead is a
 * prospective client and this is a prospective supplier: different people read
 * them, they are answered differently, and this carries four things a lead has
 * no column for — whether they hold public liability cover, how long they have
 * traded, what they are certified for, and a recorded consent. Folding them
 * together would have meant packing structured answers into `challenge` as
 * prose and teaching every reader of that column to unpack them again.
 *
 * `insured` is the string "Yes" or "No" rather than a boolean because the form
 * asks a question with two named answers and an unanswered one is refused; a
 * boolean would make "not stated" indistinguishable from "No".
 */
export const contractorApplications = sqliteTable(
  "contractor_applications",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    company: text("company").notNull(),
    contactName: text("contact_name").notNull(),
    email: text("email").notNull(),
    phone: text("phone").notNull(),
    /** JSON array of trades, validated against a fixed list server-side. */
    trades: text("trades").notNull(),
    regions: text("regions").notNull(),
    insured: text("insured").notNull(),
    yearsTrading: text("years_trading"),
    certifications: text("certifications"),
    notes: text("notes"),
    /** Recorded, because "they agreed" is a claim that needs a row behind it. */
    consent: integer("consent", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("New"),
    notifiedAt: text("notified_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("contractor_applications_created_idx").on(table.organisationId, table.createdAt),
  ],
);

export const maintenanceGroups = sqliteTable(
  "maintenance_groups",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    legacyClientId: text("client_id").notNull().default("sunnamusk-uk"),
    boardId: text("board_id").notNull().default("maintenance"),
    name: text("name").notNull(),
    color: text("color").notNull().default("#579bfc"),
    stageKey: text("stage_key"),
    collapsed: integer("collapsed", { mode: "boolean" }).notNull().default(false),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    /** Stage 23 — see `maintenanceRequests.deletedAt`. NULL means live. */
    deletedAt: text("deleted_at"),
    deletedBy: text("deleted_by"),
    description: text("description"),
    position: integer("position").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("maintenance_groups_board_idx").on(table.organisationId, table.boardId),
    uniqueIndex("maintenance_groups_board_position_idx").on(
      table.organisationId,
      table.boardId,
      table.position,
    ),
  ],
);

export const maintenanceGroupItems = sqliteTable(
  "maintenance_group_items",
  {
    requestId: text("request_id")
      .primaryKey()
      .references(() => maintenanceRequests.id),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    legacyClientId: text("client_id").notNull().default("sunnamusk-uk"),
    boardId: text("board_id").notNull().default("maintenance"),
    groupId: text("group_id")
      .notNull()
      .references(() => maintenanceGroups.id),
    position: integer("position").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("maintenance_group_items_group_idx").on(
      table.organisationId,
      table.boardId,
      table.groupId,
      table.position,
    ),
  ],
);

export const maintenanceBoardOptions = sqliteTable(
  "maintenance_board_options",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    legacyClientId: text("client_id").notNull().default("sunnamusk-uk"),
    boardId: text("board_id").notNull().default("maintenance"),
    columnKey: text("column_key").notNull(),
    value: text("value").notNull(),
    label: text("label").notNull(),
    color: text("color").notNull().default("#579bfc"),
    textColor: text("text_color").notNull().default("#ffffff"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    system: integer("system", { mode: "boolean" }).notNull().default(false),
    position: integer("position").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("maintenance_board_options_column_idx").on(
      table.organisationId,
      table.boardId,
      table.columnKey,
      table.position,
    ),
    uniqueIndex("maintenance_board_options_value_idx").on(
      table.organisationId,
      table.boardId,
      table.columnKey,
      table.value,
    ),
  ],
);

export const maintenanceBoardColumns = sqliteTable(
  "maintenance_board_columns",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    legacyClientId: text("client_id").notNull().default("sunnamusk-uk"),
    boardId: text("board_id").notNull().default("maintenance"),
    key: text("column_key").notNull(),
    title: text("title").notNull(),
    type: text("type").notNull(),
    position: integer("position").notNull().default(0),
    width: integer("width").notNull().default(160),
    settings: text("settings").notNull().default("{}"),
    system: integer("system", { mode: "boolean" }).notNull().default(false),
    visible: integer("visible", { mode: "boolean" }).notNull().default(true),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    summary: text("summary"),
    optionSetKey: text("option_set_key"),
    description: text("description"),
    /**
     * In the recycle bin since this moment, or NULL for a live column.
     *
     * The same shape `maintenanceGroups` and `maintenanceRequests` already
     * carry, and for the same reason: the row and everything hanging off it —
     * every cell, every file, the type, the width, the position, the pin, the
     * summary function — stay exactly where they are, and one nullable field
     * decides whether the board can see them. A column's data is its cells, and
     * there are thousands of them; no snapshot in `recycle_bin.placement` could
     * hold those, which is why the earlier answer here was "not recoverable".
     *
     * The row also keeps its KEY, which matters: the unique index below is on
     * (organisation, board, column_key), so a binned column still holds its key
     * and a new column with the same title is given a suffixed one. That is
     * what makes a restore thirty days later safe rather than a constraint
     * violation.
     */
    deletedAt: text("deleted_at"),
    deletedBy: text("deleted_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("maintenance_board_columns_position_idx").on(
      table.organisationId,
      table.boardId,
      table.position,
    ),
    uniqueIndex("maintenance_board_columns_key_idx").on(
      table.organisationId,
      table.boardId,
      table.key,
    ),
  ],
);

export const maintenanceBoardCells = sqliteTable(
  "maintenance_board_cells",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    legacyClientId: text("client_id").notNull().default("sunnamusk-uk"),
    boardId: text("board_id").notNull().default("maintenance"),
    requestId: text("request_id")
      .notNull()
      .references(() => maintenanceRequests.id),
    columnId: text("column_id")
      .notNull()
      .references(() => maintenanceBoardColumns.id),
    value: text("value").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("maintenance_board_cells_request_idx").on(
      table.organisationId,
      table.boardId,
      table.requestId,
    ),
    uniqueIndex("maintenance_board_cells_value_idx").on(
      table.organisationId,
      table.boardId,
      table.requestId,
      table.columnId,
    ),
  ],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    legacyClientId: text("client_id").notNull().default("sunnamusk-uk"),
    requestId: text("request_id").references(() => maintenanceRequests.id),
    siteId: text("site_id"),
    unitId: text("unit_id"),
    kind: text("kind").notNull().default("issue"),
    boardColumnId: text("board_column_id"),
    /*
     * The comment this file was attached to, when it was.
     *
     * monday's updates carry their own assets — a quote PDF, a photo of the
     * part — and they belong to the comment, not loosely to the job. Without
     * this the file has nowhere to hang and several imported comments read as
     * orphans, naming a document ("Pro forma-0005585.pdf") that appears
     * nowhere on screen.
     *
     * NULL for the ordinary case: a file attached to the job itself.
     */
    updateId: text("update_id"),
    objectKey: text("object_key").notNull().unique(),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    uploadedByEmail: text("uploaded_by_email"),
    pending: integer("pending", { mode: "boolean" }).notNull().default(false),
    submittedVia: text("submitted_via"),
    reviewedAt: text("reviewed_at"),
    reviewedBy: text("reviewed_by"),
    /*
     * WORKSTREAM 7 — a document's own identity, separate from its bytes.
     *
     * Until these existed an attachment was only ever "the file that happens to
     * hang off this cell": its name was the uploader's filename, it had no type
     * anyone could filter on, no expiry the compliance register could read, and
     * no way to say that one PDF supersedes another. Every one of the official
     * criteria W07-02, 03, 05, 07, 10, 11 and 12 needed a column that was not
     * there.
     *
     * `title` is a DISPLAY name and `original_name` stays the byte-truth: the
     * file a person downloads must keep the name it was uploaded under, or the
     * copy on their disk stops matching the register.
     */
    title: text("title"),
    documentType: text("document_type"),
    description: text("description"),
    /*
     * `YYYY-MM-DD` and nothing else. The Postgres side carries a CHECK
     * constraint saying so, which means a malformed date is a DATABASE ERROR
     * rather than a bad row — so every writer must normalise through
     * `dateOnlyValue` and answer 400 before the insert. See the note on
     * `expiryRefusal` in app/api/files/document-fields.ts.
     */
    expiryDate: text("expiry_date"),
    /*
     * `timestamptz` on Postgres, declared `text` here.
     *
     * This is the dual-build pattern `reviewedAt` above already uses, and it is
     * deliberate rather than lazy: this file is compiled for BOTH the SQLite
     * build and the Postgres one, drizzle's sqlite `integer({mode:"timestamp"})`
     * would emit an integer comparison against a timestamptz column, and the
     * only thing either build ever does with these values is write an ISO
     * string and hand it back. Text is what both dialects agree on.
     */
    metadataUpdatedAt: text("metadata_updated_at"),
    metadataUpdatedBy: text("metadata_updated_by"),
    /*
     * WHOSE document this is, when it is nobody's job.
     *
     * A contractor's public liability certificate is not evidence about a work
     * order — it is a fact about the contractor — and before this column the
     * upload route refused it outright, because `requestId` was mandatory. See
     * the anchor rule in `app/api/files/anchors.ts`.
     */
    contractorId: text("contractor_id"),
    /** Soft removal. NULL means live; a timestamp means archived, not destroyed. */
    archivedAt: text("archived_at"),
    archivedBy: text("archived_by"),
    /*
     * VERSION LINEAGE.
     *
     * `root_document_id` names the FIRST version of a document; version 1 is
     * self-rooted (NULL, resolved as `coalesce(root_document_id, id)`), so
     * nothing had to be back-filled to adopt this. `version_no` counts up from
     * 1 and `is_current` marks the single head.
     *
     * Two UNIQUE indexes on the Postgres side enforce what code must not be
     * trusted to remember:
     *   attachments_current_version_idx  UNIQUE (coalesce(root_document_id, id))
     *                                    WHERE is_current  — ONE head, ever.
     *   attachments_root_version_idx     UNIQUE (coalesce(root_document_id, id),
     *                                    version_no)        — no duplicate n.
     * So a new version MUST clear its predecessor's `is_current` in the same
     * transaction, and a concurrent `max + 1` LOSES and must retry rather than
     * mint a second version 4. Being rejected is the feature: it is the database
     * refusing to hold two current versions of one certificate, which is the
     * state that would make the compliance register count a document twice.
     */
    rootDocumentId: text("root_document_id"),
    versionNo: integer("version_no").notNull().default(1),
    isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("attachments_organisation_idx").on(table.organisationId),
    index("attachments_request_idx").on(table.requestId),
    index("attachments_site_idx").on(table.siteId),
    index("attachments_contractor_idx").on(table.contractorId),
    index("attachments_root_idx").on(table.rootDocumentId),
    index("attachments_expiry_idx").on(table.expiryDate),
    index("attachments_unit_idx").on(table.unitId),
    index("attachments_update_idx").on(table.updateId),
    index("attachments_board_column_idx").on(
      table.boardColumnId,
      table.requestId,
    ),
  ],
);

export const complianceDocuments = sqliteTable(
  "compliance_documents",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    legacyClientId: text("client_id").notNull().default("sunnamusk-uk"),
    siteId: text("site_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("Missing"),
    expiryDate: text("expiry_date"),
    attachmentId: text("attachment_id").references(() => attachments.id),
    notRequired: integer("not_required", { mode: "boolean" })
      .notNull()
      .default(false),
    lastAlertAt: text("last_alert_at"),
    lastAlertStage: text("last_alert_stage"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("compliance_organisation_idx").on(table.organisationId),
    index("compliance_site_kind_idx").on(table.siteId, table.kind),
    index("compliance_expiry_idx").on(table.expiryDate),
  ],
);

export const activityLog = sqliteTable(
  "activity_log",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    legacyClientId: text("client_id").notNull().default("sunnamusk-uk"),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    actorEmail: text("actor_email"),
    detail: text("detail"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("activity_organisation_idx").on(table.organisationId),
    index("activity_entity_idx").on(table.entityType, table.entityId),
    index("activity_created_idx").on(table.createdAt),
  ],
);

export const workspaceSettings = sqliteTable(
  "workspace_settings",
  {
    legacyClientId: text("client_id").primaryKey().default("sunnamusk-uk"),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    settings: text("settings").notNull().default("{}"),
    updatedByEmail: text("updated_by_email"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("workspace_settings_organisation_idx").on(table.organisationId)],
);

export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    role: text("role").notNull(),
    siteScope: text("site_scope"),
    approvalLimitPence: integer("approval_limit_pence"),
    status: text("status").notNull().default("active"),
    invitedBy: text("invited_by"),
    acceptedAt: text("accepted_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("memberships_user_organisation_idx").on(table.userId, table.organisationId),
    index("memberships_organisation_idx").on(table.organisationId),
  ],
);

export const optionSets = sqliteTable(
  "option_sets",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("option_sets_organisation_key_idx").on(table.organisationId, table.key),
  ],
);

export const optionValues = sqliteTable(
  "option_values",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    optionSetId: text("option_set_id").notNull().references(() => optionSets.id),
    value: text("value").notNull(),
    label: text("label").notNull(),
    colourHex: text("colour_hex").notNull(),
    textColour: text("text_colour").notNull().default("#ffffff"),
    position: integer("position").notNull().default(0),
    isDone: integer("is_done", { mode: "boolean" }).notNull().default(false),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    system: integer("system", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("option_values_set_position_idx").on(table.organisationId, table.optionSetId, table.position),
    uniqueIndex("option_values_set_value_idx").on(table.organisationId, table.optionSetId, table.value),
  ],
);


/**
 * Boards — Stage 3, item O1.
 *
 * Until now `board_id` was the literal string "maintenance" everywhere. This
 * makes it a real record so an organisation can run more than one board, and
 * so item references can be issued per board.
 */
export const boards = sqliteTable(
  "boards",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind").notNull().default("maintenance"),
    itemNoun: text("item_noun").notNull().default("Job"),
    referencePrefix: text("reference_prefix").notNull().default("MS"),
    referenceCounter: integer("reference_counter").notNull().default(0),
    position: integer("position").notNull().default(0),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("boards_org_key_idx").on(table.organisationId, table.key),
    index("boards_org_idx").on(table.organisationId),
  ],
);

/** Item comments — powers the board's update bubble (AA16). Group V extends. */
export const itemUpdates = sqliteTable(
  "item_updates",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    boardId: text("board_id").notNull().default("maintenance"),
    requestId: text("request_id").notNull(),
    parentId: text("parent_id"),
    authorName: text("author_name").notNull(),
    authorEmail: text("author_email"),
    body: text("body").notNull(),
    editedAt: text("edited_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("item_updates_request_idx").on(table.organisationId, table.requestId)],
);

/**
 * `👍 Like` on an update or a reply — monday has it, and the app did not.
 *
 * A ROW PER PERSON, not a counter on `item_updates`. Two things the panel draws
 * cannot be answered by a number: whether YOU have liked this one (the thumb is
 * filled if you have) and who the others were (the names on hover). A counter
 * also has the `issue_attachment_count` problem — two writers, no reconciler,
 * and it drifts. The count here is a COUNT.
 *
 * Keyed on the actor's EMAIL rather than a user id because the thread's authors
 * are not all workspace users: 265 of these updates were imported from monday
 * and their authors have no row in `users`. A like is always written by someone
 * signed in, so the email is always present — but keeping the key the same
 * shape as `item_updates.author_email` means the two can be compared without a
 * join that would fail on exactly the historic rows people read most.
 *
 * The primary key is the pair, so liking twice is idempotent at the storage
 * layer and a double-tap cannot inflate the count.
 */
export const itemUpdateLikes = sqliteTable(
  "item_update_likes",
  {
    updateId: text("update_id").notNull(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    actorEmail: text("actor_email").notNull(),
    actorName: text("actor_name").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.updateId, table.actorEmail] }),
    index("item_update_likes_update_idx").on(table.organisationId, table.updateId),
  ],
);

/** Per-item change log — who changed what, from what, to what, when. */
export const itemActivity = sqliteTable(
  "item_activity",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    boardId: text("board_id").notNull().default("maintenance"),
    requestId: text("request_id").notNull(),
    actorName: text("actor_name").notNull(),
    columnKey: text("column_key"),
    action: text("action").notNull(),
    valueBefore: text("value_before"),
    valueAfter: text("value_after"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("item_activity_request_idx").on(table.organisationId, table.requestId)],
);


/** Saved board views — Stage 5, items P1 and AA3–AA7. */
export const boardViews = sqliteTable(
  "board_views",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    boardId: text("board_id").notNull().default("maintenance"),
    key: text("key").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull().default("table"),
    icon: text("icon"),
    filters: text("filters").notNull().default("[]"),
    sort: text("sort").notNull().default("[]"),
    settings: text("settings").notNull().default("{}"),
    position: integer("position").notNull().default(0),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    system: integer("system", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("board_views_org_key_idx").on(table.organisationId, table.boardId, table.key),
    index("board_views_org_position_idx").on(table.organisationId, table.boardId, table.position),
  ],
);


/**
 * The editable form configuration behind a Form view — the form builder's store.
 *
 * WHY A TABLE RATHER THAN `board_views.settings`
 *
 * A Form view already has a `settings` JSON blob, and putting the form config
 * there was the obvious first move. It is wrong for three reasons that only
 * show up once the form is SHARED:
 *
 *  1. `share_token` has to be unique and indexed. It is the primary lookup key
 *     for every public request, and you cannot index inside a JSON blob — every
 *     hit on a public form would table-scan `board_views`.
 *  2. The public form is read by anonymous visitors. Keeping it in its own table
 *     means the public reader never touches the row that carries a view's
 *     filters, sorts and column layout, so there is no way to leak them.
 *  3. `password_hash` must never reach the browser. A column can be omitted from
 *     a SELECT; a key buried in a JSON blob has to be stripped by hand on every
 *     read path, and the one place somebody forgets is the leak.
 *
 * `config` holds the parts with no query obligations — questions, appearance,
 * the feature toggles — seeded from `maintenanceFormConfiguration`. The columns
 * beside it are the fields something actually filters, joins or counts on.
 */
export const formConfigurations = sqliteTable(
  "form_configurations",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    boardId: text("board_id").notNull().default("maintenance"),
    /** Which Form view this belongs to — `board_views.key`. */
    viewKey: text("view_key").notNull().default("form"),

    /* ---- Identity, denormalised out of `config` so lists need no JSON parse. */
    title: text("title").notNull(),
    description: text("description"),

    /*
     * The public link. Unguessable and unique; this is what /f/:token resolves.
     * Stored in the clear on purpose — unlike a session token it is a locator,
     * not a credential, and monday's own form URLs work the same way. What
     * protects a form is `active`, `require_login` and `password_hash`.
     */
    shareToken: text("share_token").notNull(),

    /*
     * The "Shorten URL" alias — monday serves these from wkf.ms, we serve both
     * from /f/. Twelve hex characters rather than sixty-four: a short link is
     * pasted into a WhatsApp message and read off a phone, and 48 bits is still
     * far past guessing for a form whose whole purpose is to be handed out.
     *
     * It is a SECOND locator for the same form, not a replacement. Both resolve,
     * so turning the toggle off does not break links already sent.
     */
    shortToken: text("short_token"),

    /*
     * "Deactivate form". A deactivated form still resolves — the public page
     * answers "this form is no longer accepting responses" rather than 404, so
     * somebody following an old link learns why instead of thinking it broke.
     */
    active: integer("active", { mode: "boolean" }).notNull().default(true),

    /* ---- Access control. Columns, not JSON — see the note above. ---------- */
    requireLogin: integer("require_login", { mode: "boolean" }).notNull().default(false),
    /** Salted hash. NULL means no password. The plaintext is never stored. */
    passwordHash: text("password_hash"),

    /*
     * Response limit and close date. Both are enforced server-side on submit;
     * a disabled limit is NULL rather than 0, because 0 is a real limit that
     * means "accept nothing".
     */
    responseLimit: integer("response_limit"),
    closeAt: text("close_at"),
    /** Incremented per accepted submission, so the limit needs no COUNT(*). */
    responseCount: integer("response_count").notNull().default(0),

    /** Questions, appearance and the remaining feature flags, as JSON. */
    config: text("config").notNull().default("{}"),

    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("form_configurations_token_idx").on(table.shareToken),
    uniqueIndex("form_configurations_view_idx").on(
      table.organisationId,
      table.boardId,
      table.viewKey,
    ),
  ],
);


/** Delivery record for every notification — Stage 7, item J6. */
export const notificationLog = sqliteTable(
  "notification_log",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    channel: text("channel").notNull(),
    event: text("event").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id"),
    recipient: text("recipient").notNull(),
    subject: text("subject"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    providerId: text("provider_id"),
    deliveredAt: text("delivered_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("notification_log_org_idx").on(table.organisationId, table.createdAt),
    index("notification_log_subject_idx").on(
      table.organisationId,
      table.subjectType,
      table.subjectId,
    ),
  ],
);


/** Scoped, expiring links that let a contractor act on one job — Stage 9, Z1. */
export const jobAccessTokens = sqliteTable(
  "job_access_tokens",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    requestId: text("request_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    audience: text("audience").notNull().default("contractor"),
    label: text("label"),
    allowedKinds: text("allowed_kinds").notNull().default('["completion","nameplate"]'),
    canComment: integer("can_comment", { mode: "boolean" }).notNull().default(true),
    canRequestCompletion: integer("can_request_completion", { mode: "boolean" })
      .notNull()
      .default(true),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    createdBy: text("created_by"),
    firstOpenedAt: text("first_opened_at"),
    lastUsedAt: text("last_used_at"),
    useCount: integer("use_count").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("job_access_tokens_hash_idx").on(table.tokenHash),
    index("job_access_tokens_request_idx").on(table.organisationId, table.requestId),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Stage 20 — accounts, teams, permissions, audit and sidebar layout.
 *
 * Everything below exists because the workspace previously had no real notion
 * of a person. Identity came from a cookie the browser set for itself, which
 * made "each client sees only their own data" a convention rather than a rule.
 * A row here is the authority for who someone is, what they may do, and what
 * they did.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A signed-in session.
 *
 * The cookie carries a random token; only its hash is stored, so a leaked
 * database cannot be used to impersonate anyone. Sessions are revoked by
 * stamping `revoked_at` rather than deleting, so "signed out of all devices"
 * remains visible in the audit trail.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    /** The workspace this session is currently looking at, when it has chosen. */
    organisationId: text("organisation_id"),
    issuedAt: text("issued_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at"),
    revokedAt: text("revoked_at"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (table) => [
    uniqueIndex("sessions_token_idx").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId, table.expiresAt),
  ],
);

/**
 * An outstanding invitation to join a workspace.
 *
 * Holds the role the invitee will get, so accepting cannot escalate: the
 * membership is written from this row, not from anything the invitee sends.
 */
export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    email: text("email").notNull(),
    role: text("role").notNull().default("client"),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by"),
    message: text("message"),
    expiresAt: text("expires_at").notNull(),
    acceptedAt: text("accepted_at"),
    acceptedUserId: text("accepted_user_id"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("invitations_token_idx").on(table.tokenHash),
    index("invitations_organisation_idx").on(table.organisationId, table.email),
  ],
);

/**
 * A single-use, expiring link that lets one person set a new password.
 *
 * Shaped like `invitations` because it is the same object under a different
 * name: a credential handed out of band, revocable, and stored only as a hash.
 * There is no mail server here, so an administrator issues the link and passes
 * it on — the same delivery story as an invitation, and the same honesty about
 * it on screen.
 */
export const passwordResets = sqliteTable(
  "password_resets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    organisationId: text("organisation_id").references(() => organisations.id),
    tokenHash: text("token_hash").notNull(),
    issuedBy: text("issued_by"),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("password_resets_token_idx").on(table.tokenHash),
    index("password_resets_user_idx").on(table.userId, table.createdAt),
  ],
);

/** A named group of people inside one client workspace. */
export const teams = sqliteTable(
  "teams",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    colourHex: text("colour_hex").notNull().default("#12B4A8"),
    position: integer("position").notNull().default(0),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("teams_organisation_slug_idx").on(table.organisationId, table.slug),
  ],
);

export const teamMembers = sqliteTable(
  "team_members",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    teamId: text("team_id").notNull().references(() => teams.id),
    userId: text("user_id").notNull().references(() => users.id),
    /** "lead" or "member" — who to escalate to, not a permission. */
    teamRole: text("team_role").notNull().default("member"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("team_members_pair_idx").on(table.teamId, table.userId),
    index("team_members_user_idx").on(table.userId),
  ],
);

/**
 * What a role may do, per workspace.
 *
 * Stored rather than hardcoded so an admin can widen or narrow a role without a
 * deploy. A capability absent from this table falls back to the built-in
 * default for that role, so an empty table is a working system rather than a
 * locked-out one.
 */
export const roleCapabilities = sqliteTable(
  "role_capabilities",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    role: text("role").notNull(),
    capability: text("capability").notNull(),
    allowed: integer("allowed", { mode: "boolean" }).notNull().default(true),
    updatedBy: text("updated_by"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("role_capabilities_idx").on(table.organisationId, table.role, table.capability),
  ],
);

/**
 * Who did what.
 *
 * Deliberately separate from `activity_log`, which records changes to a
 * maintenance request for the people working it. This records changes to the
 * *system* — sign-ins, permission changes, invitations, deletions — for whoever
 * has to answer a question about them later. Append-only by contract: nothing
 * in the app updates or deletes a row here.
 */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id"),
    actorUserId: text("actor_user_id"),
    actorEmail: text("actor_email"),
    actorRole: text("actor_role"),
    /** Dotted verb: "user.invited", "session.signed_in", "board.item_deleted". */
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    summary: text("summary").notNull(),
    /** JSON. Before/after values where a change has them. */
    detail: text("detail"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("audit_events_organisation_idx").on(table.organisationId, table.createdAt),
    index("audit_events_actor_idx").on(table.actorEmail),
    index("audit_events_action_idx").on(table.action),
  ],
);

/**
 * How one person's sidebar is arranged.
 *
 * `user_id` NULL is the workspace default an admin sets; a row with a user id
 * is that person's own arrangement, which wins. `locked` names the items an
 * admin has pinned so a client cannot hide something they are required to see —
 * enforced when the layout is saved, not merely hidden in the UI.
 */
export const navigationLayouts = sqliteTable(
  "navigation_layouts",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    userId: text("user_id"),
    /** JSON array: [{ key, label, hidden, position, group }]. */
    items: text("items").notNull().default("[]"),
    /** JSON array of item keys an admin has locked on. */
    locked: text("locked").notNull().default("[]"),
    updatedBy: text("updated_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("navigation_layouts_scope_idx").on(table.organisationId, table.userId),
  ],
);

/**
 * Failed sign-in counters, shared across Worker isolates.
 *
 * Replaces a module-scope `Map`, which counted per isolate: five attempts each
 * across an unknown number of isolates, reset by every deploy. One row per
 * `email|ip`, so the limit is the limit.
 *
 * No organisation column, deliberately — a failed sign-in has no workspace,
 * the same reason `audit_events.organisation_id` is nullable. Times are epoch
 * milliseconds because the window and lockout arithmetic runs inside one SQL
 * statement, where integer comparison is exact.
 */
export const signInFailures = sqliteTable(
  "sign_in_failures",
  {
    /** `${email}|${ip}` — both, so this cannot lock someone out by address. */
    key: text("key").primaryKey(),
    count: integer("count").notNull().default(0),
    firstAt: integer("first_at").notNull().default(0),
    blockedUntil: integer("blocked_until").notNull().default(0),
  },
  (table) => [
    index("sign_in_failures_expiry_idx").on(table.blockedUntil, table.firstAt),
  ],
);

/**
 * How one person's dashboard is arranged.
 *
 * The same three-layer idea as `navigation_layouts`, and for the same reason: a
 * `user_id` of NULL is the workspace default an admin sets, a row with a user id
 * is that person's own arrangement and wins over it, and the built-in order is
 * the floor beneath both.
 *
 * `items` is an ARRANGEMENT, never an inventory. It records the order panels sit
 * in and which ones are hidden; whether a panel EXISTS comes from the widget
 * registry in the code. That is what lets a panel added in a later release
 * appear for someone who saved a layout last year, instead of vanishing because
 * their stored list did not mention it.
 */
export const dashboardLayouts = sqliteTable(
  "dashboard_layouts",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    userId: text("user_id"),
    /** Which surface: "overview" or "reports". */
    surface: text("surface").notNull().default("overview"),
    /** JSON array: [{ key, hidden }] in display order. */
    items: text("items").notNull().default("[]"),
    updatedBy: text("updated_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    // NULL is distinct from NULL in SQLite, so the workspace-default row cannot
    // be constrained here; the API enforces one default per surface.
    uniqueIndex("dashboard_layouts_scope_idx").on(
      table.organisationId,
      table.userId,
      table.surface,
    ),
  ],
);

/**
 * Sections the workspace owner added, the way a monday workspace gets a board.
 *
 * This is the one place in the sidebar model that records EXISTENCE rather than
 * arrangement, and the distinction matters enough to state twice. A row in
 * `navigation_layouts` says where a section sits and what it is called *here*;
 * a row in this table says the section is real. `resolveNavigation` still
 * decides nothing about existence — it is handed a catalogue, and these rows
 * are appended to that catalogue before it runs. So the property Stage 20 was
 * built to hold survives intact: a section added today appears in the sidebar
 * of somebody who arranged theirs last year, because their stored arrangement
 * was never the inventory.
 *
 * `surface` is which built-in screen the section draws, and it is the reason
 * this cannot invent a destination. It names a renderer the product already
 * ships; a row naming a surface the app does not know is dropped from the
 * catalogue rather than drawn, exactly as an unknown key is.
 *
 * `archived_at` rather than a delete for a section with content — see the
 * DELETE handler in `app/api/workspace-sections/route.ts`. Removing a nav item
 * must not be a way to lose rows.
 */
export const workspaceSections = sqliteTable(
  "workspace_sections",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    /** Namespaced `section:<slug>` so it can never collide with a built-in key. */
    key: text("key").notNull(),
    label: text("label").notNull(),
    /**
     * W02-07's "description" — what this section is for, in the workspace's own
     * words. NULL means "no opinion", and the screen's own blurb stands.
     */
    description: text("description"),
    /** One of `IconName` in app/components.tsx. Validated on write. */
    icon: text("icon").notNull().default("grid"),
    /** Which built-in surface draws it — see SECTION_SURFACES. */
    surface: text("surface").notNull().default("board"),
    /** The surface's parameter: a board key for board surfaces, else NULL. */
    surfaceRef: text("surface_ref"),
    /** The heading it lands under before anybody rearranges anything. */
    groupKey: text("group_key").notNull().default("group:operations"),
    position: integer("position").notNull().default(0),
    /** Set instead of deleting when the section still holds content. */
    archivedAt: text("archived_at"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("workspace_sections_key_idx").on(table.organisationId, table.key),
    index("workspace_sections_position_idx").on(table.organisationId, table.position),
  ],
);

/**
 * Which view a section opens on — monday's default view, and its memory.
 *
 * Two layers in one table, told apart by `user_id` exactly as
 * `navigation_layouts` and `dashboard_layouts` do it. NULL is the workspace
 * default the owner sets and everyone lands on; a row with a user id is that
 * person's own last view, which wins for them alone.
 *
 * `view_key` is a REFERENCE, not a definition: the views themselves live in
 * `board_views`. A remembered key whose view has since been deleted resolves to
 * nothing and falls through to the layer beneath, so a deleted view leaves
 * people on the default rather than on a tab that no longer exists.
 */
export const sectionViewPreferences = sqliteTable(
  "section_view_preferences",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    /** A built-in section key or a `section:` key from `workspace_sections`. */
    sectionKey: text("section_key").notNull(),
    /** NULL is the workspace default; a user id is that person's last view. */
    userId: text("user_id"),
    viewKey: text("view_key").notNull(),
    updatedBy: text("updated_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    // NULL is distinct from NULL in SQLite, so the workspace-default row is not
    // actually constrained here; the API enforces one default per section.
    uniqueIndex("section_view_preferences_scope_idx").on(
      table.organisationId,
      table.sectionKey,
      table.userId,
    ),
  ],
);

/**
 * The recycle bin — Stage 23.
 *
 * THIS TABLE REVERSES A DECISION THIS FILE PREVIOUSLY MADE ON PURPOSE.
 *
 * Until Stage 23 no table carried a `deleted_at`, every delete was a real
 * `DELETE FROM`, and the Trash screen said so rather than offering a Restore
 * button that could not work. That was the honest position while it held, and
 * `tests/stage-twenty-account-menu.test.mjs` failed the moment a soft-delete
 * column landed so the claim could not quietly rot.
 *
 * It was reversed on the owner's explicit instruction: "when someone deleted
 * something we should have backup for 30 days and where he can find also the
 * deleted section — check monday.com". The old reasoning was not wrong about
 * the schema; it was a description of the schema, and the owner asked for a
 * different schema. So the column landed, the test was rewritten to guard the
 * new invariant instead of the old one, and this table is what makes a Restore
 * button truthful.
 *
 * WHAT THIS TABLE IS. One row per thing currently sitting in the bin — it is a
 * live index, not a history. A row is inserted when something is soft-deleted
 * and REMOVED when that thing is restored or permanently purged. The permanent
 * record that a deletion happened lives in `audit_events` and `activity_log`,
 * which are append-only and which the Trash screen still shows underneath the
 * bin. Keeping tombstones here as well would grow the table without bound and
 * duplicate a trail that already exists.
 *
 * WHY A SEPARATE TABLE rather than reading the soft-delete flags directly:
 *
 *   1. `placement` is the whole point. Restoring a job "to where it came from"
 *      means its group AND its position, and that lives in
 *      `maintenance_group_items` — a row that has to be removed on delete, or
 *      every one of the twenty-odd board reads that join through it would keep
 *      showing the deleted job. The placement is snapshotted here as JSON so
 *      restore can put it back exactly.
 *
 *   2. `expires_at` is stored, not computed. Thirty days from the deletion is
 *      what the screen promises, and a stored column can be indexed — which is
 *      what lets the sweep find its work without scanning the table. See
 *      `sweepRecycleBin` in `app/lib/recycle-bin.ts`.
 *
 *   3. `title` is a snapshot so the bin lists what was deleted without joining
 *      back to a row that may be about to be purged.
 *
 * `entity_type` is free-form TEXT rather than an enum so a later kind — files
 * are the obvious next one — needs no migration.
 */
export const recycleBin = sqliteTable(
  "recycle_bin",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    /** "job" or "group" today; TEXT so a later kind needs no migration. */
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    boardId: text("board_id"),
    /** Snapshotted at deletion, so the bin lists without joining. */
    title: text("title").notNull(),
    summary: text("summary"),
    /**
     * JSON. For a job: `{ groupId, groupName, position }` lifted out of
     * `maintenance_group_items` before that row is removed. For a group:
     * `{ position, itemIds }` — the items that were sitting in it.
     */
    placement: text("placement"),
    deletedByEmail: text("deleted_by_email"),
    deletedByName: text("deleted_by_name"),
    deletedAt: text("deleted_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    /** Stored rather than computed so the expiry sweep can use an index. */
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    index("recycle_bin_org_deleted_idx").on(table.organisationId, table.deletedAt),
    // Swept by expiry, so the sweep must not scan the table to find its work —
    // the same reason `sign_in_failures_expiry_idx` exists.
    index("recycle_bin_expiry_idx").on(table.expiresAt),
    // One live bin row per thing. A second soft delete of the same id would
    // otherwise leave two entries and an ambiguous restore.
    uniqueIndex("recycle_bin_entity_idx").on(
      table.organisationId,
      table.entityType,
      table.entityId,
    ),
  ],
);

/**
 * Board automations — "When this happens, then do this".
 *
 * One row per rule. The trigger and the action are each a type key from
 * `app/lib/automations/catalog.ts` plus a JSON config, so a new kind of rule
 * needs no migration. `name` is the sentence the board shows and is composed
 * on the server from the same config, never trusted from the client.
 *
 * `enabled` is TEXT 'on'/'off' rather than an integer boolean, and every
 * timestamp is an ISO string written by the application rather than a column
 * default — both deliberately. `db/sqlite-to-postgres.ts` translates booleans
 * and timestamps per column against a converted production schema it knows
 * about; a column this adapter has never heard of has to be plain text on both
 * databases to behave the same on both.
 */
export const boardAutomations = sqliteTable(
  "board_automations",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    boardId: text("board_id").notNull().default("maintenance"),
    name: text("name").notNull(),
    triggerType: text("trigger_type").notNull(),
    triggerConfig: text("trigger_config").notNull().default("{}"),
    actionType: text("action_type").notNull(),
    actionConfig: text("action_config").notNull().default("{}"),
    enabled: text("enabled").notNull().default("on"),
    importance: text("importance").notNull().default("minor"),
    description: text("description"),
    createdBy: text("created_by"),
    runCount: integer("run_count").notNull().default(0),
    lastRunAt: text("last_run_at"),
    /** Time-based rules only: when the sweep last evaluated this rule. */
    lastSweepAt: text("last_sweep_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("board_automations_board_idx").on(table.organisationId, table.boardId)],
);

/**
 * Every time a rule fired, or was considered and did not — the Run history.
 *
 * `status` is success / failed / skipped, and a skipped row always carries the
 * reason in `error`, because "it did not run" with no explanation is the
 * question an operator opens this screen to answer. `depth` and `chain_id`
 * are the loop guard's own bookkeeping: an action that changes the board
 * raises events of its own, and those carry depth + 1 until the engine stops
 * following them. `dedupe_key` is what keeps a date rule from firing twice for
 * the same item on the same day across two sweeps.
 */
export const automationRuns = sqliteTable(
  "automation_runs",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    automationId: text("automation_id").notNull(),
    boardId: text("board_id").notNull().default("maintenance"),
    requestId: text("request_id"),
    status: text("status").notNull(),
    triggerSummary: text("trigger_summary"),
    actionSummary: text("action_summary"),
    error: text("error"),
    depth: integer("depth").notNull().default(0),
    chainId: text("chain_id"),
    dedupeKey: text("dedupe_key"),
    actorEmail: text("actor_email"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("automation_runs_board_idx").on(table.organisationId, table.boardId, table.createdAt),
    index("automation_runs_rule_idx").on(table.organisationId, table.automationId, table.dedupeKey),
  ],
);


/*
 * WORKSTREAM 5/6 — the configurable register, shared by Sites and Contractors.
 *
 * `registerKey` is the discriminator, so one pair of tables serves both
 * registers and can serve a third without a migration. See the block comment
 * in db/init.ts for why this does not reuse `maintenanceBoardCells` (its
 * `requestId` is a work order) and why the flags are nullable timestamps
 * rather than booleans (the bare-name rewrite rule in db/sqlite-to-postgres.ts).
 */
export const registerColumns = sqliteTable(
  "register_columns",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    /** 'sites' | 'contractors'. */
    registerKey: text("register_key").notNull(),
    columnKey: text("column_key").notNull(),
    /** The display label. Renaming a column changes THIS, never the field. */
    title: text("title").notNull(),
    type: text("type").notNull().default("text"),
    position: integer("position").notNull().default(0),
    width: integer("width").notNull().default(160),
    /*
     * NON-NULL: a view onto this canonical field on sites/contractors, whose
     * values live on that row and are never copied here.
     * NULL: a user-created column, whose values live in `registerValues`.
     */
    nativeField: text("native_field"),
    settings: text("settings").notNull().default("{}"),
    /** Hidden, not removed. A native column can only ever be hidden. */
    hiddenAt: text("hidden_at"),
    deletedAt: text("deleted_at"),
    deletedBy: text("deleted_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("register_columns_key_idx").on(
      table.organisationId,
      table.registerKey,
      table.columnKey,
    ),
    index("register_columns_order_idx").on(
      table.organisationId,
      table.registerKey,
      table.position,
    ),
  ],
);

/** One row per CUSTOM cell. Native cells are absent by construction. */
export const registerValues = sqliteTable(
  "register_values",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    registerKey: text("register_key").notNull(),
    entityId: text("entity_id").notNull(),
    columnKey: text("column_key").notNull(),
    value: text("value"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("register_values_cell_idx").on(
      table.organisationId,
      table.registerKey,
      table.entityId,
      table.columnKey,
    ),
    index("register_values_entity_idx").on(
      table.organisationId,
      table.registerKey,
      table.entityId,
    ),
  ],
);

/*
 * WORKSTREAM 5/6 — Contractor <-> Site, canonical and explicit.
 *
 * Before this the only site-bearing path from a contractor was transitive
 * through a job, and `coverageAreas` was free text every contractor filled
 * with "UK". The organisation is part of the unique key, so a pair can never
 * span tenants and cannot be created twice.
 */
export const contractorSites = sqliteTable(
  "contractor_sites",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    contractorId: text("contractor_id").notNull().references(() => contractors.id),
    siteId: text("site_id").notNull().references(() => sites.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    createdBy: text("created_by"),
  },
  (table) => [
    uniqueIndex("contractor_sites_pair_idx").on(
      table.organisationId,
      table.contractorId,
      table.siteId,
    ),
    index("contractor_sites_site_idx").on(table.siteId),
    index("contractor_sites_contractor_idx").on(table.contractorId),
  ],
);

/*
 * WORKSTREAM 6 — certifications as entries, each with its own expiry.
 *
 * The legacy `contractors.certifications` JSON array holds names and nothing
 * else, so no certificate could have a date of its own. It is left in place and
 * still read; a contractor with no rows here behaves exactly as before.
 */
export const contractorCertifications = sqliteTable(
  "contractor_certifications",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    contractorId: text("contractor_id").notNull().references(() => contractors.id),
    name: text("name").notNull(),
    reference: text("reference"),
    issuedOn: text("issued_on"),
    /** What makes a status derivable at all. Nullable: not every ticket expires. */
    expiresOn: text("expires_on"),
    notes: text("notes"),
    position: integer("position").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("contractor_certifications_owner_idx").on(
      table.organisationId,
      table.contractorId,
      table.position,
    ),
  ],
);
