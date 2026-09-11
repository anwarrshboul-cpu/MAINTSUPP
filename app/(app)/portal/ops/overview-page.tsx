"use client";

/**
 * OPERATIONS CENTRE → OVERVIEW.
 *
 * A thin shell. The page is `OiDash` — Job Intelligence, then Spend &
 * Reporting, then Compliance, each read from the endpoint that already owns
 * its figures — and beneath it, in the island's own footer row, the two
 * data-fix tools that stay reachable from here: "Resolve contractor names" and
 * "Assign jobs to a site", opened in the page's dialog sheet.
 *
 * Every figure is counted on the server. `requests.filter(...)` appears nowhere
 * on this page and cannot: the component is never given a job list.
 *
 * ── WHAT IS NO LONGER COMPOSED HERE ───────────────────────────────────────
 *
 * The dashboard block (`ov-dash.tsx`), the "Live operations" header, the
 * filter bar, the jump nav and the six legacy cards (`PulseRow`,
 * `AtAGlanceCard`, `FinancialStatusCard`, `PerformanceCard`,
 * `JobBreakdownCard`, `SitesAttentionCard`), the records panel and the meters
 * tool. Their files are left in place, unimported.
 *
 * ── ONE STATE, IN THE URL ─────────────────────────────────────────────────
 *
 * `OiDash` owns `portfolio`, `from` and `to` in the address bar, so a filtered
 * Overview is a link that means the same thing to whoever opens it. Nothing
 * here touches `localStorage`.
 */

import { useState } from "react";
import opsCss from "./ops.css?url";
import toolsCss from "./overview-tools.css?url";
import { announceDataChanged } from "./ops-url-state";
import { OiDash } from "./oi-dash";
import { ResolveNames } from "./resolve-names";
import { BulkSiteAssign } from "./bulk-site-assign";

export function OverviewPage({
  onNavigateToJobs,
  onNavigateToCompliance,
  onNavigateToSites,
}: {
  onNavigateToJobs: (query: string) => void;
  /** Kept for the shell, which passes it; the Overview no longer opens a single job. */
  onOpenJob: (id: string) => void;
  /** The Compliance register, optionally with a register query to apply. */
  onNavigateToCompliance: (query?: string) => void;
  onNavigateToSites: (query: string) => void;
}) {
  const [tool, setTool] = useState<"contractors" | "sites" | null>(null);

  return (
    <>
      {/* The dialog sheet's own chrome, and the tools' controls inside it. */}
      <link rel="stylesheet" href={opsCss} precedence="default" />
      <link rel="stylesheet" href={toolsCss} precedence="default" />

      <section className="ops-page">
        <OiDash
          onNavigateToJobs={onNavigateToJobs}
          onNavigateToCompliance={onNavigateToCompliance}
          onNavigateToSites={onNavigateToSites}
          footer={
            <>
              <span className="oi-footer__label">Data tools</span>
              <button type="button" className="oi-footer__tool" onClick={() => setTool("contractors")}>
                Resolve contractor names
              </button>
              <button type="button" className="oi-footer__tool" onClick={() => setTool("sites")}>
                Assign jobs to a site
              </button>
            </>
          }
        />

        {/*
          The two write-side tools. Nothing on this page changes a job record
          except these, and each states what it will do before it does it. A
          change announces itself, so every section on the page re-reads.
        */}
        {tool === "contractors" ? (
          <OverviewTool title="Resolve contractor names" onClose={() => setTool(null)}>
            <ResolveNames onChanged={announceDataChanged} />
          </OverviewTool>
        ) : null}
        {tool === "sites" ? (
          <OverviewTool title="Assign jobs to a site" onClose={() => setTool(null)}>
            <BulkSiteAssign onAssigned={announceDataChanged} />
          </OverviewTool>
        ) : null}
      </section>
    </>
  );
}

/**
 * One dialog shell for the tools.
 *
 * A dialog rather than a route because each is opened from the page that shows
 * the problem it fixes, and sending the reader to another screen loses that
 * context — which is most of why "31 jobs point at no site" went unfixed for as
 * long as it did.
 */
function OverviewTool({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="ops-sheet ovw-tool oi-tool"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ops-sheet__panel ovw-tool__panel">
        <div className="ops-sheet__head">
          <h2>{title}</h2>
          <button type="button" className="ops-menu__button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
