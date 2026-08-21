/**
 * Monday board specification — the single source of truth for board structure.
 *
 * MAINTSUPP replaces monday.com rather than syncing with it, so the structure
 * below is a verbatim capture of the two live boards taken on 06 August 2026:
 *
 *   Maintenance          board 1139774521   25 columns · 38 groups
 *   Store Documentation  board 1398027719   24 columns ·  4 groups
 *
 * The Maintenance half was re-verified column for column, group for group and
 * label for label against `db/monday-export/MAINTENANCE-MONDAY-CAPTURE.md`
 * (captured 7 August 2026), which is the authority where the two disagree.
 * `tests/stage-nineteen-maintenance-parity.test.mjs` writes that capture out in
 * full and fails on any drift.
 *
 * Everything here is a SEED. Columns, groups and option values are all editable
 * in the UI afterwards; nothing in this file is consulted at request time.
 *
 * WHY THIS FILE EXISTS
 *
 * Board structure used to be declared twice — `systemBoardColumns` in
 * `app/api/board/route.ts` and `seedColumns` in `db/seed-board-structure.ts` —
 * and both wrote into `maintenance_board_columns`. The two sets described the
 * same fields under different keys, so every board carried 38 columns where it
 * should have carried 25: `Date requested` beside `Date Requested`,
 * `Pictures of maintenance issue` beside `Pictures of Maintenance Issue`, and
 * so on. Both seeders now read from here, and `reconcileDuplicateColumns`
 * clears the orphans out of databases that were provisioned before the merge.
 *
 * DELIBERATE DEPARTURES FROM MONDAY — each one is reversible in the UI:
 *
 *  - `Number` (contact) is `phone`, not `number`. Monday stores it numerically,
 *    which eats the leading zero on values like 07863234937.
 *  - `Cost of Works` is `number` and held in pence, matching the existing cell
 *    encoding; monday's numbers column is unit-less.
 *  - `Description of Works to be done` is `long_text`, not `text`. Monday holds
 *    it in a single-line text column (`short_text`) and truncates it in the
 *    cell; the request form asks for several sentences, so it is edited in a
 *    textarea here. Same title, same key, wider editor.
 *  - Group and option colours are monday's own hex values. They are row data in
 *    `maintenance_board_options` and `maintenance_groups`, not part of the
 *    MAINTSUPP interface palette, so copying them changes no site styling.
 *  - `Tier Level` carries colours. Monday's is a plain dropdown, which has no
 *    palette at all, so these four hexes are MAINTSUPP's own choice and the
 *    capture rightly records none. Nothing to reconcile.
 *
 * KNOWN MONDAY TYPOS, reproduced so imported rows map one-to-one. Renaming any
 * of them in the UI is a single edit:
 *
 *  - Engineer Required option "Plummer"      (should be "Plumber")
 *  - Group "Nottingham complited"            (should be "completed")
 *  - Group "Westfield Stratford  completed"  (double space)
 *  - Group "August  2026 Recently completed" (double space)
 */

export type SeedColumn = {
  key: string;
  title: string;
  type: string;
  width: number;
  optionSetKey?: string;
  description?: string;
  required?: boolean;
  system?: boolean;
  summary?: string;
};

export type SeedGroup = {
  key: string;
  name: string;
  colour: string;
  description?: string;
  collapsed?: boolean;
};

export type SeedOption = {
  value: string;
  label: string;
  colour: string;
  textColour?: string;
  isDone?: boolean;
};

/* ── Maintenance — columns ────────────────────────────────────────────────── */

/**
 * The 25 columns, in monday board order. Keys match the ones the live board
 * already renders, so no existing cell loses its column.
 *
 * Titles are monday's own, capitalisation included — "Job Requested by",
 * "Picture of completed works", "Approved by" — because `matchHeader` in
 * `app/lib/monday-import.ts` maps export headings onto these strings.
 *
 * The first column is titled "Name", which is what monday calls it on this
 * board. It read "Item" here, which is the generic monday item noun and the
 * default in `createBoard`, not this board's heading. The importer aliases
 * both, so the rename moves the rendered header without changing what an
 * export maps onto.
 */
export const maintenanceColumns: SeedColumn[] = [
  {
    key: "name",
    title: "Name",
    type: "text",
    width: 300,
    required: true,
    system: true,
    description: "Monday's Name column. How the job is listed on the board.",
  },
  { key: "location", title: "Location", type: "text", width: 190 },
  {
    key: "description",
    title: "Description of Works to be done",
    type: "long_text",
    width: 420,
    required: true,
  },
  {
    key: "tier",
    title: "Tier Level",
    type: "dropdown",
    width: 126,
    optionSetKey: "tier_level",
  },
  {
    key: "engineer",
    title: "Engineer Required",
    type: "status",
    width: 145,
    optionSetKey: "engineer_required",
  },
  {
    key: "priority",
    title: "Priority",
    type: "status",
    width: 135,
    optionSetKey: "priority",
    summary: "battery",
  },
  {
    key: "label",
    title: "Label",
    type: "status",
    width: 155,
    optionSetKey: "maintenance_label",
    description: "[Packaged column] Label 1.0.0",
  },
  {
    key: "status",
    title: "Status",
    type: "status",
    width: 175,
    optionSetKey: "maintenance_status",
    required: true,
    system: true,
    summary: "battery",
  },
  { key: "contractor", title: "Contractor", type: "text", width: 170 },
  { key: "assignee", title: "Assigned To", type: "people", width: 160 },
  { key: "requested", title: "Date Requested", type: "date", width: 145, summary: "min" },
  { key: "completed", title: "Date Completed", type: "date", width: 145, summary: "max" },
  { key: "timeline", title: "Timeline", type: "timeline", width: 200 },
  { key: "requester", title: "Job Requested by", type: "text", width: 175 },
  {
    key: "nextUpdate",
    title: "Next Update",
    type: "date",
    width: 145,
    description: "Drives the chase automation carried over from monday.",
  },
  {
    key: "issuePictures",
    title: "Pictures of Maintenance Issue",
    type: "files",
    width: 185,
    required: true,
    summary: "count",
  },
  {
    key: "completedPictures",
    title: "Picture of completed works",
    type: "files",
    width: 185,
    summary: "count",
    description: "Close-out evidence. A job cannot be marked done without it.",
  },
  {
    key: "cost",
    title: "Cost of Works",
    type: "number",
    width: 135,
    summary: "sum",
    description: "Held in pence.",
  },
  { key: "approvedBy", title: "Approved by", type: "text", width: 155 },
  {
    key: "subitems",
    title: "Subitems",
    type: "subitems",
    width: 150,
    system: true,
    summary: "count",
    description: "Child tasks. Monday keeps these on board 1164003119.",
  },
  { key: "invoice", title: "Invoice", type: "text", width: 145 },
  { key: "files", title: "Files", type: "files", width: 105, summary: "count" },
  {
    key: "number",
    title: "Number",
    type: "phone",
    width: 145,
    description: "Contact number. Text, not numeric — numeric drops the leading zero.",
  },
  {
    key: "storeLocation",
    title: "Store Location Name",
    type: "status",
    width: 215,
    optionSetKey: "store_location",
  },
  {
    key: "formView",
    title: "Form View",
    type: "link",
    width: 105,
    description: "Auto-generated by WorkForms on monday. Links to the public request form.",
  },
];

