"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  /*
   * The line under a checkbox's label. Every checkbox here used to print the
   * same "Available in the shared testing workspace", which says nothing about
   * what the box does — and for "Active contractor", which sits two rows below
   * an Availability select that also offers the word "Inactive", saying nothing
   * is what let the two be read as one field.
   */
  hint?: string;
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
  contractor: { name: "", contactName: "", email: "", phone: "", whatsappNumber: "", address: "", serviceCategories: "", coverageAreas: "UK", certifications: "", insuranceExpiry: "", dayRate: "", availability: "Available", rating: "", active: true, notes: "" },
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
    /*
     * Optional, and directly under the phone number because that is where a
     * coordinator looks for it — but a SEPARATE field, never prefilled from
     * the one above. `whatsappHref` in `app/lib/contact-links.ts` will not
     * guess a country code, so a number written the way it is on a van —
     * "07812 224644" — is shown as text and not turned into a link that would
     * open on "the phone number shared via url is invalid". The placeholder is
     * the whole instruction: give it the international form.
     */
    { key: "whatsappNumber", label: "WhatsApp number", type: "tel", placeholder: "+44 7700 900123 — international format" },
    { key: "address", label: "Address", placeholder: "Where they are based" },
    { key: "serviceCategories", label: "Service categories", placeholder: "Electrical, HVAC, Plumbing" },
    { key: "coverageAreas", label: "Coverage areas", placeholder: "UK, London, Midlands" },
    { key: "certifications", label: "Certifications", placeholder: "Comma-separated" },
    { key: "insuranceExpiry", label: "Insurance expiry", type: "date" },
    /* Pounds here, pence in the column — see `ratePence` in the workspace API.
       Left empty it stays null, because no recorded rate is not a rate of £0. */
    { key: "dayRate", label: "Day rate (£)", type: "number", placeholder: "e.g. 320" },
    /*
     * `required`, for the same reason a member's Role is — see the note on it
     * below. Without it this select renders the blank "None" every optional
     * field gets, and `availability` is NOT NULL with a four-label set behind
     * it. Picking "None" sent `availability: ""` and came back 400 "A
     * contractor's availability must be one of the offered states.", so the
     * control was offering a choice that could only ever fail. Measured before
     * the flag: PATCH /api/workspace → 400, editor left open, toast carrying
     * the API's refusal. There is no "no availability" state to express — a
     * contractor who cannot take work is Unavailable — so the blank was never
     * a value, only a way to lose a save.
     */
    { key: "availability", label: "Availability", type: "select", required: true, options: ["Available", "Limited", "Unavailable", "Inactive"].map((value) => ({ value, label: value })) },
    { key: "rating", label: "Rating (0–5)", type: "number" },
    {
      key: "active",
      label: "Active contractor",
      type: "checkbox",
      hint: "On the register, and offered when assigning work. Archiving clears this. Availability above is a separate, day-to-day state and is not changed by ticking this box.",
    },
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
    // `required`, so the select does not offer the blank "None" every optional
    // field gets. A member's role is one of three words and "" is not one of
    // them — the API refuses it, so offering it here only produced an error.
    { key: "role", label: "Role", type: "select", required: true, options: ["Super Admin", "Admin", "Client"].map((value) => ({ value, label: value })) },
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
  /*
   * BOTH states, and the canonical one first.
   *
   * This line printed `availability` alone, and the two fields behind it do not
   * mean the same thing: `active` is whether the contractor is on the register
   * at all, `availability` is whether one who IS on it can take work this week.
   * The archive verb writes them together — `active:false` AND
   * `availability:"Inactive"` — but re-ticking "Active contractor" writes only
   * `active`, so an un-archived contractor keeps the availability the archive
   * left behind. The list then read "Inactive" beside a saved, ticked Active
   * box, and an owner reasonably concluded the checkbox was not saving. It was;
   * the word on screen was reporting the other field entirely.
   *
   * Leading with Active/Archived is what stops the line contradicting the
   * canonical flag again. Keeping availability beside it — rather than letting
   * the record state stand in for it — is what makes a stale "Inactive" legible
   * as a separate field somebody still has to set.
   *
   * Availability is NAMED rather than just printed, because the pair it forms
   * with the word in front of it is otherwise its own small version of the same
   * bug: "Active · Inactive · 0 jobs" is two unlabelled states reading as one
   * contradiction, which is what sent the owner looking at the checkbox in the
   * first place. Four extra characters buy the reader the thing the old line
   * never told them — that these are two different questions about the same
   * contractor.
   */
  /*
   * `||`, not `??`, and the fallback says nothing was set rather than naming a
   * state nobody chose.
   *
   * `availability` is NOT NULL, so `??` looked safe. It is not: the column can
   * hold an EMPTY STRING — `text(null, 60)` is `""`, and until the API started
   * refusing it a `{ availability: null }` PATCH wrote one. A row in that state
   * printed "Availability: " with nothing after the colon, which reads as a
   * rendering fault rather than as a field somebody has to fix. `?? "Available"`
   * would have been worse than the blank: it would have reported an unset
   * column as the one value that means "send them work".
   */
  if (tab === "contractor") return `${record.active ? "Active" : "Archived"} · Availability: ${record.availability || "Not set"} · ${record.assignedJobs ?? 0} jobs`;
  if (tab === "planned") return `${record.siteName ?? "Unknown site"} · ${dateValue(record.nextDueAt) || "No date"}`;
  if (tab === "member") return `${record.role ?? "Client"} · ${record.active ? "Active" : "Paused"}`;
  return `${record.actorEmail ?? "Workspace"} · ${dateValue(record.createdAt)}`;
}

