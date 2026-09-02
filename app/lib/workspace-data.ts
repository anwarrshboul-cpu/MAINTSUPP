import type { ComplianceState, StoreRecord } from "./types";

export type WorkspaceUnit = {
  id: string;
  siteId: string;
  siteName: string;
  name: string;
  category: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  status: string;
  notes: string | null;
  openJobs: number;
  compliance: ComplianceState;
};

export type WorkspaceComplianceRecord = {
  id: string;
  siteId: string;
  siteName: string;
  kind: string;
  state: ComplianceState;
  expiry: string | null;
  fileCount: number;
  /**
   * Store Type and Store Address as the Store Documentation board holds them.
   *
   * The register is derived from that board, and most of the estate's stores
   * have no `sites` row to look these up in — 21 of the 31 board stores had no
   * row anywhere else in the product. Carrying them on the record is what lets
   * the compliance drawer name the place it is describing instead of showing a
   * store with a blank address. Null for a record the board does not cover.
   */
  siteType?: string | null;
  siteAddress?: string | null;
  /**
   * Where this record came from, so an edit can go back to the same place.
   *
   * The register is DERIVED: most records are read off a Store Documentation
   * board row and only some exist solely in `compliance_documents`. Every screen
   * so far has only read the register, so it never needed to know which — but
   * the calendar lets somebody drag a certificate expiry to a new date, and the
   * two kinds of record are written through two different endpoints. A
   * board-derived expiry has to go back to the board cell it was read from
   * (`PATCH /api/board?board=store-documentation` with `update_cell`), because
   * the register recomputes its state from that cell on the next read and would
   * silently overwrite anything written to the register copy instead; a
   * register-only record has no board cell and goes through
   * `PATCH /api/workspace`.
   *
   * PATCH, and the board in the QUERY STRING. This sentence said `POST` for a
   * while and a caller followed it: `/api/board` splits its actions across two
   * handlers — POST creates and deletes, PATCH edits — so `update_cell` sent as
   * a POST comes back `400 {"error":"Unknown board action."}` and no
   * certificate moves. Every unit test passed while that was live; it took
   * moving a real expiry on a real board row to find it. The board is read from
   * `?board=` by `boardIdFrom`, never from the body, and the column is looked up
   * by its DB **id** — passing the column key answers 404.
   *
   * Optional so no existing consumer has to change. `readComplianceRegister`
   * has carried all three on `RegisterEntry` since it was written; this is
   * `/api/workspace` stopping dropping them on the way out.
   */
  /** The Store Documentation board row this is derived from, or null for a register-only row. */
  itemId?: string | null;
  /** The board slot key, e.g. "pat", or null. */
  slotKey?: string | null;
  /**
   * The board date column key holding this expiry, e.g. "patExpiry"; null when
   * the slot tracks no expiry. Three of the twelve slots are in that case —
   * RAMS, the Fire Risk Assessment and the store Drawing carry a document with
   * no date on monday — so their records can never appear on a calendar at all.
   */
  expiryColumnKey?: string | null;
  /**
   * The same column's `maintenance_board_columns.id`, resolved on the server.
   *
   * `update_cell` looks a column up by ID scoped to a board and answers 404 for
   * a key, and column ids are per organisation — so a key alone is not enough
   * to write with. The only other way for the browser to learn it would be to
   * fetch the whole Store Documentation board (rows, cells and all) in order to
   * reschedule one certificate, which is a lot of payload for one string. It is
   * resolved here instead, from a ~20-row indexed lookup beside a read that was
   * already reading that board's columns.
   *
   * Null wherever `expiryColumnKey` is, and also when the column has been
   * deleted from the board — in which case the calendar refuses the edit and
   * says so, rather than posting an id the route will reject.
   */
  expiryColumnId?: string | null;
};

