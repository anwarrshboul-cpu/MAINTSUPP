"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLoader } from "./use-loader";
import { SiteDetail } from "./site-detail";
import { SiteForm } from "./site-form";
/*
 * W05-05 — one confirmation, shared with the Manage-data drawer. The words and
 * the reasoning live in site-closure.ts; both closure paths call them so the
 * promise can only be corrected in one place.
 */
import { confirmSiteClosure } from "./site-closure";
/*
 * W05-08 — the configurable register, mounted rather than reimplemented.
 *
 * The grid, the column menu, the columns panel and the four rules a register
 * screen has to keep — native cells come off the entity row, controls are gated
 * on the snapshot's capabilities, a refusal is shown in the server's own words,
 * and a reorder sends the WHOLE order — all live in `register-grid.tsx` beside
 * `register-client.ts`. A second copy of any of them here is how the Sites and
 * Contractors registers would come to disagree about what a column is.
 */
import { RegisterGrid } from "../register/register-grid";
import {
  api,
  labelFor,
  styleFor,
  type OptionChoice,
  type SiteGroupRecord,
  type SiteRecord,
  scopedUrl,
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

/**
 * W05-10 — THE SITE PROFILE HAS AN ADDRESS.
 *
 * The three views here REPLACE each other out of `useState`, so opening a site
 * changed nothing about the URL: reloading the page went back to the register,
 * a link to "the Bullring's profile" could not be sent to anybody, and the
 * browser's Back button left the screen the user was on entirely. For the one
 * screen a manager opens when somebody asks about a specific shop, that is the
 * difference between a page and a modal.
 *
 * A query parameter on `/dashboard/sites` rather than a path segment, because
 * the portal is one client-routed page and the PATH is how it chooses its
 * section — `portal-app.tsx` reads `location.pathname` on `popstate` and would
 * read `/dashboard/sites/site-bluewater` as a section it does not have. The
 * parameter rides alongside and is invisible to that handler, which is why this
 * needs no change there.
 *
 * The EDITOR is deliberately not addressed. A half-typed form is not a place,
 * and a URL that reopens one would restore the shell of an edit without any of
 * the typing.
 */
const SITE_PARAM = "site";

/** The current URL with the site parameter set, or cleared when null. */
function siteHref(siteId: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (siteId) params.set(SITE_PARAM, siteId);
  else params.delete(SITE_PARAM);
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}`;
}

/**
 * Every string the register will match a search term against, lower-cased once.
 *
 * `site.aliases` is spread in here rather than being a separate branch so that
 * alias search is not a feature that has to be switched on later — it is simply
 * the case where the array is empty. `GET /api/sites` does not send the field
 * yet (see the note on `SiteRecord.aliases`); on a payload that lacks it this
 * spreads nothing and the behaviour is exactly what it was, and on a payload
 * that has it "Cardiff St Davids" finds "Grand Arcade - Cardiff" with no
 * further change here.
 *
 * `String()` rather than a cast: `code`, `city` and both monday names are
 * nullable, and `.filter(Boolean)` drops the nulls before they can become the
 * string "null" and match a search for "null".
 */
function searchableText(site: SiteRecord): string[] {
  return [
    site.name,
    site.code,
    site.city,
    site.postcode,
    site.mondayMaintenanceName,
    site.mondayComplianceName,
    ...(site.aliases ?? []),
  ]
    .filter(Boolean)
    .map((field) => String(field).toLowerCase());
}

export function SitesManager({
  sectionKey = null,
  onNotify,
}: {
  /**
   * WHICH SITES REGISTER THIS SCREEN IS SHOWING.
   *
   * The section key of a Sites-template instance, or null for the workspace's
   * own register. It is a LOOKUP KEY and nothing more: the server resolves it
   * against `workspace_sections` inside the caller's own organisation and
   * refuses a section that is archived, that belongs to someone else, or that
   * holds a different kind of register. Nothing here filters rows — asking for
   * the wrong register is a 404, not a smaller list.
   */
  sectionKey?: string | null;
  onNotify: (message: string) => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  /*
   * W05-08 — WHICH OF THE TWO VIEWS OF ONE REGISTER IS OPEN.
   *
   * "Summary" is the seven-column table this screen has always had, and it is
   * the default because it is the one with the Raise / Edit / Close controls on
   * every row — the daily job. "All columns" is the configurable register: all
   * forty native site fields plus whatever columns this workspace has added,
   * arranged, renamed, resized and hidden the way somebody configured them.
   *
   * BOTH READ `visible`, so the search box and the two filters above apply to
   * either one. A register that ignored the filters would be a second, subtly
   * different answer to the same question.
   *
   * Deliberately NOT in the URL. `?site=` addresses the detail screen because a
   * site profile is somewhere you send somebody; which of two renderings of the
   * list you last looked at is not, and the column layout itself — the part
   * that IS worth keeping — already persists server-side in `register_columns`.
   */
  const [view, setView] = useState<"summary" | "register">("summary");
  const [importing, setImporting] = useState<ImportResult | null>(null);
  const [pendingCsv, setPendingCsv] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  /*
   * The URL is read on mount and on every Back and Forward, and it is the only
   * thing that decides whether the detail screen is open.
   *
   * Deferred through a zero timer for the reason `portal-app.tsx` defers its
   * own `?manage=` read: state written synchronously in an effect body cascades
   * a render and the lint rules here reject it. `popstate` needs no timer — it
   * is already an event, not a render.
   *
   * The mount read and the history read are the same function on purpose. Two
   * of them is how a deep link comes to work on a fresh load and not after a
   * Back, which is the half nobody tests.
   */
  useEffect(() => {
    const sync = () => {
      const siteId = new URLSearchParams(window.location.search).get(SITE_PARAM);
      setMode((current) => {
        if (siteId) {
          return current.kind === "detail" && current.siteId === siteId
            ? current
            : { kind: "detail", siteId };
        }
        // Only the detail screen is URL-addressed, so only the detail screen is
        // closed by the parameter going away. An open editor is left alone.
        return current.kind === "detail" ? { kind: "list" } : current;
      });
    };
    const timer = window.setTimeout(sync, 0);
    window.addEventListener("popstate", sync);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  /*
   * Every move between the three views goes through one of these two, so the
   * URL and the rendered view cannot disagree. `pushState` rather than
   * `replaceState`: opening a site is somewhere the reader went, and Back
   * should return them to the register they came from.
   */
  const openSite = (siteId: string) => {
    window.history.pushState(null, "", siteHref(siteId));
    setMode({ kind: "detail", siteId });
  };

  const leaveSite = (next: Mode) => {
    window.history.pushState(null, "", siteHref(null));
    setMode(next);
  };

  const { data, error, setError, reload } = useLoader<ListPayload & { accessMethods: OptionChoice[] }>(
    async () => {
      const [list, access] = await Promise.all([
        api<ListPayload>(scopedUrl("/api/sites", sectionKey)),
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
      return searchableText(site).some((field) => field.includes(term));
    });
  }, [data, search, statusFilter, groupFilter]);

  /*
   * The placeholder says what is SEARCHED, and it has to keep saying that.
   *
   * It read "Search name, code, postcode or monday name" while the filter also
   * matched the town — a promise that was short of the truth, which is the
   * cheapest kind of search bug to ship because nobody reports the results they
   * did not know to expect.
   *
   * The "former name" half appears only once the payload actually carries
   * aliases. `aliases` is optional on `SiteRecord` because `GET /api/sites`
   * does not select it yet (see site-types.ts), so advertising it now would put
   * the same untruth back the other way round. This asks the data instead of a
   * flag: the moment the route attaches a non-empty `aliases`, the label grows
   * to match, and a workspace that genuinely has no former names is still told
   * the truth about itself.
   */
  const searchesAliases = Boolean(
    data?.sites.some((site) => (site.aliases?.length ?? 0) > 0),
  );

  async function archive(site: SiteRecord) {
    /*
     * W05-05 — the shared confirmation, not a sentence local to this screen.
     *
     * The words this replaces were fine as far as they went and they did not go
     * far enough: "Its jobs and certificates are kept" says nothing about what
     * closing actually DOES, which is take the site off the active register so
     * it stops being offered when raising or assigning work. The identical
     * write is reachable from the Manage-data drawer's Lifecycle select, which
     * asked nothing at all. One helper now owns the promise for both doors.
     *
     * CANCEL COSTS NOTHING: this returns before the fetch, so no request is
     * made, no state moves and no toast appears.
     */
    if (!confirmSiteClosure(site.name)) return;
    try {
      await api(scopedUrl("/api/sites", sectionKey), { method: "DELETE", body: { id: site.id } });
      onNotify(`${site.name} closed.`);
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The site could not be closed.");
    }
  }

  async function runImport(csv: string, dryRun: boolean) {
    try {
      const result = await api<ImportResult>(scopedUrl("/api/sites/csv", sectionKey), {
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
        sectionKey={sectionKey}
        siteId={mode.siteId}
        siteTypes={data?.siteTypes ?? []}
        statuses={data?.statuses ?? []}
        /*
         * The membership the detail screen already loaded, carried into the
         * editor. This used to pass `[]`, and because a saved form posts its
         * `groupIds` and the route deletes-then-reinserts from that list,
         * opening a site from its own detail page and pressing Save wiped
         * every reporting group it belonged to — no diff, no warning, and
         * the boxes drawn unticked. The list row below has always passed the
         * real ids; the two paths now agree.
         */
        onEdit={(site, groupIds) => leaveSite({ kind: "form", site, groupIds })}
        onClose={() => leaveSite({ kind: "list" })}
      />
    );
  }

  if (mode.kind === "form") {
    return (
      <section className="section-stack">
        <header className="section-header">
          {/*
            An `<h1>` for the same reason the list below is one. These three
            views REPLACE each other — list, form and detail are separate
            returns, not panes of one page — so while the form is open the
            `<h1>Sites</h1>` is not rendered at all, and the document had no
            level-one heading. axe reported `page-has-heading-one` on the Add
            form and the Edit form, on Sites only. `.section-header h2` has no
            rule anywhere, so this also stops the heading being the one
            unstyled title in the shell.
          */}
          <h1>{mode.site ? `Edit ${mode.site.name}` : "Add a site"}</h1>
        </header>
        <SiteForm
          sectionKey={sectionKey}
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
          <a className="secondary-button" href={scopedUrl("/api/sites/csv", sectionKey)} download>
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

      {/*
        NOT A TAB STOP. `.visually-hidden` clips this to a 1x1 rect but leaves
        it focusable, and it is opened by the "Import CSV" button above rather
        than by a <label for>. So a keyboard user reached it one Tab after that
        button, landed on an invisible control, saw no focus ring anywhere on
        the page and had to Tab again — a WCAG 2.4.7 dead stop and a second,
        silent route to the same action. `tabIndex={-1}` leaves the picker fully
        usable through the visible button, which is the accessible control and
        already carries the name.
      */}
      <input
        ref={fileInput}
        type="file"
        accept=".csv,text/csv"
        className="visually-hidden"
        tabIndex={-1}
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
            placeholder={
              searchesAliases
                ? "Search name, former name, code, town, postcode or board name"
                : "Search name, code, town, postcode or board name"
            }
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
        {/*
          W05-08 — the switch between the two views.

          A radio group rather than two buttons, because that is what this is:
          one setting with two values, exactly one of them chosen. `aria-label`
          on the wrapper names the group; each control names its own value. A
          pair of toggle buttons would announce as two unrelated controls and
          leave a screen reader user with no way to tell which one is on.
        */}
        <div className="register-view-switch" role="radiogroup" aria-label="Register view">
          {([
            ["summary", "Summary"],
            ["register", "All columns"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={view === key}
              className={view === key ? "is-active" : ""}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
        </div>
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
      ) : view === "register" ? (
        /*
          W05-08 — THE CONFIGURABLE REGISTER.

          `visible` rather than `data.sites`, so the search box and the two
          filters above mean the same thing in both views. The rows are the
          site records themselves because that is where a NATIVE column's value
          lives — `registerCellValue` inside the grid reads
          `row[column.nativeField]` for those and `snapshot.values` for the
          custom ones, and a grid that read one store for both would draw all
          forty native columns blank.
        */
        <RegisterGrid
          register="sites"
          rows={visible as unknown as Array<Record<string, unknown> & { id: string }>}
          caption="Site register, every configured column"
          title="Site register columns"
          emptyMessage="No sites match these filters."
        />
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
                      onClick={() => openSite(site.id)}
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
                      W12 — "Raise a ticket" NO LONGER LIVES IN THIS CELL.

                      It used to sit here on the reasoning that a fault is
                      noticed while somebody is looking at the site. The owner
                      review of /dashboard/sites asked for it out of the
                      register TABLE: the Actions column is where a row is
                      administered — opened, edited, closed — and a per-row
                      ticket button turned a maintenance register into a
                      reporting form, one copy per site, thirty-one buttons
                      down the page.

                      Raising against a site is UNCHANGED everywhere it still
                      belongs: the site DETAIL header and its per-unit rows
                      (units-manager.tsx), the compliance chase lines
                      (views/store-compliance-tracker.tsx), the documentation
                      board (views/store-documentation-board.tsx) and the
                      portal-wide control. `RaiseTicketButton` itself is
                      untouched — only this one mounting is gone, so the
                      import above went with it.

                      The flex row stays. Edit and Close are still two
                      inline-flex boxes that would otherwise sit on the text
                      baseline at different heights, and `.table-row-actions`
                      is what wraps them onto a second line at 390px instead
                      of pushing "Close" off a cell that does not scroll.
                    */}
                    <div className="table-row-actions">
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
