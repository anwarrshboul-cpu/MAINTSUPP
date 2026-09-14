"use client";

/**
 * ONE ASSET, in full.
 *
 * The screen that answers "what exact LED strip does this store use, who
 * supplies it, what replaced the last one, and where are the photographs".
 *
 * ── TABS, NOT ACCORDIONS, AND NOT A MODAL ──────────────────────────────────
 *
 * `SectionTabs` / `SectionPanel` from the Sites screens, which already own the
 * APG tablist — roving tabindex, wrapping arrows, selection following focus —
 * and a panel that stays mounted so every `aria-controls` resolves. Building a
 * second tablist here is exactly the accessibility defect that component's own
 * header was written after.
 *
 * The detail REPLACES the list rather than floating over it, matching
 * `SiteDetail`. An asset record is somewhere you send somebody — the URL
 * carries `?asset=` — and a modal is not a place.
 */

import { useState } from "react";
import { Icon } from "../../../components";
import { RaiseTicketButton } from "../raise-ticket";
import { SectionPanel, SectionTabs } from "../sites/section-tabs";
import { formatDate, formatMoney, labelFor, styleFor } from "../sites/site-types";
import { assetKindLabel, parseSpecs } from "../../../lib/asset-model";
import { AssetFiles } from "./asset-files";
import { AssetEventForm } from "./asset-event-form";
import {
  fileSize,
  isImage,
  type AssetDetailPayload,
  type AssetHistoryRow,
} from "./asset-types";

const TABS = [
  "Overview",
  "Technical",
  "Specifications",
  "Supplier",
  "Replacement",
  "Photos & files",
  "History",
] as const;

const TAB_PREFIX = "asset-detail";

/** One label/value pair. Absent values are OMITTED, never printed as a dash. */
function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="asset-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * A URL somebody typed, as a link that cannot be a weapon.
 *
 * The server already refuses anything but http(s) — see `safeUrl` — so this is
 * the second of two belts. `rel="noreferrer"` because a supplier's site has no
 * business learning which workspace linked to it, and `noopener` because a
 * target of `_blank` otherwise hands the opened page a handle on this one.
 */
function ExternalLink({ href }: { href: string }) {
  if (!/^https?:\/\//i.test(href)) return <>{href}</>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="ops-link">
      {href}
    </a>
  );
}

