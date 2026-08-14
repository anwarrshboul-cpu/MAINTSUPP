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
};

export type WorkspaceContractor = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  serviceCategories: string[];
  coverageAreas: string[];
  certifications: string[];
  insuranceExpiry: string | null;
  availability: string;
  rating: number | null;
  active: boolean;
  assignedJobs: number;
  completedJobs: number;
  urgentJobs: number;
  spend: number;
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