/**
 * MAINTSUPP-only columns. Neither is a monday column, which is why both are kept
 * out of `maintenanceColumns` — folding either in would make a parity count of
 * that array read 26 or 27 rather than monday's 25.
 *
 * `move` is the row's "move to group" control, which monday exposes from the row
 * menu rather than as a column. `dueDate` surfaces this product's own
 * `maintenance_requests.due_at`, which monday's board has no equivalent of.
 */
export const maintenanceUiColumns: SeedColumn[] = [
  { key: "move", title: "Group", type: "dropdown", width: 185, system: true },
  /*
   * The job's deadline, which the product has always had and the board has
   * never shown.
   *
   * `maintenance_requests.due_at` drives the overdue meter, the Planned
   * calendar and the SLA window, and until now the only way to set it was the
   * Timeline column's end handle or the request drawer. An operator looking at
   * the board could not see when a job was due, which is the single question a
   * maintenance board is opened to answer.
   *
   * It reads and writes THE SAME FIELD — there is no cell behind it. A date
   * column storing its own value would be a second deadline that the calendar
   * and the overdue count could not see, which is exactly the shadow this
   * board already refuses elsewhere.
   */
  { key: "dueDate", title: "Due Date", type: "date", width: 150 },
];

/* ── Maintenance — groups ─────────────────────────────────────────────────── */

/**
 * All 38 groups, in monday board order and with monday's colours.
 *
 * The 28 per-store and per-month archives are seeded `collapsed`, so the board
 * opens on the ten operational groups and the archive is one click away rather
 * than 700 rows of scrolling.
 */
export const maintenanceGroups: SeedGroup[] = [
  {
    key: "topics",
    name: "Incoming requests",
    colour: "#579bfc",
    description: "Newly submitted, not yet triaged.",
  },
  { key: "recently", name: "recently", colour: "#007eb5" },
  { key: "jobs-booked", name: "Jobs Booked", colour: "#9cd326" },
  {
    key: "needs-attention",
    name: "Needs attention",
    colour: "#ff642e",
    description: "Blocked, escalated or overdue.",
  },
  { key: "completed-2026-08", name: "August  2026 Recently completed", colour: "#9cd326" },
  { key: "completed-2026-07", name: "July 2026 Recently completed", colour: "#df2f4a" },
  { key: "completed-2026-06", name: "June 2026 Recently completed", colour: "#66ccff" },
  { key: "on-hold", name: "On Hold", colour: "#bb3354" },
  { key: "access-requests", name: "Access Requests", colour: "#c4c4c4" },
  { key: "international", name: "International", colour: "#00c875" },
  { key: "done-wood-green", name: "Wood Green completed", colour: "#757575", collapsed: true },
  { key: "done-aldgate", name: "Aldgate completed", colour: "#9cd326", collapsed: true },
  { key: "done-arndale", name: "Arndale completed", colour: "#ff5ac4", collapsed: true },
  { key: "done-bluewater", name: "Bluewater completed", colour: "#fdab3d", collapsed: true },
  { key: "done-brent-cross", name: "Brent Cross completed", colour: "#9cd326", collapsed: true },
  { key: "done-brighton", name: "Brighton completed", colour: "#ffcb00", collapsed: true },
  {
    key: "done-bespoke-whitecity",
    name: "Bespoke whitecity completed",
    colour: "#784bd1",
    collapsed: true,
  },
  {
    key: "done-bristol-cabot-circus",
    name: "Bristol Cabot Circus completed",
    colour: "#757575",
    collapsed: true,
  },
  { key: "done-bullring", name: "Bullring completed", colour: "#ff007f", collapsed: true },
  { key: "done-cambridge", name: "Cambridge completed", colour: "#fdab3d", collapsed: true },
  { key: "done-cardiff", name: "Cardiff completed", colour: "#bb3354", collapsed: true },
  { key: "done-cribbs", name: "Cribbs completed", colour: "#ff5ac4", collapsed: true },
  { key: "done-derby", name: "Derby completed", colour: "#cab641", collapsed: true },
  {
    key: "done-glasgow-silverburn",
    name: "Glasgow Silverburn completed",
    colour: "#579bfc",
    collapsed: true,
  },
  {
    key: "done-highcross-leicester",
    name: "Highcross Leicester completed",
    colour: "#00c875",
    collapsed: true,
  },
  {
    key: "done-meadowhall-sheffield",
    name: "Meadowhall Sheffield completed",
    colour: "#00c875",
    collapsed: true,
  },
  { key: "done-merry-hill", name: "Merry Hill completed", colour: "#037f4c", collapsed: true },
  { key: "done-metro-centre", name: "Metro Centre completed", colour: "#9cd326", collapsed: true },
  {
    key: "done-milton-keynes",
    name: "Milton Keynes completed",
    colour: "#9cd326",
    collapsed: true,
  },
  { key: "done-nottingham", name: "Nottingham complited", colour: "#579bfc", collapsed: true },
  { key: "done-reading", name: "Reading completed", colour: "#ff5ac4", collapsed: true },
  { key: "done-white-city", name: "White City completed", colour: "#cab641", collapsed: true },
  {
    key: "done-sjq-edinburgh",
    name: "SJQ Edinburgh completed",
    colour: "#7f5347",
    collapsed: true,
  },
  { key: "done-solihull", name: "Solihull completed", colour: "#ff5ac4", collapsed: true },
  { key: "done-southall", name: "Southall completed", colour: "#9d50dd", collapsed: true },
  {
    key: "done-westfield-stratford",
    name: "Westfield Stratford  completed",
    colour: "#7f5347",
    collapsed: true,
  },
  {
    key: "done-trafford-centre",
    name: "Trafford centre completed",
    colour: "#ff5ac4",
    collapsed: true,
  },
  { key: "done-watford", name: "Watford completed", colour: "#cab641", collapsed: true },
];

