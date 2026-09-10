"use client";

/*
 * PLACEHOLDER — replaced in this same release by the Invoice Tracker UI work.
 * It exists so the section routes and the shell compiles while the tabs are
 * built beside it; it renders an honest "not loaded" state and never a figure.
 */

import type { FinanceTabKey } from "./finance-tabs";

export function FinanceAnalysis(_props: {
  onOpenJob: (id: string) => void;
  onSelectTab: (tab: FinanceTabKey) => void;
}) {
  return (
    <div className="ops-card">
      <p className="ops-card__note">Analysis is loading…</p>
    </div>
  );
}
