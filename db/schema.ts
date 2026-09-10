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

    /*
     * BILLING ELIGIBILITY — deliberately separate from `active` above.
     *
     * `active` says the site is trading. These say it is chargeable, and the
     * two are not the same fact: a site can be open and outside the agreement,
     * or inside the agreement during a fit-out before it opens. Reusing
     * `active` for both would have made every invoice a hostage to an
     * operational flag that operations staff change for their own reasons.
     *
     * The window is also NOT `lease_start` / `lease_end`. A billing window is a
     * commercial term; a lease is a property record, maintained by different
     * people for a different purpose.
     */
    billable: integer("billable", { mode: "boolean" }).notNull().default(true),
    billingActiveFrom: text("billing_active_from"),
    billingActiveTo: text("billing_active_to"),

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

    /**
     * W2 -- WHICH REGISTER THIS SITE BELONGS TO.
     *
     * The board key of the section instance that owns the row, or NULL for the
     * canonical register -- the workspace's own Sites screen, which genuinely
     * has no board behind it (`SECTION_SURFACES` records `boardKey: null` for
     * the `stores` surface, and `builtInSectionBoard("stores")` returns null).
     *
     * The same column, holding the same kind of value, as the twelve
     * board-scoped tables below. `app/lib/register-scope.ts` owns the meaning,
     * the predicate and the request-to-scope resolution; nothing may compare
     * this column by hand, because `= NULL` is never true and a hand-rolled
     * filter therefore reads an instance as empty and the canonical register as
     * everything.
     *
     * Nullable with no default so the migration is a no-op: every existing row
     * reads NULL, which is canonical, so nothing moves.
     */
    boardId: text("board_id"),

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
    /* W2 -- the scope filter is on every read of this table, so it is indexed
       with the organisation it always accompanies. Not unique: two registers
       may legitimately hold a site of the same name, which is the whole point
       of an independent instance. */
    index("sites_organisation_board_idx").on(table.organisationId, table.boardId),
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
    /**
     * W2 -- reporting groups belong to ONE register. Without this an instance's
     * Sites screen would list the canonical register's groups, which is the
     * leak of canonical data into an instance the owner ruled out by name.
     * See `sites.boardId`.
     */
    boardId: text("board_id"),
    position: integer("position").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("site_groups_organisation_slug_idx").on(table.organisationId, table.slug),
    index("site_groups_organisation_position_idx").on(table.organisationId, table.position),
    /* W2 -- see `sites_organisation_board_idx`. */
    index("site_groups_organisation_board_idx").on(table.organisationId, table.boardId),
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
    /**
     * W2 -- WHICH REGISTER THIS CONTRACTOR BELONGS TO. See `sites.boardId`;
     * one model, one meaning, and `app/lib/register-scope.ts` owns both.
     *
     * NULL is the canonical roster, which is what every existing row reads and
     * what `resolveContractorLink` searches when nobody names an instance. That
     * default is what keeps a contractor added to an instance from breaking the
     * name-matching on the jobs the workspace already has.
     */
    boardId: text("board_id"),
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
  (table) => [
    index("contractors_organisation_idx").on(table.organisationId),
    /* W2 -- see `sites_organisation_board_idx`. */
    index("contractors_organisation_board_idx").on(table.organisationId, table.boardId),
  ],
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
    /*
     * The stable identity behind the display name above, added when "Assigned
     * To" stopped being free text and started being a person in the workspace.
     *
     * Exactly the `contractor` / `contractor_id` arrangement a few lines up,
     * and for the same two reasons: a person renamed or removed must not
     * rewrite who was named on a job that closed last year, and the hundreds of
     * imported rows whose assignee was only ever a string keep working
     * untouched. Both columns are written together by the picker.
     */
    assigneeUserId: text("assignee_user_id"),
    requestedAt: text("requested_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    dueAt: text("due_at"),
    completedAt: text("completed_at"),
    nextUpdateAt: text("next_update_at"),
    /*
     * When the visit is booked for. THE JOB owns this, not a calendar row —
     * see `app/(app)/portal/planned-visit.ts`. `dueAt` above is already the SLA
     * deadline and `completedAt` the completion date, so Module 2 §10's list
     * only needs these three added.
     */
    scheduledDate: text("scheduled_date"),
    scheduledTime: text("scheduled_time"),
    targetCompletionDate: text("target_completion_date"),
    isSeed: integer("is_seed", { mode: "boolean" }).notNull().default(false),
    seedBatchId: text("seed_batch_id"),
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
    index("maintenance_scheduled_idx").on(table.organisationId, table.scheduledDate),
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

/**
 * A QUOTE, AS A FIRST-CLASS RECORD.
 *
 * Module 5 §3: "Track them as first-class records, not as attachments on a
 * job." The nine columns above the fold are what this table has always had and
 * what `app/lib/reporting/engine.ts` already reads; everything below them is
 * Module 5's, added rather than duplicated into a second `quotes` table.
 *
 * `request_id` is NOT NULL and always was, which is exactly the rule §3 asks
 * for — "Linked job: Required — a quote with no job is an orphan."
 *
 * `amount` is the legacy REAL. New code writes `net_pence` / `vat_pence` /
 * `gross_pence` and reads nothing else; the old column is kept because a
 * migration that drops a column is not one this bootstrap can perform, and
 * `engine.ts` still selects it.
 */
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

    /* ── Module 5 §3 ──────────────────────────────────────────────────────── */
    /** `QT-YYYY-NNN`, allocated by `app/lib/finance/references.ts`. */
    internalRef: text("internal_ref"),
    /** The supplier's own reference, as printed on their document. */
    supplierRef: text("supplier_ref"),
    /** Inherited from the job, overridable — §3. */
    siteId: text("site_id"),
    description: text("description"),
    netPence: integer("net_pence"),
    vatPence: integer("vat_pence"),
    grossPence: integer("gross_pence"),
    quoteDate: text("quote_date"),
    /** Expiry drives the reminder seven days out. §3. */
    validUntil: text("valid_until"),
    approvedBy: text("approved_by"),
    /** Required to move to Rejected. §3. */
    rejectedReason: text("rejected_reason"),
    rejectedBy: text("rejected_by"),
    rejectedAt: text("rejected_at"),
    clientApprovalRequired: integer("client_approval_required", { mode: "boolean" })
      .notNull()
      .default(false),
    clientApprovedBy: text("client_approved_by"),
    clientApprovedAt: text("client_approved_at"),
    poNumber: text("po_number"),
    /** Set when another quote on the same job was approved instead. */
    supersededById: text("superseded_by_id"),
    createdBy: text("created_by"),
    createdAt: text("created_at"),
    updatedAt: text("updated_at"),
  },
  (table) => [
    index("quotations_organisation_idx").on(table.organisationId),
    index("quotations_request_idx").on(table.requestId),
    index("quotations_expiry_idx").on(table.organisationId, table.validUntil),
  ],
);

