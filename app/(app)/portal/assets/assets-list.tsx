"use client";

/**
 * THE ASSET REGISTER — every store's equipment, in one list.
 *
 * ── WHICH DESIGN LANGUAGE, AND WHY IT IS A BLEND ───────────────────────────
 *
 * The page chrome is the `ops/` rebuild: `.ops-page`, the eyebrow-over-`h1`
 * header, `OpsCard`, `OpsFilterBar`, `.ops-tile`, and every filter in the URL
 * rather than in `localStorage`. That is the current language and the one the
 * Sites, Contractors and Compliance pages were rebuilt into.
 *
 * The REGISTER ITSELF is `analytics-table analytics-table--mobile-cards`, which
 * is the older product-wide table, and that is a deliberate mix rather than an
 * accident. The ops pages' own convention is a desktop-only `.ops-table-wrap`
 * with a line of text on a phone saying the table needs a wider screen, and
 * their lists carry three or four columns so `.ops-row` can hold the whole row.
 * An asset register has ten columns a maintenance team needs on a phone at the
 * store — model, part number, supplier, replacement part — and "switch to a
 * wider screen" is not an answer when the reader is standing in front of the
 * broken cabinet. `--mobile-cards` reflows each row into a labelled card at
 * 767px from CSS alone, which is why every `<td>` below carries `data-label`.
 * `compliance-page.tsx` already draws an `analytics-table` inside an `OpsCard`,
 * so the combination is established; only the mobile half is new here.
 *
 * ── WHERE THE FIGURES COME FROM ────────────────────────────────────────────
 *
 * The four tiles are counted by the SERVER over the rows this caller may see,
 * and handed down in `totals`. They are not recounted here and not counted by a
 * second query there: a member confined to three stores reading estate-wide
 * totals off the top of a page is aggregate leakage, and it is a mistake this
 * product has already made once on the dashboard.
 */

import { useCallback, useMemo } from "react";
import { Icon } from "../../../components";
import opsCss from "../ops/ops.css?url";
import assetsCss from "./assets.css?url";
import { EmptyState, ErrorState, OpsCard, SkeletonRow, plural } from "../ops/ops-primitives";
import { OpsFilterBar, type FilterGroup } from "../ops/ops-filter-bar";
import { useQueryState } from "../ops/ops-url-state";
import {
  assetHaystack,
  assetKindLabel,
  NEEDS_REPLACEMENT_STATUS,
  parseSpecs,
} from "../../../lib/asset-model";
import { formatDate, formatMoney, labelFor, styleFor } from "../sites/site-types";
import type { AssetListPayload, AssetRow } from "./asset-types";

/** Every key this screen owns in the address bar, so "Clear all" is exact. */
const FILTER_KEYS = ["q", "site", "kind", "category", "status", "sort"] as const;

type SortKey = "name" | "site" | "category" | "status" | "updated" | "model";

const SORTS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "name", label: "Asset name" },
  { value: "site", label: "Site" },
  { value: "category", label: "Category" },
  { value: "status", label: "Status" },
  { value: "model", label: "Model / part number" },
  { value: "updated", label: "Recently updated" },
];

