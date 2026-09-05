"use client";

/**
 * THE REPORT TAB — part 2, and nothing from part 1.
 *
 * WHAT IS AND IS NOT ON THIS SCREEN
 *
 * Every section in `document-model.ts` already carried `part: 1 | 2`, and this
 * tab is that line drawn on the screen: §3 Executive Summary through §13 SLA
 * Rules. So there is no invoice total here, no billable-sites table, no VAT and
 * no fee — not hidden, absent. `PART_FOR_KIND.report` is 2, `sectionsFor`
 * honours it, and the preview and the three exports on this tab are handed
 * `kind: "report"`, which means the Word file a client receives from here
 * cannot contain the service fee that was being charged for the work it
 * describes.
 *
 * That separation is the point of the tab rather than a tidiness exercise. The
 * combined document put a MAINTSUPP invoice total on page one of a maintenance
 * report, where the owner's own instruction is that the fee "must never read as
 * maintenance expenditure" — the two are now different documents with different
 * filenames, and neither can be sent by mistake for the other.
 *
 * THE PERIOD AND THE DOCUMENT ARE SHARED WITH THE INVOICE TAB
 *
 * `useGeneratorDocument` is mounted once, above both tabs, in `ReportsView`.
 * Saving a draft here and switching to Invoice keeps the same document open —
 * they are two views of one row, not two documents.
 *
 * NOTHING HERE COMPUTES A FIGURE. `maintenanceKpiRows` and
 * `buildReportDocument` are the same functions the exporters call.
 */

import { useMemo, useState } from "react";
import { Icon } from "../../../components";
import { AnalyticsMetricCard } from "../dashboard-analytics";
import { maintenanceKpiRows, SPEND_LABELS } from "../../../lib/exports/document-model";
import { formatMoney } from "../../../lib/exports/format";
import { CombinedDocumentPreview } from "./report-preview";
import { GeneratorActionBar } from "./generator-actions";
import { HoldsPanel } from "./holds-panel";
import {
  DataIssuesPanel,
  GeneratorAlert,
  GeneratorSetupCards,
  JOBS_ITEM_HREF,
  StatusChip,
} from "./invoice-generator";
import type { GeneratorController, GeneratorIssue } from "./invoice-generator";

const ISSUES_ANCHOR = "report-issues";