export function AssetDetail({
  data,
  canEdit,
  embedded = false,
  onEdit,
  onClose,
  onOpenAsset,
  onArchive,
  onChanged,
  onNotify,
}: {
  data: AssetDetailPayload;
  canEdit: boolean;
  /** Drawn inside a site's page: the heading drops to `h2`. See `AssetsManager`. */
  embedded?: boolean;
  onEdit: () => void;
  onClose: () => void;
  onOpenAsset: (assetId: string) => void;
  onArchive: () => void;
  onChanged: () => void;
  onNotify: (message: string) => void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  /*
   * The record's own title is `h1` as a page and `h2` inside a site, so its
   * SUBSECTIONS have to move with it or the outline makes them siblings of the
   * asset rather than parts of it.
   */
  const SubHeading = embedded ? "h3" : "h2";
  const { asset, history, files, children, parent } = data;
  const specs = parseSpecs(asset.specs);

  const supplier =
    (asset.supplierContractorId
      ? data.suppliers.find((entry) => entry.id === asset.supplierContractorId)?.name
      : null) ?? asset.supplier;

  const siteName = data.sites.find((site) => site.id === asset.siteId)?.name ?? asset.siteId;
  const image = files.find((file) => file.id === asset.primaryImageId) ??
    files.find((file) => isImage(file.contentType));

  return (
    <section className="section-stack asset-detail">
      <header className="section-header">
        <div>
          {/*
            An `<h1>` when this IS the page, because the view REPLACES the list
            rather than sitting inside it — while it is open the register's own
            `<h1>Assets</h1>` is not rendered at all, and a document with no
            level-one heading is an axe failure the Sites screens already had
            and fixed. Embedded in a site, the site's name is the `<h1>` and
            this is an `<h2>`.
          */}
          {embedded ? <h2>{asset.name}</h2> : <h1>{asset.name}</h1>}
          <p className="asset-detail__eyebrow">
            {[asset.assetNumber, assetKindLabel(asset.kind), siteName]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="section-header__actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Back to assets
          </button>
          {/*
            AN ASSET THAT HAS FAILED IS THE COMMONEST REASON ANYBODY OPENS THIS
            SCREEN, so raising the job is here rather than two navigations away.

            The context is the whole of the improvement over the register this
            replaced, which passed `{ section: "Assets" }` and nothing else: the
            site, the asset and its model travel onto the ticket, so the person
            picking the job up is not left to work out which of eleven LED
            strips at which of thirty stores is being reported.
          */}
          <RaiseTicketButton
            context={{
              siteId: asset.siteId,
              siteName,
              unitId: asset.id,
              unitName: asset.name,
              section: "Assets",
              note: [asset.assetNumber, asset.manufacturer, asset.model, asset.locationInSite]
                .filter(Boolean)
                .join(" · "),
            }}
            label="Raise a ticket"
            onRaised={(ticket) =>
              onNotify(`${ticket.reference ?? ticket.title} raised for ${ticket.siteName}.`)
            }
            onNotify={onNotify}
          />
          {canEdit ? (
            <>
              <button type="button" className="secondary-button" onClick={onArchive}>
                Move to bin
              </button>
              <button type="button" className="primary-button" onClick={onEdit}>
                Edit asset
              </button>
            </>
          ) : null}
        </div>
      </header>

      <SectionTabs
        idPrefix={TAB_PREFIX}
        label="Asset sections"
        sections={TABS}
        active={tab}
        onChange={setTab}
      />

      {/* ── Overview ─────────────────────────────────────────────────────── */}
      <SectionPanel idPrefix={TAB_PREFIX} section="Overview" active={tab === "Overview"} focusable>
        {/* The two-column layout only applies when there is a photograph to
            put in the first column — see the note in assets.css. */}
        <div className={`asset-overview${image ? " asset-overview--with-image" : ""}`}>
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="asset-hero" src={image.inlineUrl} alt={image.title ?? asset.name} />
          ) : null}
          <dl className="asset-facts">
            <Fact
              label="Status"
              value={
                <span className="status-chip" style={styleFor(data.statuses, asset.status)}>
                  {labelFor(data.statuses, asset.status)}
                </span>
              }
            />
            <Fact label="Category" value={labelFor(data.categories, asset.category)} />
            <Fact label="Site" value={siteName} />
            <Fact label="Location at the site" value={asset.locationInSite} />
            <Fact label="Quantity" value={asset.quantity} />
            <Fact label="Asset tag" value={asset.assetTag} />
            <Fact label="Installed" value={formatDate(asset.installedAt)} />
            <Fact label="Warranty expires" value={formatDate(asset.warrantyExpiry)} />
            <Fact label="Last serviced" value={formatDate(asset.lastServicedAt)} />
            <Fact label="Next service due" value={formatDate(asset.nextServiceDueAt)} />
            <Fact
              label="Part of"
              value={
                parent ? (
                  <button
                    type="button"
                    className="ops-link"
                    onClick={() => onOpenAsset(parent.id)}
                  >
                    {parent.assetNumber ? `${parent.assetNumber} — ` : ""}
                    {parent.name}
                  </button>
                ) : null
              }
            />
            <Fact label="Notes" value={asset.notes} />
          </dl>

          {children.length ? (
            <div className="asset-children">
              <SubHeading className="ops-section-title">Parts of this asset</SubHeading>
              <ul className="asset-children__list">
                {children.map((child) => (
                  <li key={child.id}>
                    <button
                      type="button"
                      className="ops-link"
                      onClick={() => onOpenAsset(child.id)}
                    >
                      {child.assetNumber ? `${child.assetNumber} — ` : ""}
                      {child.name}
                    </button>
                    <span className="asset-subline">
                      {[assetKindLabel(child.kind ?? ""), child.status]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </SectionPanel>

      {/* ── Technical ────────────────────────────────────────────────────── */}
      <SectionPanel idPrefix={TAB_PREFIX} section="Technical" active={tab === "Technical"} focusable>
        <dl className="asset-facts">
          <Fact label="Manufacturer" value={asset.manufacturer} />
          <Fact label="Model" value={asset.model} />
          <Fact label="Part number" value={asset.partNumber} />
          <Fact label="Serial number" value={asset.serialNumber} />
          <Fact label="Specification" value={asset.specification} />
          <Fact label="Colour" value={asset.colour} />
          <Fact label="Colour code" value={asset.colourCode} />
          <Fact label="Paint / finish reference" value={asset.paintReference} />
          <Fact label="Purchase price" value={formatMoney(asset.purchasePricePence)} />
        </dl>
        {!asset.manufacturer &&
        !asset.model &&
        !asset.partNumber &&
        !asset.serialNumber &&
        !asset.specification &&
        !asset.paintReference ? (
          <p className="ops-empty">
            No technical detail recorded yet. Edit the asset to add the model, part number or
            paint reference.
          </p>
        ) : null}
      </SectionPanel>

      {/* ── Specifications ───────────────────────────────────────────────── */}
      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Specifications"
        active={tab === "Specifications"}
        focusable
      >
        {specs.length ? (
          <div className="table-scroll">
            <table className="analytics-table analytics-table--mobile-cards">
              <caption className="visually-hidden">
                The measured specifications recorded for this asset
              </caption>
              <thead>
                <tr>
                  <th scope="col">Specification</th>
                  <th scope="col">Value</th>
                  <th scope="col">Unit</th>
                </tr>
              </thead>
              <tbody>
                {specs.map((spec) => (
                  <tr key={spec.key}>
                    <td data-label="Specification">{spec.key}</td>
                    <td data-label="Value">{spec.value}</td>
                    <td data-label="Unit">{spec.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="ops-empty">
            No measured specifications yet — voltage, wattage, colour temperature, IP rating,
            opening angle and so on. Edit the asset to add them.
          </p>
        )}
      </SectionPanel>

      {/* ── Supplier ─────────────────────────────────────────────────────── */}
      <SectionPanel idPrefix={TAB_PREFIX} section="Supplier" active={tab === "Supplier"} focusable>
        <dl className="asset-facts">
          <Fact label="Supplier" value={supplier} />
          <Fact label="Supplier reference" value={asset.supplierReference} />
          <Fact
            label="Email"
            value={
              asset.supplierEmail ? (
                <a className="ops-link" href={`mailto:${asset.supplierEmail}`}>
                  {asset.supplierEmail}
                </a>
              ) : null
            }
          />
          <Fact
            label="Phone"
            value={
              asset.supplierPhone ? (
                <a className="ops-link" href={`tel:${asset.supplierPhone}`}>
                  {asset.supplierPhone}
                </a>
              ) : null
            }
          />
          <Fact
            label="Product page"
            value={asset.supplierUrl ? <ExternalLink href={asset.supplierUrl} /> : null}
          />
        </dl>
        {!supplier && !asset.supplierUrl && !asset.supplierEmail ? (
          <p className="ops-empty">
            No supplier recorded. Link a contractor who supplies this part, or type the supplier
            details directly.
          </p>
        ) : null}
      </SectionPanel>

      {/* ── Replacement ──────────────────────────────────────────────────── */}
      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Replacement"
        active={tab === "Replacement"}
        focusable
      >
        <dl className="asset-facts">
          <Fact label="Replacement part number" value={asset.replacementPartNumber} />
          <Fact label="Replacement model" value={asset.replacementModel} />
          <Fact label="Replacement specification" value={asset.replacementSpecification} />
          <Fact label="Replacement supplier" value={asset.replacementSupplier} />
          <Fact label="Replacement cost" value={formatMoney(asset.replacementCostPence)} />
          <Fact label="Last replaced" value={formatDate(asset.lastReplacedAt)} />
          <Fact
            label="Replace every"
            value={
              asset.replacementIntervalMonths
                ? `${asset.replacementIntervalMonths} months`
                : null
            }
          />
          <Fact label="Notes" value={asset.replacementNotes} />
        </dl>
        {!asset.replacementPartNumber && !asset.replacementModel && !asset.replacementNotes ? (
          <p className="ops-empty">
            Nothing recorded about what to order when this fails. That is the question this
            section exists to answer — edit the asset to fill it in.
          </p>
        ) : null}
      </SectionPanel>

      {/* ── Photos and files ─────────────────────────────────────────────── */}
      <SectionPanel
        idPrefix={TAB_PREFIX}
        section="Photos & files"
        active={tab === "Photos & files"}
        focusable
      >
        <AssetFiles
          assetId={asset.id}
          siteId={asset.siteId}
          files={files}
          primaryImageId={asset.primaryImageId}
          canEdit={canEdit}
          onChanged={onChanged}
          onNotify={onNotify}
        />
      </SectionPanel>

      {/* ── History ──────────────────────────────────────────────────────── */}
      <SectionPanel idPrefix={TAB_PREFIX} section="History" active={tab === "History"} focusable>
        {canEdit ? (
          <AssetEventForm
            assetId={asset.id}
            events={data.events}
            suppliers={data.suppliers}
            headingLevel={embedded ? "h3" : "h2"}
            onSaved={(message) => {
              onNotify(message);
              onChanged();
            }}
          />
        ) : null}
        {history.length ? (
          <ol className="asset-history">
            {history.map((entry) => (
              <HistoryEntry key={entry.id} entry={entry} />
            ))}
          </ol>
        ) : (
          <p className="ops-empty">
            Nothing recorded yet. When something is replaced, record it here so the part that
            came out is not lost when the model above is overwritten.
          </p>
        )}
      </SectionPanel>
    </section>
  );
}

function HistoryEntry({ entry }: { entry: AssetHistoryRow }) {
  return (
    <li className="asset-history__item">
      <div className="asset-history__head">
        <strong>{entry.eventType}</strong>
        <span className="asset-subline">{formatDate(entry.performedAt)}</span>
      </div>
      <dl className="asset-facts asset-facts--compact">
        <Fact label="Was" value={entry.previousDetail} />
        <Fact label="Now" value={entry.replacementDetail} />
        <Fact label="By" value={entry.contractorName} />
        <Fact label="Outcome" value={entry.outcome} />
        <Fact label="Cost" value={formatMoney(entry.costPence)} />
        <Fact label="Notes" value={entry.notes} />
        <Fact label="Recorded by" value={entry.recordedByEmail} />
      </dl>
    </li>
  );
}

/** Re-exported so the files panel can size what it lists without a second copy. */
export { fileSize };

/** Kept beside the panel that draws it, for the same reason. */
export function FileIcon({ contentType }: { contentType: string }) {
  return <Icon name={isImage(contentType) ? "image" : "document"} size={15} />;
}
