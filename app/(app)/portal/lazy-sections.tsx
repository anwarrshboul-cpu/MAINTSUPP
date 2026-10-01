"use client";

/*
 * SECTIONS LOADED WHEN THEY ARE OPENED, NOT WITH THE SHELL.
 *
 * The portal shipped as one 1.4MB script: every section, opened or not, was
 * downloaded and parsed before the first screen drew. A section listed here is
 * its own chunk, fetched the first time somebody opens it.
 *
 * Each export keeps the eager component's NAME and PROPS, so `portal-app.tsx`
 * changes one import path and none of its JSX. The `import type` lines are
 * erased at build time — they borrow the props without pulling the modules into
 * the shell's chunk. Only add a section here if nothing else imports it
 * statically, or its code stays in the shell anyway. Left eager on purpose:
 * generic components (`ContractorRegister`), whose type parameter a wrapper
 * would erase, and anything mounted on every screen (`SectionManager`, a
 * dialog gated by its own `open` prop), which would only flash a placeholder.
 */

import { lazy, Suspense, type ComponentProps, type ComponentType } from "react";
import type { InvoiceTrackerPage as EagerInvoiceTrackerPage } from "./finance/invoice-tracker-page";
import type { ContractorProfile as EagerContractorProfile } from "./contractor-profile";
import type { CompliancePage as EagerCompliancePage } from "./ops/compliance-page";
import type { ContractorsList as EagerContractorsList } from "./ops/contractors-list";
import type { SitesManager as EagerSitesManager } from "./sites/sites-manager";
import type { AdminClientsView as EagerAdminClientsView } from "./views/admin-clients";
import type { AdminRolesView as EagerAdminRolesView } from "./views/admin-roles";
import type { AdminUsersView as EagerAdminUsersView } from "./views/admin-users";
import type { AuditLog as EagerAuditLog } from "./views/audit-log";
import type { ReconcilePanel as EagerReconcilePanel } from "./views/reconcile-panel";
import type { ReportTab as EagerReportTab } from "./reports/report-tab";
import type { InvoiceTab as EagerInvoiceTab } from "./reports/invoice-tab";
import type { GeneratedDocuments as EagerGeneratedDocuments } from "./reports/generated-documents";
import type { WorkspaceDataManager as EagerWorkspaceDataManager } from "./workspace-data-manager";

function SectionLoading() {
  return (
    <div role="status" aria-live="polite" style={{ padding: 24, color: "var(--muted, #60727d)" }}>
      Loading…
    </div>
  );
}

/** A section, fetched on first render, with the same props as the eager one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- props are re-typed by each export below
function lazySection<T extends ComponentType<any>>(load: () => Promise<T>) {
  const Lazy = lazy(() => load().then((component) => ({ default: component })));
  function Section(props: ComponentProps<T>) {
    return (
      <Suspense fallback={<SectionLoading />}>
        <Lazy {...props} />
      </Suspense>
    );
  }
  return Section;
}

export const InvoiceTrackerPage = lazySection<typeof EagerInvoiceTrackerPage>(() =>
  import("./finance/invoice-tracker-page").then((m) => m.InvoiceTrackerPage));
export const ContractorProfile = lazySection<typeof EagerContractorProfile>(() =>
  import("./contractor-profile").then((m) => m.ContractorProfile));
export const CompliancePage = lazySection<typeof EagerCompliancePage>(() =>
  import("./ops/compliance-page").then((m) => m.CompliancePage));
export const ContractorsList = lazySection<typeof EagerContractorsList>(() =>
  import("./ops/contractors-list").then((m) => m.ContractorsList));
export const SitesManager = lazySection<typeof EagerSitesManager>(() =>
  import("./sites/sites-manager").then((m) => m.SitesManager));
export const AdminClientsView = lazySection<typeof EagerAdminClientsView>(() =>
  import("./views/admin-clients").then((m) => m.AdminClientsView));
export const AdminRolesView = lazySection<typeof EagerAdminRolesView>(() =>
  import("./views/admin-roles").then((m) => m.AdminRolesView));
export const AdminUsersView = lazySection<typeof EagerAdminUsersView>(() =>
  import("./views/admin-users").then((m) => m.AdminUsersView));
export const AuditLog = lazySection<typeof EagerAuditLog>(() =>
  import("./views/audit-log").then((m) => m.AuditLog));
export const ReconcilePanel = lazySection<typeof EagerReconcilePanel>(() =>
  import("./views/reconcile-panel").then((m) => m.ReconcilePanel));
export const ReportTab = lazySection<typeof EagerReportTab>(() =>
  import("./reports/report-tab").then((m) => m.ReportTab));
export const InvoiceTab = lazySection<typeof EagerInvoiceTab>(() =>
  import("./reports/invoice-tab").then((m) => m.InvoiceTab));
export const GeneratedDocuments = lazySection<typeof EagerGeneratedDocuments>(() =>
  import("./reports/generated-documents").then((m) => m.GeneratedDocuments));
export const WorkspaceDataManager = lazySection<typeof EagerWorkspaceDataManager>(() =>
  import("./workspace-data-manager").then((m) => m.WorkspaceDataManager));
