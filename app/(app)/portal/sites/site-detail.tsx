"use client";

import { useState } from "react";
import { SectionPanel, SectionTabs } from "./section-tabs";
/*
 * W05-09 — the fifth connection. Its own component because it is the only part
 * of this screen with its own fetch and its own writes; see site-contractors.tsx.
 */
import { SiteContractors } from "./site-contractors";
import { useLoader } from "./use-loader";
import {
  api,
  formatDate,
  formatMoney,
  labelFor,
  styleFor,
  type ComplianceRecord,
  type OptionChoice,
  type SiteRecord,
  type UnitRecord,
  scopedUrl,
} from "./site-types";
/*
 * ONE RULE FOR WHAT A DOCUMENT IS CALLED. `documentName` is the Documents
 * register's own — the title somebody set, the stored filename otherwise — and
 * every surface that names a document calls it. Printing `originalName`
 * directly is what let a rename reach the register and stop there.
 */
import { documentName } from "../views/document-register";
import { expiryStatus } from "../../../lib/expiry-status";
import type { ComplianceState } from "../../../lib/types";

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
  /*
   * `/api/sites?id=` selects the whole `attachments` row, so the title has
   * always been in this payload; the type never named it, so the Site
   * documents tab linked a renamed certificate under its upload filename.
   */
  title?: string | null;
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
  /*
   * W05-10 — the same membership as `groupIds`, with the names on it.
   *
   * Both, not one: `groupIds` is what this screen hands the editor and the
   * editor treats a sent list as authoritative, so it has to stay exactly the
   * shape it is. `groups` is what a reader can be shown. A profile that could
   * not name the portfolio a store rolls up into was missing the answer to the
   * question the reporting groups exist to ask.
   */
  groups: Array<{ id: string; name: string; kind: string; colourHex: string }>;
  /** Every earlier spelling of the name, as `site_aliases` recorded it. */
  aliases: string[];
};

/*
 * W05-09 — CONTRACTORS IS THE FIFTH TAB, and it sits beside Assets rather than
 * at the end. The criterion names five things a site connects to — Jobs,
 * Compliance, Documents, Assets, Contractors — and four of them were already
 * here; putting the fifth after Activity would have filed the missing
 * relationship behind the audit trail. "Contacts" above it is the site's OWN
 * people (its manager, its landlord, its out-of-hours number); this is the
 * external network appointed to it, which is a different list with a different
 * owner, so they are two tabs and not one.
 */
const TABS = [
  "Overview",
  "Jobs",
  "Compliance",
  "Assets",
  "Contractors",
  "Documents",
  "Contacts",
  "Activity",
] as const;

/**
 * Namespaces this screen's tab and panel ids so they cannot collide with the
 * editor's — both strips have a "Contacts". See section-tabs.tsx.
 */
const TAB_PREFIX = "site-detail";

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
 * The colour for each of the five register states.
 *
 * These five hexes are the product's existing compliance palette, taken from the
 * Dashboard's compliance donut (`complianceSegments` in portal-app.tsx) so that
 * a document which is amber on the Dashboard is the same amber here. "Not
 * required" has no donut segment — it is excluded from the counts rather than
 * coloured — so it takes the neutral grey this screen already used for a state
 * that is not a finding.
 */
const COMPLIANCE_TONES: Record<ComplianceState, string> = {
  Compliant: "#12b4a8",
  "Expiring soon": "#f0a91f",
  Expired: "#e2445c",
  Missing: "#5c82af",
  "Not required": "#808799",
};

/*
 * WHAT USED TO BE HERE, AND WHY IT IS GONE.
 *
 * A local `expiryState(expiry, notRequired)` that classified certificates with
 * its own ladder:
 *
 *     if (days < 0)   "Expired N days ago"
 *     if (days <= 30) "Expires in N days"
 *     else            "Valid to DD/MM/YYYY"
 *
 * Its docblock said the colouring "uses the same vocabulary the compliance
 * register will use in Stage 5, so the language does not change under the
 * user's feet later". The register then shipped with a DIFFERENT vocabulary —
 * Compliant / Expiring soon / Expired / Missing / Not required — and a
 * DIFFERENT threshold, `EXPIRY_DUE_SOON_DAYS = 60`, and this file was never
 * brought across. So the promise inverted itself: the language did change under
 * the user's feet, and this screen became the one place still speaking the old
 * one.
 *
 * The consequence was not cosmetic. A certificate 45 days from expiry is
 * "Expiring soon" on the Dashboard, on the Compliance Tracker and in the digest,
 * and read "Valid to 15/10/2026" in reassuring green on the page for the
 * individual store — the one screen a manager opens when they are asking about
 * that specific shop.
 *
 * There is no local classifier now. The five-word state arrives already derived
 * from `readSiteComplianceRecords`, which computes it with `complianceStateFor`
 * — the same function the register, the board and the digest use — and
 * `expiryStatus` supplies the sentence for the accessible description, so the
 * one remaining piece of date arithmetic on this screen is also the shared one.
 */

