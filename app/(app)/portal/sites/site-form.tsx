"use client";

import { useState } from "react";
import { FormField as Field } from "./form-field";
import { SectionPanel, SectionTabs } from "./section-tabs";
import {
  ApiError,
  api,
  type DuplicateWarning,
  type OptionChoice,
  type SiteGroupRecord,
  type SiteRecord,
  scopedUrl,
} from "./site-types";

type FormState = Record<string, string>;

function initialState(site: SiteRecord | null): FormState {
  return {
    name: site?.name ?? "",
    code: site?.code ?? "",
    siteTypeValue: site?.siteTypeValue ?? site?.type ?? "",
    status: site?.status ?? "",
    addressLine1: site?.addressLine1 ?? "",
    addressLine2: site?.addressLine2 ?? "",
    city: site?.city ?? "",
    postcode: site?.postcode ?? "",
    country: site?.country ?? "United Kingdom",
    /*
     * THE FIELD THAT WAS BEING RESET BY ITS OWN ABSENCE.
     *
     * `region` is a real, NOT NULL column and it is the UK/Europe split every
     * portfolio figure is grouped on — the CSV importer writes "Europe" for the
     * international rows, `/api/workspace` carries it, and the Manage-data
     * editor edits it. This form had no region field, and because
     * `PATCH /api/sites` rebuilt every column from the body it sent, a site
     * saved from here came back as "UK" whatever it had been. The route now
     * preserves what an edit did not carry; this makes it editable rather than
     * merely safe, so the one screen that owns a site can also correct it.
     *
     * "UK" is the same default the column and the API already hold, so a new
     * site opens on the answer that is right for nine in ten of them.
     */
    region: site?.region ?? "UK",
    /*
     * W05-01 — THE TWO COLUMNS NO SCREEN COULD REACH.
     *
     * `latitude` and `longitude` are real columns on `sites`, they are in
     * `SiteRecord`, `PATCH /api/sites` has always written them — and until now
     * the ONLY way to put a value in either was a CSV import, which runs under
     * `data.import`, a different capability from the one that owns this form.
     * So the person who owns the site register could not record where a site
     * is; somebody with permission to bulk-load a spreadsheet could.
     *
     * Held as strings like every other field here, so an untouched empty box
     * posts `""` and `optionalNumber` reads it as "no coordinate" rather than
     * as zero — which is a real place off the coast of Ghana, and exactly the
     * kind of default nobody notices.
     */
    latitude:
      site?.latitude === null || site?.latitude === undefined ? "" : String(site.latitude),
    longitude:
      site?.longitude === null || site?.longitude === undefined ? "" : String(site.longitude),
    /*
     * W05-07 — OPERATIONAL ELIGIBILITY, AS ITS OWN ANSWER.
     *
     * `active` is what `listRetailSites` and the public Location dropdown
     * filter on, and it had no control anywhere in the product: it could only
     * ever be whatever `status` implied. That is why the register could not
     * express a current site that is not a shop — a warehouse, the office, an
     * internal location — without also closing it.
     *
     * A new site defaults to eligible, which is what somebody adding a site is
     * almost always doing. Closing a site still overrides this: see
     * `reconcileSiteState`.
     */
    active: site ? String(Boolean(site.active)) : "true",
    managerName: site?.managerName ?? "",
    managerPhone: site?.managerPhone ?? "",
    managerEmail: site?.managerEmail ?? "",
    landlord: site?.landlord ?? "",
    managingAgent: site?.managingAgent ?? "",
    outOfHoursContact: site?.outOfHoursContact ?? "",
    accessMethod: site?.accessMethod ?? "",
    accessContact: site?.accessContact ?? "",
    accessUrl: site?.accessUrl ?? "",
    accessNotes: site?.accessNotes ?? "",
    openingHours: site?.openingHours ?? "",
    deliveryRestrictions: site?.deliveryRestrictions ?? "",
    parkingNotes: site?.parkingNotes ?? "",
    keyAlarmNotes: site?.keyAlarmNotes ?? "",
    leaseStart: site?.leaseStart ?? "",
    leaseEnd: site?.leaseEnd ?? "",
    breakClause: site?.breakClause ?? "",
    rentReview: site?.rentReview ?? "",
    serviceCharge:
      site?.serviceChargePence === null || site?.serviceChargePence === undefined
        ? ""
        : (site.serviceChargePence / 100).toFixed(2),
    // Empty means "no budget set", which the spend panel reports differently
    // from a budget of zero — so an untouched field must stay empty, never
    // become "0.00".
    annualBudget:
      site?.annualBudgetPence === null || site?.annualBudgetPence === undefined
        ? ""
        : (site.annualBudgetPence / 100).toFixed(2),
    mondayMaintenanceName: site?.mondayMaintenanceName ?? "",
    mondayComplianceName: site?.mondayComplianceName ?? "",
    notes: site?.notes ?? "",
  };
}

