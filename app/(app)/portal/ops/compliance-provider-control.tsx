"use client";

/**
 * THE RENEWAL CONTRACTOR ON ONE REQUIREMENT — link, change or unlink it.
 *
 * `compliance_documents.provider_contractor_id`: the contractor RECORD booked to
 * renew a certificate, which the Compliance block's "Who's renewing" groups by.
 * It sits beside the responsibility control and answers a different question:
 * that one says whose OBLIGATION the requirement is (client, landlord, centre);
 * this says which contractor RENEWS it. Neither is inferred from the other, and
 * neither is inferred from the certificate's free-text "issued by".
 *
 * A native `<select>` for the reasons `ResponsibilityControl` gives — a 44px
 * target, keyboard-operable, usable at 320px — over this organisation's own
 * contractors (the summary sends them; the server refuses any other id). A
 * person without `sites.edit` sees the answer as text rather than a control
 * that would only be refused.
 *
 * A save re-reads the row's group and the meters (`onSaved`) and tells every
 * dashboard on the page its data moved (`announceDataChanged`), so the
 * renewals donut regroups without a reload.
 */

import { useCallback, useState } from "react";
import { useCapability } from "../../../lib/client-capabilities";
import { announceDataChanged } from "./ops-url-state";
import responsibilityCss from "./compliance-responsibility.css?url";

export type ProviderOption = { id: string; name: string; active: boolean };

export function ProviderControl({
  record,
  providers,
  onSaved,
}: {
  record: {
    siteId: string;
    kind: string;
    providerContractorId?: string | null;
    providerName?: string | null;
  };
  providers: readonly ProviderOption[];
  /** Called after a save lands, so the row and the meters can be re-read. */
  onSaved: () => void;
}) {
  const canEdit = useCapability("sites.edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = record.providerContractorId ?? "";
  /* The current link is always representable, even for a contractor archived
     since — a select whose value is not an option silently shows the first. */
  const known = !current || providers.some((provider) => provider.id === current);

  const save = useCallback(
    async (next: string) => {
      if (next === current) return;
      setBusy(true);
      setError(null);
      try {
        const response = await fetch("/api/compliance/provider", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            contractorId: next === "" ? null : next,
            records: [{ siteId: record.siteId, kind: record.kind }],
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          setError(payload.error || "That renewal contractor could not be saved.");
          return;
        }
        onSaved();
        announceDataChanged();
      } catch {
        setError("That renewal contractor could not be saved.");
      } finally {
        setBusy(false);
      }
    },
    [current, onSaved, record.kind, record.siteId],
  );

  if (canEdit === false) {
    return (
      <span className="resp-control resp-control--compact provider-control provider-control--read">
        <span className="provider-control__text">
          <span className="visually-hidden">Renewal contractor for {record.kind}: </span>
          {record.providerName ?? "No renewal contractor linked"}
        </span>
      </span>
    );
  }

  return (
    <span className="resp-control resp-control--compact provider-control">
      <link rel="stylesheet" href={responsibilityCss} precedence="default" />
      <label className="resp-control__label">
        <span className="visually-hidden">Renewal contractor for {record.kind}</span>
        <select
          className="resp-control__select"
          value={current}
          disabled={busy}
          title="The contractor record booked to renew this certificate"
          onChange={(event) => void save(event.target.value)}
        >
          <option value="">No renewal contractor</option>
          {!known ? (
            <option value={current}>{record.providerName ?? "A contractor no longer listed"}</option>
          ) : null}
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.active ? provider.name : `${provider.name} (archived)`}
            </option>
          ))}
        </select>
      </label>
      {busy ? <span className="resp-control__busy">Saving…</span> : null}
      {error ? (
        <span className="resp-control__error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
