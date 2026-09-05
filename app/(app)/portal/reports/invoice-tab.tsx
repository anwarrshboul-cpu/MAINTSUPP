"use client";

/**
 * THE INVOICE TAB — part 1, and nothing from part 2.
 *
 * WHAT IS AND IS NOT ON THIS SCREEN
 *
 * §1 Invoice Summary and §2 Site Charges: the billable active sites, the fee
 * applied to each, VAT, and the total payable. There is no job log here, no SLA
 * table, no hold, no maintenance spend — `PART_FOR_KIND.invoice` is 1,
 * `sectionsFor` honours it, and the preview and the three exports on this tab
 * are handed `kind: "invoice"`, so the file a client receives with their bill
 * does not carry five hundred rows of somebody else's job history.
 *
 * ── WHY THE FIVE EXPENDITURE FIGURES ARE NOT ON THIS TAB ──────────────────
 *
 * They are on the Report, where their heading says in words that they are not
 * additive. Restating the service fee beside the invoice total — two figures
 * that ARE the same money, described differently — is the single most likely
 * way for the owner's "the fee must never read as maintenance expenditure" rule
 * to be broken by a screen rather than by a sentence. The invoice tab shows
 * what is being charged; the report shows what was spent; the reader is never
 * asked to hold both meanings of one number at once.
 *
 * THE DOCUMENT IS SHARED WITH THE REPORT TAB. `useGeneratorDocument` is mounted
 * once above both, in `ReportsView` — same draft, same saved row, same
 * lifecycle. NOTHING HERE COMPUTES A FIGURE: the totals row is
 * `payload.invoice.totals`, never a sum of the rows above it.
 */

import { useMemo, useState } from "react";
import { Icon } from "../../../components";
import type { BillableSiteLine, CombinedReportPayload } from "../../../lib/reporting/contract";
import { invoiceKpiRows } from "../../../lib/exports/document-model";
import { formatBasisPoints, formatMoney } from "../../../lib/exports/format";
import { CombinedDocumentPreview } from "./report-preview";
import { GeneratorActionBar } from "./generator-actions";
import {
  DataIssuesPanel,
  formatDate,
  GeneratorAlert,
  GeneratorSetupCards,
  StatusChip,
} from "./invoice-generator";
import type { GeneratorController, GeneratorIssue } from "./invoice-generator";

const ISSUES_ANCHOR = "invoice-issues";

/* ── The billable-sites table ────────────────────────────────────────────── */

