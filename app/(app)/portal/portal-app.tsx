"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Avatar, BrandMark, Icon, type IconName } from "../../components";
/*
 * `mock-data.ts` is deliberately NOT imported here.
 *
 * It used to seed three pieces of state — the jobs, the document register and
 * the site list — so the dashboard had something to draw before its fetches
 * landed. The comment said it was for the marketing preview; nothing in
 * `(marketing)` has rendered this component for a long time, so the only
 * readers were real ones.
 *
 * What that bought was a first paint of somebody else's portfolio, and, when a
 * fetch failed, a permanent one: a chip reading "Sample data — workspace
 * unavailable" over dashboards still computing spend, compliance and SLA from
 * eleven invented jobs. A caption does not undo a £42,540 figure sitting next
 * to it, and nobody reads a caption to find out whether the number above it is
 * theirs.
 *
 * Empty is honest. Every screen below already has an empty state, because an
 * genuinely empty workspace was always possible.
 */
import type {
  BoardOptionColumn,
  ComplianceState,
  AttachmentKind,
  FileRecord,
  MaintenanceBoardColumn,
  MaintenanceRequest,
  Priority,
  RequestActivityEntry,
  RequestUpdate,
  RequestDrawerTab,
  RequestStage,
  StoreRecord,
} from "../../lib/types";
import { AccountMenu } from "./account-menu";
import {
  formatDayMonth,
  formatMonthShort,
  formatShortDate,
  formatShortDateTime,
  formatTimeOfDay,
} from "../../lib/format-date";
/*
 * The rules for turning a typed-in number into something a handset can act on.
 * They live in one module because the contractor register is not the only
 * place a number is printed, and because `wa.me` refuses a national number
 * rather than dialling it — see the file's own header for why guessing a
 * country code is the one thing neither helper is allowed to do.
 */
import { telHref, whatsappHref } from "../../lib/contact-links";
import { chipInk } from "./chip-ink";
/*
 * ── The calendar ─────────────────────────────────────────────────────────────
 *
 * Five files, split by what they are rather than by size: the model is pure and
 * testable, the surfaces are presentational, the controls own their popovers,
 * the preferences own the browser store, and `calendar-surface.tsx` joins them
 * into the panel that both this page and the board's Calendar view tab mount.
 * This file keeps only what belongs to the PAGE — its heading, its own date
 * range, and the planned register underneath.
 */
import { OperationsCalendarPanel } from "./calendar-surface";
import type { CalendarWriteTarget } from "./calendar-model";
import {
  awaitingApprovalStatuses,
  awaitingPartsStatuses,
  isClosedRequest,
  isOpenRequest,
} from "./dashboard-meters";
import { ThemeToggle } from "./theme-toggle";
import { DashboardWidgets, type DashboardWidget } from "./dashboard-widgets";
import { EvidenceManager } from "./evidence-manager";
import { BeforeAfter } from "./before-after";
// Stage 20 — the sidebar is arranged per person. See sidebar-nav.tsx.
import { SidebarNav, type SidebarNavEntry } from "./sidebar-nav";
import { uploadEvidenceFile } from "../../lib/client-upload";
import {
  LiveMaintenanceBoard,
  type MaintenanceBoardSnapshot,
  type MaintenanceBoardSnapshotColumn,
} from "./live-board";
import { RaiseTicketButton } from "./raise-ticket";
// The Updates panel, built against monday's — see update-thread.tsx.
import { UpdateThread, type ComposerHandle } from "./update-thread";
import "./update-thread.css";
import { useBodyScrollLock } from "./overlay/scroll-lock";
import { AnchoredPopover } from "./overlay/anchored";
import { ItemActionsMenu, type BoardItemActions } from "./overlay/item-actions";
import { installSessionGuard } from "./session-guard";
import { publishedBoardOptions } from "../../lib/board-option-registry";
import { RECOMMENDED_EVIDENCE_CATEGORIES } from "../../lib/workspace-data";
import { priorityOptions } from "./board-model";
import {
  classifySpend,
  ComplianceExpiryTimeline,
  ContractorScorecard,
  CostByCategory,
  OpenJobAgeing,
  ReactiveVsPlanned,
  SiteAttention,
  SlaPerformance,
  SpendAgainstBudget,
  SpendMatrix,
  SpendTrend,
} from "./dashboard-insights";
import { storeDocumentationResponsibility } from "../../../db/monday-board-spec";
import ContractorLinkPanel from "./contractor-link-panel";
import { SitesManager } from "./sites/sites-manager";
import { AdminClientsView } from "./views/admin-clients";
import { RecycleBinSection } from "./views/recycle-bin-section";
import { AdminRolesView } from "./views/admin-roles";
import { AdminUsersView } from "./views/admin-users";
import { AuditLog } from "./views/audit-log";
import { StoreDocumentationBoard } from "./views/store-documentation-board";
import { complianceTrend, tradeBreakdown } from "./views/overview-series";
import { UnitsManager } from "./units/units-manager";
import {
  defaultWorkspaceSettings,
  type WorkspaceContractor,
  type WorkspaceMember,
  type WorkspacePlannedItem,
  type WorkspaceSettings,
  type WorkspaceSnapshot,
  type WorkspaceUnit,
} from "../../lib/workspace-data";
import {
  WorkspaceDataManager,
  type ManagerTab,
} from "./workspace-data-manager";
import {
  AnalyticsMetricCard,
  AnalyticsToolbar,
  DonutChart,
  DonutLegend,
  HorizontalBars,
  TrendChart,
  withinAnalyticsPeriod,
  type DonutSegment,
} from "./dashboard-analytics";
import {
  PeriodCaption,
  PeriodPicker,
  SortDirectionSelect,
  useStoredPeriod,
  useStoredSortDirection,
} from "./period-picker";
import {
  endOfDay,
  parseStamp,
  periodSpendSeries,
  periodTrend,
  resolvePeriod,
  sortBySpend,
  stampWithinPeriod,
} from "./period-model";

export type Section =
  | "overview"
  | "maintenance"
  | "units"
  | "stores"
  | "store-documentation"
  | "contractors"
  | "compliance"
  | "calendar"
  | "documents"
  | "reports"
  | "team"
  | "settings"
  // Stage 20 administration. Three sections rather than one screen with tabs,
  // because each is gated on a different capability — a client who may see
  // users must not be handed the roles editor by a tab they can click.
  | "admin-users"
  | "admin-roles"
  | "admin-clients"
  /*
   * The audit trail. The screen and its API have existed since Stage 20 and
   * nothing in the product linked to them: /dashboard/audit answered, and the
   * only way to reach it was to type it. A log nobody can find is a log nobody
   * reads.
   */
  | "audit"
  /*
   * The recycle bin, for the same reason and with a sharper edge. The bin, its
   * 30-day retention, its API and its screen all existed; the only route to
   * them was nine items down the menu behind the avatar, and the client's
   * report was that there was no way to get a deleted row back. Undo that
   * nobody can find is not undo. This renders the same panel over the same API.
   */
  | "recycle-bin";

type ViewMode = "board" | "list";

type NotificationState = "read" | "dismissed";

type DemoRole = "super_admin" | "admin" | "client";

type OrganisationSummary = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  primaryColour: string;
  planTier: string;
  status: string;
};

type RuntimeWorkspaceContext = {
  actor: { email: string; displayName: string; role: DemoRole };
  currentOrganisation: OrganisationSummary;
  organisations: OrganisationSummary[];
  /**
   * The identity the server resolved, and everything it may read.
   *
   * `organisationIds` is the authority on scope — the organisation cookie is a
   * request the server honours only when it names one of these. Rendered in the
   * sidebar because an empty board and a board you are not allowed to see look
   * identical, so without it the scoping has to be taken on trust.
   */
  identity?: {
    email: string;
    organisationIds: string[];
    crossOrganisation: boolean;
    unaffiliated: boolean;
  };
  /**
   * Every client and what each holds. Served only to a super admin; a client
   * receives null, so this cannot leak another client's row counts.
   */
  tenantSummary?: Array<{
    id: string;
    name: string;
    slug: string;
    maintenanceRequests: number;
    sites: number;
  }> | null;
  testingMode: boolean;
  authenticationEnabled: boolean;
  /**
   * What this actor may do here — the defaults merged with this workspace's
   * overrides, decided by the same `can()` every route enforces with.
   *
   * Optional because a browser holding a cached payload from before this field
   * existed must not crash the shell; a missing map means "not answered", which
   * every reader treats as "do not offer" rather than "denied".
   */
  capabilities?: Record<string, boolean>;
};

type WorkspaceManagerState = {
  tab: ManagerTab;
  recordId?: string | null;
};

const managerTabBySection: Partial<Record<Section, ManagerTab>> = {
  stores: "site",
  compliance: "compliance",
  units: "unit",
  contractors: "contractor",
  calendar: "planned",
  team: "member",
};

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type NotificationStateEntry = {
  requestId: string;
  state: NotificationState;
  updatedAt: string;
};

/** How a stored role reads to a person. */
function roleLabel(role: string) {
  if (role === "super_admin") return "Super Admin";
  if (role === "admin") return "Admin";
  return "Client";
}

const sectionMeta: Record<
  Section,
  { label: string; eyebrow: string; title: string; icon: IconName }
> = {
  "admin-users": {
    label: "Users",
    eyebrow: "Administration",
    title: "Users & access",
    icon: "user",
  },
  "admin-roles": {
    label: "Roles",
    eyebrow: "Administration",
    title: "Roles & permissions",
    icon: "settings",
  },
  "admin-clients": {
    label: "All clients",
    eyebrow: "Owner console",
    title: "Every client workspace",
    icon: "building",
  },
  audit: {
    label: "Audit",
    eyebrow: "Administration",
    title: "Audit trail",
    icon: "shield",
  },
  "recycle-bin": {
    label: "Recycle Bin",
    eyebrow: "Workspace",
    title: "Recycle Bin",
    // No bin in the icon set; the recycling arrows are the nearest true thing,
    // and they read as "put it back" rather than as "throw it away".
    icon: "refresh",
  },
  overview: {
    label: "Overview",
    eyebrow: "Operations centre",
    title: "Good morning",
    icon: "grid",
  },
  maintenance: {
    label: "Jobs",
    eyebrow: "Work order management",
    title: "Live job list",
    icon: "wrench",
  },
  units: {
    label: "Units",
    eyebrow: "Asset register",
    title: "Units & assets",
    icon: "building",
  },
  stores: {
    label: "Sites",
    eyebrow: "Property portfolio",
    // "& assets" because this screen is now the only way in to the unit
    // register; opening a site lists the units on it.
    title: "Sites, units & assets",
    icon: "store",
  },
  "store-documentation": {
    label: "Store Documentation",
    eyebrow: "Compliance documents",
    title: "Store Documentation UK",
    icon: "document",
  },
  contractors: {
    label: "Contractors",
    eyebrow: "Supplier network",
    title: "Contractor performance",
    icon: "users",
  },
  compliance: {
    label: "Compliance",
    eyebrow: "Document control",
    title: "Compliance tracker",
    icon: "shield",
  },
  calendar: {
    label: "Planned",
    eyebrow: "Planned maintenance",
    title: "Planned works calendar",
    icon: "calendar",
  },
  documents: {
    label: "Documents",
    eyebrow: "Central file library",
    title: "Documents & evidence",
    icon: "folder",
  },
  reports: {
    label: "Reports",
    eyebrow: "Portfolio intelligence",
    title: "Spend & reporting",
    icon: "chart",
  },
  team: {
    label: "Team",
    eyebrow: "People & permissions",
    title: "Workspace team",
    icon: "users",
  },
  settings: {
    label: "Settings",
    eyebrow: "Workspace controls",
    title: "Settings",
    icon: "settings",
  },
};

/*
 * Stage 20. These two arrays used to *be* the sidebar — what you saw was a
 * `.map` over them and nothing else. They are now the bottom layer of three:
 * the order a workspace has before an admin has set a default and before the
 * person looking at it has arranged anything.
 *
 * They are still written out here, in the file that draws the sidebar, because
 * that is where anybody adding a section will look. `BUILT_IN_ORDER` in
 * `app/api/navigation/layout.ts` is the server's copy of the same order, needed
 * so `GET /api/navigation` can answer without a browser;
 * `tests/stage-twenty-navigation.test.mjs` asserts the two agree, which is what
 * makes a second copy safe rather than a second source of truth.
 */
/*
 * "Units" is deliberately absent.
 *
 * It was a second door to data the Sites screen already shows: `site-detail`
 * lists every unit on the site it belongs to, so the register was reachable
 * twice and the sidebar offered two entries — "Units & assets" and "Sites &
 * locations" — for one portfolio. The owner asked for one.
 *
 * The SECTION is kept, not deleted. `/dashboard/units` still resolves, the
 * screen still renders, and no row in the asset register is affected; what
 * changes is that the sidebar stops offering the duplicate. Anyone who has
 * bookmarked it, or whose saved layout still names it, keeps working — a saved
 * layout records arrangement, and existence comes from the catalogue.
 */
const navPrimary: Section[] = [
  /*
   * The owner's order, given explicitly: overview, jobs, store documentation,
   * compliance, planned, then the rest, with settings last.
   *
   * It follows the working day rather than the data model — what is happening
   * now, then the paperwork that is about to expire, then what is booked. The
   * previous order put the site register third, which is a reference screen
   * nobody opens first.
   *
   * Settings is last deliberately: it is the only entry that changes how the
   * product behaves rather than showing what is in it.
   */
  "overview",
  "maintenance",
  "store-documentation",
  "compliance",
  "calendar",
  "stores",
  "contractors",
  "documents",
  "reports",
  "settings",
];

const navSecondary: Section[] = [
  "team",
  "admin-users",
  "admin-roles",
  "admin-clients",
  // Last under Workspace, beside the two screens that decide who may do what.
  // Filtered out of the catalogue entirely for a role without `audit.read` —
  // see `navCatalogue`.
  "audit",
  // Beside the audit trail, which is the other screen someone opens when
  // something has gone wrong and they need to know what happened to it.
  "recycle-bin",
];

const sectionRoutes: Record<Section, string> = {
  overview: "",
  maintenance: "jobs",
  calendar: "planned",
  units: "units",
  stores: "sites",
  "store-documentation": "store-documentation",
  contractors: "contractors",
  compliance: "compliance",
  documents: "documents",
  reports: "reports",
  settings: "settings",
  team: "team",
  // Nested, so the account menu's "Administration" link and the two screens
  // beneath it are all addressable. The dashboard route joins segments.
  "admin-users": "admin",
  "admin-roles": "admin/roles",
  "admin-clients": "admin/clients",
  // The URL /dashboard/audit already answered, from a static segment that drew
  // the log with no sidebar around it. The route is kept exactly; what changed
  // is that it now resolves through the shell like every other section, so the
  // person reading it can get back out.
  audit: "audit",
  /*
   * A route of its own rather than a link into /dashboard/account/trash: the
   * account area is a different shell with a different rail, and a sidebar item
   * that throws the reader out of the portal is how the bin got lost the first
   * time. Both URLs answer, and both render the one panel.
   */
  "recycle-bin": "recycle-bin",
};

const routeSections: Record<string, Section> = Object.fromEntries(
  Object.entries(sectionRoutes).map(([section, route]) => [
    route,
    section as Section,
  ]),
) as Record<string, Section>;

/**
 * Everything the sidebar is allowed to offer — the catalogue.
 *
 * Membership comes from `Object.keys(sectionMeta)`, *not* from `navPrimary` and
 * `navSecondary`, and that difference is the point of the whole stage. Another
 * team adding a section adds it to `sectionMeta` and `sectionRoutes`; it then
 * appears in every person's sidebar with nobody's saved layout migrated,
 * because a saved layout records *arrangement* while this records *existence*.
 * Forgetting to also list it in `navPrimary` costs it a position — it lands at
 * the end of "Workspace" — and never costs it a nav item.
 *
 * The two checks below are the 404 guard: no label without a destination. A
 * key with a `sectionMeta` entry but no route would render a nav item that goes
 * nowhere, which is precisely what "Add must not invent a destination" forbids.
 */
const builtInNavCatalogue: SidebarNavEntry[] = (() => {
  const placed = new Map<string, string>([
    ...navPrimary.map((key) => [key, "group:operations"] as const),
    ...navSecondary.map((key) => [key, "group:workspace"] as const),
  ]);
  const ordered = [
    ...navPrimary,
    ...navSecondary,
    ...Object.keys(sectionMeta).filter((key) => !placed.has(key)),
  ];
  return ordered
    .filter(
      (key) => key in sectionMeta && sectionRoutes[key as Section] !== undefined,
    )
    .map((key) => ({
      key,
      label: sectionMeta[key as Section].label,
      icon: sectionMeta[key as Section].icon,
      // A section nobody placed lands under "Workspace", where "Team" and the
      // administrative screens already live.
      group: placed.get(key) ?? "group:workspace",
    }));
})();

/**
 * A section this workspace added for itself — Stage 23.
 *
 * `surface` is the key of a BUILT-IN section, and it is what the screen area
 * renders. That is the whole of "adding a section must not invent a
 * destination": a workspace section can only ever point at something this file
 * already draws. The filter below re-checks it here rather than trusting the
 * server, because this file is the only thing that knows what it can render.
 */
type WorkspaceSectionEntry = {
  key: string;
  label: string;
  icon: IconName;
  surface: Section;
  group: string;
};

/*
 * The dashboard's dates, through the shared formatter.
 *
 * Same two forms this always produced — "24 Nov 2026" and "24 Nov 2026, 14:05"
 * — but named in one place rather than assembled from `Intl` options here.
 * The zone is pinned to Europe/London because these are timestamps on work
 * orders and the estate is in the UK; a date-only value never reaches `Date`
 * at all, which is what stops it shifting a day. See app/lib/format-date.ts.
 */
function formatDate(value: string | null, includeTime = false) {
  return includeTime
    ? formatShortDateTime(value, { timeZone: "Europe/London" })
    : formatShortDate(value, { timeZone: "Europe/London" });
}

function formatMoney(value: number | null) {
  if (value === null) return "Not quoted";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(value);
}

function useCurrentTime() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/*
 * Scroll lock for overlays.
 *
 * WHAT WAS WRONG: nothing stopped the page behind a drawer from scrolling.
 * With the job drawer open on /dashboard/jobs at 390x844 — a fixed, full-
 * screen 390x844 panel over a full-viewport scrim — `body` computed
 * `overflow: visible` and the document was 90,120px tall. Scrolling moved the
 * list underneath the drawer; closing it left you ~1,400px from where you
 * started, in a list 107 screens long. The nav drawer behaved the same way,
 * and its scrim, despite covering the whole viewport, prevented nothing: a
 * scrim only swallows clicks, it does not stop a touch-drag or inertial
 * scroll from reaching the scroller behind it.
 *
 * WHY THIS IS RIGHT: the lock is a shared counter, not a per-overlay flag.
 * Two overlays can be open at once (the nav drawer over a board that already
 * has a drawer open), and with independent flags whichever closed first would
 * unlock the page while the other was still up, and would restore ITS saved
 * scroll position over the other's. Counting means the page unlocks once, on
 * the last close, and the offset is captured once, on the first open.
 *
 * `position: fixed` rather than `overflow: hidden` alone: on iOS Safari —
 * every engineer standing in a shop — `overflow: hidden` on the body is not
 * reliably honoured for touch scrolling, and taking the body out of flow is
 * the technique that actually holds. Because that collapses the scroll
 * position to 0, the offset is re-applied as a negative `top` so the page does
 * not visibly jump, then restored on release. The restore is explicitly
 * `instant`: `html` carries `scroll-behavior: smooth` (globals.css), so a
 * default-behaviour restore would animate 90,000px back into place.
 */
function useScrollLock(active: boolean) {
  // The counter itself now lives in overlay/scroll-lock.ts, where the shared
  // popover primitive can take the same lock; this name is kept so the three
  // call sites below read as they always have.
  useBodyScrollLock(active);
}

/**
 * Who an event is attributed to.
 *
 * A cell change from `item_activity` carries a display NAME rather than an
 * email — that is what `item_activity.actor_name` holds — so it is read from
 * the detail rather than being derived from an address that is not there. Both
 * halves of the merged history therefore name somebody; before this, the cell
 * changes had no reader at all.
 */
function activityActor(email: string | null, detail?: Record<string, unknown>) {
  const named = typeof detail?.actorName === "string" ? detail.actorName.trim() : "";
  if (named) return named;
  if (!email) return "Operations team";
  if (email === "public-form") return "Request form";
  const localPart = email.split("@")[0] || email;
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function activityDescription(entry: RequestActivityEntry) {
  /*
   * A per-cell change, from `item_activity` — the one store in this system
   * that records WHICH COLUMN moved and what it held on either side.
   * `activity_log` has no column field, so "Priority went from Low to Urgent"
   * was recorded and unreadable until this history merged the two. See the note
   * at the merge in app/api/maintenance/route.ts.
   */
  if (entry.action === "column.value_changed") {
    const column = typeof entry.detail.column === "string" ? entry.detail.column : "a column";
    const from = typeof entry.detail.from === "string" ? entry.detail.from.trim() : "";
    const to = typeof entry.detail.to === "string" ? entry.detail.to.trim() : "";
    if (!from && to) return `set ${column} to "${to}".`;
    if (from && !to) return `cleared ${column}.`;
    if (from && to) return `changed ${column} from "${from}" to "${to}".`;
    return `changed ${column}.`;
  }
  if (entry.action.startsWith("item.")) {
    // duplicated / created / moved / archived, from the same store.
    return `${entry.action.slice("item.".length).replace(/_/g, " ")} this item.`;
  }
  if (entry.action === "request.created") return "created this request.";
  if (entry.action === "request.note_added") return "added an update.";
  if (entry.action === "request.stage_changed") {
    const stage =
      typeof entry.detail.stage === "string" ? entry.detail.stage : "workflow";
    return `moved the request to ${stage}.`;
  }
  if (entry.action === "request.fields_changed") {
    return "updated the request details.";
  }
  if (entry.action.includes("file") || entry.action.includes("attachment")) {
    return "updated the request files.";
  }
  return "updated this request.";
}

async function fetchRequestActivities(requestId: string) {
  const response = await fetch(
    `/api/maintenance?id=${encodeURIComponent(requestId)}`,
    { headers: { Accept: "application/json" } },
  );
  const payload = (await response.json()) as {
    activities?: RequestActivityEntry[];
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || "The update history could not be loaded.");
  }
  return payload.activities ?? [];
}

function priorityClass(priority: Priority) {
  return `priority priority--${priority.toLowerCase()}`;
}

function stageLabel(stage: RequestStage) {
  return {
    Incoming: "Incoming requests",
    Booked: "Jobs booked",
    Attention: "Needs attention",
    Completed: "Recently completed",
  }[stage];
}

function stageIcon(stage: RequestStage): IconName {
  if (stage === "Completed") return "check";
  if (stage === "Attention") return "alert";
  if (stage === "Booked") return "calendar";
  return "inbox";
}

function notificationCandidates(requests: MaintenanceRequest[]) {
  return requests.filter(
    (request) =>
      isOpenRequest(request) &&
      (request.stage === "Attention" || request.priority === "Urgent"),
  );
}

function complianceTone(state: ComplianceState) {
  return `compliance-pill compliance-pill--${state
    .toLowerCase()
    .replaceAll(" ", "-")}`;
}