/* ── Maintenance — option sets ────────────────────────────────────────────── */

/**
 * Option values per column key, in monday's display order with monday's hexes.
 * `#ffffff` text is used on every chip except the pale ones, which monday also
 * renders dark.
 */
const PALE = new Set(["#c4c4c4", "#ffcb00", "#cab641", "#9cd326", "#ffadad", "#ff7575", "#faa1f1"]);

function opt(label: string, colour: string, isDone = false): SeedOption {
  return {
    value: label,
    label,
    colour,
    textColour: PALE.has(colour) ? "#101820" : "#ffffff",
    isDone,
  };
}

export const maintenanceOptions: Record<string, SeedOption[]> = {
  /** Monday dropdown_mm51wmh0 — a plain dropdown, so monday assigns no colours. */
  tier_level: [
    opt("Tier 1", "#e2445c"),
    opt("Tier 2", "#fdab3d"),
    opt("Tier 3", "#579bfc"),
    opt("Tier 4", "#00c875"),
  ],

  /** Monday single_select. Order is monday's index order, not its id order. */
  engineer_required: [
    opt("Plummer", "#df2f4a"),
    opt("Electrician", "#00c875"),
    opt("Handyman", "#fdab3d"),
    opt("Other", "#007eb5"),
  ],

  /**
   * Monday status column `status` — three real labels, in index order.
   *
   * Monday also carries a fourth label (id 4) whose text is empty. That is its
   * "no value" chip, not a choice: monday hides it from the dropdown and shows
   * an unset cell as blank. Seeding it would put an unlabelled, unpickable chip
   * in the options admin, so the three real labels are all that come across.
   */
  priority: [opt("Medium", "#fdab3d"), opt("Low", "#00c875"), opt("Urgent", "#df2f4a")],

  /**
   * Monday color_mm0ahrtb — 16 real labels, in index order (monday orders the
   * dropdown by `index`, which is not its id order). Monday's blank label id 5
   * is its "no value" chip and is left out, as with Priority above.
   */
  maintenance_label: [
    opt("Locks", "#9aadbd"),
    opt("Hinges", "#007eb5"),
    opt("Glass", "#9d99b9"),
    opt("Signboard", "#00c875", true),
    opt("Diffuser", "#9d50dd"),
    opt("Vinyls", "#037f4c"),
    opt("Acrylic", "#579bfc"),
    opt("Paint", "#cab641"),
    opt("Replacement parts", "#ffcb00"),
    opt("Other", "#333333"),
    opt("Lights", "#bb3354"),
    opt("TV/Display", "#ff007f"),
    opt("Shelves", "#ff5ac4"),
    opt("AC", "#784bd1"),
    opt("Drawers", "#9cd326"),
    opt("CCTV", "#66ccff"),
  ],

  /** Monday status1 — 23 labels, in index order. Monday leaves no blank here. */
  maintenance_status: [
    opt("Pending Approval", "#ff7575"),
    opt("Pending Scheduling", "#fdab3d"),
    opt("Job Scheduled", "#cab641"),
    opt("Job In Progress", "#bda8f9"),
    opt("Job Completed", "#00c875", true),
    opt("Blocked - Awaiting Response", "#df2f4a"),
    opt("Awaiting Landlord Approval", "#c4c4c4"),
    opt("Waiting for parts", "#ff007f"),
    opt("Health And Safety Hold", "#ffcb00"),
    opt("Waiting for payment", "#333333"),
    opt("Waiting for decisions", "#bb3354"),
    opt("Awaiting Access", "#ff5ac4"),
    opt("Escalated", "#784bd1"),
    opt("Major works", "#9d50dd"),
    opt("Third Party Delay", "#9cd326"),
    opt("Quote requested", "#66ccff"),
    opt("Quote Received (waiting for Approval)", "#ffadad"),
    opt("Quote approved", "#757575"),
    opt("Quote rejected", "#7f5347"),
    opt("Deposit Invoice Received", "#ff6d3b"),
    opt("Deposit Invoice Paid", "#faa1f1"),
    opt("Completion Invoice Received", "#007eb5"),
    opt("Completion Invoice Paid", "#7e3b8a"),
  ],

  /** Monday single_selecty9rcyhe — 21 stores, in index order. */
  store_location: [
    opt("Birmingham – Bullring", "#fdab3d"),
    opt("Solihull – Touchwood", "#00c875"),
    opt("Westfield – White City", "#df2f4a"),
    opt("Aldgate – Whitechapel Road", "#007eb5"),
    opt("Brent Cross – Shopping Centre", "#9d50dd"),
    opt("Brighton – Churchill Square", "#037f4c"),
    opt("Bristol – Cabot Circus", "#579bfc"),
    opt("Cardiff – Grand Arcade", "#cab641"),
    opt("Dudley – Merry Hill", "#ffcb00"),
    opt("Glasgow – Silverburn", "#333333"),
    opt("Greenhithe – Bluewater", "#bb3354"),
    opt("Manchester – Arndale", "#ff007f"),
    opt("Manchester – Trafford Centre", "#ff5ac4"),
    opt("Milton Keynes – The Centre", "#784bd1"),
    opt("Nottingham – Victoria Centre", "#9cd326"),
    opt("Reading – The Oracle", "#66ccff"),
    opt("Sheffield – Meadow Hall", "#757575"),
    opt("Southall – The Broadway", "#7f5347"),
    opt("Watford – Atria", "#ff6d3b"),
    opt("Westfield – Stratford", "#ff7575"),
    opt("Wood Green – High Road", "#faa1f1"),
  ],
};

