import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/*
 * Postgres, via Supabase. Converted from SQLite/D1.
 *
 * TIMESTAMPS ARE DELIBERATELY STILL `text`.
 *
 * They were text in SQLite and the whole app reads, sorts and compares them as
 * "YYYY-MM-DD HH:MM:SS" strings. Postgres's bare CURRENT_TIMESTAMP would write
 * "2026-08-06 15:02:45.123456+00" instead — microseconds and an offset — which
 * silently changes every string comparison and every value the API returns.
 * `NOW_UTC` below reproduces the exact SQLite format, so the conversion changes
 * the engine without changing the data.
 *
 * Moving these to real `timestamptz` columns is the right long-term shape, but
 * it is a data-model change touching every consumer, not part of a port.
 */
const NOW_UTC = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')`;

export const sites = pgTable(
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
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    position: integer("position").notNull().default(0),
    active: boolean("active").notNull().default(true),

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

    // X11 — monday name reconciliation. Both boards describe the same sites
    // under different names; the importer matches on either.
    mondayMaintenanceName: text("monday_maintenance_name"),
    mondayComplianceName: text("monday_compliance_name"),

    notes: text("notes"),
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
  },
  (table) => [
    index("sites_organisation_idx").on(table.organisationId),
    index("sites_lifecycle_idx").on(table.lifecycle),
    index("sites_organisation_status_idx").on(table.organisationId, table.status),
    index("sites_organisation_position_idx").on(table.organisationId, table.position),
    uniqueIndex("sites_organisation_slug_idx").on(table.organisationId, table.slug),
  ],
);

// X11 — unlimited additional aliases beyond the two named monday columns, so
// that U9 can resolve any historic spelling to one canonical site.
export const siteAliases = pgTable(
  "site_aliases",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    siteId: text("site_id").notNull().references(() => sites.id),
    alias: text("alias").notNull(),
    normalised: text("normalised").notNull(),
    source: text("source").notNull().default("manual"),
    createdAt: text("created_at").notNull().default(NOW_UTC),
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
export const siteGroups = pgTable(
  "site_groups",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    kind: text("kind").notNull().default("region"),
    colourHex: text("colour_hex").notNull().default("#12B4A8"),
    position: integer("position").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
  },
  (table) => [
    uniqueIndex("site_groups_organisation_slug_idx").on(table.organisationId, table.slug),
    index("site_groups_organisation_position_idx").on(table.organisationId, table.position),
  ],
);

export const siteGroupMembers = pgTable(
  "site_group_members",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    siteGroupId: text("site_group_id").notNull().references(() => siteGroups.id),
    siteId: text("site_id").notNull().references(() => sites.id),
    createdAt: text("created_at").notNull().default(NOW_UTC),
  },
  (table) => [
    uniqueIndex("site_group_members_pair_idx").on(table.siteGroupId, table.siteId),
    index("site_group_members_site_idx").on(table.siteId),
  ],
);

// X12/X13 — every import-time correction and every rejected placeholder is
// recorded here rather than applied silently. Compliance and site data are
// legally significant, so nothing is auto-corrected without a visible trail.
export const importAnomalies = pgTable(
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
    resolved: boolean("resolved").notNull().default(false),
    resolvedBy: text("resolved_by"),
    resolvedAt: text("resolved_at"),
    createdAt: text("created_at").notNull().default(NOW_UTC),
  },
  (table) => [
    index("import_anomalies_organisation_idx").on(table.organisationId),
    index("import_anomalies_batch_idx").on(table.batchId),
    index("import_anomalies_resolved_idx").on(table.organisationId, table.resolved),
  ],
);

export const organisations = pgTable("organisations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logoUrl: text("logo_url"),
  primaryColour: text("primary_colour").notNull().default("#12B4A8"),
  planTier: text("plan_tier").notNull().default("development"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(NOW_UTC),
  updatedAt: text("updated_at").notNull().default(NOW_UTC),
});

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    email: text("email").notNull().unique(),
    fullName: text("full_name"),
    role: text("role").notNull().default("client_user"),
    active: boolean("active").notNull().default(true),
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
  },
  (table) => [index("users_organisation_idx").on(table.organisationId)],
);

export const units = pgTable(
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

    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
  },
  (table) => [
    index("units_organisation_idx").on(table.organisationId),
    index("units_site_idx").on(table.siteId),
    index("units_next_service_idx").on(table.organisationId, table.nextServiceDueAt),
  ],
);

// W5 — service history. One row per visit, so a unit's record is a timeline
// rather than a single overwritten "last serviced" field.
export const unitServiceRecords = pgTable(
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
    createdAt: text("created_at").notNull().default(NOW_UTC),
  },
  (table) => [
    index("unit_service_unit_idx").on(table.unitId, table.performedAt),
    index("unit_service_organisation_idx").on(table.organisationId),
  ],
);