export type WorkspaceContractor = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  /**
   * The number they answer on WhatsApp, when it is not the one above.
   *
   * A separate column rather than a reinterpretation of `phone`, and never a
   * copy of it: the office landline that takes the calls is routinely not the
   * mobile that takes the messages, and a landline turned into a wa.me link
   * opens on "the phone number shared via url is invalid". Optional — null is
   * "no WhatsApp", which is most of the register.
   *
   * Held as typed. `app/lib/contact-links.ts` decides whether it resolves to an
   * international number and refuses to guess a country code, so a national
   * number is still printed for a human to read even when no link can be made.
   */
  whatsappNumber: string | null;
  /**
   * The person to ask for, as distinct from the company.
   *
   * "Call Apex Electrical" is not an instruction anybody can follow at 7am with
   * water coming through a ceiling. These four — the person, where they are,
   * what was agreed and what they charge — were the gap between what the
   * register held and what a coordinator needed off it.
   */
  contactName: string | null;
  address: string | null;
  notes: string | null;
  /** Pence. Null means nobody has recorded a rate, which is not a rate of £0. */
  dayRatePence: number | null;
  /**
   * How many live documents are filed against this contractor.
   *
   * W07-07 asks that a document can be linked to a contractor and that the link
   * is reachable from the contractor's side. Until the `contractor_id` column
   * existed there was no link to reach: `attachments` could name a job, a site
   * and a unit, and the register held insurance and certification as free text
   * on the contractor row with no file behind either.
   *
   * A COUNT rather than the rows, because this payload describes a register of
   * contractors rather than any one of them, and it is what a list can show
   * ("3 documents") and what tells a screen whether opening a document panel
   * would find anything. Current, unarchived versions only — the same rule the
   * site's Documents tab uses, so the two cannot disagree about what "has
   * documents" means.
   *
   * Optional in the type because `app/lib/mock-data.ts` also builds these and
   * has no storage behind them; absent reads as "not known", not as zero.
   */
  documentCount?: number;
  /**
   * W06-06 — the postcode, as its own column.
   *
   * `address` is one free-text line, so nothing could sort, search or map on
   * where a contractor is. Optional and NOT format-checked against a UK
   * pattern: the product admits non-UK contractors — `coverageAreas` is full of
   * "Europe" and `sites.country` is a free column — so "75008" and "1012 AB"
   * are as legitimate here as "SW1A 1AA".
   */
  postcode?: string | null;
  serviceCategories: string[];
  coverageAreas: string[];
  certifications: string[];
  /**
   * W06-08 — certifications as ENTRIES, each with its own expiry.
   *
   * `certifications` above is the legacy array of names and stays exactly where
   * it is: it holds no dates, so "is their gas ticket still valid" had no
   * answer, but it is what every existing row and every existing screen holds.
   * This is additive — a contractor with no rows in `contractor_certifications`
   * gets an empty list and behaves precisely as they did before.
   *
   * Optional in the type because `app/lib/mock-data.ts` builds these payloads
   * too and has no storage behind them; absent reads as "not known", not as
   * "none".
   */
  certificationEntries?: WorkspaceCertification[];
  insuranceExpiry: string | null;
  /**
   * The RAG bucket `insuranceExpiry` falls in, from `expiryStatus`.
   *
   * DERIVED on read and never stored, for the reason `compliance_documents
   * .status` proves: a status written into a column stops being true the day
   * after it was written, and "Compliant" then outlived the certificate by
   * months. Sent from the server so the register, the manage drawer and any
   * later digest cannot each classify the same date differently.
   */
  insuranceState?: "expired" | "due-soon" | "valid" | "not-recorded";
  insuranceStatusLabel?: string;
  /**
   * W06-08 — who the cover is with, and under which policy.
   *
   * A bare expiry date can say WHEN something ends but never WHAT ended, which
   * is the whole reason chasing a lapsed contractor's insurance used to start
   * with a phone call asking who their broker was.
   */
  insurerName?: string | null;
  policyNumber?: string | null;
  insuranceNotes?: string | null;
  availability: string;
  rating: number | null;
  active: boolean;
  /**
   * W06-07 — the agreed rate card, all of it in integer pence.
   *
   * AGREED TERMS, not money spent. Nothing sums these and nothing may: spend is
   * computed from job cost alone, and `app/lib/contractor-attribution.ts` is
   * pinned by test never to so much as name one of these columns. Null is "not
   * agreed", which is not the same as a rate of zero — the register prints a
   * dash rather than "£0.00", because £0.00 reads as "they work for free".
   *
   * `otherCostLabel` is what makes `otherCostPence` legible. A figure with no
   * name is not a cost, and overloading `notes` to carry the name would put it
   * somewhere no column, filter or report can read.
   */
  hourlyRatePence?: number | null;
  callOutCostPence?: number | null;
  otherCostPence?: number | null;
  otherCostLabel?: string | null;
  /**
   * W06-09 — payment TERMS and an EXTERNAL accounting reference.
   *
   * THE APPROVED MODEL, AND ITS BOUNDARY. `paymentTerms` is controlled from the
   * `contractor_payment_terms` option set; `financeReference` points at the
   * supplier record in Xero, Sage, QuickBooks or an internal ledger. There is
   * deliberately NO bank account number, sort code, IBAN or card detail on this
   * type, on the `contractors` table, or anywhere on the route that writes it,
   * and none may be added: a maintenance portal holding payment credentials is
   * a breach waiting for its first misconfigured backup, and the accounting
   * system that already holds them is built for it.
   */
  paymentTerms?: string | null;
  financeReference?: string | null;
  assignedJobs: number;
  completedJobs: number;
  urgentJobs: number;
  spend: number;
};