/**
 * THE LEDGER — one row per invoice, either direction. Module 5 §4.
 *
 * The reasoning for extending this table rather than creating a new one is at
 * the head of the Module 5 block further down this file. Three columns here are
 * legacy and are deliberately left where they are:
 *
 *   · `amount` REAL — superseded by `net_pence` / `vat_pence` / `gross_pence`.
 *     Never read by the finance module.
 *   · `paid_at` — superseded by `payments` + `payment_alloc`. §6 is explicit
 *     that one invoice can take several payments, which a single timestamp
 *     cannot express, so nothing computes settlement from this column.
 *   · `request_id` NOT NULL — the invoice's PRIMARY job. Multi-job invoices
 *     put every share in `invoice_job_alloc`, including the primary one, and
 *     `app/lib/finance/allocations.ts` reconciles against that table alone.
 *     The column stays because it is NOT NULL and this bootstrap performs no
 *     destructive ALTER; it is maintained as a mirror of the first allocation.
 *
 * `due_at` IS the due date. §4 names the field `due_date`; the column that was
 * already here holds exactly that, so it is reused. Two columns for one
 * contractual date is the same class of drift as a stored balance.
 */
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

    /* ── Module 5 §4 ──────────────────────────────────────────────────────── */
    /** payable | receivable — the one field that makes this table serve both sides. */
    direction: text("direction").notNull().default("payable"),
    /** `AP-YYYY-NNN` or `AR-YYYY-NNN`, allocated by `app/lib/finance/references.ts`. */
    internalRef: text("internal_ref"),
    /** contractor | client */
    counterpartyType: text("counterparty_type"),
    /** A `contractors.id` on a payable, an `organisations.id` on a receivable. */
    counterpartyId: text("counterparty_id"),
    counterpartyName: text("counterparty_name"),
    /** The supplier's department or contact — payable only. */
    fromDepartment: text("from_department"),
    /** The client department or cost centre — receivable only. */
    toDepartment: text("to_department"),
    faoContact: text("fao_contact"),
    quoteId: text("quote_id"),
    poNumber: text("po_number"),
    siteId: text("site_id"),
    invoiceDate: text("invoice_date"),
    /** When it landed with us — payable only. */
    receivedDate: text("received_date"),
    /** When it went to the client — receivable only. */
    sentDate: text("sent_date"),
    paymentTermsDays: integer("payment_terms_days"),
    netPence: integer("net_pence"),
    vatPence: integer("vat_pence"),
    grossPence: integer("gross_pence"),
    currency: text("currency").notNull().default("GBP"),
    costCentre: text("cost_centre"),
    category: text("category"),
    notes: text("notes"),
    /** §15.5 — a percentage held back on project work until sign-off. */
    retentionPence: integer("retention_pence"),
    retentionReleaseDate: text("retention_release_date"),
    retentionReleasedAt: text("retention_released_at"),
    /** manual | email | csv | module4 | recurring */
    source: text("source").notNull().default("manual"),
    /** The `service_invoices.id` this receivable was raised from. §12. */
    serviceInvoiceId: text("service_invoice_id"),
    createdBy: text("created_by"),
    /** After this instant the accounting facts are immutable. §15.14. */
    finalisedAt: text("finalised_at"),
    finalisedBy: text("finalised_by"),
    /*
     * WHICH PAYMENT RUN THIS INVOICE BELONGS TO — the membership §13 needs and
     * did not have.
     *
     * The export used to RE-DERIVE its rows ("every approved or scheduled
     * payable with a balance") instead of reading a membership list, on the
     * reasoning that re-deriving keeps a run honest if an invoice is settled
     * between creating it and exporting it. It does — and it also puts every
     * other run's invoices in the file. Proven: a run created for one £10
     * invoice exported two rows totalling £1,210, and a second run created for
     * one £1 invoice exported three, re-including both the first run had
     * already sent to the bank. Upload both files as intended and two
     * suppliers are paid twice.
     *
     * Holding it on the INVOICE rather than as a list on the run is what makes
     * double membership impossible rather than merely unlikely: an invoice
     * already carrying a run id cannot be picked up by the next one.
     */
    paymentRunId: text("payment_run_id"),
    voidedAt: text("voided_at"),
    voidedBy: text("voided_by"),
    voidReason: text("void_reason"),
    updatedAt: text("updated_at"),
  },
  (table) => [
    index("invoices_organisation_idx").on(table.organisationId),
    index("invoices_request_idx").on(table.requestId),
    /* §14 names these three by hand. */
    index("invoices_due_status_idx").on(table.dueAt, table.status),
    index("invoices_direction_status_idx").on(table.direction, table.status),
    index("invoices_counterparty_idx").on(table.organisationId, table.counterpartyId),
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
    /*
     * Certificate fields, HERE rather than in a `certificates` table of their
     * own. This register already holds every compliance document in the
     * product — the Store Documentation board reads it and the expiry
     * dashboard counts it — so a second table would mean two answers to "how
     * many certificates expire this month".
     */
    reference: text("reference"),
    issuedBy: text("issued_by"),
    issueDate: text("issue_date"),
    nextInspectionDate: text("next_inspection_date"),
    /** Accountable for booking the renewal; a dynamic reminder group resolves to it. */
    renewalOwnerEmail: text("renewal_owner_email"),
    escalationEmail: text("escalation_email"),
    costPence: integer("cost_pence"),
    remedialsRequired: integer("remedials_required", { mode: "boolean" })
      .notNull()
      .default(false),
    /** The job spawned by "Create job from this", when remedials were flagged. */
    remedialRequestId: text("remedial_request_id"),
    /** Not started | Quote requested | Booked | Attended | Certificate received. */
    renewalStatus: text("renewal_status"),
    supersededById: text("superseded_by_id"),
    isSeed: integer("is_seed", { mode: "boolean" }).notNull().default(false),
    seedBatchId: text("seed_batch_id"),
    /**
     * Whose obligation this requirement is — `client`, `landlord`, `centre`,
     * `not_applicable`, or the literal `unconfirmed`.
     *
     * NULL means nobody has ever been asked, which is NOT the same as
     * `unconfirmed` and must never be conflated with it: NULL counts toward the
     * compliance percentage as it always has, `unconfirmed` does not. See
     * `app/lib/compliance-duty-holder.ts`.
     *
     * Distinct from `StoreDocumentSlot.responsibility`, which says who CHASES
     * the certificate. Two axes, two names.
     */
    dutyHolder: text("duty_holder"),
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
    /**
     * W2 - THE TEMPLATE THIS REGISTER WAS BUILT FROM, and the instance model's
     * one identifying fact.
     *
     * `workspace_sections.template` records what the OWNER chose; this records
     * what the REGISTER actually is, and the two are not the same question. A
     * section can be re-homed, archived and restored, or detached from its
     * register entirely, and through all of it the board still has to be able
     * to say whether it is a Jobs board - which is what decides whether the
     * spec's newest column belongs on it.
     *
     * NULL means a board that predates templates: the two built-in ones, and
     * every register created for a section before W2. Read that way everywhere.
     * NULL is never "assume Jobs" - a legacy section's generic six-column
     * register must keep working exactly as it does, and silently converting
     * one into a job board is the change the owner ruled out by name.
     */
    template: text("template"),
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
    /**
     * W2 — the TEMPLATE this instance was created from. See SECTION_TEMPLATES.
     *
     * Plain nullable TEXT rather than a constrained set, and that is what lets
     * `contractors` and `sites` arrive without a second migration: a new
     * template is an entry in the catalogue module, validated by the API on
     * write, and this column simply holds its key.
     *
     * NULL MEANS LEGACY, NOT UNKNOWN. Every section created before W2 is a
     * second door onto one of the product's own screens — a real, supported
     * shape that must keep working — so a NULL here is a statement about the
     * row rather than a gap to be backfilled.
     */
    template: text("template"),
    /** The heading it lands under before anybody rearranges anything. */
    groupKey: text("group_key").notNull().default("group:operations"),
    position: integer("position").notNull().default(0),
    /** Set instead of deleting when the section still holds content. */
    archivedAt: text("archived_at"),
    /**
     * W2C — THE SECTION IS IN THE RECYCLE BIN, AS ONE BUNDLE.
     *
     * `archived_at` and this column are two different statements and the
     * product needs both. Archiving is an ARRANGEMENT act: the section leaves
     * every sidebar, nothing else changes, and it can sit there for ever.
     * `deleted_at` is a LIFECYCLE act: the section and everything it owns — its
     * register, that register's rows, views, forms, columns, attachments, and
     * any sites or contractors created inside it — are in the Recycle Bin for
     * thirty days, after which they are destroyed.
     *
     * NOTHING ELSE MOVES WHEN THIS IS SET, and that is the whole design. The
     * children keep their `board_id`, their placements, their cells and their
     * files exactly where they are; the section is the only door onto a
     * `sec-` register, so hiding the section hides the bundle. Restore is then
     * one UPDATE back to NULL and is atomic by construction — there is no
     * partially-restored state available, because nothing was taken apart.
     * Cascading tombstones would have given the bin hundreds of rows to put
     * back and a way to get half of it wrong.
     *
     * Deleting also sets `archived_at` when it is not already set, so every
     * reader that already excludes an archived section — the nav catalogue,
     * `resolveRegisterScope`, the section manager's live list — excludes a
     * deleted one with no change at all. The pre-delete value is snapshotted
     * into the bin entry so Restore puts the row back in the state it left.
     *
     * Nullable TEXT, no default, no backfill: every existing row reads NULL,
     * which means "not deleted". See `sendSectionToBin` in
     * `app/lib/recycle-bin.ts` for the bundle, and the `bin=1` branch of
     * `DELETE /api/workspace-sections` for what writes it.
     */
    deletedAt: text("deleted_at"),
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
/**
 * THE FREE-TEXT CONTRACTOR NAMES A REGISTER ROW ANSWERS TO — the mapping table.
 *
 * Two disconnected sets of contractor identities exist on this estate and
 * nothing joined them: names typed onto jobs (`maintenance_requests.contractor`)
 * and proper records in the register. `contractor_id` closes the gap for a job
 * somebody has linked, but there is no way to say "every job that says
 * 'Saed Electrical' is this record" — so the register's Assigned, Completed and
 * Spend columns read zero over contractors who had done the work, and the
 * Overview reported most of its attributed spend as unlinked.
 *
 * A row here is that statement. `normalised` is what the lookup matches on —
 * lower-cased, collapsed whitespace — because these strings have been through a
 * spreadsheet, a form and a human; `alias` keeps what was actually typed, so a
 * screen can show the operator the string they are mapping rather than a
 * flattened copy of it.
 *
 * UNIQUE ON (organisation, normalised). One job-side name resolves to at most
 * one record, ever. The alternative — a name claimed by two contractors —
 * double-counts money, which is the one failure `contractor-attribution.ts`
 * refuses to risk; it declines to attribute an ambiguous name for exactly this
 * reason, and this index makes ambiguity unrepresentable rather than merely
 * handled.
 */
export const contractorNameAliases = sqliteTable(
  "contractor_name_aliases",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    contractorId: text("contractor_id").notNull().references(() => contractors.id),
    /** The string as typed on the job. */
    alias: text("alias").notNull(),
    /** Lower-cased, whitespace-collapsed. The column the lookup matches on. */
    normalised: text("normalised").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    createdBy: text("created_by"),
  },
  (table) => [
    uniqueIndex("contractor_name_aliases_unique_idx").on(
      table.organisationId,
      table.normalised,
    ),
    index("contractor_name_aliases_contractor_idx").on(
      table.organisationId,
      table.contractorId,
    ),
  ],
);

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

