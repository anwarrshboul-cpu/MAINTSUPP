"use client";

/*
 * PLACEHOLDER — replaced in this same release by the Invoice Tracker UI work.
 * It exists so the section routes and the shell compiles while the tabs are
 * built beside it; it renders an honest "not loaded" state and never a figure.
 */

export function FinanceLedger(_props: {
  direction: "payable" | "receivable";
  onOpenJob: (id: string) => void;
  onNotify: (message: string) => void;
}) {
  return (
    <div className="ops-card">
      <p className="ops-card__note">Ledger is loading…</p>
    </div>
  );
}