/** Subitem columns — monday board 1164003119. */
export const maintenanceSubitemColumns: SeedColumn[] = [
  { key: "name", title: "Name", type: "text", width: 300, system: true, required: true },
  { key: "owner", title: "Owner", type: "people", width: 160 },
  { key: "status", title: "Status", type: "status", width: 175, optionSetKey: "subitem_status" },
  { key: "date", title: "Date", type: "date", width: 145 },
];

/**
 * Subitem statuses — monday's stock three, in its `index` order.
 *
 * The child board keeps monday's default status column, so the dropdown reads
 * Working on it, Done, Stuck. They were listed here as Stuck, Working on it,
 * Done — id order, which is not what monday renders. `subitemStatusOptions` in
 * `app/(app)/portal/board-model.ts` maps this array straight to the picker, so
 * the order is what the user sees.
 */
export const maintenanceSubitemOptions: Record<string, SeedOption[]> = {
  subitem_status: [
    opt("Working on it", "#fdab3d"),
    opt("Done", "#00c875", true),
    opt("Stuck", "#df2f4a"),
  ],
};

/* ── Store Documentation UK ───────────────────────────────────────────────── */

/**
 * The 24 columns, in monday board order. Eleven certificate slots are a
 * file/expiry pair, which is what the Compliance Tracker reads.
 */
export const storeDocumentationColumns: SeedColumn[] = [
  {
    key: "name",
    /*
     * "Name", because that is the header monday draws.
     *
     * This read "Store" — a rename made because the board's item noun is
     * Store, which is true and is still how a new row is labelled and how the
     * "New store" button reads. But the column HEADER on board 1398027719 says
     * "Name", the maintenance board's equivalent column is already titled
     * "Name" here, and the standing rule is that where the app and the capture
     * disagree the capture is right. Confirmed against the API: the first
     * column of all three boards is titled "Name".
     */
    title: "Name",
    type: "text",
    width: 300,
    required: true,
    system: true,
    description: "Monday's Name column. The board's item noun is \"Store\".",
  },
  {
    key: "storeType",
    title: "Store Type",
    type: "dropdown",
    width: 150,
    optionSetKey: "store_type",
    description: "Single-select on monday — limit_select is on with a count of 1.",
  },
  { key: "storeAddress", title: "Store Address", type: "text", width: 340 },
  { key: "accessRequest", title: "Access Request", type: "text", width: 200 },
  { key: "rams", title: "RAMS", type: "files", width: 120, summary: "count" },
  { key: "fireRiskAssessment", title: "Fire Risk Assessment", type: "files", width: 150 },
  { key: "pliDocument", title: "PLI Document", type: "files", width: 130 },
  { key: "pliExpiry", title: "PLI Expiry Date", type: "date", width: 145 },
  { key: "patCertificate", title: "PAT Test Certificate", type: "files", width: 150 },
  { key: "patExpiry", title: "PAT Test Expiry Date", type: "date", width: 155 },
  {
    key: "electricalCertificate",
    title: "Electrical Wiring Certificate",
    type: "files",
    width: 180,
  },
  {
    key: "electricalExpiry",
    title: "Electrical Wiring Certificate Expiry",
    type: "date",
    width: 200,
  },
  { key: "fireExtinguisher", title: "Fire Extinguisher", type: "files", width: 145 },
  { key: "fireExtinguisherExpiry", title: "Fire Extinguisher Expiry", type: "date", width: 175 },
  { key: "fireAlarmReport", title: "Fire Alarm Report", type: "files", width: 145 },
  { key: "fireAlarmExpiry", title: "Fire Alarm Expiry", type: "date", width: 150 },
  { key: "emergencyLighting", title: "Emergency Lighting Report", type: "files", width: 180 },
  { key: "emergencyLightingExpiry", title: "Emergency Lighting Expiry", type: "date", width: 185 },
  { key: "sprinklerReport", title: "Sprinkler Report", type: "files", width: 145 },
  { key: "sprinklerExpiry", title: "Sprinkler Expiry", type: "date", width: 145 },
  { key: "waterHygiene", title: "Water Hygiene Test Report", type: "files", width: 185 },
  { key: "waterHygieneExpiry", title: "Water Hygiene Test Expiry", type: "date", width: 185 },
  { key: "fireDoorTest", title: "FireDoor Test", type: "files", width: 135 },
  { key: "fireDoorExpiry", title: "Fire Door Expiry", type: "date", width: 145 },
  { key: "drawing", title: "Drawing", type: "files", width: 120 },
];

export const storeDocumentationGroups: SeedGroup[] = [
  { key: "topics", name: "Current stores", colour: "#579bfc" },
  { key: "europe", name: "Europe", colour: "#a25ddc" },
  { key: "closed", name: "Closed", colour: "#ff5ac4", collapsed: true },
  { key: "other", name: "Other", colour: "#757575" },
];

export const storeDocumentationOptions: Record<string, SeedOption[]> = {
  store_type: [
    opt("Inline", "#579bfc"),
    opt("Kiosk", "#00c875"),
    opt("Office", "#a25ddc"),
    opt("Warehouse", "#fdab3d"),
  ],
};