/* ===========================================================================
 * OWNER FIXES + REPORTS BILLING — additive tables, 2026-09-04.
 *
 * Everything below is new. Nothing above it changes shape, nothing is renamed
 * and nothing is dropped, which is the only kind of migration `db/init.ts` can
 * replay on the boot path of every request. Money is INTEGER PENCE throughout:
 * `real` was available and was not used, because a fixed per-site fee summed
 * over thirty sites and then VAT-ed is exactly the arithmetic where binary
 * floating point stops agreeing with an invoice.
 *
 * "Client" here means `organisations`. There is no separate clients table in
 * this product — the sidebar's "ALL CLIENTS" list is the organisation list, and
 * every tenancy helper already scopes by organisation. Inventing a second
 * customer entity for billing would have put the invoice outside the boundary
 * `scopedDb()` enforces.
 * ======================================================================== */

/**
 * Manual calendar items — the Planned calendar's third source.
 *
 * The Operations calendar draws Jobs and Compliance from their canonical
 * records. The owner asked to "add and adjust additional calendar items
 * manually", and the one thing that must not happen is a manual note becoming
 * indistinguishable from a Job. So manual items are their OWN table with their
 * own category, never a `maintenance_requests` row with a flag: a job that is
 * not a job would leak into every job count, meter and report in the product.
 */
export const calendarEvents = sqliteTable(
  "calendar_events",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    title: text("title").notNull(),
    notes: text("notes"),
    /** Optional. A manual item need not be about a site. */
    siteId: text("site_id"),
    startsOn: text("starts_on").notNull(),
    /** NULL means a single-day item, not an open-ended one. */
    endsOn: text("ends_on"),
    allDay: integer("all_day", { mode: "boolean" }).notNull().default(true),
    category: text("category").notNull().default("Manual"),
    colour: text("colour"),
    createdByEmail: text("created_by_email"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    archivedAt: text("archived_at"),
    deletedAt: text("deleted_at"),
    deletedBy: text("deleted_by"),
    /*
     * THE HINGE OF THE HYBRID VISIT MODEL.
     *
     * Set: this row is a VIEW of a maintenance job, the job owns the schedule,
     * and `startsOn` above must be NULL. Unset: this is a standalone visit — a
     * survey, an inspection — that has no job and needs none invented for it.
     * `app/(app)/portal/planned-visit.ts` holds the rules and the invariant.
     */
    requestId: text("request_id"),
    /** Reactive repair | Planned maintenance | Inspection | Survey | Installation | Other. */
    visitType: text("visit_type"),
    startsAtTime: text("starts_at_time"),
    endsAtTime: text("ends_at_time"),
    assignedTo: text("assigned_to"),
    contractorId: text("contractor_id"),
    accessNotes: text("access_notes"),
    priority: text("priority"),
    status: text("status"),
    responseDeadlineAt: text("response_deadline_at"),
    recurrence: text("recurrence"),
    isSeed: integer("is_seed", { mode: "boolean" }).notNull().default(false),
    seedBatchId: text("seed_batch_id"),
  },
  (table) => [
    index("calendar_events_org_start_idx").on(table.organisationId, table.startsOn),
    index("calendar_events_site_idx").on(table.siteId),
  ],
);

/**
 * One row per organisation: the defaults an invoice is built from.
 *
 * `invoiceSequence` is the invoice-number counter and is the reason this table
 * has a UNIQUE index on `organisation_id` rather than being a bag of rows in
 * `workspace_settings` — a number that must never be issued twice needs a row
 * that can be updated conditionally, not a JSON blob that is read, mutated and
 * written back.
 */
