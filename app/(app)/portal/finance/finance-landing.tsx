"use client";

/*
 * PLACEHOLDER — replaced in this same release by the Invoice Tracker UI work.
 * It exists so the section routes and the shell compiles while the tabs are
 * built beside it; it renders an honest "not loaded" state and never a figure.
 */

import type { FinanceTabKey } from "./finance-tabs";

export function FinanceLanding(_props: {
  onSelectTab: (tab: FinanceTabKey) => void;
  onOpenJob: (id: string) => void;
  onNavigate: (section: string) => void;
}) {
  return (
    <div className="ops-card">
      <p className="ops-card__note">Cash position is loading…</p>
    </div>
  );
}