/**
 * The document slots the Compliance Tracker walks, in monday's column order.
 *
 * Twelve slots, of which nine are a file/expiry pair and three carry a document
 * with no expiry date on monday — RAMS, the Fire Risk Assessment and the store
 * Drawing. `expiryColumn: null` marks those, so the tracker asks for a date on
 * exactly the nine that have one rather than showing nine empty date cells.
 *
 * `label` is the requirement name written into `compliance_documents.kind`, so
 * these strings are the register's vocabulary. The register previously carried
 * five ad-hoc kinds — PAT, Fire alarm, Emergency lighting, Water hygiene and
 * Electrical wiring — which is under half of what the board tracks: PLI, fire
 * extinguishers, sprinklers, fire doors, RAMS, the fire risk assessment and the
 * drawing had nowhere to be recorded at all.
 *
 * `responsibility` is who chases the certificate. It was previously inferred by
 * substring-matching the requirement name, which put the sprinkler and fire
 * door reports on the fire safety partner correctly but sent RAMS and the
 * drawing to the store manager by accident of them containing no keyword.
 */
export type StoreDocumentSlot = {
  key: string;
  label: string;
  fileColumn: string;
  expiryColumn: string | null;
  responsibility: string;
};

export const storeDocumentationCertificates: StoreDocumentSlot[] = [
  {
    key: "rams",
    label: "RAMS",
    fileColumn: "rams",
    expiryColumn: null,
    responsibility: "Contractor",
  },
  {
    key: "fire-risk-assessment",
    label: "Fire Risk Assessment",
    fileColumn: "fireRiskAssessment",
    expiryColumn: null,
    responsibility: "Fire safety partner",
  },
  {
    key: "pli",
    label: "PLI",
    fileColumn: "pliDocument",
    expiryColumn: "pliExpiry",
    responsibility: "Insurance broker",
  },
  {
    key: "pat",
    label: "PAT Test",
    fileColumn: "patCertificate",
    expiryColumn: "patExpiry",
    responsibility: "Electrical contractor",
  },
  {
    key: "electrical",
    label: "Electrical Wiring",
    fileColumn: "electricalCertificate",
    expiryColumn: "electricalExpiry",
    responsibility: "Electrical contractor",
  },
  {
    key: "fire-extinguisher",
    label: "Fire Extinguisher",
    fileColumn: "fireExtinguisher",
    expiryColumn: "fireExtinguisherExpiry",
    responsibility: "Fire safety partner",
  },
  {
    key: "fire-alarm",
    label: "Fire Alarm",
    fileColumn: "fireAlarmReport",
    expiryColumn: "fireAlarmExpiry",
    responsibility: "Fire safety partner",
  },
  {
    key: "emergency-lighting",
    label: "Emergency Lighting",
    fileColumn: "emergencyLighting",
    expiryColumn: "emergencyLightingExpiry",
    responsibility: "Fire safety partner",
  },
  {
    key: "sprinkler",
    label: "Sprinkler",
    fileColumn: "sprinklerReport",
    expiryColumn: "sprinklerExpiry",
    responsibility: "Fire safety partner",
  },
  {
    key: "water-hygiene",
    label: "Water Hygiene",
    fileColumn: "waterHygiene",
    expiryColumn: "waterHygieneExpiry",
    responsibility: "Water hygiene partner",
  },
  {
    key: "fire-door",
    label: "Fire Door",
    fileColumn: "fireDoorTest",
    expiryColumn: "fireDoorExpiry",
    responsibility: "Fire safety partner",
  },
  {
    key: "drawing",
    label: "Drawing",
    fileColumn: "drawing",
    expiryColumn: null,
    responsibility: "Projects team",
  },
];

/** Requirement names, in board order — the register's vocabulary. */
export const storeDocumentationKinds = storeDocumentationCertificates.map(
  (slot) => slot.label,
);

/** Who chases each requirement, keyed by requirement name. */
export const storeDocumentationResponsibility = new Map(
  storeDocumentationCertificates.map((slot) => [slot.label, slot.responsibility]),
);

/** Requirements monday tracks without an expiry date. */
export const storeDocumentationUndated = new Set(
  storeDocumentationCertificates
    .filter((slot) => slot.expiryColumn === null)
    .map((slot) => slot.label),
);

/* ── Maintenance request form — monday view 646339 ────────────────────────── */

/**
 * The public request form, captured from the WorkForms config so the hosted
 * form asks the same questions in the same order with the same rules.
 *
 * `showIf` reproduces monday's one conditional rule: the "Handyman Required"
 * follow-up appears only when Engineer Required is answered "Handyman".
 */
export const maintenanceFormSpec = {
  title: "Maintenance Request",
  description: "Please fill up 1 form for each repair requested",
  submitAnother: true,
  showNameQuestion: false,
  questions: [
    { key: "storeLocation", label: "Location", type: "select", required: true },
    { key: "requester", label: "Manager", type: "text", required: true },
    { key: "number", label: "Contact number", type: "phone", required: true },
    { key: "requested", label: "Date Requested", type: "date", required: true },
    { key: "engineer", label: "Engineer Required", type: "select", required: true },
    {
      key: "handymanRequired",
      label: "Handyman Required",
      type: "text",
      required: false,
      showIf: { key: "engineer", equals: "Handyman" },
    },
    {
      key: "description",
      label: "Description of Works to be done",
      type: "long_text",
      required: true,
      help: "Please submit only one issue or request per ticket. Do not combine or mention more than one issue in a single request.",
    },
    {
      key: "issuePictures",
      label: "Pictures of Maintenance Issue",
      type: "files",
      required: true,
      help: "Please note you must upload pictures and videos of issues. Any request without clear pictures and videos will be declined.",
    },
    { key: "priority", label: "Status", type: "select", required: true },
  ],
} as const;


/* ── The WorkForms configuration in full — monday form 11280606 ───────────── */

