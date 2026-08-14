/**
 * The portal's shared vocabulary: the shapes the API returns, and the pure
 * helpers both server and client components need.
 *
 * Nothing here may import `next/headers` or anything else server-only — a
 * client component that imports one type from a module drags the whole module
 * into the browser bundle, and a server-only import turns that into a build
 * error a long way from its cause. Server-side session work lives in
 * `session.ts` for that reason.
 */

import type { JobPriority, JobStage, JobStatus } from "./job-stages";

export type Role =
  | "owner"
  | "super_admin"
  | "admin"
  | "client_admin"
  | "client_user"
  | "contractor";

export type ProfileStatus = "active" | "pending_approval" | "suspended";

export type Actor = {
  profileId: string;
  email: string;
  role: Role;
  status: ProfileStatus;
  organisationId: string | null;
  contractorId: string | null;
  siteIds: string[];
};

export type Viewer = {
  actor: Actor;
  fullName: string | null;
  phone: string | null;
};

/** A row from `GET /jobs`. Money is absent, not null, for a contractor. */
export type JobRow = {
  id: string;
  reference: string;
  title: string;
  description: string;
  status: JobStatus;
  stage: JobStage;
  priority: JobPriority | null;
  engineer_required: string | null;
  fault_label: string | null;
  tier_level: number | null;
  location: string | null;
  date_requested: string;
  date_completed: string | null;
  next_update: string | null;
  job_requested_by: string | null;
  contact_number: string | null;
  contractor_name: string | null;
  assigned_to_name: string | null;
  /*
   * Absent, not empty, for a contractor. The token opens the public view of
   * the job, and that view shows the cost of works — so the one role the API
   * strips the money columns from is not sent the credential that would show
   * them anyway. Anything reading this must cope with the key not being there.
   */
  share_token?: string;
  site_id: string | null;
  site_name: string | null;
  organisation_id: string;
  organisation_name: string | null;
  /*
   * Assignment. `null` on `assignment_status` means the job has never been
   * offered to anybody — see migration 0008. It is deliberately NOT the same as
   * "declined": a refusal keeps the contractor on the row so that it stays
   * attributable and so the job does not decay into one nobody ever looked at.
   */
  assignment_status: AssignmentStatus | null;
  assigned_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  eta_at: string | null;
  /*
   * Optional, and that is the point. `GET /jobs` omits these columns entirely
   * for a contractor rather than sending nulls, so anything reading them must
   * cope with the key not being there at all.
   */
  cost_of_works_pence?: number | null;
  invoice_ref?: string | null;
  approved_by?: string | null;
};