function downloadCsv(requests: MaintenanceRequest[]) {
  const columns: (keyof MaintenanceRequest)[] = [
    "id",
    "title",
    "location",
    "priority",
    "stage",
    "status",
    "engineer",
    "contractor",
    "assignee",
    "requestedAt",
    "dueAt",
    "cost",
  ];
  const escapeCell = (value: unknown) =>
    `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [
    columns.join(","),
    ...requests.map((request) =>
      columns.map((column) => escapeCell(request[column])).join(","),
    ),
  ].join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  link.download = `maintsupp-maintenance-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function downloadTableCsv(
  filename: string,
  headers: string[],
  rows: Array<Array<string | number | null>>,
) {
  const escapeCell = (value: unknown) =>
    `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [headers, ...rows]
    .map((row) => row.map(escapeCell).join(","))
    .join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  link.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function portfolioOptions(storeRows: StoreRecord[]) {
  return [
    { value: "all", label: "All portfolios" },
    ...storeRows
      .filter((store) => store.lifecycle === "Current")
      .map((store) => ({ value: store.id, label: store.name })),
  ];
}

/*
 * `monthlySpendSeries` and `requestTrend` were deleted here, not moved.
 *
 * Both built their own window from `new Date()` and never saw the period
 * control: the series was always the last N calendar months, and the trend was
 * always twelve fixed seven-day buckets ending now. On any period older than 84
 * days every sparkline on the screen was a flat line at zero underneath a
 * number in the thousands, and on "March 2026" the spend chart drew five months
 * that could not contain a row.
 *
 * `periodSpendSeries` and `periodTrend` in period-model.ts replace them and
 * take the period as an argument, so a caller cannot forget to pass it.
 */

function requestAgeDays(request: MaintenanceRequest, now: number) {
  return Math.max(
    0,
    Math.floor((now - new Date(request.requestedAt).getTime()) / 86_400_000),
  );
}

/**
 * When a due date stops being a promise and starts being a breach.
 *
 * A due date with a time is an instant, and it is overdue the moment that
 * instant passes — a four-hour SLA due at 09:00 is late at 09:01. A BARE date
 * ("2026-08-25", which is what the monday import writes) means the whole day:
 * the job is not overdue until the day is over. The old test —
 * `new Date(dueAt) < now` — read a bare date as UTC midnight, which flagged a
 * job "overdue" during the very day it was due, at an hour that depended on
 * the reader's timezone. `parseStamp` reads the naive forms as local wall
 * clock, the same doctrine the whole period model follows.
 */
function duePassed(dueAt: string, now: number) {
  const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(dueAt.trim());
  const stamp = bareDate ? endOfDay(parseStamp(dueAt)) : parseStamp(dueAt);
  return Number.isFinite(stamp) && stamp < now;
}

/**
 * The overview's open-jobs donut.
 *
 * Every arm of this used to sniff a substring, and `dashboard-meters.ts`
 * already documents at length why that cannot be made safe: `includes("part")`
 * matches "Third Par-t-y Delay", and on the live board that single false
 * positive WAS the whole "Awaiting parts" figure. The meters above the board
 * were fixed; this donut kept the old approach, so the same workspace answered
 * the same question two different ways on two screens.
 *
 * Measured on the live data before this change: "On hold" swallowed 54 of 59
 * open jobs — `includes("waiting")` matches "A-waiting Access" and four more —
 * while "Scheduled" and "In progress" both read 0 against true counts of 9
 * and 6.
 *
 * Labels are now named whole, from the same capture the meters use. The
 * `stage` fallbacks are kept: stage is the app's own lifecycle field and is
 * not a monday label, so it is not a guess.
 */
function jobStatusSegments(requests: MaintenanceRequest[]): DonutSegment[] {
  const open = requests.filter(isOpenRequest);
  const normalise = (value: string) =>
    value.trim().toLowerCase().replace(/\s+/g, " ");
  const inSet = (labels: readonly string[]) => {
    const wanted = new Set(labels.map(normalise));
    return (status: string) => wanted.has(normalise(status));
  };

  // Named from db/monday-export/MAINTENANCE-MONDAY-CAPTURE.md, the same source
  // dashboard-meters.ts reads. Adding a label in monday must be a deliberate
  // change here, not a silent shift in what a segment means.
  const isAwaitingParts = inSet(awaitingPartsStatuses);
  const isOnHold = inSet([
    ...awaitingApprovalStatuses,
    "Awaiting Landlord Approval",
    "Health And Safety Hold",
    "Waiting for payment",
    "Waiting for decisions",
    "Awaiting Access",
    "Third Party Delay",
    "Blocked - Awaiting Response",
  ]);
  const isScheduled = inSet(["Job Scheduled", "Pending Scheduling"]);
  const isInProgress = inSet(["Job In Progress", "Escalated", "Major works"]);

  const classify = (request: MaintenanceRequest) => {
    const status = request.status ?? "";
    if (isAwaitingParts(status)) return "Awaiting parts";
    if (isOnHold(status)) return "On hold";
    if (isScheduled(status) || request.stage === "Booked") return "Scheduled";
    if (isInProgress(status) || request.stage === "Attention") return "In progress";
    return "Open";
  };
  const palette: Record<string, string> = {
    Open: "#12b4a8",
    "In progress": "#f26a21",
    "Awaiting parts": "#f0a91f",
    "On hold": "#5c82af",
    Scheduled: "#55b878",
  };
  return Object.keys(palette).map((label) => ({
    label,
    value: open.filter((request) => classify(request) === label).length,
    color: palette[label],
  }));
}

function downloadFileRegister(files: FileRecord[]) {
  const columns: (keyof FileRecord)[] = [
    "id",
    "name",
    "kind",
    "site",
    "requestId",
    "uploadedAt",
    "size",
    "status",
  ];
  const escapeCell = (value: unknown) =>
    `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [
    columns.join(","),
    ...files.map((file) =>
      columns.map((column) => escapeCell(file[column])).join(","),
    ),
  ].join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  link.download = `maintsupp-document-register-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export default function PortalApp({
  userName,
  userEmail,
  initialSection = "overview",
}: {
  userName: string;
  userEmail: string;
  /*
   * A string, not a `Section`: `/dashboard/s/<slug>` resolves to a workspace
   * section key, which is not in the union by construction.
   */
  initialSection?: Section | string;
}) {
  const [activeSection, setActiveSection] = useState<string>(initialSection);
  const [workspaceSections, setWorkspaceSections] = useState<
    WorkspaceSectionEntry[]
  >([]);
  const [requests, setRequests] =
    useState<MaintenanceRequest[]>([]);
  const requestsRef = useRef(requests);
  const [selectedRequest, setSelectedRequest] =
    useState<MaintenanceRequest | null>(null);
  const [drawerInitialTab, setDrawerInitialTab] =
    useState<RequestDrawerTab>("updates");
  const [showCreateRequest, setShowCreateRequest] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  /*
   * The nav drawer and the create-request modal are the two overlays the shell
   * owns; the job drawer takes its own lock where it mounts. All three go
   * through the same counter, so opening the nav over an open job drawer and
   * closing it again leaves the page still locked and still in place.
   */
  useScrollLock(mobileNavOpen);
  useScrollLock(showCreateRequest);
  /*
   * Whether the topbar is on a phone, and therefore whether `.page-identity`
   * ships at all. See the block that renders it for the reasoning; this is
   * `matchMedia` rather than a CSS rule because the point is not to hide the
   * title but not to have one.
   *
   * 768 is the dashboard's own phone breakpoint, matched to the touch-target
   * block in brand-overrides.css so the title leaves exactly when the controls
   * grow into the space it was holding.
   *
   * The first paint renders it and the effect removes it, which is the same
   * shape as `isMobile` in live-board.tsx and for the same reason: this is a
   * client component that is still server-rendered, and a server has no
   * viewport to ask. The cost is one relayout of a row that is already
   * relaying out as the board's data arrives.
   */
  const [narrowTopbar, setNarrowTopbar] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 768px)");
    const sync = () => setNarrowTopbar(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  /*
   * The board's "⋯ › Notifications" item lives in board-actions, which does
   * not own this state, so it asks for the panel by event rather than by
   * pressing the top-bar button on the user's behalf.
   */
  useEffect(() => {
    const open = () => setNotificationsOpen(true);
    window.addEventListener("maintsupp:open-notifications", open);
    return () => window.removeEventListener("maintsupp:open-notifications", open);
  }, []);
  const notificationsButtonRef = useRef<HTMLButtonElement | null>(null);
  /* The open board's item verbs, for the drawer's "⋮" — overlay/item-actions.tsx. */
  const [boardItemActions, setBoardItemActions] = useState<BoardItemActions | null>(null);
  const [notificationStates, setNotificationStates] = useState<
    Record<string, NotificationState>
  >({});
  const [toast, setToast] = useState<string | null>(null);
  /*
   * "loading" is the honest starting state, and it used to be "sample" — which
   * was accurate only because sample data was on screen.
   */
  const [dataMode, setDataMode] = useState<"live" | "loading" | "unavailable">(
    "loading",
  );
  const [demoRole, setDemoRole] = useState<DemoRole>("super_admin");
  const [runtimeContext, setRuntimeContext] =
    useState<RuntimeWorkspaceContext | null>(null);
  const [contextBusy, setContextBusy] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceManager, setWorkspaceManager] =
    useState<WorkspaceManagerState | null>(null);
  const [documents, setDocuments] = useState<FileRecord[]>([]);
  const [boardSnapshot, setBoardSnapshot] =
    useState<MaintenanceBoardSnapshot | null>(null);

  /*
   * Before anything fetches. Every loader below is a request that can discover
   * the session has ended, and this is what turns that discovery into a trip to
   * the sign-in page instead of a screen full of error text.
   */
  useEffect(() => {
    installSessionGuard();
  }, []);

  /*
   * The theme is NOT written here any more.
   *
   * This effect used to set `body.dataset.theme = "dark"` unconditionally on
   * mount and delete the attribute on unmount. It ran after the toggle had
   * applied the stored choice, so a light preference was overwritten with dark
   * on every mount and then corrected a tick later; the cleanup dropped `body`
   * out of both theme blocks entirely. Its intent — "the shell must always have
   * a theme attribute" — is now met before first paint by the boot script in
   * app/(app)/layout.tsx, and kept in step by `useAppliedTheme` in the toggle.
   */

  useEffect(() => {
    requestsRef.current = requests;
  }, [requests]);

  const loadRuntimeContext = useCallback(async () => {
    const response = await fetch("/api/context", {
      headers: { Accept: "application/json" },
    });
    const payload = (await response.json()) as {
      context?: RuntimeWorkspaceContext;
      error?: string;
    };
    if (!response.ok || !payload.context) {
      throw new Error(payload.error || "The client workspace could not be loaded.");
    }
    setRuntimeContext(payload.context);
    setDemoRole(payload.context.actor.role);
    return payload.context;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadRuntimeContext().catch((error: unknown) => {
        setToast(error instanceof Error ? error.message : "The client workspace could not be loaded.");
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadRuntimeContext]);

  const changeDemoRole = async (role: DemoRole) => {
    setContextBusy(true);
    try {
      const response = await fetch("/api/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_role", role }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "The test role could not be changed.");
      window.location.reload();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The test role could not be changed.");
      setContextBusy(false);
    }
  };

  const changeOrganisation = async (organisationId: string) => {
    if (demoRole !== "super_admin") return;
    setContextBusy(true);
    try {
      const response = await fetch("/api/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "select_organisation", organisationId }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "The client workspace could not be selected.");
      window.location.reload();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The client workspace could not be selected.");
      setContextBusy(false);
    }
  };

  const createOrganisation = async () => {
    if (demoRole !== "super_admin") return;
    const name = window.prompt("Enter the client or organisation name:")?.trim();
    if (!name) return;
    setContextBusy(true);
    try {
      const response = await fetch("/api/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create_organisation", name }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "The client workspace could not be created.");
      window.location.reload();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The client workspace could not be created.");
      setContextBusy(false);
    }
  };

  const loadWorkspace = useCallback(async () => {
    const response = await fetch("/api/workspace", {
      headers: { Accept: "application/json" },
    });
    const payload = (await response.json()) as {
      workspace?: WorkspaceSnapshot;
      error?: string;
    };
    if (!response.ok || !payload.workspace) {
      throw new Error(payload.error || "The shared workspace could not be loaded.");
    }
    setWorkspace(payload.workspace);
    /*
     * Deliberately NOT `setDataMode("live")`.
     *
     * The chip describes the JOBS on screen, because that is what every figure
     * on every dashboard is computed from. The workspace fetch carries sites,
     * contractors and settings — it succeeding says nothing about whether the
     * job list did, and stamping "live" here painted "Live workspace" over a
     * failed jobs load. Proven: with `/api/maintenance` failing and everything
     * else healthy, the screen still claimed to be live.
     */
    return payload.workspace;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadWorkspace().catch(() => undefined);
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [loadWorkspace]);

  useEffect(() => {
    let active = true;
    async function loadDocuments() {
      try {
        const response = await fetch("/api/files?limit=100", {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          files?: Array<{
            id: string;
            requestId: string | null;
            kind: string;
            originalName: string;
            byteSize: number;
            createdAt: string;
            contentType?: string;
            inlineUrl?: string;
            downloadUrl?: string;
          }>;
        };
        if (!active || !payload.files) return;
        const liveFiles: FileRecord[] = payload.files.map((file) => ({
          id: file.id,
          name: file.originalName,
          kind:
            file.kind === "completion"
              ? "Completion evidence"
              : file.kind === "issue"
                ? "Issue evidence"
                : "Workspace document",
          site:
            requestsRef.current.find((item) => item.id === file.requestId)?.location ??
            "Shared workspace",
          requestId: file.requestId,
          uploadedAt: file.createdAt,
          size: formatFileSize(file.byteSize),
          status: "Current",
          inlineUrl: file.inlineUrl,
          downloadUrl: file.downloadUrl,
          contentType: file.contentType,
        }));
        setDocuments(liveFiles);
      } catch {
        /*
         * The register stays empty rather than falling back to the bundled
         * files. A document list is read to answer "do we hold the certificate"
         * — the one question a stand-in answers wrongly, and confidently.
         */
        if (active) setDocuments([]);
      }
    }
    loadDocuments();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const syncSectionFromHistory = () => {
      const slug = window.location.pathname.split("/").filter(Boolean)[1] ?? "";
      setActiveSection(routeSections[slug] ?? "overview");
      setMobileNavOpen(false);
    };
    window.addEventListener("popstate", syncSectionFromHistory);
    return () => window.removeEventListener("popstate", syncSectionFromHistory);
  }, []);

  /*
   * Bumped to re-run the load below without a page reload.
   *
   * The figures on every dashboard come from one fetch of `/api/maintenance`
   * that ran once on mount, so a job closed on someone else's screen stayed
   * open on this one until the tab was reloaded — and nothing on screen said
   * how old the numbers were. A counter is enough to re-enter the effect; the
   * effect already owns the paging and the failure handling, so nothing about
   * how the data is fetched is duplicated here.
   */
  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  /** When the figures on screen were last successfully read. Null until then. */
  const [dataUpdatedAt, setDataUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    let active = true;
    async function loadRequests() {
      /*
       * Every page of the board, not just the first.
       *
       * `/api/maintenance` was paged in Stage 16 after a bare `.limit(250)` made
       * the board show 250 of 744 jobs while every total agreed with every other
       * total. The server side was fixed; this caller was not — it asked for no
       * limit, took the default 1000, and never read `hasMore`. Past 1000 jobs
       * the dashboards would have gone quietly wrong in exactly the same way,
       * and the oldest work — the overdue backlog — is what falls off the end.
       */
      try {
        const collected: MaintenanceRequest[] = [];
        let offset = 0;
        for (;;) {
          const response = await fetch(
            `/api/maintenance?limit=1000&offset=${offset}`,
            { headers: { Accept: "application/json" } },
          );
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = (await response.json()) as {
            requests?: MaintenanceRequest[];
            hasMore?: boolean;
            nextOffset?: number | null;
          };
          if (!active) return;
          collected.push(...(payload.requests ?? []));
          if (!payload.hasMore || typeof payload.nextOffset !== "number") break;
          offset = payload.nextOffset;
        }
        if (active) {
          setRequests(collected);
          setDataMode("live");
          // Stamped only on success, so the time on screen is when the figures
          // were last actually read — not when someone last pressed the button.
          setDataUpdatedAt(new Date());
        }
      } catch {
        /*
         * Say so, and show nothing.
         *
         * Two rounds of this. First the chip said "Loading workspace" for ever,
         * so a 503 from D1 presented `mock-data.ts` as the customer's own
         * figures. Then the chip was made honest — but the invented rows stayed
         * underneath it, and every dashboard on the screen went on computing
         * spend, compliance and SLA from them. The rows are gone now: the state
         * starts empty and a failure leaves it empty.
         */
        if (active) {
          setRequests([]);
          setDataMode("unavailable");
        }
      } finally {
        if (active) setRefreshing(false);
      }
    }
    loadRequests();
    return () => {
      active = false;
    };
  }, [refreshToken]);

  useEffect(() => {
    let active = true;

    async function loadNotificationStates() {
      try {
        const response = await fetch("/api/notifications", {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          states?: NotificationStateEntry[];
        };
        if (!active) return;
        setNotificationStates(
          Object.fromEntries(
            (payload.states ?? []).map((entry) => [
              entry.requestId,
              entry.state,
            ]),
          ),
        );
      } catch {
        // The notification panel remains usable if preferences cannot load.
      }
    }

    loadNotificationStates();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const saveWorkspaceRecord = async (
    entity: ManagerTab | "settings",
    id: string | null,
    data: Record<string, unknown>,
  ) => {
    if (entity === "activity") return;
    setWorkspaceBusy(true);
    try {
      const response = await fetch("/api/workspace", {
        method: id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity, id, data }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "The shared record could not be saved.");
      }
      await loadWorkspace();
      setToast("Shared workspace updated. Dashboard totals have been refreshed.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The shared record could not be saved.");
      throw error;
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const archiveWorkspaceRecord = async (entity: ManagerTab, id: string) => {
    if (entity === "activity") return;
    setWorkspaceBusy(true);
    try {
      const response = await fetch("/api/workspace", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity, id }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "The record could not be archived.");
      }
      await loadWorkspace();
      setToast("Record archived. Its history remains available.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The record could not be archived.");
      throw error;
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const openWorkspaceManager = (tab?: ManagerTab, recordId?: string | null) => {
    const fallbackTab = managerTabBySection[activeSurface] ?? "site";
    setWorkspaceManager({ tab: tab ?? fallbackTab, recordId });
  };

  /*
   * `/dashboard?manage=import` — how the avatar menu's "Import data" reaches
   * the importer from the account screens, which have no manager to open.
   * monday's own item opens the importer in place; this is the same landing,
   * arrived at by URL. The parameter is stripped once consumed so a refresh
   * does not reopen it.
   */
  useEffect(() => {
    if (!workspace) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("manage") !== "import") return;
    // Deferred through a timer like every other load in this file, so the
    // manager opens on a later tick rather than cascading a render.
    const timer = window.setTimeout(() => {
      setWorkspaceManager({ tab: "import", recordId: null });
      params.delete("manage");
      const query = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}`,
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [workspace]);

  /* No fallback: an unreadable workspace has no sites, and saying so beats
     drawing somebody else's estate. */
  const currentStores = workspace?.stores ?? [];
  const currentUnits = workspace?.units ?? [];
  const currentContractors = workspace?.contractors ?? [];
  const currentPlanned = workspace?.planned ?? [];
  const currentTeam = workspace?.team ?? [];
  const currentSettings = workspace?.settings ?? defaultWorkspaceSettings;
  const displayUserName = runtimeContext?.actor.displayName ?? userName;
  const displayUserEmail = runtimeContext?.actor.email ?? userEmail;

  /*
   * The workspace's own sections.
   *
   * `/api/navigation` returns them beside the arrangement, so the catalogue is
   * complete in one request rather than one paint late. Deferred by a
   * zero-delay timer like every other loader here, and a failed load leaves the
   * built-in sidebar standing — it is already on screen.
   */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/navigation", {
            headers: { Accept: "application/json" },
          });
          if (!response.ok) return;
          const payload = (await response.json()) as {
            sections?: WorkspaceSectionEntry[];
          };
          setWorkspaceSections(
            (payload.sections ?? []).filter(
              (entry) =>
                entry.surface in sectionMeta &&
                sectionRoutes[entry.surface] !== undefined,
            ),
          );
        } catch {
          // Built-in catalogue only. Nothing disappears; nothing 404s.
        }
      })();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  /*
   * What may appear in the sidebar: what the product ships, then what this
   * workspace added. Existence, never arrangement — the merge in
   * `app/api/navigation/layout.ts` still decides order and visibility.
   */
  const navCatalogue = useMemo<SidebarNavEntry[]>(
    () =>
      [
        ...builtInNavCatalogue,
        ...workspaceSections.map((entry) => ({
          key: entry.key,
          label: entry.label,
          icon: entry.icon,
          group: entry.group,
        })),
      ].filter((entry) => {
        /*
         * The audit trail is the one built-in section whose EXISTENCE is
         * decided by a capability rather than only its contents.
         *
         * Every other administration screen is listed for everybody and
         * refuses on its own — which is right for Users and Roles, where a
         * client seeing the entry and being told no is merely tidy. An
         * organisation-wide record of who did what is different: the fact that
         * one exists, and where it is, is not something to advertise to a role
         * that may not read it. `audit.read` is the same capability
         * /api/audit enforces, so the entry and the answer cannot disagree.
         *
         * `undefined` while the context loads, which keeps the item out until
         * the answer arrives rather than flashing it and taking it away.
         */
        if (entry.key === "recycle-bin") {
          /*
           * Listed for whoever can RESTORE, which is `board.edit`.
           *
           * Reading the bin only needs `board.view`, so a client can open it —
           * and /api/trash tells the screen so, which is why the buttons it
           * cannot use are not drawn. But a sidebar entry is a promise that
           * there is something to do behind it, and for a client there is not:
           * they can neither restore nor purge. The screen stays reachable by
           * URL for anyone who may read it; the nav item is for whoever the bin
           * is actually FOR.
           */
          return runtimeContext?.capabilities?.["board.edit"] === true;
        }
        if (entry.key !== "audit") return true;
        return runtimeContext?.capabilities?.["audit.read"] === true;
      }),
    [runtimeContext, workspaceSections],
  );

  /*
   * Which built-in screen is on. For a workspace section that is the surface it
   * names; for a built-in section it is the section itself. A key that resolves
   * to neither — a bookmark to a section since archived — falls back to
   * Overview rather than rendering a blank page.
   */
  const activeCustom =
    workspaceSections.find((entry) => entry.key === activeSection) ?? null;
  const rawSurface = activeCustom ? activeCustom.surface : activeSection;
  const activeSurface: Section = (
    rawSurface in sectionMeta ? rawSurface : "overview"
  ) as Section;

  const setSection = (section: string) => {
    setActiveSection(section);
    setMobileNavOpen(false);
    /*
     * `s/` namespaces a workspace section's URL so it can never take a route a
     * built-in section owns, now or in a later release.
     */
    const route =
      sectionRoutes[section as Section] ??
      (section.startsWith("section:")
        ? `s/${section.slice("section:".length)}`
        : "");
    window.history.pushState({}, "", route ? `/dashboard/${route}` : "/dashboard");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const openRequest = (
    request: MaintenanceRequest,
    tab: RequestDrawerTab = "updates",
  ) => {
    setDrawerInitialTab(tab);
    setSelectedRequest(request);
  };

  const createRequest = async (
    draft: CreateRequestDraft,
    attachments: File[],
  ) => {
    const response = await fetch("/api/maintenance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(payload.error || "The request could not be saved.");
    }

    const payload = (await response.json()) as {
      request: MaintenanceRequest;
    };
    let created = payload.request;
    const failedUploads: string[] = [];

    if (attachments.length) {
      for (const file of attachments) {
        try {
          const uploadPayload = await uploadEvidenceFile({
            file,
            requestId: created.id,
            kind: "issue",
          });
          if (uploadPayload.request) {
            created = uploadPayload.request;
          }
        } catch (caught) {
          failedUploads.push(
            caught instanceof Error
              ? caught.message
              : `Could not upload ${file.name}.`,
          );
        }
      }
    }

    setRequests((current) => [created, ...current]);
    setDataMode("live");
    setShowCreateRequest(false);
    setToast(
      failedUploads.length
        ? `${created.id} was created. ${failedUploads.length} file${failedUploads.length === 1 ? "" : "s"} could not be uploaded.`
        : `${created.id} has been created and routed to triage.`,
    );
    openRequest(created);
  };

  const persistRequestUpdate = async (
    id: string,
    update: {
      stage?: RequestStage;
      note?: string;
      fields?: Record<string, string | number | null>;
    },
  ) => {
    const response = await fetch("/api/maintenance", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...update }),
    });
    const payload = (await response.json()) as {
      request?: MaintenanceRequest;
      error?: string;
    };
    if (!response.ok || !payload.request) {
      throw new Error(payload.error || "The update could not be saved.");
    }
    const updated = payload.request;
    setRequests((current) =>
      current.map((request) => (request.id === id ? updated : request)),
    );
    setSelectedRequest((current) => (current?.id === id ? updated : current));
    setDataMode("live");
    return updated;
  };

  const persistBoardCell = async (
    requestId: string,
    column: MaintenanceBoardColumn,
    value: string | number | boolean | { start: string; end: string },
  ) => {
    const response = await fetch("/api/board", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_cell",
        requestId,
        columnId: column.id,
        value,
      }),
    });
    const payload = (await response.json()) as {
      cell?: { requestId: string; columnId: string; value: string };
      error?: string;
    };
    if (!response.ok || !payload.cell) {
      throw new Error(payload.error || "The column value could not be saved.");
    }
    const key = `${requestId}::${column.id}`;
    setBoardSnapshot((current) =>
      current
        ? {
            ...current,
            cellValues: {
              ...current.cellValues,
              [key]: payload.cell!.value,
            },
          }
        : current,
    );
    window.dispatchEvent(new Event("maintsupp:refresh-board"));
    return payload.cell.value;
  };

  /*
   * ── Moving a date from the calendar ──────────────────────────────────────
   *
   * Two handlers because there are two systems behind the grid, and one screen
   * pretending otherwise is how a shadow copy gets created. Both go through the
   * SAME routes the board and the drawer use, so a calendar edit produces the
   * same activity row, fires the same automations and is refused by the same
   * capability check as an edit made anywhere else.
   *
   * Both are optimistic and both roll back. A date that appears to move and
   * then silently does not is the worst outcome available here: the operator
   * leaves believing the job was rescheduled.
   */
  const changeJobDate = async (
    id: string,
    field: "dueAt" | "requestedAt" | "completedAt" | "nextUpdateAt",
    day: string | null,
  ) => {
    const before = requestsRef.current.find((request) => request.id === id);
    if (!before) throw new Error("That job is no longer on this workspace.");
    /* The wire format is the field's own: `optionalIsoDate` in
       app/lib/request-fields.ts turns `YYYY-MM-DD` into the UTC instant the
       column holds, which is exactly what the board writes for the same
       field. */
    const optimistic = { ...before, [field]: day ? `${day}T00:00:00.000Z` : null };
    setRequests((current) =>
      current.map((request) => (request.id === id ? optimistic : request)),
    );
    setSelectedRequest((current) => (current?.id === id ? optimistic : current));
    try {
      await persistRequestUpdate(id, { fields: { [field]: day } });
      window.dispatchEvent(new Event("maintsupp:refresh-board"));
    } catch (error) {
      setRequests((current) =>
        current.map((request) => (request.id === id ? before : request)),
      );
      setSelectedRequest((current) => (current?.id === id ? before : current));
      throw error;
    }
  };

  const changeComplianceDate = async (
    target: CalendarWriteTarget,
    day: string,
  ) => {
    if (target.path === "board-cell") {
      /*
       * A certificate expiry read off the Store Documentation board goes back
       * INTO that board cell. Writing the `compliance_documents` copy instead
       * would look correct until the next read: `readComplianceRegister`
       * recomputes state from the board cell, so the edit would vanish on
       * refresh with nothing to explain it.
       */
      const response = await fetch(
        `/api/board?board=${encodeURIComponent(target.boardId)}`,
        {
          /*
           * PATCH, not POST. `/api/board` splits its actions across two
           * handlers — POST creates and deletes, PATCH edits — and
           * `update_cell` is on the PATCH side, exactly where
           * `persistBoardCell` above already sends it. Sent as POST it comes
           * back 400 "Unknown board action", which is what this did until a
           * real certificate was moved on a real board and did not move.
           */
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update_cell",
            requestId: target.requestId,
            columnId: target.columnId,
            value: day,
          }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "That expiry could not be saved.");
      }
    } else if (target.path === "workspace-compliance") {
      /* A register-only record has no board cell, so the register row IS the
         record. The PATCH replaces site, requirement and state along with the
         date, so all three go back unchanged — see `CalendarWriteTarget`. */
      const response = await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity: "compliance",
          id: target.id,
          data: {
            siteId: target.siteId,
            kind: target.kind,
            state: target.state,
            expiry: day,
          },
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "That expiry could not be saved.");
      }
    } else {
      throw new Error("That date cannot be changed here.");
    }
    /* The register is DERIVED, so there is nothing sensible to patch locally —
       state, RAG banding and the site rollup are all recomputed server-side.
       Re-read it, exactly as every other compliance write on this screen does. */
    await loadWorkspace();
  };

  const changeRequestStage = async (id: string, nextStage: RequestStage) => {
    const before = requests.find((request) => request.id === id);
    if (!before) return;
    const optimistic = { ...before, stage: nextStage };
    setRequests((current) =>
      current.map((request) => (request.id === id ? optimistic : request)),
    );
    setSelectedRequest((current) =>
      current?.id === id ? { ...current, stage: nextStage } : current,
    );
    try {
      await persistRequestUpdate(id, { stage: nextStage });
      setToast(`${id} moved to ${stageLabel(nextStage)}.`);
    } catch (caught) {
      setRequests((current) =>
        current.map((request) => (request.id === id ? before : request)),
      );
      setSelectedRequest((current) => (current?.id === id ? before : current));
      setToast(
        caught instanceof Error
          ? caught.message
          : "The workflow update could not be saved.",
      );
    }
  };

  /*
   * A comment goes to `item_updates`, which is where comments live.
   *
   * This used to call `persistRequestUpdate(id, { note })`, which incremented
   * `comment_count` and wrote the text into `activity_log` as an audit row —
   * so the app's own comments and monday's 218 imported ones sat in two
   * different tables, and the counter was whatever the last writer said. One
   * writer now, and `/api/updates` recomputes the count from a COUNT rather
   * than incrementing, so a re-import cannot silently zero it.
   */
  const addRequestNote = async (
    id: string,
    note: string,
    options: { parentId?: string | null; attachmentIds?: string[] } = {},
  ) => {
    const response = await fetch("/api/updates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: id,
        body: note,
        /*
         * A reply is a comment with a parent, and this is the only way to make
         * one. `/api/updates` has read `parentId` and validated it against the
         * job since the route was written, but the sole caller never sent it —
         * so the 47 replies imported from monday could be read and a 48th could
         * only be created by hand in SQL.
         */
        parentId: options.parentId ?? null,
        // Already uploaded by the composer; the route stamps `update_id` on
        // them so they belong to the comment rather than only to the job.
        attachmentIds: options.attachmentIds ?? [],
      }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      /*
       * Thrown, not swallowed.
       *
       * This used to `setToast(...)` and return normally, so the drawer's
       * `await onAddUpdate(...)` resolved, its catch never ran, and it cleared
       * the box and closed the composer — the caller's words gone, on a save
       * that had failed. The drawer already renders the message beside the
       * composer and keeps the draft; it only needs to be told.
       */
      throw new Error(payload.error ?? "That comment could not be saved.");
    }
    setToast("Comment added.");
    // The drawer holds its own copy of the thread, and the board holds the
    // count, so both are told rather than left to guess.
    window.dispatchEvent(new Event("maintsupp:refresh-board"));
  };

  const persistNotificationState = useCallback(
    async (requestIds: string[], state: NotificationState) => {
      if (!requestIds.length) return;

      try {
        const response = await fetch("/api/notifications", {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ requestIds, state }),
        });
        const payload = (await response.json()) as {
          states?: NotificationStateEntry[];
          error?: string;
        };
        if (!response.ok) {
          throw new Error(
            payload.error || "The notification could not be updated.",
          );
        }
        setNotificationStates(
          Object.fromEntries(
            (payload.states ?? []).map((entry) => [
              entry.requestId,
              entry.state,
            ]),
          ),
        );
      } catch (caught) {
        setToast(
          caught instanceof Error
            ? caught.message
            : "The notification could not be updated.",
        );
        throw caught;
      }
    },
    [],
  );

  /*
   * The screen's framing, under the workspace's own name for it. A section
   * called "CCTV" that draws the job board is titled CCTV, not "Live job list".
   */
  const surfaceMeta = sectionMeta[activeSurface];
  const meta = activeCustom
    ? { ...surfaceMeta, label: activeCustom.label, title: activeCustom.label }
    : surfaceMeta;
  const urgentCount = requests.filter(
    (request) =>
      request.priority === "Urgent" && isOpenRequest(request),
  ).length;
  const notificationItems = useMemo(
    () =>
      notificationCandidates(requests).filter(
        (request) => notificationStates[request.id] !== "dismissed",
      ),
    [notificationStates, requests],
  );
  const unreadNotificationCount = notificationItems.filter(
    (request) => notificationStates[request.id] !== "read",
  ).length;

  return (
    <div className="portal-shell">
      <aside
        className={`portal-sidebar${mobileNavOpen ? " portal-sidebar--open" : ""}`}
      >
        <div className="portal-sidebar__brand">
          {/* The logo goes home. It was inert, which meant the only way out of
              the dashboard was the browser's back button. */}
          <Link href="/" aria-label="MAINTSUPP home">
            <BrandMark />
          </Link>
          <button
            className="icon-button sidebar-close"
            type="button"
            onClick={() => setMobileNavOpen(false)}
            aria-label="Close navigation"
          >
            <Icon name="close" size={19} />
          </button>
        </div>

        <div className="workspace-switcher">
          <span className="workspace-icon">
            <Icon name="building" size={17} />
          </span>
          <span className="workspace-switcher__copy">
            <small>Workspace</small>
            {demoRole === "super_admin" ? (
              <select
                aria-label="Client workspace"
                value={runtimeContext?.currentOrganisation.id ?? ""}
                disabled={contextBusy || !runtimeContext}
                onChange={(event) => void changeOrganisation(event.target.value)}
              >
                {(runtimeContext?.organisations ?? []).map((organisation) => (
                  <option key={organisation.id} value={organisation.id}>
                    {organisation.name}
                  </option>
                ))}
              </select>
            ) : (
              <strong>{runtimeContext?.currentOrganisation.name ?? "Client workspace"}</strong>
            )}
          </span>
          {demoRole === "super_admin" && (
            <button
              className="workspace-switcher__add"
              type="button"
              aria-label="Add client workspace"
              title="Add client workspace"
              disabled={contextBusy}
              onClick={() => void createOrganisation()}
            >
              <Icon name="plus" size={16} />
            </button>
          )}
        </div>

        {/*
          Who you are reading this workspace as.

          The board itself looks identical whichever client you are — an empty
          board and a board you are not allowed to see render the same way — so
          without this the scoping is invisible and has to be taken on trust.
          The email is the identity the server actually resolved, not the label
          on the role selector, so if the two ever disagree it shows here.
        */}
        {runtimeContext?.identity && (
          <div className="workspace-identity">
            <span className="workspace-identity__email" title={runtimeContext.identity.email}>
              {runtimeContext.identity.email}
            </span>
            <span className="workspace-identity__scope">
              {runtimeContext.identity.crossOrganisation
                ? `Every workspace · ${runtimeContext.identity.organisationIds.length}`
                : "This workspace only"}
            </span>
          </div>
        )}

        {/*
          The super admin's "view on everything" — the one screen that names
          every client and what each holds. Served only to an actor the database
          says is a super admin; a client gets `tenantSummary: null` and this
          does not render, so it cannot leak another client's row counts.
        */}
        {runtimeContext?.tenantSummary && runtimeContext.tenantSummary.length > 1 && (
          <div className="workspace-tenants">
            <span className="nav-label">All clients</span>
            {runtimeContext.tenantSummary.map((tenant) => (
              <button
                key={tenant.id}
                type="button"
                className={
                  tenant.id === runtimeContext.currentOrganisation.id ? "is-active" : ""
                }
                disabled={contextBusy}
                onClick={() => void changeOrganisation(tenant.id)}
              >
                <span className="workspace-tenants__name">{tenant.name}</span>
                <span className="workspace-tenants__count">
                  {tenant.maintenanceRequests === 0 && tenant.sites === 0
                    ? "No data yet"
                    : `${tenant.maintenanceRequests} jobs · ${tenant.sites} sites`}
                </span>
              </button>
            ))}
          </div>
        )}

        {/*
          The sidebar, arranged by whoever is looking at it.

          What used to be two `.map`s over two constants is now a rendering of
          the layout `/api/navigation` resolves: this person's own arrangement
          over the workspace default over the built-in order. `navCatalogue` is
          what may appear; the stored layout only decides how. Nothing about the
          resting appearance changed — same pill, same 19px icon, same counts.
        */}
        <SidebarNav
          catalogue={navCatalogue}
          activeSection={activeSection}
          onSelect={(key) => setSection(key)}
          badges={{ maintenance: urgentCount }}
          badgeDescriptions={{ maintenance: "urgent jobs open" }}
          onNotify={setToast}
        />

        <div className="sidebar-help">
          <span className="sidebar-help__icon">
            <Icon name="spark" size={17} />
          </span>
          <div>
            <strong>Need a hand?</strong>
            <span>MAINTSUPP support is online</span>
          </div>
        </div>

        <div className="sidebar-profile">
          <Avatar name={displayUserName} />
          <span className="sidebar-profile__copy">
            <strong>{displayUserName}</strong>
            {/*
              The role switcher is a demo affordance, and it is shown only while
              nobody has actually signed in.
              `resolveTenantAccess` refuses to let it widen a real session's
              reach, so leaving it on screen for a signed-in user would offer a
              control that silently does nothing — they would pick "Client",
              watch the board not change, and reasonably conclude the app was
              broken. Signed in, the role is stated as a fact instead.
            */}
            {runtimeContext?.testingMode === false ? (
              <span className="sidebar-profile__role">
                {roleLabel(runtimeContext.actor.role)}
              </span>
            ) : (
              <label>
                <span>Testing access</span>
                <select
                  aria-label="Demo access role"
                  value={demoRole}
                  disabled={contextBusy}
                  onChange={(event) => void changeDemoRole(event.target.value as DemoRole)}
                >
                  <option value="super_admin">Super Admin</option>
                  <option value="admin">Admin</option>
                  <option value="client">Client</option>
                </select>
              </label>
            )}
          </span>
        </div>
      </aside>

      {mobileNavOpen && (
        <button
          className="nav-scrim"
          type="button"
          aria-label="Close navigation"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <div className="portal-main">
        <header className="portal-topbar">
          <button
            className="icon-button mobile-menu"
            type="button"
            onClick={() => {
              setNotificationsOpen(false);
              setMobileNavOpen(true);
            }}
            aria-label="Open navigation"
          >
            <Icon name="menu" size={21} />
          </button>

          {/*
            The page's name, on anything wider than a phone.

            On a phone it is not rendered, and that is the whole fix. It was
            42px wide at 320px and 77px at 390px — "Live job list" arriving as
            "Co…" — because it is `flex: 0 1 auto; min-width: 0` in a row that
            now holds six 44px controls, so it absorbed every pixel the touch
            targets took. A truncated title is worse than no title: it occupies
            110-150px of the one row a contractor navigates from, and says
            nothing.

            Nothing becomes unreachable, because the screen below states its own
            name in an `<h1>` on every route — but that was NOT true when this
            was written. Three routes had no `<h1>` at any width: /sites and
            /units set their page title as an `<h2>`, and /store-documentation
            put its only heading inside `.live-board-heading`, which globals.css
            takes to `display: none` at 760px for the board's vertical room. All
            three are fixed in their own components rather than papered over
            here; a page with no heading is a defect whatever the topbar does.

            `display: none` in CSS was the alternative and is not the same
            thing. It would still ship the string, still put it in the document
            for anything reading the DOM, and still leave the next person to
            measure this row wondering why an element that is not on screen is
            in the markup.
          */}
          {!narrowTopbar && (
            <div className="page-identity">
              <span>{meta.eyebrow}</span>
              <strong>
                {activeSection === "overview"
                  ? `${meta.title}, ${displayUserName.split(" ")[0]}`
                  : meta.title}
              </strong>
            </div>
          )}

          <div className="topbar-actions">
            <ThemeToggle />
            <span
              className={`data-indicator data-indicator--${dataMode}`}
              title={
                dataMode === "unavailable"
                  ? "Your workspace could not be read. Nothing is shown rather than something invented — use Refresh once the connection is back."
                  : undefined
              }
            >
              <span />
              {dataMode === "live"
                ? "Live workspace"
                : dataMode === "unavailable"
                  ? "Workspace unavailable"
                  : "Loading workspace"}
            </span>
            {/*
              Refresh, and when the figures were last read.

              Every dashboard on this screen derives from one fetch that ran on
              mount, so a job closed on another screen stayed open here until
              the tab was reloaded — and nothing said how old the numbers were.
              The time is stamped on success only, so it reports when the data
              was actually read rather than when the button was last pressed.

              `aria-live="polite"` on the timestamp because it changes without
              the user moving focus, and a screen reader that never announces it
              would leave the same "how old is this" question the control exists
              to answer.
            */}
            <button
              className="secondary-button topbar-data-button"
              type="button"
              onClick={() => {
                setRefreshing(true);
                setRefreshToken((token) => token + 1);
                // The board keeps its own snapshot, so it is told to re-read
                // rather than left a version behind the meters above it.
                window.dispatchEvent(new Event("maintsupp:refresh-board"));
              }}
              disabled={refreshing}
              aria-label="Refresh the figures on screen"
            >
              <Icon name="refresh" size={17} />
              <span>{refreshing ? "Refreshing…" : "Refresh"}</span>
            </button>
            <span className="topbar-updated" aria-live="polite">
              {dataUpdatedAt
                ? `Updated ${formatTimeOfDay(dataUpdatedAt)}`
                : "Not yet loaded"}
            </span>
            <button
              className="secondary-button topbar-data-button"
              type="button"
              onClick={() => openWorkspaceManager()}
              disabled={!workspace}
              /*
               * Named here as well as in the span, because below 1080px the
               * span is not there to name it.
               *
               * `.topbar-data-button > span { display: none }`
               * (brand-overrides.css) drops the label and leaves an icon-only
               * button — and `display: none` removes the text from the
               * accessibility tree too, so this button had NO accessible name
               * at all on a tablet or a phone. axe reports it `button-name`,
               * impact CRITICAL, at 768. Its sibling above already carries an
               * `aria-label` for exactly this reason; this one was missed.
               *
               * The visible label is unchanged at every width, and where the
               * span IS shown the two agree word for word, so nothing is
               * announced twice and nothing reads differently to what is
               * printed.
               */
              aria-label="Manage data"
            >
              <Icon name="settings" size={17} />
              <span>Manage data</span>
            </button>
            <a className="topbar-link" href="/request">
              <Icon name="plus" size={17} />
              Public request form
            </a>
            <div className="notification-wrap">
              <button
                ref={notificationsButtonRef}
                className="icon-button"
                type="button"
                aria-label={`Notifications${unreadNotificationCount ? `, ${unreadNotificationCount} unread` : ""}`}
                aria-expanded={notificationsOpen}
                aria-haspopup="dialog"
                onClick={() => {
                  setMobileNavOpen(false);
                  setNotificationsOpen((open) => !open);
                }}
              >
                <Icon name="bell" size={20} />
                {unreadNotificationCount > 0 && (
                  <span className="notification-dot" />
                )}
              </button>
              {/* Portalled and anchored to the bell, so neither the top bar's
                  backdrop-filter nor its z-index can trap or cover it. */}
              <AnchoredPopover
                open={notificationsOpen}
                anchorRef={notificationsButtonRef}
                onClose={() => setNotificationsOpen(false)}
                placement="bottom-end"
                role="dialog"
                label="Notifications"
                className="notification-layer"
              >
                <NotificationPanel
                  items={notificationItems}
                  states={notificationStates}
                  unreadCount={unreadNotificationCount}
                  onMarkRead={(requestIds) =>
                    persistNotificationState(requestIds, "read")
                  }
                  onDismiss={(requestIds) =>
                    persistNotificationState(requestIds, "dismissed")
                  }
                  onOpen={(request) => {
                    if (notificationStates[request.id] !== "read") {
                      void persistNotificationState([request.id], "read").catch(
                        () => undefined,
                      );
                    }
                    openRequest(request);
                    setSection("maintenance");
                    setNotificationsOpen(false);
                  }}
                />
              </AnchoredPopover>
            </div>
            {/*
              monday's top-right icon row is notifications, inbox, invite
              member, apps, help, the product grid, then the avatar. Three of
              those have somewhere real to go here and are kept in monday's
              relative order; the other two are deliberately absent rather than
              present and dead:
                · inbox — there is no cross-item update feed to open. The
                  board drawer holds updates per job. `item_updates` was empty
                  when this was written; monday's 218 comments and 47 replies
                  have since been imported, so a feed is now buildable — but
                  building one is a decision, not a consequence, and an inbox
                  that opens onto a list nobody curates is worse than none.
                · product grid — MAINTSUPP is one product; there is nothing to
                  switch between.
            */}
            <Link
              className="icon-button topbar-icon"
              href="/dashboard/account/invite"
              aria-label="Invite members"
              title="Invite members"
            >
              <Icon name="users" size={19} />
            </Link>
            <Link
              className="icon-button topbar-icon"
              href="/dashboard/account/integrations"
              aria-label="Integrations"
              title="Integrations"
            >
              <Icon name="grid" size={19} />
            </Link>
            <Link
              className="icon-button topbar-icon"
              href="/dashboard/account/help"
              aria-label="Get help"
              title="Get help"
            >
              <Icon name="message" size={19} />
            </Link>
            <button
              className="primary-button topbar-create"
              type="button"
              aria-label="New request"
              onClick={() => setShowCreateRequest(true)}
            >
              <Icon name="plus" size={18} />
              <span>New request</span>
            </button>
            {/*
              The avatar was decorative. It is now monday's avatar menu: the
              two-column Account / Explore panel, the workspace + plan pill
              header, and the working-status row. `onImportData` is what makes
              monday's "Import data" open the importer in place rather than
              navigate away.
            */}
            <AccountMenu
              userName={displayUserName}
              userEmail={displayUserEmail}
              onImportData={() => openWorkspaceManager("import")}
              onNotify={setToast}
            />
          </div>
        </header>

        <main className="portal-content">
          {/*
            An unreadable job list is not a quiet zero.
            
            Overview and Reports are computed entirely from `requests`, so with
            nothing loaded every tile reads £0, 0 open, 100% SLA — figures that
            are indistinguishable from a genuinely quiet month, and sit beside
            real annual budgets that DID load. The chip in the topbar says the
            workspace could not be read; these two screens say it where the
            numbers would have been.
            
            The other surfaces are not gated: the board, the registers and the
            managers each read their own source and show their own empty state,
            so they are never reporting a figure they did not measure.
          */}
          {activeSurface === "overview" && dataMode === "unavailable" && (
            <WorkspaceUnavailable
              onRetry={() => {
                setRefreshing(true);
                setRefreshToken((token) => token + 1);
              }}
              busy={refreshing}
            />
          )}
          {activeSurface === "overview" && dataMode !== "unavailable" && (
            <OverviewView
              /*
                KEYED BY SECTION, so a range belongs to the page it was chosen on.

                These surfaces are chosen by `activeSurface`, and a workspace
                section may declare ANY built-in surface as the thing it draws
                (`WorkspaceSectionEntry.surface`, resolved a few hundred lines
                above). Two sidebar destinations can therefore resolve to one
                surface — "Reports" and a workspace "Site reports", say — and
                without a key React reconciles the SAME component instance
                across them. The date range, the portfolio and every other
                piece of page state then follow the reader from one page to
                the other, which is precisely what this workstream forbids.

                Independence held until now only because switching surface
                happened to unmount the old one. This makes it structural.
              */
              key={activeSection}
              sectionKey={activeSection}
              requests={requests}
              stores={currentStores}
              compliance={workspace?.compliance ?? []}
              units={currentUnits}
              workspaceReady={workspace !== null}
              /* The workspace flag above covers units and compliance, which
                 arrive from a different fetch. The four job tiles below it
                 were still printing a literal 0 until /api/maintenance
                 answered. */
              jobsReady={dataMode === "live"}
              onOpenRequest={(request) => {
                openRequest(request);
                setSection("maintenance");
              }}
              onNavigate={setSection}
            />
          )}
          {activeSurface === "maintenance" && (
            <LiveMaintenanceBoard
              /* The section, not the board: two sections can read one board,
                 and each keeps its own open tab. */
              sectionKey={activeSection}
              requests={requests}
              onCreateDetailed={() => setShowCreateRequest(true)}
              onOpenRequest={openRequest}
              onRequestChange={(updated) => {
                setRequests((current) =>
                  current.map((request) =>
                    request.id === updated.id ? updated : request,
                  ),
                );
                setSelectedRequest((current) =>
                  current?.id === updated.id ? updated : current,
                );
                setDataMode("live");
              }}
              onRequestCreated={(created) => {
                setRequests((current) =>
                  current.some((request) => request.id === created.id)
                    ? current.map((request) =>
                        request.id === created.id ? created : request,
                      )
                    : [created, ...current],
                );
                setDataMode("live");
              }}
              onRequestsDeleted={(requestIds) => {
                setRequests((current) =>
                  current.filter((request) => !requestIds.includes(request.id)),
                );
                setSelectedRequest((current) =>
                  current && requestIds.includes(current.id) ? null : current,
                );
                setDataMode("live");
              }}
              onBoardSnapshotChange={setBoardSnapshot}
              onNotify={setToast}
              onOpenApps={() => setSection("settings")}
              onItemActionsChange={setBoardItemActions}
              /*
               * The board's Calendar view TAB — Workstream 4's calendar, not a
               * second one. This is the fix for what the owner reported: the
               * calendar was built on the Planned page, and the tab a person
               * opens when they want to see this board as a calendar drew a
               * bare month grid with none of it.
               *
               * The board supplies its own scoped jobs, the drawer opener and
               * the toast. What only a HOST can supply is the compliance
               * register and the two audited date writers, so those come from
               * here — and they are the very same handlers the Planned page
               * hands to `OperationsCalendarPanel`. A date moved on the board's
               * calendar therefore takes exactly the path a date moved on
               * /dashboard/planned takes: one write path, one audit trail, one
               * capability check.
               *
               * Without this prop the tab still draws the calendar and refuses
               * a date change out loud rather than pretending to save it.
               */
              calendar={{
                complianceRecords: workspace?.compliance ?? [],
                onOpenCompliance: (id) => openWorkspaceManager("compliance", id),
                onJobDateChange: changeJobDate,
                onComplianceDateChange: changeComplianceDate,
              }}
            />
          )}
          {activeSurface === "stores" && <SitesManager onNotify={setToast} />}
          {activeSurface === "store-documentation" && (
            <StoreDocumentationBoard
              onNotify={setToast}
              onOpenApps={() => setSection("settings")}
              /* `openRequest` only sets the drawer's record and tab — it does
                 not navigate — so a store opens over this section rather than
                 bouncing the reader to the maintenance board. */
              onOpenRequest={openRequest}
              onItemActionsChange={setBoardItemActions}
            />
          )}
          {activeSurface === "units" && (
            <UnitsManager sites={currentStores} onNotify={setToast} />
          )}
          {/*
            THE FAILURE STATE REACHES THE TWO SCREENS THAT ARE MADE OF JOBS.

            `WorkspaceUnavailable` was wired to Overview and Reports only, on
            the reasoning that the other sections read their own sources. That
            is true of the registers and the board; it is not true of these
            two. The contractor scorecard's roster falls back to one derived
            from `requests`, and every count beside a name — assigned,
            completed, urgent, spend — is computed from them, so a failed jobs
            fetch drew a full roster with a column of zeroes. The calendar
            takes `requests` as a prop and draws a schedule that silently
            omits every job.

            Both are the invented-figures problem this product has already
            ruled on twice: nothing is shown rather than something made up.
          */}
          {activeSurface === "contractors" && dataMode === "unavailable" && (
            <WorkspaceUnavailable
              onRetry={() => {
                setRefreshing(true);
                setRefreshToken((token) => token + 1);
              }}
              busy={refreshing}
            />
          )}
          {activeSurface === "contractors" && dataMode !== "unavailable" && (
            <ContractorsView
              key={activeSection}
              sectionKey={activeSection}
              contractors={currentContractors}
              requests={requests}
              onManage={(id) => openWorkspaceManager("contractor", id)}
            />
          )}
          {activeSurface === "compliance" && (
            <ComplianceView
              key={activeSection}
              sectionKey={activeSection}
              stores={currentStores}
              complianceRecords={workspace?.compliance ?? []}
              onManage={(id) => openWorkspaceManager("compliance", id)}
              onNotify={setToast}
            />
          )}
          {activeSurface === "calendar" && dataMode === "unavailable" && (
            <WorkspaceUnavailable
              onRetry={() => {
                setRefreshing(true);
                setRefreshToken((token) => token + 1);
              }}
              busy={refreshing}
            />
          )}
          {activeSurface === "calendar" && dataMode !== "unavailable" && (
            <CalendarView
              key={activeSection}
              sectionKey={activeSection}
              requests={requests}
              planned={currentPlanned}
              complianceRecords={workspace?.compliance ?? []}
              onManage={(id) => openWorkspaceManager("planned", id)}
              onOpenCompliance={(id) => openWorkspaceManager("compliance", id)}
              onOpenRequest={(request) => {
                openRequest(request);
                setSection("maintenance");
              }}
              onNotify={setToast}
              onJobDateChange={changeJobDate}
              onComplianceDateChange={changeComplianceDate}
            />
          )}
          {activeSurface === "documents" && (
            <DocumentsView key={activeSection} sectionKey={activeSection} files={documents} />
          )}
          {activeSurface === "reports" && dataMode === "unavailable" && (
            <WorkspaceUnavailable
              onRetry={() => {
                setRefreshing(true);
                setRefreshToken((token) => token + 1);
              }}
              busy={refreshing}
            />
          )}
          {activeSurface === "reports" && dataMode !== "unavailable" && (
            <ReportsView
              key={activeSection}
              sectionKey={activeSection}
              requests={requests}
              stores={currentStores}
              /* `dataMode` IS the jobs signal — it is stamped "live" only
                 once /api/maintenance has answered, and the gate above lets
                 "loading" through on purpose so the page's chrome paints
                 immediately. What it must not do is let the figures claim the
                 portfolio is empty while the fetch is still in flight. */
              jobsReady={dataMode === "live"}
              onNavigate={setSection}
            />
          )}
          {activeSurface === "team" && (
            <TeamView
              userName={displayUserName}
              userEmail={displayUserEmail}
              team={currentTeam}
              onManage={(id) => openWorkspaceManager("member", id)}
            />
          )}
          {/*
            Administration. Each screen re-checks its own capability against the
            API rather than trusting that being routed here meant anything — the
            sidebar can be rearranged by its owner, so the presence of a nav
            item is not a permission.
          */}
          {/*
            The audit trail. Like the three administration screens above it, the
            component re-checks its own capability against /api/audit rather
            than trusting that being routed here meant anything — a sidebar can
            be rearranged by its owner, so the presence of a nav item is not a
            permission and never was.
          */}
          {activeSurface === "audit" && <AuditLog />}
          {/*
            The recycle bin — the same panel the account area draws, over the
            same /api/trash. See recycle-bin-section.tsx for why it is a door
            and not a room.
          */}
          {activeSurface === "recycle-bin" && <RecycleBinSection onNotify={setToast} />}
          {activeSurface === "admin-users" && <AdminUsersView />}
          {activeSurface === "admin-roles" && <AdminRolesView />}
          {activeSurface === "admin-clients" && (
            <AdminClientsView onSwitched={() => void loadRuntimeContext()} />
          )}
          {activeSurface === "settings" && (
            <SettingsView
              settings={currentSettings}
              /*
               * The categories actually in use, counted from the jobs on
               * screen rather than from a fixed list. A hard-coded set would
               * drift the first time somebody adds a category on the board,
               * and the gate would then quietly not apply to it.
               */
              categories={Array.from(
                new Set(
                  requests
                    .map((item) => (item.category ?? "").trim())
                    .filter((value) => value && value !== "[object Object]"),
                ),
              ).sort((left, right) => left.localeCompare(right, "en-GB"))}
              busy={workspaceBusy}
              onSave={async (settings) => {
                await saveWorkspaceRecord("settings", runtimeContext?.currentOrganisation.id ?? null, settings as unknown as Record<string, unknown>);
              }}
              onNotify={setToast}
            />
          )}
        </main>
      </div>

      {selectedRequest && (
        <RequestDrawer
          key={`${selectedRequest.id}:${drawerInitialTab}`}
          request={selectedRequest}
          boardSnapshot={boardSnapshot}
          initialTab={drawerInitialTab}
          onClose={() => setSelectedRequest(null)}
          onStatusChange={(nextStage) =>
            changeRequestStage(selectedRequest.id, nextStage)
          }
          onAddUpdate={(note, options) =>
            addRequestNote(selectedRequest.id, note, options)
          }
          onFieldsChange={(fields) =>
            persistRequestUpdate(selectedRequest.id, { fields })
          }
          onBoardCellChange={(column, value) =>
            persistBoardCell(selectedRequest.id, column, value)
          }
          onAddColumn={() =>
            window.dispatchEvent(
              new Event("maintsupp:open-column-picker"),
            )
          }
          onRequestChange={(updated) => {
            setRequests((current) =>
              current.map((request) =>
                request.id === updated.id ? updated : request,
              ),
            );
            setSelectedRequest(updated);
            setDataMode("live");
          }}
          itemActions={boardItemActions}
          onNotify={setToast}
          /* The avatar beside the reply box, so the panel shows who is about to
             speak — as monday's does. `displayUserName` is the same name the
             shell puts in the top bar. */
          currentUserName={displayUserName}
        />
      )}

      {showCreateRequest && (
        <CreateRequestModal
          locations={currentStores.filter((store) => store.lifecycle === "Current").map((store) => store.name)}
          onClose={() => setShowCreateRequest(false)}
          onCreate={createRequest}
        />
      )}

      {workspaceManager && workspace && (
        <WorkspaceDataManager
          workspace={workspace}
          initialTab={workspaceManager.tab}
          initialRecordId={workspaceManager.recordId}
          busy={workspaceBusy}
          onClose={() => setWorkspaceManager(null)}
          onSave={saveWorkspaceRecord}
          onArchive={archiveWorkspaceRecord}
          onImported={() => {
            // A monday import writes sites, groups and items straight into the
            // database, so the whole snapshot is reloaded rather than patched.
            void loadWorkspace().catch(() => undefined);
          }}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <span>
            <Icon name="check" size={17} />
          </span>
          {toast}
        </div>
      )}
    </div>
  );
}

function NotificationPanel({
  items,
  states,
  unreadCount,
  onOpen,
  onMarkRead,
  onDismiss,
}: {
  items: MaintenanceRequest[];
  states: Record<string, NotificationState>;
  unreadCount: number;
  onOpen: (request: MaintenanceRequest) => void;
  onMarkRead: (requestIds: string[]) => Promise<void>;
  onDismiss: (requestIds: string[]) => Promise<void>;
}) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const unreadIds = items
    .filter((request) => states[request.id] !== "read")
    .map((request) => request.id);

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusyAction(key);
    try {
      await action();
    } catch {
      // The parent surfaces persistence failures in the global status toast.
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="notification-panel">
      <div className="notification-panel__header">
        <div>
          <strong>Notifications</strong>
          <span>{unreadCount ? `${unreadCount} unread` : "All caught up"}</span>
        </div>
        {unreadIds.length > 0 && (
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() =>
              void runAction("all", () => onMarkRead(unreadIds))
            }
          >
            Mark all read
          </button>
        )}
      </div>
      <div className="notification-panel__list">
        {items.length ? (
          items.map((request) => {
            const isUnread = states[request.id] !== "read";
            const itemBusy = busyAction?.endsWith(`:${request.id}`) ?? false;
            return (
              <div
                className={`notification-item${isUnread ? " is-unread" : ""}`}
                key={request.id}
              >
                <button
                  className="notification-item__open"
                  type="button"
                  onClick={() => onOpen(request)}
                >
                  <span className="notification-alert">
                    <Icon name="alert" size={15} />
                  </span>
                  <span className="notification-item__copy">
                    <strong>{request.title}</strong>
                    <small>
                      {request.location} · {request.id}
                    </small>
                  </span>
                  {isUnread && <i aria-hidden="true" />}
                </button>
                <div className="notification-item__actions">
                  {isUnread && (
                    <button
                      type="button"
                      disabled={itemBusy}
                      aria-label={`Mark ${request.id} as read`}
                      title="Mark as read"
                      onClick={() =>
                        void runAction(`read:${request.id}`, () =>
                          onMarkRead([request.id]),
                        )
                      }
                    >
                      <Icon name="check" size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={itemBusy}
                    aria-label={`Remove ${request.id} from notifications`}
                    title="Remove notification"
                    onClick={() =>
                      void runAction(`dismiss:${request.id}`, () =>
                        onDismiss([request.id]),
                      )
                    }
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              </div>
            );
          })
        ) : (
          <div className="notification-panel__empty">
            <span>
              <Icon name="check" size={17} />
            </span>
            <strong>You’re all caught up</strong>
            <small>New urgent work will appear here.</small>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Whether a row is a work order the reporting screens should count.
 *
 * Two rows reach the browser that are not a job anybody ordered, and both were
 * being counted as one.
 *
 * A SUBITEM is a full row of `maintenance_requests` whose `parentId` is
 * another row — monday's Subitems column, kept in one table so the whole
 * editing surface applies to it. The board has always known this: it filters
 * `!request.parentId` before it places anything, and the comment there records
 * why — "the same work appeared twice and the group counts were wrong". The
 * analytics screens never learned it, so a job split into three visits counted
 * as four work orders and its parts cost was summed alongside its parent's.
 *
 * An ARCHIVED row is one somebody deliberately took off the board.
 * `/api/board/items` excludes them; `/api/maintenance`, which is where every
 * dashboard figure comes from, does not. The exclusion is applied here rather
 * than in that route because the jobs board reads the same array, and quietly
 * emptying rows out of the board is a different decision from leaving them out
 * of a spend total — this is the one Workstream 8 is entitled to make.
 */
function countsAsWorkOrder(request: MaintenanceRequest) {
  return !request.parentId && !request.archived;
}

function OverviewView({
  requests,
  stores: storeRows,
  compliance: complianceRecords,
  units,
  workspaceReady,
  jobsReady,
  sectionKey,
  onNavigate,
  onOpenRequest,
}: {
  requests: MaintenanceRequest[];
  stores: StoreRecord[];
  /**
   * The workspace compliance register, derived from the Store Documentation
   * board. The tile used to count `stores[].compliance`, which only covers
   * sites that have a `sites` row, and counted a stored status string rather
   * than a date — so it disagreed with /dashboard/compliance and with the
   * Compliance Tracker about the same documents. One source, one verdict.
   */
  compliance: WorkspaceSnapshot["compliance"];
  units: WorkspaceUnit[];
  /**
   * Whether `/api/workspace` has answered yet.
   *
   * The jobs fetch and the workspace fetch land separately, and this page
   * derives half its figures from each. Before this flag, the seconds between
   * the two paints showed "Active units 0 — Add units to the register" and
   * "Compliance 0% — No requirements recorded yet": definitive claims about an
   * account that had simply not loaded, and on a failed workspace fetch they
   * stood there permanently. Loading and empty are different states, and a
   * dashboard must not present one as the other.
   */
  workspaceReady: boolean;
  /**
   * WHICH PAGE THIS IS, for the range it remembers.
   *
   * The section id the shell is actually on — a built-in one, or a
   * workspace-defined section that draws this surface. It is the storage
   * namespace for this page's date range and nothing else, which is what
   * keeps one page's range out of another's. A display label would break the
   * moment somebody renamed a menu item.
   */
  sectionKey: string;
  /**
   * Whether `/api/maintenance` has answered yet — the jobs half of this page.
   *
   * `workspaceReady` was added when "Active units 0" and "Compliance 0%" were
   * found standing over an account that had not loaded. The job tiles have the
   * same defect from the same cause and it was left in place: "Open jobs 0",
   * "Overdue 0" and "Completed 0" are all printed from an array that starts
   * empty. Two fetches, two flags.
   */
  jobsReady: boolean;
  onNavigate: (section: Section) => void;
  onOpenRequest: (request: MaintenanceRequest) => void;
}) {
  const now = useCurrentTime();
  const [portfolio, setPortfolio] = useState("all");
  const [overviewLayoutSlot, setOverviewLayoutSlot] = useState<HTMLElement | null>(null);
  // Named once, so the tiles and the panels below cannot drift apart on what
  // "not loaded yet" means.
  const loading = !jobsReady;
  /*
   * Remembered for THIS page. Keying the sections stopped a range leaking
   * between them and, by unmounting on the way out, also threw it away — so
   * Overview came back on its default every time. The key stays and the value
   * outlives the component; see `useStoredPeriod`.
   */
  const [period, setPeriod] = useStoredPeriod(sectionKey, "90");
  const scopedStores = useMemo(
    () => storeRows.filter((store) => store.lifecycle === "Current" && (portfolio === "all" || store.id === portfolio)),
    [portfolio, storeRows],
  );
  const scopedRequests = useMemo(
    () => requests.filter((request) =>
      countsAsWorkOrder(request) &&
      (portfolio === "all" || request.siteId === portfolio) &&
      withinAnalyticsPeriod(request.requestedAt, period, now),
    ),
    [now, period, portfolio, requests],
  );
  // Counted from the unit register only. This used to fall back to the number
  // of sites when no units had been registered, which put a plausible number
  // under the words "Active units" that was really a count of something else —
  // a ten-site client with an empty asset register read as ten live units. If
  // the register is empty the honest answer is zero, and the card says why.
  const activeUnitCount = units.filter(
    (unit) => unit.status === "Active" && (portfolio === "all" || unit.siteId === portfolio),
  ).length;
  /*
   * OPEN AND CLOSED COME FROM ONE PREDICATE, SHARED WITH THE BOARD'S METERS.
   *
   * This read `stage !== "Completed"` while the six meters above the job board
   * read `stage === "Completed" || status === "Job Completed"`, and the two
   * disagree on live data: the imported rows sit in monday's "… Recently
   * completed" groups, which carry no lifecycle stage here, so 28 jobs whose own
   * status says "Job Completed" counted as open on this page and as closed on
   * the board. Two screens, one portfolio, different numbers.
   *
   * `isOpenRequest` and `isClosedRequest` in dashboard-meters.ts are that
   * predicate, and they are a partition — every row is one or the other — which
   * is what lets Overview, Reports and the board's meters be checked against
   * each other rather than taken on trust.
   */
  const open = scopedRequests.filter(isOpenRequest);
  const attention = open
    .filter((request) => request.stage === "Attention" || request.priority === "Urgent")
    .sort((left, right) => requestAgeDays(right, now) - requestAgeDays(left, now));
  const completed = scopedRequests.filter(isClosedRequest);
  const overdue = open.filter(
    // Open work only, past its own target — see `duePassed` for why a bare
    // date is not overdue until its day is over. Completed jobs cannot appear
    // here: `open` is the canonical partition's other half.
    (request) => request.dueAt && duePassed(request.dueAt, now),
  );
  const complianceItems = complianceRecords.filter(
    (record) =>
      record.state !== "Not required" &&
      (portfolio === "all" || record.siteId === portfolio),
  );
  const complianceCounts = {
    compliant: complianceItems.filter((item) => item.state === "Compliant").length,
    expiring: complianceItems.filter((item) => item.state === "Expiring soon").length,
    expired: complianceItems.filter((item) => item.state === "Expired").length,
    missing: complianceItems.filter((item) => item.state === "Missing").length,
  };
  const compliancePercent = Math.round(
    (complianceCounts.compliant / Math.max(complianceItems.length, 1)) * 100,
  );
  const statusSegments = jobStatusSegments(scopedRequests);
  const tradeRows = tradeBreakdown(scopedRequests);
  const spendSeries = periodSpendSeries(scopedRequests, period, now);
  const overviewWindow = resolvePeriod(period, now);
  const complianceSegments: DonutSegment[] = [
    { label: "Compliant", value: complianceCounts.compliant, color: "#12b4a8" },
    { label: "Expiring soon", value: complianceCounts.expiring, color: "#f0a91f" },
    { label: "Expired", value: complianceCounts.expired, color: "#e2445c" },
    { label: "Missing", value: complianceCounts.missing, color: "#5c82af" },
  ];

  return (
    <div className="section-stack analytics-page">
      <section className="analytics-page-heading">
        <div><span>Live operations</span><h1>Dashboard Overview</h1></div>
        <AnalyticsToolbar
          portfolio={portfolio}
          portfolios={portfolioOptions(storeRows)}
          onPortfolioChange={setPortfolio}
          period={period}
          /*
           * Overview's own range, with the same picker Reports uses: Today,
           * Last 7 days, Month to date, Last 30/90 days, Year to date and a
           * validated custom start/end — instead of the four rolling windows
           * the plain select offered. It is this page's state and nobody
           * else's, which is the point: a range chosen here does not follow
           * the reader to Reports or Compliance.
           *
           * It changes the figures, not just the label — `period` is what
           * `scopedRequests` filters on above, and every meter, chart and
           * tile on this page reads from that.
           */
          periodControl={<PeriodPicker value={period} onChange={setPeriod} now={now} />}
          onExport={() => downloadCsv(scopedRequests)}
          /*
           * "Edit layout" belongs with the other page controls, not floating
           * above the panels it edits. Reports already portals its bar into
           * this toolbar; Overview drew its own in place, which is why it sat
           * alone in the top-left with nothing beside it. Same slot, same
           * component, same state — only where the bar is drawn changes.
           */
          slotRef={setOverviewLayoutSlot}
        />
      </section>

      {/* Focusable because it scrolls sideways at phone widths: without a tab
          stop a keyboard user cannot reach the cards past the fold. */}
      <section
        className="analytics-metric-grid analytics-metric-grid--six"
        aria-label="Portfolio metrics"
        tabIndex={0}
      >
        {/*
          Each sparkline names what it plots, because none of them is a history
          — see the trend note in dashboard-meters.ts. And each trend is built
          from the same rows as the number above it: "Requiring attention" used
          to count open-and-urgent-or-escalated in the figure while its
          sparkline counted `stage === "Attention"` only — the figure read 8
          over a line that summed 2.
        */}
        <AnalyticsMetricCard label="Active units" value={workspaceReady ? String(activeUnitCount) : "—"} detail={!workspaceReady ? "Loading workspace…" : activeUnitCount ? "Current portfolio" : "Add units to the register"} icon="building" tone="teal" trend={periodTrend(scopedRequests, () => true, period, now)} trendLabel="Maintenance requests raised across the selected period — not a history of the unit count; the unit register keeps none." onClick={() => onNavigate("units")} />
        <AnalyticsMetricCard label="Requiring attention" value={jobsReady ? String(attention.length) : "—"} detail={jobsReady ? "Urgent or escalated" : "Loading jobs…"} icon="alert" tone="orange" trend={periodTrend(attention, () => true, period, now)} trendLabel="Jobs now urgent or escalated, by the week they were raised across the selected period. Not a history of the attention count." onClick={() => onNavigate("maintenance")} />
        <AnalyticsMetricCard label="Open jobs" value={jobsReady ? String(open.length) : "—"} detail={jobsReady ? `${open.filter((request) => request.priority === "Urgent").length} urgent` : "Loading jobs…"} icon="inbox" tone="blue" trend={periodTrend(scopedRequests, isOpenRequest, period, now)} trendLabel="Open jobs by the week they were raised, across the selected period. Not a history of the open count — no status history is recorded." onClick={() => onNavigate("maintenance")} />
        <AnalyticsMetricCard label="Overdue" value={jobsReady ? String(overdue.length) : "—"} detail={jobsReady ? "Target date passed" : "Loading jobs…"} icon="clock" tone="red" trend={periodTrend(overdue, () => true, period, now)} trendLabel="Jobs now overdue, by the week they were raised across the selected period. Not a history of the overdue count." onClick={() => onNavigate("maintenance")} />
        {/*
          "Raised in this period" is not padding. This tile counts the jobs
          RAISED inside the window that are now closed — not the jobs closed
          inside it. A job raised in June and closed in August is absent from
          August, and one raised in August and closed in November is present.
          The sparkline below has always said so; the number above it never
          did, and that is the figure a reader takes away.
        */}
        <AnalyticsMetricCard label="Completed" value={jobsReady ? String(completed.length) : "—"} detail={jobsReady ? "Verified closures, raised in this period" : "Loading jobs…"} icon="check" tone="green" trend={periodTrend(completed, () => true, period, now)} trendLabel="Completed jobs by the week they were raised — not by the week they closed, and not a history of the completed count." onClick={() => onNavigate("maintenance")} />
        <AnalyticsMetricCard label="Compliance" value={workspaceReady ? `${compliancePercent}%` : "—"} detail={!workspaceReady ? "Loading workspace…" : complianceItems.length ? `${complianceCounts.compliant} current records` : "No requirements recorded yet"} icon="shield" tone="teal" trend={complianceTrend(complianceItems, now)} trendLabel="Today's compliance score walked back through recorded certificate expiries, week by week. A view of expiry pressure, not an audit trail." onClick={() => onNavigate("compliance")} />
      </section>

      

      <section className="analytics-bottom-grid">
        <article className="analytics-panel analytics-spend-panel">
          <header><h2>Spend trend</h2><span>{overviewWindow.label}</span></header>
          {/*
            Cost is optional on a job and most are still open, so a portfolio
            can genuinely have no spend recorded. Plotting that as a line
            pinned to the axis looks like a charting failure, and worse, it
            invites the reader to conclude the work was free.
          */}
          {spendSeries.some((point) => point.value > 0)
            ? <TrendChart items={spendSeries} valueFormatter={(value) => formatMoney(Math.round(value))} />
            : <p className="analytics-empty">{jobsReady
                ? "No costs recorded against jobs in this period. Spend appears here once jobs carry a cost."
                : "Loading jobs…"}</p>}
        </article>
        <button className="analytics-panel analytics-score-panel" type="button" onClick={() => onNavigate("compliance")}>
          <header><h2>Compliance score</h2></header>
          <DonutChart segments={complianceSegments} value={complianceItems.length ? `${compliancePercent}%` : "—"} label="On track" size="medium" />
          {/*
            0% and "0 of 0" are different claims: one says the sites are failing
            their requirements, the other says nobody has told us what the
            requirements are. A new site has the second problem.
          */}
          <span>{!workspaceReady
            ? "Loading the compliance register…"
            : complianceItems.length
              ? `${complianceCounts.compliant} of ${complianceItems.length} requirements on track`
              : "No compliance requirements recorded for these sites yet"}</span>
          <strong>View compliance <Icon name="chevron" size={15} /></strong>
        </button>
        <article className="analytics-panel analytics-trades-panel">
          <header><h2>Jobs by trade</h2></header>
          {/*
            An empty bar chart is indistinguishable from a broken one, so an
            unfiltered period with no jobs says so in words instead of drawing
            an axis with nothing on it.
          */}
          {tradeRows.length
            ? <HorizontalBars items={tradeRows} />
            : <p className="analytics-empty">{jobsReady
                ? "No jobs in this period. Logged jobs are grouped here by the trade on the record."
                : "Loading jobs…"}</p>}
        </article>
      </section>

      {/*
        Deeper panels. Each is computed from the same organisation-scoped rows
        the tiles above use, so two accounts see two different pictures from one
        code path, and each carries its own empty state — a new workspace has no
        data at all, and a blank axis reads as broken rather than empty.
      */}
      {/*
        Arrangeable. The panels are unchanged — what each COMPUTES is exactly
        what it computed before — but the order and which ones appear now come
        from the person's saved layout rather than from this file.
      */}
      {/* Last on the overview, on the owner's instruction: it is a
          follow-up list rather than a headline, and it was sitting above
          the panels people actually open first. */}
      <section className="analytics-overview-grid">
        <article className="analytics-panel analytics-attention-panel">
          <header><h2>Units requiring attention</h2><button type="button" onClick={() => onNavigate("maintenance")}>View all <Icon name="chevron" size={15} /></button></header>
          <div className="table-scroll">
            <table className="analytics-table analytics-table--mobile-cards">
              <thead><tr><th>Priority</th><th>Unit / Site</th><th>Issue</th><th>Status</th><th>Days</th></tr></thead>
              <tbody>
                {attention.slice(0, 5).map((request) => (
                  <tr className="analytics-row" key={request.id} role="button" aria-label={`Open ${request.id}`} onClick={() => onOpenRequest(request)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") onOpenRequest(request); }}>
                    <td data-label="Priority"><span className={priorityClass(request.priority)}>{request.priority}</span></td>
                    <td data-label="Unit / Site">{request.location}</td>
                    <td data-label="Issue"><strong>{request.title}</strong></td>
                    <td data-label="Status"><span className="analytics-status">{request.status}</span></td>
                    <td data-label="Days open">{requestAgeDays(request, now)}</td>
                  </tr>
                ))}
                {!attention.length && <tr><td colSpan={5} className="analytics-empty">No jobs currently require attention.</td></tr>}
              </tbody>
            </table>
          </div>
        </article>

        <article className="analytics-panel analytics-donut-panel">
          <header><h2>Jobs by status</h2></header>
          <div className="analytics-donut-layout">
            <DonutChart segments={statusSegments} value={String(open.length)} label="Open jobs" />
            <DonutLegend segments={statusSegments} />
          </div>
        </article>
      </section>

      <DashboardWidgets
        surface="overview"
        barSlot={overviewLayoutSlot}
        widgets={[
          {
            key: "sla",
            label: "SLA performance",
            render: () => <SlaPerformance requests={scopedRequests} />,
          },
          {
            key: "ageing",
            label: "Open job ageing",
            render: () => (
              <OpenJobAgeing requests={scopedRequests} now={now} onOpen={onOpenRequest} />
            ),
          },
          {
            key: "site-attention",
            label: "Sites needing attention",
            render: () => (
              /*
               * The WORKSPACE register, not `stores[].compliance`. This panel
               * was still reading the per-store legacy list after the tile
               * above was moved to the register (see the `compliance` prop
               * note): two compliance sources on one page, and the legacy one
               * only covers sites that have a `sites` row and judges a stored
               * status string rather than a date. `complianceItems` is the
               * same portfolio-scoped rows the tile counts, so the panel's
               * gaps and the tile's score can no longer disagree.
               */
              <SiteAttention
                requests={scopedRequests}
                compliance={complianceItems}
                stores={scopedStores}
                loading={!workspaceReady || loading}
              />
            ),
          },
          {
            key: "reactive-planned",
            label: "Reactive vs planned",
            render: () => (
              <ReactiveVsPlanned requests={scopedRequests} now={now} period={period} loading={loading} />
            ),
          },
          {
            key: "spend-budget",
            label: "Spend against budget",
            render: () => (
              <SpendAgainstBudget
                requests={scopedRequests}
                sites={storeRows}
                period={period}
                now={now}
                loading={!workspaceReady || loading}
              />
            ),
          },
        ] satisfies DashboardWidget[]}
      />
    </div>
  );
}

export function LegacyMaintenanceView({
  requests,
  onCreate,
  onOpenRequest,
}: {
  requests: MaintenanceRequest[];
  onCreate: () => void;
  onOpenRequest: (request: MaintenanceRequest) => void;
}) {
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<"All" | RequestStage>("All");
  const [priority, setPriority] = useState<"All" | Priority>("All");
  const [viewMode, setViewMode] = useState<ViewMode>("board");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return requests.filter((request) => {
      const matchesQuery =
        !needle ||
        [
          request.id,
          request.title,
          request.description,
          request.location,
          request.contractor ?? "",
          request.assignee ?? "",
        ].some((value) => value.toLowerCase().includes(needle));
      return (
        matchesQuery &&
        (stage === "All" || request.stage === stage) &&
        (priority === "All" || request.priority === priority)
      );
    });
  }, [priority, query, requests, stage]);

  const stages: RequestStage[] = [
    "Incoming",
    "Booked",
    "Attention",
    "Completed",
  ];

  return (
    <div className="section-stack">
      <section className="section-header">
        <div>
          <span className="eyebrow-chip">
            <Icon name="wrench" size={15} />
            End-to-end work orders
          </span>
          <h1>Maintenance requests</h1>
          <p>
            Triage, assign, approve and close every request with one traceable
            activity history.
          </p>
        </div>
        <button className="primary-button" type="button" onClick={onCreate}>
          <Icon name="plus" size={18} />
          New request
        </button>
      </section>

      <section className="maintenance-summary">
        <button
          type="button"
          className={stage === "All" ? "is-active" : ""}
          onClick={() => setStage("All")}
        >
          <span>All requests</span>
          <strong>{requests.length}</strong>
        </button>
        {stages.map((item) => (
          <button
            type="button"
            key={item}
            className={stage === item ? "is-active" : ""}
            onClick={() => setStage(item)}
          >
            <span>{stageLabel(item)}</span>
            <strong>
              {requests.filter((request) => request.stage === item).length}
            </strong>
          </button>
        ))}
      </section>

      <section className="panel maintenance-workspace">
        <div className="workspace-toolbar">
          <label className="search-field">
            <Icon name="search" size={18} />
            <input
              aria-label="Search maintenance requests"
              placeholder="Search by issue, ID, location or contractor…"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                <Icon name="close" size={15} />
              </button>
            )}
          </label>
          <label className="select-control">
            <Icon name="filter" size={17} />
            <select
              aria-label="Filter by priority"
              value={priority}
              onChange={(event) =>
                setPriority(event.target.value as "All" | Priority)
              }
            >
              <option>All</option>
              <option>Urgent</option>
              <option>High</option>
              <option>Medium</option>
              <option>Low</option>
            </select>
          </label>
          <div className="view-switch" aria-label="Change view">
            <button
              type="button"
              className={viewMode === "board" ? "is-active" : ""}
              onClick={() => setViewMode("board")}
              aria-label="Board view"
            >
              <Icon name="grid" size={17} />
            </button>
            <button
              type="button"
              className={viewMode === "list" ? "is-active" : ""}
              onClick={() => setViewMode("list")}
              aria-label="List view"
            >
              <Icon name="list" size={17} />
            </button>
          </div>
          <button
            className="secondary-button export-button"
            type="button"
            onClick={() => downloadCsv(filtered)}
          >
            <Icon name="download" size={17} />
            Export
          </button>
        </div>

        <div className="filter-result">
          <span>
            Showing <strong>{filtered.length}</strong> of {requests.length}{" "}
            requests
          </span>
          {(query || stage !== "All" || priority !== "All") && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setStage("All");
                setPriority("All");
              }}
            >
              Reset filters
            </button>
          )}
        </div>

        {viewMode === "board" ? (
          <div className="request-board">
            {stages.map((item) => {
              const group = filtered.filter(
                (request) => request.stage === item,
              );
              return (
                <div className={`board-column board-column--${item.toLowerCase()}`} key={item}>
                  <div className="board-column__heading">
                    <span>
                      <Icon name={stageIcon(item)} size={16} />
                    </span>
                    <strong>{stageLabel(item)}</strong>
                    <i>{group.length}</i>
                  </div>
                  <div className="board-column__body">
                    {group.map((request) => (
                      <RequestCard
                        key={request.id}
                        request={request}
                        onOpen={() => onOpenRequest(request)}
                      />
                    ))}
                    {!group.length && (
                      <div className="board-empty">
                        <Icon name="check" size={18} />
                        No matching requests
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <RequestTable requests={filtered} onOpenRequest={onOpenRequest} />
        )}
      </section>
    </div>
  );
}

function RequestCard({
  request,
  onOpen,
}: {
  request: MaintenanceRequest;
  onOpen: () => void;
}) {
  return (
    <button className="request-card" type="button" onClick={onOpen}>
      <span className="request-card__topline">
        <span className={priorityClass(request.priority)}>
          {request.priority}
        </span>
        <small>{request.id}</small>
      </span>
      <strong>{request.title}</strong>
      <span className="request-location">
        <Icon name="map" size={14} />
        {request.location}
      </span>
      <p>{request.description}</p>
      <span className="request-tags">
        <span>
          <Icon name="tool" size={13} />
          {request.engineer}
        </span>
        <span>{request.category}</span>
      </span>
      <span className="request-card__footer">
        <span className="mini-avatar">
          {request.assignee ? request.assignee.charAt(0) : "—"}
        </span>
        <span>
          <small>{request.status}</small>
          <strong>{formatDate(request.nextUpdateAt ?? request.dueAt, true)}</strong>
        </span>
        <span className="comment-count">
          <Icon name="message" size={14} />
          {request.commentCount}
        </span>
      </span>
    </button>
  );
}

function RequestTable({
  requests,
  onOpenRequest,
}: {
  requests: MaintenanceRequest[];
  onOpenRequest: (request: MaintenanceRequest) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="data-table request-table">
        <thead>
          <tr>
            <th>Request</th>
            <th>Location</th>
            <th>Priority</th>
            <th>Engineer</th>
            <th>Status</th>
            <th>Assigned to</th>
            <th>Next update</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <tr key={request.id}>
              <td>
                <button
                  className="table-primary"
                  type="button"
                  onClick={() => onOpenRequest(request)}
                >
                  <strong>{request.title}</strong>
                  <span>
                    {request.id} · {request.source}
                  </span>
                </button>
              </td>
              <td>{request.location}</td>
              <td>
                <span className={priorityClass(request.priority)}>
                  {request.priority}
                </span>
              </td>
              <td>{request.engineer}</td>
              <td>
                <span className="status-chip">{request.status}</span>
              </td>
              <td>{request.assignee ?? "Unassigned"}</td>
              <td>{formatDate(request.nextUpdateAt, true)}</td>
              <td>
                <button
                  className="icon-button table-open"
                  type="button"
                  onClick={() => onOpenRequest(request)}
                  aria-label={`Open ${request.id}`}
                >
                  <Icon name="chevron" size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!requests.length && (
        <div className="table-empty">
          <Icon name="search" size={22} />
          <strong>No matching requests</strong>
          <span>Try a different search or filter.</span>
        </div>
      )}
    </div>
  );
}


/**
 * What Overview and Reports show when the job list could not be read.
 *
 * Deliberately has no numbers on it. The alternative — the real panels drawn
 * from an empty array — reads as a quiet month rather than a failure, and does
 * it in the two places somebody goes specifically to find out how much has been
 * spent.
 */
function WorkspaceUnavailable({
  onRetry,
  busy,
}: {
  onRetry: () => void;
  busy: boolean;
}) {
  return (
    <div className="section-stack">
      <section className="panel">
        <div className="view-empty">
          <h2>Your workspace could not be read</h2>
          <p>
            Nothing is shown here rather than something invented — every figure on
            this screen is counted from your jobs, and they did not load. Your data
            is not affected.
          </p>
          <button
            className="primary-button"
            type="button"
            onClick={onRetry}
            disabled={busy}
          >
            <Icon name="refresh" size={17} />
            {busy ? "Trying again…" : "Try again"}
          </button>
        </div>
      </section>
    </div>
  );
}

/*
 * COMPLIANCE'S HORIZON, AS ONE REMEMBERABLE VALUE.
 *
 * This page's control is not the reporting `PeriodPicker` — it is an EXPIRY
 * horizon ("what falls due in the next 90 days") with a two-date custom shape
 * beside it, and it is deliberately a different question. But it is a date
 * range the reader chose, so it has to survive leaving the page like the
 * others.
 *
 * Three pieces of state are stored as one token so the horizon and the two
 * dates can never come back out of storage disagreeing with each other:
 * a preset is itself, and a custom span is `custom:FROM..TO` with either end
 * allowed to be empty while it is being typed.
 */
const EXPIRY_PRESETS = new Set(["all", "30", "90", "180", "custom"]);

function isExpiryToken(value: string) {
  if (EXPIRY_PRESETS.has(value)) return true;
  if (!value.startsWith("custom:") || value.length > 64) return false;
  const span = value.slice("custom:".length);
  return span.includes("..") && /^[0-9.-]{0,21}$/.test(span);
}

const expiryToken = (window: string, from: string, to: string) =>
  window === "custom" ? `custom:${from}..${to}` : window;

function expiryParts(token: string) {
  if (!token.startsWith("custom:")) return { window: token, from: "", to: "" };
  const [from = "", to = ""] = token.slice("custom:".length).split("..");
  return { window: "custom", from, to };
}

function ComplianceView({
  stores: storeRows,
  complianceRecords,
  sectionKey,
  onManage,
  onNotify,
}: {
  stores: StoreRecord[];
  complianceRecords: WorkspaceSnapshot["compliance"];
  /**
   * WHICH PAGE THIS IS, for the range it remembers.
   *
   * The section id the shell is actually on — a built-in one, or a
   * workspace-defined section that draws this surface. It is the storage
   * namespace for this page's date range and nothing else, which is what
   * keeps one page's range out of another's. A display label would break the
   * moment somebody renamed a menu item.
   */
  sectionKey: string;
  onManage: (id?: string | null) => void;
  onNotify: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"All" | ComplianceState>("All");
  const [portfolio, setPortfolio] = useState("all");
  /*
   * One stored token, three values read back out of it. Every existing caller
   * below still sets one thing at a time; each setter rewrites the token with
   * the other two carried through, so choosing "Between two dates" cannot lose
   * a date already typed and typing a date cannot lose the horizon.
   */
  const [storedExpiry, setStoredExpiry] = useStoredPeriod(
    sectionKey ? `${sectionKey}:expiry` : "compliance:expiry",
    "all",
    isExpiryToken,
  );
  const {
    window: expiryWindow,
    from: expiryFrom,
    to: expiryTo,
  } = expiryParts(storedExpiry);
  const setExpiryWindow = (next: string) =>
    setStoredExpiry(expiryToken(next, expiryFrom, expiryTo));
  const setExpiryFrom = (next: string) =>
    setStoredExpiry(expiryToken("custom", next, expiryTo));
  const setExpiryTo = (next: string) =>
    setStoredExpiry(expiryToken("custom", expiryFrom, next));
  /*
   * A start and an end of the reader's own, for the expiry horizon.
   *
   * The preset horizons answer "what falls due in the next 90 days". They
   * cannot answer "what falls due in the quarter I am about to be audited on",
   * which is the question that gets asked in a compliance meeting — so
   * "Between two dates" is a fourth shape alongside them. It stays an EXPIRY
   * filter rather than becoming a reporting period: this page is about what is
   * coming, not what happened.
   */
  const [showAll, setShowAll] = useState(false);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const now = useCurrentTime();

  /*
   * The register is the workspace's compliance records, not the site table's.
   *
   * This screen used to read `stores[].compliance`, which meant it could only
   * ever describe stores that have a row in `sites` — ten seeded, fictional
   * ones. The Store Documentation board holds thirty-one real stores, and
   * twenty-one of them appeared on no compliance surface at all, including six
   * of the seven stores with an expired certificate. `/api/workspace` now
   * derives `compliance` from that board, so reading it here is what puts the
   * estate on the screen. Stores that are in `sites` still resolve to their
   * site id, so the portfolio filter, the drawer and Manage register keep
   * working exactly as before.
   */
  const scopedCompliance = useMemo(() => {
    if (portfolio === "all") return complianceRecords;
    return complianceRecords.filter((record) => record.siteId === portfolio);
  }, [complianceRecords, portfolio]);

  const records = useMemo(
    () => scopedCompliance.filter((record) => record.state !== "Not required"),
    [scopedCompliance],
  );

  /** Every store the register speaks for, whether or not it has a `sites` row. */
  const registerPortfolios = useMemo(() => {
    const byId = new Map<string, string>();
    for (const record of complianceRecords) {
      if (!byId.has(record.siteId)) byId.set(record.siteId, record.siteName);
    }
    return [
      { value: "all", label: "All portfolios" },
      ...[...byId]
        .map(([value, label]) => ({ value, label }))
        .sort((left, right) => left.label.localeCompare(right.label, "en-GB")),
    ];
  }, [complianceRecords]);

  const counts = useMemo(() => ({
    Compliant: records.filter((record) => record.state === "Compliant").length,
    "Expiring soon": records.filter((record) => record.state === "Expiring soon").length,
    Expired: records.filter((record) => record.state === "Expired").length,
    Missing: records.filter((record) => record.state === "Missing").length,
  }), [records]);
  const compliantPercent = Math.round(
    (counts.Compliant / Math.max(records.length, 1)) * 100,
  );
  const managerFor = (siteId: string) =>
    storeRows.find((store) => store.id === siteId)?.manager ?? "";
  const needle = query.trim().toLowerCase();
  const filteredRecords = records.filter((record) => {
    const matchesSearch = !needle ||
      [record.siteName, managerFor(record.siteId), record.kind, record.state]
        .some((value) => value.toLowerCase().includes(needle));
    const matchesStatus = filter === "All" || record.state === filter;
    const matchesWindow = (() => {
      if (expiryWindow === "custom") {
        // A half-open range is still useful: "everything after March" is a
        // question, and so is "everything before the audit".
        if (!record.expiry) return !expiryFrom && !expiryTo;
        const at = new Date(record.expiry).getTime();
        if (expiryFrom && at < new Date(`${expiryFrom}T00:00:00`).getTime()) return false;
        if (expiryTo && at > new Date(`${expiryTo}T23:59:59`).getTime()) return false;
        return true;
      }
      return (
        expiryWindow === "all" ||
        !record.expiry ||
        new Date(record.expiry).getTime() <= now + Number(expiryWindow) * 86_400_000
      );
    })();
    return matchesSearch && matchesStatus && matchesWindow;
  });
  const expiringTypes = Array.from(
    records
      .filter((record) => record.state === "Expired" || record.state === "Expiring soon" ||
        Boolean(record.expiry && new Date(record.expiry).getTime() <= now + 90 * 86_400_000))
      .reduce((map, record) => {
        map.set(record.kind, (map.get(record.kind) ?? 0) + 1);
        return map;
      }, new Map<string, number>()),
  )
    .map(([label, value], index) => ({
      label,
      value,
      color: ["#f05b22", "#f68b1f", "#f0a91f", "#5c82af", "#6f8793"][index % 5],
    }))
    .sort((left, right) => right.value - left.value);
  const scoreSegments: DonutSegment[] = [
    { label: "Compliant", value: counts.Compliant, color: "#12b4a8" },
    { label: "Expiring soon", value: counts["Expiring soon"], color: "#f0a91f" },
    { label: "Expired", value: counts.Expired, color: "#e2445c" },
    { label: "Missing", value: counts.Missing, color: "#5c82af" },
  ];
  /**
   * Who chases a certificate, from the Store Documentation capture.
   *
   * This used to substring-match the requirement name, which had no answer for
   * RAMS, the PLI or the store drawing — they contain none of the keywords, so
   * all three fell through to the store manager. Anything the board does not
   * define still falls back to the manager, which is the right answer for a
   * requirement an admin has added themselves.
   */
  const responsibilityFor = (kind: string, siteId: string) =>
    storeDocumentationResponsibility.get(kind) ||
    managerFor(siteId) ||
    "Store manager";

  /**
   * The store behind the "View" button.
   *
   * Most of the estate has no `sites` row — the Store Documentation board is
   * the only place twenty-one of these stores exist — so the drawer is built
   * from the register itself, taking the site record where there is one. Store
   * type and address come off the board row rather than being left blank or
   * invented.
   */
  const selectedStore = useMemo<StoreRecord | null>(() => {
    if (!selectedSiteId) return null;
    const forSite = complianceRecords.filter((record) => record.siteId === selectedSiteId);
    if (forSite.length === 0) return null;
    const documents = forSite.map((record) => ({
      kind: record.kind,
      state: record.state,
      expiry: record.expiry,
      fileCount: record.fileCount,
    }));
    const known = storeRows.find((store) => store.id === selectedSiteId);
    if (known) return { ...known, compliance: documents };
    return {
      id: selectedSiteId,
      name: forSite[0].siteName,
      type: forSite[0].siteType || "Store",
      region: "",
      lifecycle: "",
      status: "",
      address: forSite[0].siteAddress || "No address on the board",
      manager: "",
      openRequests: 0,
      annualBudgetPence: null,
      compliance: documents,
    };
  }, [complianceRecords, selectedSiteId, storeRows]);

  return (
    <div className="section-stack analytics-page">
      <section className="analytics-page-heading analytics-page-heading--wide-controls">
        <div><span>Portfolio assurance</span><h1>Compliance overview</h1></div>
        {/* A lapsed certificate is a job somebody has to do. Raised from the
            screen that reports it rather than retyped into the board. */}
        <RaiseTicketButton
          context={{ section: "Compliance" }}
          onRaised={(ticket) =>
            onNotify(`${ticket.reference ?? ticket.title} raised for ${ticket.siteName}.`)
          }
          onNotify={onNotify}
        />
        <AnalyticsToolbar
          portfolio={portfolio}
          portfolios={registerPortfolios}
          onPortfolioChange={setPortfolio}
          period={expiryWindow}
          periods={[
            { value: "all", label: "All expiry dates" },
            { value: "30", label: "Next 30 days" },
            { value: "90", label: "Next 90 days" },
            { value: "180", label: "Next 180 days" },
            { value: "custom", label: "Between two dates…" },
          ]}
          onPeriodChange={setExpiryWindow}
          onExport={() => downloadTableCsv(
            "maintsupp-compliance",
            ["Site", "Requirement", "Responsibility", "Due date", "Status"],
            filteredRecords.map((record) => [record.siteName, record.kind, responsibilityFor(record.kind, record.siteId), record.expiry, record.state]),
          )}
          exportLabel="Export register"
        >
          {/* Only when asked for, so the row is not two empty date boxes wide
              for the four readers in five who want a preset. */}
          {expiryWindow === "custom" && (
            <>
              <label className="analytics-period analytics-period--argument">
                <span className="visually-hidden">Expiring from</span>
                <input
                  aria-label="Expiring from"
                  type="date"
                  value={expiryFrom}
                  onChange={(event) => setExpiryFrom(event.target.value)}
                />
              </label>
              <label className="analytics-period analytics-period--argument">
                <span className="visually-hidden">Expiring until</span>
                <input
                  aria-label="Expiring until"
                  type="date"
                  value={expiryTo}
                  onChange={(event) => setExpiryTo(event.target.value)}
                />
              </label>
            </>
          )}
          <button className="analytics-toolbar__button" type="button" onClick={() => onManage(null)}>
            <Icon name="plus" size={17} /> Manage register
          </button>
          <label className="analytics-toolbar__search">
            <Icon name="search" size={17} />
            <input aria-label="Search certificates" type="search" placeholder="Search certificates…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <label>
            <Icon name="shield" size={17} />
            <select aria-label="Certificate status" value={filter} onChange={(event) => setFilter(event.target.value as "All" | ComplianceState)}>
              <option>All</option><option>Compliant</option><option>Expiring soon</option><option>Expired</option><option>Missing</option>
            </select>
          </label>
        </AnalyticsToolbar>
      </section>

      <section className="analytics-compliance-grid">
        <article className="analytics-panel analytics-compliance-score">
          <header><h2>Compliance score</h2></header>
          <div className="analytics-compliance-score__body">
            <DonutChart segments={scoreSegments} value={`${compliantPercent}%`} label={compliantPercent >= 80 ? "On track" : "Action required"} />
            <DonutLegend segments={scoreSegments} />
          </div>
          <p>{counts.Compliant} of {records.length} requirements on track</p>
        </article>

        <article className="analytics-panel analytics-certificate-register">
          <header><h2>Certificate register</h2><span>{filteredRecords.length} records</span></header>
          <div className="table-scroll">
            <table className="analytics-table analytics-table--mobile-cards">
              <thead><tr><th>Site</th><th>Requirement</th><th>Responsibility</th><th>Due date</th><th>Status</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {filteredRecords.slice(0, showAll ? filteredRecords.length : 8).map((record) => (
                  <tr key={record.id}>
                    <td data-label="Site"><strong>{record.siteName}</strong></td>
                    <td data-label="Requirement">{record.kind}</td>
                    <td data-label="Responsibility">{responsibilityFor(record.kind, record.siteId)}</td>
                    <td data-label="Due date">{record.expiry ? formatDate(record.expiry) : "—"}</td>
                    <td data-label="Status"><span className={complianceTone(record.state)}><span />{record.state}</span></td>
                    <td data-label="Actions"><div className="table-row-actions"><button className="table-text-action" type="button" onClick={() => setSelectedSiteId(record.siteId)}>View</button><button className="table-text-action" type="button" onClick={() => onManage(record.id.startsWith("board:") ? null : record.id)}>Edit <Icon name="chevron" size={14} /></button></div></td>
                  </tr>
                ))}
                {!filteredRecords.length && <tr><td className="analytics-empty" colSpan={6}>No certificate records match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
          {filteredRecords.length > 8 && (
            <button className="analytics-panel-footer" type="button" onClick={() => setShowAll((current) => !current)}>
              {showAll ? "Show summary" : "View all certificates"} <Icon name="chevron" size={15} />
            </button>
          )}
        </article>
      </section>

      <section className="analytics-panel analytics-expiry-types">
        <header><div><h2>Expiring certificate types</h2><span>Certificates expired or due in the next 90 days</span></div></header>
        <HorizontalBars items={expiringTypes.length ? expiringTypes : [{ label: "No certificates due", value: 0, color: "#5c82af" }]} />
        <button className="analytics-panel-footer" type="button" onClick={() => { setFilter("Expiring soon"); setExpiryWindow("90"); }}>
          View all expiring <Icon name="chevron" size={15} />
        </button>
      </section>

      {/* A twelve-month forward view, so renewals are planned rather than chased. */}
      <section className="insight-grid">
        <ComplianceExpiryTimeline compliance={scopedCompliance} now={now} />
      </section>

      {selectedStore && (
        <StoreComplianceDrawer
          store={selectedStore}
          onClose={() => setSelectedSiteId(null)}
        />
      )}
    </div>
  );
}

/**
 * The Planned page — the Operations calendar with its own date range above it
 * and the shared planned-maintenance register below.
 *
 * THE CALENDAR ITSELF IS NOT HERE ANY MORE. It is
 * `OperationsCalendarPanel` in ./calendar-surface.tsx, because the board's
 * Calendar view TAB mounts the same panel — the owner went looking for the
 * calendar there, found a bare month grid with none of this on it, and was
 * right to call the previous report unaccepted. One component now, two places
 * that host it.
 *
 * What is left in this file is what belongs to the PAGE rather than to the
 * calendar: the heading, the page's own date range, and the register.
 *
 * THE PAGE'S OWN STATE, AND NOBODY ELSE'S. A range chosen here does not follow
 * the reader to Reports, and Reports does not reach in here — this product's
 * date ranges are per page by decision.
 */
function CalendarView({
  requests,
  planned,
  complianceRecords,
  sectionKey,
  onManage,
  onOpenRequest,
  onOpenCompliance,
  onNotify,
  onJobDateChange,
  onComplianceDateChange,
}: {
  /**
   * WHICH PAGE THIS IS, for the range it remembers.
   *
   * The section id the shell is actually on — a built-in one, or a
   * workspace-defined section that draws this surface. It is the storage
   * namespace for this page's date range and nothing else, which is what
   * keeps one page's range out of another's. A display label would break the
   * moment somebody renamed a menu item.
   */
  sectionKey: string;
  requests: MaintenanceRequest[];
  planned: WorkspacePlannedItem[];
  complianceRecords: WorkspaceSnapshot["compliance"];
  onManage: (id?: string | null) => void;
  onOpenRequest: (request: MaintenanceRequest) => void;
  /* A renewal on the grid opens the certificate behind it, the same way a job
     opens its work order — see `CalendarEvent.kind`. */
  onOpenCompliance: (id: string | null) => void;
  onNotify: (message: string) => void;
  /** Writes a job's own date field. Rejects with a readable message on refusal. */
  onJobDateChange: (
    id: string,
    field: "dueAt" | "requestedAt" | "completedAt" | "nextUpdateAt",
    day: string | null,
  ) => Promise<void>;
  /** Writes a certificate expiry back to whichever store actually holds it. */
  onComplianceDateChange: (
    target: CalendarWriteTarget,
    day: string,
  ) => Promise<void>;
}) {
  const nowMs = useMemo(() => Date.now(), []);

  /*
   * THE PAGE'S OWN RANGE, and what it is for on a calendar.
   *
   * The grid already answers "what is happening in March". The range answers a
   * different question — "show me only the next quarter's renewals" — and it
   * filters what is DRAWN. Choosing a range also moves nothing on its own; the
   * panel says how many events it removed and offers one click to clear it, so
   * a range can never quietly empty a month the reader navigated to.
   *
   * It does NOT default to the past. This screen inherited "Last 90 days" from
   * the analytics pages, where `analyticsWindow` reads `now - 90 days … now + 1
   * day`. On a planning calendar that hid everything due the day after tomorrow
   * or later: of 28 jobs carrying a due date, 13 were drawn and 15 hidden, most
   * of them the future work the page exists to show.
   */
  const [period, setPeriod] = useStoredPeriod(sectionKey, "all");
  const periodWindow = resolvePeriod(period, nowMs);

  return (
    <div className="section-stack">
      <section className="section-header">
        <div>
          <span className="eyebrow-chip">
            <Icon name="calendar" size={15} />
            Planned visits &amp; deadlines
          </span>
          <h1>Operations calendar</h1>
          <p>
            See booked visits, response deadlines and compliance renewals in one
            schedule.
          </p>
        </div>
        <div className="section-header__actions">
          <PeriodPicker value={period} onChange={setPeriod} now={nowMs} />
          <button className="primary-button" type="button" onClick={() => onManage(null)}><Icon name="plus" size={17} />Manage planned work</button>
        </div>
      </section>

      {/*
        The calendar first — Stage 23.

        Planned maintenance opened on the register: a list of the next six
        tasks, with the month grid below the fold on a phone and often below it
        on a laptop. The register answers "what is scheduled"; the calendar
        answers "what is scheduled WHEN", which is the question somebody opens
        a planned-maintenance screen to ask, and is how monday's calendar view
        behaves. The register keeps everything it had, one scroll down.
      */}
      <OperationsCalendarPanel
        requests={requests}
        complianceRecords={complianceRecords}
        periodWindow={
          periodWindow &&
          Number.isFinite(periodWindow.start) &&
          Number.isFinite(periodWindow.end)
            ? { start: periodWindow.start, end: periodWindow.end }
            : null
        }
        onShowAllDates={() => setPeriod("all")}
        onOpenRequest={onOpenRequest}
        onOpenCompliance={onOpenCompliance}
        onNotify={onNotify}
        onJobDateChange={onJobDateChange}
        onComplianceDateChange={onComplianceDateChange}
      />

      <section className="panel planned-register-panel">
        <div className="planned-register-panel__heading"><div><span>Shared planned maintenance</span><strong>{planned.filter((item) => item.status !== "Cancelled").length} active tasks</strong></div><button type="button" onClick={() => onManage(null)}>Open full register <Icon name="chevron" size={15} /></button></div>
        <div className="planned-register-list">
          {planned.filter((item) => item.status !== "Cancelled").slice(0, 6).map((item) => (
            <button type="button" key={item.id} onClick={() => onManage(item.id)}>
              <span className="planned-register-date"><strong>{new Date(item.nextDueAt).getDate()}</strong><small>{formatMonthShort(item.nextDueAt)}</small></span>
              <span><strong>{item.title}</strong><small>{item.siteName} · {item.frequency}</small></span>
              <span className="status-chip">{item.status}</span>
              <Icon name="chevron" size={15} />
            </button>
          ))}
          {!planned.length && <div className="planned-register-empty">Add a planned task to connect recurring work to this calendar.</div>}
        </div>
      </section>

    </div>
  );
}

function DocumentsView({
  files,
  sectionKey,
}: {
  files: FileRecord[];
  /**
   * WHICH PAGE THIS IS, for the range it remembers.
   *
   * The section id the shell is actually on — a built-in one, or a
   * workspace-defined section that draws this surface. It is the storage
   * namespace for this page's date range and nothing else, which is what
   * keeps one page's range out of another's. A display label would break the
   * moment somebody renamed a menu item.
   */
  sectionKey: string;
}) {
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedFile, setSelectedFile] = useState<FileRecord | null>(null);
  /*
   * This page's own reporting range, defaulting to a year because a document
   * register is consulted over a longer horizon than a job board. It is this
   * page's state and nobody else's — a range chosen here does not follow the
   * reader to Reports.
   *
   * It filters the register itself, not just the label: `withinPeriod` is
   * applied before the search, so the counts above the table, the export and
   * the rows all describe the same set.
   */
  const [period, setPeriod] = useStoredPeriod(sectionKey, "12m");
  /*
   * The clock is read once per render pass, not on every render.
   *
   * `Date.now()` in the body moved the window a few milliseconds every time
   * React re-rendered for any reason, so no two paints filtered on quite the
   * same range and nothing downstream could be memoised against it. This is
   * the hook Overview and Reports already use; it ticks on the minute.
   */
  const now = useCurrentTime();
  const window = resolvePeriod(period, now);
  /*
   * `stampWithinPeriod`, not `Date.parse`, and the difference is a day.
   *
   * `uploadedAt` arrives in the two forms this database stores — a bare
   * `2026-08-03` and a `2026-08-09 07:39:18` — and `Date.parse` reads the
   * first as UTC midnight and the second as local, while every bound above is
   * built from LOCAL midnight. West of Greenwich a file uploaded on the first
   * of the month fell out of that month. The comparator that knows about both
   * forms is the one the reporting screens already share.
   *
   * It also replaces a guard that could never fire: `resolvePeriod` always
   * returns an object, so `if (!window) return true` was dead, and a
   * half-typed custom range left `start`/`end` as NaN — every comparison
   * false, every file hidden, and the register silently empty with no reason
   * given. `stampWithinPeriod` returns false for an unrecognised window and
   * the panel below now says why.
   */
  const withinPeriod = (file: FileRecord) =>
    stampWithinPeriod(file.uploadedAt, period, now);
  const inRange = files.filter(withinPeriod);
  const filtered = inRange.filter((file) =>
    [file.name, file.kind, file.site, file.requestId ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const currentMonth = new Date().toISOString().slice(0, 7);

  return (
    <div className="section-stack">
      <section className="section-header">
        <div>
          <span className="eyebrow-chip">
            <Icon name="folder" size={15} />
            Searchable evidence
          </span>
          <h1>Documents & evidence</h1>
          <p>
            Maintenance photos, certificates, approvals and invoices with a
            clear owner and source.
          </p>
        </div>
        <div className="section-header__controls">
          <PeriodPicker value={period} onChange={setPeriod} now={now} />
          <button
            className="secondary-button"
            type="button"
            onClick={() => downloadFileRegister(filtered)}
          >
            <Icon name="download" size={17} />
            Export register
          </button>
        </div>
      </section>

      <section className="document-stat-grid">
        <div>
          <Icon name="folder" size={20} />
          <span>
            <small>Documents in range</small>
            <strong>{inRange.length}</strong>
          </span>
        </div>
        <div>
          <Icon name="upload" size={20} />
          <span>
            <small>Added this month</small>
            <strong>{inRange.filter((file) => file.uploadedAt.startsWith(currentMonth)).length}</strong>
          </span>
        </div>
        <div>
          <Icon name="alert" size={20} />
          <span>
            <small>Require attention</small>
            <strong>{inRange.filter((file) => file.status === "Expiring soon").length}</strong>
          </span>
        </div>
      </section>

      <section className="panel documents-panel">
        <div className="workspace-toolbar">
          <label className="search-field">
            <Icon name="search" size={18} />
            <input
              aria-label="Search documents"
              placeholder="Search files, sites or work order IDs…"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="view-switch" aria-label="Change document view">
            <button
              type="button"
              className={viewMode === "board" ? "is-active" : ""}
              onClick={() => setViewMode("board")}
              aria-label="Grid view"
            >
              <Icon name="grid" size={17} />
            </button>
            <button
              type="button"
              className={viewMode === "list" ? "is-active" : ""}
              onClick={() => setViewMode("list")}
              aria-label="List view"
            >
              <Icon name="list" size={17} />
            </button>
          </div>
        </div>

        {viewMode === "list" ? (
          <div className="table-scroll">
            <table className="data-table document-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Type</th>
                  <th>Site</th>
                  <th>Work order</th>
                  <th>Uploaded</th>
                  <th>Size</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((file) => (
                  <tr key={file.id}>
                    <td>
                      <button
                        type="button"
                        className="file-name-cell"
                        onClick={() => setSelectedFile(file)}
                      >
                        <span>
                          <Icon name="document" size={17} />
                        </span>
                        <strong>{file.name}</strong>
                      </button>
                    </td>
                    <td>{file.kind}</td>
                    <td>{file.site}</td>
                    <td>{file.requestId ?? "—"}</td>
                    <td>{formatDate(file.uploadedAt)}</td>
                    <td>{file.size}</td>
                    <td>
                      <span
                        className={`file-status file-status--${file.status
                          .toLowerCase()
                          .replaceAll(" ", "-")}`}
                      >
                        {file.status}
                      </span>
                    </td>
                    <td>
                      <button
                        className="icon-button table-open"
                        type="button"
                        aria-label={`Open ${file.name}`}
                        onClick={() => setSelectedFile(file)}
                      >
                        <Icon name="chevron" size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
                {/*
                  A register that filters had no way of saying it had filtered
                  everything out: an empty range drew a header row over
                  nothing, which reads as a broken page rather than an answer.
                  The range and the search fail differently and are named
                  separately, and an unrecognised window says what is missing
                  from it instead of pretending the estate holds no documents.
                */}
                {!filtered.length && (
                  <tr>
                    <td className="analytics-empty" colSpan={8}>
                      {!window.recognised
                        ? window.reason
                        : inRange.length
                          ? `No document in ${window.label} matches "${query.trim()}".`
                          : `No documents were uploaded in ${window.label}.`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="document-grid">
            {filtered.map((file) => (
              <button
                type="button"
                key={file.id}
                onClick={() => setSelectedFile(file)}
              >
                <span className="document-grid__icon">
                  <Icon name="document" size={24} />
                </span>
                <strong>{file.name}</strong>
                <span>{file.kind}</span>
                <small>
                  {file.site} · {file.size}
                </small>
              </button>
            ))}
            {/* The card view empties for the same two reasons the table does,
                and said the same nothing about either. */}
            {!filtered.length && (
              <p className="analytics-empty">
                {!window.recognised
                  ? window.reason
                  : inRange.length
                    ? `No document in ${window.label} matches "${query.trim()}".`
                    : `No documents were uploaded in ${window.label}.`}
              </p>
            )}
          </div>
        )}
      </section>

      {selectedFile && (
        <FileDetailDrawer
          file={selectedFile}
          onClose={() => setSelectedFile(null)}
        />
      )}
    </div>
  );
}


/**
 * The WhatsApp mark, filled rather than stroked.
 *
 * Every other glyph on this row is a 1.8px outline, and this one deliberately
 * is not: WhatsApp is a brand a user recognises by its silhouette, and an
 * outlined approximation of it at 14px reads as "some bubble" rather than as
 * "the green one on my phone". Recognition is the whole job here — the row
 * exists so a coordinator can tell at a glance which of two numbers opens
 * WhatsApp — so the real shape wins over set consistency.
 *
 * It takes `currentColor`, so it is the link colour in both themes rather than
 * a hard-coded #25d366 that would fail contrast on the light ground.
 */
function WhatsAppGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      height={size}
      width={size}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M12.04 2c-5.5 0-9.96 4.46-9.96 9.96 0 1.76.46 3.48 1.34 5L2 22l5.2-1.36a9.9 9.9 0 0 0 4.84 1.24h.01c5.49 0 9.95-4.46 9.95-9.96A9.9 9.9 0 0 0 19.08 4.9 9.9 9.9 0 0 0 12.04 2Zm0 1.85c2.16 0 4.19.84 5.72 2.37a8.05 8.05 0 0 1 2.37 5.74c0 4.47-3.63 8.1-8.1 8.1a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.1.81.83-3.02-.2-.31a8.05 8.05 0 0 1-1.25-4.3c0-4.47 3.64-8.1 8.11-8.06Zm-3.5 4.02c-.16 0-.43.06-.66.31-.22.25-.86.84-.86 2.05 0 1.2.88 2.37 1 2.53.13.17 1.72 2.63 4.17 3.69.58.25 1.04.4 1.4.51.58.19 1.11.16 1.53.1.47-.07 1.44-.59 1.64-1.16.2-.57.2-1.06.14-1.16-.06-.1-.22-.16-.47-.28-.24-.13-1.44-.72-1.66-.8-.23-.08-.39-.12-.55.12-.16.25-.63.8-.77.96-.14.17-.29.19-.53.06-.25-.12-1.04-.38-1.97-1.22a7.4 7.4 0 0 1-1.37-1.7c-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.44.12-.14.16-.24.24-.4.08-.17.04-.31-.02-.44-.06-.12-.55-1.33-.76-1.82-.2-.47-.4-.41-.55-.41h-.47Z" />
    </svg>
  );
}

/**
 * A contractor's phone, WhatsApp and email, as things you can act on.
 *
 * These columns have existed on `contractors` since Stage 0 and the workspace
 * payload has always carried them; nothing rendered either, so the register
 * told you who a contractor was and gave you no way to reach them. On a phone —
 * which is where this is used, standing in a shop — a number you cannot tap is
 * a number you have to memorise and retype.
 *
 * WHY THE HREFS COME FROM contact-links.ts RATHER THAN A TEMPLATE HERE.
 *
 * The old `tel:` was built inline and that was fine, because a dialler is
 * forgiving and the user is standing there watching it. `wa.me` is neither: it
 * addresses people by full international number and answers a national one —
 * `07812 224644`, the shape every number on a van is written in — with "the
 * phone number shared via url is invalid". So a WhatsApp row that always
 * linked would be a button that is broken for most of the register.
 *
 * `whatsappHref` returns null rather than inventing a country code, and null
 * here means PLAIN TEXT, not a hidden row: the number is still readable and
 * still dialable by hand, it simply is not dressed up as an action that would
 * dead-end. The same guard is on the telephone row, for the four-digit
 * extensions that are not numbers anybody can be reached on.
 *
 * The numbers print as stored rather than reformatted: an operator recognises
 * the spacing they typed, and guessing at a national format is how a leading
 * zero goes missing.
 *
 * A contractor with nothing at all is not an error — most rows have no phone
 * yet — so it says so quietly rather than rendering an empty cell that reads
 * as a bug. A contractor with no WhatsApp gets no WhatsApp row at all: a dash
 * there would only make every row in the table taller to say nothing.
 */
function ContractorContact({
  contractor,
}: {
  contractor: {
    name: string;
    contactName?: string | null;
    email?: string | null;
    phone?: string | null;
    whatsappNumber?: string | null;
  };
}) {
  const phone = (contractor.phone ?? "").trim();
  const email = (contractor.email ?? "").trim();
  const person = (contractor.contactName ?? "").trim();
  const whatsapp = (contractor.whatsappNumber ?? "").trim();

  const dial = telHref(phone);
  const chat = whatsappHref(whatsapp);

  if (!phone && !email && !person && !whatsapp) {
    return <span className="contractor-contact__none">No contact details</span>;
  }

  return (
    <span className="contractor-contact">
      {/* The person leads, because a number nobody has a name for is the
          thing that gets dialled last. */}
      {person && <strong className="contractor-contact__person">{person}</strong>}
      {phone &&
        (dial ? (
          <a
            className="contractor-contact__link"
            href={dial}
            aria-label={`Call ${contractor.name} on ${phone}`}
          >
            <Icon name="phone" size={14} />
            {phone}
          </a>
        ) : (
          /* Too short to be a number anybody answers — an internal extension,
             usually. Shown, because the coordinator may still know what to do
             with it; not linked, because the handset would not. */
          <span className="contractor-contact__plain">
            <Icon name="phone" size={14} />
            {phone}
          </span>
        ))}
      {/* Directly under the telephone row, because the two are read as a pair:
          "this is their number, and this is the one that opens WhatsApp". */}
      {whatsapp &&
        (chat ? (
          <a
            className="contractor-contact__link contractor-contact__link--whatsapp"
            href={chat}
            target="_blank"
            rel="noreferrer"
            aria-label={`Message ${contractor.name} on WhatsApp at ${whatsapp}`}
          >
            <WhatsAppGlyph />
            {whatsapp}
          </a>
        ) : (
          <span
            className="contractor-contact__plain contractor-contact__plain--whatsapp"
            /* The tooltip is for the mouse. It is NOT the accessible answer —
               `title` on a plain span is not reliably announced — which is why
               the same sentence is also in the text below. */
            title="Add the country code to make this a WhatsApp link"
          >
            <WhatsAppGlyph />
            {whatsapp}
            {/*
              * Said out loud, because everything that distinguishes this row
              * from the linked one is visual: no underline, a quieter colour,
              * no pointer. A screen reader would otherwise hear a WhatsApp
              * number and a glyph it cannot see, with nothing to say that
              * activating it does nothing.
              */}
            <span className="visually-hidden">
              {" "}
              — not a WhatsApp link; the country code is missing
            </span>
          </span>
        ))}
      {email && (
        <a
          className="contractor-contact__link"
          href={`mailto:${email}`}
          aria-label={`Email ${contractor.name} at ${email}`}
        >
          <Icon name="inbox" size={14} />
          {email}
        </a>
      )}
    </span>
  );
}

function ContractorsView({
  contractors: registeredContractors,
  requests,
  sectionKey,
  onManage,
}: {
  contractors: WorkspaceContractor[];
  requests: MaintenanceRequest[];
  /**
   * WHICH PAGE THIS IS, for the range it remembers.
   *
   * The section id the shell is actually on — a built-in one, or a
   * workspace-defined section that draws this surface. It is the storage
   * namespace for this page's date range and nothing else, which is what
   * keeps one page's range out of another's. A display label would break the
   * moment somebody renamed a menu item.
   */
  sectionKey: string;
  onManage: (id?: string | null) => void;
}) {
  const fallbackContractors = useMemo<WorkspaceContractor[]>(
    () =>
      Array.from(
        requests.reduce((map, request) => {
          const name = request.contractor ?? "Unassigned";
          const current = map.get(name) ?? { name, assignedJobs: 0, completedJobs: 0, spend: 0, urgentJobs: 0, trades: new Set<string>() };
          current.assignedJobs += 1;
          current.completedJobs += isClosedRequest(request) ? 1 : 0;
          current.spend += request.cost ?? 0;
          current.urgentJobs += request.priority === "Urgent" && isOpenRequest(request) ? 1 : 0;
          current.trades.add(request.category);
          map.set(name, current);
          return map;
        }, new Map<string, { name: string; assignedJobs: number; completedJobs: number; spend: number; urgentJobs: number; trades: Set<string> }>()),
      ).map(([, contractor]) => ({
        id: `contractor-${contractor.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        name: contractor.name,
        email: null,
        phone: null,
        /*
         * Null, and never the phone number.
         *
         * These rows are synthesised from the jobs a name appears on, so there
         * is no register row behind them and nothing here is known. Copying
         * `phone` across would be the one mistake the WhatsApp work is written
         * against: a number reached this way has no country code, `wa.me`
         * refuses it, and the register would show a contractor as messageable
         * on the strength of a value nobody entered.
         */
        whatsappNumber: null,
        // Derived from the jobs, so there is no register row carrying these.
        contactName: null,
        address: null,
        notes: null,
        dayRatePence: null,
        serviceCategories: Array.from(contractor.trades),
        coverageAreas: ["UK"],
        certifications: [],
        insuranceExpiry: null,
        availability: contractor.name === "Unassigned" ? "Inactive" : "Available",
        rating: null,
        active: contractor.name !== "Unassigned",
        assignedJobs: contractor.assignedJobs,
        completedJobs: contractor.completedJobs,
        urgentJobs: contractor.urgentJobs,
        spend: contractor.spend,
      })),
    [requests],
  );
  const roster = registeredContractors.length ? registeredContractors : fallbackContractors;

  /*
   * THE PAGE'S OWN REPORTING RANGE.
   *
   * "Assigned 40, completed 38" is a different claim over a quarter than over
   * five years, and this page had no way to say which it meant. The register
   * itself — who they are, what they cover, what they are certified for — is
   * not time-bound and never filters; the WORK counts beside it are, so they
   * are recomputed from the jobs inside the window rather than taken from the
   * workspace payload's all-time totals. A contractor with no work in the
   * window stays listed, showing zeroes, because "we use them and they did
   * nothing this quarter" is the answer the reader came for.
   */
  const [period, setPeriod] = useStoredPeriod(sectionKey, "12m");
  // Once per render pass, and on the minute — not a fresh instant on every
  // render, which gave two paints two slightly different windows.
  const nowMs = useCurrentTime();
  const periodWindow = resolvePeriod(period, nowMs);
  /*
   * THIS PAGE DATES WORK BY WHEN IT WAS FINISHED, and that is deliberate.
   *
   * Every other reporting screen filters on `requestedAt`, because it is
   * asking what was raised in a window. This one asks what a contractor DID in
   * a window, and a job raised in June and finished in August is August's work
   * to them. `completedAt ?? requestedAt` keeps open jobs in view under the
   * date they were raised, which is the only date they have. Said here because
   * a reader comparing this page's "38 completed" against the Reports total
   * will otherwise find two honest numbers that do not add up, and nothing on
   * either screen explaining why.
   *
   * The comparator is the shared one for the same reason Documents' is: a bare
   * `YYYY-MM-DD` read by `Date.parse` is UTC midnight measured against local
   * bounds, and the guard it replaces — `if (!periodWindow) return true` —
   * could never fire, so a half-typed custom range emptied the table with no
   * explanation instead of saying it was unfinished.
   *
   * AND THERE IS NO COST DATE TO USE INSTEAD. `cost` is monday's "Cost of
   * Works" number; it carries no date of its own, the `invoice` column beside
   * it is free text and empty on every row, and the `invoices` table — which
   * does have `due_at` and `paid_at` — has never been read or written by any
   * code here. So `completedAt ?? requestedAt` is not a proxy chosen over a
   * transaction date; it is the only date these rows have. On staging, 10 of
   * the 12 costed jobs have no completion date at all, so for most of them this
   * dates spend by when the work was REQUESTED. A reader billing from the Spend
   * column needs to know that, and now the code says it.
   *
   * THE RANGE IS THE ONLY THING THAT STILL SEPARATES THIS TABLE FROM THE
   * DRAWER. `/api/workspace` carries `assignedJobs`/`completedJobs`/
   * `urgentJobs`/`spend` per contractor with no date filter at all — all-time —
   * and the manage drawer prints its "N jobs" straight from that. The lifecycle
   * scope and the "completed" rule are now identical on both sides
   * (`liveWorkOrder` and `completedJobPredicate` in app/api/workspace/route.ts
   * are this page's `countsAsWorkOrder` and `isClosedRequest`), so under "All
   * records" the two agree exactly, row for row — asserted by
   * tests/workstream-six-contractor-scope.test.mjs. Under any narrower period
   * they differ by the rows outside the window, which is the period doing its
   * job and not a disagreement.
   */
  const inWindow = (request: MaintenanceRequest) =>
    countsAsWorkOrder(request) &&
    stampWithinPeriod(request.completedAt ?? request.requestedAt, period, nowMs);
  const scopedRequests = requests.filter(inWindow);

  /*
   * How many rows in this roster answer to each name.
   *
   * Two contractors can share one, because nothing stops them: no unique index
   * on `contractors.name` and no duplicate check on the create. When that
   * happens the name branch below matches BOTH, so one unlinked job was
   * counted against each of them and the Tracked spend tile — which sums these
   * per-row figures — reported a single GBP 999 job as GBP 1,998.
   */
  const rosterPerName = new Map<string, number>();
  for (const entry of roster) {
    rosterPerName.set(entry.name, (rosterPerName.get(entry.name) ?? 0) + 1);
  }

  const contractors = roster.map((contractor) => {
    /*
     * THE ID FIRST, AND THE NAME ONLY WHERE THERE IS NO ID.
     *
     * This line attributed work by matching the job's contractor NAME against
     * the register row's name, and a name is not an identity. Renaming a
     * contractor therefore zeroed their whole history — assigned, completed,
     * urgent AND spend — while `contractor_id` on every one of those jobs went
     * on pointing straight at them. S3 replayed this function over the live
     * `/api/maintenance` payload and measured the drop: `{assigned:1,
     * completed:0, urgent:1, spend:250}` → `{0,0,0,0}` on rename, server and
     * client identically. The server half is fixed; this is the half the
     * reader actually sees, because the four numbers in the table are
     * recomputed here rather than taken from the payload — that is what the
     * page's own reporting period requires, and it is also why fixing the API
     * alone left the table wrong.
     *
     * The two branches are disjoint per job: a job with an id is matched by
     * the id and by nothing else, a job without one falls back to the name. So
     * no job can reach two contractors and none can be counted twice — the
     * same partition property the server-side aggregate relies on.
     *
     * `fallbackContractors` above synthesises ids from the name
     * (`contractor-${slug}`) and those are NOT register ids. The predicate is
     * still right there: that roster only exists when the register is empty,
     * and a workspace with no contractors has no job carrying a valid
     * `contractor_id` either, so every synthesised row takes the name branch
     * exactly as before. Matching those ids would be the bug, not the fix.
     *
     * And a name TWO of them share attributes to neither, matching both the
     * server aggregate and `resolveContractorLink`: a register that cannot say
     * which contractor a name means cannot say whose job it was. An ambiguous
     * name under-counting is visible and fixable; double-counting silently
     * inflates a figure somebody bills from.
     */
    const nameIsUnique = (rosterPerName.get(contractor.name) ?? 0) <= 1;
    const theirs = scopedRequests.filter((request) =>
      request.contractorId
        ? request.contractorId === contractor.id
        : nameIsUnique && request.contractor === contractor.name);
    return {
      ...contractor,
      assignedJobs: theirs.length,
      completedJobs: theirs.filter(isClosedRequest).length,
      urgentJobs: theirs.filter((request) => request.priority === "Urgent" && isOpenRequest(request)).length,
      spend: theirs.reduce((sum, request) => sum + (request.cost ?? 0), 0),
    };
  });

  return (
    <div className="section-stack">
      <section className="section-header"><div><span className="eyebrow-chip"><Icon name="users" size={15} />Managed network</span><h1>Contractors</h1><p>Qualifications, coverage, assigned work, completion performance and costs in one operational register.</p></div>
        {/*
          * Two controls, not three.
          *
          * "Raise a ticket" was here on the reasoning that somebody looking at
          * a contractor is usually about to give them something to do. It is
          * the wrong reading of this page: a ticket is raised against a SITE,
          * and the control's own dialog says so — it opens with no site chosen
          * and nothing on this screen to choose one from, because a contractor
          * is not a location. Sites, Units and the compliance tracker keep it
          * for exactly the reason it does not belong here: on those screens the
          * row you are looking at IS the thing the ticket is about.
          *
          * Removing it also gives the row back to the two controls that are
          * about this page — the period the figures are measured over, and the
          * register itself — which is why the two are allowed to sit at their
          * natural widths below rather than being squeezed to fit a third.
          */}
        <div className="section-header__actions section-header__actions--pair">
          <PeriodPicker value={period} onChange={setPeriod} now={nowMs} />
          <button className="primary-button" type="button" onClick={() => onManage(null)}><Icon name="plus" size={17} />Manage contractors</button>
        </div></section>
      <section className="site-stat-grid">
        <div><span className="site-stat-icon"><Icon name="users" size={19} /></span><small>Contractors</small><strong>{contractors.filter((item) => item.name !== "Unassigned").length}</strong></div>
        <div><span className="site-stat-icon site-stat-icon--teal"><Icon name="check" size={19} /></span><small>Completed jobs</small><strong>{contractors.reduce((sum, item) => sum + item.completedJobs, 0)}</strong></div>
        <div><span className="site-stat-icon site-stat-icon--orange"><Icon name="alert" size={19} /></span><small>Urgent actions</small><strong>{contractors.reduce((sum, item) => sum + item.urgentJobs, 0)}</strong></div>
        <div><span className="site-stat-icon site-stat-icon--green"><Icon name="chart" size={19} /></span><small>Tracked spend</small><strong>{formatMoney(contractors.reduce((sum, item) => sum + item.spend, 0))}</strong></div>
      </section>
      <section className="panel sites-panel"><div className="table-scroll"><table className="data-table sites-table">
        <thead><tr><th>Contractor</th><th>Contact</th><th>Service categories</th><th>Coverage</th><th>Day rate</th><th>Assigned</th><th>Completed</th><th>Completion rate</th><th>Open urgent</th><th>Spend</th><th aria-label="Actions" /></tr></thead>
        <tbody>{contractors.map((contractor) => (
          /*
            THE ONE STATE THIS TABLE COULD NOT SHOW.

            Eleven columns, and neither of the register's two states was among
            them. Proved on a fixture: archiving a contractor writes
            `active:false, availability:"Inactive"` — confirmed against
            /api/workspace — and its row here stayed byte-identical to a live
            one. Nothing on the page distinguished a contractor you can call
            today from one somebody took off the register last month.

            A twelfth column was the wrong answer: the table already scrolls
            sideways inside `.table-scroll` from 1440 down, and a column that is
            blank on all but a handful of rows buys that scroll for nothing. So
            the flag rides with the name, where the reader already is.

            Labelled, and with the word `recordSubtitle` uses for the same flag,
            because "Archived" and the availability value "Inactive" are two
            different fields and this page has spent a stage learning not to
            print one where the other is meant. The hidden half of the sentence
            says which field it is out loud, for a reader who cannot see that it
            is attached to the name rather than to the availability nobody
            prints here.
          */
          <tr key={contractor.id}><td><span className="site-name-cell"><span><Icon name="users" size={17} /></span><strong>{contractor.name}</strong>{!contractor.active && <span className="contractor-archived-chip">Archived<span className="visually-hidden"> — off the register; this is not their availability</span></span>}</span></td><td data-label="Contact"><ContractorContact contractor={contractor} /></td><td>{contractor.serviceCategories.join(", ") || "Not specified"}</td><td>{contractor.coverageAreas.join(", ") || "Not specified"}</td><td>{contractor.dayRatePence === null || contractor.dayRatePence === undefined ? "—" : formatMoney(contractor.dayRatePence / 100)}</td><td>{contractor.assignedJobs}</td><td>{contractor.completedJobs}</td><td>{Math.round((contractor.completedJobs / Math.max(contractor.assignedJobs, 1)) * 100)}%</td><td>{contractor.urgentJobs}</td><td>{formatMoney(contractor.spend)}</td><td><button className="icon-button table-open" type="button" aria-label={`Edit ${contractor.name}`} onClick={() => onManage(contractor.id)}><Icon name="chevron" size={16} /></button></td></tr>
        ))}
        {!contractors.length && (
          <tr>
            <td className="analytics-empty" colSpan={11}>
              {periodWindow.recognised
                ? "No contractors are registered yet, and no job in this period names one."
                : periodWindow.reason}
            </td>
          </tr>
        )}</tbody>
      </table></div></section>
    </div>
  );
}

/**
 * How often an issue recurs — measured against the window it was counted in.
 *
 * The column used to read the raw order count and nothing else: four or more
 * was "Weekly", two was "Fortnightly", one was "Monthly". Those words are
 * rates and a count is not a rate, so on "All records" — eleven years of this
 * workspace — four orders was labelled "Weekly", and on "Today" two orders was
 * labelled "Fortnightly". Both readings were wrong, in opposite directions,
 * with nothing on the screen to warn the reader.
 *
 * A span the caller cannot measure returns a dash rather than a guess: a
 * single-row window has no cadence to report, and inventing one is what this
 * replaces.
 */
function describeCadence(orders: number, spanDays: number | null) {
  if (!spanDays || spanDays <= 0 || orders <= 0) return "—";
  const perWeek = orders / (spanDays / 7);
  if (perWeek >= 1) return "Weekly";
  if (perWeek >= 0.5) return "Fortnightly";
  if (perWeek >= 0.2) return "Monthly";
  if (perWeek >= 0.05) return "Quarterly";
  return "Occasional";
}

function ReportsView({
  requests,
  stores: storeRows,
  jobsReady,
  sectionKey,
  onNavigate,
}: {
  requests: MaintenanceRequest[];
  stores: StoreRecord[];
  /**
   * Whether `/api/maintenance` has answered yet.
   *
   * Every figure on this screen is computed from `requests`, which starts as
   * an empty array. Before this flag the whole page read "Nothing in this
   * period — Last 12 months", "No job in Last 12 months carries a cost, so
   * there is nothing to rank" and a caption saying no work orders were raised
   * — five confident findings about a portfolio that had simply not loaded,
   * and on a slow connection they stood there for seconds. Overview was given
   * the same treatment for its workspace tiles in Stage 19; the sentence
   * written there applies here unchanged: loading and empty are different
   * states, and a dashboard must not present one as the other.
   */
  jobsReady: boolean;
  /**
   * WHICH PAGE THIS IS, for the range it remembers.
   *
   * The section id the shell is actually on — a built-in one, or a
   * workspace-defined section that draws this surface. It is the storage
   * namespace for this page's date range and nothing else, which is what
   * keeps one page's range out of another's. A display label would break the
   * moment somebody renamed a menu item.
   */
  sectionKey: string;
  onNavigate: (section: Section) => void;
}) {
  const now = useCurrentTime();
  const [portfolio, setPortfolio] = useState("all");
  /*
   * "Last 12 months" rather than the old "365". The same twelve months of work,
   * but as whole calendar months, so the chart underneath draws twelve labelled
   * monthly buckets instead of a rolling window that starts mid-month.
   */
  const [period, setPeriod] = useStoredPeriod(sectionKey, "12m");
  /*
   * Highest first, and the choice is remembered.
   *
   * Per person per BROWSER, not per account: `localStorage` is the only
   * preference store this product has for a view setting — the board keeps its
   * collapsed groups there and the theme toggle its palette — and the one
   * server-side store, /api/dashboard-layout, records panel order and
   * hidden-ness and nothing else. The same user on a second device gets the
   * default back.
   */
  const [siteSpendOrder, setSiteSpendOrder] = useStoredSortDirection(
    "maintsupp:reports:site-spend-order",
  );
  const [showAllRepeat, setShowAllRepeat] = useState(false);
  /*
   * The header cell that "Edit layout" is drawn into.
   *
   * The owner marked the control — which floated in its own bar under the
   * Spend trend chart — and marked the empty space in this page's header row
   * beside "All portfolios", the period picker and "Export spend", and asked
   * for it there. `DashboardWidgets` still owns the layout, the panels and the
   * saving; it is handed this node and portals its bar into it, so nothing
   * about the arrangement moved, only the button. Overview passes no slot and
   * keeps its bar exactly where it was.
   *
   * A callback ref rather than `getElementById`: it fires during the commit
   * that creates the node, so the control appears on the first paint that has
   * somewhere to put it, with no polling and no ordering assumption between
   * two siblings.
   */
  const [layoutSlot, setLayoutSlot] = useState<HTMLElement | null>(null);
  const periodWindow = resolvePeriod(period, now);
  const scopedRequests = useMemo(
    () => requests.filter((request) =>
      countsAsWorkOrder(request) &&
      (portfolio === "all" || request.siteId === portfolio) &&
      withinAnalyticsPeriod(request.requestedAt, period, now)),
    [now, period, portfolio, requests],
  );
  /*
   * The denominator the cadence needs, in days.
   *
   * A named period supplies its own edges. "All records" has none — its start
   * is -Infinity — so the rows supply them instead, which is the same thing
   * `resolveBounds` does for a sparkline over the same token.
   */
  const cadenceSpanDays = useMemo(() => {
    if (Number.isFinite(periodWindow.start) && Number.isFinite(periodWindow.end)) {
      return (periodWindow.end - periodWindow.start) / 86_400_000;
    }
    const stamps = scopedRequests
      .map((request) => parseStamp(request.requestedAt))
      .filter((stamp) => Number.isFinite(stamp));
    if (stamps.length < 2) return null;
    return (Math.max(...stamps) - Math.min(...stamps)) / 86_400_000;
  }, [periodWindow.start, periodWindow.end, scopedRequests]);
  const analytics = useMemo(() => {
    const spendBySite = new Map<string, number>();
    let total = 0;
    let reactive = 0;
    let planned = 0;
    let projects = 0;
    for (const request of scopedRequests) {
      const cost = request.cost ?? 0;
      total += cost;
      spendBySite.set(request.siteId, (spendBySite.get(request.siteId) ?? 0) + cost);
      // One classifier, shared with the Reactive vs planned panel below.
      const bucket = classifySpend(request);
      if (bucket === "planned") planned += cost;
      else if (bucket === "projects") projects += cost;
      else reactive += cost;
    }
    const repeats = Array.from(
      scopedRequests.reduce((map, request) => {
        const current = map.get(request.category) ?? {
          issue: request.category,
          sites: new Set<string>(),
          orders: 0,
          spend: 0,
          latest: request.requestedAt,
        };
        current.sites.add(request.siteId);
        current.orders += 1;
        current.spend += request.cost ?? 0;
        if (new Date(request.requestedAt) > new Date(current.latest)) current.latest = request.requestedAt;
        map.set(request.category, current);
        return map;
      }, new Map<string, { issue: string; sites: Set<string>; orders: number; spend: number; latest: string }>()),
    )
      .map(([, item]) => ({
        ...item,
        frequency: describeCadence(item.orders, cadenceSpanDays),
      }))
      /*
       * Orders, then spend, then name. The sort was on orders alone, which
       * leaves every tie in whatever order the rows happened to arrive in — so
       * the same period could list the same two categories either way round on
       * two loads, and no SQL query could reproduce the table.
       */
      .sort(
        (left, right) =>
          right.orders - left.orders ||
          right.spend - left.spend ||
          left.issue.localeCompare(right.issue),
      );
    return {
      total,
      reactive,
      planned,
      projects,
      bySite: sortBySpend(
        storeRows
          .map((store) => ({ id: store.id, label: store.name, value: spendBySite.get(store.id) ?? 0 }))
          .filter((item) => item.value > 0),
        siteSpendOrder,
      ),
      repeats,
    };
  }, [cadenceSpanDays, scopedRequests, siteSpendOrder, storeRows]);
  const spendTrend = periodSpendSeries(scopedRequests, period, now);
  /*
   * One sentence, used wherever this screen would otherwise assert that the
   * portfolio is empty. Kept as a constant so a later panel cannot half-adopt
   * the distinction and go back to claiming nothing happened.
   */
  const loading = !jobsReady;
  const LOADING_NOTE = "Loading jobs…";

  return (
    <div className="section-stack analytics-page">
      <section className="analytics-page-heading">
        <div>
          <span>Decision-ready reporting</span>
          <h1>Spend and reporting</h1>
          {/*
            The dates actually applied, under the heading. "Last quarter" does
            not tell anyone which three months they are reading, and every
            figure below depends on the answer.
          */}
          <PeriodCaption period={period} now={now} matched={scopedRequests.length} loading={loading} />
        </div>
        <AnalyticsToolbar
          portfolio={portfolio}
          portfolios={portfolioOptions(storeRows)}
          onPortfolioChange={setPortfolio}
          periodControl={<PeriodPicker value={period} onChange={setPeriod} now={now} />}
          onExport={() => downloadCsv(scopedRequests)}
          exportLabel="Export spend"
          slotRef={setLayoutSlot}
        />
      </section>

      {/* Focusable because it scrolls sideways at phone widths: without a tab
          stop a keyboard user cannot reach the cards past the fold. */}
      <section
        className="analytics-metric-grid report-metric-grid"
        aria-label="Report metrics"
        tabIndex={0}
      >
        {/*
          An empty period reads as a dash and says so, never as £0.
          £0 is a result — it says the portfolio spent nothing — and on a period
          that simply holds no work that is a different and untrue claim.
        */}
        {/*
          The line under each tile counts JOBS; the figure above it sums MONEY.
          Both are wanted — the shape of the work and the size of it — and each
          `trendLabel` says which, because a sparkline under a pound sign reads
          as pounds otherwise.

          The three splits go through `classifySpend`, which is the whole reason
          that function is exported. They used to restate it inline, and got it
          wrong in a way that only showed on the chart: the classifier tests
          compliance-or-tier-4 FIRST, so a £5,000 compliance job is "planned"
          and its money landed on the Planned tile — while `cost >= 1000` drew
          it under Projects and `tier >= 4 || compliance` drew it under Planned
          as well. One job, two lines, and neither line matching its own total.
        */}
        <AnalyticsMetricCard label="This period" value={scopedRequests.length ? formatMoney(analytics.total) : "—"} detail={loading ? LOADING_NOTE : scopedRequests.length ? `${scopedRequests.length} work orders` : "Nothing in this period"} icon="chart" tone="teal" trend={periodTrend(scopedRequests, () => true, period, now)} trendLabel="Work orders raised per bucket across the selected period — a count of jobs, not the spend totalled above." />
        <AnalyticsMetricCard label="Reactive" value={scopedRequests.length ? formatMoney(analytics.reactive) : "—"} detail="Day-to-day maintenance" icon="alert" tone="orange" trend={periodTrend(scopedRequests, (request) => classifySpend(request) === "reactive", period, now)} trendLabel="Reactive jobs raised per bucket, classified exactly as the figure above is." />
        <AnalyticsMetricCard label="Planned" value={scopedRequests.length ? formatMoney(analytics.planned) : "—"} detail="Compliance and planned work" icon="calendar" tone="blue" trend={periodTrend(scopedRequests, (request) => classifySpend(request) === "planned", period, now)} trendLabel="Planned and compliance jobs raised per bucket, classified exactly as the figure above is." />
        <AnalyticsMetricCard label="Projects" value={scopedRequests.length ? formatMoney(analytics.projects) : "—"} detail="Higher-value works" icon="document" tone="green" trend={periodTrend(scopedRequests, (request) => classifySpend(request) === "projects", period, now)} trendLabel="Project jobs raised per bucket, classified exactly as the figure above is." />
      </section>

      <section className="analytics-report-grid">
        <article className="analytics-panel analytics-report-trend">
          <header>
            <div><h2>Spend trend</h2><strong>{scopedRequests.length ? formatMoney(analytics.total) : "—"}</strong><span>{periodWindow.recognised ? periodWindow.label : "No period selected"}</span></div>
          </header>
          {/*
            The "Last 6 months / Last 12 months" control that sat here has gone.
            It ignored the period above it, so a reader could set the tiles to
            July and the chart to twelve months and be shown two different
            windows on one screen, each labelled only "Spend trend". The period
            IS the range now, and the buckets take their granularity from it —
            hours across a day, days across a month, months across a year.
          */}
          {!periodWindow.recognised
            ? <p className="analytics-empty">{periodWindow.reason}</p>
            : loading
              ? <p className="analytics-empty">{LOADING_NOTE}</p>
              : spendTrend.some((point) => point.value > 0)
                ? <TrendChart items={spendTrend} valueFormatter={(value) => formatMoney(Math.round(value))} />
                : <p className="analytics-empty">{scopedRequests.length
                    ? `None of the ${scopedRequests.length} jobs in ${periodWindow.label} carries a cost yet.`
                    : `Nothing in this period — ${periodWindow.label}.`}</p>}
        </article>

        <article className="analytics-panel analytics-top-sites">
          <header>
            <h2>Top sites by spend</h2>
            {/*
              Highest first by default — it is a panel about the top. Reversing
              it answers a real second question, which sites are cheap to run,
              so it is a control rather than a hidden default.
            */}
            <SortDirectionSelect
              value={siteSpendOrder}
              onChange={setSiteSpendOrder}
              label="Order sites by spend"
            />
            <button type="button" onClick={() => onNavigate("stores")}>View sites <Icon name="chevron" size={15} /></button>
          </header>
          {analytics.bySite.length ? (
            <HorizontalBars
              items={analytics.bySite.slice(0, 8)}
              valueFormatter={(value) => formatMoney(value)}
              onSelect={setPortfolio}
            />
          ) : (
            <div className="analytics-empty">{loading
              ? LOADING_NOTE
              : periodWindow.recognised
                ? `No job in ${periodWindow.label} carries a cost, so there is nothing to rank.`
                : periodWindow.reason}</div>
          )}
        </article>
      </section>

      {/*
        The spend questions the four tiles above cannot answer: which sites are
        consistently expensive rather than expensive this period, which fault
        types keep costing money, and who is doing the work.
      */}
      <DashboardWidgets
        surface="reports"
        barSlot={layoutSlot}
        widgets={[
          {
            /*
             * First, because "is this quarter worse than the last" is the
             * question a spend report is opened to answer, and Reports could
             * not answer it — the chart existed only on Overview.
             */
            key: "spend-trend",
            label: "Spend trend",
            wide: true,
            render: () => (
              <SpendTrend requests={scopedRequests} period={period} now={now} loading={loading} />
            ),
          },
          {
            key: "spend-matrix",
            label: "Spend matrix",
            // The matrix needs the full row, not a third of it.
            wide: true,
            render: () => (
              <SpendMatrix
                requests={scopedRequests}
                stores={storeRows}
                now={now}
                period={period}
                direction={siteSpendOrder}
                loading={loading}
              />
            ),
          },
          {
            key: "cost-by-category",
            label: "Cost by job type",
            render: () => <CostByCategory requests={scopedRequests} loading={loading} />,
          },
          {
            key: "spend-budget",
            label: "Spend against budget",
            render: () => (
              <SpendAgainstBudget
                requests={scopedRequests}
                sites={storeRows}
                period={period}
                now={now}
                loading={loading}
              />
            ),
          },
          {
            key: "contractor-scorecard",
            label: "Contractor scorecard",
            render: () => <ContractorScorecard requests={scopedRequests} loading={loading} />,
          },
          {
            key: "reactive-planned",
            label: "Reactive vs planned",
            render: () => (
              <ReactiveVsPlanned requests={scopedRequests} now={now} period={period} loading={loading} />
            ),
          },
        ] satisfies DashboardWidget[]}
      />

      {/* Last on this screen, on the owner's instruction. It is a follow-up
          list rather than a headline, and it was sitting above the panels
          people open first. */}
      <section className="analytics-panel analytics-repeat-panel">
        <header><h2>Repeat activity</h2><button type="button" onClick={() => setShowAllRepeat((current) => !current)}>{showAllRepeat ? "Show summary" : "View all"}</button></header>
        <div className="table-scroll">
          <table className="analytics-table analytics-table--mobile-cards">
            {/* "Activity" is gone. Every row of it printed one identical
                authored sentence, under a column heading, in a table of
                measurements — which is a claim about the job that nothing on
                the record supports. There is no field to populate it from, so
                the column goes rather than the sentence being reworded. */}
            <thead><tr><th>Issue</th><th>Sites</th><th>Orders</th><th>Spend</th><th>Last occurred</th><th>Frequency</th></tr></thead>
            <tbody>
              {analytics.repeats.slice(0, showAllRepeat ? analytics.repeats.length : 6).map((item) => (
                <tr key={item.issue}>
                  <td data-label="Issue"><strong>{item.issue || "Unlabelled"}</strong></td>
                  <td data-label="Sites">{item.sites.size}</td>
                  <td data-label="Orders">{item.orders}</td>
                  <td data-label="Spend">{item.spend ? formatMoney(item.spend) : "Not quoted"}</td>
                  <td data-label="Last occurred">{formatDate(item.latest)}</td>
                  <td data-label="Frequency"><span className="analytics-frequency">{item.frequency}</span></td>
                </tr>
              ))}
              {!analytics.repeats.length && <tr><td className="analytics-empty" colSpan={6}>{loading
                ? LOADING_NOTE
                : periodWindow.recognised
                  ? `Nothing in this period — ${periodWindow.label}.`
                  : periodWindow.reason}</td></tr>}
            </tbody>
          </table>
        </div>
        <button className="analytics-panel-footer" type="button" onClick={() => setShowAllRepeat((current) => !current)}>
          {showAllRepeat ? "Show summary" : "View all repeat activity"} <Icon name="chevron" size={15} />
        </button>
      </section>
    </div>
  );
}

function TeamView({
  userName,
  userEmail,
  team,
  onManage,
}: {
  userName: string;
  userEmail: string;
  team: WorkspaceMember[];
  onManage: (id?: string | null) => void;
}) {
  const members = team.length
    ? team
    : [{ id: "current-user", name: userName, email: userEmail, role: "Super Admin", active: true, lastActive: "Now" }];

  return (
    <div className="section-stack">
      <section className="section-header">
        <div>
          <span className="eyebrow-chip">
            <Icon name="users" size={15} />
            Role-based access
          </span>
          <h1>Workspace team</h1>
          <p>
            Control who can raise, manage, approve and close work across the
            portfolio.
          </p>
        </div>
        <button
          className="primary-button"
          type="button"
          onClick={() => onManage(null)}
        >
          <Icon name="plus" size={18} />
          Add team member
        </button>
      </section>
      <section className="panel team-panel">
        <div className="team-list">
          {members.map((member) => (
            <div key={member.id} className={member.active ? "" : "is-inactive"}>
              <Avatar name={member.name} />
              <span className="team-person">
                <strong>{member.name}</strong>
                <small>{member.email}</small>
              </span>
              <span className="role-chip">{member.role}</span>
              <span className="last-active">{member.lastActive}</span>
              <button
                className="icon-button"
                type="button"
                aria-label={`Manage ${member.name}`}
                onClick={() => onManage(member.id)}
              >
                <Icon name="more" size={18} />
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SettingsView({
  settings,
  categories,
  busy,
  onSave,
  onNotify,
}: {
  settings: WorkspaceSettings;
  /** Every category the workspace's jobs actually use. */
  categories: string[];
  busy: boolean;
  onSave: (settings: WorkspaceSettings) => Promise<void>;
  onNotify: (message: string) => void;
}) {
  const [alerts, setAlerts] = useState({ ...settings.alerts });
  const [slas, setSlas] = useState<WorkspaceSettings["slas"]>({ ...settings.slas });
  const [evidenceCategories, setEvidenceCategories] = useState<string[]>(
    settings.completionEvidenceCategories ?? [],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAlerts({ ...settings.alerts });
      setSlas({ ...settings.slas });
      setEvidenceCategories(settings.completionEvidenceCategories ?? []);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [settings]);

  const saveSettings = async () => {
    try {
      /*
       * Spread the whole settings object, not just the two this screen edits.
       * `PATCH /api/workspace` replaces the stored JSON wholesale, so sending
       * a partial object would clear `completionEvidenceCategories` every time
       * somebody changed an SLA — a safety rule silently switched off by an
       * unrelated save.
       */
      await onSave({
        ...settings,
        alerts,
        slas,
        completionEvidenceCategories: evidenceCategories,
      });
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "Settings could not be saved.");
    }
  };

  return (
    <div className="section-stack settings-width">
      <section className="section-header">
        <div>
          <span className="eyebrow-chip">
            <Icon name="settings" size={15} />
            Workspace configuration
          </span>
          <h1>Settings</h1>
          <p>
            Configure service targets, notification rules and workspace
            preferences.
          </p>
        </div>
        <button className="primary-button" type="button" onClick={() => void saveSettings()} disabled={busy}>
          <Icon name="check" size={17} />
          {busy ? "Saving…" : "Save settings"}
        </button>
      </section>

      <section className="panel settings-card">
        <div className="settings-card__heading">
          <span>
            <Icon name="bell" size={19} />
          </span>
          <div>
            <h2>Notifications</h2>
            <p>Choose the events that should trigger an email update.</p>
          </div>
        </div>
        {[
          {
            key: "urgent" as const,
            label: "Urgent maintenance requests",
            detail: "Notify operations as soon as a priority issue is raised.",
          },
          {
            key: "compliance" as const,
            label: "Compliance expiry alerts",
            detail: "Send reminders 90, 30 and 7 days before expiry.",
          },
          {
            key: "daily" as const,
            label: "Daily operations digest",
            detail: "Receive a weekday summary at 08:00.",
          },
        ].map((setting) => (
          <label className="setting-row" key={setting.key}>
            <span>
              <strong>{setting.label}</strong>
              <small>{setting.detail}</small>
            </span>
            <input
              type="checkbox"
              checked={alerts[setting.key]}
              onChange={(event) =>
                setAlerts((current) => ({
                  ...current,
                  [setting.key]: event.target.checked,
                }))
              }
            />
            <i aria-hidden="true" />
          </label>
        ))}
      </section>

      <section className="panel settings-card">
        <div className="settings-card__heading">
          <span>
            <Icon name="clock" size={19} />
          </span>
          <div>
            <h2>Service levels</h2>
            <p>Default response targets by priority.</p>
          </div>
        </div>
        <div className="sla-settings">
          {/*
            Rendered from the board's Priority options rather than a fixed list.
            The hard-coded ["Urgent", "High", "Medium", "Low"] included a "High"
            monday does not have, so the screen offered a target that could
            never apply to a job.
          */}
          {priorityOptions.map((option) => (
            <div key={option.value}>
              <span className={priorityClass(option.value as Priority)}>
                {option.label ?? option.value}
              </span>
              <input
                value={slas[option.value] ?? ""}
                aria-label={`${option.value} SLA`}
                onChange={(event) =>
                  setSlas((current) => ({ ...current, [option.value]: event.target.value }))
                }
              />
            </div>
          ))}
        </div>
      </section>

      {/*
        J — which jobs cannot be closed without a photograph of the work.
        
        EMPTY BY DEFAULT, and it stays empty until somebody here says
        otherwise. Turning a gate on for every category the moment this deploys
        would stop coordinators closing jobs they have every right to close,
        for a rule nobody agreed to. The recommended set is offered in one
        click — physical repairs and replacements, where "it was done" is a
        claim somebody may have to check against an invoice months later — but
        choosing it is a decision made here, and it lands in the audit log like
        any other settings change.
        
        The rule is enforced in `PATCH /api/maintenance`, not here. Hiding the
        close control would not be a rule; a request from anything else would
        close the job regardless.
      */}
      <section className="panel settings-card">
        <div className="settings-card__head">
          <h2>Completion evidence</h2>
          <p>
            Jobs in these categories cannot be marked Completed until a photograph
            is filed in “Picture of completed works”. Everything else closes as it
            does today.
          </p>
        </div>

        <div className="settings-evidence">
          <div className="settings-evidence__actions">
            <button
              type="button"
              className="secondary-button admin-mini"
              disabled={busy}
              onClick={() =>
                setEvidenceCategories([...RECOMMENDED_EVIDENCE_CATEGORIES])
              }
            >
              Use the recommended set
            </button>
            <button
              type="button"
              className="secondary-button admin-mini"
              disabled={busy || !evidenceCategories.length}
              onClick={() => setEvidenceCategories([])}
            >
              Require none
            </button>
            <span className="settings-evidence__count">
              {evidenceCategories.length
                ? `${evidenceCategories.length} categories require a photograph`
                : "No category requires a photograph"}
            </span>
          </div>

          <ul className="settings-evidence__list">
            {categories.map((category) => {
              const on = evidenceCategories.includes(category);
              return (
                <li key={category}>
                  <label>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={busy}
                      onChange={() =>
                        setEvidenceCategories((current) =>
                          on
                            ? current.filter((item) => item !== category)
                            : [...current, category],
                        )
                      }
                    />
                    <span>{category}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
    </div>
  );
}

type MobileRequestEditorKind =
  | "text"
  | "long_text"
  | "number"
  | "phone"
  | "date"
  | "timeline"
  | "option";

type MobileRequestEditorOption = {
  value: string;
  label: string;
  color: string;
  textColor?: string;
  active?: boolean;
};

type MobileRequestFieldEditor = {
  field: string;
  title: string;
  kind: MobileRequestEditorKind;
  value: string;
  allowEmpty?: boolean;
  optionColumn?: BoardOptionColumn;
  customColumn?: MaintenanceBoardColumn;
  options?: MobileRequestEditorOption[];
};


function mondayDate(value: string | null) {
  // en-GB, through the shared formatter: "24 Nov", not "Nov 24". This was the
  // second of the four en-US formatters a completion audit found.
  if (!value) return "";
  return formatDayMonth(value, { fallback: "", timeZone: "Europe/London" });
}

function mondayDateInput(value: string | null) {
  return value ? value.slice(0, 10) : "";
}

function mondayChoice(column: BoardOptionColumn, value: string) {
  return publishedBoardOptions().find(
    (choice) => choice.columnKey === column && choice.value === value,
  );
}

function mondayChoiceStyle(column: BoardOptionColumn, value: string) {
  const choice = mondayChoice(column, value);
  const background = choice?.color ?? "#c4c4c4";
  // The ground is monday's and stays; only the label is ours to get right.
  return { backgroundColor: background, color: chipInk(background, choice?.textColor) };
}

function MobileMondayField({
  label,
  children,
  onClick,
  variant = "plain",
  empty = false,
  style,
}: {
  label: string;
  children?: ReactNode;
  onClick?: () => void;
  variant?:
    | "plain"
    | "long_text"
    | "option"
    | "timeline"
    | "files"
    | "link"
    | "icon";
  empty?: boolean;
  style?: { backgroundColor: string; color: string };
}) {
  const className = `mobile-monday-field__value mobile-monday-field__value--${variant}${
    empty ? " is-empty" : ""
  }`;
  return (
    <div className="mobile-monday-field">
      <span className="mobile-monday-field__label">{label}</span>
      {onClick ? (
        <button
          type="button"
          className={className}
          style={style}
          onClick={onClick}
          aria-label={`Edit ${label}`}
        >
          {children}
        </button>
      ) : (
        <div className={className} style={style}>
          {children}
        </div>
      )}
    </div>
  );
}

function MobileMondayFiles({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="mobile-monday-file-icons" aria-label={`${count} files`}>
      {Array.from({ length: Math.min(3, count) }, (_, index) => (
        <span key={index}>
          <Icon name="image" size={13} />
        </span>
      ))}
      {count > 3 && <small>+{count - 3}</small>}
    </span>
  );
}

const mobileLocationColours = [
  "#00c875",
  "#fdab3d",
  "#e2445c",
  "#0086c0",
  "#579bfc",
  "#a25ddc",
  "#00a9a5",
];

function mobileBoardCellKey(requestId: string, columnId: string) {
  return `${requestId}::${columnId}`;
}

function mobileCustomDateValue(value: string) {
  if (!value) return "";
  if (value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { date?: unknown };
      return typeof parsed.date === "string" ? parsed.date : "";
    } catch {
      return "";
    }
  }
  return value.slice(0, 10);
}

function mobileCustomTimeline(value: string) {
  if (!value) return { start: "", end: "" };
  try {
    const parsed = JSON.parse(value) as { start?: unknown; end?: unknown };
    return {
      start: typeof parsed.start === "string" ? parsed.start : "",
      end: typeof parsed.end === "string" ? parsed.end : "",
    };
  } catch {
    return { start: "", end: "" };
  }
}

function mobileCustomChoices(column: MaintenanceBoardColumn) {
  return column.type === "people"
    ? column.settings.people ?? []
    : column.settings.choices ?? [];
}

function MobileMondayColumns({
  request,
  boardSnapshot,
  visible,
  onEdit,
  onOpenEvidence,
  onBoardCellChange,
  onAddColumn,
  onNotify,
}: {
  request: MaintenanceRequest;
  boardSnapshot: MaintenanceBoardSnapshot | null;
  visible: boolean;
  onEdit: (editor: MobileRequestFieldEditor) => void;
  onOpenEvidence: (
    kind: AttachmentKind | "all",
    column?: MaintenanceBoardColumn,
  ) => void;
  onBoardCellChange: (
    column: MaintenanceBoardColumn,
    value: string | number | boolean | { start: string; end: string },
  ) => Promise<string>;
  onAddColumn: () => void;
  onNotify: (message: string) => void;
}) {
  const columns = boardSnapshot?.columns ?? [];
  const cellValues = boardSnapshot?.cellValues ?? {};
  const fileCounts = boardSnapshot?.fileCounts ?? {};
  const locationOptions: MobileRequestEditorOption[] = Array.from(
    new Set([request.location].filter(Boolean)),
  ).map((value, index) => ({
    value,
    label: value,
    color: mobileLocationColours[index % mobileLocationColours.length],
    textColor: "#ffffff",
  }));
  const selectedLocation = locationOptions.find(
    (option) => option.value === request.location,
  );
  const currentGroup = (() => {
    if (!boardSnapshot) return { id: "", name: request.stage };
    const placement = boardSnapshot.items.find(
      (item) => item.requestId === request.id,
    );
    const group = boardSnapshot.groups.find(
      (candidate) => candidate.id === placement?.groupId,
    );
    return { id: group?.id ?? "", name: group?.name ?? request.stage };
  })();

  const edit = (
    field: string,
    title: string,
    kind: MobileRequestEditorKind,
    value: string,
    extra: Pick<
      MobileRequestFieldEditor,
      | "allowEmpty"
      | "optionColumn"
      | "customColumn"
      | "options"
    > = {},
  ) => onEdit({ field, title, kind, value, ...extra });

  const renderSystemColumn = (entry: MaintenanceBoardSnapshotColumn) => {
    const column = entry.column;
    const key = entry.key;
    const boardValue =
      cellValues[mobileBoardCellKey(request.id, column.id)] ?? "";
    switch (key) {
      case "name": {
        const value =
          boardValue.trim() ||
          (request.source === "Manual" ? "Manual" : "Incoming form answer");
        return (
          <MobileMondayField
            key={column.id}
            label={column.title}
            onClick={() =>
              edit("board-item", column.title, "text", value, {
                customColumn: column,
              })
            }
          >
            {value}
          </MobileMondayField>
        );
      }
      case "location":
        return (
          <MobileMondayField
            key={column.id}
            label={column.title}
            empty={!request.location}
            onClick={() =>
              edit("location", column.title, "text", request.location)
            }
          >
            {request.location}
          </MobileMondayField>
        );
      case "description":
        return (
          <MobileMondayField
            key={column.id}
            label={column.title}
            variant="long_text"
            empty={!request.description}
            onClick={() =>
              edit(
                "description",
                column.title,
                "long_text",
                request.description,
              )
            }
          >
            {request.description}
          </MobileMondayField>
        );
      case "tier":
        return (
          <MobileMondayField
            key={column.id}
            label={column.title}
            variant="option"
            style={mondayChoiceStyle("tier", String(request.tier))}
            onClick={() =>
              edit("tier", column.title, "option", String(request.tier), {
                optionColumn: "tier",
              })
            }
          >
            Tier {request.tier}
          </MobileMondayField>
        );
      case "engineer":
      case "priority":
      case "label":
      case "status": {
        const config = {
          engineer: {
            field: "engineer",
            value: request.engineer,
            optionColumn: "engineer" as const,
          },
          priority: {
            field: "priority",
            value: request.priority,
            optionColumn: "priority" as const,
          },
          label: {
            field: "category",
            value: request.category,
            optionColumn: "label" as const,
          },
          status: {
            field: "status",
            value: request.status,
            optionColumn: "status" as const,
          },
        }[key];
        return (
          <MobileMondayField
            key={column.id}
            label={column.title}
            variant="option"
            empty={!config.value}
            style={mondayChoiceStyle(config.optionColumn, config.value)}
            onClick={() =>
              edit(config.field, column.title, "option", config.value, {
                optionColumn: config.optionColumn,
              })
            }
          >
            {config.value}
          </MobileMondayField>
        );
      }
      case "contractor":
      case "requester":
      case "invoice": {
        const config = {
          contractor: {
            field: "contractor",
            value: request.contractor ?? "",
          },
          requester: { field: "requester", value: request.requester },
          invoice: { field: "invoice", value: request.invoice ?? "" },
        }[key];
        return (
          <MobileMondayField
            key={column.id}
            label={column.title}
            empty={!config.value}
            onClick={() =>
              edit(config.field, column.title, "text", config.value, {
                allowEmpty: true,
              })
            }
          >
            {config.value}
          </MobileMondayField>
        );
      }
      case "assignee":
      case "approvedBy": {
        const field = key === "assignee" ? "assignee" : "approvedBy";
        const value =
          key === "assignee" ? request.assignee ?? "" : request.approvedBy ?? "";
        return (
          <MobileMondayField
            key={column.id}
            label={column.title}
            variant="icon"
            empty={!value}
            onClick={() =>
              edit(field, column.title, "text", value, { allowEmpty: true })
            }
          >
            {value ? <Avatar name={value} size="small" /> : <Icon name="user" size={17} />}
          </MobileMondayField>
        );
      }
      case "requested":
      case "completed":
      case "nextUpdate": {
        const config = {
          requested: {
            field: "requestedAt",
            value: request.requestedAt,
            allowEmpty: false,
          },
          completed: {
            field: "completedAt",
            value: request.completedAt,
            allowEmpty: true,
          },
          nextUpdate: {
            field: "nextUpdateAt",
            value: request.nextUpdateAt,
            allowEmpty: true,
          },
        }[key];
        return (
          <MobileMondayField
            key={column.id}
            label={column.title}
            empty={!config.value}
            onClick={() =>
              edit(
                config.field,
                column.title,
                "date",
                mondayDateInput(config.value),
                { allowEmpty: config.allowEmpty },
              )
            }
          >
            {mondayDate(config.value)}
          </MobileMondayField>
        );
      }
      case "timeline":
        return (
          <MobileMondayField
            key={column.id}
            label={column.title}
            variant="timeline"
            onClick={() =>
              edit("dueAt", column.title, "date", mondayDateInput(request.dueAt), {
                allowEmpty: true,
              })
            }
          >
            {request.dueAt
              ? `${mondayDate(request.requestedAt)} – ${mondayDate(request.dueAt)}`
              : "–"}
          </MobileMondayField>
        );
      case "issuePictures":
      case "completedPictures":
      case "files": {
        const kind: AttachmentKind | "all" =
          key === "issuePictures"
            ? "issue"
            : key === "completedPictures"
              ? "completion"
              : "all";
        const count =
          key === "issuePictures"
            ? request.issueAttachmentCount ?? 0
            : key === "completedPictures"
              ? request.completedAttachmentCount ?? 0
              : request.attachmentCount;
        return (
          <MobileMondayField
            key={column.id}
            label={column.title}
            variant="files"
            empty={!count}
            onClick={() => onOpenEvidence(kind)}
          >
            <MobileMondayFiles count={count} />
          </MobileMondayField>
        );
      }
      case "cost":
        return (
          <MobileMondayField
            key={column.id}
            label={column.title}
            empty={request.cost === null}
            onClick={() =>
              edit(
                "cost",
                column.title,
                "number",
                request.cost === null ? "" : String(request.cost),
                { allowEmpty: true },
              )
            }
          >
            {request.cost === null ? "" : request.cost.toLocaleString("en-GB")}
          </MobileMondayField>
        );
      case "number":
        return (
          <MobileMondayField
            key={column.id}
            label={column.title}
            empty={!request.contact}
            onClick={() =>
              edit("contact", column.title, "phone", request.contact)
            }
          >
            {request.contact}
          </MobileMondayField>
        );
      case "storeLocation":
        return (
          <MobileMondayField
            key={column.id}
            label={column.title}
            variant="option"
            empty={!request.location}
            style={{
              backgroundColor: selectedLocation?.color ?? "#0086c0",
              color: chipInk(
                selectedLocation?.color ?? "#0086c0",
                selectedLocation?.textColor,
              ),
            }}
            onClick={() =>
              edit("location", column.title, "option", request.location, {
                options: locationOptions,
              })
            }
          >
            {request.location || "Choose a location"}
          </MobileMondayField>
        );
      case "formView":
        return (
          <MobileMondayField
            key={column.id}
            label={column.title}
            variant="link"
            empty={!request.formUrl}
            onClick={() =>
              edit("formUrl", column.title, "text", request.formUrl ?? "", {
                allowEmpty: true,
              })
            }
          >
            {request.formUrl}
          </MobileMondayField>
        );
      case "move":
        return (
          <MobileMondayField
            key={column.id}
            label={column.title}
            variant="option"
            style={{ backgroundColor: "#579bfc", color: "#ffffff" }}
            onClick={() =>
              edit("board-group", column.title, "option", currentGroup.id, {
                options: (boardSnapshot?.groups ?? []).map((group) => ({
                  value: group.id,
                  label: group.name,
                  color: group.color,
                  textColor: "#ffffff",
                })),
              })
            }
          >
            {currentGroup.name}
          </MobileMondayField>
        );
      default:
        return null;
    }
  };

  const renderCustomColumn = (entry: MaintenanceBoardSnapshotColumn) => {
    const column = entry.column;
    const cellKey = mobileBoardCellKey(request.id, column.id);
    const rawValue = cellValues[cellKey] ?? "";
    if (column.type === "files") {
      const count = fileCounts[cellKey] ?? 0;
      return (
        <MobileMondayField
          key={column.id}
          label={column.title}
          variant="files"
          empty={!count}
          onClick={() => onOpenEvidence("all", column)}
        >
          <MobileMondayFiles count={count} />
        </MobileMondayField>
      );
    }

    if (
      column.type === "status" ||
      column.type === "dropdown" ||
      column.type === "people"
    ) {
      const choices = mobileCustomChoices(column);
      const selected = choices.find((choice) => choice.label === rawValue);
      const options = choices.map((choice) => ({
        value: choice.label,
        label: choice.label,
        color: choice.color,
        textColor: choice.textColor ?? "#ffffff",
      }));
      return (
        <MobileMondayField
          key={column.id}
          label={column.title}
          variant="option"
          empty={!rawValue}
          style={{
            backgroundColor: selected?.color ?? "#c4c4c4",
            color: chipInk(selected?.color ?? "#c4c4c4", selected?.textColor),
          }}
          onClick={() =>
            edit("custom", column.title, "option", rawValue, {
              allowEmpty: true,
              customColumn: column,
              options,
            })
          }
        >
          {rawValue}
        </MobileMondayField>
      );
    }

    if (column.type === "checkbox") {
      const checked = rawValue === "true";
      return (
        <MobileMondayField
          key={column.id}
          label={column.title}
          onClick={() => {
            void onBoardCellChange(column, !checked).catch((caught) =>
              onNotify(
                caught instanceof Error
                  ? caught.message
                  : "The checkbox could not be saved.",
              ),
            );
          }}
        >
          {checked ? <Icon name="check" size={20} /> : ""}
        </MobileMondayField>
      );
    }

    if (column.type === "timeline") {
      const timeline = mobileCustomTimeline(rawValue);
      return (
        <MobileMondayField
          key={column.id}
          label={column.title}
          variant="timeline"
          onClick={() =>
            edit("custom", column.title, "timeline", JSON.stringify(timeline), {
              allowEmpty: true,
              customColumn: column,
            })
          }
        >
          {timeline.start && timeline.end
            ? `${mondayDate(timeline.start)} – ${mondayDate(timeline.end)}`
            : "–"}
        </MobileMondayField>
      );
    }

    const dateValue =
      column.type === "date" ? mobileCustomDateValue(rawValue) : "";
    const displayValue =
      column.type === "date"
        ? mondayDate(dateValue)
        : column.type === "number" && rawValue
          ? Number(rawValue).toLocaleString("en-GB")
          : rawValue;
    const kind: MobileRequestEditorKind =
      column.type === "long_text"
        ? "long_text"
        : column.type === "number"
          ? "number"
          : column.type === "phone"
            ? "phone"
            : column.type === "date"
              ? "date"
              : "text";
    return (
      <MobileMondayField
        key={column.id}
        label={column.title}
        variant={column.type === "link" ? "link" : column.type === "long_text" ? "long_text" : "plain"}
        empty={!displayValue}
        onClick={() =>
          edit("custom", column.title, kind, dateValue || rawValue, {
            allowEmpty: true,
            customColumn: column,
          })
        }
      >
        {displayValue}
      </MobileMondayField>
    );
  };

  return (
    <section
      className={`mobile-monday-columns${visible ? "" : " is-tab-hidden"}`}
      aria-label="Columns"
    >
      {!boardSnapshot && (
        <div className="mobile-monday-columns__loading">Loading columns…</div>
      )}
      {columns.map((entry) =>
        entry.kind === "system"
          ? renderSystemColumn(entry)
          : renderCustomColumn(entry),
      )}
      <button
        className="mobile-monday-add-column"
        type="button"
        onClick={onAddColumn}
      >
        + Add Column
      </button>
    </section>
  );
}

function MobileRequestEditor({
  editor,
  draft,
  error,
  saving,
  onDraftChange,
  onClose,
  onSave,
}: {
  editor: MobileRequestFieldEditor;
  draft: string;
  error: string | null;
  saving: boolean;
  onDraftChange: (value: string) => void;
  onClose: () => void;
  onSave: (value?: string) => void;
}) {
  const options: MobileRequestEditorOption[] =
    editor.options ??
    (editor.optionColumn
      ? publishedBoardOptions()
          .filter(
            (choice) =>
              choice.columnKey === editor.optionColumn && choice.active,
          )
          .map((choice) => ({
            value: choice.value,
            label: choice.label,
            color: choice.color,
            textColor: choice.textColor,
          }))
      : []);
  const isOption = editor.kind === "option";
  const timelineDraft =
    editor.kind === "timeline"
      ? mobileCustomTimeline(draft)
      : { start: "", end: "" };

  return (
    <div
      className={`mobile-request-field-editor${
        isOption ? " mobile-request-field-editor--option" : ""
      }`}
      role="dialog"
      aria-modal="true"
      aria-label={editor.title}
    >
      <button
        className="mobile-request-field-editor__backdrop"
        type="button"
        aria-label="Close editor"
        onClick={onClose}
      />
      <section>
        <header>
          <button type="button" onClick={onClose} aria-label="Close editor">
            <Icon name="close" size={23} />
          </button>
          <strong>{editor.title}</strong>
          {!isOption && (
            <button
              className="mobile-request-field-editor__save"
              type="button"
              disabled={saving}
              onClick={() => onSave()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          )}
        </header>

        <div className="mobile-request-field-editor__body">
          {isOption && (
            <div className="mobile-request-field-editor__options">
              {options.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  className={choice.value === draft ? "is-selected" : ""}
                  disabled={saving}
                  style={{
                    backgroundColor: choice.color,
                    color: chipInk(choice.color, choice.textColor),
                  }}
                  onClick={() => onSave(choice.value)}
                >
                  {choice.label}
                  {choice.value === draft && <Icon name="check" size={17} />}
                </button>
              ))}
              <button
                className="mobile-request-field-editor__manage"
                type="button"
                onClick={onClose}
              >
                <Icon name="wrench" size={16} />
                Add / Edit labels
              </button>
            </div>
          )}

          {editor.kind === "long_text" && (
            <textarea
              rows={12}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              aria-label={editor.title}
            />
          )}

          {editor.kind === "text" && (
            <textarea
              rows={6}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              aria-label={editor.title}
            />
          )}

          {editor.kind === "number" && (
            <input
              type="number"
              inputMode="decimal"
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              aria-label={editor.title}
            />
          )}

          {editor.kind === "phone" && (
            <input
              type="tel"
              inputMode="tel"
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              aria-label={editor.title}
            />
          )}

          {editor.kind === "date" && (
            <input
              type="date"
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              aria-label={editor.title}
            />
          )}

          {editor.kind === "timeline" && (
            <div className="mobile-timeline-editor">
              <label>
                <span>Start date</span>
                <input
                  type="date"
                  value={timelineDraft.start}
                  onChange={(event) =>
                    onDraftChange(
                      JSON.stringify({
                        ...timelineDraft,
                        start: event.target.value,
                      }),
                    )
                  }
                />
              </label>
              <label>
                <span>End date</span>
                <input
                  type="date"
                  value={timelineDraft.end}
                  onChange={(event) =>
                    onDraftChange(
                      JSON.stringify({
                        ...timelineDraft,
                        end: event.target.value,
                      }),
                    )
                  }
                />
              </label>
            </div>
          )}

          {error && (
            <small className="mobile-request-field-editor__error">{error}</small>
          )}
        </div>
      </section>
    </div>
  );
}

function RequestDrawer({
  request,
  boardSnapshot,
  initialTab,
  onClose,
  onStatusChange,
  onAddUpdate,
  onFieldsChange,
  onBoardCellChange,
  onAddColumn,
  onRequestChange,
  onNotify,
  currentUserName,
  itemActions,
}: {
  request: MaintenanceRequest;
  boardSnapshot: MaintenanceBoardSnapshot | null;
  initialTab: RequestDrawerTab;
  onClose: () => void;
  onStatusChange: (stage: RequestStage) => void | Promise<void>;
  /**
   * A comment, optionally hung under another one and optionally carrying files.
   *
   * `parentId` is what makes a REPLY rather than a new top-level comment;
   * `attachmentIds` are rows already written by `/api/files` that the comment
   * adopts. Both are optional, so the two footer buttons that just want to say
   * something still call this with one argument.
   */
  onAddUpdate: (
    note: string,
    options?: { parentId?: string | null; attachmentIds?: string[] },
  ) => Promise<void>;
  onFieldsChange: (
    fields: Record<string, string | number | null>,
  ) => Promise<MaintenanceRequest>;
  onBoardCellChange: (
    column: MaintenanceBoardColumn,
    value: string | number | boolean | { start: string; end: string },
  ) => Promise<string>;
  onAddColumn: () => void;
  onRequestChange: (request: MaintenanceRequest) => void;
  onNotify: (message: string) => void;
  /** Drawn on the reply composer's avatar. Null before the context arrives. */
  currentUserName: string | null;
  /**
   * The board's item verbs for the header's "⋮" — the row menu's actions,
   * relocated to where monday keeps them. Null when no board is mounted.
   */
  itemActions?: BoardItemActions | null;
}) {
  /*
   * The drawer only exists while it is open, so the lock is unconditional
   * here: mounting takes it, unmounting gives it back.
   */
  useScrollLock(true);
  /*
   * The Updates panel's composer, so the two footer buttons can put the cursor
   * in the box that is already on screen instead of revealing a second one.
   *
   * The drawer used to hold the textarea itself, along with the draft, the
   * chosen files, the saving flag and a whole parallel set of reply state —
   * nine `useState`s and two refs for one box. All of that is `UpdateThread`'s
   * now, and what comes back up is this one handle. A ref rather than state:
   * nothing here renders differently because the box exists, so storing it in
   * state would re-render the entire drawer on mount for no visible reason.
   */
  const composerHandle = useRef<ComposerHandle | null>(null);
  const setComposerHandle = useCallback((handle: ComposerHandle | null) => {
    composerHandle.current = handle;
  }, []);
  // Relative comment times ("2mo") go stale silently; this ticks them.
  const now = useCurrentTime();
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  /* Bumped when the evidence panel closes, so the before/after pair picks up
     anything just uploaded rather than showing a stale pair. */
  const [evidenceRefreshToken, setEvidenceRefreshToken] = useState(0);
  const [evidenceKind, setEvidenceKind] = useState<AttachmentKind | "all">(
    "all",
  );
  const [evidenceColumn, setEvidenceColumn] =
    useState<MaintenanceBoardColumn | null>(null);
  const [activeTab, setActiveTab] =
    useState<RequestDrawerTab>(initialTab);
  const [activities, setActivities] = useState<RequestActivityEntry[]>([]);
  const [activitiesLoading, setActivitiesLoading] = useState(true);
  const [activitiesError, setActivitiesError] = useState<string | null>(null);
  const [mobileEditor, setMobileEditor] =
    useState<MobileRequestFieldEditor | null>(null);
  const [mobileDraft, setMobileDraft] = useState("");
  const [mobileSaving, setMobileSaving] = useState(false);
  const [mobileEditorError, setMobileEditorError] = useState<string | null>(
    null,
  );

  /*
   * THE DRAWER IS A DIALOG, AND HAS TO BEHAVE LIKE ONE.
   *
   * It paints over the page, takes the scroll lock and puts a scrim between the
   * reader and everything behind it — and it did all of that as a bare
   * `<aside>`: no `role`, focus left on the row that opened it, Escape doing
   * nothing. Verified in a browser: after opening a job, `document.activeElement`
   * was still the board's "Open item" button, so the next Tab walked the rest of
   * the board — a 27-column grid — before it reached the drawer, and a reader
   * who cannot see the overlay was given no way out of it. Escape closes every
   * other surface in this app (the evidence manager, the media viewer, every
   * anchored popover); the one that covers the whole screen was the exception.
   *
   * `role="dialog"` + `aria-modal` is the markup half; the effect below is the
   * behaviour half. The `aria-modal` claim is honest here: `useScrollLock` above
   * already froze the page and `.drawer-scrim` already swallows the pointer.
   *
   * `surface.focus()` rather than the close button's: focusing the container
   * makes a screen reader announce the dialog and its label, which is what a
   * reader needs first; the close button is then one Tab away.
   */
  const drawerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const surface = drawerRef.current;
    if (surface && !surface.contains(document.activeElement)) {
      surface.focus({ preventScroll: true });
    }
    return () => {
      /*
       * Focus goes back to the row that opened the drawer — but only if it
       * would otherwise be lost. A close that happened because the reader
       * clicked something else has already put focus somewhere deliberate,
       * and stealing it back is the more annoying bug.
       */
      if (!opener || !document.contains(opener)) return;
      const active = document.activeElement;
      if (!active || active === document.body) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      /*
       * Innermost surface first — the convention media-viewer.tsx and
       * evidence-manager.tsx already follow between themselves. Those two stop
       * the event at the window when they handle it; the two pieces of drawer
       * state below have no listener of their own, so they are checked here.
       */
      if (evidenceOpen || mobileEditor) return;
      // An anchored popover (the "⋮" menu, a status picker) owns the press.
      if (document.querySelector(".ms-layer .ms-popover")) return;
      /*
       * Escape inside a box means "abandon what I am typing", everywhere else
       * on this board — the group rename input, the add-subitem field, the
       * reply composer in update-thread.tsx. It must not also throw the drawer
       * away and the half-written comment with it.
       */
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [evidenceOpen, mobileEditor, onClose]);

  /*
   * HOW MANY FILES — COUNTED, not read off the row's counter.
   *
   * The Files tab printed `request.attachmentCount`, which is the same class of
   * number the Updates tab beside it stopped trusting: a counter with two
   * writers and no reconciler. db/schema.ts:976 names it — "A counter also has
   * the `issue_attachment_count` problem — two writers, no reconciler, and it
   * drifts. The count here is a COUNT."
   *
   * Verified drifted in the running workspace: MN-1043's tab header read
   * "6 files" while the evidence panel it opens — the thing that actually reads
   * `/api/files` — reported All files 0, Issue 0, Completed 0, Other 0. Two
   * numbers for one fact, on two surfaces one click apart.
   *
   * The snapshot stays as the value shown until this answers, exactly as
   * `commentCount` above keeps `request.commentCount` until the thread loads;
   * it is re-read when the evidence panel closes (`evidenceRefreshToken`) and
   * updated in place while that panel adds or removes files.
   */
  const [fileCount, setFileCount] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch(
          `/api/files?requestId=${encodeURIComponent(request.id)}`,
          { headers: { Accept: "application/json" } },
        );
        if (!response.ok) return;
        const payload = (await response.json()) as { files?: unknown[] };
        if (active && Array.isArray(payload.files)) setFileCount(payload.files.length);
      } catch {
        // Falling back to the snapshot is the honest failure here: the panel
        // one click away still reads the files, and an error box on a count
        // helps nobody.
      }
    })();
    return () => {
      active = false;
    };
  }, [request.id, evidenceRefreshToken]);

  const loadActivities = useCallback(async () => {
    setActivitiesLoading(true);
    setActivitiesError(null);
    try {
      setActivities(await fetchRequestActivities(request.id));
    } catch (caught) {
      setActivitiesError(
        caught instanceof Error
          ? caught.message
          : "The update history could not be loaded.",
      );
    } finally {
      setActivitiesLoading(false);
    }
  }, [request.id]);
  /*
   * The thread comes from `item_updates`, not from the audit log.
   *
   * This used to filter `activities` for `request.note_added` rows, which meant
   * the only comments it could ever show were the ones this app had written.
   * monday's 218 comments and 47 replies live in `item_updates`, so the tab
   * counted them correctly from `comment_count` and then rendered "No detailed
   * updates have been added yet" — the number right, the thread empty, and the
   * empty state explaining the absence as though it were expected.
   *
   * `activities` is still loaded and still drives the Activity Log tab. The two
   * are different things: one is what people said, the other is what changed.
   */
  const [updates, setUpdates] = useState<RequestUpdate[]>([]);
  const [updatesLoading, setUpdatesLoading] = useState(false);
  /*
   * The Updates section's OWN failure, and its own "I have an answer".
   *
   * Both states used to be borrowed from the Activity Log: the section drew
   * `activitiesLoading` as "Loading updates…", `activitiesError` as "The update
   * history could not be loaded" with a Try again that re-fetched ACTIVITIES,
   * and — because the thread was gated only on `updates.length > 0` — rendered
   * a fully loaded thread underneath that error box at the same time. Meanwhile
   * a thread that genuinely failed was caught here, blanked to `[]`, and shown
   * as "No detailed updates have been added yet": the same false reassurance
   * this route's header comment says was removed.
   */
  const [updatesError, setUpdatesError] = useState<string | null>(null);
  const [updatesLoaded, setUpdatesLoaded] = useState(false);

  const loadUpdates = useCallback(async () => {
    setUpdatesError(null);
    try {
      const response = await fetch(
        `/api/updates?requestId=${encodeURIComponent(request.id)}`,
        { headers: { Accept: "application/json" } },
      );
      if (!response.ok) throw new Error("failed");
      const payload = (await response.json()) as { updates?: RequestUpdate[] };
      setUpdates(payload.updates ?? []);
      setUpdatesLoaded(true);
    } catch {
      // A thread that will not load must not take the drawer with it; the
      // Activity Log beside it still renders. It says so, though — an empty
      // list and a failed fetch are not the same thing and must not read alike.
      setUpdates([]);
      setUpdatesLoaded(false);
      setUpdatesError("The update thread could not be loaded.");
    } finally {
      setUpdatesLoading(false);
    }
  }, [request.id]);

  useEffect(() => {
    /*
     * The loading flag is set inside the async body, not before it.
     *
     * Setting state synchronously in an effect triggers a cascading render, and
     * the lint rule that catches it is right: the fetch below is what takes
     * time, so the flag belongs with it. `active` guards the case where the
     * drawer moves to another job before this one answers.
     */
    let active = true;
    (async () => {
      setUpdatesLoading(true);
      await loadUpdates();
      if (!active) return;
    })();
    return () => {
      active = false;
    };
  }, [loadUpdates]);

  useEffect(() => {
    let active = true;
    async function loadInitialActivities() {
      try {
        const history = await fetchRequestActivities(request.id);
        if (active) setActivities(history);
      } catch (caught) {
        if (!active) return;
        setActivitiesError(
          caught instanceof Error
            ? caught.message
            : "The update history could not be loaded.",
        );
      } finally {
        if (active) setActivitiesLoading(false);
      }
    }
    void loadInitialActivities();
    return () => {
      active = false;
    };
  }, [request.id]);

  /*
   * Everything in the thread, replies included.
   *
   * The tab used to read `request.commentCount` — the board row's snapshot,
   * taken when the board was fetched — while the section header counted the
   * thread it had just loaded. After a successful post the two read 5 and 6,
   * and the difference persisted until the board refreshed. One number now,
   * from the rows on screen, with the snapshot kept only for the moment before
   * the thread has answered (or if it failed to).
   */
  const threadCount = updates.reduce(
    (total, entry) => total + 1 + entry.replies.length,
    0,
  );
  const commentCount = updatesLoaded ? threadCount : request.commentCount;

  /*
   * One writer for the composer and for every reply box.
   *
   * Files first, then the comment: `/api/updates` stamps `update_id` onto rows
   * that already exist, so they have to exist. If the comment then fails the
   * uploads remain on the job as general evidence — visible in the Files tab,
   * attributable, deletable — rather than becoming rows nothing points at.
   *
   * `loadUpdates()` is what makes a comment appear. Without it the POST
   * succeeded, the toast said "Comment added", the box cleared and the thread
   * did not change: `loadUpdates` was only ever called by the mount effect, so
   * the only way to see your own comment was to close the drawer and open it
   * again. `loadActivities()` stays because the Activity Log is a second
   * reader, not the same one.
   */
  const submitComment = useCallback(
    async (body: string, parentId: string | null, files: File[]) => {
      const attachmentIds: string[] = [];
      for (const file of files) {
        const uploaded = await uploadEvidenceFile({
          file,
          requestId: request.id,
          kind: "general",
        });
        attachmentIds.push(uploaded.file.id);
      }
      await onAddUpdate(body, { parentId, attachmentIds });
      await loadUpdates();
      await loadActivities();
    },
    [request.id, onAddUpdate, loadUpdates, loadActivities],
  );

  /*
   * A like is applied in place, not by re-fetching the thread.
   *
   * `loadUpdates()` is right for a comment — the server assigns the id and the
   * timestamp, and the panel has to learn them. A like changes two numbers the
   * server has just told us, and re-reading the whole thread for it would
   * remount every card: an open `… See more`, a half-typed reply and the page a
   * reader had scrolled to inside an embedded PDF would all be thrown away by a
   * thumb. `likedBy` is adjusted here too, so the hover does not go on naming
   * the old set until the next real reload.
   */
  const applyLike = useCallback(
    (updateId: string, liked: boolean, likeCount: number) => {
      const me = currentUserName?.trim() || "You";
      const touch = <T extends { id: string; likedBy: string[] }>(entry: T): T =>
        entry.id === updateId
          ? {
              ...entry,
              likeCount,
              likedByMe: liked,
              likedBy: liked
                ? entry.likedBy.includes(me)
                  ? entry.likedBy
                  : [...entry.likedBy, me]
                : entry.likedBy.filter((name) => name !== me),
            }
          : entry;
      setUpdates((current) =>
        current.map((update) => ({
          ...touch(update),
          replies: update.replies.map(touch),
        })),
      );
    },
    [currentUserName],
  );

  const stageOrder: RequestStage[] = [
    "Incoming",
    "Booked",
    "Attention",
    "Completed",
  ];
  const currentIndex = stageOrder.indexOf(request.stage);

  const openMobileEditor = (editor: MobileRequestFieldEditor) => {
    setMobileDraft(editor.value);
    setMobileEditorError(null);
    setMobileEditor(editor);
  };

  const saveMobileEditor = async (optionValue?: string) => {
    if (!mobileEditor || mobileSaving) return;
    setMobileSaving(true);
    setMobileEditorError(null);
    try {
      const rawValue = optionValue ?? mobileDraft;

      if (mobileEditor.field === "board-group") {
        const response = await fetch("/api/board", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "move_items",
            requestIds: [request.id],
            groupId: rawValue,
          }),
        });
        const payload = (await response.json()) as {
          requests?: MaintenanceRequest[];
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error || "The job could not be moved.");
        }
        if (payload.requests?.[0]) onRequestChange(payload.requests[0]);
        window.dispatchEvent(new Event("maintsupp:refresh-board"));
        setMobileEditor(null);
        setMobileDraft("");
        onNotify(`${request.id} moved.`);
        return;
      }

      if (mobileEditor.customColumn) {
        let boardValue: string | number | boolean | { start: string; end: string } =
          rawValue.trim();
        if (mobileEditor.kind === "number") {
          boardValue = rawValue.trim()
            ? Number(rawValue.replaceAll(",", ""))
            : "";
          if (
            typeof boardValue === "number" &&
            !Number.isFinite(boardValue)
          ) {
            throw new Error("Please enter a valid number.");
          }
        } else if (mobileEditor.kind === "timeline") {
          const timeline = mobileCustomTimeline(rawValue);
          if (timeline.start && timeline.end && timeline.end < timeline.start) {
            throw new Error("The end date must be on or after the start date.");
          }
          boardValue = timeline;
        }
        await onBoardCellChange(mobileEditor.customColumn, boardValue);
        setMobileEditor(null);
        setMobileDraft("");
        onNotify(`${mobileEditor.title} updated.`);
        return;
      }

      let value: string | number | null = rawValue.trim();

      if (mobileEditor.kind === "number") {
        value = rawValue.trim() ? Number(rawValue.replaceAll(",", "")) : null;
        if (typeof value === "number" && !Number.isFinite(value)) {
          throw new Error("Please enter a valid number.");
        }
      } else if (mobileEditor.kind === "date") {
        value = rawValue.trim()
          ? new Date(`${rawValue}T12:00:00.000Z`).toISOString()
          : null;
      } else if (mobileEditor.field === "tier") {
        value = Number(rawValue);
      } else if (!rawValue.trim() && mobileEditor.allowEmpty) {
        value = null;
      }

      const updated = await onFieldsChange({ [mobileEditor.field]: value });
      onRequestChange(updated);
      setMobileEditor(null);
      setMobileDraft("");
      onNotify(`${mobileEditor.title} updated.`);
    } catch (caught) {
      setMobileEditorError(
        caught instanceof Error ? caught.message : "The field could not be saved.",
      );
    } finally {
      setMobileSaving(false);
    }
  };

  return (
    <>
      <button
        className="drawer-scrim"
        type="button"
        aria-label="Close request"
        onClick={onClose}
      />
      <aside
        ref={drawerRef}
        className="detail-drawer"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={`${request.id} details`}
      >
        <div className="detail-drawer__header">
          <div>
            <span>{request.id}</span>
            <h2>
              {request.source === "Manual" ? "Manual" : "Incoming form answer"}
            </h2>
          </div>
          <div className="detail-drawer__actions">
            {itemActions && (
              <ItemActionsMenu request={request} actions={itemActions} />
            )}
            <button
              className="icon-button"
              type="button"
              onClick={onClose}
              aria-label="Close details"
            >
              <Icon name="close" size={20} />
            </button>
          </div>
        </div>

        <nav className="detail-drawer__tabs" aria-label="Item details sections">
          <button
            className={activeTab === "columns" ? "is-active" : ""}
            type="button"
            onClick={() => setActiveTab("columns")}
          >
            <Icon name="grid" size={15} />
            Columns
          </button>
          <button
            className={activeTab === "updates" ? "is-active" : ""}
            type="button"
            onClick={() => setActiveTab("updates")}
          >
            <Icon name="message" size={15} />
            Updates / {commentCount}
          </button>
          <button
            className={activeTab === "files" ? "is-active" : ""}
            type="button"
            onClick={() => setActiveTab("files")}
          >
            <Icon name="folder" size={15} />
            Files
          </button>
          <button
            className={activeTab === "activity" ? "is-active" : ""}
            type="button"
            onClick={() => setActiveTab("activity")}
          >
            <Icon name="activity" size={15} />
            Activity Log
          </button>
          <button
            className={activeTab === "link" ? "is-active" : ""}
            type="button"
            onClick={() => setActiveTab("link")}
          >
            <Icon name="paperclip" size={15} />
            Contractor link
          </button>
        </nav>

        <div className="detail-drawer__body">
          <MobileMondayColumns
            request={request}
            boardSnapshot={boardSnapshot}
            visible={activeTab === "columns"}
            onEdit={openMobileEditor}
            onOpenEvidence={(kind, column) => {
              setEvidenceOpen(true);
              setEvidenceKind(kind);
              setEvidenceColumn(column ?? null);
            }}
            onBoardCellChange={onBoardCellChange}
            onAddColumn={onAddColumn}
            onNotify={onNotify}
          />
          <div
            className={`drawer-status-line desktop-request-columns${
              activeTab === "columns" ? "" : " is-tab-hidden"
            }`}
          >
            <span className={priorityClass(request.priority)}>
              {request.priority}
            </span>
            <span className="status-chip">{request.status}</span>
          </div>

          <section
            className={`drawer-section desktop-request-columns${
              activeTab === "columns" ? "" : " is-tab-hidden"
            }`}
          >
            <span className="drawer-label">Progress</span>
            <div className="request-progress">
              {stageOrder.map((stage, index) => (
                <button
                  key={stage}
                  type="button"
                  className={
                    index <= currentIndex || stage === request.stage
                      ? "is-complete"
                      : ""
                  }
                  onClick={() => onStatusChange(stage)}
                >
                  <span>
                    {index < currentIndex ? (
                      <Icon name="check" size={13} />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <small>{stageLabel(stage)}</small>
                </button>
              ))}
            </div>
          </section>

          <section
            className={`drawer-section desktop-request-columns${
              activeTab === "columns" ? "" : " is-tab-hidden"
            }`}
          >
            <span className="drawer-label">Issue</span>
            <p className="drawer-description">{request.description}</p>
            <div className="detail-grid">
              <DetailItem icon="map" label="Location" value={request.location} />
              <DetailItem
                icon="tool"
                label="Engineer required"
                value={request.engineer}
              />
              <DetailItem
                icon="user"
                label="Requested by"
                value={request.requester}
              />
              <DetailItem
                icon="calendar"
                label="Date requested"
                value={formatDate(request.requestedAt, true)}
              />
              <DetailItem
                icon="clock"
                label="Next update"
                value={formatDate(request.nextUpdateAt, true)}
              />
              <DetailItem
                icon="chart"
                label="Cost of works"
                value={formatMoney(request.cost)}
              />
            </div>
          </section>

          <section
            className={`drawer-section desktop-request-columns${
              activeTab === "columns" ? "" : " is-tab-hidden"
            }`}
          >
            <div className="drawer-section__title">
              <span className="drawer-label">Assignment</span>
              <span className="tiny-chip">Tier {request.tier}</span>
            </div>
            <div className="assignment-card">
              <Avatar name={request.assignee ?? "Unassigned"} />
              <span>
                <small>MAINTSUPP owner</small>
                <strong>{request.assignee ?? "Not assigned"}</strong>
              </span>
              <span>
                <small>Contractor</small>
                <strong>{request.contractor ?? "To be appointed"}</strong>
              </span>
            </div>
          </section>

          <section
            className={`drawer-section${
              activeTab === "files" ? "" : " is-tab-hidden"
            }`}
          >
            <div className="drawer-section__title">
              <span className="drawer-label">Files &amp; evidence</span>
              <span>
                {(() => {
                  const shown = fileCount ?? request.attachmentCount;
                  return `${shown} file${shown === 1 ? "" : "s"}`;
                })()}
              </span>
            </div>
            {/*
              The pair, above the way in to everything else.
              
              The two picture columns have carried 1,149 fault photographs and
              1,616 completion photographs since the monday import, and the only
              way to compare them was to open the evidence panel, scroll,
              remember, and scroll back. That comparison is what the pair exists
              for — it is what an invoice is checked against.
            */}
            <BeforeAfter
              requestId={request.id}
              reference={request.id}
              refreshToken={evidenceRefreshToken}
            />
            <button
              className="drawer-file-row"
              type="button"
              onClick={() => {
                setEvidenceKind("all");
                setEvidenceOpen(true);
              }}
            >
              <span>
                <Icon name="folder" size={18} />
              </span>
              <div>
                <strong>Request evidence</strong>
                <small>
                  Site photos, approvals, completion evidence and invoices
                </small>
              </div>
              <Icon name="chevron" size={16} />
            </button>
          </section>

          <section
            className={`drawer-section${
              activeTab === "updates" ? "" : " is-tab-hidden"
            }`}
          >
            <div className="drawer-section__title">
              <span className="drawer-label">Update thread</span>
              <span>{threadCount} shown</span>
            </div>
            {/*
              THE PANEL IS `UpdateThread`, built against monday's own.

              What stood here was ~250 lines of cards, a reply box and a
              composer at the BOTTOM of the tab. The owner put the two panels
              side by side and said ours did not have "the same look and tools
              and features"; `db/monday-export/UPDATES-PANEL-CAPTURE.md` is the
              capture that came out of that, and update-thread.tsx answers it
              item by item — composer at the top, `11d` rather than "11 days
              ago", Like, a Reply on every reply, rendered attachments, and
              `… See more`.

              It keeps its own three states, which is why none of them are
              passed: a failed ACTIVITY fetch used to draw "The update history
              could not be loaded" over a thread that had loaded perfectly well.
              The fetching, the counts and the like bookkeeping stay here — the
              drawer owns the data, the panel draws it.
            */}
            <UpdateThread
              updates={updates}
              loading={updatesLoading}
              error={updatesError}
              now={now}
              currentUserName={currentUserName}
              composerRef={setComposerHandle}
              onReload={loadUpdates}
              onSubmit={submitComment}
              onLikeChange={applyLike}
            />
          </section>

          <section
            className={`drawer-section${
              activeTab === "activity" ? "" : " is-tab-hidden"
            }`}
          >
            <div className="drawer-section__title">
              <span className="drawer-label">Activity history</span>
              <span>{activities.length} events</span>
            </div>
            {activitiesLoading && (
              <div className="drawer-history-state">Loading activity…</div>
            )}
            {activitiesError && (
              <div className="drawer-history-state drawer-history-state--error">
                <span>{activitiesError}</span>
                <button type="button" onClick={() => void loadActivities()}>
                  Try again
                </button>
              </div>
            )}
            {!activitiesLoading &&
              !activitiesError &&
              activities.length === 0 && (
                <div className="drawer-history-state">
                  No activity has been recorded yet.
                </div>
              )}
            {!activitiesLoading && !activitiesError && activities.length > 0 && (
              <div className="activity-timeline">
                {activities.map((entry, index) => (
                  <div key={entry.id}>
                    <span
                      className={`activity-dot${
                        index === 0 ? " activity-dot--teal" : ""
                      }`}
                    />
                    <p>
                      <strong>{activityActor(entry.actorEmail, entry.detail)}</strong>{" "}
                      {activityDescription(entry)}
                    </p>
                    <small>{formatDate(entry.createdAt, true)}</small>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section
            className={`drawer-section${
              activeTab === "link" ? "" : " is-tab-hidden"
            }`}
          >
            <ContractorLinkPanel
              requestId={request.id}
              reference={request.id}
              siteName={request.location ?? null}
            />
          </section>

        </div>

        <div
          className={`detail-drawer__footer${
            activeTab === "columns" ? " detail-drawer__footer--columns" : ""
          }`}
        >
          <button
            className="mobile-monday-update-button"
            type="button"
            onClick={() => {
              setActiveTab("updates");
              // The composer is on screen already; put the cursor in it rather
              // than revealing a second copy of it. Queued, because on a phone
              // this is the first render of the Updates tab and the box is
              // mounting in the same commit as the tab switch.
              window.setTimeout(() => composerHandle.current?.focus(), 0);
            }}
          >
            <span>
              <Icon name="plus" size={22} />
            </span>
            Write an update
          </button>
          <div className="detail-drawer__footer-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setActiveTab("updates");
                window.setTimeout(() => composerHandle.current?.focus(), 0);
              }}
            >
              <Icon name="message" size={17} />
              Add update
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() =>
                onStatusChange(
                  request.stage === "Incoming"
                    ? "Booked"
                    : request.stage === "Booked"
                      ? "Attention"
                      : "Completed",
                )
              }
            >
              Advance request
              <Icon name="arrow" size={17} />
            </button>
          </div>
        </div>
      </aside>
      {mobileEditor && (
        <MobileRequestEditor
          editor={mobileEditor}
          draft={mobileDraft}
          error={mobileEditorError}
          saving={mobileSaving}
          onDraftChange={setMobileDraft}
          onClose={() => {
            if (mobileSaving) return;
            setMobileEditor(null);
            setMobileEditorError(null);
          }}
          onSave={(value) => void saveMobileEditor(value)}
        />
      )}
      {evidenceOpen && (
        <EvidenceManager
          request={request}
          initialKind={evidenceKind}
          columnId={evidenceColumn?.id}
          columnTitle={evidenceColumn?.title}
          onClose={() => {
            setEvidenceOpen(false);
            setEvidenceRefreshToken((token) => token + 1);
            if (evidenceColumn) {
              window.dispatchEvent(new Event("maintsupp:refresh-board"));
            }
            setEvidenceColumn(null);
          }}
          onFileCountChange={(count) => {
            /*
             * The tab's header follows the panel while it is open, so adding
             * the first photo does not leave "0 files" behind it. The board
             * refresh stays conditional: only a workspace-column upload
             * changes a CELL, and re-fetching the whole board for a general
             * evidence upload would be a page-wide reload for one number.
             */
            if (evidenceColumn) {
              // Opened for ONE column, so `count` is that column's files, not
              // the job's — adopting it here would put a smaller number in a
              // header that means "everything on this job".
              window.dispatchEvent(new Event("maintsupp:refresh-board"));
            } else {
              setFileCount(count);
            }
          }}
          onRequestChange={onRequestChange}
          onNotify={onNotify}
        />
      )}
    </>
  );
}

function DetailItem({
  icon,
  label,
  value,
}: {
  icon: IconName;
  label: string;
  value: string;
}) {
  return (
    <div className="detail-item">
      <span>
        <Icon name={icon} size={16} />
      </span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function StoreComplianceDrawer({
  store,
  onClose,
}: {
  store: StoreRecord;
  onClose: () => void;
}) {
  return (
    <>
      <button
        className="drawer-scrim"
        type="button"
        aria-label="Close site details"
        onClick={onClose}
      />
      <aside className="detail-drawer">
        <div className="detail-drawer__header">
          <div>
            <span>Compliance profile</span>
            <h2>{store.name}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close details"
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="detail-drawer__body">
          <div className="site-profile-banner">
            <span>
              <Icon name="store" size={21} />
            </span>
            <div>
              <strong>{store.type}</strong>
              <small>{store.address}</small>
            </div>
          </div>
          <section className="drawer-section">
            <div className="drawer-section__title">
              <span className="drawer-label">Required documents</span>
              <span>{store.compliance.length} types</span>
            </div>
            <div className="compliance-document-list">
              {store.compliance.map((item) => (
                <div key={item.kind}>
                  <span className="compliance-doc-icon">
                    <Icon name="document" size={18} />
                  </span>
                  <span>
                    <strong>{item.kind}</strong>
                    <small>
                      {item.expiry
                        ? `Expires ${formatDate(item.expiry)}`
                        : item.state}
                    </small>
                  </span>
                  <span className={complianceTone(item.state)}>
                    <span />
                    {item.state}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}

/**
 * WHAT A FILE DRAWER CAN PREVIEW, and why the list is the server's list.
 *
 * `app/api/files/[id]/route.ts` serves `INLINE_SAFE_TYPES` with their real
 * content type and everything else as `application/octet-stream`, which the
 * browser downloads rather than renders. A drawer that decided for itself what
 * to preview would either embed something the server refuses to serve inline —
 * an empty frame with no explanation — or refuse something the server would
 * happily have shown. The two lists have to be the same list.
 */
function previewKindFor(contentType: string | undefined) {
  if (!contentType) return "none" as const;
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (
    type === "image/jpeg" ||
    type === "image/png" ||
    type === "image/webp" ||
    type === "image/gif" ||
    type === "image/heic" ||
    type === "image/heif"
  ) {
    return "image" as const;
  }
  if (type === "video/mp4" || type === "video/webm" || type === "video/quicktime") {
    return "video" as const;
  }
  if (type === "application/pdf") return "pdf" as const;
  return "none" as const;
}

function FileDetailDrawer({
  file,
  onClose,
}: {
  file: FileRecord;
  onClose: () => void;
}) {
  /*
   * THE DRAWER IS A DIALOG, AND HAS TO BEHAVE LIKE ONE.
   *
   * The same argument the request drawer above already makes, and the same fix
   * — this one was simply missed. It painted over the page behind a scrim as a
   * bare `<aside>`: no `role`, focus left on the row that opened it, and
   * Escape doing nothing, measured closed in 0 of 20 openings across ten widths
   * and both themes. `surface.focus()` rather than the close button's, so a
   * screen reader announces the dialog and its label first; the close button is
   * then one Tab away.
   */
  const drawerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const surface = drawerRef.current;
    if (surface && !surface.contains(document.activeElement)) {
      surface.focus({ preventScroll: true });
    }
    return () => {
      // Only if focus would otherwise be lost — see the request drawer above.
      if (!opener || !document.contains(opener)) return;
      const active = document.activeElement;
      if (!active || active === document.body) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // An anchored popover owns the press while one is open.
      if (document.querySelector(".ms-layer .ms-popover")) return;
      /*
       * Escape inside a box means "abandon what I am typing" everywhere else in
       * this app, and the register's own search field is one Tab from here.
       */
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const preview = previewKindFor(file.contentType);
  const canOpen = Boolean(file.inlineUrl);

  return (
    <>
      <button
        className="drawer-scrim"
        type="button"
        aria-label="Close file details"
        onClick={onClose}
      />
      <aside
        className="detail-drawer detail-drawer--file"
        ref={drawerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`File details: ${file.name}`}
      >
        <div className="detail-drawer__header">
          <div>
            <span>{file.id}</span>
            <h2>{file.name}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close details"
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="detail-drawer__body">
          <div className="file-preview-placeholder">
            {preview === "image" && canOpen ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                className="file-preview__media"
                src={file.inlineUrl}
                alt={file.name}
              />
            ) : preview === "pdf" && canOpen ? (
              <iframe
                className="file-preview__media"
                src={file.inlineUrl}
                title={`Preview of ${file.name}`}
              />
            ) : preview === "video" && canOpen ? (
              <video className="file-preview__media" src={file.inlineUrl} controls />
            ) : (
              <>
                <Icon name="document" size={38} />
                <strong>{file.kind}</strong>
                <span>{file.size}</span>
                {/*
                 * Said rather than implied. The server sends this file as
                 * octet-stream, so there is nothing to embed — and a reader
                 * looking at an icon with no explanation cannot tell that from
                 * a preview that failed to load.
                 */}
                <span>
                  {canOpen
                    ? "This file type cannot be previewed. Download it to open."
                    : "No stored file for this record."}
                </span>
              </>
            )}
          </div>
          {canOpen && (
            <div className="file-preview__actions">
              <a
                className="secondary-button"
                href={file.inlineUrl}
                target="_blank"
                rel="noreferrer"
              >
                <Icon name="search" size={17} />
                Open in new tab
              </a>
              <a
                className="secondary-button"
                href={file.downloadUrl ?? `${file.inlineUrl}?download=1`}
                download={file.name}
              >
                <Icon name="download" size={17} />
                Download
              </a>
            </div>
          )}
          <section className="drawer-section">
            <span className="drawer-label">File details</span>
            <div className="detail-grid">
              <DetailItem icon="store" label="Site" value={file.site} />
              <DetailItem
                icon="wrench"
                label="Work order"
                value={file.requestId ?? "Not linked"}
              />
              <DetailItem
                icon="calendar"
                label="Uploaded"
                value={formatDate(file.uploadedAt, true)}
              />
              <DetailItem icon="shield" label="Status" value={file.status} />
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}

interface CreateRequestDraft {
  location: string;
  requester: string;
  contact: string;
  description: string;
  category: string;
  engineer: string;
  priority: Priority;
}

function CreateRequestModal({
  locations: siteLocations,
  onClose,
  onCreate,
}: {
  locations: string[];
  onClose: () => void;
  onCreate: (draft: CreateRequestDraft, files: File[]) => Promise<void>;
}) {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [draft, setDraft] = useState<CreateRequestDraft>({
    location: "",
    requester: "",
    contact: "",
    description: "",
    category: "Lighting",
    engineer: "Electrician",
    priority: "Medium",
  });
  const firstField = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    firstField.current?.focus();
  }, []);

  const update = (key: keyof CreateRequestDraft, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    setLoading(true);
    setError(null);
    try {
      await onCreate(draft, attachments);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The request could not be saved.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-wrap" role="dialog" aria-modal="true">
      <button
        className="modal-scrim"
        type="button"
        aria-label="Close new request"
        onClick={onClose}
      />
      <div className="request-modal">
        <div className="request-modal__top">
          <div>
            <span className="modal-icon">
              <Icon name="wrench" size={19} />
            </span>
            <div>
              <span>New maintenance request</span>
              <h2>{step === 1 ? "Site & issue" : "Triage details"}</h2>
            </div>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="modal-progress">
          <span className="is-active">
            <i>1</i>
            Request
          </span>
          <b />
          <span className={step === 2 ? "is-active" : ""}>
            <i>2</i>
            Triage
          </span>
        </div>

        <div className="request-modal__body">
          {step === 1 ? (
            <>
              <label className="form-field">
                <span>Location</span>
                <select
                  ref={firstField}
                  value={draft.location}
                  onChange={(event) => update("location", event.target.value)}
                  required
                >
                  <option value="" disabled>
                    Select a site
                  </option>
                  {siteLocations.map((location) => (
                    <option key={location}>{location}</option>
                  ))}
                </select>
              </label>
              <div className="form-grid">
                <label className="form-field">
                  <span>Requester name</span>
                  <input
                    value={draft.requester}
                    placeholder="Full name"
                    onChange={(event) => update("requester", event.target.value)}
                  />
                </label>
                <label className="form-field">
                  <span>Contact number</span>
                  <input
                    value={draft.contact}
                    placeholder="+44"
                    onChange={(event) => update("contact", event.target.value)}
                  />
                </label>
              </div>
              <label className="form-field">
                <span>Description of works required</span>
                <textarea
                  value={draft.description}
                  placeholder="Describe what is happening, where it is and any immediate risk…"
                  rows={5}
                  onChange={(event) =>
                    update("description", event.target.value)
                  }
                />
                <small>{draft.description.length}/800 characters</small>
              </label>
              <label className="file-drop">
                <input
                  type="file"
                  multiple
                  accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
                  onChange={(event) =>
                    setAttachments(Array.from(event.currentTarget.files ?? []))
                  }
                />
                <span>
                  <Icon name="upload" size={20} />
                </span>
                <strong>
                  {attachments.length
                    ? `${attachments.length} file${attachments.length > 1 ? "s" : ""} selected`
                    : "Add photos, videos or documents"}
                </strong>
                <small>
                  Files up to 25 MB; videos up to 90 MB each. Large videos upload in parts.
                </small>
              </label>
            </>
          ) : (
            <>
              <div className="form-grid">
                <label className="form-field">
                  <span>Priority</span>
                  <select
                    value={draft.priority}
                    onChange={(event) =>
                      update("priority", event.target.value)
                    }
                  >
                    <option>Urgent</option>
                    <option>High</option>
                    <option>Medium</option>
                    <option>Low</option>
                  </select>
                </label>
                <label className="form-field">
                  <span>Category</span>
                  <select
                    value={draft.category}
                    onChange={(event) =>
                      update("category", event.target.value)
                    }
                  >
                    <option>Lighting</option>
                    <option>Electrical</option>
                    <option>Joinery</option>
                    <option>Glass</option>
                    <option>HVAC</option>
                    <option>Plumbing</option>
                    <option>CCTV</option>
                    <option>Digital display</option>
                    <option>Other</option>
                  </select>
                </label>
              </div>
              <label className="form-field">
                <span>Engineer required</span>
                <select
                  value={draft.engineer}
                  onChange={(event) => update("engineer", event.target.value)}
                >
                  <option>Electrician</option>
                  <option>Handyman</option>
                  <option>HVAC</option>
                  <option>Plumber</option>
                  <option>Specialist</option>
                </select>
              </label>
              <div className="triage-preview">
                <span>
                  <Icon name="spark" size={18} />
                </span>
                <div>
                  <strong>Routing preview</strong>
                  <p>
                    This request will enter <b>Incoming requests</b> with a{" "}
                    <b>{draft.priority.toLowerCase()}</b> priority and will be
                    visible to the operations team immediately.
                  </p>
                </div>
              </div>
              <div className="request-review">
                <span>
                  <small>Site</small>
                  <strong>{draft.location}</strong>
                </span>
                <span>
                  <small>Requested by</small>
                  <strong>{draft.requester}</strong>
                </span>
                <span>
                  <small>Evidence</small>
                  <strong>{attachments.length} files</strong>
                </span>
              </div>
            </>
          )}

          {error && (
            <div className="form-error" role="alert">
              <Icon name="alert" size={17} />
              {error}
            </div>
          )}
        </div>

        <div className="request-modal__footer">
          <button
            className="secondary-button"
            type="button"
            onClick={() => (step === 1 ? onClose() : setStep(1))}
          >
            {step === 1 ? "Cancel" : "Back"}
          </button>
          {step === 1 ? (
            <button
              className="primary-button"
              type="button"
              disabled={
                !draft.location ||
                !draft.requester.trim() ||
                !draft.contact.trim() ||
                draft.description.trim().length < 10
              }
              onClick={() => setStep(2)}
            >
              Continue
              <Icon name="arrow" size={17} />
            </button>
          ) : (
            <button
              className="primary-button"
              type="button"
              disabled={loading}
              onClick={submit}
            >
              {loading ? "Creating…" : "Create request"}
              {!loading && <Icon name="check" size={17} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
