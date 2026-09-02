"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components";
import { uploadEvidenceFile } from "../../lib/client-upload";
import { formatDate as sharedFormatDate } from "../../lib/format-date";
/*
 * ONE RULE FOR WHAT A DOCUMENT IS CALLED — the title somebody set, the stored
 * filename otherwise. `documentName` in views/document-register.ts is the only
 * function allowed to decide it, and the server's `Content-Disposition` follows
 * the same rule. Printing `originalName` here is what would let a renamed
 * certificate appear under its upload filename on one screen and its title on
 * another.
 */
import { documentName } from "./views/document-register";
/*
 * THE ONE BODY SCROLL LOCK, shared with the job drawer and the phone's nav.
 * A second flag of our own would disagree with that counter about when the page
 * is free to move: with two overlays open, whichever closed first would unlock
 * the page under the other one.
 */
import { useBodyScrollLock } from "./overlay/scroll-lock";
/*
 * THE SAME CONTACT CELL THE REGISTER DRAWS, not a second copy of it. `wa.me`
 * answers a national number with "the phone number shared via url is invalid",
 * so the rule about when a WhatsApp link may be built at all lives in one
 * component and one helper — a hand-written `tel:`/`wa.me` pair here would be
 * the second place to get that wrong.
 */
import { ContractorContact } from "./contractor-contact";

/**
 * W06-10 — THE CONTRACTOR PROFILE: jobs, sites, documents, performance.
 *
 * The criterion asks that a contractor be connected to their assigned jobs,
 * their sites, their documents and their performance. Two of those four worked
 * and two did not:
 *
 *   JOBS         — `maintenance_requests.contractor_id`, attributed by
 *                  `app/lib/contractor-attribution.ts`. Passed in already
 *                  attributed, because the rule is the page's and not this
 *                  panel's, and a second implementation would be a second
 *                  answer to "whose job was that".
 *   PERFORMANCE  — the same jobs, counted. Also passed in.
 *   SITES        — did not exist in any form. `contractor_sites` and
 *                  `/api/contractor-sites` are the relation; see that route for
 *                  why it is a table and not an inference over `coverage_areas`.
 *   DOCUMENTS    — the plumbing existed and nothing reached it. `contractor_id`
 *                  on `attachments`, its index, the anchor validator and
 *                  `GET /api/files?contractorId=` all shipped with W07-07, and
 *                  not one of `uploadEvidenceFile`'s six call sites passed a
 *                  `contractorId`. So a contractor's public liability
 *                  certificate could be stored by an API client and never by a
 *                  person.
 *
 * UPLOADS GO THROUGH `uploadEvidenceFile`, ALWAYS. It owns the ~1 MiB
 * direct-path ceiling — above which the Workers form parser answers a bare-text
 * 413 carrying no JSON `error` — the multipart fallback past
 * `DIRECT_UPLOAD_LIMIT`, and the thumbnail. A hand-rolled `fetch("/api/files")`
 * silently loses all three, which is exactly how the drawer's "Upload new
 * version" once failed on a phone photograph with a generic message.
 */

const formatDate = sharedFormatDate;

type ContractorSummary = {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  whatsappNumber: string | null;
  availability: string | null;
  active: boolean;
};

type SiteSummary = {
  id: string;
  name: string;
  code: string | null;
  city: string | null;
  postcode: string | null;
  region: string;
  status: string;
  active: boolean;
};

type SiteLink = {
  id: string;
  site: SiteSummary;
  createdAt: string;
  createdBy: string | null;
};

type LinkPayload = {
  contractorId: string;
  links: SiteLink[];
  canEdit: boolean;
  canManageDocuments: boolean;
  candidates: SiteSummary[];
  candidateTotal: number;
  candidateLimit: number;
};

type DocumentRow = {
  id: string;
  originalName: string;
  title: string | null;
  documentType: string | null;
  kind: string;
  byteSize: number;
  createdAt: string;
  expiryDate: string | null;
  versionNo: number;
  inlineUrl?: string;
  downloadUrl?: string;
};

/** The job rows this panel lists. Attributed by the page, never by this file. */
export type ProfileJob = {
  id: string;
  reference?: string | null;
  title: string;
  location?: string | null;
  status: string;
  priority: string;
  requestedAt: string;
  completedAt?: string | null;
  cost?: number | null;
};

export type ContractorPerformance = {
  assignedJobs: number;
  completedJobs: number;
  urgentJobs: number;
  spend: number;
};

function bytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function money(value: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(value);
}

