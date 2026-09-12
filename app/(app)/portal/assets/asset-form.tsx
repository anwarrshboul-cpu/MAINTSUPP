"use client";

/**
 * ADDING AND EDITING AN ASSET.
 *
 * ── FOUR FIELDS TO CREATE ONE, AND THIRTY TO DESCRIBE IT ───────────────────
 *
 * The brief's rule, and it is the right one: a thirty-field wall is how an
 * asset register ends up with eleven rows in it. Site, name, kind and category
 * are the only required fields and they sit alone on the first tab; everything
 * else is a tab somebody opens when they have the information in front of them.
 * A store manager can add "LED strip, Bullring, Lighting" in fifteen seconds
 * and the maintenance team can fill in the part number next week.
 *
 * The tabs are `SectionTabs` — the same APG tablist the site editor uses, for
 * the same reason: a second hand-rolled one would be a second set of the
 * accessibility defects that component was written to fix.
 *
 * ── THE SPECIFICATION EDITOR ───────────────────────────────────────────────
 *
 * Rows of name / value / unit, added and removed with buttons. The brief is
 * explicit that ordinary users must not edit raw JSON, and the alternative —
 * a textarea holding `[{"key":"Voltage"…}]` — would also be a validation
 * surface the server would have to re-derive. The server still parses and
 * bounds everything through `parseSpecs`, because a form is never the place a
 * rule is enforced.
 */

import { useState } from "react";
import { SectionPanel, SectionTabs } from "../sites/section-tabs";
import { FormField } from "../sites/form-field";
import { api, type OptionChoice } from "../sites/site-types";
import {
  ASSET_KIND_HINTS,
  assetKind,
  MAX_SPECS,
  urlProblem,
  type AssetSpec,
} from "../../../lib/asset-model";
import type { AssetForm as AssetFormValues, AssetRelation } from "./asset-types";

const SECTIONS = [
  "Identity",
  "Technical",
  "Specifications",
  "Supplier",
  "Replacement",
  "Notes",
] as const;

const TAB_PREFIX = "asset-editor";