const SECTIONS = [
  "Identity",
  "Address",
  "Contacts",
  "Access",
  "Opening",
  "Lease",
  "Reconciliation",
] as const;

/**
 * Namespaces the tab and panel ids. The editor and the detail screen are
 * separate returns and never render together, but they use the same section
 * names ("Contacts" is on both), and an id that is only unique by luck is not
 * unique. See section-tabs.tsx.
 */
const TAB_PREFIX = "site-editor";

export function SiteForm({
  sectionKey = null,
  site,
  siteTypes,
  statuses,
  accessMethods,
  groups,
  memberGroupIds,
  onSaved,
  onCancel,
}: {
  /** The register a NEW site is created in, and an existing one is edited in. */
  sectionKey?: string | null;
  site: SiteRecord | null;
  siteTypes: OptionChoice[];
  statuses: OptionChoice[];
  accessMethods: OptionChoice[];
  groups: SiteGroupRecord[];
  memberGroupIds: string[];
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialState(site));
  const [groupIds, setGroupIds] = useState<string[]>(memberGroupIds);
  const [section, setSection] = useState<(typeof SECTIONS)[number]>("Identity");
  const [error, setError] = useState("");
  const [duplicates, setDuplicates] = useState<DuplicateWarning[]>([]);
  const [saving, setSaving] = useState(false);

  const set = (key: string) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function save(confirmDuplicate: boolean) {
    setSaving(true);
    setError("");
    try {
      const body = { data: { ...form, groupIds }, confirmDuplicate, id: site?.id };
      await api(scopedUrl("/api/sites", sectionKey), {
        method: site ? "PATCH" : "POST",
        body,
      });
      onSaved(site ? `${form.name} updated.` : `${form.name} added.`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.requiresConfirmation) {
        setDuplicates(caught.duplicates ?? []);
        setError(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : "The site could not be saved.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="site-form">
      {/*
        The strip and the panels are one pattern, not two lists that happen to
        agree. See section-tabs.tsx for what was missing and what the APG asks
        for; every section body below is now the `tabpanel` the tab above it
        points at.
      */}
      <SectionTabs
        idPrefix={TAB_PREFIX}
        label="Site editor sections"
        sections={SECTIONS}
        active={section}
        onChange={setSection}
      />

      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Identity"
        className="form-grid"
        active={section === "Identity"}
      >
        <Field id="site-name" label="Site name" value={form.name} onChange={set("name")} required />
        <Field
          id="site-code"
          label="Site code"
          value={form.code}
          onChange={set("code")}
          hint="Left blank, a code is generated from the site name."
        />
        <Field
          id="site-type"
          label="Site type"
          value={form.siteTypeValue}
          onChange={set("siteTypeValue")}
          options={siteTypes}
          required
        />
        <Field
          id="site-status"
          label="Status"
          value={form.status}
          onChange={set("status")}
          options={statuses}
          required
        />
        {/*
          W05-07 — the third state column, with a control at last.
          NOT a duplicate of Status above. Status classifies the record for
          reporting; this says whether the site may be assigned work and
          offered as a location, which is what `sites.active` actually gates.
          The two answer different questions and the register holds rows where
          they differ — a warehouse is a current site nobody dispatches a shop
          fitter to. Closing a site overrides this either way, so the hint says
          so rather than leaving somebody to discover it.
        */}
        <fieldset className="form-field">
          <legend>Availability</legend>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.active === "true"}
              onChange={(event) => set("active")(String(event.target.checked))}
            />
            <span>Available for work</span>
          </label>
          <p className="form-hint">
            Offered when raising and assigning jobs, and on the public request
            form. Closing a site clears this whatever is ticked here.
          </p>
        </fieldset>
        <Field id="site-notes" label="Notes" value={form.notes} onChange={set("notes")} multiline />
        <fieldset className="form-field">
          <legend>Reporting groups</legend>
          {groups.length === 0 ? (
            <p className="form-hint">
              No groups yet. Create one to report on a region or portfolio.
            </p>
          ) : (
            groups.map((group) => (
              <label key={group.id} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={groupIds.includes(group.id)}
                  onChange={(event) =>
                    setGroupIds((current) =>
                      event.target.checked
                        ? [...current, group.id]
                        : current.filter((id) => id !== group.id),
                    )
                  }
                />
                <span>{group.name}</span>
              </label>
            ))
          )}
        </fieldset>
      </SectionPanel>

      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Address"
        className="form-grid"
        active={section === "Address"}
      >
        <Field id="addr1" label="Address line 1" value={form.addressLine1} onChange={set("addressLine1")} required />
        <Field id="addr2" label="Address line 2" value={form.addressLine2} onChange={set("addressLine2")} />
        <Field id="city" label="Town or city" value={form.city} onChange={set("city")} />
        <Field id="postcode" label="Postcode" value={form.postcode} onChange={set("postcode")} />
        <Field id="country" label="Country" value={form.country} onChange={set("country")} />
        {/*
          * Free text rather than a select, because `region` is not one of the
          * option tables — there is no `site_region` list for an admin to
          * edit, and hardcoding a two-item dropdown here would be this file
          * quietly inventing a vocabulary the rest of the product does not
          * enforce. The hint names the two values already in the data instead,
          * which is the honest version of the same guidance.
          */}
        <Field
          id="region"
          label="Region"
          value={form.region}
          onChange={set("region")}
          hint="How the portfolio is split for reporting. Existing sites use UK or Europe."
        />
        {/*
          W05-01 — the coordinates, beside the address they belong to.
          `type="number"` with the real bounds rather than free text: the route
          refuses anything outside them, and a field that only tells you its
          rules after a failed save is a field that teaches its rules by
          punishing you. `step="any"` because a degree is not an integer.
        */}
        <Field
          id="latitude"
          label="Latitude"
          type="number"
          min={-90}
          max={90}
          step="any"
          value={form.latitude}
          onChange={set("latitude")}
          placeholder="51.5074"
          hint="Decimal degrees, between -90 and 90. Leave blank if the position is not known."
        />
        <Field
          id="longitude"
          label="Longitude"
          type="number"
          min={-180}
          max={180}
          step="any"
          value={form.longitude}
          onChange={set("longitude")}
          placeholder="-0.1278"
          hint="Decimal degrees, between -180 and 180."
        />
      </SectionPanel>

      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Contacts"
        className="form-grid"
        active={section === "Contacts"}
      >
        <Field id="mgr" label="Site manager" value={form.managerName} onChange={set("managerName")} />
        <Field id="mgr-phone" label="Manager phone" type="tel" value={form.managerPhone} onChange={set("managerPhone")} hint="Keep the leading zero." />
        <Field id="mgr-email" label="Manager email" type="email" value={form.managerEmail} onChange={set("managerEmail")} />
        <Field id="landlord" label="Landlord" value={form.landlord} onChange={set("landlord")} />
        <Field id="agent" label="Managing agent" value={form.managingAgent} onChange={set("managingAgent")} />
        <Field id="ooh" label="Out-of-hours contact" value={form.outOfHoursContact} onChange={set("outOfHoursContact")} />
      </SectionPanel>

      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Access"
        className="form-grid"
        active={section === "Access"}
      >
        <Field
          id="access-method"
          label="How access is arranged"
          value={form.accessMethod}
          onChange={set("accessMethod")}
          options={accessMethods}
          hint="One method per site. Add another in Settings if yours is missing."
        />
        <Field id="access-contact" label="Access contact" value={form.accessContact} onChange={set("accessContact")} hint="Email address or phone number, whichever the centre uses." />
        <Field id="access-url" label="Access portal" type="url" value={form.accessUrl} onChange={set("accessUrl")} />
        <Field id="access-notes" label="Access notes" value={form.accessNotes} onChange={set("accessNotes")} multiline />
      </SectionPanel>

      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Opening"
        className="form-grid"
        active={section === "Opening"}
      >
        <Field id="hours" label="Opening hours" value={form.openingHours} onChange={set("openingHours")} multiline />
        <Field id="delivery" label="Delivery restrictions" value={form.deliveryRestrictions} onChange={set("deliveryRestrictions")} multiline />
        <Field id="parking" label="Parking" value={form.parkingNotes} onChange={set("parkingNotes")} multiline />
        <Field id="keys" label="Key and alarm notes" value={form.keyAlarmNotes} onChange={set("keyAlarmNotes")} multiline />
      </SectionPanel>

      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Lease"
        className="form-grid"
        active={section === "Lease"}
      >
        <Field id="lease-start" label="Lease start" type="date" value={form.leaseStart} onChange={set("leaseStart")} />
        <Field id="lease-end" label="Lease end" type="date" value={form.leaseEnd} onChange={set("leaseEnd")} />
        <Field id="break" label="Break clause" value={form.breakClause} onChange={set("breakClause")} />
        <Field id="review" label="Rent review" value={form.rentReview} onChange={set("rentReview")} />
        <Field id="charge" label="Service charge (£)" type="number" value={form.serviceCharge} onChange={set("serviceCharge")} hint="Annual amount in pounds." />
        <Field
          id="budget"
          label="Annual maintenance budget (£)"
          type="number"
          value={form.annualBudget}
          onChange={set("annualBudget")}
          hint="Leave blank if no budget is set. Spend against budget reports how much of the portfolio is covered."
        />
      </SectionPanel>

      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Reconciliation"
        className="form-grid"
        active={section === "Reconciliation"}
      >
        <p className="form-hint">
          The two monday boards name the same site differently. Record both
          spellings here and an import matches either one.
        </p>
        <Field id="monday-maint" label="Name on the Maintenance board" value={form.mondayMaintenanceName} onChange={set("mondayMaintenanceName")} placeholder="Wood Green - High Road" />
        <Field id="monday-comp" label="Name on the Store Documentation board" value={form.mondayComplianceName} onChange={set("mondayComplianceName")} placeholder="Woodgreen" />
      </SectionPanel>

      {error ? (
        <div className="form-error" role="alert">
          <p>{error}</p>
          {duplicates.length ? (
            <>
              <ul>
                {duplicates.map((entry) => (
                  <li key={entry.id}>
                    {entry.name} ({entry.status})
                  </li>
                ))}
              </ul>
              <button type="button" className="secondary-button" onClick={() => save(true)}>
                Save anyway
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="section-header__actions">
        <button type="button" className="secondary-button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={saving || !form.name.trim()}
          onClick={() => save(duplicates.length > 0)}
        >
          {saving ? "Saving…" : site ? "Save changes" : "Add site"}
        </button>
      </div>
    </div>
  );
}