/**
 * THE COMPLETE form configuration, read back from monday's API rather than
 * inferred from a screenshot.
 *
 * WHY THIS EXISTS ALONGSIDE `maintenanceFormSpec` ABOVE, RATHER THAN REPLACING IT
 *
 * They answer different questions and both are load-bearing:
 *
 *   · `maintenanceFormSpec` is the DISTILLED form — the nine questions this
 *     product actually asks, in our own vocabulary (`storeLocation`, `priority`),
 *     keyed the way `FormResultsView` reads answers back off a job. It is the
 *     contract between the form and the rest of the app.
 *   · `maintenanceFormConfiguration` (below) is monday's form AS CONFIGURED —
 *     all nineteen questions including the ten hidden ones, every feature flag,
 *     and the whole appearance block. It is the seed for the editable,
 *     DB-backed form config that the form builder writes to.
 *
 * Collapsing them would lose information in both directions. The distilled spec
 * has no notion of a hidden "Cost of Works" question; the full config has no
 * notion of our `storeLocation` key. So the builder edits a copy of THIS, and
 * the distilled spec stays the app's stable internal contract.
 *
 * PROVENANCE
 *
 *   Board    Maintenance, 1139774521 (read-only reference)
 *   View     646339 "Form" (FormBoardView)
 *   Form     id 11280606 (its share token is deliberately not recorded — see
 *            the note on the `monday` field below)
 *   Read     2026-08-18, via the monday API. Nothing was written to the board.
 *
 * TWO THINGS THE API REVEALED THAT THE SCREENSHOTS COULD NOT
 *
 *  1. `order` below is monday's own `sortedQuestionsList`, which is NOT the
 *     order the questions come back in. The page block leads, then the nine
 *     visible questions, then the ten hidden ones. Rendering the questions
 *     array as-returned would put "Status" in the wrong place.
 *
 *  2. "Handyman Required" (`short_text3`) is configured on the VIEW — it holds
 *     conditional rule 8874e83b-03e1-0324-f6a1-51fedafadfec, which fires when
 *     Engineer Required is answered "0" (Handyman) — but it is ABSENT from
 *     `sortedQuestionsList`, so monday's live form does not render it. Our
 *     distilled spec does render it, deliberately: the follow-up detail is the
 *     point of asking, and it is appended to the description on submit. That is
 *     a considered divergence, recorded here so nobody "fixes" it later.
 *
 * The stale `closeDate.date` of 2023-10-13 is real, and is left exactly as read.
 * The feature is disabled, so the date is inert — it is the residue of a close
 * date somebody set three years ago and then switched off.
 *
 * The logo is deliberately NOT monday's Cloudinary URL. The original
 * (res.cloudinary.com/monday-platform-eu/…/1695317103408_2a981549-….jpg) is
 * recorded here for reference only; hotlinking another platform's CDN from our
 * own public form would be fragile and would leak a monday URL to every
 * submitter. `logo.url: null` means "draw the app's own BrandMark", and the
 * Design panel accepts a replacement.
 */
export type FormQuestionOption = {
  label: string;
  value: string;
  visible: boolean;
  active: boolean;
};

/**
 * The per-question settings monday exposes under "Question settings".
 *
 * Every field is optional and every reader defaults it, so a question stored
 * before this type existed is valid and behaves exactly as it did — which is
 * what lets this be added without migrating the stored `config` blob.
 *
 * Deliberately a subset of monday's. These are the ones that change what a
 * SUBMITTER sees or answers, which is the parity that matters here. Omitted on
 * purpose: `labelLimitCount` (multi-select only, and we have no multi-select),
 * `locationAutofilled` (no Location type), `prefixAutofilled` (no Phone type),
 * `skipValidation` (no Link type) — all four belong to question types this
 * product does not have, so adding the controls would mean adding dead ones.
 */
export type FormQuestionSettings = {
  /** Value the field opens with. The submitter can still change it. */
  defaultAnswer?: string | null;
  /** Date questions: open on today's date. */
  defaultCurrentDate?: boolean;
  /** Date questions: ask for a time as well as a day. */
  includeTime?: boolean;
  /** Single-select: a dropdown, or the options laid out in full. */
  display?: "Dropdown" | "Vertical" | "Horizontal";
  /** Single-select: the order options are offered in. */
  optionsOrder?: "Custom" | "Alphabetical";
};

export type FormQuestion = {
  id: string;
  /** monday's own question type, kept verbatim so parity is checkable. */
  type:
    | "PAGE_BLOCK"
    | "SingleSelect"
    | "ShortText"
    | "LongText"
    | "Number"
    | "Date"
    | "DateRange"
    | "File"
    | "People"
    | "Subitems";
  title: string;
  description: string | null;
  visible: boolean;
  required: boolean;
  options: FormQuestionOption[] | null;
  /** Set when the question only appears in answer to another one. */
  showIf: { questionId: string; equals: string[] } | null;
  /** Optional; absent means "monday's defaults for this type". */
  settings?: FormQuestionSettings;
};

