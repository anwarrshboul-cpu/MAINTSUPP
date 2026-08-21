"use client";

import { useMemo, useState } from "react";
import { Icon, type IconName } from "../../components";
import { storeDocumentationKinds } from "../../../db/monday-board-spec";
import { MondayImportPanel } from "./monday-import-panel";
import type {
  WorkspaceEntity,
  WorkspaceSnapshot,
} from "../../lib/workspace-data";

type ManagerTab = Exclude<WorkspaceEntity, "settings"> | "activity" | "import";
type EditorValue = string | boolean;
type EditorData = Record<string, EditorValue>;

type FieldDefinition = {
  key: string;
  label: string;
  type?: "text" | "email" | "tel" | "number" | "date" | "textarea" | "select" | "checkbox";
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
};

// Sites and units moved to their own modules in Stage 2. They are deliberately
// absent here: two editors writing one table with different field sets meant
// whichever screen an admin happened to open decided what got saved.
/*
 * Sites and Units were missing from this list, and everything else in the file
 * already supported them: `emptyDefaults`, `fieldsFor`, `recordsFor`,
 * `recordTitle` and `recordToEditor` all have a `site` and a `unit` branch.
 *
 * Only the tab strip did not, and the manager opens on `site` by default —
 * `openWorkspaceManager` falls back to it for any surface without a mapping,
 * which is every surface the Jobs board is on. So "Manage data" opened showing
 * the site list with no tab selected, no way to get back to it after clicking
 * another tab, and a search box reading "Search undefined…" because
 * `tabs.find(...)` had nothing to find.
 */
const tabs: Array<{ key: ManagerTab; label: string; icon: IconName }> = [
  { key: "site", label: "Sites", icon: "building" },
  { key: "unit", label: "Units", icon: "grid" },
  { key: "compliance", label: "Compliance", icon: "shield" },
  { key: "contractor", label: "Contractors", icon: "users" },
  { key: "planned", label: "Planned", icon: "calendar" },
  { key: "member", label: "Team", icon: "users" },
  { key: "activity", label: "Activity", icon: "activity" },
  { key: "import", label: "Import", icon: "upload" },
];

const emptyDefaults: Record<Exclude<ManagerTab, "activity" | "import">, EditorData> = {
  site: { name: "", type: "Kiosk", region: "UK", lifecycle: "Current", address: "", manager: "" },
  compliance: { siteId: "", kind: "", state: "Missing", expiry: "" },
  unit: { siteId: "", name: "", category: "Asset", manufacturer: "", model: "", serialNumber: "", status: "Active", notes: "" },
  contractor: { name: "", contactName: "", email: "", phone: "", address: "", serviceCategories: "", coverageAreas: "UK", certifications: "", insuranceExpiry: "", dayRate: "", availability: "Available", rating: "4", active: true, notes: "" },
  planned: { siteId: "", unitId: "", contractorId: "", title: "", category: "Planned maintenance", frequency: "Annual", nextDueAt: "", lastCompletedAt: "", status: "Scheduled", reminderDays: "30" },
  member: { name: "", email: "", role: "Client", active: true },
};

function dateValue(value: unknown) {
  return typeof value === "string" && value ? value.slice(0, 10) : "";
}

function stringify(value: unknown): EditorValue {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined) return "";
  return String(value);
}

function editorData(record: Record<string, unknown>, dateKeys: string[] = []): EditorData {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      dateKeys.includes(key) ? dateValue(value) : stringify(value),
    ]),
  );
}