/**
 * WHAT THE SEARCH BOX ACTUALLY LOOKS AT.
 *
 * It looked at the two strings the list happens to PRINT — `recordTitle` and
 * `recordSubtitle` — which for a contractor is the name plus "Active ·
 * Availability: X · N jobs". Measured against the register: "Dan Intl" → 0
 * results with Dan Intl stored as the contact person; "s4intl@example.com" → 0
 * with that address on the row; "+44 7700 900123" → 0 with that number on the
 * row; "London" → 0 with London in the coverage areas. The three searches that
 * DID return something — "Electrical", "Signage", "Midlands" — matched company
 * NAMES (Saed Electrical, Johnny Signage, Midlands Glass) and not the service
 * category or the coverage area of any other contractor, which is the worst
 * kind of pass: it looks like the feature works. Meanwhile "Available" matched
 * 33 of 33 rows, because the word is in the subtitle of every one of them.
 *
 * So the haystack is widened to the fields somebody is actually holding when
 * they type: who to ask for, how to reach them, what they do, where they do it.
 * The printed line stays IN the haystack rather than being replaced by it —
 * "archived" is a real thing to search for, and it exists nowhere else.
 *
 * Phone numbers go in twice, once as typed and once as bare digits, because a
 * pasted number carries whatever spacing its source used and "+44 7700 900123"
 * should find a row stored as "+447700900123". The needle gets the same
 * treatment below. What this deliberately does NOT do is treat "07700 900123"
 * and "+44 7700 900123" as the same number: that is the country-code guess
 * `app/lib/contact-links.ts` exists to refuse, and a search that quietly
 * assumed a country would be the same mistake in a smaller box.
 *
 * Only the contractor branch is widened. The other registers have the same
 * narrowness and it is the same fix, but this is a contractor pass and a
 * change to Sites' search belongs to somebody looking at Sites.
 */