export const maintenanceFormConfiguration = {
  /*
   * WHAT IS DELIBERATELY NOT RECORDED HERE
   *
   * monday's own form token and its wkf.ms short link are omitted, and this
   * repository being PUBLIC is the whole reason.
   *
   * That pair is a live, working submission endpoint into the client's real
   * Maintenance board — the one with 753 jobs on it. The form is configured as
   * "public and available to anyone with the link", so the link is not secret,
   * but it is unlisted, and committing it here would take it from unlisted to
   * indexed and hand anyone a way to post junk onto a production board.
   *
   * The board and view ids stay because they identify WHICH configuration this
   * is, they are already committed across this codebase, and neither of them
   * can be submitted to. The form id is likewise inert without the token.
   *
   * To re-read the live configuration, fetch the form token from the board's
   * Form view URL in monday and pass it to the API. It is intentionally a step
   * somebody has to take deliberately.
   */
  monday: {
    formId: 11280606,
    boardId: "1139774521",
    viewId: "646339",
  },
  title: "Maintenance Request",
  description: "Please fill up 1 form for each repair requested",
  active: true,
  type: "standard",
  isAnonymous: false,

  /** monday's `sortedQuestionsList` — the order the form is actually drawn in. */
  order: [
    "page_block__classic_default",
    "single_selecty9rcyhe",
    "short_text64",
    "numbertb4g1z46",
    "date",
    "single_select",
    "short_text",
    "upload_file",
    "status",
    "status1",
    "person",
    "dup__of_upload_pictures_of_work_needed",
    "numbers",
    "text",
    "timeline",
    "date_mkmts6wz",
    "date2",
    "subitems",
    "text6",
  ],

  questions: [
    {
      id: "page_block__classic_default",
      type: "PAGE_BLOCK",
      title: "Page",
      description: "",
      visible: true,
      required: false,
      options: null,
      showIf: null,
    },
    {
      id: "single_selecty9rcyhe",
      type: "SingleSelect",
      title: "Location",
      description: null,
      visible: true,
      required: true,
      /*
       * The 21 live stores. Note the gap at value 5 — a store was deleted and
       * monday does not renumber, so the values are not a 0..20 range. Anything
       * matching on index rather than on `value` would mis-map every store from
       * Brighton onwards.
       */
      options: [
        { label: "Birmingham – Bullring", value: "0", visible: true, active: true },
        { label: "Solihull – Touchwood", value: "1", visible: true, active: true },
        { label: "Westfield – White City", value: "2", visible: true, active: true },
        { label: "Aldgate – Whitechapel Road", value: "3", visible: true, active: true },
        { label: "Brent Cross – Shopping Centre", value: "4", visible: true, active: true },
        { label: "Brighton – Churchill Square", value: "6", visible: true, active: true },
        { label: "Bristol – Cabot Circus", value: "7", visible: true, active: true },
        { label: "Cardiff – Grand Arcade", value: "8", visible: true, active: true },
        { label: "Dudley – Merry Hill", value: "9", visible: true, active: true },
        { label: "Glasgow – Silverburn", value: "10", visible: true, active: true },
        { label: "Greenhithe – Bluewater", value: "11", visible: true, active: true },
        { label: "Manchester – Arndale", value: "12", visible: true, active: true },
        { label: "Manchester – Trafford Centre", value: "13", visible: true, active: true },
        { label: "Milton Keynes – The Centre", value: "14", visible: true, active: true },
        { label: "Nottingham – Victoria Centre", value: "15", visible: true, active: true },
        { label: "Reading – The Oracle", value: "16", visible: true, active: true },
        { label: "Sheffield – Meadow Hall", value: "17", visible: true, active: true },
        { label: "Southall – The Broadway", value: "18", visible: true, active: true },
        { label: "Watford – Atria", value: "19", visible: true, active: true },
        { label: "Westfield – Stratford", value: "101", visible: true, active: true },
        { label: "Wood Green – High Road", value: "102", visible: true, active: true },
      ],
      showIf: null,
    },
    {
      id: "short_text64",
      type: "ShortText",
      title: "Manager",
      description: null,
      visible: true,
      required: true,
      options: null,
      showIf: null,
    },
    {
      /*
       * A Number on monday, not a phone field — WorkForms has no telephone type.
       * Our own form uses `inputMode="tel"`, which is a better keyboard on a
       * phone and still accepts the same answers.
       */
      id: "numbertb4g1z46",
      type: "Number",
      title: "Contact number",
      description: null,
      visible: true,
      required: true,
      options: null,
      showIf: null,
    },
    {
      id: "date",
      type: "Date",
      title: "Date Requested",
      description: null,
      visible: true,
      required: true,
      options: null,
      showIf: null,
    },
    {
      id: "single_select",
      type: "SingleSelect",
      title: "Engineer Required",
      description: null,
      visible: true,
      required: true,
      /* "Plummer" is monday's spelling and is left as configured. */
      options: [
        { label: "Plummer", value: "2", visible: true, active: true },
        { label: "Electrician", value: "1", visible: true, active: true },
        { label: "Handyman", value: "0", visible: true, active: true },
        { label: "Other", value: "3", visible: true, active: true },
      ],
      showIf: null,
    },
    {
      /*
       * A ShortText on monday despite being the long free-text answer. The
       * description carries HTML because WorkForms stores rich text; it is
       * rendered as plain text here rather than injected as markup.
       */
      id: "short_text",
      type: "ShortText",
      title: "Description of Works to be done",
      description:
        "Please submit only one issue or request per ticket. Do not combine or mention more than one issue in a single request.",
      visible: true,
      required: true,
      options: null,
      showIf: null,
    },
    {
      id: "upload_file",
      type: "File",
      title: "Pictures of Maintenance Issue",
      description:
        "Please note you must upload pictures and videos of issues. Any request without clear pictures and videos will be declined.",
      visible: true,
      required: true,
      options: null,
      showIf: null,
    },
    {
      /*
       * The PRIORITY column, titled "Status" on the form. The blank fourth
       * option is real — an unnamed purple label somebody created on the board.
       */
      id: "status",
      type: "SingleSelect",
      title: "Status",
      description: null,
      visible: true,
      required: true,
      options: [
        { label: "Medium", value: "0", visible: true, active: true },
        { label: "", value: "4", visible: true, active: true },
        { label: "Low", value: "1", visible: true, active: true },
        { label: "Urgent", value: "2", visible: true, active: true },
      ],
      showIf: null,
    },
    {
      /*
       * The workflow status — 23 labels, hidden on the form because a submitter
       * has no business setting it. Kept so the builder can show it as a hidden
       * question, exactly as monday's Edit panel does.
       */
      id: "status1",
      type: "SingleSelect",
      title: "Status",
      description: null,
      visible: false,
      required: false,
      options: [
        { label: "Pending Approval", value: "12", visible: true, active: true },
        { label: "Pending Scheduling", value: "0", visible: true, active: true },
        { label: "Job Scheduled", value: "8", visible: true, active: true },
        { label: "Job In Progress", value: "7", visible: true, active: true },
        { label: "Job Completed", value: "1", visible: true, active: true },
        { label: "Blocked - Awaiting Response", value: "2", visible: true, active: true },
        { label: "Awaiting Landlord Approval", value: "5", visible: true, active: true },
        { label: "Waiting for parts", value: "6", visible: true, active: true },
        { label: "Health And Safety Hold", value: "9", visible: true, active: true },
        { label: "Waiting for payment", value: "10", visible: true, active: true },
        { label: "Waiting for decisions", value: "11", visible: true, active: true },
        { label: "Awaiting Access", value: "13", visible: true, active: true },
        { label: "Escalated", value: "14", visible: true, active: true },
        { label: "Major works", value: "4", visible: true, active: true },
        { label: "Third Party Delay", value: "15", visible: true, active: true },
        { label: "Quote requested", value: "16", visible: true, active: true },
        {
          label: "Quote Received (waiting for Approval)",
          value: "3",
          visible: true,
          active: true,
        },
        { label: "Quote approved", value: "17", visible: true, active: true },
        { label: "Quote rejected", value: "18", visible: true, active: true },
        { label: "Deposit Invoice Received", value: "19", visible: true, active: true },
        { label: "Deposit Invoice Paid", value: "102", visible: true, active: true },
        { label: "Completion Invoice Received", value: "103", visible: true, active: true },
        { label: "Completion Invoice Paid", value: "104", visible: true, active: true },
      ],
      showIf: null,
    },
    {
      id: "person",
      type: "People",
      title: "Assigned To",
      description: null,
      visible: false,
      required: false,
      options: null,
      showIf: null,
    },
    {
      id: "dup__of_upload_pictures_of_work_needed",
      type: "File",
      title: "Picture of completed works",
      description: null,
      visible: false,
      required: false,
      options: null,
      showIf: null,
    },
    {
      id: "numbers",
      type: "Number",
      title: "Cost of Works",
      description: null,
      visible: false,
      required: false,
      options: null,
      showIf: null,
    },
    {
      id: "text",
      type: "ShortText",
      title: "Approved by",
      description: null,
      visible: false,
      required: false,
      options: null,
      showIf: null,
    },
    {
      id: "timeline",
      type: "DateRange",
      title: "Timeline",
      description: null,
      visible: false,
      required: false,
      options: null,
      showIf: null,
    },
    {
      id: "date_mkmts6wz",
      type: "Date",
      title: "Next Update",
      description: null,
      visible: false,
      required: false,
      options: null,
      showIf: null,
    },
    {
      id: "date2",
      type: "Date",
      title: "Date Completed",
      description: null,
      visible: false,
      required: false,
      options: null,
      showIf: null,
    },
    {
      id: "subitems",
      type: "Subitems",
      title: "Subitems",
      description: null,
      visible: false,
      required: false,
      options: null,
      showIf: null,
    },
    {
      id: "text6",
      type: "ShortText",
      title: "Invoice",
      description: null,
      visible: false,
      required: false,
      options: null,
      showIf: null,
    },
  ] satisfies FormQuestion[],

  /**
   * The Settings panel, one field per toggle. Every value is as monday has it
   * today, so a fresh database starts where the real form stands.
   */
  features: {
    /** "Require login to monday.com" — internal-only forms. */
    isInternal: true,
    reCaptchaChallenge: false,
    /*
     * Enabled, but monday's own wkf.ms address is not carried — see the note
     * above. It would be dead data anyway: `presentedShareUrl` builds the short
     * link from THIS deployment's own `short_token` and never reads this field.
     */
    shortenedLink: { enabled: true, url: null as string | null },
    password: { enabled: false },
    /** "Save as draft". */
    draftSubmission: { enabled: false },
    requireLogin: { enabled: false, redirectToLogin: false },
    responseLimit: { enabled: false, limit: null as number | null },
    /** Disabled, but the date it was last set to survives. See the note above. */
    closeDate: { enabled: false, date: "2023-10-13" as string | null },
    /** The Welcome page — off, so the form opens straight on question one. */
    preSubmissionView: {
      enabled: false,
      title: null as string | null,
      description: null as string | null,
      startButton: { text: null as string | null },
    },
    afterSubmissionView: {
      title: null as string | null,
      description: null as string | null,
      redirectAfterSubmission: { enabled: false, redirectUrl: null as string | null },
      /** "Submit multiple forms" — the "Submit another response" button. */
      allowResubmit: true,
      showSuccessImage: true,
      allowEditSubmission: false,
      /** "Response viewing". */
      allowViewSubmission: true,
    },
    board: {
      /** null means the board's top group — "Incoming requests". */
      itemGroupId: null as string | null,
      includeNameQuestion: false,
      includeUpdateQuestion: false,
      syncQuestionAndColumnsTitles: false,
      /** "Allow creating items via form". */
      allowCreatingItems: true,
    },
    aiTranslate: { enabled: false },
  },

  /** The Design panel. */
  appearance: {
    /** "monday.com Branding", inverted: monday stores hide, the toggle shows. */
    hideBranding: true,
    showProgressBar: false,
    primaryColor: null as string | null,
    layout: {
      type: "CARD" as "CARD" | "CLASSIC",
      alignment: "Center" as "Left" | "Center" | "Right",
      direction: "LtR" as "LtR" | "RtL",
    },
    background: { type: "None" as "None" | "Color" | "Image", value: null as string | null },
    text: {
      font: "Poppins",
      color: null as string | null,
      size: "Medium" as "Small" | "Medium" | "Large",
    },
    logo: {
      position: "Auto" as "Auto" | "Left" | "Center" | "Right",
      /** null draws the app's own BrandMark — see the note above. */
      url: null as string | null,
      size: "Medium" as "Small" | "Medium" | "Large",
    },
    submitButton: { text: null as string | null },
  },

  accessibility: { language: "English (English)", logoAltText: null as string | null },
  tags: [] as string[],
};
