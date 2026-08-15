"use client";

import { useCallback, useMemo, useState } from "react";
import { RaiseTicketButton } from "../raise-ticket";
import { useLoader } from "../sites/use-loader";
import { FormField as Field } from "../sites/form-field";
import {
  api,
  daysUntil,
  formatDate,
  formatMoney,
  labelFor,
  styleFor,
  type OptionChoice,
  type ServiceRecord,
  type UnitRecord,
} from "../sites/site-types";

/** Only identity is needed here, so any site-shaped record will do. */
type SiteChoice = { id: string; name: string };

type UnitsPayload = {
  units: UnitRecord[];
  categories: OptionChoice[];
  statuses: OptionChoice[];
};

type UnitDetailPayload = {
  unit: UnitRecord;
  history: ServiceRecord[];
  files: Array<{ id: string; originalName: string; createdAt: string }>;
};

const BLANK: Record<string, string> = {
  siteId: "",
  name: "",
  category: "",
  status: "",
  manufacturer: "",
  model: "",
  serialNumber: "",
  assetTag: "",
  locationInSite: "",
  installedAt: "",
  warrantyExpiry: "",
  purchasePrice: "",
  supplier: "",
  lastServicedAt: "",
  serviceIntervalMonths: "",
  notes: "",
};

function toForm(unit: UnitRecord): Record<string, string> {
  return {
    siteId: unit.siteId,
    name: unit.name,
    category: unit.category,
    status: unit.status,
    manufacturer: unit.manufacturer ?? "",
    model: unit.model ?? "",
    serialNumber: unit.serialNumber ?? "",
    assetTag: unit.assetTag ?? "",
    locationInSite: unit.locationInSite ?? "",
    installedAt: unit.installedAt ?? "",
    warrantyExpiry: unit.warrantyExpiry ?? "",
    purchasePrice:
      unit.purchasePricePence === null ? "" : (unit.purchasePricePence / 100).toFixed(2),
    supplier: unit.supplier ?? "",
    lastServicedAt: unit.lastServicedAt ?? "",
    serviceIntervalMonths:
      unit.serviceIntervalMonths === null ? "" : String(unit.serviceIntervalMonths),
    notes: unit.notes ?? "",
  };
}