/** `GET /jobs/:id` selects `j.*`, so it carries more than the list rows do. */
export type JobDetail = JobRow & {
  share_enabled?: boolean;
  share_expires_at?: string | null;
  status_changed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type JobsPage = {
  jobs: JobRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

/**
 * How many cards a stage column loads at a time.
 *
 * Lives here rather than in the board component because the server component
 * that renders the first page needs the same number: a `"use client"` module's
 * exports become client references when a server component imports them, so a
 * constant shared across that boundary has to come from a module that is
 * neither.
 */
export const BOARD_PAGE_SIZE = 25;

/** One stage column's first page, rendered on the server and handed to the board. */
export type StageSeed = { rows: JobRow[]; error: string | null };

export type JobComment = {
  id: string;
  body: string;
  author_name: string | null;
  author_full_name: string | null;
  via_share_link: boolean;
  created_at: string;
};

export type JobAttachment = {
  id: string;
  kind: "issue_picture" | "completed_picture" | "file";
  /*
   * A key into a private bucket, NOT a URL. Nothing is readable from it — put
   * it in an `<img src>` and every photograph in the portal is a broken image.
   * Bytes come back through `GET /uploads/:id/url`, which mints a short-lived
   * signed URL after running the access check.
   */
  object_key: string;
  original_name: string;
  content_type: string;
  byte_size: number;
  uploaded_by_name: string | null;
  via_share_link: boolean;
  /*
   * Optional because only one of the two endpoints can ever set it: `GET
   * /jobs/:id` filters `pending` rows out for everybody, so a share-link upload
   * awaiting release is visible only through `GET /uploads/job/:id`, and only
   * to staff. Anything reading this must cope with the key being absent.
   */
  pending?: boolean;
  reviewed_at?: string | null;
  created_at: string;
};

export type JobQuote = {
  id: string;
  amount_pence: number;
  description: string | null;
  status: "pending" | "approved" | "rejected";
  valid_until: string | null;
  decided_at: string | null;
  created_at: string;
};

export type JobDetailPayload = {
  job: JobDetail;
  comments: JobComment[];
  quotes: JobQuote[];
  attachments: JobAttachment[];
};

/* ------------------------------------------------------------- assignment -- */

/** Migration 0008's enum. `null` — never offered — is the fourth state. */
export type AssignmentStatus = "offered" | "accepted" | "declined";

/** One row of `GET /jobs/quotes/pending`: a quote, with the job it is for. */
export type PendingQuote = {
  id: string;
  amount_pence: number | string;
  description: string | null;
  valid_until: string | null;
  created_at: string;
  job_id: string;
  reference: string;
  title: string;
  status: string;
  site_name: string | null;
  organisation_name: string | null;
};

export type PendingQuotes = { quotes: PendingQuote[]; canDecide: boolean };

/** One month of `GET /jobs/summary/monthly`. Empty months are present as zeroes. */
export type MonthlyRow = {
  month: string;
  raised: number;
  completed: number;
  spendPence: number;
};

export type MonthlySummary = {
  months: MonthlyRow[];
  openByStage: Record<string, number>;
  totals: { raised: number; completed: number; spendPence: number; open: number };
};

/** What an assignment state is called on screen, and how it is coloured. */
export const ASSIGNMENT_LABELS: Record<AssignmentStatus, string> = {
  offered: "Offered — awaiting acceptance",
  accepted: "Accepted",
  declined: "Declined — needs reassignment",
};

/*
 * A declined job is the one state that has to look wrong. It is not an error —
 * the contractor answered honestly — but it is work that has stopped moving,
 * and the whole reason 0008 keeps it on the row rather than unassigning is so
 * that somebody sees it. The word is always rendered too: colour never carries
 * a meaning on its own.
 */
export const assignmentChipClass = (status: AssignmentStatus | null): string =>
  status === "declined" ? "chip chip--urgent" : "chip chip--status";

export type Site = {
  id: string;
  name: string;
  organisation_id: string | null;
  /*
   * Optional because `/members/scopes` does not send them and `/jobs/meta/sites`
   * does. The portal's Report a Job form pre-fills the site address from these
   * so a store manager does not retype what their account already knows.
   */
  address?: string | null;
  postcode?: string | null;
};
export type Organisation = { id: string; name: string };
export type Contractor = { id: string; name: string };

export type Scopes = {
  organisations: Organisation[];
  sites: Site[];
  contractors: Contractor[];
};

export type Member = {
  id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  role: Role;
  status: ProfileStatus;
  organisation_id: string | null;
  organisation_name: string | null;
  contractor_id: string | null;
  contractor_name: string | null;
  created_at: string;
  last_seen_at: string | null;
  email_verified: boolean;
  site_names: string[];
};

export type Invitation = {
  id: string;
  email: string;
  role: Role;
  status: string;
  expires_at: string;
  created_at: string;
  organisation_name: string | null;
};

/* --------------------------------------------------------------- analytics -- */

/** One bar. `label` is always rendered — colour never carries a value alone. */
export type MixSlice = { label: string; jobs: number };

export type SpendSiteRow = {
  siteName: string;
  /** One figure per month in `AnalyticsSpend.months`, same order, pence. */
  monthly: number[];
  totalPence: number;
};

export type AnalyticsSpend = {
  months: string[];
  sites: SpendSiteRow[];
  /**
   * How many SITES the spend covers, which is not `sites.length`.
   *
   * The last row of `sites` is an "Other sites (n)" rollup, so counting rows
   * reported 13 when the money spanned 26 stores. The API knows what the
   * rollup stands for; the screen does not, so it is sent rather than derived.
   */
  siteCount: number;
  monthlyTotals: number[];
  totalPence: number;
};

export type WaitingJob = {
  id: string;
  reference: string;
  title: string;
  status: string;
  stage: string;
  priority: string | null;
  site_name: string;
  date_requested: string;
  age_days: number;
};

export type ComplianceDue = {
  id: string;
  kind: string;
  status: string;
  site_name: string;
  expiry_date: string;
  days_left: number;
};

export type ContractorScore = {
  id: string;
  name: string;
  jobs: number;
  completed: number;
  /** Absent — not null — when the caller may not see money. See `JobRow`. */
  spendPence?: number;
};

/**
 * `GET /analytics/overview`.
 *
 * `spend` is optional for the same reason the money columns on `JobRow` are:
 * the API omits the section entirely rather than sending nulls, so anything
 * reading it must cope with the key not being there. `money` states which case
 * it is — "not shown to your role" and "nothing was spent" are different
 * sentences and a screen that confuses them is lying in one of them.
 */
export type AnalyticsOverview = {
  money: boolean;
  generatedAt: string;
  jobs: {
    byStage: MixSlice[];
    byPriority: MixSlice[];
    total: number;
    open: number;
    completed: number;
  };
  ageing: { buckets: MixSlice[]; waitingLongest: WaitingJob[] };
  compliance: {
    byStatus: { label: string; documents: number }[];
    expired: number;
    dueWithin: { days30: number; days60: number; days90: number };
    soonest: ComplianceDue[];
  };
  contractors: { rows: ContractorScore[] };
  spend?: AnalyticsSpend;
};

/* ---------------------------------------------------------------- settings -- */

export type SettingSource = "database" | "environment" | "default";

export type Setting = {
  key: string;
  type: "boolean" | "integer" | "text" | "json";
  label: string;
  description: string;
  value: unknown;
  source: SettingSource;
  envVar: string | null;
  envValue: string | null;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

export type SettingAuditEntry = {
  id: string;
  key: string;
  old_value: unknown;
  new_value: unknown;
  changed_by_email: string;
  created_at: string;
};

export type IntakeRequest = {
  id: string;
  site_name: string;
  contact_name: string;
  phone: string;
  email: string;
  address: string;
  postcode: string;
  fault_category: string;
  urgency: string;
  description: string;
  access_window: string | null;
  photos: string[];
  created_at: string;
};

/* ------------------------------------------------------------- compliance -- */

/**
 * The five states a requirement can be in, recomputed by the API on every read.
 *
 * "Not required" is not a failure and "Missing" is not "Not required" — the
 * whole point of the register is that those are different facts about a store
 * and only one of them is somebody's job to fix.
 */
export type ComplianceStatus =
  | "Missing"
  | "Valid"
  | "Expiring"
  | "Expired"
  | "Not required";

/** One entry in the requirement catalogue: the denominator, as data. */
export type ComplianceRequirement = {
  kind: string;
  label: string;
  expires: boolean;
  sort_order: number;
};

/**
 * A score AND the integers it was made from.
 *
 * `percent` alone is exactly what went wrong before: it can halve because the
 * requirement list grew rather than because anything lapsed. Every screen that
 * prints the percentage must print `inDate` and `required` beside it, which is
 * why they travel together in one type.
 */
export type ComplianceScore = {
  /** The denominator: requirements counted, `not_required` already removed. */
  required: number;
  /** The numerator: Valid + Expiring. An expiring certificate is still in date. */
  inDate: number;
  valid: number;
  expiring: number;
  expired: number;
  missing: number;
  /** Excluded from `required`, shown separately so the exclusion is visible. */
  notRequired: number;
  /** Null when nothing is required — a fraction with no denominator has no value. */
  percent: number | null;
};

export type ComplianceSiteRow = {
  id: string;
  name: string;
  organisationId: string;
  organisationName: string;
  nextExpiry: string | null;
  score: ComplianceScore;
};

export type ComplianceOverview = {
  requirements: ComplianceRequirement[];
  sites: ComplianceSiteRow[];
  summary: ComplianceScore & { sites: number };
  expiringWithinDays: number;
  canManage: boolean;
};

export type ComplianceCertificate = {
  id: string;
  kind: string;
  original_name: string;
  created_at: string;
};

export type ComplianceRow = {
  kind: string;
  label: string;
  expires: boolean;
  document_id: string | null;
  expiry_date: string | null;
  days_left: number | null;
  not_required: boolean;
  not_required_reason: string | null;
  /*
   * A key into a private bucket lives on the API side only — what comes back
   * here is the attachment id, and the bytes arrive through
   * `GET /uploads/:id/url`, which mints a short-lived signed URL after running
   * the same site access check.
   */
  attachment_id: string | null;
  original_name: string | null;
  content_type: string | null;
  uploaded_at: string | null;
  status: ComplianceStatus;
  /** Superseded certificates, newest first. Replacing one does not delete it. */
  previous: ComplianceCertificate[];
};

export type ComplianceSiteDetail = {
  site: { id: string; name: string; organisation_id: string };
  requirements: ComplianceRow[];
  score: ComplianceScore;
  expiringWithinDays: number;
  canManage: boolean;
};

export type ComplianceCalendarItem = {
  site_id: string;
  site_name: string;
  organisation_name: string;
  kind: string;
  label: string;
  expiry_date: string;
  days_left: number;
};

export type ComplianceCalendar = {
  months: number;
  expiringWithinDays: number;
  expired: ComplianceCalendarItem[];
  soon: ComplianceCalendarItem[];
  later: ComplianceCalendarItem[];
};

/* --------------------------------------------------------------- invoices -- */

/** Derived by the API from the due date. 'overdue' is never a stored value. */
export type InvoiceStatus = "awaiting_payment" | "paid" | "overdue" | "cancelled";

export type InvoiceRow = {
  id: string;
  invoice_number: string;
  /** Integer pence. Never a float, and never pounds. */
  amount_pence: number;
  notes: string | null;
  issued_at: string | null;
  due_at: string | null;
  paid_at: string | null;
  status: InvoiceStatus;
  /** Negative once it is late. Null when no due date was recorded. */
  days_to_due: number | null;
  organisation_id: string;
  organisation_name: string;
  job_id: string | null;
  job_reference: string | null;
  job_title: string | null;
  contractor_id: string | null;
  contractor_name: string | null;
  attachment_id: string | null;
  created_at: string;
};

export type InvoiceTotals = {
  count: number;
  totalPence: number;
  paidPence: number;
  outstandingPence: number;
  overduePence: number;
  overdueCount: number;
};

export type InvoicePage = {
  invoices: InvoiceRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /** Totals for the CURRENT filter, so the figure matches the list under it. */
  totals: InvoiceTotals;
  canRecord: boolean;
};

export type InvoiceOrganisationTotals = Omit<InvoiceTotals, "count"> & {
  organisationId: string;
  organisationName: string;
  invoiceCount: number;
};

export type InvoiceSummary = {
  organisations: InvoiceOrganisationTotals[];
  totals: Omit<InvoiceTotals, "count"> & { invoiceCount: number };
};

/* ------------------------------------------------------------ capabilities -- */

/*
 * A deliberate, minimal mirror of `apps/api/src/lib/access.ts`.
 *
 * The API re-checks every one of these on every request; this copy exists only
 * so the shell does not draw a link that answers 403, or a control whose only
 * possible outcome is an error message. It is presentation, never enforcement —
 * if the two ever disagree, the API wins and the user sees a refusal.
 */
export const OWNER_EMAIL = "anwarrshboul@gmail.com";

const STAFF: readonly Role[] = ["owner", "super_admin", "admin"];

export const isStaff = (role: Role): boolean => STAFF.includes(role);

const RANK: Record<Role, number> = {
  owner: 5,
  super_admin: 4,
  admin: 3,
  client_admin: 2,
  client_user: 1,
  contractor: 1,
};

export const canSeeMoney = (actor: Actor): boolean =>
  actor.status === "active" && actor.role !== "contractor";

export const canTriage = (actor: Actor): boolean =>
  actor.status === "active" && isStaff(actor.role);

export const canManageMembers = canTriage;

/** Staff move the work; the assigned contractor moves their own. A client watches. */
export const canChangeStatus = (actor: Actor): boolean =>
  actor.status === "active" &&
  (isStaff(actor.role) || actor.role === "contractor");

/**
 * Handing a job to a contractor. Staff only, and the API says so too — a role
 * that could assign could assign to itself, which is self-granted access to any
 * job it could name.
 */
export const canAssign = (actor: Actor): boolean =>
  actor.status === "active" && isStaff(actor.role);

/** Approving or rejecting a quote. The client decides; staff may act for them. */
export const canDecideQuotes = (actor: Actor): boolean =>
  actor.status === "active" &&
  (isStaff(actor.role) || actor.role === "client_admin");

/**
 * Answering an offer: accept, decline, promise an ETA.
 *
 * Whether this particular job is theirs is not knowable here — that is
 * `contractor_id`, which the browser is not the authority on. The component
 * takes the job's assignment state as well, and the API refuses either way.
 */
export const canAnswerOffer = (actor: Actor): boolean =>
  actor.status === "active" &&
  (isStaff(actor.role) || actor.role === "contractor");

/** Reporting a fault from inside the portal: the client side of the house. */
export const canReportJob = (actor: Actor): boolean =>
  actor.status === "active" &&
  (actor.role === "client_admin" || actor.role === "client_user");

/**
 * Account-level settings. The owner alone — mirrors `canManageSettings` in the
 * API's access.ts, which refuses everybody else outright.
 */
export const canManageSettings = (actor: Actor): boolean =>
  actor.status === "active" && actor.role === "owner";

/**
 * The compliance register. Everyone with a site scope reads it; a contractor
 * has none, and `siteScopeFor` in the API denies them outright.
 */
export const canSeeCompliance = (actor: Actor): boolean =>
  actor.status === "active" && actor.role !== "contractor";

/**
 * Uploading a certificate, setting an expiry, marking a requirement not
 * required. Mirrors `canManageCompliance` in the API's access.ts: staff and the
 * client admin whose paperwork it is, but not a site-scoped client_user —
 * `not_required` moves the score's denominator for the whole estate.
 */
export const canManageCompliance = (actor: Actor): boolean =>
  actor.status === "active" &&
  (isStaff(actor.role) || actor.role === "client_admin");

/**
 * Recording an invoice or marking one paid. Staff only, and narrower than
 * `canSeeMoney`: a client reads their own ledger, and the ledger is MAINTSUPP's
 * bookkeeping.
 */
export const canRecordInvoices = (actor: Actor): boolean =>
  actor.status === "active" && isStaff(actor.role);

export const canGrantRole = (actor: Actor, role: Role): boolean => {
  if (!canManageMembers(actor)) return false;
  if (role === "owner") return false; // there is one, declared in a migration
  return RANK[actor.role] > RANK[role];
};

export const canActOnMember = (
  actor: Actor,
  target: { email: string; role: Role },
): boolean => {
  if (!canManageMembers(actor)) return false;
  if (target.email.trim().toLowerCase() === OWNER_EMAIL) return false;
  return RANK[actor.role] > RANK[target.role];
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  super_admin: "Super admin",
  admin: "Admin",
  client_admin: "Client admin",
  client_user: "Client user",
  contractor: "Contractor",
};

export const ALL_ROLES: readonly Role[] = [
  "owner",
  "super_admin",
  "admin",
  "client_admin",
  "client_user",
  "contractor",
];

/* -------------------------------------------------------------------- nav -- */

export type NavItem = { href: string; label: string };

/**
 * The links a role may open. Presentation only — see the note above — but a
 * link that always 403s is worse than no link, because it teaches people the
 * product is broken rather than that the page is not theirs.
 */
export function navFor(actor: Actor): NavItem[] {
  const items: NavItem[] = [];
  /*
   * A contractor lands on their own work list, not on the board. The board is
   * a stage-grouped view of a client's estate; scoped to one contractor it is
   * seven columns with two cards in them, and it answers none of the three
   * questions they actually have — what have I not accepted, where am I
   * expected, and what still needs closing out.
   */
  if (actor.role === "contractor") {
    items.push({ href: "/portal/my-jobs", label: "My jobs" });
  }
  items.push({ href: "/portal/dashboard", label: "Board" });
  if (canTriage(actor)) items.push({ href: "/portal/requests", label: "Requests" });
  if (canDecideQuotes(actor)) items.push({ href: "/portal/quotes", label: "Quotes" });
  // The monthly picture is money and portfolio counts, so it follows the same
  // line as Analytics: staff and the client admin who is accountable for it.
  if (isStaff(actor.role) || actor.role === "client_admin") {
    items.push({ href: "/portal/summary", label: "Summary" });
  }
  if (canReportJob(actor)) items.push({ href: "/portal/report", label: "Report a job" });
  /*
   * Analytics is OFFERED to staff and client admins, which is a menu decision
   * rather than a permission: `/analytics` refuses nobody who is signed in,
   * because every figure it returns is an aggregate of the rows that caller's
   * scope already allows — a contractor asking for it gets counts of their own
   * assigned jobs and no money at all. This line decides whose screen it is,
   * not who may compute it.
   */
  if (isStaff(actor.role) || actor.role === "client_admin") {
    items.push({ href: "/portal/analytics", label: "Analytics" });
  }
  /*
   * Compliance is offered to everyone with a site scope. A contractor has none
   * — `siteScopeFor` denies them — so the link would open a register with no
   * sites in it, which reads as a broken page rather than as one that is not
   * theirs.
   */
  if (canSeeCompliance(actor)) {
    items.push({ href: "/portal/compliance", label: "Compliance" });
  }
  // Money. The API refuses a contractor outright, so this is a permission.
  if (canSeeMoney(actor)) items.push({ href: "/portal/invoices", label: "Invoices" });
  if (canManageMembers(actor)) items.push({ href: "/portal/members", label: "Members" });
  // The one link that IS a permission: the API answers 403 to everybody else.
  if (canManageSettings(actor)) items.push({ href: "/portal/settings", label: "Settings" });
  return items;
}

/* -------------------------------------------------------------- formatting -- */

/**
 * Parses a Postgres timestamp as rendered by `::text`.
 *
 * That gives "2026-08-14 09:12:33.482+00" — a space instead of the ISO "T", and
 * a two-digit offset. Chrome tolerates it; Safari returns Invalid Date, so on
 * an iPhone every date on the board would read "—". Normalising first is the
 * difference between a working board and one that silently loses its dates on
 * exactly the device this product is used on.
 */
export function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;

  /*
   * A `date` column arrives as "2026-08-26", with no time at all, and it has to
   * be handled BEFORE the offset repair below — because "-26" matches
   * `([+-]\d{2})$` and the repair turns the day of the month into a timezone,
   * producing "2026-08-26:00" and an Invalid Date. Every compliance expiry and
   * every `next_update` on the board is a plain date, so without this branch
   * they all render as "—".
   *
   * Built from its three parts rather than passed to `new Date("2026-08-26")`,
   * which the spec says to read as UTC midnight: west of Greenwich that is the
   * 25th locally, and a certificate would appear to expire the day before it
   * does. A calendar date has no timezone, so it is constructed as local
   * midnight and stays the date that was written down.
   */
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (dateOnly) {
    const parsedDate = new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
    );
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }

  const iso = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDate(value: string | null | undefined): string | null {
  const parsed = parseTimestamp(value);
  return parsed
    ? parsed.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;
}

export function formatDateTime(value: string | null | undefined): string | null {
  const parsed = parseTimestamp(value);
  return parsed
    ? parsed.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
}

/** Money, or null when the caller was never sent the field. */
export function formatMoney(pence: number | null | undefined): string | null {
  if (pence === null || pence === undefined || !Number.isFinite(pence)) return null;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(pence / 100);
}

/** Priority chip class. The word is always rendered too — colour alone is not a signal. */
export function priorityChipClass(priority: string | null): string {
  switch (priority) {
    case "Urgent":
      return "chip chip--urgent";
    case "Medium":
      return "chip chip--medium";
    case "Low":
      return "chip chip--low";
    default:
      return "chip chip--low";
  }
}

/**
 * The compliance status chip.
 *
 * Four states and four treatments, and the word is always rendered alongside —
 * a reader who cannot tell amber from red must still be able to tell an expired
 * certificate from one expiring next month. "Missing" is outlined rather than
 * filled because it is an absence: nothing has been filed, which is a different
 * thing from something that has lapsed.
 */
export function complianceChipClass(status: ComplianceStatus | string): string {
  switch (status) {
    case "Valid":
      return "chip p-chip--good";
    case "Expiring":
      return "chip chip--medium";
    case "Expired":
      return "chip chip--urgent";
    case "Missing":
      return "chip chip--status";
    default:
      // "Not required" — neither a pass nor a fail, and not in the denominator.
      return "chip chip--low";
  }
}

/** How an invoice's derived status is spelled on screen. */
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  awaiting_payment: "Awaiting payment",
  paid: "Paid",
  overdue: "Overdue",
  cancelled: "Cancelled",
};

export function invoiceChipClass(status: InvoiceStatus | string): string {
  switch (status) {
    case "paid":
      return "chip p-chip--good";
    case "overdue":
      return "chip chip--urgent";
    case "awaiting_payment":
      return "chip chip--medium";
    default:
      return "chip chip--low";
  }
}

/**
 * Pounds typed by a person into integer pence.
 *
 * Parsed as two integers rather than multiplied as a float: `12.10 * 100` is
 * 1209.9999999999998 in IEEE 754, and rounding that happens to work while
 * `Math.round(1.005 * 100)` does not. Money is integer pence everywhere in this
 * product, and the one place it could stop being exact is the moment a human
 * types a decimal point. Returns null for anything that is not an amount.
 */
export function poundsToPence(value: string): number | null {
  const text = value.trim().replace(/^£/, "").replace(/,/g, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const pounds = Number(match[1]);
  const pence = Number((match[2] ?? "0").padEnd(2, "0"));
  if (!Number.isSafeInteger(pounds * 100 + pence)) return null;
  return pounds * 100 + pence;
}
