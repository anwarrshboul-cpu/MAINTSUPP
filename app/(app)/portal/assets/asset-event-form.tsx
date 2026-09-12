"use client";

/**
 * RECORDING WHAT HAPPENED TO AN ASSET.
 *
 * The one control in this section that writes history rather than state, and
 * the reason the history table exists: a site that moves from transformer A to
 * transformer B must not lose A. The two fields that carry that are "What was
 * there" and "What replaced it", and they are deliberately plain text — the
 * operator standing at the cabinet knows "Meanwell LPV-60-24, the old grey
 * one", and a pair of dropdowns over records that may never have been created
 * would capture none of it.
 *
 * This writes ONLY the event. It does not edit the asset's own model or part
 * number, because guessing which of fourteen technical fields a replacement
 * changed is how a record ends up with a model that never existed. The form
 * says so, and the Edit button is one tab away.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "../sites/site-types";
import { FormField } from "../sites/form-field";

export function AssetEventForm({
  assetId,
  events,
  suppliers,
  headingLevel = "h2",
  onSaved,
}: {
  assetId: string;
  events: readonly string[];
  suppliers: Array<{ id: string; name: string }>;
  /** One level below the record's own title. See `AssetDetail`. */
  headingLevel?: "h2" | "h3";
  onSaved: (message: string) => void;
}) {
  const Heading = headingLevel;
  const [open, setOpen] = useState(false);
  /*
   * The disclosure button is REPLACED by the form, so without this the caret is
   * dropped on the body and a keyboard user has to tab back in from the top of
   * the page to reach the control they just opened.
   */
  const firstField = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) firstField.current?.querySelector<HTMLElement>("select, input")?.focus();
  }, [open]);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const [form, setForm] = useState({
    eventType: "Replaced",
    performedAt: new Date().toISOString().slice(0, 10),
    previousDetail: "",
    replacementDetail: "",
    contractorId: "",
    cost: "",
    outcome: "",
    notes: "",
  });

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function save() {
    setSaving(true);
    setProblem("");
    try {
      await api("/api/assets", {
        method: "POST",
        body: { assetId, event: form },
      });
      onSaved(`${form.eventType} recorded.`);
      setOpen(false);
      setForm((current) => ({
        ...current,
        previousDetail: "",
        replacementDetail: "",
        cost: "",
        outcome: "",
        notes: "",
      }));
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "That could not be recorded.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="asset-event__open">
        <button type="button" className="primary-button" onClick={() => setOpen(true)}>
          Record an event
        </button>
        <p className="ops-card__note">
          Installed, replaced, serviced, retired or a status change. Recording a replacement is
          what keeps the part that came out from being lost.
        </p>
      </div>
    );
  }

  return (
    <div className="asset-event">
      <Heading className="ops-section-title">Record an event</Heading>
      <div className="form-grid" ref={firstField}>
        <FormField
          id="asset-event-type"
          label="What happened"
          value={form.eventType}
          onChange={set("eventType")}
          options={events.map((event) => ({ value: event, label: event }))}
          required
        />
        <FormField
          id="asset-event-date"
          label="When"
          type="date"
          value={form.performedAt}
          onChange={set("performedAt")}
          required
        />
        <FormField
          id="asset-event-previous"
          label="What was there"
          value={form.previousDetail}
          onChange={set("previousDetail")}
          hint="The part that came out — model, part number, whatever is known."
        />
        <FormField
          id="asset-event-replacement"
          label="What replaced it"
          value={form.replacementDetail}
          onChange={set("replacementDetail")}
          hint="The part that went in."
        />
        <FormField
          id="asset-event-contractor"
          label="Who did the work"
          value={form.contractorId}
          onChange={set("contractorId")}
          options={[
            { value: "", label: "Not recorded" },
            ...suppliers.map((entry) => ({ value: entry.id, label: entry.name })),
          ]}
        />
        <FormField
          id="asset-event-cost"
          label="Cost (£)"
          type="number"
          min={0}
          step="0.01"
          value={form.cost}
          onChange={set("cost")}
        />
        <FormField
          id="asset-event-outcome"
          label="Outcome"
          value={form.outcome}
          onChange={set("outcome")}
        />
        <FormField
          id="asset-event-notes"
          label="Notes"
          multiline
          value={form.notes}
          onChange={set("notes")}
        />
      </div>
      <p className="ops-card__note">
        This adds to the history and does not change the asset&rsquo;s own model or part number.
        If the new part is now the one installed, edit the asset as well.
      </p>
      {problem ? (
        <p className="form-error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="section-header__actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => setOpen(false)}
          disabled={saving}
        >
          Cancel
        </button>
        <button type="button" className="primary-button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Record it"}
        </button>
      </div>
    </div>
  );
}