function fieldsFor(tab: Exclude<ManagerTab, "activity">, workspace: WorkspaceSnapshot): FieldDefinition[] {
  const siteOptions = workspace.stores.map((site) => ({ value: site.id, label: site.name }));
  const unitOptions = [{ value: "", label: "No linked unit" }, ...workspace.units.map((unit) => ({ value: unit.id, label: unit.name }))];
  const contractorOptions = [{ value: "", label: "No contractor" }, ...workspace.contractors.filter((item) => item.active).map((item) => ({ value: item.id, label: item.name }))];
  if (tab === "site") return [
    { key: "name", label: "Site name", required: true },
    { key: "type", label: "Type", type: "select", options: ["Kiosk", "Inline", "Office", "Warehouse"].map((value) => ({ value, label: value })) },
    { key: "region", label: "Region", type: "select", options: ["UK", "Europe", "Other"].map((value) => ({ value, label: value })) },
    { key: "lifecycle", label: "Lifecycle", type: "select", options: ["Current", "Closed"].map((value) => ({ value, label: value })) },
    { key: "address", label: "Address", type: "textarea", required: true },
    { key: "manager", label: "Site manager" },
  ];
  if (tab === "compliance") return [
    { key: "siteId", label: "Site", type: "select", required: true, options: siteOptions },
    // The twelve requirements the Store Documentation board tracks. This was a
    // free-text box, so the same certificate was filed under "PAT", "PAT test"
    // and "PAT Test Certificate" on different sites and the register counted
    // them as three separate requirements. Anything already recorded under
    // another name is still editable — the select keeps it as an option.
    {
      key: "kind",
      label: "Requirement",
      type: "select",
      required: true,
      options: [
        ...storeDocumentationKinds,
        ...[...new Set(workspace.compliance.map((item) => item.kind))].filter(
          (kind) => !storeDocumentationKinds.includes(kind),
        ),
      ].map((value) => ({ value, label: value })),
    },
    { key: "state", label: "Status", type: "select", options: ["Compliant", "Expiring soon", "Expired", "Missing", "Not required"].map((value) => ({ value, label: value })) },
    { key: "expiry", label: "Expiry date", type: "date" },
  ];
  if (tab === "unit") return [
    { key: "siteId", label: "Site", type: "select", required: true, options: siteOptions },
    { key: "name", label: "Unit / asset name", required: true },
    { key: "category", label: "Category", required: true },
    { key: "manufacturer", label: "Manufacturer" },
    { key: "model", label: "Model" },
    { key: "serialNumber", label: "Serial number" },
    { key: "status", label: "Status", type: "select", options: ["Active", "Inactive", "Out of service", "Retired"].map((value) => ({ value, label: value })) },
    { key: "notes", label: "Notes", type: "textarea" },
  ];
  if (tab === "contractor") return [
    { key: "name", label: "Contractor name", required: true },
    /*
     * The person, not just the company. "Call Apex Electrical" is not an
     * instruction anybody can follow at 7am with water coming through a
     * ceiling; "call Dan at Apex" is.
     */
    { key: "contactName", label: "Contact person", placeholder: "Who to ask for" },
    { key: "email", label: "Email", type: "email" },
    { key: "phone", label: "Phone", type: "tel" },
    { key: "address", label: "Address", placeholder: "Where they are based" },
    { key: "serviceCategories", label: "Service categories", placeholder: "Electrical, HVAC, Plumbing" },
    { key: "coverageAreas", label: "Coverage areas", placeholder: "UK, London, Midlands" },
    { key: "certifications", label: "Certifications", placeholder: "Comma-separated" },
    { key: "insuranceExpiry", label: "Insurance expiry", type: "date" },
    /* Pounds here, pence in the column — see `ratePence` in the workspace API.
       Left empty it stays null, because no recorded rate is not a rate of £0. */
    { key: "dayRate", label: "Day rate (£)", type: "number", placeholder: "e.g. 320" },
    { key: "availability", label: "Availability", type: "select", options: ["Available", "Limited", "Unavailable", "Inactive"].map((value) => ({ value, label: value })) },
    { key: "rating", label: "Rating (0–5)", type: "number" },
    { key: "active", label: "Active contractor", type: "checkbox" },
    { key: "notes", label: "Notes", type: "textarea", placeholder: "What was agreed, access arrangements, anything the next coordinator needs" },
  ];
  if (tab === "planned") return [
    { key: "siteId", label: "Site", type: "select", required: true, options: siteOptions },
    { key: "unitId", label: "Linked unit", type: "select", options: unitOptions },
    { key: "contractorId", label: "Contractor", type: "select", options: contractorOptions },
    { key: "title", label: "Planned task", required: true },
    { key: "category", label: "Category", required: true },
    { key: "frequency", label: "Frequency", type: "select", options: ["One-off", "Weekly", "Monthly", "Quarterly", "Biannual", "Annual"].map((value) => ({ value, label: value })) },
    { key: "nextDueAt", label: "Next due", type: "date", required: true },
    { key: "lastCompletedAt", label: "Last completed", type: "date" },
    { key: "status", label: "Status", type: "select", options: ["Scheduled", "Booked", "In progress", "Completed", "On hold", "Cancelled"].map((value) => ({ value, label: value })) },
    { key: "reminderDays", label: "Reminder days", type: "number" },
  ];
  return [
    { key: "name", label: "Full name", required: true },
    { key: "email", label: "Email", type: "email", required: true },
    { key: "role", label: "Role", type: "select", options: ["Super Admin", "Admin", "Client"].map((value) => ({ value, label: value })) },
    { key: "active", label: "Active access", type: "checkbox" },
  ];
}

