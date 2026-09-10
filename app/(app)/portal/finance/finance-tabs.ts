/**
 * THE INVOICE TRACKER'S TAB STRIP — one list, no runtime dependencies.
 *
 * Six tabs, and the split is Module 5's own rather than a filing convenience:
 *
 *   · `landing`     — cash position, unbilled work, ageing. §8, §9.
 *   · `payable`     — invoices received. What we owe. §4, §5, §7.
 *   · `receivable`  — invoices issued. What we are owed. §4, §5.
 *   · `quotes`      — before the invoice, where cost control happens. §3.
 *   · `payments`    — money moved, and its allocations. §6.
 *   · `analysis`    — margin, profitability, contractor scorecard,
 *                     statement reconciliation. §8, §15.
 *   · `settings`    — approval bands, tolerances, bank accounts, status map.
 *                     §13, §16.
 *
 * Payable and receivable are two TABS over one table and one component, which
 * is §1's requirement stated in the UI: "Most systems build one and bolt the
 * other on badly." Two tabs, one `direction` prop, one set of code paths — so a
 * fix to allocation arithmetic cannot land on one side and miss the other.
 *
 * `landing` is the default and is the only key never written to the URL, so an
 * unopened Invoice Tracker has a clean address.
 */

export const FINANCE_TABS = [
  { key: "landing", label: "Overview" },
  { key: "payable", label: "Payable" },
  { key: "receivable", label: "Receivable" },
  { key: "quotes", label: "Quotes" },
  { key: "payments", label: "Payments" },
  { key: "analysis", label: "Analysis" },
  { key: "settings", label: "Settings" },
] as const;

export type FinanceTabKey = (typeof FINANCE_TABS)[number]["key"];

const KEYS: readonly string[] = FINANCE_TABS.map((entry) => entry.key);

/**
 * A slug from the address bar, resolved to a tab.
 *
 * An unknown slug falls back to the landing tab rather than rendering nothing.
 * A bookmark to a tab that has since been renamed should land somewhere useful;
 * a blank screen teaches people the link is broken when the product is not.
 */
export function financeTabFromSlug(slug: string | null | undefined): FinanceTabKey {
  const value = (slug ?? "").trim().toLowerCase();
  return (KEYS.includes(value) ? value : "landing") as FinanceTabKey;
}