/**
 * W06-08 — one certification a contractor holds.
 *
 * `status` is absent on purpose: it is DERIVED from `expiresOn` by
 * `expiryStatus` at read time and travels as `expiryState` / `expiryLabel`, so
 * there is no second copy of the verdict to go stale. Everything but `name` is
 * optional, because not every ticket has a reference and not every ticket
 * expires.
 */
export type WorkspaceCertification = {
  id: string;
  name: string;
  reference: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  notes: string | null;
  position: number;
  /** From `app/lib/expiry-status.ts` — the platform's one classifier. */
  expiryState: "expired" | "due-soon" | "valid" | "not-recorded";
  expiryLabel: string;
  daysRemaining: number | null;
};

export type WorkspacePlannedItem = {
  id: string;
  siteId: string;
  siteName: string;
  unitId: string | null;
  contractorId: string | null;
  contractorName: string | null;
  title: string;
  category: string;
  frequency: string;
  nextDueAt: string;
  lastCompletedAt: string | null;
  status: string;
  reminderDays: number;
};

export type WorkspaceMember = {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  lastActive: string;
};

export type WorkspaceAlerts = {
  urgent: boolean;
  compliance: boolean;
  daily: boolean;
};

export type WorkspaceSlas = Record<string, string>;

export type WorkspaceSettings = {
  alerts: WorkspaceAlerts;
  slas: WorkspaceSlas;
  /**
   * Job categories that cannot be marked Completed without a photograph in
   * "Picture of completed works".
   *
   * A list rather than a flag, because the rule is not the same for every kind
   * of work: a replaced lock or a repaired shopfront is worth a photograph and
   * a changed lightbulb usually is not, and which is which is the client's
   * judgement, not this codebase's.
   *
   * EMPTY BY DEFAULT, deliberately. Turning a gate on for everybody the moment
   * this deploys would stop coordinators closing jobs they have every right to
   * close, for a rule nobody agreed to. The settings screen offers a
   * recommended set in one click; choosing it is the client's decision and is
   * recorded in the audit log like any other settings change.
   */
  completionEvidenceCategories: string[];
};

/**
 * The categories where a photograph of the finished work is standard practice
 * in facilities management — physical repairs and replacements, where "it was
 * done" is a claim somebody may need to check months later against an invoice.
 *
 * Offered, never applied. `defaultWorkspaceSettings` keeps the list empty.
 */
export const RECOMMENDED_EVIDENCE_CATEGORIES = [
  "Glass",
  "Hinges",
  "Locks",
  "Replacement parts",
  "Signboard",
  "CCTV",
  "AC",
  "TV/Display",
  "Shelves",
  "Drawers",
  "Acrylic",
  "Vinyls",
] as const;

export type WorkspaceActivity = {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  actorEmail: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
};

export type WorkspaceSnapshot = {
  stores: StoreRecord[];
  compliance: WorkspaceComplianceRecord[];
  units: WorkspaceUnit[];
  contractors: WorkspaceContractor[];
  planned: WorkspacePlannedItem[];
  team: WorkspaceMember[];
  settings: WorkspaceSettings;
  activity: WorkspaceActivity[];
};

export type WorkspaceEntity =
  | "site"
  | "compliance"
  | "unit"
  | "contractor"
  | "planned"
  | "member"
  | "settings";

export const defaultWorkspaceSettings: WorkspaceSettings = {
  alerts: { urgent: true, compliance: true, daily: false },
  // Empty: see the type. Nothing is gated until the client says so.
  completionEvidenceCategories: [],
  // Keyed by the labels on the board's Priority column — Urgent, Medium, Low.
  // "High" was carried here too, but monday's Priority column has never had it,
  // so the settings screen showed a target for a priority no job could take.
  slas: {
    Urgent: "4 hours",
    Medium: "3 business days",
    Low: "5 business days",
  },
};