export const billingSettings = sqliteTable(
  "billing_settings",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    currency: text("currency").notNull().default("GBP"),
    /** The organisation-wide default, bottom of the three-level fee hierarchy. */
    defaultSiteFeePence: integer("default_site_fee_pence"),
    vatEnabled: integer("vat_enabled", { mode: "boolean" }).notNull().default(false),
    /** Basis points: 20% VAT is 2000. Integer, for the same reason money is. */
    vatRateBasisPoints: integer("vat_rate_basis_points").notNull().default(2000),
    vatNumber: text("vat_number"),
    paymentTermsDays: integer("payment_terms_days").notNull().default(30),
    paymentTermsNote: text("payment_terms_note"),
    billingAddress: text("billing_address"),
    invoiceNumberPrefix: text("invoice_number_prefix").notNull().default("MS"),
    /** The year `invoiceSequence` is counting within, for `MS-YYYY-NNN`. */
    invoiceSequenceYear: integer("invoice_sequence_year"),
    invoiceSequence: integer("invoice_sequence").notNull().default(0),
    /** No automatic proration unless the client genuinely has the rule. */
    proRataEnabled: integer("pro_rata_enabled", { mode: "boolean" }).notNull().default(false),
    updatedBy: text("updated_by"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("billing_settings_org_idx").on(table.organisationId),
  ],
);

/**
 * The client-level fixed site fee — middle of the hierarchy.
 *
 * Effective-dated rather than overwritten, so an invoice raised for March still
 * prices at March's fee after April's rise. Rows are never edited in place by
 * the app; a change closes the old row and opens a new one.
 */
export const clientSiteFees = sqliteTable(
  "client_site_fees",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    feePence: integer("fee_pence").notNull(),
    effectiveFrom: text("effective_from"),
    effectiveTo: text("effective_to"),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("client_site_fees_org_idx").on(table.organisationId, table.effectiveFrom),
  ],
);

/** The per-site override — top of the hierarchy. Same effective-dating rule. */
export const siteFeeOverrides = sqliteTable(
  "site_fee_overrides",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    siteId: text("site_id").notNull(),
    feePence: integer("fee_pence").notNull(),
    effectiveFrom: text("effective_from"),
    effectiveTo: text("effective_to"),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("site_fee_overrides_site_idx").on(table.organisationId, table.siteId, table.effectiveFrom),
  ],
);

/**
 * The combined invoice + maintenance-report document.
 *
 * NOT the existing `invoices` table, which is a contractor's bill against ONE
 * maintenance request. This is MAINTSUPP's own fixed service fee for a period,
 * and conflating the two would have put contractor costs inside the invoice
 * total — precisely what the owner asked to keep apart.
 *
 * The totals are stored, not recomputed on read. Once `status` is 'Finalised'
 * these columns and `report_snapshots` are the document: a fee edited next
 * month must not silently restate an invoice already sent.
 */
