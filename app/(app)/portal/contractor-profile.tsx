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
 * W06-13 — THE SUMMARY, AND THE TWO PIECES IT LENDS BACK.
 *
 * `ContractorSummary` is the view this drawer opens on. `ContractorRow` and
 * `ContractorExpiryChip` are its labelled row and its expiry chip, imported
 * rather than written again here so the Details tab beside it looks like the
 * Summary rather than like a second designer's idea of the same thing.
 *
 * The contact cell moved WITH it. `wa.me` answers a national number with "the
 * phone number shared via url is invalid", so the rule about when a WhatsApp
 * link may be built at all lives in one component over one helper; the drawer
 * header no longer draws a second copy of the same three values a few
 * centimetres above the Summary's "Reach them" card.
 */
import {
  ContractorExpiryChip,
  ContractorRow,
  ContractorSummary,
  type SummaryContractor,
} from "./contractor-summary";
/*
 * THE TAB PATTERN THE SITES SCREENS ALREADY IMPLEMENT, imported rather than
 * approximated. It is the WAI-ARIA tabs contract in full — `aria-controls` on
 * every tab, `role="tabpanel"` and `aria-labelledby` on every panel, a roving
 * tabindex so the strip is one tab stop, and Arrow/Home/End moving selection
 * with focus. The item drawer's own `.detail-drawer__tabs` is a `<nav>` of
 * plain buttons with none of that, and copying it here would have been the
 * third place in this product to declare a tablist and then not behave like
 * one.
 */
import { SectionPanel, SectionTabs } from "./sites/section-tabs";

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

/**
 * The register row this drawer describes.
 *
 * `SummaryContractor` and a handful more, rather than a list of its own. The
 * Summary card already names every field it reads and the reason each is
 * optional — two producers build these records, and the Contractors page's
 * synthesised fallback roster knows almost nothing — so restating them here
 * would be a second declaration to keep in step with the first.
 *
 * What the drawer needs on top of it is the identity it fetches by and the
 * fields the DETAILS tab shows and the Summary deliberately does not.
 */