function BillableSitesTable({
  payload,
  canEdit,
  onExclude,
  onInclude,
  busyLine,
}: {
  payload: CombinedReportPayload;
  canEdit: boolean;
  onExclude: (line: BillableSiteLine) => void;
  onInclude: (line: BillableSiteLine) => void;
  busyLine: number | null;
}) {
  const currency = payload.invoice.currency;
  const totals = payload.invoice.totals;
  return (
    <section className="reports-card" aria-labelledby="invoice-sites-heading">
      <header className="reports-card__head">
        <h2 id="invoice-sites-heading">
          <Icon name="store" size={17} />
          Billable active sites
        </h2>
        <p>
          One line per site considered for this period. An excluded line keeps its row so the
          exclusion stays visible, and is not counted in the totals.
        </p>
      </header>
      <div className="reports-table-scroll" tabIndex={0} role="region" aria-label="Billable sites">
        <table className="reports-table reports-table--sites">
          <thead>
            <tr>
              <th scope="col">Site name</th>
              <th scope="col">Site reference</th>
              <th scope="col">Active status</th>
              <th scope="col">Active from</th>
              <th scope="col">Active to</th>
              <th scope="col">Billable</th>
              <th scope="col" className="is-right">Applied fee</th>
              <th scope="col">Fee source</th>
              <th scope="col" className="is-right">VAT rate</th>
              <th scope="col" className="is-right">Line subtotal</th>
              <th scope="col">Inclusion</th>
              <th scope="col">Validation</th>
              {canEdit && <th scope="col">Action</th>}
            </tr>
          </thead>
          <tbody>
            {payload.invoice.lines.map((line) => {
              const worst = line.validation.find((entry) => entry.severity === "blocking")
                ?? line.validation.find((entry) => entry.severity === "warning")
                ?? line.validation[0];
              return (
                <tr key={line.lineNo} className={line.included ? undefined : "is-excluded"}>
                  <td data-label="Site name"><strong>{line.siteName}</strong></td>
                  <td data-label="Site reference">{line.siteReference ?? "—"}</td>
                  <td data-label="Active status">{line.activeStatus}</td>
                  <td data-label="Active from">{formatDate(line.activeFrom)}</td>
                  <td data-label="Active to">{formatDate(line.activeTo)}</td>
                  <td data-label="Billable">{line.billable ? "Yes" : "No"}</td>
                  <td data-label="Applied fee" className="is-right">
                    {formatMoney(line.feePence, currency)}
                  </td>
                  <td data-label="Fee source">
                    {line.feeSource ?? (
                      <span className="reports-cell reports-cell--blocking">No fee found</span>
                    )}
                  </td>
                  <td data-label="VAT rate" className="is-right">
                    {formatBasisPoints(line.vatRateBasisPoints)}
                  </td>
                  <td data-label="Line subtotal" className="is-right">
                    {formatMoney(line.lineSubtotalPence, currency)}
                  </td>
                  <td data-label="Inclusion">
                    {line.included ? (
                      "Included"
                    ) : (
                      <span className="reports-exclusion">
                        Excluded
                        {line.excludedByEmail && <small>by {line.excludedByEmail}</small>}
                        {line.exclusionReason && <small>{line.exclusionReason}</small>}
                      </span>
                    )}
                  </td>
                  <td data-label="Validation">
                    {worst ? (
                      <span className={`reports-cell reports-cell--${worst.severity}`}>
                        {worst.message}
                      </span>
                    ) : (
                      <span className="reports-cell reports-cell--good">Clear</span>
                    )}
                  </td>
                  {canEdit && (
                    <td data-label="Action">
                      <button
                        type="button"
                        className="reports-linkish"
                        disabled={busyLine === line.lineNo}
                        onClick={() => (line.included ? onExclude(line) : onInclude(line))}
                      >
                        {line.included ? "Exclude…" : "Include"}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {!payload.invoice.lines.length && (
              <tr>
                <td colSpan={canEdit ? 13 : 12} className="reports-empty">
                  No site was billable in this period, so the invoice carries no lines.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td data-label="Total sites"><strong>{totals.totalSites} sites</strong></td>
              <td data-label="Included"><strong>{totals.includedSites} included</strong></td>
              <td data-label="Excluded"><strong>{totals.excludedSites} excluded</strong></td>
              <td colSpan={6} />
              <td data-label="Subtotal" className="is-right">
                <strong>{formatMoney(totals.subtotalPence, currency)}</strong>
              </td>
              <td data-label="VAT"><strong>VAT {formatMoney(totals.vatPence, currency)}</strong></td>
              <td data-label="Total" colSpan={canEdit ? 2 : 1}>
                <strong>Total {formatMoney(totals.totalPence, currency)}</strong>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

/* ── The tab ─────────────────────────────────────────────────────────────── */

export function InvoiceTab({ generator }: { generator: GeneratorController }) {
  const { payload, status, snapshot, computing, canEdit, editable, busyLine } = generator;
  const [showPreview, setShowPreview] = useState(false);

  const invoiceCards = payload ? invoiceKpiRows(payload) : [];

  /*
   * THE INVOICE'S OWN ISSUES.
   *
   * Per-LINE validation, which is what §2 Site Charges is validated by: a
   * missing fee, a site active for part of the period, a duplicate charge. The
   * maintenance data-quality findings are on the Report tab, where the data
   * they describe is. Both tabs are shown the finalisation blockers, because
   * both carry Finalise.
   */
  const issues: GeneratorIssue[] = useMemo(
    () =>
      (payload?.invoice.lines ?? []).flatMap((line) =>
        line.validation.map((entry) => ({
          severity: entry.severity,
          code: entry.code,
          message: `${line.siteName}: ${entry.message}`,
          href: null as string | null,
        })),
      ),
    [payload],
  );
  const blockingCount =
    issues.filter((issue) => issue.severity === "blocking").length + generator.blockers.length;

  return (
    <div className="reports-generator">
      <GeneratorActionBar
        generator={generator}
        kind="invoice"
        issuesAnchorId={ISSUES_ANCHOR}
        blockingCount={blockingCount}
        onGenerate={() => {
          setShowPreview(true);
          void generator.compute();
        }}
      />

      <GeneratorAlert generator={generator} />

      <GeneratorSetupCards generator={generator} />

      {/* ── Invoice KPI cards ──────────────────────────────────────────── */}
      <section className="reports-card" aria-labelledby="invoice-summary-heading">
        <header className="reports-card__head">
          <h2 id="invoice-summary-heading">
            <Icon name="chart" size={17} />
            Invoice
            <StatusChip status={status} />
            {computing && <span className="reports-computing">Recalculating…</span>}
          </h2>
          <p>
            The MAINTSUPP service fee for this period. This is what the client is invoiced and is
            never presented as maintenance expenditure — what the portfolio spent is on the Report
            tab.
          </p>
        </header>
        {payload ? (
          <div className="reports-kpis" aria-label="Invoice figures">
            {invoiceCards.map((card) => (
              <article className="reports-kpi" key={card.key}>
                <small>{card.label}</small>
                <strong>{card.value}</strong>
                {card.note && <span>{card.note}</span>}
              </article>
            ))}
          </div>
        ) : (
          <p className="reports-empty">
            {computing ? "Computing the invoice for this period…" : "Choose a period to compute the invoice."}
          </p>
        )}
      </section>

      {payload && (
        <BillableSitesTable
          payload={payload}
          canEdit={Boolean(canEdit) && editable}
          busyLine={busyLine}
          onExclude={(line) => void generator.changeInclusion(line, false)}
          onInclude={(line) => void generator.changeInclusion(line, true)}
        />
      )}

      {/* ── Data quality, scoped to the charge lines ───────────────────── */}
      {payload && (
        <DataIssuesPanel
          id={ISSUES_ANCHOR}
          lead="These are findings about the lines being charged. Anything wrong with the maintenance data is on the Report tab."
          issues={issues}
          blockers={generator.blockers}
          advisories={generator.warnings}
        />
      )}

      {/* ── The invoice itself ─────────────────────────────────────────── */}
      {payload && (
        <section className="reports-card" aria-labelledby="invoice-preview-heading">
          <header className="reports-card__head">
            <h2 id="invoice-preview-heading">
              <Icon name="document" size={17} />
              Invoice document
            </h2>
            <p>
              Sections 1 and 2 — the invoice on its own, with no maintenance report attached. The
              Word, PDF and Excel files are made from this same value, so their totals cannot differ
              from what is on screen.
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
            <CombinedDocumentPreview payload={payload} snapshot={snapshot} kind="invoice" />
          )}
          {!showPreview && (
            <p className="reports-empty">
              MAINTSUPP Invoice is ready to preview. Previewing changes nothing and never finalises.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