export function ReportTab({ generator }: { generator: GeneratorController }) {
  const { payload, currency, status, snapshot, computing } = generator;
  const [showPreview, setShowPreview] = useState(false);
  const [drill, setDrill] = useState<string | null>(null);
  /*
   * Which job's holds are open, if any.
   *
   * A hold is the only thing on this screen that CHANGES a published number —
   * approved hold days are subtracted from the elapsed time a client is judged
   * by — so it is reachable from the drill-down, beside the job it belongs to,
   * rather than from a settings page somebody has to know exists.
   */
  const [holdsFor, setHoldsFor] = useState<{ requestId: string; reference: string | null } | null>(null);

  const maintenanceCards = payload ? maintenanceKpiRows(payload) : [];

  /*
   * THE REPORT'S OWN ISSUES.
   *
   * `maintenance.dataQuality` and nothing else. A missing site fee is an
   * INVOICE defect and belongs on the Invoice tab beside the line it applies
   * to; putting it here would put an invoice concern back in the maintenance
   * report, which is exactly what the split removed. The finalisation blockers
   * are passed through because both tabs carry Finalise, and a reason it cannot
   * be pressed is not something a reader should change tab to read.
   */
  const issues: GeneratorIssue[] = useMemo(
    () =>
      (payload?.maintenance.dataQuality ?? []).map((finding) => ({
        severity: finding.severity,
        code: finding.code,
        message: finding.message,
        href: finding.href,
      })),
    [payload],
  );
  const blockingCount =
    issues.filter((issue) => issue.severity === "blocking").length + generator.blockers.length;

  const drillRows = useMemo(() => {
    if (!payload || !drill) return [];
    const log = payload.maintenance.jobLog.flatMap((group) =>
      group.rows.map((row) => ({ ...row, group: group.group })),
    );
    switch (drill) {
      case "completed":
        return log.filter((row) => row.group === "Completed");
      case "open":
        return log.filter((row) => row.group !== "Completed" && row.group !== "Cancelled");
      case "hold":
        return log.filter((row) => row.group === "On Hold");
      case "past-target":
        return payload.maintenance.openPastTarget.map((row) => ({
          requestId: row.requestId,
          reference: row.reference,
          siteName: row.siteName,
          issue: row.issue,
          group: row.status,
          raisedOn: row.raisedOn,
        }));
      case "critical":
        return payload.maintenance.criticalOpen.map((row) => ({
          requestId: row.requestId,
          reference: row.reference,
          siteName: row.siteName,
          issue: row.issue,
          group: row.status,
          raisedOn: row.raisedOn,
        }));
      case "sla":
        return payload.maintenance.sla.map((row) => ({
          requestId: row.requestId,
          reference: row.reference,
          siteName: row.siteName,
          issue: row.description,
          group: row.result,
          raisedOn: null,
        }));
      default:
        return log;
    }
  }, [drill, payload]);

  return (
    <div className="reports-generator">
      <GeneratorActionBar
        generator={generator}
        kind="report"
        issuesAnchorId={ISSUES_ANCHOR}
        blockingCount={blockingCount}
        onGenerate={() => {
          setShowPreview(true);
          void generator.compute();
        }}
      />

      <GeneratorAlert generator={generator} />

      <GeneratorSetupCards generator={generator} />

      {/* ── Maintenance KPI cards ──────────────────────────────────────── */}
      <section className="reports-card" aria-labelledby="report-maintenance-heading">
        <header className="reports-card__head">
          <h2 id="report-maintenance-heading">
            <Icon name="tool" size={17} />
            Maintenance performance
            <StatusChip status={status} />
            {computing && <span className="reports-computing">Recalculating…</span>}
          </h2>
          <p>What the portfolio did in this period. Select a figure to list the jobs behind it.</p>
        </header>
        {payload ? (
          <>
            <div className="reports-kpis reports-kpis--wide" aria-label="Maintenance figures">
              {maintenanceCards.map((card) => (
                <AnalyticsMetricCard
                  key={card.key}
                  label={card.label}
                  value={card.value}
                  icon="chart"
                  tone={card.key === "criticalOpenJobs" ? "red" : card.key === "slaPerformance" ? "blue" : "teal"}
                  onClick={() => setDrill((current) => (current === card.drill ? null : card.drill))}
                />
              ))}
            </div>

            {drill && (
              <div className="reports-drill">
                <header>
                  <h3>{drillRows.length} job{drillRows.length === 1 ? "" : "s"} behind this figure</h3>
                  <button type="button" onClick={() => setDrill(null)}>
                    Close <Icon name="close" size={13} />
                  </button>
                </header>
                <div className="reports-table-scroll" tabIndex={0} role="region" aria-label="Jobs behind this figure">
                  <table className="reports-table">
                    <thead>
                      <tr>
                        <th scope="col">Reference</th>
                        <th scope="col">Site</th>
                        <th scope="col">Job</th>
                        <th scope="col">State</th>
                        <th scope="col">Holds</th>
                        <th scope="col">Open</th>
                      </tr>
                    </thead>
                    <tbody>
                      {drillRows.map((row) => (
                        <tr key={row.requestId}>
                          <td data-label="Reference">{row.reference ?? row.requestId}</td>
                          <td data-label="Site">{row.siteName}</td>
                          <td data-label="Job">{row.issue}</td>
                          <td data-label="State">{row.group}</td>
                          <td data-label="Holds">
                            <button
                              type="button"
                              className="reports-drill__holds"
                              onClick={() =>
                                setHoldsFor((current) =>
                                  current?.requestId === row.requestId
                                    ? null
                                    : { requestId: row.requestId, reference: row.reference ?? null },
                                )
                              }
                            >
                              {holdsFor?.requestId === row.requestId ? "Hide holds" : "Holds"}
                            </button>
                          </td>
                          <td data-label="Open">
                            <a href={JOBS_ITEM_HREF(row.requestId)}>
                              Open on the board <Icon name="chevron" size={13} />
                            </a>
                          </td>
                        </tr>
                      ))}
                      {!drillRows.length && (
                        <tr>
                          <td colSpan={6} className="reports-empty">
                            No job in this period matches that figure.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {holdsFor ? (
                  <HoldsPanel
                    requestId={holdsFor.requestId}
                    reference={holdsFor.reference}
                    /*
                     * `holds.approve` maps to `settings.edit` in
                     * REPORT_CAPABILITIES, which is exactly what `canSettle`
                     * already resolves — so the button follows the same
                     * capability the route enforces rather than a second idea
                     * of who may approve. This only decides whether to DRAW it;
                     * a client that lied here would still be refused.
                     */
                    canApprove={generator.canSettle === true}
                  />
                ) : null}
              </div>
            )}

            {/* THE FIVE FIGURES, SEPARATELY LABELLED. The owner's instruction was
                that the invoice total must never read as maintenance
                expenditure, so the service fee is first, is labelled as the
                invoice, and the panel says in words that these do not add up.
                It appears on the REPORT because the fee is what the reader is
                most likely to mistake for expenditure; the invoice itself is on
                its own tab and does not restate these five. */}
            <div className="reports-spend">
              <h3>Expenditure, reported separately</h3>
              <p>
                These five figures are <strong>not additive</strong>. The service fee is what
                MAINTSUPP invoices; the others are what the portfolio spent on maintenance.
              </p>
              <dl>
                <div className="reports-spend__row is-fee">
                  <dt>{SPEND_LABELS.serviceFee}</dt>
                  <dd>{formatMoney(payload.maintenance.spend.serviceFeePence, currency)}</dd>
                </div>
                <div className="reports-spend__row">
                  <dt>{SPEND_LABELS.completed}</dt>
                  <dd>{formatMoney(payload.maintenance.spend.completedMaintenancePence, currency)}</dd>
                </div>
                <div className="reports-spend__row">
                  <dt>{SPEND_LABELS.openCommitted}</dt>
                  <dd>{formatMoney(payload.maintenance.spend.openCommittedPence, currency)}</dd>
                </div>
                <div className="reports-spend__row">
                  <dt>{SPEND_LABELS.project}</dt>
                  <dd>{formatMoney(payload.maintenance.spend.projectPence, currency)}</dd>
                </div>
                <div className="reports-spend__row">
                  <dt>{SPEND_LABELS.routine}</dt>
                  <dd>{formatMoney(payload.maintenance.spend.routinePence, currency)}</dd>
                </div>
              </dl>
            </div>
          </>
        ) : (
          <p className="reports-empty">
            {computing
              ? "Computing this period's maintenance performance…"
              : "Choose a period to compute the report."}
          </p>
        )}
      </section>

      {/* ── Data quality ───────────────────────────────────────────────── */}
      {payload && (
        <DataIssuesPanel
          id={ISSUES_ANCHOR}
          lead="These are findings about the maintenance data this report rests on. Anything wrong with a site fee is on the Invoice tab, beside the line it applies to."
          issues={issues}
          blockers={generator.blockers}
          advisories={generator.warnings}
        />
      )}

      {/* ── The report itself ──────────────────────────────────────────── */}
      {payload && (
        <section className="reports-card" aria-labelledby="report-preview-heading">
          <header className="reports-card__head">
            <h2 id="report-preview-heading">
              <Icon name="document" size={17} />
              Maintenance report
            </h2>
            <p>
              Sections 3 to 13 — the performance report on its own, with no invoice figures in it.
              The Word, PDF and Excel files are made from this same value, so their totals cannot
              differ from what is on screen.
            </p>
            <button
              type="button"
              className="reports-button"
              onClick={() => setShowPreview((current) => !current)}
              aria-expanded={showPreview}
            >
              {showPreview ? "Hide preview" : "Generate Preview"}
              <Icon name="chevron" size={14} />
            </button>
          </header>
          {showPreview && (
            <CombinedDocumentPreview payload={payload} snapshot={snapshot} kind="report" />
          )}
          {!showPreview && (
            <p className="reports-empty">
              MAINTSUPP Maintenance Report is ready to preview. Previewing changes nothing and never
              finalises.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