export function ContractorProfile({
  contractor,
  jobs,
  performance,
  periodLabel,
  onClose,
  onNotify,
}: {
  contractor: ContractorSummary;
  jobs: ProfileJob[];
  performance: ContractorPerformance;
  /** What window the performance figures were measured over. */
  periodLabel: string;
  onClose: () => void;
  onNotify: (message: string) => void;
}) {
  const [links, setLinks] = useState<LinkPayload | null>(null);
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [search, setSearch] = useState("");
  const [pendingSite, setPendingSite] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /*
   * THE PANEL IS A DIALOG AND HAS TO BEHAVE LIKE ONE — the same argument the
   * document drawer already makes on this page. Focus moves to the surface so a
   * screen reader announces it and its label before the close button, and
   * Escape closes it.
   */
  const surfaceRef = useRef<HTMLElement | null>(null);
  useBodyScrollLock(true);
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const surface = surfaceRef.current;
    if (surface && !surface.contains(document.activeElement)) {
      surface.focus({ preventScroll: true });
    }
    return () => {
      if (!opener || !document.contains(opener)) return;
      const active = document.activeElement;
      if (!active || active === document.body) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      /* Escape inside a box means "abandon what I am typing" everywhere else in
         this app, and the site search is one Tab from here. */
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select")) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  /*
   * TWO COUNTERS, TWO EFFECTS, NO CALLABLE LOADERS.
   *
   * The work is declared inside each effect and state is only touched after the
   * await resolves — the pattern `use-loader.ts` states and this repo's lint
   * rules enforce: setting state synchronously in an effect body causes
   * cascading renders. Two counters rather than one because the two halves are
   * refreshed by different verbs: linking a site must not re-fetch the
   * documents, and filing a document must not re-fetch the sites.
   *
   * `active` guards a response arriving after the drawer has closed.
   */
  const [linksNonce, setLinksNonce] = useState(0);
  const [documentsNonce, setDocumentsNonce] = useState(0);
  const reloadLinks = useCallback(() => setLinksNonce((current) => current + 1), []);
  const reloadDocuments = useCallback(
    () => setDocumentsNonce((current) => current + 1),
    [],
  );

  const contractorId = contractor.id;

  useEffect(() => {
    let active = true;
    async function run() {
      try {
        const response = await fetch(
          `/api/contractor-sites?contractorId=${encodeURIComponent(contractorId)}${
            search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ""
          }`,
          { headers: { Accept: "application/json" } },
        );
        const payload = (await response.json()) as LinkPayload & { error?: string };
        if (!active) return;
        if (!response.ok) throw new Error(payload.error || "The sites could not be loaded.");
        setLinks(payload);
      } catch (caught) {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "The sites could not be loaded.");
      }
    }
    run();
    return () => {
      active = false;
    };
  }, [contractorId, search, linksNonce]);

  useEffect(() => {
    let active = true;
    async function run() {
      try {
        /*
         * The endpoint's DEFAULT archive gate, deliberately: current version,
         * not archived. "The documents this contractor holds" means the ones
         * that are live — a certificate replaced twice is ONE document, and
         * counting its superseded rows would triple the figure beside it.
         */
        const response = await fetch(
          `/api/files?contractorId=${encodeURIComponent(contractorId)}&limit=100`,
          { headers: { Accept: "application/json" } },
        );
        if (!response.ok) throw new Error("The documents could not be loaded.");
        const payload = (await response.json()) as { files?: DocumentRow[] };
        if (!active) return;
        setDocuments(payload.files ?? []);
      } catch (caught) {
        if (!active) return;
        setError(
          caught instanceof Error ? caught.message : "The documents could not be loaded.",
        );
      }
    }
    run();
    return () => {
      active = false;
    };
  }, [contractorId, documentsNonce]);

  async function linkSite() {
    if (!pendingSite) return;
    setBusy("link");
    setError("");
    try {
      const response = await fetch("/api/contractor-sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractorId: contractor.id, siteId: pendingSite }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "That site could not be linked.");
      setPendingSite("");
      reloadLinks();
    } catch (caught) {
      // The server's own sentence — "Site not found." says which id was wrong.
      setError(caught instanceof Error ? caught.message : "That site could not be linked.");
    } finally {
      setBusy(null);
    }
  }

  async function unlinkSite(link: SiteLink) {
    setBusy(link.id);
    setError("");
    try {
      const response = await fetch(
        `/api/contractor-sites?id=${encodeURIComponent(link.id)}`,
        { method: "DELETE" },
      );
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "That link could not be removed.");
      reloadLinks();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That link could not be removed.");
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File) {
    setBusy("upload");
    setError("");
    setProgress(0);
    try {
      /*
       * `contractorId` is the anchor, and this is the first call site in the
       * product to send one. `kind: "general"` because a contractor's insurance
       * is a workspace document rather than evidence about a work order — the
       * two other kinds are a job's issue and completion photographs, and
       * filing a certificate as either would put it on a board's photo strip.
       */
      await uploadEvidenceFile({
        file,
        kind: "general",
        contractorId: contractor.id,
        onProgress: setProgress,
      });
      onNotify(`${file.name} filed against ${contractor.name}.`);
      reloadDocuments();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "That document could not be uploaded.",
      );
    } finally {
      setBusy(null);
      setProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function unfile(document: DocumentRow) {
    setBusy(document.id);
    setError("");
    try {
      /*
       * Unfiling is a PATCH of the anchor, not a delete. The bytes, the row and
       * every URL ever issued for it survive; the document simply stops being
       * this contractor's. The server refuses it when the contractor is the
       * document's ONLY anchor — nothing may float free — and that refusal is
       * shown here word for word rather than replaced.
       */
      const response = await fetch(`/api/files/${encodeURIComponent(document.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractorId: null }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "That document could not be unfiled.");
      }
      reloadDocuments();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "That document could not be unfiled.",
      );
    } finally {
      setBusy(null);
    }
  }

  const canEditSites = links?.canEdit ?? false;
  const canManageDocuments = links?.canManageDocuments ?? false;
  const completion = Math.round(
    (performance.completedJobs / Math.max(performance.assignedJobs, 1)) * 100,
  );

  return (
    <>
      {/*
        The scrim is a BUTTON, as every other overlay on this page draws it: a
        bare div swallows the press without ever being reachable from a
        keyboard, and the close it performs is a real action that deserves a
        name a screen reader can read.
      */}
      <button
        className="drawer-scrim"
        type="button"
        aria-label="Close contractor profile"
        onClick={onClose}
      />
      <aside
        className="detail-drawer detail-drawer--contractor"
        role="dialog"
        aria-modal="true"
        aria-label={`Contractor profile: ${contractor.name}`}
        tabIndex={-1}
        ref={surfaceRef}
      >
        <div className="detail-drawer__header">
          <div>
            <span>
              {contractor.availability || "Availability not recorded"}
              {contractor.active ? "" : " · archived"}
            </span>
            <h2>{contractor.name}</h2>
            <p className="drawer-label">
              <ContractorContact contractor={contractor} />
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close contractor profile">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="detail-drawer__body contractor-profile">

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {/* ── PERFORMANCE ────────────────────────────────────────────────── */}
        <section className="contractor-profile__section">
          <h3>Performance</h3>
          {/*
            The window is NAMED. These four are period-scoped measurements, not
            facts about the contractor, and a completion rate with no window
            beside it is a number nobody can check. The agreed day rate, the
            call-out and the hourly rate are deliberately absent: they are
            agreed TERMS, and summing a rate into a spend total does not
            summarise cost, it invents it.
          */}
          <p className="drawer-label">Measured over {periodLabel}.</p>
          <div className="site-stat-grid">
            <div className="panel">
              <span className="drawer-label">Assigned jobs</span>
              <strong>{performance.assignedJobs}</strong>
            </div>
            <div className="panel">
              <span className="drawer-label">Completed</span>
              <strong>{performance.completedJobs}</strong>
            </div>
            <div className="panel">
              <span className="drawer-label">Completion rate</span>
              <strong>{completion}%</strong>
            </div>
            <div className="panel">
              <span className="drawer-label">Open urgent</span>
              <strong>{performance.urgentJobs}</strong>
            </div>
            <div className="panel">
              <span className="drawer-label">Tracked spend</span>
              <strong>{money(performance.spend)}</strong>
            </div>
            <div className="panel">
              <span className="drawer-label">Documents held</span>
              <strong>{documents ? documents.length : "—"}</strong>
            </div>
          </div>
        </section>

        {/* ── SITES ──────────────────────────────────────────────────────── */}
        <section className="contractor-profile__section">
          <h3>Sites</h3>
          {canEditSites && links && (
            <div className="contractor-profile__link">
              <label className="visually-hidden" htmlFor="contractor-site-search">
                Search sites
              </label>
              <input
                id="contractor-site-search"
                type="search"
                placeholder="Search sites…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <label className="visually-hidden" htmlFor="contractor-site-choice">
                Site to link
              </label>
              <select
                id="contractor-site-choice"
                value={pendingSite}
                onChange={(event) => setPendingSite(event.target.value)}
              >
                <option value="">Choose a site…</option>
                {links.candidates.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                    {site.code ? ` (${site.code})` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="primary-button"
                disabled={!pendingSite || busy === "link"}
                onClick={() => void linkSite()}
              >
                {busy === "link" ? "Linking…" : "Link site"}
              </button>
              {links.candidateTotal > links.candidates.length && (
                <p className="drawer-label">
                  Showing {links.candidates.length} of {links.candidateTotal} available
                  sites. Search to narrow the list.
                </p>
              )}
            </div>
          )}
          {!links ? (
            <p className="analytics-empty">Loading sites…</p>
          ) : links.links.length === 0 ? (
            <p className="analytics-empty">
              {contractor.name} is not linked to any site yet. Linking one records
              the appointment; it does not change any job already attributed to
              them.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="analytics-table analytics-table--mobile-cards">
                <caption className="visually-hidden">
                  Sites linked to {contractor.name}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Site</th>
                    <th scope="col">Code</th>
                    <th scope="col">Where</th>
                    <th scope="col">Linked</th>
                    {canEditSites && <th scope="col">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {links.links.map((link) => (
                    <tr key={link.id}>
                      <td data-label="Site">
                        <strong>{link.site.name}</strong>
                      </td>
                      <td data-label="Code">{link.site.code ?? "—"}</td>
                      <td data-label="Where">
                        {[link.site.city, link.site.postcode]
                          .filter(Boolean)
                          .join(", ") || link.site.region}
                      </td>
                      <td data-label="Linked">{formatDate(link.createdAt)}</td>
                      {canEditSites && (
                        <td data-label="Actions">
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={busy === link.id}
                            onClick={() => void unlinkSite(link)}
                          >
                            {busy === link.id ? "Removing…" : "Unlink"}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── DOCUMENTS ──────────────────────────────────────────────────── */}
        <section className="contractor-profile__section">
          <h3>Documents</h3>
          {canManageDocuments && (
            <div className="contractor-profile__upload">
              <label className="secondary-button" htmlFor="contractor-document-upload">
                <Icon name="upload" size={16} />
                {busy === "upload"
                  ? `Uploading${progress === null ? "" : ` ${Math.round(progress)}%`}…`
                  : "Add a document"}
              </label>
              <input
                id="contractor-document-upload"
                ref={fileInputRef}
                type="file"
                className="visually-hidden"
                disabled={busy === "upload"}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
              <span className="drawer-label">
                Insurance, certifications, method statements and terms. Filed
                against {contractor.name}, not against a job.
              </span>
            </div>
          )}
          {!documents ? (
            <p className="analytics-empty">Loading documents…</p>
          ) : documents.length === 0 ? (
            <p className="analytics-empty">
              No documents are filed against {contractor.name}.
            </p>
          ) : (
            <ul className="file-list">
              {documents.map((document) => (
                <li key={document.id}>
                  <a href={document.inlineUrl ?? `/api/files/${document.id}`}>
                    {documentName({ title: document.title, name: document.originalName })}
                  </a>
                  <span className="drawer-label">
                    {document.documentType || document.kind} · {bytes(document.byteSize)} ·{" "}
                    {formatDate(document.createdAt)}
                    {document.expiryDate ? ` · expires ${formatDate(document.expiryDate)}` : ""}
                    {document.versionNo > 1 ? ` · v${document.versionNo}` : ""}
                  </span>
                  {canManageDocuments && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy === document.id}
                      onClick={() => void unfile(document)}
                    >
                      {busy === document.id ? "Removing…" : "Unfile"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── JOBS ───────────────────────────────────────────────────────── */}
        <section className="contractor-profile__section">
          <h3>Assigned jobs</h3>
          {jobs.length === 0 ? (
            <p className="analytics-empty">
              No job in {periodLabel} is attributed to {contractor.name}.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="analytics-table analytics-table--mobile-cards">
                <caption className="visually-hidden">
                  Jobs attributed to {contractor.name}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Reference</th>
                    <th scope="col">Job</th>
                    <th scope="col">Site</th>
                    <th scope="col">Status</th>
                    <th scope="col">Raised</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.slice(0, 50).map((job) => (
                    <tr key={job.id}>
                      <td data-label="Reference">{job.reference ?? job.id}</td>
                      <td data-label="Job">{job.title}</td>
                      <td data-label="Site">{job.location || "—"}</td>
                      <td data-label="Status">{job.status}</td>
                      <td data-label="Raised">{formatDate(job.requestedAt)}</td>
                      <td data-label="Cost">
                        {job.cost === null || job.cost === undefined ? "—" : money(job.cost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/*
                The list is capped and SAYS SO. A profile that silently showed
                fifty of a hundred and eighty jobs would be a count nobody could
                check — the same failure the Documents register had before its
                walk reported its own bound.
              */}
              {jobs.length > 50 && (
                <p className="drawer-label">
                  Showing the first 50 of {jobs.length} jobs in {periodLabel}.
                </p>
              )}
            </div>
          )}
        </section>
        </div>
      </aside>
    </>
  );
}
