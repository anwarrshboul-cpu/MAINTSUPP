"use client";

import { useState } from "react";
import { useLoader } from "./use-loader";
import {
  api,
  daysUntil,
  formatDate,
  formatMoney,
  labelFor,
  styleFor,
  type ComplianceRecord,
  type OptionChoice,
  type SiteRecord,
  type UnitRecord,
} from "./site-types";

type JobRow = {
  id: string;
  title: string;
  status: string;
  priority: string;
  engineer: string;
  requestedAt: string;
  completedAt: string | null;
  cost: number | null;
};

type FileRow = {
  id: string;
  originalName: string;
  kind: string;
  byteSize: number;
  createdAt: string;
};

type ActivityRow = {
  id: string;
  action: string;
  actorEmail: string | null;
  detail: string | null;
  createdAt: string;
};

type DetailPayload = {
  site: SiteRecord;
  jobs: JobRow[];
  units: UnitRecord[];
  compliance: ComplianceRecord[];
  files: FileRow[];
  activity: ActivityRow[];
  groupIds: string[];
};

const TABS = [
  "Overview",
  "Jobs",
  "Compliance",
  "Assets",
  "Documents",
  "Contacts",
  "Activity",
] as const;

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="analytics-empty">{children}</p>;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="detail-row">
      <span className="drawer-label">{label}</span>
      <span>{value || "—"}</span>
    </div>
  );
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Expiry colouring uses the same vocabulary the compliance register will use in
 * Stage 5, so the language does not change under the user's feet later.
 */
function expiryState(expiry: string | null, notRequired: boolean) {
  if (notRequired) return { label: "Not required", tone: "#5c82af" };
  if (!expiry) return { label: "No expiry recorded", tone: "#808799" };
  const days = daysUntil(expiry);
  if (days === null) return { label: "No expiry recorded", tone: "#808799" };
  if (days < 0) return { label: `Expired ${Math.abs(days)} days ago`, tone: "#e2445c" };
  if (days <= 30) return { label: `Expires in ${days} days`, tone: "#f0a91f" };
  return { label: `Valid to ${formatDate(expiry)}`, tone: "#12b4a8" };
}

