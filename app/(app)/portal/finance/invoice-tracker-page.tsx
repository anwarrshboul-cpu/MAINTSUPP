"use client";

/**
 * OPERATIONS → INVOICE TRACKER — Module 5's landing page.
 *
 * Money moves in two directions through this workspace and they behave
 * differently: PAYABLE is what contractors and suppliers have invoiced us,
 * RECEIVABLE is what we have invoiced clients. Both are rows in one `invoices`
 * table separated by `direction`, because the lifecycle is nearly identical and
 * the two reports that matter — cash position and margin per job — need both
 * sides in the same query.
 *
 * ── WHAT THIS FILE IS ─────────────────────────────────────────────────────
 *
 * The shell: the section header, the tab strip, and the shared state every tab
 * reads. Each tab is its own module beside this one, for the same reason the
 * Operations pages are: a finance screen that grows a spreadsheet, a matching
 * panel and a payment run in one file becomes unreviewable, and the ledger is
 * the last place to accept that.
 *
 * State lives in the URL, exactly as `ops-url-state.ts` holds the Overview's,
 * so a filtered ledger is a link somebody can send.
 */

import opsCss from "../ops/ops.css?url";
import opsTokensCss from "../ops/ops-tokens.css?url";
import financeCss from "./finance.css?url";
import { useQueryValue } from "../ops/ops-url-state";
import type { Section } from "../portal-app";
import { FinanceLanding } from "./finance-landing";
import { FinanceLedger } from "./finance-ledger";
import { FinanceQuotes } from "./finance-quotes";
import { FinancePayments } from "./finance-payments";
import { FinanceAnalysis } from "./finance-analysis";
import { FinanceSettingsPanel } from "./finance-settings";
import { FINANCE_TABS, type FinanceTabKey, financeTabFromSlug } from "./finance-tabs";

export function InvoiceTrackerPage({
  onNavigate,
  onOpenJob,
  onNotify,
}: {
  onNavigate: (section: Section) => void;
  onOpenJob: (id: string) => void;
  onNotify: (message: string) => void;
}) {
  /* The tab is a URL parameter, not component state, so a link to the payables
     ledger is a link to the payables ledger. `landing` is the default and is
     therefore never written — see `useQueryValue`. */
  const [tabSlug, setTabSlug] = useQueryValue("tab", "landing");
  const tab = financeTabFromSlug(tabSlug);
  const selectTab = (next: FinanceTabKey) => setTabSlug(next);

  return (
    <>
      {/* Tokens first, then the shared operations sheet, then this page's own —
          same precedence, so insertion order decides, and a token has to exist
          before a rule can read it. */}
      <link rel="stylesheet" href={opsTokensCss} precedence="default" />
      <link rel="stylesheet" href={opsCss} precedence="default" />
      <link rel="stylesheet" href={financeCss} precedence="default" />

      <section className="ops-page fin-page">
        <header className="ops-page__head">
          <p className="ops-page__eyebrow">Money in and money out</p>
          <h1>Invoice Tracker</h1>
        </header>

        <nav className="fin-tabs" aria-label="Invoice Tracker sections">
          <ul className="fin-tabs__list">
            {FINANCE_TABS.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  className="fin-tabs__tab"
                  aria-current={tab === entry.key ? "page" : undefined}
                  onClick={() => selectTab(entry.key)}
                >
                  {entry.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {tab === "landing" && (
          <FinanceLanding onSelectTab={selectTab} onOpenJob={onOpenJob} onNavigate={(section) => onNavigate(section as Section)} />
        )}
        {(tab === "payable" || tab === "receivable") && (
          <FinanceLedger
            direction={tab === "payable" ? "payable" : "receivable"}
            onOpenJob={onOpenJob}
            onNotify={onNotify}
          />
        )}
        {tab === "quotes" && <FinanceQuotes onOpenJob={onOpenJob} onNotify={onNotify} />}
        {tab === "payments" && <FinancePayments onNotify={onNotify} />}
        {tab === "analysis" && <FinanceAnalysis onOpenJob={onOpenJob} onSelectTab={selectTab} />}
        {tab === "settings" && <FinanceSettingsPanel onNotify={onNotify} />}
      </section>
    </>
  );
}