function searchText(tab: ManagerTab, record: Record<string, unknown>) {
  const printed = `${recordTitle(tab, record)} ${recordSubtitle(tab, record)}`;
  if (tab !== "contractor") return printed.toLowerCase();
  const flat = (value: unknown) =>
    Array.isArray(value) ? value.join(" ") : typeof value === "string" ? value : "";
  const numbers = [record.phone, record.whatsappNumber].map(flat).filter(Boolean);
  return [
    printed,
    flat(record.contactName),
    flat(record.email),
    ...numbers,
    ...numbers.map((value) => value.replace(/\D/g, "")),
    flat(record.serviceCategories),
    flat(record.coverageAreas),
  ]
    .join(" ")
    .toLowerCase();
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
    // A pasted number brings its own spacing. Four digits, so a search for a
    // year or a house number does not start matching phone numbers.
    const digits = needle.replace(/\D/g, "");
    return recordsFor(tab, workspace).filter((record) => {
      if (!needle) return true;
      const hay = searchText(tab, record);
      return hay.includes(needle) || (digits.length >= 4 && hay.includes(digits));
    });
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

  /*
   * KEYBOARD OWNERSHIP OF A DIALOG THAT ALREADY CLAIMED IT.
   *
   * The section below has said `role="dialog" aria-modal="true"` since it was
   * written, and none of the three things that claim implies were true.
   * Measured with the manager open, at 1440, before any of this:
   *
   *  · Opening it left focus on the "Manage contractors" button behind the
   *    scrim. Eight Tabs from there walked the CONTRACTOR TABLE — "Call … on
   *    +44 …", "Email Climate Response …", "Edit Johnny Signage" — every one of
   *    them under the scrim, none of them in the dialog. Twelve Shift+Tabs
   *    reached the topbar, the account menu and "Get help".
   *  · Escape did nothing. The dialog was still there afterwards.
   *  · Closing it dropped focus on `document.body`, so the next Tab restarted
   *    from the top of the page rather than from the control that opened this.
   *
   * `aria-modal` tells a screen reader's virtual cursor to stay inside. It does
   * not constrain the browser's focus ring, and the content behind is neither
   * `inert` nor hidden, so the tab order ran straight through it. A sighted
   * keyboard user was moving a focus ring they could not see across a page they
   * could not reach.
   *
   * Escape-closes and focus-on-open are the pattern `raise-ticket.tsx:535` and
   * `form-share-dialog.tsx:43` already use; the initial target is the dialog
   * box itself rather than a control inside it, so the first thing announced is
   * "Manage dashboard data, dialog" rather than a search field with no stated
   * context. The wrap-around and the restore are new here because no dialog in
   * this codebase had them, and this one covers the whole viewport on a phone.
   */
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    // Captured on mount, not on close: by the time the dialog is closing the
    // element that opened it is no longer `document.activeElement`.
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => {
      // `isConnected`, because the surface behind can re-render while the
      // manager is open and the opener may no longer exist to focus.
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const focusable = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
        // `offsetParent` is null for the record list once the editor takes the
        // whole width on a phone — a hidden control is not a tab stop.
      ).filter((element) => element.offsetParent !== null);

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        /*
         * ONE LAYER AT A TIME.
         *
         * Closing the whole manager on Escape gave this dialog the keyboard
         * dismissal it was missing, and took something else away with it: this
         * component edits EIGHT tabs, so a half-typed new Site — name, address,
         * manager — vanished along with the dialog on a keystroke people press
         * to dismiss an autocomplete. Nothing asked, nothing recoverable.
         *
         * With the record editor open, Escape now does exactly what its own
         * Cancel button does (`setForm(null)`): it backs out to the list and
         * leaves the manager standing. That is the layered behaviour people
         * expect from a dialog-within-a-dialog, the discard is the one the
         * Cancel button already documents, and the user is still where they
         * were. A second Escape then closes the manager, so the dismissal the
         * accessibility fix added is still one key away and the trap still has
         * its exit.
         */
        if (form) {
          setForm(null);
          return;
        }
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!dialog.current?.contains(active)) {
        // Focus escaped, or started outside — the scrim is a sibling of the
        // dialog, not a child. Pull it back rather than let the page have it.
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, form]);

  return (
    <div className="workspace-manager-layer" role="presentation">
      <button className="modal-scrim" type="button" aria-label="Close data manager" onClick={onClose} />
      <section className="workspace-manager" role="dialog" aria-modal="true" aria-labelledby="workspace-manager-title" ref={dialog} tabIndex={-1}>
        {/*
          A `div`, not a `header`.

          A bare `<header>` maps to the `banner` landmark unless it is inside an
          article, aside, main, nav or section — and `role="dialog"` on the
          section above is exactly what stops it counting as one. So this
          announced itself as a SECOND page banner alongside the topbar, which
          axe reports twice over (`landmark-no-duplicate-banner` and
          `landmark-unique`, both moderate, in light and dark). The class does
          all the styling, so nothing moves; the `h2` inside still labels the
          dialog through `aria-labelledby`.
        */}
        <div className="workspace-manager__header">
          <div>
            <span><Icon name="grid" size={18} /></span>
            <div><small>Shared workspace database</small><h2 id="workspace-manager-title">Manage dashboard data</h2></div>
          </div>
          <button className="icon-button" type="button" aria-label="Close" onClick={onClose}><Icon name="close" size={19} /></button>
        </div>
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
              {/*
                `role="presentation"` for the reason the manager's own header
                is a `div`: a bare `<header>` is scoped out of the `banner`
                landmark by an article, aside, main, nav or section, and a
                `<form>` is none of those — so this announced itself as a third
                page banner and axe reported `landmark-no-duplicate-banner`
                against `form > header` in both themes. The role is dropped
                rather than the element, because the two CSS rules that size
                this bar and its `small` both select on `header`, and moving the
                markup to keep an unwanted landmark out would be a restyle. The
                `h3` inside keeps its own role either way.
              */}
              <header role="presentation"><div><small>{editorId ? "Edit shared record" : "Create shared record"}</small><h3>{editorId ? "Update details" : `New ${tabs.find((item) => item.key === tab)?.label.slice(0, -1) || "record"}`}</h3></div><button className="icon-button" type="button" aria-label="Close editor" onClick={() => setForm(null)}><Icon name="close" size={17} /></button></header>
              <div className="workspace-record-editor__fields">
                {fields.map((field) => {
                  const value = form[field.key] ?? (field.type === "checkbox" ? false : "");
                  if (field.type === "checkbox") return (
                    /*
                      A NAME AND A DESCRIPTION, not one 180-character name.
                      The wrapping label gives a checkbox the whole of its text
                      content as its accessible name, and this label carries the
                      hint that stops "Active contractor" being read as the
                      Availability select two rows above. Measured: 180
                      characters, all of it announced on focus before the state.
                      `aria-label` keeps the name to the four words on the line;
                      `aria-describedby` hands the sentence over as the
                      description it always was. The visible text is unchanged
                      and the label still toggles on click.
                    */
                    <label className="workspace-checkbox" key={field.key}><span><strong>{field.label}</strong><small id={`workspace-field-${field.key}-hint`}>{field.hint ?? "Available in the shared testing workspace"}</small></span><input type="checkbox" aria-label={field.label} aria-describedby={`workspace-field-${field.key}-hint`} checked={Boolean(value)} onChange={(event) => setForm((current) => current ? { ...current, [field.key]: event.target.checked } : current)} /></label>
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