export function UnitsManager({
  sites,
  onNotify,
}: {
  sites: SiteChoice[];
  onNotify: (message: string) => void;
}) {
  const [siteFilter, setSiteFilter] = useState("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<{ id: string | null; form: Record<string, string> } | null>(null);
  const [detail, setDetail] = useState<UnitDetailPayload | null>(null);
  const [service, setService] = useState({ performedAt: "", serviceType: "", contractorName: "", outcome: "", cost: "", notes: "" });
  const { data, error, setError, reload } = useLoader<UnitsPayload>(
    () => api<UnitsPayload>("/api/units"),
    "Units could not be loaded.",
  );

  const siteOptions = useMemo(
    () => sites.map((site) => ({ value: site.id, label: site.name })),
    [sites],
  );
  const siteName = useCallback(
    (id: string) => sites.find((site) => site.id === id)?.name ?? "Unknown site",
    [sites],
  );

  const visible = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    return data.units.filter((unit) => {
      if (siteFilter && unit.siteId !== siteFilter) return false;
      if (!term) return true;
      return [unit.name, unit.serialNumber, unit.assetTag, unit.model]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(term));
    });
  }, [data, search, siteFilter]);

  async function save() {
    if (!editing) return;
    try {
      await api("/api/units", {
        method: editing.id ? "PATCH" : "POST",
        body: { id: editing.id, data: editing.form },
      });
      onNotify(editing.id ? "Asset updated." : "Asset added.");
      setEditing(null);
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The asset could not be saved.");
    }
  }

  async function openDetail(unitId: string) {
    try {
      setDetail(await api<UnitDetailPayload>(`/api/units?id=${encodeURIComponent(unitId)}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The asset could not be opened.");
    }
  }

  async function recordService() {
    if (!detail) return;
    try {
      await api("/api/units", {
        method: "POST",
        body: { unitId: detail.unit.id, serviceRecord: service },
      });
      onNotify("Service visit recorded.");
      setService({ performedAt: "", serviceType: "", contractorName: "", outcome: "", cost: "", notes: "" });
      await openDetail(detail.unit.id);
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The visit could not be recorded.");
    }
  }

  if (detail) {
    return (
      <section className="section-stack">
        <header className="section-header">
          <div>
            <p className="eyebrow-chip">{siteName(detail.unit.siteId)}</p>
            <h2>{detail.unit.name}</h2>
          </div>
          <button type="button" className="secondary-button" onClick={() => setDetail(null)}>
            Back to assets
          </button>
        </header>

        <div className="site-stat-grid">
          <div className="panel">
            <span className="drawer-label">Serial</span>
            <strong>{detail.unit.serialNumber ?? "—"}</strong>
          </div>
          <div className="panel">
            <span className="drawer-label">Warranty</span>
            <strong>{formatDate(detail.unit.warrantyExpiry)}</strong>
          </div>
          <div className="panel">
            <span className="drawer-label">Last serviced</span>
            <strong>{formatDate(detail.unit.lastServicedAt)}</strong>
          </div>
          <div className="panel">
            <span className="drawer-label">Next service</span>
            <strong>{formatDate(detail.unit.nextServiceDueAt)}</strong>
          </div>
          <div className="panel">
            <span className="drawer-label">Purchase price</span>
            <strong>{formatMoney(detail.unit.purchasePricePence)}</strong>
          </div>
        </div>

        <div className="panel">
          <h3>Record a service visit</h3>
          <div className="form-grid">
            <Field id="svc-date" label="Date" type="date" value={service.performedAt} onChange={(v) => setService((s) => ({ ...s, performedAt: v }))} required />
            <Field id="svc-type" label="Type" value={service.serviceType} onChange={(v) => setService((s) => ({ ...s, serviceType: v }))} />
            <Field id="svc-contractor" label="Contractor" value={service.contractorName} onChange={(v) => setService((s) => ({ ...s, contractorName: v }))} />
            <Field id="svc-outcome" label="Outcome" value={service.outcome} onChange={(v) => setService((s) => ({ ...s, outcome: v }))} />
            <Field id="svc-cost" label="Cost (£)" type="number" value={service.cost} onChange={(v) => setService((s) => ({ ...s, cost: v }))} />
            <Field id="svc-notes" label="Notes" value={service.notes} onChange={(v) => setService((s) => ({ ...s, notes: v }))} />
          </div>
          <button type="button" className="primary-button" onClick={recordService} disabled={!service.performedAt}>
            Record visit
          </button>
        </div>

        <h3>Service history</h3>
        {detail.history.length === 0 ? (
          <p className="analytics-empty">No visits recorded against this asset yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="analytics-table analytics-table--mobile-cards">
              <caption className="visually-hidden">Service history</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Type</th>
                  <th scope="col">Contractor</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                {detail.history.map((entry) => (
                  <tr key={entry.id}>
                    <td data-label="Date">{formatDate(entry.performedAt)}</td>
                    <td data-label="Type">{entry.serviceType}</td>
                    <td data-label="Contractor">{entry.contractorName ?? "—"}</td>
                    <td data-label="Outcome">{entry.outcome ?? "—"}</td>
                    <td data-label="Cost">{formatMoney(entry.costPence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    );
  }

  if (editing) {
    return (
      <section className="section-stack">
        <header className="section-header">
          <h2>{editing.id ? "Edit asset" : "Add an asset"}</h2>
        </header>
        <div className="form-grid">
          <Field id="u-site" label="Site" value={editing.form.siteId} onChange={(v) => setEditing((e) => e && { ...e, form: { ...e.form, siteId: v } })} options={siteOptions} required />
          <Field id="u-name" label="Asset name" value={editing.form.name} onChange={(v) => setEditing((e) => e && { ...e, form: { ...e.form, name: v } })} required />
          <Field id="u-cat" label="Category" value={editing.form.category} onChange={(v) => setEditing((e) => e && { ...e, form: { ...e.form, category: v } })} options={data?.categories.filter((c) => c.active).map((c) => ({ value: c.value, label: c.label })) ?? []} />
          <Field id="u-status" label="Status" value={editing.form.status} onChange={(v) => setEditing((e) => e && { ...e, form: { ...e.form, status: v } })} options={data?.statuses.filter((c) => c.active).map((c) => ({ value: c.value, label: c.label })) ?? []} />
          <Field id="u-loc" label="Where it is on site" value={editing.form.locationInSite} onChange={(v) => setEditing((e) => e && { ...e, form: { ...e.form, locationInSite: v } })} />
          <Field id="u-tag" label="Asset tag" value={editing.form.assetTag} onChange={(v) => setEditing((e) => e && { ...e, form: { ...e.form, assetTag: v } })} />
          <Field id="u-make" label="Manufacturer" value={editing.form.manufacturer} onChange={(v) => setEditing((e) => e && { ...e, form: { ...e.form, manufacturer: v } })} />
          <Field id="u-model" label="Model" value={editing.form.model} onChange={(v) => setEditing((e) => e && { ...e, form: { ...e.form, model: v } })} />
          <Field id="u-serial" label="Serial number" value={editing.form.serialNumber} onChange={(v) => setEditing((e) => e && { ...e, form: { ...e.form, serialNumber: v } })} />
          <Field id="u-supplier" label="Supplier" value={editing.form.supplier} onChange={(v) => setEditing((e) => e && { ...e, form: { ...e.form, supplier: v } })} />
          <Field id="u-installed" label="Installed" type="date" value={editing.form.installedAt} onChange={(v) => setEditing((e) => e && { ...e, form: { ...e.form, installedAt: v } })} />
          <Field id="u-warranty" label="Warranty expiry" type="date" value={editing.form.warrantyExpiry} onChange={(v) => setEditing((e) => e && { ...e, form: { ...e.form, warrantyExpiry: v } })} />
          <Field id="u-price" label="Purchase price (£)" type="number" value={editing.form.purchasePrice} onChange={(v) => setEditing((e) => e && { ...e, form: { ...e.form, purchasePrice: v } })} />
          <Field id="u-last" label="Last serviced" type="date" value={editing.form.lastServicedAt} onChange={(v) => setEditing((e) => e && { ...e, form: { ...e.form, lastServicedAt: v } })} />
          <Field id="u-interval" label="Service every (months)" type="number" value={editing.form.serviceIntervalMonths} onChange={(v) => setEditing((e) => e && { ...e, form: { ...e.form, serviceIntervalMonths: v } })} hint="The next service date is worked out from this." />
          <Field id="u-notes" label="Notes" value={editing.form.notes} onChange={(v) => setEditing((e) => e && { ...e, form: { ...e.form, notes: v } })} />
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="section-header__actions">
          <button type="button" className="secondary-button" onClick={() => setEditing(null)}>Cancel</button>
          <button type="button" className="primary-button" onClick={save} disabled={!editing.form.name.trim() || !editing.form.siteId}>
            {editing.id ? "Save changes" : "Add asset"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="section-stack">
      <header className="section-header">
        <div>
          {/* An `<h1>` for the same reason as the site register's — this page
              carried no heading of any level above 2, so it had no name of its
              own once the topbar stopped supplying one below 768px. */}
          <h1>Units and assets</h1>
          <p className="drawer-label">Equipment on site, with its warranty and service record.</p>
        </div>
        <div className="section-header__actions">
          {/* An asset that has failed is the most common reason anybody opens
              this screen. The unit and its site travel onto the ticket. */}
          <RaiseTicketButton
            context={{ section: "Assets" }}
            label="Raise a ticket"
            onRaised={(ticket) =>
              onNotify(`${ticket.reference ?? ticket.title} raised for ${ticket.siteName}.`)
            }
            onNotify={onNotify}
          />
          <button type="button" className="primary-button" onClick={() => setEditing({ id: null, form: { ...BLANK } })}>
            Add asset
          </button>
        </div>
      </header>

      <div className="workspace-toolbar">
        <div className="search-field">
          <label htmlFor="unit-search" className="visually-hidden">Search assets</label>
          <input id="unit-search" type="search" placeholder="Search name, serial or tag" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <label htmlFor="unit-site-filter" className="visually-hidden">Filter by site</label>
        <select id="unit-site-filter" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
          <option value="">All sites</option>
          {siteOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      {error ? <p className="form-error" role="alert">{error}</p> : null}

      {!data ? (
        <p className="analytics-empty">Loading assets…</p>
      ) : visible.length === 0 ? (
        <p className="analytics-empty">
          {data.units.length === 0 ? "No assets recorded yet. Add the first one." : "No assets match these filters."}
        </p>
      ) : (
        <div className="table-scroll">
          <table className="analytics-table analytics-table--mobile-cards">
            <caption className="visually-hidden">Asset register</caption>
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col">Site</th>
                <th scope="col">Category</th>
                <th scope="col">Status</th>
                <th scope="col">Next service</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((unit) => {
                const due = daysUntil(unit.nextServiceDueAt);
                return (
                  <tr key={unit.id}>
                    <td data-label="Asset">
                      <button type="button" className="table-text-action" onClick={() => openDetail(unit.id)}>
                        {unit.name}
                      </button>
                    </td>
                    <td data-label="Site">{siteName(unit.siteId)}</td>
                    <td data-label="Category">{labelFor(data.categories, unit.category)}</td>
                    <td data-label="Status">
                      <span className="status-chip" style={styleFor(data.statuses, unit.status)}>
                        {labelFor(data.statuses, unit.status)}
                      </span>
                    </td>
                    <td data-label="Next service">
                      {formatDate(unit.nextServiceDueAt)}
                      {due !== null && due < 0 ? " (overdue)" : ""}
                    </td>
                    <td data-label="Actions">
                      <button type="button" className="secondary-button" onClick={() => setEditing({ id: unit.id, form: toForm(unit) })}>
                        Edit
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