export function SiteDetail({
  siteId,
  siteTypes,
  statuses,
  onEdit,
  onClose,
}: {
  siteId: string;
  siteTypes: OptionChoice[];
  statuses: OptionChoice[];
  onEdit: (site: SiteRecord) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const { data, error } = useLoader<DetailPayload>(
    () => api<DetailPayload>(`/api/sites?id=${encodeURIComponent(siteId)}`),
    "This site could not be loaded.",
  );

  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Empty>Loading site…</Empty>;

  const { site } = data;
  const openJobs = data.jobs.filter((job) => !job.completedAt);
  const spend = data.jobs.reduce((total, job) => total + (job.cost ?? 0), 0);

  return (
    <section className="section-stack site-detail">
      <header className="section-header">
        <div>
          <p className="eyebrow-chip">{site.code ?? "No code"}</p>
          <h2>{site.name}</h2>
          <p className="drawer-label">
            {[site.addressLine1, site.city, site.postcode].filter(Boolean).join(", ")}
          </p>
        </div>
        <div className="section-header__actions">
          <span className="status-chip" style={styleFor(statuses, site.status)}>
            {labelFor(statuses, site.status)}
          </span>
          <button type="button" className="secondary-button" onClick={() => onEdit(site)}>
            Edit site
          </button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close site">
            ✕
          </button>
        </div>
      </header>

      <div className="view-switch" role="tablist" aria-label="Site sections">
        {TABS.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={tab === entry}
            className={tab === entry ? "is-active" : ""}
            onClick={() => setTab(entry)}
          >
            {entry}
          </button>
        ))}
      </div>

      {tab === "Overview" ? (
        <div className="site-stat-grid">
          <div className="panel">
            <span className="drawer-label">Open jobs</span>
            <strong>{openJobs.length}</strong>
          </div>
          <div className="panel">
            <span className="drawer-label">Jobs recorded</span>
            <strong>{data.jobs.length}</strong>
          </div>
          <div className="panel">
            <span className="drawer-label">Assets</span>
            <strong>{data.units.length}</strong>
          </div>
          <div className="panel">
            <span className="drawer-label">Documents held</span>
            <strong>{data.compliance.length}</strong>
          </div>
          <div className="panel">
            <span className="drawer-label">Spend recorded</span>
            <strong>{formatMoney(Math.round(spend * 100))}</strong>
          </div>
          <div className="panel">
            <span className="drawer-label">Site type</span>
            <strong>{labelFor(siteTypes, site.siteTypeValue ?? site.type)}</strong>
          </div>
          <div className="panel site-detail__wide">
            <Row label="Lease" value={`${formatDate(site.leaseStart)} to ${formatDate(site.leaseEnd)}`} />
            <Row label="Break clause" value={site.breakClause} />
            <Row label="Rent review" value={site.rentReview} />
            <Row label="Service charge" value={formatMoney(site.serviceChargePence)} />
            <Row label="Opening hours" value={site.openingHours} />
            <Row label="Deliveries" value={site.deliveryRestrictions} />
            <Row label="Parking" value={site.parkingNotes} />
            <Row label="Notes" value={site.notes} />
          </div>
        </div>
      ) : null}

      {tab === "Jobs" ? (
        data.jobs.length === 0 ? (
          <Empty>No jobs have been raised for this site yet.</Empty>
        ) : (
          <div className="table-scroll">
            <table className="analytics-table analytics-table--mobile-cards">
              <caption className="visually-hidden">Jobs raised at {site.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Status</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Trade</th>
                  <th scope="col">Raised</th>
                  <th scope="col">Completed</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((job) => (
                  <tr key={job.id}>
                    <td data-label="Job">{job.title}</td>
                    <td data-label="Status">{job.status}</td>
                    <td data-label="Priority">{job.priority}</td>
                    <td data-label="Trade">{job.engineer}</td>
                    <td data-label="Raised">{formatDate(job.requestedAt)}</td>
                    <td data-label="Completed">{formatDate(job.completedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {tab === "Compliance" ? (
        data.compliance.length === 0 ? (
          <Empty>
            No certificates recorded against this site. Upload one from the
            Compliance screen and its expiry appears here.
          </Empty>
        ) : (
          <div className="table-scroll">
            <table className="analytics-table analytics-table--mobile-cards">
              <caption className="visually-hidden">Documents held for {site.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Document</th>
                  <th scope="col">State</th>
                  <th scope="col">Expiry</th>
                </tr>
              </thead>
              <tbody>
                {data.compliance.map((record) => {
                  const state = expiryState(record.expiryDate, record.notRequired);
                  return (
                    <tr key={record.id}>
                      <td data-label="Document">{record.kind}</td>
                      <td data-label="State">
                        <span className="status-chip" style={{ backgroundColor: state.tone }}>
                          {state.label}
                        </span>
                      </td>
                      <td data-label="Expiry">{formatDate(record.expiryDate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {tab === "Assets" ? (
        data.units.length === 0 ? (
          <Empty>No assets recorded here yet. Add one from the Units screen.</Empty>
        ) : (
          <div className="table-scroll">
            <table className="analytics-table analytics-table--mobile-cards">
              <caption className="visually-hidden">Assets at {site.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Asset</th>
                  <th scope="col">Category</th>
                  <th scope="col">Serial</th>
                  <th scope="col">Warranty</th>
                  <th scope="col">Next service</th>
                </tr>
              </thead>
              <tbody>
                {data.units.map((unit) => (
                  <tr key={unit.id}>
                    <td data-label="Asset">{unit.name}</td>
                    <td data-label="Category">{unit.category}</td>
                    <td data-label="Serial">{unit.serialNumber ?? "—"}</td>
                    <td data-label="Warranty">{formatDate(unit.warrantyExpiry)}</td>
                    <td data-label="Next service">{formatDate(unit.nextServiceDueAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {tab === "Documents" ? (
        data.files.length === 0 ? (
          <Empty>No files are attached to this site.</Empty>
        ) : (
          <ul className="file-list">
            {data.files.map((file) => (
              <li key={file.id}>
                <a href={`/api/files/${file.id}`}>{file.originalName}</a>
                <span className="drawer-label">
                  {file.kind} · {fileSize(file.byteSize)} · {formatDate(file.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {tab === "Contacts" ? (
        <div className="panel">
          <Row label="Site manager" value={site.managerName} />
          <Row label="Phone" value={site.managerPhone} />
          <Row label="Email" value={site.managerEmail} />
          <Row label="Landlord" value={site.landlord} />
          <Row label="Managing agent" value={site.managingAgent} />
          <Row label="Out of hours" value={site.outOfHoursContact} />
          <Row label="Access method" value={site.accessMethod} />
          <Row label="Access contact" value={site.accessContact} />
          <Row
            label="Access portal"
            value={site.accessUrl ? <a href={site.accessUrl}>{site.accessUrl}</a> : null}
          />
          <Row label="Access notes" value={site.accessNotes} />
          <Row label="Keys and alarm" value={site.keyAlarmNotes} />
        </div>
      ) : null}

      {tab === "Activity" ? (
        data.activity.length === 0 ? (
          <Empty>Nothing has changed on this site since it was created.</Empty>
        ) : (
          <ul className="activity-list">
            {data.activity.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.action}</strong>
                <span className="drawer-label">
                  {entry.actorEmail ?? "Unknown"} · {formatDate(entry.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