export const contractors = pgTable(
  "contractors",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    serviceCategories: text("service_categories").notNull().default("[]"),
    coverageAreas: text("coverage_areas").notNull().default("[]"),
    certifications: text("certifications").notNull().default("[]"),
    insuranceExpiry: text("insurance_expiry"),
    availability: text("availability").notNull().default("Available"),
    rating: doublePrecision("rating"),
    active: boolean("active").notNull().default(true),
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
  },
  (table) => [index("contractors_organisation_idx").on(table.organisationId)],
);

export const maintenanceRequests = pgTable(
  "maintenance_requests",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    legacyClientId: text("client_id").notNull().default("sunnamusk-uk"),
    siteId: text("site_id").notNull(),
    source: text("source").notNull().default("Portal form"),
    title: text("title").notNull(),
    reference: text("reference"),
    completionRequestedAt: text("completion_requested_at"),
    completionRequestedBy: text("completion_requested_by"),
    completionNote: text("completion_note"),
    blockedReason: text("blocked_reason"),
    notifiedAt: text("notified_at"),
    notifyAttempts: integer("notify_attempts").notNull().default(0),
    parentId: text("parent_id"),
    archived: boolean("archived").notNull().default(false),
    archivedAt: text("archived_at"),
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
    assignee: text("assignee"),
    requestedAt: text("requested_at").notNull().default(NOW_UTC),
    dueAt: text("due_at"),
    completedAt: text("completed_at"),
    nextUpdateAt: text("next_update_at"),
    cost: doublePrecision("cost"),
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
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
  },
  (table) => [
    index("maintenance_organisation_stage_idx").on(table.organisationId, table.stage),
    index("maintenance_site_idx").on(table.siteId),
    index("maintenance_priority_idx").on(table.priority),
  ],
);

export const plannedMaintenance = pgTable(
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
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
  },
  (table) => [
    index("planned_maintenance_organisation_idx").on(table.organisationId),
    index("planned_maintenance_site_idx").on(table.siteId),
    index("planned_maintenance_due_idx").on(table.nextDueAt),
  ],
);

export const quotations = pgTable(
  "quotations",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    requestId: text("request_id").notNull().references(() => maintenanceRequests.id),
    contractorId: text("contractor_id").references(() => contractors.id),
    amount: doublePrecision("amount").notNull(),
    status: text("status").notNull().default("Awaiting approval"),
    attachmentId: text("attachment_id"),
    submittedAt: text("submitted_at").notNull().default(NOW_UTC),
    approvedAt: text("approved_at"),
  },
  (table) => [
    index("quotations_organisation_idx").on(table.organisationId),
    index("quotations_request_idx").on(table.requestId),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    requestId: text("request_id").notNull().references(() => maintenanceRequests.id),
    contractorId: text("contractor_id").references(() => contractors.id),
    invoiceNumber: text("invoice_number"),
    amount: doublePrecision("amount").notNull(),
    status: text("status").notNull().default("Awaiting payment"),
    dueAt: text("due_at"),
    paidAt: text("paid_at"),
    attachmentId: text("attachment_id"),
    createdAt: text("created_at").notNull().default(NOW_UTC),
  },
  (table) => [
    index("invoices_organisation_idx").on(table.organisationId),
    index("invoices_request_idx").on(table.requestId),
  ],
);

export const systemNotifications = pgTable(
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
    createdAt: text("created_at").notNull().default(NOW_UTC),
  },
  (table) => [
    index("system_notifications_organisation_idx").on(table.organisationId),
    index("system_notifications_user_idx").on(table.userEmail, table.readAt),
    index("system_notifications_entity_idx").on(table.entityType, table.entityId),
  ],
);

export const leads = pgTable(
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
    createdAt: text("created_at").notNull().default(NOW_UTC),
  },
  (table) => [
    index("leads_organisation_idx").on(table.organisationId),
    index("leads_created_idx").on(table.createdAt),
  ],
);