export const serviceInvoices = sqliteTable(
  "service_invoices",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    /** NULL until finalisation issues one from `billing_settings.invoice_sequence`. */
    invoiceNumber: text("invoice_number"),
    status: text("status").notNull().default("Draft"),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    invoiceDate: text("invoice_date"),
    dueAt: text("due_at"),
    currency: text("currency").notNull().default("GBP"),
    vatEnabled: integer("vat_enabled", { mode: "boolean" }).notNull().default(false),
    vatRateBasisPoints: integer("vat_rate_basis_points").notNull().default(0),
    purchaseOrder: text("purchase_order"),
    clientReference: text("client_reference"),
    internalReference: text("internal_reference"),
    paymentTerms: text("payment_terms"),
    clientNote: text("client_note"),
    internalNote: text("internal_note"),
    billingAddress: text("billing_address"),
    billableSiteCount: integer("billable_site_count").notNull().default(0),
    subtotalPence: integer("subtotal_pence").notNull().default(0),
    vatPence: integer("vat_pence").notNull().default(0),
    adjustmentPence: integer("adjustment_pence").notNull().default(0),
    creditPence: integer("credit_pence").notNull().default(0),
    totalPence: integer("total_pence").notNull().default(0),
    /** Reported beside the invoice, never added to it. */
    maintenanceSpendPence: integer("maintenance_spend_pence").notNull().default(0),
    createdByEmail: text("created_by_email"),
    createdByUserId: text("created_by_user_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    approvedByEmail: text("approved_by_email"),
    approvedAt: text("approved_at"),
    finalisedByEmail: text("finalised_by_email"),
    finalisedAt: text("finalised_at"),
    voidedByEmail: text("voided_by_email"),
    voidedAt: text("voided_at"),
    voidReason: text("void_reason"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("service_invoices_org_period_idx").on(
      table.organisationId,
      table.periodStart,
      table.periodEnd,
    ),
    index("service_invoices_status_idx").on(table.organisationId, table.status),
  ],
);

/** One charge line per billable site. `feeSource` records which level won. */
export const serviceInvoiceLines = sqliteTable(
  "service_invoice_lines",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    invoiceId: text("invoice_id").notNull(),
    lineNo: integer("line_no").notNull().default(0),
    siteId: text("site_id"),
    /* Names are snapshotted onto the line, not joined at read time: a site
       renamed after finalisation must not rewrite an issued invoice. */
    siteName: text("site_name"),
    siteReference: text("site_reference"),
    description: text("description"),
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    quantity: integer("quantity").notNull().default(1),
    feePence: integer("fee_pence").notNull().default(0),
    /** 'Site override' | 'Client fee' | 'Organisation default'. */
    feeSource: text("fee_source"),
    feeRecordId: text("fee_record_id"),
    vatRateBasisPoints: integer("vat_rate_basis_points").notNull().default(0),
    lineSubtotalPence: integer("line_subtotal_pence").notNull().default(0),
    lineVatPence: integer("line_vat_pence").notNull().default(0),
    lineTotalPence: integer("line_total_pence").notNull().default(0),
    included: integer("included", { mode: "boolean" }).notNull().default(true),
    exclusionReason: text("exclusion_reason"),
    excludedByEmail: text("excluded_by_email"),
    excludedAt: text("excluded_at"),
    /** Free text from the validator: why this line blocks or warns. */
    validation: text("validation"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("service_invoice_lines_invoice_idx").on(table.invoiceId, table.lineNo),
    index("service_invoice_lines_site_idx").on(table.organisationId, table.siteId),
  ],
);

/** Authorised adjustments and credits. Separate rows so each carries a reason. */
export const invoiceAdjustments = sqliteTable(
  "invoice_adjustments",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    invoiceId: text("invoice_id").notNull(),
    /** 'adjustment' | 'credit'. */
    kind: text("kind").notNull().default("adjustment"),
    amountPence: integer("amount_pence").notNull().default(0),
    reason: text("reason").notNull(),
    authorisedByEmail: text("authorised_by_email"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("invoice_adjustments_invoice_idx").on(table.invoiceId),
  ],
);

/**
 * The immutable snapshot a finalised document is rendered from.
 *
 * `payload` is the whole computed report as JSON — totals, site summary, SLA
 * outcomes, job log, data-quality findings. Exports read THIS, never the live
 * tables, which is what makes Word, PDF and Excel agree with each other and
 * with what was approved months later.
 */
export const reportSnapshots = sqliteTable(
  "report_snapshots",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    invoiceId: text("invoice_id").notNull(),
    payload: text("payload").notNull(),
    slaRulesVersion: text("sla_rules_version"),
    jobIds: text("job_ids"),
    siteIds: text("site_ids"),
    feeIds: text("fee_ids"),
    createdByEmail: text("created_by_email"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("report_snapshots_invoice_idx").on(table.invoiceId),
  ],
);

/** Target working days per classification. Versioned so a report can say which. */
export const slaRules = sqliteTable(
  "sla_rules",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    classification: text("classification").notNull(),
    targetWorkingDays: integer("target_working_days").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    version: integer("version").notNull().default(1),
    note: text("note"),
    updatedBy: text("updated_by"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("sla_rules_org_idx").on(table.organisationId, table.classification),
  ],
);

/**
 * Approved holds — the only thing allowed to reduce a measured SLA duration.
 *
 * `approved` defaults to FALSE on purpose. An unapproved hold is a data-quality
 * finding the report must surface, not a silent discount on the elapsed days.
 */
export const jobHolds = sqliteTable(
  "job_holds",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    requestId: text("request_id").notNull(),
    startAt: text("start_at").notNull(),
    endAt: text("end_at"),
    reason: text("reason"),
    category: text("category"),
    approved: integer("approved", { mode: "boolean" }).notNull().default(false),
    approvedBy: text("approved_by"),
    approvedAt: text("approved_at"),
    note: text("note"),
    attachmentId: text("attachment_id"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("job_holds_request_idx").on(table.organisationId, table.requestId),
  ],
);

/** Every state transition of a document. Append-only, like `audit_events`. */
export const invoiceApprovals = sqliteTable(
  "invoice_approvals",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    invoiceId: text("invoice_id").notNull(),
    action: text("action").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    actorEmail: text("actor_email"),
    actorUserId: text("actor_user_id"),
    reason: text("reason"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("invoice_approvals_invoice_idx").on(table.invoiceId, table.createdAt),
  ],
);

/** Which formats were produced, when, by whom — the export history. */
export const invoiceExports = sqliteTable(
  "invoice_exports",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    invoiceId: text("invoice_id").notNull(),
    /** 'docx' | 'pdf' | 'xlsx'. */
    format: text("format").notNull(),
    filename: text("filename"),
    attachmentId: text("attachment_id"),
    byteSize: integer("byte_size"),
    actorEmail: text("actor_email"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("invoice_exports_invoice_idx").on(table.invoiceId, table.createdAt),
  ],
);

/* -------------------------------------------------------------------------- */
/*  Pre-W14 — the reminder engine, the status map and the holiday calendar     */
/* -------------------------------------------------------------------------- */

/**
 * One reminder row.
 *
 * `subjectType` + `subjectId` rather than a nullable foreign key per kind: the
 * same row shape hangs off a certificate, a planned visit and a job, which is
 * what "one engine, not two" means in practice. Offsets are stored and
 * `nextSendAt` is a cache, so moving a certificate's expiry date recalculates
 * the cascade instead of migrating it.
 */
export const reminderRules = sqliteTable(
  "reminder_rules",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    /** 'certificate' | 'visit' | 'job' | 'note'. */
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    /** 'd90' through 'overdue' for a generated step; NULL for one somebody added. */
    stepKey: text("step_key"),
    /*
     * `is_enabled`, not `enabled`. `board_automations.enabled` is TEXT, and the
     * Postgres translator's boolean rule works on the bare column NAME — so a
     * second `enabled` that is boolean would make that rule wrong for one of
     * the two tables. See BOOLEAN_COLUMNS in db/sqlite-to-postgres.ts.
     */
    isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
    offsetValue: integer("offset_value").notNull().default(0),
    /** 'day' | 'week' | 'month'. */
    offsetUnit: text("offset_unit").notNull().default("day"),
    /** 'before' | 'after' | 'on'. */
    offsetDirection: text("offset_direction").notNull().default("before"),
    /** HH:MM, local to `timezone`. Defaults to 08:00, editable per row. */
    sendTime: text("send_time").notNull().default("08:00"),
    timezone: text("timezone").notNull().default("Europe/London"),
    repeatEnabled: integer("repeat_enabled", { mode: "boolean" }).notNull().default(false),
    repeatIntervalDays: integer("repeat_interval_days").notNull().default(3),
    repeatCap: integer("repeat_cap").notNull().default(10),
    sendsCount: integer("sends_count").notNull().default(0),
    customMessage: text("custom_message"),
    channel: text("channel").notNull().default("email"),
    nextSendAt: text("next_send_at"),
    /** 'pending' | 'sent' | 'acknowledged' | 'cancelled' | 'failed'. */
    status: text("status").notNull().default("pending"),
    acknowledgedAt: text("acknowledged_at"),
    acknowledgedBy: text("acknowledged_by"),
    createdByEmail: text("created_by_email"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("reminder_rules_subject_idx").on(
      table.organisationId,
      table.subjectType,
      table.subjectId,
    ),
    index("reminder_rules_due_idx").on(table.nextSendAt, table.status),
  ],
);

/** Exactly one of `userId`, `email`, `groupKey` is set on each row. */
export const reminderRecipients = sqliteTable(
  "reminder_recipients",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    reminderId: text("reminder_id").notNull(),
    userId: text("user_id"),
    email: text("email"),
    /** A DYNAMIC group, resolved at send time so staff changes cannot stale it. */
    groupKey: text("group_key"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("reminder_recipients_rule_idx").on(table.reminderId)],
);

/**
 * The idempotency ledger. One row per (rule, occurrence) — the UNIQUE index is
 * what makes a double-firing cron harmless, enforced by the database rather
 * than by a check the application races with itself.
 */
export const reminderDispatch = sqliteTable(
  "reminder_dispatch",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    reminderId: text("reminder_id").notNull(),
    occurrenceDate: text("occurrence_date").notNull(),
    sentAt: text("sent_at"),
    providerMessageId: text("provider_message_id"),
    recipientsJson: text("recipients_json"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("reminder_dispatch_once_idx").on(table.reminderId, table.occurrenceDate),
  ],
);

/** The editable global cascade. Editing it never retro-applies to a record. */
export const reminderDefaults = sqliteTable(
  "reminder_defaults",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    /** 'certificate' | 'visit' | 'job'. */
    scope: text("scope").notNull().default("certificate"),
    stepKey: text("step_key").notNull(),
    stepOrder: integer("step_order").notNull().default(0),
    offsetValue: integer("offset_value").notNull().default(0),
    offsetUnit: text("offset_unit").notNull().default("day"),
    offsetDirection: text("offset_direction").notNull().default("before"),
    sendTime: text("send_time").notNull().default("08:00"),
    /** Group KEYS, never addresses. */
    recipientGroupsJson: text("recipient_groups_json").notNull().default("[]"),
    repeatEnabled: integer("repeat_enabled", { mode: "boolean" }).notNull().default(false),
    repeatIntervalDays: integer("repeat_interval_days").notNull().default(3),
    repeatCap: integer("repeat_cap").notNull().default(10),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    updatedByEmail: text("updated_by_email"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("reminder_defaults_step_idx").on(
      table.organisationId,
      table.scope,
      table.stepKey,
    ),
  ],
);

/**
 * Acknowledge / snooze / renew, as single-use links that work with no session.
 * Only the HASH is stored: a leaked row must not be a working link.
 */
export const reminderTokens = sqliteTable(
  "reminder_tokens",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    reminderId: text("reminder_id").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** 'ack' | 'snooze' | 'renew'. */
    action: text("action").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    usedByEmail: text("used_by_email"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("reminder_tokens_hash_idx").on(table.tokenHash)],
);

/**
 * Status text to colour, shape and meaning. Data because the statuses came
 * from monday and will change; an unmapped one renders grey with its raw label
 * and raises an admin notice rather than disappearing.
 */
export const jobStatusMap = sqliteTable(
  "job_status_map",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    sourceStatusLabel: text("source_status_label").notNull(),
    displayLabel: text("display_label").notNull(),
    colourHex: text("colour_hex").notNull().default("#64748B"),
    icon: text("icon"),
    /** 'solid' | 'outline' | 'hatched' | 'strikethrough'. */
    chipStyle: text("chip_style").notNull().default("solid"),
    countsAsOpen: integer("counts_as_open", { mode: "boolean" }).notNull().default(true),
    countsAsOverdueEligible: integer("counts_as_overdue_eligible", { mode: "boolean" })
      .notNull()
      .default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    /**
     * WHICH OF THE OVERVIEW'S EIGHT METERS THIS STATUS BELONGS TO.
     *
     * Nullable, and null means the catch-all. That is not a gap to be filled: a
     * status invented tomorrow arrives with no row at all, resolves to `other`,
     * and the eight still sum to the cohort total — which is what makes §9.9
     * ("a status added later produces correct output with no code change") true
     * by construction rather than by remembering.
     *
     * It lives HERE rather than in a join table because this table already
     * holds exactly one row per (organisation, status) behind a UNIQUE index.
     * One column on that row makes "a status belongs to exactly one meter" a
     * property of the schema; a join table would make it a property of whatever
     * code last wrote to it.
     *
     * Added by `addColumn` in `ensureOverviewFoundation`, so it is absent on a
     * database that has not booted this release yet. Every reader coalesces.
     */
    meterKey: text("meter_key"),
    updatedByEmail: text("updated_by_email"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("job_status_map_label_idx").on(table.organisationId, table.sourceStatusLabel),
  ],
);

/**
 * England and Wales bank holidays, as DATA and not as an algorithm.
 *
 * Substitute days are rows in their own right. Not organisation-scoped: a bank
 * holiday is a fact about the country, not about a tenant.
 */
export const bankHolidays = sqliteTable(
  "bank_holidays",
  {
    id: text("id").primaryKey(),
    jurisdiction: text("jurisdiction").notNull().default("england-and-wales"),
    holidayDate: text("holiday_date").notNull(),
    title: text("title").notNull(),
    source: text("source"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("bank_holidays_date_idx").on(table.jurisdiction, table.holidayDate)],
);

/**
 * A waived data issue.
 *
 * `reason` is NOT NULL because the waiver is only meaningful with one: it is
 * printed into the report's data-quality notes, so an empty reason would put a
 * blank line where the justification should be.
 */
export const reportIssueWaivers = sqliteTable(
  "report_issue_waivers",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    invoiceId: text("invoice_id").notNull(),
    issueCode: text("issue_code").notNull(),
    subjectId: text("subject_id"),
    reason: text("reason").notNull(),
    waivedByEmail: text("waived_by_email"),
    waivedAt: text("waived_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    revokedAt: text("revoked_at"),
    revokedByEmail: text("revoked_by_email"),
  },
  (table) => [index("report_issue_waivers_invoice_idx").on(table.invoiceId)],
);

/* ────────────────────────────────────────────────────────────────────────────
 * THE OVERVIEW'S METER MODEL
 *
 * Eight meters, and every status this workspace has ever seen belongs to
 * exactly one of them. The assignment itself lives on `job_status_map.meter_key`
 * — that table already holds one row per (organisation, status label) behind a
 * UNIQUE index, so "a status belongs to exactly one meter" is a property of the
 * schema rather than of the code that reads it. What lives HERE is the meter: a
 * name an operator can change, a colour, a position and whether it draws a tile.
 *
 * `is_catch_all` marks `other`, which cannot be deleted, hidden, or emptied of
 * its role. It is a column and not a comparison against the literal string
 * "other" because the display label is editable and the key has to survive
 * being renamed on screen.
 * ──────────────────────────────────────────────────────────────────────────── */
export const dashboardMeters = sqliteTable(
  "dashboard_meters",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    meterKey: text("meter_key").notNull(),
    displayLabel: text("display_label").notNull(),
    colourHex: text("colour_hex").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    visible: integer("visible", { mode: "boolean" }).notNull().default(true),
    isCatchAll: integer("is_catch_all", { mode: "boolean" }).notNull().default(false),
    updatedByEmail: text("updated_by_email"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("dashboard_meters_key_idx").on(table.organisationId, table.meterKey),
  ],
);

/**
 * THE SLA LADDER THE OVERVIEW MEASURES AGAINST — versioned, never overwritten.
 *
 * A row is never edited. Changing a target closes the old row by stamping
 * `superseded_at` and inserts a new one with the next `version`, so a chart of
 * last quarter is still drawn against the target that applied last quarter.
 * That is the whole reason this is not four numbers in a constants file.
 *
 * NOT the same question as `sla_rules`. That table holds the CONTRACTUAL
 * resolution target in whole working days, per classification, and Module 4's
 * client report is its only reader. This one holds the OPERATIONAL ladder —
 * acknowledged / assigned / attended / resolved, per priority, in minutes — and
 * the Overview's SLA tab is its only reader. Two different agreements measured
 * at two different granularities; merging them would force one to lie about the
 * other's units.
 */
export const slaTargets = sqliteTable(
  "sla_targets",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    /** acknowledged | assigned | attended | resolved */
    stage: text("stage").notNull(),
    /** urgent | medium | low | not_recorded — `normalisePriority`'s vocabulary. */
    priorityKey: text("priority_key").notNull(),
    targetMinutes: integer("target_minutes").notNull(),
    /** business | calendar — business honours `bank_holidays`. */
    basis: text("basis").notNull().default("business"),
    version: integer("version").notNull().default(1),
    effectiveFrom: text("effective_from").notNull(),
    supersededAt: text("superseded_at"),
    note: text("note"),
    updatedByEmail: text("updated_by_email"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("sla_targets_lookup_idx").on(table.organisationId, table.stage, table.supersededAt),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * MODULE 5 — THE INVOICE TRACKER
 *
 * WHY THE LEDGER IS THE `invoices` TABLE AND NOT A NEW ONE.
 *
 * Module 5 §1 is explicit: payable and receivable are one table with a
 * `direction`, "because the lifecycle is nearly identical and the reports that
 * matter — cash position, margin per job — need both sides in the same query".
 * A table called `invoices` already existed with exactly the payable shape —
 * one contractor bill against one job — and `app/api/workspace/route.ts` and
 * `app/lib/contractor-attribution.ts` both record the same finding about it: it
 * "has never been read or written by any code". Zero rows, zero readers. So it
 * is extended rather than duplicated; a second table meaning "invoice" beside a
 * dead one is how a ledger ends up with two answers.
 *
 * `service_invoices` is NOT this table and is not merged into it. That is
 * Module 4's document — MAINTSUPP's own coordination fee, with lines, a
 * snapshot and a five-state finalisation. It stays the authority for what was
 * issued; finalising one writes a RECEIVABLE row here so the ledger sees it,
 * which is Module 5 §12's "no re-entry, ever".
 *
 * MONEY IS INTEGER PENCE. `invoices.amount` is a legacy REAL and is left
 * untouched and unread — this file has said "money is stored in integer pence,
 * never a float" since the billing stack was built, and a ledger that has to
 * reconcile allocations to the penny is the last place to make an exception.
 *
 * BALANCE IS NEVER STORED. §6: "always compute it. A stored balance drifts and
 * then no one trusts the ledger." There is deliberately no balance column
 * anywhere below, and `app/lib/finance/balance.ts` is the only thing allowed to
 * answer the question.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ONE INVOICE ACROSS MANY JOBS.
 *
 * §4: "A contractor invoice covering four jobs at one site must split across
 * those jobs with a per-job allocation that sums to the invoice total. Enforce
 * the sum." The UNIQUE index is why a job cannot appear twice on one invoice
 * and quietly double its share.
 */
export const invoiceJobAllocations = sqliteTable(
  "invoice_job_alloc",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    invoiceId: text("invoice_id").notNull(),
    requestId: text("request_id").notNull(),
    amountPence: integer("amount_pence").notNull().default(0),
    note: text("note"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("invoice_job_alloc_invoice_idx").on(table.invoiceId),
    index("invoice_job_alloc_job_idx").on(table.requestId),
    uniqueIndex("invoice_job_alloc_once_idx").on(table.invoiceId, table.requestId),
  ],
);

/**
 * A PAYMENT IS ITS OWN RECORD.
 *
 * §6: "One invoice can have several payments; one payment can cover several
 * invoices." Neither of those survives a `paid_at` column, which is why the
 * money moves in this table and the link lives in `payment_alloc`.
 */
export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    reference: text("reference"),
    /** in | out — money arriving settles receivables, money leaving settles payables. */
    direction: text("direction").notNull(),
    amountPence: integer("amount_pence").notNull().default(0),
    paymentDate: text("payment_date").notNull(),
    /** bank_transfer | card | direct_debit | cheque | offset */
    method: text("method").notNull().default("bank_transfer"),
    paymentSourceId: text("payment_source_id"),
    paymentRunId: text("payment_run_id"),
    /** The remittance advice, in the private bucket. §15.12. */
    attachmentId: text("attachment_id"),
    note: text("note"),
    recordedBy: text("recorded_by"),
    recordedAt: text("recorded_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("payments_org_idx").on(table.organisationId, table.paymentDate),
    index("payments_run_idx").on(table.paymentRunId),
  ],
);

export const paymentAllocations = sqliteTable(
  "payment_alloc",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    paymentId: text("payment_id").notNull(),
    invoiceId: text("invoice_id").notNull(),
    amountPence: integer("amount_pence").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("payment_alloc_payment_idx").on(table.paymentId),
    index("payment_alloc_invoice_idx").on(table.invoiceId),
    uniqueIndex("payment_alloc_once_idx").on(table.paymentId, table.invoiceId),
  ],
);

/**
 * A CREDIT NOTE, WHICH IS HOW A FINALISED INVOICE IS CORRECTED.
 *
 * §6 and §15.14: after finalisation the accounting facts are immutable and a
 * correction is a new document, never an edit. `amount_pence` is always
 * positive here; what it does to a balance is decided by the direction of the
 * invoice it credits, and only `app/lib/finance/balance.ts` decides it.
 */
export const creditNotes = sqliteTable(
  "credit_notes",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    reference: text("reference"),
    invoiceId: text("invoice_id").notNull(),
    amountPence: integer("amount_pence").notNull().default(0),
    reason: text("reason").notNull(),
    issuedDate: text("issued_date").notNull(),
    attachmentId: text("attachment_id"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("credit_notes_invoice_idx").on(table.invoiceId)],
);

/**
 * WHAT THE THREE-WAY MATCH FOUND.
 *
 * A flag is a row and not a computed view, because it can be WAIVED — and a
 * waiver has an author, a typed reason and a time. §7: flags "block Approved
 * for payment until cleared or waived with a typed reason". A
 * recomputed-on-read flag cannot carry that, so the engine reconciles rows
 * rather than replacing them: an open flag whose cause has gone is cleared, a
 * waived one stays waived.
 */
export const invoiceFlags = sqliteTable(
  "invoice_flags",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    invoiceId: text("invoice_id").notNull(),
    /**
     * no_approved_quote | over_quote | job_not_complete | site_mismatch |
     * possible_duplicate | no_linked_job | vat_anomaly | outside_agreement
     */
    flagType: text("flag_type").notNull(),
    /** blocking | warning */
    severity: text("severity").notNull().default("blocking"),
    detail: text("detail"),
    /** open | cleared | waived */
    status: text("status").notNull().default("open"),
    waivedBy: text("waived_by"),
    waiveReason: text("waive_reason"),
    waivedAt: text("waived_at"),
    clearedAt: text("cleared_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("invoice_flags_invoice_idx").on(table.invoiceId, table.status),
    uniqueIndex("invoice_flags_once_idx").on(table.invoiceId, table.flagType),
  ],
);

/**
 * THE EDITABLE STATUS VOCABULARY, one row per (direction, status).
 *
 * Follows `job_status_map` exactly — same shape, same reason. §5: "Unmapped
 * statuses render grey with the raw label and raise an admin notice, never
 * disappear."
 */
export const invoiceStatusMap = sqliteTable(
  "invoice_status_map",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    direction: text("direction").notNull(),
    statusKey: text("status_key").notNull(),
    displayLabel: text("display_label").notNull(),
    colourHex: text("colour_hex").notNull(),
    icon: text("icon"),
    countsAsOpen: integer("counts_as_open", { mode: "boolean" }).notNull().default(true),
    countsAsOverdueEligible: integer("counts_as_overdue_eligible", { mode: "boolean" })
      .notNull()
      .default(true),
    isTerminal: integer("is_terminal", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    updatedByEmail: text("updated_by_email"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("invoice_status_map_key_idx").on(
      table.organisationId,
      table.direction,
      table.statusKey,
    ),
  ],
);

/**
 * VALUE-BANDED APPROVAL, as rows rather than as thresholds in code.
 *
 * §13. Bands are half-open on the upper bound and `max_amount_pence` NULL means
 * "and above", so the ladder always covers every amount and an invoice can
 * never fall between two rules.
 */
export const approvalRules = sqliteTable(
  "approval_rules",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    direction: text("direction").notNull().default("payable"),
    minAmountPence: integer("min_amount_pence").notNull().default(0),
    maxAmountPence: integer("max_amount_pence"),
    approversRequired: integer("approvers_required").notNull().default(1),
    requiresClient: integer("requires_client", { mode: "boolean" }).notNull().default(false),
    /** Above this, whoever approved the quote may not approve the invoice. §13. */
    makerCheckerFromPence: integer("maker_checker_from_pence"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    updatedByEmail: text("updated_by_email"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("approval_rules_band_idx").on(table.organisationId, table.direction)],
);

/** Every status transition, append-only. §2: "This is the audit trail, and it is the point of the module." */
export const invoiceStatusHistory = sqliteTable(
  "invoice_status_history",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    invoiceId: text("invoice_id").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorEmail: text("actor_email"),
    actorUserId: text("actor_user_id"),
    reason: text("reason"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("invoice_status_history_invoice_idx").on(table.invoiceId)],
);

/** One approver's decision, and the rule it satisfied. One row per approver per invoice. */
export const invoiceApprovalRecords = sqliteTable(
  "invoice_approval_records",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    invoiceId: text("invoice_id").notNull(),
    approverEmail: text("approver_email").notNull(),
    approverUserId: text("approver_user_id"),
    /** approved | rejected | client_signed_off */
    decision: text("decision").notNull(),
    /** The sentence shown beside the approval: which band, how many approvers. */
    basis: text("basis"),
    ruleId: text("rule_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("invoice_approval_records_invoice_idx").on(table.invoiceId),
    uniqueIndex("invoice_approval_records_once_idx").on(table.invoiceId, table.approverEmail),
  ],
);

/** A batch of approved payables scheduled together and exported as one bank file. §13. */
export const paymentRuns = sqliteTable(
  "payment_runs",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    reference: text("reference").notNull(),
    paymentDate: text("payment_date").notNull(),
    /** draft | scheduled | paid | cancelled */
    status: text("status").notNull().default("draft"),
    paymentSourceId: text("payment_source_id"),
    totalPence: integer("total_pence").notNull().default(0),
    invoiceCount: integer("invoice_count").notNull().default(0),
    exportedAt: text("exported_at"),
    exportFilename: text("export_filename"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("payment_runs_org_idx").on(table.organisationId, table.paymentDate)],
);

/**
 * BANK ACCOUNTS LIVE IN SETTINGS AND NOWHERE ELSE.
 *
 * §16: "Bank details appear only in settings, never in code." `contractors`
 * deliberately carries no account number at all — this repository is public —
 * and that rule is not relaxed here. These are the WORKSPACE's own accounts,
 * the ones a payment run debits, typed by an administrator into a form and
 * never committed to a file. `sort_code` and `account_number` are returned
 * masked to anybody without `billing.manage`, by `app/lib/finance/banking.ts`.
 */
export const paymentSources = sqliteTable(
  "payment_sources",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    /*
     * NO PAYMENT CREDENTIAL IS STORED HERE, AND THAT IS DELIBERATE.
     *
     * §16 asks for bank details in settings, and this table held
     * `bank_name`, `sort_code`, `account_number` and `iban` for one commit.
     * It should not have: W06-09 is an OWNER-APPROVED security decision that
     * predates Module 5 — "the owner-approved payment model is TERMS plus an
     * EXTERNAL accounting reference, and it is approved precisely because the
     * alternative … is a breach waiting for its first misconfigured backup.
     * The accounting system that already holds those is built for them." This
     * repository is public, and an independent security review reached the
     * same conclusion from the other end.
     *
     * So a bank account here is a NAME somebody recognises plus the reference
     * that finds it in the accounting system — enough to say which account a
     * payment run is drawn on, and nothing anybody could pay from. The
     * payment-run export already returns empty payee columns and says so in
     * its own header; this is the same decision, one table earlier.
     */
    label: text("label").notNull(),
    accountName: text("account_name"),
    /** The account's id in the accounting system, not a credential. */
    accountingReference: text("accounting_reference"),
    referencePrefix: text("reference_prefix"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    updatedByEmail: text("updated_by_email"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("payment_sources_org_idx").on(table.organisationId)],
);

/** §15.9 — a dispute has a record rather than living in an inbox. */
export const invoiceDisputes = sqliteTable(
  "invoice_disputes",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    invoiceId: text("invoice_id").notNull(),
    reason: text("reason").notNull(),
    detail: text("detail"),
    /** open | resolved | withdrawn */
    status: text("status").notNull().default("open"),
    raisedBy: text("raised_by"),
    raisedAt: text("raised_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    resolution: text("resolution"),
    resolvedBy: text("resolved_by"),
    resolvedAt: text("resolved_at"),
  },
  (table) => [index("invoice_disputes_invoice_idx").on(table.invoiceId, table.status)],
);

/** §15.4 — what the supplier thinks you owe, against what the ledger holds. */
export const supplierStatements = sqliteTable(
  "supplier_statements",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    counterpartyId: text("counterparty_id"),
    counterpartyName: text("counterparty_name"),
    statementDate: text("statement_date").notNull(),
    claimedTotalPence: integer("claimed_total_pence").notNull().default(0),
    sourceFilename: text("source_filename"),
    uploadedBy: text("uploaded_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("supplier_statements_org_idx").on(table.organisationId, table.statementDate)],
);

export const supplierStatementLines = sqliteTable(
  "supplier_statement_lines",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    statementId: text("statement_id").notNull(),
    supplierRef: text("supplier_ref"),
    invoiceDate: text("invoice_date"),
    amountPence: integer("amount_pence").notNull().default(0),
    matchedInvoiceId: text("matched_invoice_id"),
    /** matched | supplier_only | ledger_only | amount_differs */
    matchState: text("match_state").notNull().default("supplier_only"),
    note: text("note"),
  },
  (table) => [index("supplier_statement_lines_statement_idx").on(table.statementId)],
);

/** §15.13 — the monthly retainer generates on a schedule rather than being remembered. */
export const recurringInvoiceRules = sqliteTable(
  "recurring_invoice_rules",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    direction: text("direction").notNull().default("receivable"),
    counterpartyId: text("counterparty_id"),
    description: text("description"),
    netPence: integer("net_pence").notNull().default(0),
    category: text("category"),
    /** monthly | quarterly | annually */
    frequency: text("frequency").notNull().default("monthly"),
    dayOfMonth: integer("day_of_month").notNull().default(1),
    paymentTermsDays: integer("payment_terms_days"),
    nextRunDate: text("next_run_date"),
    lastRunAt: text("last_run_at"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("recurring_invoice_rules_due_idx").on(table.nextRunDate, table.active)],
);

/**
 * WHAT A PDF READER THOUGHT IT SAW — a suggestion, never a value.
 *
 * §12: "Never save an extracted value without human confirmation. Extraction
 * that writes silently will eventually book a wrong amount." So an extraction
 * is its own row with its own confidences, and nothing it holds reaches
 * `invoices` until somebody accepts it in the form.
 */
export const invoiceExtractions = sqliteTable(
  "invoice_extractions",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    attachmentId: text("attachment_id"),
    invoiceId: text("invoice_id"),
    engine: text("engine").notNull().default("heuristic"),
    fieldsJson: text("fields_json").notNull().default("{}"),
    confidenceJson: text("confidence_json").notNull().default("{}"),
    /** suggested | accepted | rejected */
    status: text("status").notNull().default("suggested"),
    acceptedBy: text("accepted_by"),
    acceptedAt: text("accepted_at"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("invoice_extractions_attachment_idx").on(table.attachmentId)],
);

/** §12 — the `invoices@` boundary. A message becomes a Draft payable, never a posted one. */
export const financeInbox = sqliteTable(
  "finance_inbox",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    messageId: text("message_id"),
    sender: text("sender"),
    subject: text("subject"),
    receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    attachmentId: text("attachment_id"),
    invoiceId: text("invoice_id"),
    /** received | drafted | rejected */
    status: text("status").notNull().default("received"),
    error: text("error"),
  },
  (table) => [
    index("finance_inbox_org_idx").on(table.organisationId, table.status),
    uniqueIndex("finance_inbox_message_idx").on(table.organisationId, table.messageId),
  ],
);