function recordsFor(tab: ManagerTab, workspace: WorkspaceSnapshot): Array<Record<string, unknown>> {
  if (tab === "site") return workspace.stores as unknown as Array<Record<string, unknown>>;
  if (tab === "compliance") return workspace.compliance as unknown as Array<Record<string, unknown>>;
  if (tab === "unit") return workspace.units as unknown as Array<Record<string, unknown>>;
  if (tab === "contractor") return workspace.contractors as unknown as Array<Record<string, unknown>>;
  if (tab === "planned") return workspace.planned as unknown as Array<Record<string, unknown>>;
  if (tab === "member") return workspace.team as unknown as Array<Record<string, unknown>>;
  return workspace.activity as unknown as Array<Record<string, unknown>>;
}

function recordTitle(tab: ManagerTab, record: Record<string, unknown>) {
  if (tab === "site") return String(record.name ?? "Site");
  if (tab === "compliance") return String(record.kind ?? "Requirement");
  if (tab === "unit") return String(record.name ?? "Unit");
  if (tab === "contractor") return String(record.name ?? "Contractor");
  if (tab === "planned") return String(record.title ?? "Planned task");
  if (tab === "member") return String(record.name ?? record.email ?? "Team member");
  return String(record.action ?? "Activity").replaceAll("_", " ");
}

function recordSubtitle(tab: ManagerTab, record: Record<string, unknown>) {
  if (tab === "site") return `${record.type ?? "Site"} · ${record.lifecycle ?? "Current"}`;
  if (tab === "compliance") return `${record.siteName ?? "Unknown site"} · ${record.state ?? "Missing"}`;
  if (tab === "unit") return `${record.siteName ?? "Unknown site"} · ${record.status ?? "Active"}`;
  if (tab === "contractor") return `${record.availability ?? "Available"} · ${record.assignedJobs ?? 0} jobs`;
  if (tab === "planned") return `${record.siteName ?? "Unknown site"} · ${dateValue(record.nextDueAt) || "No date"}`;
  if (tab === "member") return `${record.role ?? "Client"} · ${record.active ? "Active" : "Paused"}`;
  return `${record.actorEmail ?? "Workspace"} · ${dateValue(record.createdAt)}`;
}