export const maintenanceGroups = pgTable(
  "maintenance_groups",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    legacyClientId: text("client_id").notNull().default("sunnamusk-uk"),
    boardId: text("board_id").notNull().default("maintenance"),
    name: text("name").notNull(),
    color: text("color").notNull().default("#579bfc"),
    stageKey: text("stage_key"),
    collapsed: boolean("collapsed").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    description: text("description"),
    position: integer("position").notNull().default(0),
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
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

export const maintenanceGroupItems = pgTable(
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
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
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

export const maintenanceBoardOptions = pgTable(
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
    active: boolean("active").notNull().default(true),
    system: boolean("system").notNull().default(false),
    position: integer("position").notNull().default(0),
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
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

export const maintenanceBoardColumns = pgTable(
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
    system: boolean("system").notNull().default(false),
    visible: boolean("visible").notNull().default(true),
    pinned: boolean("pinned").notNull().default(false),
    required: boolean("required").notNull().default(false),
    summary: text("summary"),
    optionSetKey: text("option_set_key"),
    description: text("description"),
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
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

export const maintenanceBoardCells = pgTable(
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
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
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

export const attachments = pgTable(
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
    objectKey: text("object_key").notNull().unique(),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    uploadedByEmail: text("uploaded_by_email"),
    pending: boolean("pending").notNull().default(false),
    submittedVia: text("submitted_via"),
    reviewedAt: text("reviewed_at"),
    reviewedBy: text("reviewed_by"),
    createdAt: text("created_at").notNull().default(NOW_UTC),
  },
  (table) => [
    index("attachments_organisation_idx").on(table.organisationId),
    index("attachments_request_idx").on(table.requestId),
    index("attachments_site_idx").on(table.siteId),
    index("attachments_unit_idx").on(table.unitId),
    index("attachments_board_column_idx").on(
      table.boardColumnId,
      table.requestId,
    ),
  ],
);

export const complianceDocuments = pgTable(
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
    notRequired: boolean("not_required")
      .notNull()
      .default(false),
    lastAlertAt: text("last_alert_at"),
    lastAlertStage: text("last_alert_stage"),
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
  },
  (table) => [
    index("compliance_organisation_idx").on(table.organisationId),
    index("compliance_site_kind_idx").on(table.siteId, table.kind),
    index("compliance_expiry_idx").on(table.expiryDate),
  ],
);

export const activityLog = pgTable(
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
    createdAt: text("created_at").notNull().default(NOW_UTC),
  },
  (table) => [
    index("activity_organisation_idx").on(table.organisationId),
    index("activity_entity_idx").on(table.entityType, table.entityId),
    index("activity_created_idx").on(table.createdAt),
  ],
);

export const workspaceSettings = pgTable(
  "workspace_settings",
  {
    legacyClientId: text("client_id").primaryKey().default("sunnamusk-uk"),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    settings: text("settings").notNull().default("{}"),
    updatedByEmail: text("updated_by_email"),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
  },
  (table) => [uniqueIndex("workspace_settings_organisation_idx").on(table.organisationId)],
);

export const memberships = pgTable(
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
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
  },
  (table) => [
    uniqueIndex("memberships_user_organisation_idx").on(table.userId, table.organisationId),
    index("memberships_organisation_idx").on(table.organisationId),
  ],
);

export const optionSets = pgTable(
  "option_sets",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
  },
  (table) => [
    uniqueIndex("option_sets_organisation_key_idx").on(table.organisationId, table.key),
  ],
);

export const optionValues = pgTable(
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
    isDone: boolean("is_done").notNull().default(false),
    isDefault: boolean("is_default").notNull().default(false),
    active: boolean("active").notNull().default(true),
    system: boolean("system").notNull().default(false),
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
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
export const boards = pgTable(
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
    archived: boolean("archived").notNull().default(false),
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
  },
  (table) => [
    uniqueIndex("boards_org_key_idx").on(table.organisationId, table.key),
    index("boards_org_idx").on(table.organisationId),
  ],
);

/** Item comments — powers the board's update bubble (AA16). Group V extends. */
export const itemUpdates = pgTable(
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
    createdAt: text("created_at").notNull().default(NOW_UTC),
  },
  (table) => [index("item_updates_request_idx").on(table.organisationId, table.requestId)],
);

/** Per-item change log — who changed what, from what, to what, when. */
export const itemActivity = pgTable(
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
    createdAt: text("created_at").notNull().default(NOW_UTC),
  },
  (table) => [index("item_activity_request_idx").on(table.organisationId, table.requestId)],
);


/** Saved board views — Stage 5, items P1 and AA3–AA7. */
export const boardViews = pgTable(
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
    isDefault: boolean("is_default").notNull().default(false),
    system: boolean("system").notNull().default(false),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
  },
  (table) => [
    uniqueIndex("board_views_org_key_idx").on(table.organisationId, table.boardId, table.key),
    index("board_views_org_position_idx").on(table.organisationId, table.boardId, table.position),
  ],
);


/** Delivery record for every notification — Stage 7, item J6. */
export const notificationLog = pgTable(
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
    createdAt: text("created_at").notNull().default(NOW_UTC),
    updatedAt: text("updated_at").notNull().default(NOW_UTC),
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
export const jobAccessTokens = pgTable(
  "job_access_tokens",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull().references(() => organisations.id),
    requestId: text("request_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    audience: text("audience").notNull().default("contractor"),
    label: text("label"),
    allowedKinds: text("allowed_kinds").notNull().default('["completion","nameplate"]'),
    canComment: boolean("can_comment").notNull().default(true),
    canRequestCompletion: boolean("can_request_completion")
      .notNull()
      .default(true),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    createdBy: text("created_by"),
    firstOpenedAt: text("first_opened_at"),
    lastUsedAt: text("last_used_at"),
    useCount: integer("use_count").notNull().default(0),
    createdAt: text("created_at").notNull().default(NOW_UTC),
  },
  (table) => [
    uniqueIndex("job_access_tokens_hash_idx").on(table.tokenHash),
    index("job_access_tokens_request_idx").on(table.organisationId, table.requestId),
  ],
);
