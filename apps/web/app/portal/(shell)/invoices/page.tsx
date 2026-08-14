import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewerState, serverFetch } from "../../../../lib/session";
import {
  canRecordInvoices,
  canSeeMoney,
  formatMoney,
  isStaff,
  type InvoicePage,
  type InvoiceSummary,
  type Scopes,
} from "../../../../lib/portal";
import InvoiceLedger from "./invoice-ledger";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Invoices" };

/**
 * The invoice screen.
 *
 * RECORD AND TRACK, NOT ISSUE. There is no "create invoice" here in the sense of
 * producing a document: no numbering, no PDF generation, no template. The owner
 * decided MAINTSUPP does not issue invoices, so this screen writes down invoices
 * that already exist elsewhere and tracks what is outstanding — which is why the
 * number field is typed in from the paperwork rather than allocated, and why the
 * only file involved is one somebody attaches.
 *
 * A contractor never reaches this page: the nav does not draw it and the API
 * answers 403 to every path under `/invoices` for them.
 */
export default async function InvoicesPage() {
  const state = await getViewerState();
  if (state.kind !== "ok") return null;

  const { actor } = state.viewer;
  if (!canSeeMoney(actor)) redirect("/portal/dashboard");

  const [page, summary, scopes] = await Promise.all([
    serverFetch<InvoicePage>("/invoices?limit=100"),
    serverFetch<InvoiceSummary>("/invoices/summary"),
    // Only staff record invoices, and only they need the client list to do it.
    isStaff(actor.role)
      ? serverFetch<Scopes>("/members/scopes")
      : Promise.resolve({ ok: false as const, status: 403, error: "" }),
  ]);

  if (!page.ok) {
    return (
      <div className="card card--empty">
        <h1>Invoices</h1>
        <p className="muted">{page.error}</p>
      </div>
    );
  }

  const totals = summary.ok ? summary.data.totals : null;
  const organisations = summary.ok ? summary.data.organisations : [];

  return (
    <>
      <h1 className="p-h1">Invoices</h1>
      <p className="p-lede">
        A record of invoices raised elsewhere, so that what is outstanding has
        one answer. Nothing here issues or numbers an invoice.
      </p>

      {totals ? (
        <dl className="p-stats">
          <div className="p-stat">
            <dt>Outstanding</dt>
            <dd>{formatMoney(totals.outstandingPence)}</dd>
            <p className="p-stat-note">unpaid, late or not</p>
          </div>
          <div className="p-stat">
            <dt>Overdue</dt>
            <dd className={totals.overduePence > 0 ? "p-bad" : undefined}>
              {formatMoney(totals.overduePence)}
            </dd>
            <p className="p-stat-note">
              {totals.overdueCount} past {totals.overdueCount === 1 ? "its" : "their"} due date
            </p>
          </div>
          <div className="p-stat">
            <dt>Paid</dt>
            <dd>{formatMoney(totals.paidPence)}</dd>
            <p className="p-stat-note">settled</p>
          </div>
          <div className="p-stat">
            <dt>Recorded</dt>
            <dd>{totals.invoiceCount}</dd>
            <p className="p-stat-note">
              {formatMoney(totals.totalPence)} in total, cancelled excluded
            </p>
          </div>
        </dl>
      ) : null}

      {organisations.length > 0 ? (
        <section className="p-panel">
          <div className="p-section-head">
            <h2>By organisation</h2>
          </div>
          {/* Wide content scrolls inside its own wrapper; the page never does. */}
          <div className="p-tablewrap">
            <table className="p-table">
              <thead>
                <tr>
                  <th className="p-sticky">Organisation</th>
                  <th className="p-num">Invoices</th>
                  <th className="p-num">Total</th>
                  <th className="p-num">Paid</th>
                  <th className="p-num">Outstanding</th>
                  <th className="p-num">Overdue</th>
                </tr>
              </thead>
              <tbody>
                {organisations.map((org) => (
                  <tr key={org.organisationId}>
                    <th scope="row" className="p-sticky">
                      {org.organisationName}
                    </th>
                    <td className="p-num p-mono">{org.invoiceCount}</td>
                    <td className="p-num p-mono">{formatMoney(org.totalPence)}</td>
                    <td className="p-num p-mono">{formatMoney(org.paidPence)}</td>
                    <td className="p-num p-mono">{formatMoney(org.outstandingPence)}</td>
                    <td className="p-num p-mono">
                      {org.overduePence > 0 ? (
                        <span className="p-bad">{formatMoney(org.overduePence)}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="p-sticky">Total</td>
                  <td className="p-num p-mono">{totals?.invoiceCount ?? 0}</td>
                  <td className="p-num p-mono">{formatMoney(totals?.totalPence ?? 0)}</td>
                  <td className="p-num p-mono">{formatMoney(totals?.paidPence ?? 0)}</td>
                  <td className="p-num p-mono">{formatMoney(totals?.outstandingPence ?? 0)}</td>
                  <td className="p-num p-mono">{formatMoney(totals?.overduePence ?? 0)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      ) : null}

      <InvoiceLedger
        initial={page.data}
        canRecord={canRecordInvoices(actor)}
        organisations={scopes.ok ? scopes.data.organisations : []}
      />
    </>
  );
}