function recordToEditor(tab: Exclude<ManagerTab, "activity">, record: Record<string, unknown>) {
  const wanted = fieldsFor(tab, {
    stores: [], compliance: [], units: [], contractors: [], planned: [], team: [], activity: [],
    settings: {
      alerts: { urgent: true, compliance: true, daily: false },
      slas: {},
      completionEvidenceCategories: [],
    },
  }).map((field) => field.key);
  const selected = Object.fromEntries(wanted.map((key) => [key, record[key]]));
  /*
   * The rate is stored in pence and edited in pounds, so the two names differ
   * and the plain key copy above cannot find it. Without this the box is empty
   * every time an existing contractor is opened, and saving would wipe a rate
   * that was already recorded.
   */
  if (tab === "contractor" && "dayRate" in selected) {
    const pence = record.dayRatePence;
    selected.dayRate = typeof pence === "number" ? String(pence / 100) : "";
  }
  return editorData(selected, ["expiry", "insuranceExpiry", "nextDueAt", "lastCompletedAt"]);
}

export function WorkspaceDataManager({
  workspace,
  initialTab,
  initialRecordId,
  busy,
  onClose,
  onSave,
  onArchive,
  onImported,
}: {
  workspace: WorkspaceSnapshot;
  initialTab: ManagerTab;
  initialRecordId?: string | null;
  busy: boolean;
  onClose: () => void;
  onSave: (entity: Exclude<ManagerTab, "activity" | "import">, id: string | null, data: Record<string, unknown>) => Promise<void>;
  onArchive: (entity: Exclude<ManagerTab, "activity" | "import">, id: string) => Promise<void>;
  /** Fired after a monday import writes, so the dashboard reloads its data. */
  onImported?: () => void;
}) {
  const [tab, setTab] = useState<ManagerTab>(initialTab);
  const [query, setQuery] = useState("");
  const initialRecord = initialRecordId && initialTab !== "activity"
    ? recordsFor(initialTab, workspace).find((item) => item.id === initialRecordId)
    : null;
  const [editorId, setEditorId] = useState<string | null>(initialRecord ? initialRecordId ?? null : null);
  const [form, setForm] = useState<EditorData | null>(() =>
    initialRecord && initialTab !== "activity"
      ? recordToEditor(initialTab, initialRecord)
      : null,
  );

  const records = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return recordsFor(tab, workspace).filter((record) =>
      !needle || `${recordTitle(tab, record)} ${recordSubtitle(tab, record)}`.toLowerCase().includes(needle),
    );
  }, [query, tab, workspace]);
  const readOnlyTab = tab === "activity" || tab === "import";
  const fields = readOnlyTab ? [] : fieldsFor(tab, workspace);
  const activeTabLabel = tabs.find((item) => item.key === tab)?.label ?? "records";

  const startNew = () => {
    if (readOnlyTab) return;
    const defaults = { ...emptyDefaults[tab] };
    if ("siteId" in defaults && !defaults.siteId) defaults.siteId = workspace.stores[0]?.id ?? "";
    setEditorId(null);
    setForm(defaults);
  };

  const editRecord = (record: Record<string, unknown>) => {
    if (readOnlyTab) return;
    setEditorId(String(record.id));
    setForm(recordToEditor(tab, record));
  };

  return (
    <div className="workspace-manager-layer" role="presentation">
      <button className="modal-scrim" type="button" aria-label="Close data manager" onClick={onClose} />
      <section className="workspace-manager" role="dialog" aria-modal="true" aria-labelledby="workspace-manager-title">
        <header className="workspace-manager__header">
          <div>
            <span><Icon name="grid" size={18} /></span>
            <div><small>Shared workspace database</small><h2 id="workspace-manager-title">Manage dashboard data</h2></div>
          </div>
          <button className="icon-button" type="button" aria-label="Close" onClick={onClose}><Icon name="close" size={19} /></button>
        </header>
        <div className="workspace-manager__tabs" role="tablist" aria-label="Data sections">
          {tabs.map((item) => (
            <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} className={tab === item.key ? "is-active" : ""} onClick={() => { setTab(item.key); setForm(null); setEditorId(null); setQuery(""); }}>
              <Icon name={item.icon} size={16} /><span>{item.label}</span>
            </button>
          ))}
        </div>
        <div className={`workspace-manager__body${form ? " has-editor" : ""}`}>
          {tab === "import" ? (
            <MondayImportPanel onImported={onImported} />
          ) : (
          <div className="workspace-manager__records">
            <div className="workspace-manager__toolbar">
              {/*
                `?? "records"`, so an unlisted tab can never put the word
                "undefined" in front of somebody again. The missing tabs above
                are the real fix; this is the guard that keeps the next one from
                showing.
              */}
              <label><Icon name="search" size={17} /><input type="search" aria-label={`Search ${activeTabLabel}`} placeholder={`Search ${activeTabLabel.toLowerCase()}…`} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
              {!readOnlyTab && <button className="primary-button" type="button" onClick={startNew}><Icon name="plus" size={17} />New</button>}
            </div>
            <div className="workspace-record-list">
              {records.map((record) => (
                <button key={String(record.id)} type="button" className={editorId === record.id ? "is-active" : ""} onClick={() => editRecord(record)}>
                  <span><strong>{recordTitle(tab, record)}</strong><small>{recordSubtitle(tab, record)}</small></span>
                  {!readOnlyTab && <Icon name="chevron" size={15} />}
                </button>
              ))}
              {!records.length && <div className="workspace-record-list__empty"><Icon name="search" size={22} /><strong>No records found</strong><span>Try another search or add a new record.</span></div>}
            </div>
          </div>
          )}
          {form && !readOnlyTab && (
            <form className="workspace-record-editor" onSubmit={async (event) => { event.preventDefault(); try { await onSave(tab, editorId, form); setForm(null); setEditorId(null); } catch { /* The dashboard toast reports the API error. */ } }}>
              <header><div><small>{editorId ? "Edit shared record" : "Create shared record"}</small><h3>{editorId ? "Update details" : `New ${tabs.find((item) => item.key === tab)?.label.slice(0, -1) || "record"}`}</h3></div><button className="icon-button" type="button" aria-label="Close editor" onClick={() => setForm(null)}><Icon name="close" size={17} /></button></header>
              <div className="workspace-record-editor__fields">
                {fields.map((field) => {
                  const value = form[field.key] ?? (field.type === "checkbox" ? false : "");
                  if (field.type === "checkbox") return (
                    <label className="workspace-checkbox" key={field.key}><span><strong>{field.label}</strong><small>Available in the shared testing workspace</small></span><input type="checkbox" checked={Boolean(value)} onChange={(event) => setForm((current) => current ? { ...current, [field.key]: event.target.checked } : current)} /></label>
                  );
                  return (
                    <label className="form-field" key={field.key}><span>{field.label}</span>
                      {field.type === "select" ? (
                        <select required={field.required} value={String(value)} onChange={(event) => setForm((current) => current ? { ...current, [field.key]: event.target.value } : current)}>
                          {!field.required && !field.options?.some((option) => option.value === "") && <option value="">None</option>}
                          {field.required && <option value="">Select…</option>}
                          {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      ) : field.type === "textarea" ? (
                        <textarea required={field.required} rows={3} value={String(value)} placeholder={field.placeholder} onChange={(event) => setForm((current) => current ? { ...current, [field.key]: event.target.value } : current)} />
                      ) : (
                        <input required={field.required} type={field.type ?? "text"} value={String(value)} placeholder={field.placeholder} step={field.type === "number" ? "any" : undefined} onChange={(event) => setForm((current) => current ? { ...current, [field.key]: event.target.value } : current)} />
                      )}
                    </label>
                  );
                })}
              </div>
              <footer>
                {editorId && <button className="secondary-button workspace-archive-button" type="button" disabled={busy} onClick={async () => { if (window.confirm("Archive this record? It will remain in the activity history.")) { try { await onArchive(tab, editorId); setForm(null); setEditorId(null); } catch { /* The dashboard toast reports the API error. */ } } }}>Archive</button>}
                <button className="secondary-button" type="button" onClick={() => setForm(null)}>Cancel</button>
                <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
              </footer>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}

export type { ManagerTab };