type ContractorRecord = SummaryContractor & {
  id: string;
  address?: string | null;
  postcode?: string | null;
  notes?: string | null;
  policyNumber?: string | null;
  insuranceNotes?: string | null;
  rating?: number | null;
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

/**
 * W06-13 — THE FIVE VIEWS, AND WHY SUMMARY IS FIRST.
 *
 * The drawer used to be one long scroll: Performance, then Sites, then
 * Documents, then up to fifty job rows. Opening it put a stat grid on screen
 * and everything a person had actually come for — the number to ring, whether
 * the insurance is in date, what was agreed — either below four hundred pixels
 * of table or nowhere in the product at all. The question a contractor drawer
 * is opened to answer is "who are they and can I use them", so that is what it
 * opens on.
 *
 * DETAILS IS SECOND AND IS NOT A SECOND SUMMARY. It holds precisely the fields
 * the Summary leaves out — the address, the postcode, the notes, the policy
 * number, the rating, and every certification rather than the one expiring
 * soonest — so the two together are the whole record with nothing said twice.
 * The three that follow are the relations, in the order they were already in.
 *
 * Editing still happens in "Manage contractors". This drawer reads the record;
 * it writes only the two things that are relations rather than fields — a site
 * link, and a document filed against them. What it now also does is CARRY THE
 * WAY IN to that editor — see `openEditor` below. The register's pinned pencil
 * is gone, so this header is the only route a person has to the one editor, and
 * the drawer had to grow the affordance rather than grow a form.
 */
const TABS = ["Summary", "Details", "Sites", "Documents", "Jobs"] as const;

/** Namespaces the tab and panel ids, so nothing on the page can collide. */
const TAB_PREFIX = "contractor-profile";

export function ContractorProfile({
  contractor,
  jobs,
  performance,
  periodLabel,
  onClose,
  onManage,
  onNotify,
}: {
  contractor: ContractorRecord;
  jobs: ProfileJob[];
  performance: ContractorPerformance;
  /** What window the performance figures were measured over. */
  periodLabel: string;
  onClose: () => void;
  /**
   * Open the ordinary contractor editor — the only way to write a native field.
   *
   * THE SAME CALLBACK THE REGISTER IS HANDED, passed straight through by the
   * Contractors page, so pressing Edit here and pressing Edit anywhere else
   * reaches one `openWorkspaceManager("contractor", id)` and one record editor.
   * Required rather than optional on purpose: with the table's pinned pencil
   * removed, an unwired drawer is a product with no way to edit a contractor,
   * and that is a failure the type checker should catch rather than the owner.
   */
  onManage: (id: string) => void;
  onNotify: (message: string) => void;
}) {
  /*
   * SUMMARY, ALWAYS, ON EVERY OPEN.
   *
   * Deliberately not remembered. The drawer is keyed on the contractor's id at
   * its call site, so it remounts per contractor anyway; and a drawer that
   * reopened on whichever tab was last used would answer a question the reader
   * asked about somebody else. The overview is cheap to leave and one key press
   * from anything else.
   */
  const [tab, setTab] = useState<(typeof TABS)[number]>("Summary");
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

  /**
   * EDIT — HAND THE RECORD TO THE ONE EDITOR, AND GET OUT OF ITS WAY.
   *
   * `onManage` is the page's own callback, unchanged and unwrapped: it opens
   * `WorkspaceDataManager` on the contractor tab with this row selected. There
   * is no second form here and there must not be one — the register editor is
   * where the 25 native fields, their validation and their save verb live, and
   * a drawer-local copy of any of it is a second answer to "what did we agree
   * their day rate was".
   *
   * THE DRAWER CLOSES FIRST, and that ordering is not cosmetic. Both this panel
   * and the manager listen for Escape on `window`, and the manager's handler
   * (workspace-data-manager.tsx, "ONE LAYER AT A TIME") does not
   * `preventDefault()` — so leaving this open underneath would mean one Escape
   * dismissing two overlays at once, which is the exact layering bug that
   * handler was written to avoid. Closing also hands the focus chain over
   * cleanly: React runs this panel's effect cleanup before the manager's mount
   * effect, so focus lands back on the register's name button and the manager
   * captures THAT as the control to restore to when it closes. Press Edit,
   * save, close, and the focus ring is back on the contractor you started from.
   *
   * `contractor.id` AND NOTHING DERIVED FROM IT. The manager finds its record
   * with `recordsFor("contractor", workspace).find(item => item.id === …)`, so
   * the id is the whole contract. On the page's synthesised fallback roster —
   * the one built out of job text when the register is EMPTY — that lookup
   * finds nothing and the manager opens on its (empty) contractor list. That is
   * the truthful landing, it is what the register's pencil did with the same
   * id before it was removed, and it must not be "fixed" by inventing a record.
   */
  const openEditor = useCallback(() => {
    onClose();
    onManage(contractor.id);
  }, [onClose, onManage, contractor.id]);

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
  /*
   * The two relation counts the Summary shows, taken from the rows this drawer
   * has ALREADY LISTED rather than from a number it cannot check. Null while
   * the fetch is in flight — the Summary prints an em dash for that and a zero
   * for zero, because "they hold nothing" is a claim and "not loaded yet" is
   * not the same claim.
   *
   * The site profile's own Overview once made the opposite mistake: its
   * "Documents held" card read the length of the COMPLIANCE register and
   * printed 265 while the Documents tab below it listed two files.
   */
  const documentsHeld = documents ? documents.length : null;
  const sitesLinked = links ? links.links.length : null;
  /** Every certification the register holds — the Details tab's list. */
  const certifications = contractor.certificationEntries ?? [];
  /*
   * WHETHER THE DETAILS TAB HAS A RECORD TO SHOW.
   *
   * The same rule the Summary's cards use, and the same reason: a panel of six
   * em dashes reads as a screen that failed rather than as a record nobody has
   * filled in. `rating` is tested for null AND undefined because two producers
   * build these rows — `/api/workspace` sends null, and the Contractors page's
   * synthesised fallback roster does not send the key at all.
   */
  const hasRating = contractor.rating !== null && contractor.rating !== undefined;
  const hasRecordDetail = Boolean(
    contractor.address ||
      contractor.postcode ||
      contractor.policyNumber ||
      contractor.insuranceNotes ||
      contractor.notes ||
      hasRating,
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
        {/*
          THE HEADER IS THE IDENTITY AND NOTHING ELSE NOW.

          It used to print the availability word, an " · archived" suffix and a
          full copy of the contact cell. Two of those three were wrong the
          moment the Summary existed: joining `availability` to `active` with a
          dot presents two different columns as one state — the exact reading
          the register's own subtitle was rewritten to stop — and the contact
          cell was about to appear twice within one screenful. Both now live in
          the Summary, under two separate labels and a sentence saying they are
          not the same claim.

          The ARCHIVED flag stays here, because it is the one fact that must be
          visible on every tab: reading a job list or filing a document against
          somebody who is off the register is a mistake nobody makes on purpose.
          Availability does not, because it changes weekly and is not a reason
          to stop reading.

          WHAT IS NEW IS THE PENCIL, and it is here rather than on the Summary
          because the Summary is one of five tabs. Somebody who reads the Jobs
          list and decides the day rate is wrong should not have to go back a
          tab to say so; the header is the one strip that is on screen whichever
          view they are in, and it already holds the drawer's other verb.
        */}
        <div className="detail-drawer__header">
          <div>
            <span>
              Contractor
              {contractor.active ? "" : " · archived"}
            </span>
            <h2>{contractor.name}</h2>
          </div>
          {/*
            TWO BUTTONS IN THE SHARED ACTIONS CLUSTER, not two loose children.
            `.detail-drawer__actions` (overlay/overlay.css) is the same wrapper
            the item drawer uses for exactly this — the `margin-left: auto` and
            the 6px gap live on it once, and the phone rule that sizes a drawer
            header button to 42x42 already names it. A second bare `<button>`
            beside the close would have taken `margin-left: auto` a second time
            and been styled by a rule written for a single control.

            THE NAME SAYS WHOSE RECORD IT IS. "Edit" alone is what a screen
            reader would announce out of context, and this drawer is opened from
            a table of thirty contractors; `Edit {name}` is the wording the
            register's own pencil used before it was removed, so nothing has to
            be relearned. The word is repeated in `title` for a pointer user,
            because an icon-only control names itself to nobody else.
          */}
          <div className="detail-drawer__actions">
            <button
              type="button"
              className="icon-button"
              onClick={openEditor}
              aria-label={`Edit ${contractor.name}`}
              title={`Edit ${contractor.name}`}
            >
              <Icon name="edit" size={17} />
            </button>
            <button type="button" className="icon-button" onClick={onClose} aria-label="Close contractor profile">
              <Icon name="close" size={18} />
            </button>
          </div>
        </div>
        {/*
          The strip sits BETWEEN the header and the scrolling body rather than
          inside it, so it does not scroll away under a fifty-row job table.
          `.detail-drawer` is a flex column and `.detail-drawer__body` is the
          only thing in it that grows.
        */}
        <div className="contractor-profile__tabs">
          <SectionTabs
            idPrefix={TAB_PREFIX}
            label="Contractor sections"
            sections={TABS}
            active={tab}
            onChange={setTab}
          />
        </div>
        <div className="detail-drawer__body contractor-profile">

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {/* ── SUMMARY ────────────────────────────────────────────────────── */}
        <SectionPanel
          idPrefix={TAB_PREFIX}
          section="Summary"
          focusable
          active={tab === "Summary"}
        >
          <ContractorSummary
            contractor={contractor}
            performance={performance}
            periodLabel={periodLabel}
            documentsHeld={documentsHeld}
            sitesLinked={sitesLinked}
          />
        </SectionPanel>

        {/* ── DETAILS ────────────────────────────────────────────────────── */}
        {/*
          THE REST OF THE RECORD, and only the rest of it. Every row here is a
          field the Summary deliberately does not carry: the postal detail, the
          free text, the policy number, the rating, and the full certification
          list of which the Summary shows one. Nothing is printed on both tabs.
        */}
        <SectionPanel
          idPrefix={TAB_PREFIX}
          section="Details"
          focusable
          active={tab === "Details"}
        >
          <section className="contractor-profile__section">
            <h3>Details</h3>
            <div className="contractor-summary__rows">
              <ContractorRow label="Address" when={Boolean(contractor.address)}>
                {contractor.address}
              </ContractorRow>
              <ContractorRow label="Postcode" when={Boolean(contractor.postcode)}>
                {contractor.postcode}
              </ContractorRow>
              <ContractorRow label="Policy number" when={Boolean(contractor.policyNumber)}>
                {contractor.policyNumber}
              </ContractorRow>
              <ContractorRow label="Insurance notes" when={Boolean(contractor.insuranceNotes)}>
                {contractor.insuranceNotes}
              </ContractorRow>
              {/*
                A rating out of five, printed as what it is. `rating` is a
                `real` and null means nobody has rated them — which is not the
                same as a rating of zero, so the row simply does not appear.
              */}
              <ContractorRow label="Rating" when={hasRating}>
                {contractor.rating} out of 5
              </ContractorRow>
              <ContractorRow label="Notes" when={Boolean(contractor.notes)}>
                {contractor.notes}
              </ContractorRow>
            </div>
            {!hasRecordDetail && (
              <p className="analytics-empty">
                No further record detail is held for {contractor.name}. The address, the
                notes and the policy number are edited under Manage contractors.
              </p>
            )}
          </section>

          {/* ── CERTIFICATIONS ───────────────────────────────────────────── */}
          {/*
            EVERY ticket, where the Summary shows the one expiring soonest. The
            state beside each is the one `/api/workspace` classified with
            `app/lib/expiry-status.ts`; this list picks nothing and decides
            nothing, so a certificate cannot read "Due soon" here and "Valid"
            in the record editor.
          */}
          {certifications.length > 0 && (
            <section className="contractor-profile__section">
              <h3>Certifications</h3>
              <ul className="file-list">
                {certifications.map((entry, index) => (
                  <li key={`${entry.name}-${index}`}>
                    <strong>{entry.name}</strong>
                    <span className="drawer-label">
                      {entry.expiresOn
                        ? `Expires ${formatDate(entry.expiresOn)}`
                        : "No expiry recorded"}
                    </span>
                    <ContractorExpiryChip
                      state={entry.expiryState}
                      label={entry.expiryLabel}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </SectionPanel>

        {/* ── SITES ──────────────────────────────────────────────────────── */}
        <SectionPanel
          idPrefix={TAB_PREFIX}
          section="Sites"
          focusable
          active={tab === "Sites"}
        >
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
        </SectionPanel>

        {/* ── DOCUMENTS ──────────────────────────────────────────────────── */}
        <SectionPanel
          idPrefix={TAB_PREFIX}
          section="Documents"
          focusable
          active={tab === "Documents"}
        >
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
        </SectionPanel>

        {/* ── JOBS ───────────────────────────────────────────────────────── */}
        <SectionPanel
          idPrefix={TAB_PREFIX}
          section="Jobs"
          focusable
          active={tab === "Jobs"}
        >
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
        </SectionPanel>
        </div>
      </aside>
    </>
  );
}