export function SiteDetail({
  sectionKey = null,
  siteId,
  siteTypes,
  statuses,
  onEdit,
  onClose,
}: {
  /** The register this site belongs to — see `scopedUrl`. */
  sectionKey?: string | null;
  siteId: string;
  siteTypes: OptionChoice[];
  statuses: OptionChoice[];
  /**
   * The site AND the groups it is currently in.
   *
   * The second argument is not decoration. `SiteForm` always posts its
   * `groupIds`, and `PATCH /api/sites` treats a sent list as authoritative:
   * `setSiteGroupMembership` deletes every membership row for the site
   * before re-inserting what it was handed. So an editor opened with an
   * empty list and saved does not leave the groups alone — it destroys
   * them, with the boxes drawn unticked as if that had always been true.
   * This screen has already fetched the real membership; handing it over
   * is what stops the editor guessing.
   */
  onEdit: (site: SiteRecord, groupIds: string[]) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const { data, error } = useLoader<DetailPayload>(
    () => api<DetailPayload>(scopedUrl(`/api/sites?id=${encodeURIComponent(siteId)}`, sectionKey)),
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
          {/*
            The site's name is this view's `<h1>`. The detail view is a
            separate return from the register, so the list's `<h1>Sites</h1>`
            is not on the page here — axe reported `page-has-heading-one` on
            every detail run, and at 390px, where the topbar title is gone,
            the screen had no heading of any level to announce what it showed.
          */}
          <h1>{site.name}</h1>
          {/*
            `addressLine2` was missing from this line and from the whole
            screen. It holds the floor, the unit or the mall on a third of the
            register — "Etage 2", "Upper Mall West" — so the profile printed a
            street with the part that tells an engineer where to go removed.
          */}
          <p className="drawer-label">
            {[site.addressLine1, site.addressLine2, site.city, site.postcode]
              .filter(Boolean)
              .join(", ")}
          </p>
        </div>
        <div className="section-header__actions">
          <span className="status-chip" style={styleFor(statuses, site.status)}>
            {labelFor(statuses, site.status)}
          </span>
          <button
            type="button"
            className="secondary-button"
            onClick={() => onEdit(site, data.groupIds)}
          >
            Edit site
          </button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close site">
            ✕
          </button>
        </div>
      </header>

      {/*
        One tab pattern, shared with the editor. The strip used to declare
        `role="tablist"` and then behave like seven separate buttons — no
        `aria-controls`, nothing carrying `role="tabpanel"`, seven Tab stops
        and dead arrow keys. section-tabs.tsx has the measurements.
      */}
      <SectionTabs
        idPrefix={TAB_PREFIX}
        label="Site sections"
        sections={TABS}
        active={tab}
        onChange={setTab}
      />

      {/*
        W05-10 — THE STAT CARDS AND THE DETAIL ROWS ARE TWO BLOCKS, NOT ONE.
        This panel carried `className="site-stat-grid"` itself, so
        `.site-stat-grid > div` (globals.css) restyled EVERY direct child as a
        stat card — including the wide block of labelled rows at the bottom. A
        stat card is `grid-template-columns: 38px 1fr auto`, so the eight
        `.detail-row` children flowed into a three-column grid whose first
        track is 38 pixels wide, and each row then applied its OWN
        `minmax(9rem, 14rem) 1fr` inside it. Measured at every width: the
        labels painted on top of each other — "SERVICE CHARGOPENING HOURS",
        "PARKINGNOTES" — with the value track collapsed to 13px at 1440.
        The grid now wraps only the things that are stat cards, and the rows
        sit in an ordinary panel beside it. No CSS rule had to be weakened for
        it; the markup was simply claiming to be something it was not.
      */}
      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Overview"
        className="site-detail__overview"
        focusable
        active={tab === "Overview"}
      >
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
          {/*
            W05-10 BUG — THIS COUNTED THE WRONG THING.

            "Documents held" rendered `data.compliance.length`, which is the
            number of rows in the COMPLIANCE REGISTER for this site —
            requirements, including every one whose state is Missing or Not
            required. Those are the documents the site does NOT hold. Measured
            on a real site: the card read 265 while the Documents tab below
            listed two files.

            `data.files` is the actual document source and is already on this
            payload: current, unarchived `attachments` rows for this site, the
            same list the Documents tab renders. The compliance figure was
            worth showing — it just was not this — so it keeps a card under a
            label that says what it is.
          */}
          <div className="panel">
            <span className="drawer-label">Documents held</span>
            <strong>{data.files.length}</strong>
          </div>
          <div className="panel">
            <span className="drawer-label">Compliance requirements</span>
            <strong>{data.compliance.length}</strong>
          </div>
          <div className="panel">
            <span className="drawer-label">Spend recorded</span>
            <strong>{formatMoney(Math.round(spend * 100))}</strong>
          </div>
          {/*
            The annual maintenance budget. It is editable on the Sites form,
            exported in the CSV and read by the Dashboard's spend panel, and
            the one screen about this single site did not show it — so a
            manager could see what a store had spent with nothing to compare it
            against. `formatMoney` prints an em dash for null, which is the
            honest rendering of "no budget set" and is not the same as zero.
          */}
          <div className="panel">
            <span className="drawer-label">Annual budget</span>
            <strong>{formatMoney(site.annualBudgetPence)}</strong>
          </div>
          <div className="panel">
            <span className="drawer-label">Site type</span>
            <strong>{labelFor(siteTypes, site.siteTypeValue ?? site.type)}</strong>
          </div>
        </div>
        <div className="panel">
          {/*
            W05-10 — the fields the profile did not have. `region` and
            `country` are how the portfolio is split for every rolled-up
            figure; the reporting groups are how it is split for reporting, and
            they were fetched and rendered nowhere at all; the coordinates were
            reachable from no screen in the product until W05-01 put them on
            the form. A profile is "complete" when the answers a person came
            for are on it.
          */}
          <Row
            label="Reporting groups"
            value={
              data.groups.length
                ? data.groups.map((group) => group.name).join(", ")
                : null
            }
          />
          <Row label="Region" value={site.region} />
          <Row label="Country" value={site.country} />
          <Row label="Address" value={site.addressLine2} />
          <Row
            label="Coordinates"
            value={
              site.latitude !== null && site.longitude !== null
                ? `${site.latitude}, ${site.longitude}`
                : null
            }
          />
          {/*
            Former names, so somebody holding a four-year-old invoice for
            "Cardiff St Davids" can see they are on the right page. The array
            is empty for a site that has never been renamed and the Row prints
            an em dash, which is the truth about that site.
          */}
          <Row label="Also known as" value={data.aliases.join(", ")} />
          <Row label="Lease" value={`${formatDate(site.leaseStart)} to ${formatDate(site.leaseEnd)}`} />
          <Row label="Break clause" value={site.breakClause} />
          <Row label="Rent review" value={site.rentReview} />
          <Row label="Service charge" value={formatMoney(site.serviceChargePence)} />
          <Row label="Opening hours" value={site.openingHours} />
          <Row label="Deliveries" value={site.deliveryRestrictions} />
          <Row label="Parking" value={site.parkingNotes} />
          <Row label="Notes" value={site.notes} />
        </div>
      </SectionPanel>

      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Jobs"
        focusable
        active={tab === "Jobs"}
      >
        {data.jobs.length === 0 ? (
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
        )}
      </SectionPanel>

      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Compliance"
        focusable
        active={tab === "Compliance"}
      >
        {data.compliance.length === 0 ? (
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
                  /*
                   * The chip says the STATE; its title says WHY, in the shared
                   * classifier's own words ("expires 12 March 2026, in 45
                   * days"). Splitting them this way is what lets the visible
                   * label be one of the five words every other screen uses
                   * while the day count — the thing the old local ladder built
                   * its label out of — is still on the page for anyone who
                   * needs it.
                   */
                  const status = expiryStatus(record.expiryDate);
                  const detail = record.notRequired
                    ? "not required at this site"
                    : record.tracksExpiry || record.expiryDate
                      ? status.description
                      : "no expiry date is tracked for this document";
                  return (
                    <tr key={record.id}>
                      <td data-label="Document">{record.kind}</td>
                      <td data-label="State">
                        <span
                          className="status-chip"
                          style={{ backgroundColor: COMPLIANCE_TONES[record.status] ?? "#808799" }}
                          title={`${record.kind}: ${detail}`}
                        >
                          {record.status}
                        </span>
                      </td>
                      <td data-label="Expiry">{formatDate(record.expiryDate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionPanel>

      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Assets"
        focusable
        active={tab === "Assets"}
      >
        {data.units.length === 0 ? (
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
        )}
      </SectionPanel>

      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Contractors"
        focusable
        active={tab === "Contractors"}
      >
        <SiteContractors siteId={site.id} siteName={site.name} />
      </SectionPanel>

      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Documents"
        focusable
        active={tab === "Documents"}
      >
        {data.files.length === 0 ? (
          <Empty>No files are attached to this site.</Empty>
        ) : (
          <ul className="file-list">
            {data.files.map((file) => (
              <li key={file.id}>
                <a href={`/api/files/${file.id}`}>{documentName(file)}</a>
                <span className="drawer-label">
                  {file.kind} · {fileSize(file.byteSize)} · {formatDate(file.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionPanel>

      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Contacts"
        className="panel"
        focusable
        active={tab === "Contacts"}
      >
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
      </SectionPanel>

      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Activity"
        focusable
        active={tab === "Activity"}
      >
        {data.activity.length === 0 ? (
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
        )}
      </SectionPanel>
    </section>
  );
}