export function AssetsList({
  data,
  error,
  loading,
  onRetry,
  onOpenAsset,
  onAddAsset,
  /**
   * The site this screen is confined to, or null for the whole portfolio.
   *
   * Set when the register is drawn inside one site's own Assets tab. It is a
   * PRESENTATION fact only — the server has already narrowed the rows — and it
   * is what hides the Site column and the Site filter, because a column whose
   * every cell says "Kingsway Central" is a column carrying no information.
   */
  fixedSiteId = null,
}: {
  data: AssetListPayload | null;
  error: string;
  loading: boolean;
  onRetry: () => void;
  onOpenAsset: (assetId: string) => void;
  onAddAsset: () => void;
  fixedSiteId?: string | null;
}) {
  /*
   * `search` is the query string itself. `useQueryState` publishes it beside
   * the parsed params precisely so a memo can depend on something stable: a
   * URLSearchParams instance is new on every render and useless as a
   * dependency.
   */
  const { params, setParams, search } = useQueryState();

  const query = (params.get("q") ?? "").trim().toLowerCase();
  const sort = (params.get("sort") ?? "name") as SortKey;

  /*
   * THE FOUR MULTI-SELECT FILTERS, PARSED ONCE.
   *
   * `params.getAll` builds a NEW array on every render, so each of these was a
   * fresh dependency for the three `useMemo`s below — the row filter, the
   * option counts and the chip list all recomputed on every render whether or
   * not a filter had moved. Parsed from `search` INSIDE the memo rather than
   * from `params` outside it, so the dependency is one string and the hook has
   * nothing unstable to close over.
   *
   * ── `?site=` IS NOT THIS SCREEN'S FILTER WHEN THE SCREEN IS INSIDE A SITE ──
   *
   * The Sites screen addresses an open site profile with `?site=<id>` — that is
   * what makes a site profile linkable — and this register reads the same key
   * as its own portfolio filter. Embedded in that profile's Assets tab the two
   * meanings collided: the list drew a removable chip reading "Site · Aldgate"
   * whose × cleared the parameter, which closed the site profile and threw the
   * reader back to the register they came from. Measured in the browser.
   *
   * So when the screen is confined to one site the parameter is not read at
   * all. The confinement is the prop, the server has already narrowed the rows,
   * and a filter that duplicates it can only ever be wrong.
   */
  const { chosenSites, chosenKinds, chosenCategories, chosenStatuses } = useMemo(() => {
    const current = new URLSearchParams(search);
    return {
      chosenSites: fixedSiteId ? [] : current.getAll("site"),
      chosenKinds: current.getAll("kind"),
      chosenCategories: current.getAll("category"),
      chosenStatuses: current.getAll("status"),
    };
  }, [search, fixedSiteId]);

  const setValue = useCallback(
    (key: string, value: string, fallback: string) => {
      const next = new URLSearchParams(window.location.search);
      if (!value || value === fallback) next.delete(key);
      else next.set(key, value);
      setParams(next);
    },
    [setParams],
  );

  const toggleValue = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(window.location.search);
      const current = next.getAll(key);
      next.delete(key);
      for (const entry of current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value]) {
        next.append(key, entry);
      }
      setParams(next);
    },
    [setParams],
  );

  const clearAll = useCallback(() => {
    const next = new URLSearchParams(window.location.search);
    for (const key of FILTER_KEYS) {
      /*
       * "Clear all" clears this screen's filters. Embedded in a site profile,
       * `site` is not one of them — it is the Sites screen's address for the
       * profile this register is sitting inside, and deleting it would close
       * the page rather than widen the list. Same collision as the chip above.
       */
      if (key === "site" && fixedSiteId) continue;
      next.delete(key);
    }
    setParams(next);
  }, [setParams, fixedSiteId]);

  const siteName = useCallback(
    (id: string) => data?.sites.find((site) => site.id === id)?.name ?? "",
    [data],
  );

  const supplierName = useCallback(
    (row: AssetRow) =>
      (row.supplierContractorId
        ? data?.suppliers.find((entry) => entry.id === row.supplierContractorId)?.name
        : null) ??
      row.supplier ??
      "",
    [data],
  );

  const visible = useMemo(() => {
    const rows = data?.assets ?? [];
    const filtered = rows.filter((row) => {
      if (chosenSites.length && !chosenSites.includes(row.siteId)) return false;
      if (chosenKinds.length && !chosenKinds.includes(row.kind)) return false;
      if (chosenCategories.length && !chosenCategories.includes(row.category)) return false;
      if (chosenStatuses.length && !chosenStatuses.includes(row.status)) return false;
      if (!query) return true;
      /*
       * The haystack is built in `asset-model.ts` and reaches into the
       * specification JSON, so "3000K" finds the strip whose colour temperature
       * is recorded as a typed specification rather than as prose. Doing this
       * in SQL would mean a LIKE across fourteen columns plus a JSON extraction
       * the two dialects spell differently, on every keystroke.
       */
      return assetHaystack({ ...row, siteName: siteName(row.siteId) }).includes(query);
    });

    const collator = new Intl.Collator("en-GB", { numeric: true, sensitivity: "base" });
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case "site":
          return collator.compare(siteName(a.siteId), siteName(b.siteId)) ||
            collator.compare(a.name, b.name);
        case "category":
          return collator.compare(a.category, b.category) || collator.compare(a.name, b.name);
        case "status":
          return collator.compare(a.status, b.status) || collator.compare(a.name, b.name);
        case "model":
          return (
            collator.compare(a.model ?? "", b.model ?? "") ||
            collator.compare(a.partNumber ?? "", b.partNumber ?? "") ||
            collator.compare(a.name, b.name)
          );
        case "updated":
          /* Newest first — "recently updated" means the top of the list is the
             thing somebody touched this morning. */
          return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
        default:
          return collator.compare(a.name, b.name);
      }
    });
  }, [data, chosenSites, chosenKinds, chosenCategories, chosenStatuses, query, sort, siteName]);

  const groups = useMemo<FilterGroup[]>(() => {
    const rows = data?.assets ?? [];
    const count = (predicate: (row: AssetRow) => boolean) => rows.filter(predicate).length;
    const list: FilterGroup[] = [];
    if (!fixedSiteId) {
      list.push({
        key: "site",
        label: "Site",
        searchable: true,
        options: (data?.sites ?? [])
          .map((site) => ({
            value: site.id,
            label: site.name,
            count: count((row) => row.siteId === site.id),
          }))
          .filter((option) => option.count > 0),
      });
    }
    list.push({
      key: "kind",
      label: "Kind",
      options: (data?.kinds ?? []).map((kind) => ({
        value: kind.value,
        label: kind.label,
        count: count((row) => row.kind === kind.value),
      })),
    });
    list.push({
      key: "category",
      label: "Category",
      searchable: true,
      options: (data?.categories ?? [])
        .map((option) => ({
          value: option.value,
          label: option.label,
          count: count((row) => row.category === option.value),
        }))
        .filter((option) => option.count > 0),
    });
    list.push({
      key: "status",
      label: "Status",
      options: (data?.statuses ?? [])
        .map((option) => ({
          value: option.value,
          label: option.label,
          count: count((row) => row.status === option.value),
        }))
        .filter((option) => option.count > 0),
    });
    return list;
  }, [data, fixedSiteId]);

  const chips = useMemo(() => {
    const entries: Array<{ key: string; label: string; value: string; onRemove: () => void }> = [];
    if (query) {
      entries.push({
        key: "q",
        label: "Search",
        value: params.get("q") ?? "",
        onRemove: () => setValue("q", "", ""),
      });
    }
    for (const id of chosenSites) {
      entries.push({
        key: "site",
        label: "Site",
        value: siteName(id) || id,
        onRemove: () => toggleValue("site", id),
      });
    }
    for (const kind of chosenKinds) {
      entries.push({
        key: "kind",
        label: "Kind",
        value: assetKindLabel(kind),
        onRemove: () => toggleValue("kind", kind),
      });
    }
    for (const category of chosenCategories) {
      entries.push({
        key: "category",
        label: "Category",
        value: labelFor(data?.categories ?? [], category),
        onRemove: () => toggleValue("category", category),
      });
    }
    for (const status of chosenStatuses) {
      entries.push({
        key: "status",
        label: "Status",
        value: labelFor(data?.statuses ?? [], status),
        onRemove: () => toggleValue("status", status),
      });
    }
    return entries;
  }, [
    query, params, chosenSites, chosenKinds, chosenCategories, chosenStatuses,
    data, siteName, setValue, toggleValue,
  ]);

  const totals = data?.totals ?? {
    all: 0,
    equipment: 0,
    replacementParts: 0,
    needsReplacement: 0,
  };

  /*
   * The export carries the filters the reader can see, so the file matches the
   * screen — EVERY chosen value, repeated, not just the first.
   *
   * This sent a parameter only when exactly one value was selected, so choosing
   * two kinds silently exported all four. A filter bar whose export ignores
   * half of it is worse than one with no export.
   *
   * The search box and the sort are deliberately NOT sent: both are applied in
   * the browser over rows the server already returned, and a route that
   * pretended to honour them would quietly produce a different set.
   */
  const exportHref = useMemo(() => {
    const search = new URLSearchParams();
    if (fixedSiteId) search.set("siteId", fixedSiteId);
    else for (const site of chosenSites) search.append("siteId", site);
    for (const kind of chosenKinds) search.append("kind", kind);
    for (const category of chosenCategories) search.append("category", category);
    for (const status of chosenStatuses) search.append("status", status);
    const query = search.toString();
    return `/api/assets/csv${query ? `?${query}` : ""}`;
  }, [fixedSiteId, chosenSites, chosenKinds, chosenCategories, chosenStatuses]);

  return (
    <div className="ops-page">
      <link rel="stylesheet" href={opsCss} precedence="default" />
      <link rel="stylesheet" href={assetsCss} precedence="default" />

      {!fixedSiteId ? (
        <header className="ops-page__head">
          <div>
            <span className="ops-page__eyebrow">Store equipment &amp; replacement parts</span>
            <h1>Assets</h1>
          </div>
          <div className="ops-actions">
            <a className="secondary-button" href={exportHref} download>
              <Icon name="download" size={15} /> Export CSV
            </a>
            <button type="button" className="primary-button" onClick={onAddAsset}>
              Add asset
            </button>
          </div>
        </header>
      ) : null}

      <OpsCard
        title="The register"
        subtitle={`${plural(totals.all, "asset")} recorded`}
        action={
          fixedSiteId ? (
            <div className="ops-actions ops-actions--end">
              <a className="secondary-button" href={exportHref} download>
                Export CSV
              </a>
              <button type="button" className="primary-button" onClick={onAddAsset}>
                Add asset
              </button>
            </div>
          ) : undefined
        }
      >
        <div className="ops-tiles">
          <button
            type="button"
            className="ops-tile"
            onClick={clearAll}
            aria-label={`All assets, ${totals.all}`}
          >
            <span className="ops-tile__value">{totals.all}</span>
            <span className="ops-tile__label">All assets</span>
          </button>
          <button
            type="button"
            className="ops-tile"
            onClick={() => toggleValue("kind", "equipment")}
            aria-pressed={chosenKinds.includes("equipment")}
          >
            <span className="ops-tile__value">{totals.equipment}</span>
            <span className="ops-tile__label">Equipment</span>
          </button>
          <button
            type="button"
            className="ops-tile"
            onClick={() => toggleValue("kind", "replacement_part")}
            aria-pressed={chosenKinds.includes("replacement_part")}
          >
            <span className="ops-tile__value">{totals.replacementParts}</span>
            <span className="ops-tile__label">Replacement parts</span>
          </button>
          <button
            type="button"
            className="ops-tile"
            /* The same constant the server counts the tile's figure with, so
               the number and the list it opens cannot disagree. */
            onClick={() => toggleValue("status", NEEDS_REPLACEMENT_STATUS)}
            aria-pressed={chosenStatuses.includes(NEEDS_REPLACEMENT_STATUS)}
          >
            <span className="ops-tile__value">{totals.needsReplacement}</span>
            <span className="ops-tile__label">Needs replacement</span>
          </button>
        </div>
        <p className="ops-card__note">
          Every tile is a filter. &ldquo;Needs replacement&rdquo; is the status to set when
          something still works but is on borrowed time.
        </p>
      </OpsCard>

      <OpsFilterBar
        periodControl={
          <>
            <label className="ops-field" style={{ flex: "1 1 180px", minWidth: 0 }}>
              <span className="visually-hidden">Search assets</span>
              <input
                type="search"
                placeholder="Name, model, part number, paint reference…"
                /* `defaultValue`, so writing the URL does not fight the caret. */
                defaultValue={params.get("q") ?? ""}
                onChange={(event) => setValue("q", event.target.value.trim(), "")}
              />
            </label>
            <label className="ops-field">
              <span className="visually-hidden">Sort assets by</span>
              <select value={sort} onChange={(event) => setValue("sort", event.target.value, "name")}>
                {SORTS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        }
        groups={groups}
        onClearAll={clearAll}
        activeChips={chips}
      />

      <OpsCard title="Assets" subtitle={`${plural(visible.length, "asset")} shown`}>
        {error ? (
          <ErrorState what={error} onRetry={onRetry} />
        ) : loading ? (
          <SkeletonRow lines={6} height={220} />
        ) : visible.length === 0 ? (
          (data?.assets.length ?? 0) === 0 ? (
            <EmptyState>
              No assets added for this site yet.{" "}
              <button type="button" className="ops-link" onClick={onAddAsset}>
                Add the first one
              </button>
            </EmptyState>
          ) : (
            <>
              <EmptyState>No assets match these filters.</EmptyState>
              <button type="button" className="ops-link" onClick={clearAll}>
                Clear all
              </button>
            </>
          )
        ) : (
          <div className="table-scroll">
            <table className="analytics-table analytics-table--mobile-cards asset-table">
              <caption className="visually-hidden">
                The asset register. Each row opens that asset&rsquo;s record.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Image</th>
                  <th scope="col">Asset</th>
                  {fixedSiteId ? null : <th scope="col">Site</th>}
                  <th scope="col">Category</th>
                  <th scope="col">Model / specification</th>
                  <th scope="col">Part number</th>
                  <th scope="col">Supplier</th>
                  <th scope="col">Status</th>
                  <th scope="col">Replacement</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const specs = parseSpecs(row.specs);
                  const replacement =
                    row.replacementPartNumber ??
                    row.replacementModel ??
                    (row.replacementCostPence !== null
                      ? formatMoney(row.replacementCostPence)
                      : null);
                  return (
                    <tr key={row.id}>
                      <td data-label="Image">
                        {row.primaryImageId ? (
                          /* The thumbnail derivative, not the original — the
                             register would otherwise pull a few hundred
                             full-size photographs to draw 48px squares. */
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            className="asset-thumb"
                            src={`/api/files/${row.primaryImageId}?thumb=1`}
                            alt=""
                            width={40}
                            height={40}
                            loading="lazy"
                          />
                        ) : (
                          <span className="asset-thumb asset-thumb--empty" aria-hidden="true">
                            <Icon name="building" size={16} />
                          </span>
                        )}
                      </td>
                      <td data-label="Asset">
                        <button
                          type="button"
                          className="table-text-action"
                          onClick={() => onOpenAsset(row.id)}
                        >
                          {row.name}
                        </button>
                        <span className="asset-subline">
                          {[row.assetNumber, assetKindLabel(row.kind), row.locationInSite]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </td>
                      {fixedSiteId ? null : <td data-label="Site">{siteName(row.siteId)}</td>}
                      <td data-label="Category">
                        {labelFor(data?.categories ?? [], row.category)}
                      </td>
                      <td data-label="Model / specification">
                        {[row.manufacturer, row.model].filter(Boolean).join(" ")}
                        {specs.length ? (
                          <span className="asset-subline">
                            {specs
                              .slice(0, 3)
                              .map((spec) => `${spec.key} ${spec.value}${spec.unit}`)
                              .join(" · ")}
                          </span>
                        ) : null}
                      </td>
                      <td data-label="Part number">{row.partNumber ?? ""}</td>
                      <td data-label="Supplier">{supplierName(row)}</td>
                      <td data-label="Status">
                        {/*
                          The chip carries the configured colour AND the word.
                          Colour is never the only carrier of a status in this
                          product — see the contrast suite.
                        */}
                        <span
                          className="status-chip"
                          style={styleFor(data?.statuses ?? [], row.status)}
                        >
                          {labelFor(data?.statuses ?? [], row.status)}
                        </span>
                      </td>
                      <td data-label="Replacement">{replacement ?? ""}</td>
                      <td data-label="Updated">{formatDate(row.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </OpsCard>
    </div>
  );
}