export function AssetForm({
  assetId,
  initial,
  categories,
  statuses,
  kinds,
  sites,
  suppliers,
  parents,
  onCancel,
  onSaved,
}: {
  /** Null when creating. Present when editing, and then it is never sent as data. */
  assetId: string | null;
  initial: AssetFormValues;
  categories: OptionChoice[];
  statuses: OptionChoice[];
  kinds: Array<{ value: string; label: string }>;
  sites: Array<{ id: string; name: string }>;
  suppliers: Array<{ id: string; name: string }>;
  /** Candidate parents: this workspace's live assets, minus this one. */
  parents: AssetRelation[];
  onCancel: () => void;
  onSaved: (message: string) => void;
}) {
  const [tab, setTab] = useState<(typeof SECTIONS)[number]>("Identity");
  const [form, setForm] = useState<AssetFormValues>(initial);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");

  const set = (key: keyof AssetFormValues) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const setSpec = (index: number, patch: Partial<AssetSpec>) =>
    setForm((current) => ({
      ...current,
      specs: current.specs.map((spec, position) =>
        position === index ? { ...spec, ...patch } : spec,
      ),
    }));

  const addSpec = () =>
    setForm((current) =>
      current.specs.length >= MAX_SPECS
        ? current
        : { ...current, specs: [...current.specs, { key: "", value: "", unit: "" }] },
    );

  const removeSpec = (index: number) =>
    setForm((current) => ({
      ...current,
      specs: current.specs.filter((_, position) => position !== index),
    }));

  async function save() {
    /*
     * The four required fields are checked here so the reader is taken to the
     * tab that is wrong, rather than being handed a 400 naming a field on a
     * panel they cannot see. The server checks them again — this is a
     * convenience, never the enforcement.
     */
    if (!form.siteId || !form.name.trim() || !form.kind || !form.category) {
      setTab("Identity");
      setProblem("Site, name, kind and category are needed before this can be saved.");
      return;
    }
    if (form.supplierUrl && urlProblem(form.supplierUrl)) {
      setTab("Supplier");
      setProblem(urlProblem(form.supplierUrl) ?? "");
      return;
    }

    setSaving(true);
    setProblem("");
    try {
      /* Blank specification rows are dropped rather than sent: a row somebody
         opened and abandoned is not a fact about the asset. */
      const data = {
        ...form,
        specs: form.specs.filter((spec) => spec.key.trim()),
      };
      if (assetId) {
        await api("/api/assets", { method: "PATCH", body: { id: assetId, data } });
        onSaved(`${form.name} updated.`);
      } else {
        await api("/api/assets", { method: "POST", body: { data } });
        onSaved(`${form.name} added to the register.`);
      }
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The asset could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  /*
   * Only assets at the SAME site can be a parent, and the server enforces it.
   * Offering the rest and then refusing them would be a menu of dead ends.
   *
   * Narrowed against `form.siteId` — the site as it is RIGHT NOW — rather than
   * against the site the form opened with, so changing the site changes the
   * candidates with it.
   */
  const parentOptions = [
    { value: "", label: "Not part of anything" },
    ...parents
      .filter(
        (entry) =>
          entry.id !== assetId && (!entry.siteId || entry.siteId === form.siteId),
      )
      .map((entry) => ({
        value: entry.id,
        label: entry.assetNumber ? `${entry.assetNumber} — ${entry.name}` : entry.name,
      })),
  ];

  return (
    <div className="asset-form">
      <SectionTabs
        idPrefix={TAB_PREFIX}
        label="Asset details"
        sections={SECTIONS}
        active={tab}
        onChange={setTab}
      />

      <SectionPanel idPrefix={TAB_PREFIX} section="Identity" active={tab === "Identity"}>
        <div className="form-grid">
          <FormField
            id="asset-site"
            label="Site"
            value={form.siteId}
            onChange={set("siteId")}
            required
            options={[
              { value: "", label: "Choose a site" },
              ...sites.map((site) => ({ value: site.id, label: site.name })),
            ]}
            hint="Every asset belongs to one store. This is the only field that cannot change later without moving the record."
          />
          <FormField
            id="asset-name"
            label="Asset name"
            value={form.name}
            onChange={set("name")}
            required
            placeholder="LED strip — front display cabinet"
          />
          <FormField
            id="asset-kind"
            label="Kind"
            value={form.kind}
            onChange={set("kind")}
            required
            options={kinds.map((kind) => ({ value: kind.value, label: kind.label }))}
            hint={ASSET_KIND_HINTS[assetKind(form.kind)]}
          />
          <FormField
            id="asset-category"
            label="Category"
            value={form.category}
            onChange={set("category")}
            required
            options={[{ value: "", label: "Choose a category" }, ...categories]}
            hint="Categories are configured in Settings — add one there rather than here."
          />
          <FormField
            id="asset-status"
            label="Status"
            value={form.status}
            onChange={set("status")}
            options={statuses}
            hint="&ldquo;Needs replacement&rdquo; puts it on the register's replacement list."
          />
          <FormField
            id="asset-location"
            label="Where at the site"
            value={form.locationInSite}
            onChange={set("locationInSite")}
            placeholder="Front counter, left cabinet, rear shutter…"
          />
          <FormField
            id="asset-parent"
            label="Part of"
            value={form.parentUnitId}
            onChange={set("parentUnitId")}
            options={parentOptions}
            hint="Optional. A transformer inside a display cabinet, a filter inside an AC unit."
          />
          <FormField
            id="asset-quantity"
            label="Quantity"
            type="number"
            min={0}
            value={form.quantity}
            onChange={set("quantity")}
          />
          <FormField
            id="asset-tag"
            label="Asset tag"
            value={form.assetTag}
            onChange={set("assetTag")}
            hint="A label physically on the item, if it carries one."
          />
        </div>
      </SectionPanel>

      <SectionPanel idPrefix={TAB_PREFIX} section="Technical" active={tab === "Technical"}>
        <div className="form-grid">
          <FormField
            id="asset-manufacturer"
            label="Manufacturer / brand"
            value={form.manufacturer}
            onChange={set("manufacturer")}
          />
          <FormField id="asset-model" label="Model" value={form.model} onChange={set("model")} />
          <FormField
            id="asset-part-number"
            label="Part number"
            value={form.partNumber}
            onChange={set("partNumber")}
          />
          <FormField
            id="asset-serial"
            label="Serial number"
            value={form.serialNumber}
            onChange={set("serialNumber")}
          />
          <FormField
            id="asset-specification"
            label="Specification"
            multiline
            value={form.specification}
            onChange={set("specification")}
            hint="Free text. Measured values belong on the Specifications tab."
          />
          <FormField id="asset-colour" label="Colour" value={form.colour} onChange={set("colour")} />
          <FormField
            id="asset-colour-code"
            label="Colour code"
            value={form.colourCode}
            onChange={set("colourCode")}
          />
          <FormField
            id="asset-paint"
            label="Paint / finish reference"
            value={form.paintReference}
            onChange={set("paintReference")}
            placeholder="RAL 7016, Dulux Trade…"
          />
          <FormField
            id="asset-installed"
            label="Installed"
            type="date"
            value={form.installedAt}
            onChange={set("installedAt")}
          />
          <FormField
            id="asset-warranty"
            label="Warranty expires"
            type="date"
            value={form.warrantyExpiry}
            onChange={set("warrantyExpiry")}
          />
          <FormField
            id="asset-last-serviced"
            label="Last serviced"
            type="date"
            value={form.lastServicedAt}
            onChange={set("lastServicedAt")}
          />
          <FormField
            id="asset-service-interval"
            label="Service every (months)"
            type="number"
            min={0}
            value={form.serviceIntervalMonths}
            onChange={set("serviceIntervalMonths")}
          />
          <FormField
            id="asset-purchase-price"
            label="Purchase price (£)"
            type="number"
            min={0}
            step="0.01"
            value={form.purchasePrice}
            onChange={set("purchasePrice")}
          />
        </div>
      </SectionPanel>

      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Specifications"
        active={tab === "Specifications"}
      >
        <p className="form-hint">
          The measured facts: voltage, wattage, colour temperature, IP rating, opening angle,
          BTU, width. Add only the ones that apply — a hinge has no wattage.
        </p>
        {form.specs.length === 0 ? (
          <p className="ops-empty">None yet.</p>
        ) : (
          <ul className="asset-specs">
            {form.specs.map((spec, index) => (
              <li key={`spec-${index}`} className="asset-specs__row">
                <FormField
                  id={`asset-spec-key-${index}`}
                  label="Specification"
                  value={spec.key}
                  onChange={(value) => setSpec(index, { key: value })}
                  placeholder="Colour temperature"
                />
                <FormField
                  id={`asset-spec-value-${index}`}
                  label="Value"
                  value={spec.value}
                  onChange={(value) => setSpec(index, { value })}
                  placeholder="3000"
                />
                <FormField
                  id={`asset-spec-unit-${index}`}
                  label="Unit"
                  value={spec.unit}
                  onChange={(value) => setSpec(index, { unit: value })}
                  placeholder="K"
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => removeSpec(index)}
                  aria-label={`Remove the ${spec.key || "empty"} specification`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="secondary-button"
          onClick={addSpec}
          disabled={form.specs.length >= MAX_SPECS}
        >
          Add a specification
        </button>
      </SectionPanel>

      <SectionPanel idPrefix={TAB_PREFIX} section="Supplier" active={tab === "Supplier"}>
        <div className="form-grid">
          <FormField
            id="asset-supplier-contractor"
            label="Supplier on file"
            value={form.supplierContractorId}
            onChange={set("supplierContractorId")}
            options={[
              { value: "", label: "Not one of our contractors" },
              ...suppliers.map((entry) => ({ value: entry.id, label: entry.name })),
            ]}
            hint="Link a contractor who also supplies this part. Otherwise type the supplier below."
          />
          <FormField
            id="asset-supplier"
            label="Supplier name"
            value={form.supplier}
            onChange={set("supplier")}
          />
          <FormField
            id="asset-supplier-reference"
            label="Supplier reference"
            value={form.supplierReference}
            onChange={set("supplierReference")}
            hint="Their code for this product, so it can be re-ordered by name."
          />
          <FormField
            id="asset-supplier-email"
            label="Supplier email"
            type="email"
            value={form.supplierEmail}
            onChange={set("supplierEmail")}
          />
          <FormField
            id="asset-supplier-phone"
            label="Supplier phone"
            value={form.supplierPhone}
            onChange={set("supplierPhone")}
          />
          <FormField
            id="asset-supplier-url"
            label="Product page"
            type="url"
            value={form.supplierUrl}
            onChange={set("supplierUrl")}
            problem={urlProblem(form.supplierUrl)}
            placeholder="https://…"
          />
        </div>
      </SectionPanel>

      <SectionPanel idPrefix={TAB_PREFIX} section="Replacement" active={tab === "Replacement"}>
        <p className="form-hint">
          What to order when this fails. This is the section that saves the phone call.
        </p>
        <div className="form-grid">
          <FormField
            id="asset-replacement-part"
            label="Replacement part number"
            value={form.replacementPartNumber}
            onChange={set("replacementPartNumber")}
          />
          <FormField
            id="asset-replacement-model"
            label="Replacement model"
            value={form.replacementModel}
            onChange={set("replacementModel")}
          />
          <FormField
            id="asset-replacement-spec"
            label="Replacement specification"
            multiline
            value={form.replacementSpecification}
            onChange={set("replacementSpecification")}
          />
          <FormField
            id="asset-replacement-supplier"
            label="Replacement supplier"
            value={form.replacementSupplier}
            onChange={set("replacementSupplier")}
          />
          <FormField
            id="asset-replacement-cost"
            label="Replacement cost (£)"
            type="number"
            min={0}
            step="0.01"
            value={form.replacementCost}
            onChange={set("replacementCost")}
          />
          <FormField
            id="asset-last-replaced"
            label="Last replaced"
            type="date"
            value={form.lastReplacedAt}
            onChange={set("lastReplacedAt")}
          />
          <FormField
            id="asset-replacement-interval"
            label="Replace every (months)"
            type="number"
            min={0}
            value={form.replacementIntervalMonths}
            onChange={set("replacementIntervalMonths")}
          />
          <FormField
            id="asset-replacement-notes"
            label="Replacement notes"
            multiline
            value={form.replacementNotes}
            onChange={set("replacementNotes")}
          />
        </div>
      </SectionPanel>

      <SectionPanel idPrefix={TAB_PREFIX} section="Notes" active={tab === "Notes"}>
        <div className="form-grid">
          <FormField
            id="asset-notes"
            label="Notes"
            multiline
            value={form.notes}
            onChange={set("notes")}
          />
        </div>
        <p className="form-hint">
          Photographs, manuals and datasheets are added from the asset&rsquo;s own record once it
          has been saved.
        </p>
      </SectionPanel>

      {problem ? (
        <p className="form-error" role="alert">
          {problem}
        </p>
      ) : null}

      <div className="section-header__actions">
        <button
          type="button"
          className="secondary-button"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button type="button" className="primary-button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : assetId ? "Save changes" : "Add the asset"}
        </button>
      </div>
    </div>
  );
}
