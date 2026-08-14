"use client";

import { useState } from "react";
import { FormField as Field } from "./form-field";
import {
  ApiError,
  api,
  type DuplicateWarning,
  type OptionChoice,
  type SiteGroupRecord,
  type SiteRecord,
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

export function SiteForm({
  site,
  siteTypes,
  statuses,
  accessMethods,
  groups,
  memberGroupIds,
  onSaved,
  onCancel,
}: {
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
      await api(site ? "/api/sites" : "/api/sites", {
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
      <div className="view-switch" role="tablist" aria-label="Site detail sections">
        {SECTIONS.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={section === entry}
            className={section === entry ? "is-active" : ""}
            onClick={() => setSection(entry)}
          >
            {entry}
          </button>
        ))}
      </div>

      {section === "Identity" ? (
        <div className="form-grid">
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
        </div>
      ) : null}

      {section === "Address" ? (
        <div className="form-grid">
          <Field id="addr1" label="Address line 1" value={form.addressLine1} onChange={set("addressLine1")} required />
          <Field id="addr2" label="Address line 2" value={form.addressLine2} onChange={set("addressLine2")} />
          <Field id="city" label="Town or city" value={form.city} onChange={set("city")} />
          <Field id="postcode" label="Postcode" value={form.postcode} onChange={set("postcode")} />
          <Field id="country" label="Country" value={form.country} onChange={set("country")} />
        </div>
      ) : null}

      {section === "Contacts" ? (
        <div className="form-grid">
          <Field id="mgr" label="Site manager" value={form.managerName} onChange={set("managerName")} />
          <Field id="mgr-phone" label="Manager phone" type="tel" value={form.managerPhone} onChange={set("managerPhone")} hint="Keep the leading zero." />
          <Field id="mgr-email" label="Manager email" type="email" value={form.managerEmail} onChange={set("managerEmail")} />
          <Field id="landlord" label="Landlord" value={form.landlord} onChange={set("landlord")} />
          <Field id="agent" label="Managing agent" value={form.managingAgent} onChange={set("managingAgent")} />
          <Field id="ooh" label="Out-of-hours contact" value={form.outOfHoursContact} onChange={set("outOfHoursContact")} />
        </div>
      ) : null}

      {section === "Access" ? (
        <div className="form-grid">
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
        </div>
      ) : null}

      {section === "Opening" ? (
        <div className="form-grid">
          <Field id="hours" label="Opening hours" value={form.openingHours} onChange={set("openingHours")} multiline />
          <Field id="delivery" label="Delivery restrictions" value={form.deliveryRestrictions} onChange={set("deliveryRestrictions")} multiline />
          <Field id="parking" label="Parking" value={form.parkingNotes} onChange={set("parkingNotes")} multiline />
          <Field id="keys" label="Key and alarm notes" value={form.keyAlarmNotes} onChange={set("keyAlarmNotes")} multiline />
        </div>
      ) : null}

      {section === "Lease" ? (
        <div className="form-grid">
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
        </div>
      ) : null}

      {section === "Reconciliation" ? (
        <div className="form-grid">
          <p className="form-hint">
            The two monday boards name the same site differently. Record both
            spellings here and an import matches either one.
          </p>
          <Field id="monday-maint" label="Name on the Maintenance board" value={form.mondayMaintenanceName} onChange={set("mondayMaintenanceName")} placeholder="Wood Green - High Road" />
          <Field id="monday-comp" label="Name on the Store Documentation board" value={form.mondayComplianceName} onChange={set("mondayComplianceName")} placeholder="Woodgreen" />
        </div>
      ) : null}

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
