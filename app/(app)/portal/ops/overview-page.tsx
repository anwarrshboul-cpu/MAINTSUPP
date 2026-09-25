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
import { LayerPortal } from "../overlay/anchored";
import { useDialogBehaviour } from "../overlay/dialog-behaviour";

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
              <span className="oi-footer__label" id="oi-footer-label">Data tools</span>
              {/* What the two are for, said once (visual pass, round 2): they are
                  the only controls on this page that change a job record. */}
              <span className="oi-footer__hint">Tidy the job records these figures are read from.</span>
              <span className="oi-footer__tools" role="group" aria-labelledby="oi-footer-label">
                <button type="button" className="oi-footer__tool" onClick={() => setTool("contractors")}>
                  Resolve contractor names
                </button>
                <button type="button" className="oi-footer__tool" onClick={() => setTool("sites")}>
                  Assign jobs to a site
                </button>
              </span>
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
 *
 * ── IT SAID `aria-modal`, AND WAS NOT ONE ─────────────────────────────────
 *
 * This shell declared `role="dialog" aria-modal="true"` and then implemented a
 * close button and a backdrop click and nothing else. Escape did nothing. Focus
 * stayed on the footer button that opened it, so a keyboard reader was told a
 * modal had opened and left standing outside it, and Tab walked out into the
 * page behind rather than cycling inside. And it sat on `.ops-sheet`'s
 * hardcoded `z-index: 60`, under the topbar (300) and the sidebar (410): the
 * measured result was that clicking "Jobs" in the sidebar navigated away with
 * the dialog still open on top of a different section.
 *
 * Both halves are now the product's own answer rather than a local one.
 * `LayerPortal layer="modal"` is the shared z scale — the same one
 * `board-modal.tsx` uses — so the ordering is a property of the layer rather
 * than a number that has to win an argument with the chrome. And
 * `useDialogBehaviour` is `board-modal.tsx`'s hook, extracted so there is one
 * implementation of what `aria-modal` promises: Escape, focus in, focus back to
 * the opener, the Tab trap, and the one body scroll lock.
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
  const { surface, onBackdrop, onKeyDown } = useDialogBehaviour(true, onClose);
  const titleId = `ovw-tool-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <LayerPortal layer="modal">
      <div className="ops-sheet ovw-tool oi-tool" onPointerDown={onBackdrop}>
        <div
          ref={surface}
          className="ops-sheet__panel ovw-tool__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          <div className="ops-sheet__head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="ops-menu__button" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
          {children}
        </div>
      </div>
    </LayerPortal>
  );
}
