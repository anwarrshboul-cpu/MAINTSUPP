"use client";

import { useMemo, useRef, useState } from "react";
import { RaiseTicketButton } from "../raise-ticket";
import { useLoader } from "./use-loader";
import { SiteDetail } from "./site-detail";
import { SiteForm } from "./site-form";
import {
  api,
  labelFor,
  styleFor,
  type OptionChoice,
  type SiteGroupRecord,
  type SiteRecord,
} from "./site-types";

type ListPayload = {
  sites: SiteRecord[];
  groups: SiteGroupRecord[];
  siteTypes: OptionChoice[];
  statuses: OptionChoice[];
};

type ImportResult = {
  dryRun: boolean;
  created: number;
  updated: number;
  skipped: Array<{ row: number; name: string; reason: string }>;
  cleaned: Array<{ row: number; name: string; field: string; from: string; to: string }>;
};

type Mode =
  | { kind: "list" }
  | { kind: "detail"; siteId: string }
  | { kind: "form"; site: SiteRecord | null; groupIds: string[] };

export function SitesManager({ onNotify }: { onNotify: (message: string) => void }) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [importing, setImporting] = useState<ImportResult | null>(null);
  const [pendingCsv, setPendingCsv] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const { data, error, setError, reload } = useLoader<ListPayload & { accessMethods: OptionChoice[] }>(
    async () => {
      const [list, access] = await Promise.all([
        api<ListPayload>("/api/sites"),
        api<{ values: OptionChoice[] }>("/api/options?key=access_method").catch(() => ({
          values: [] as OptionChoice[],
        })),
      ]);
      return { ...list, accessMethods: access.values };
    },
    "Sites could not be loaded.",
  );
  const accessMethods = data?.accessMethods ?? [];

  const visible = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    return data.sites.filter((site) => {
      if (statusFilter && site.status !== statusFilter) return false;
      if (groupFilter) {
        const group = data.groups.find((entry) => entry.id === groupFilter);
        if (!group?.siteIds.includes(site.id)) return false;
      }
      if (!term) return true;
      return [site.name, site.code, site.city, site.postcode, site.mondayMaintenanceName, site.mondayComplianceName]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(term));
    });
  }, [data, search, statusFilter, groupFilter]);

  async function archive(site: SiteRecord) {
    if (!window.confirm(`Close ${site.name}? Its jobs and certificates are kept.`)) return;
    try {
      await api("/api/sites", { method: "DELETE", body: { id: site.id } });
      onNotify(`${site.name} closed.`);
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The site could not be closed.");
    }
  }

  async function runImport(csv: string, dryRun: boolean) {
    try {
      const result = await api<ImportResult>("/api/sites/csv", {
        method: "POST",
        body: { csv, dryRun },
      });
      setImporting(result);
      if (!dryRun) {
        setPendingCsv("");
        onNotify(`${result.created} sites added, ${result.updated} updated.`);
        reload();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The file could not be read.");
    }
  }

  if (mode.kind === "detail") {
    return (
      <SiteDetail
        siteId={mode.siteId}
        siteTypes={data?.siteTypes ?? []}
        statuses={data?.statuses ?? []}
        onEdit={(site) => setMode({ kind: "form", site, groupIds: [] })}
        onClose={() => setMode({ kind: "list" })}
      />
    );
  }

  if (mode.kind === "form") {
    return (
      <section className="section-stack">
        <header className="section-header">
          <h2>{mode.site ? `Edit ${mode.site.name}` : "Add a site"}</h2>
        </header>
        <SiteForm
          site={mode.site}
          siteTypes={data?.siteTypes ?? []}
          statuses={data?.statuses ?? []}
          accessMethods={accessMethods}
          groups={data?.groups ?? []}
          memberGroupIds={mode.groupIds}
          onCancel={() => setMode({ kind: "list" })}
          onSaved={async (message) => {
            onNotify(message);
            setMode({ kind: "list" });
            reload();
          }}
        />
      </section>
    );
  }

  return (
    <section className="section-stack">
      <header className="section-header">
        <div>
          {/*
            An `<h1>`, like every other register in this shell. It was an `<h2>`
            and there was no `<h1>` anywhere on the page at any width, so with
            the topbar title gone below 768px this screen would have had no
            name at all. `.section-header h1` is the styled selector the other
            registers use, so this reads as they do rather than as a heading
            somebody made bigger.
          */}
          <h1>Sites</h1>
          <p className="drawer-label">
            One register shared by jobs, compliance and assets. There is no upper limit.
          </p>
        </div>
        <div className="section-header__actions">
          <a className="secondary-button" href="/api/sites/csv" download>
            Export CSV
          </a>
          <button
            type="button"
            className="secondary-button"
            onClick={() => fileInput.current?.click()}
          >
            Import CSV
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => setMode({ kind: "form", site: null, groupIds: [] })}
          >
            Add site
          </button>
        </div>
      </header>

      <input
        ref={fileInput}
        type="file"
        accept=".csv,text/csv"
        className="visually-hidden"
        aria-label="Choose a CSV of sites"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          const csv = await file.text();
          setPendingCsv(csv);
          await runImport(csv, true);
          event.target.value = "";
        }}
      />

      <div className="workspace-toolbar">
        <div className="search-field">
          <label htmlFor="site-search" className="visually-hidden">
            Search sites
          </label>
          <input
            id="site-search"
            type="search"
            placeholder="Search name, code, postcode or monday name"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <label htmlFor="site-status-filter" className="visually-hidden">
          Filter by status
        </label>
        <select
          id="site-status-filter"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        >
          <option value="">All statuses</option>
          {data?.statuses.map((status) => (
            <option key={status.id} value={status.value}>
              {status.label}
            </option>
          ))}
        </select>
        <label htmlFor="site-group-filter" className="visually-hidden">
          Filter by group
        </label>
        <select
          id="site-group-filter"
          value={groupFilter}
          onChange={(event) => setGroupFilter(event.target.value)}
        >
          <option value="">All groups</option>
          {data?.groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {importing ? (
        <div className="panel" role="status">
          <h3>{importing.dryRun ? "Preview of this file" : "Import complete"}</h3>
          <p>
            {importing.created} to add, {importing.updated} to update,{" "}
            {importing.skipped.length} skipped.
          </p>
          {importing.cleaned.length ? (
            <>
              <h4>Addresses tidied</h4>
              <ul>
                {importing.cleaned.map((entry) => (
                  <li key={`${entry.row}-${entry.field}`}>
                    Row {entry.row}, {entry.name}: removed stray quotation marks.
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {importing.skipped.length ? (
            <>
              <h4>Rows not imported</h4>
              <ul>
                {importing.skipped.map((entry) => (
                  <li key={entry.row}>
                    Row {entry.row}, {entry.name}: {entry.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <div className="section-header__actions">
            {importing.dryRun ? (
              <button
                type="button"
                className="primary-button"
                onClick={() => runImport(pendingCsv, false)}
              >
                Apply this import
              </button>
            ) : null}
            <button type="button" className="secondary-button" onClick={() => setImporting(null)}>
              Close
            </button>
          </div>
        </div>
      ) : null}

      {!data ? (
        <p className="analytics-empty">Loading sites…</p>
      ) : visible.length === 0 ? (
        <p className="analytics-empty">
          {data.sites.length === 0
            ? "No sites yet. Add your first one, or import a CSV."
            : "No sites match these filters."}
        </p>
      ) : (
        <div className="table-scroll">
          <table className="analytics-table analytics-table--mobile-cards sites-table">
            <caption className="visually-hidden">Site register</caption>
            <thead>
              <tr>
                <th scope="col">Site</th>
                <th scope="col">Code</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Town</th>
                <th scope="col">Manager</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((site) => (
                <tr key={site.id}>
                  <td data-label="Site">
                    <button
                      type="button"
                      className="table-text-action"
                      onClick={() => setMode({ kind: "detail", siteId: site.id })}
                    >
                      {site.name}
                    </button>
                  </td>
                  <td data-label="Code">{site.code ?? "—"}</td>
                  <td data-label="Type">
                    {labelFor(data.siteTypes, site.siteTypeValue ?? site.type)}
                  </td>
                  <td data-label="Status">
                    <span className="status-chip" style={styleFor(data.statuses, site.status)}>
                      {labelFor(data.statuses, site.status)}
                    </span>
                  </td>
                  <td data-label="Town">{site.city ?? "—"}</td>
                  <td data-label="Manager">{site.managerName ?? "—"}</td>
                  <td data-label="Actions">
                    {/*
                      The same flex row the other tables' action cells use, so
                      the three controls share a baseline and a gap. Without it
                      they are inline-flex boxes of two different heights
                      sitting on the text baseline, and the taller one — the
                      raise control, which keeps the 44px touch floor — rides
                      up out of line with Edit and Close.
                    */}
                    <div className="table-row-actions">
                    {/*
                      A fault is usually noticed while somebody is looking at
                      the site, not while they are looking at the job board.
                      Raising it here carries the site through, so the ticket
                      lands attributed instead of on whichever store the board
                      happens to default to.
                    */}
                    <RaiseTicketButton
                      context={{
                        siteId: site.id,
                        siteName: site.name,
                        section: "Site",
                      }}
                      label="Raise a ticket"
                      // Sits in the Actions column beside Edit and Close, so it
                      // takes the same control they do. "quiet" maps to
                      // .icon-button — a 36px square sized for a glyph with no
                      // label — and the words overflowed it and painted under
                      // the row.
                      variant="secondary"
                      onRaised={(ticket) =>
                        onNotify(
                          `${ticket.reference ?? ticket.title} raised for ${ticket.siteName}.`,
                        )
                      }
                      onNotify={onNotify}
                    />
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() =>
                        setMode({
                          kind: "form",
                          site,
                          groupIds: data.groups
                            .filter((group) => group.siteIds.includes(site.id))
                            .map((group) => group.id),
                        })
                      }
                    >
                      Edit
                    </button>
                    {site.status !== "closed" ? (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => archive(site)}
                      >
                        Close
                      </button>
                    ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
