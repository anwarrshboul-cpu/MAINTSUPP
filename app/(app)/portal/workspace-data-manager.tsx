"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../../components";
import { storeDocumentationKinds } from "../../../db/monday-board-spec";
import { MondayImportPanel } from "./monday-import-panel";
/*
 * W05-05 and W05-07 — the Sites tab edits the same three state columns the
 * Sites register does, so it uses the same two rules: one confirmation before a
 * site leaves the active roster, and one vocabulary for the lifecycle words.
 * Neither may be restated here; that is how the two screens came to disagree.
 */
import { confirmSiteClosure } from "./sites/site-closure";
/*
 * W06-04 — the contractor equivalent, and for the same reason: the Archive
 * button and the "Active contractor" tick box both take somebody off the
 * assignment roster and only one of them used to ask. The words and the
 * reasoning live in contractor-closure.ts so both doors say the same thing.
 */
import { confirmContractorRosterExit, leavesContractorRoster } from "./contractor-closure";
import { SITE_LIFECYCLE_CLOSED, SITE_LIFECYCLES } from "../../lib/site-state";
import { expiryStatus } from "../../lib/expiry-status";
/*
 * W2C — the provenance block the two aggregate reads stamp on every record.
 *
 * `import type`, so nothing of `register-scope.ts` — drizzle, the schema, the
 * database handle — is pulled into the browser bundle. The type is imported
 * rather than restated because a second copy of this shape is a second answer
 * to "what does the server promise about a record's register", and the whole
 * point of the block is that the screen and the route agree about it.
 */
import type { RecordProvenance } from "../../lib/register-scope";
import type {
  WorkspaceCertification,
  WorkspaceEntity,
  WorkspaceSnapshot,
} from "../../lib/workspace-data";

type ManagerTab = Exclude<WorkspaceEntity, "settings"> | "activity" | "import";
/**
 * W06-08 — one certification row while it is being edited.
 *
 * Everything is a string because everything is bound to an input; the route
 * turns "" back into null. `id` is carried through so an ordinary save is an
 * UPDATE of the row that already exists rather than a delete and a re-create —
 * a new line simply arrives with `id: ""`.
 */
type EditorCertification = {
  id: string;
  name: string;
  reference: string;
  issuedOn: string;
  expiresOn: string;
};
/*
 * The array arm is W06-08's. Every other field on every other tab is a string
 * or a tick box, and widening the union rather than smuggling a JSON string
 * through one is what keeps the certifications editor type-checked instead of
 * parsed.
 */
type EditorValue = string | boolean | EditorCertification[];
type EditorData = Record<string, EditorValue>;

type FieldDefinition = {
  key: string;
  label: string;
  /**
   * `multiselect` renders the option set as tick boxes over a comma-separated
   * string — the shape `stringArray` on the route already reads, so nothing
   * about the wire format changes. `certifications` renders the W06-08
   * repeater, which is the one control here that edits a list of records.
   */
  type?: "text" | "email" | "tel" | "number" | "date" | "textarea" | "select" | "checkbox" | "multiselect" | "certifications";
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
  // `type` starts EMPTY and is filled from the configured `site_type` list in
  // `startNew`. It was the literal "Kiosk", which is a seeded option and not a
  // guaranteed one — a workspace that renamed or removed it opened the New Site
  // form on a type the route would refuse.
  site: { name: "", type: "", region: "UK", lifecycle: "Current", address: "", manager: "" },
  compliance: { siteId: "", kind: "", state: "Missing", expiry: "" },
  unit: { siteId: "", name: "", category: "Asset", manufacturer: "", model: "", serialNumber: "", status: "Active", notes: "" },
  /*
   * W06-06/07/08/09 — every commercial field starts EMPTY, and deliberately so.
   *
   * A blank money box is "no rate agreed", which is not a rate of £0 — the
   * route stores null and the register prints a dash, because "£0.00" reads as
   * "they work for free". The same argument retired the form's old pre-filled
   * `rating: "4"`, which rated every contractor four fifths on behalf of
   * somebody who had never assessed them.
   */
  contractor: { name: "", contactName: "", email: "", phone: "", whatsappNumber: "", address: "", postcode: "", serviceCategories: "", coverageAreas: "UK", certifications: "", certificationEntries: [], insuranceExpiry: "", insurerName: "", policyNumber: "", insuranceNotes: "", dayRate: "", hourlyRate: "", callOutCost: "", otherCost: "", otherCostLabel: "", paymentTerms: "", financeReference: "", availability: "Available", rating: "", active: true, notes: "" },
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

/**
 * `assignedContractorId` — the contractor the record being edited is ALREADY
 * assigned to, which is not always somebody the list would offer.
 *
 * See `contractorOptions` below. Absent when nothing is open, and absent from
 * the keys-only call in `recordToEditor`, which is why it is optional.
 */
function fieldsFor(
  tab: Exclude<ManagerTab, "activity">,
  workspace: WorkspaceSnapshot,
  assignedContractorId?: string | null,
  /**
   * W05-07 — the CONFIGURED site types, from `option_values`.
   *
   * The Sites tab's Type select was the literal `["Kiosk", "Inline", "Office",
   * "Warehouse"]`, and `POST /api/sites` validates the same field against the
   * `site_type` option list (`validateOption`) — so the two screens that edit
   * one column disagreed about what its legal values are, and an admin who
   * added a fifth type in Settings could use it on one of them. That is the
   * exact restriction the options registry exists to remove.
   *
   * Optional, and empty until the fetch lands. `recordToEditor` calls this for
   * the KEYS only and passes nothing; the keys do not depend on the values.
   */
  siteTypes: Array<{ value: string; label: string }> = [],
  /**
   * W06-06 and W06-09 — the CONFIGURED contractor vocabularies, from
   * `option_values`.
   *
   * `contractor_trade` replaces the free-text Service categories box and
   * `contractor_payment_terms` is the controlled half of the approved payment
   * model. Both are validated by `PATCH /api/workspace` against the same two
   * sets, so this is one list read by the screen and the route rather than two
   * lists that happen to agree — the exact restriction the options registry
   * exists to remove, and the same arrangement `siteTypes` above got.
   *
   * Optional and empty until the fetch lands, for the reason `siteTypes` is:
   * `recordToEditor` calls this for the KEYS only and passes nothing, and the
   * keys do not depend on the values. An empty trade list still renders the
   * values this contractor already holds — see the `multiselect` branch.
   */
  contractorTrades: Array<{ value: string; label: string }> = [],
  contractorPaymentTerms: Array<{ value: string; label: string }> = [],
): FieldDefinition[] {
  const siteOptions = workspace.stores.map((site) => ({ value: site.id, label: site.name }));
  const unitOptions = [{ value: "", label: "No linked unit" }, ...workspace.units.map((unit) => ({ value: unit.id, label: unit.name }))];
  /*
   * WHO MAY BE ASSIGNED, plus WHOEVER IS ALREADY ASSIGNED.
   *
   * The first half is the membership rule and it is `active` alone, which is
   * what the Active checkbox's own hint below promises a person reading it:
   * "on the register, and offered when assigning work". `availability` is
   * deliberately NOT consulted — it is the day-to-day answer to "can they take
   * work this week", nothing in the product filters on it, and this select
   * schedules PLANNED work whose `nextDueAt` is routinely months away. Somebody
   * who is Unavailable today is a perfectly good choice for March.
   *
   * The second half is the bug that rule had. Archiving a contractor correctly
   * takes them off the list — and a planned task ALREADY assigned to them keeps
   * pointing at them, as it must: `referencesRefusal` in the workspace API
   * checks the id and the organisation and deliberately not `active`, because
   * refusing an archived id would make that task unsavable for ever. So the
   * select was rendering `value="<archived id>"` against options that did not
   * contain it. `selectedIndex` goes to -1 and the field shows BLANK on a task
   * that is assigned — measured on a fixture: the payload still carried
   * `contractorName: "ZZQA-CLOSURE-C1-AVAIL"` while the form showed nothing,
   * and any save made from that screen was one careless click away from
   * silently reassigning the task to "No contractor".
   *
   * Keeping the current value as an option is what this file already does for
   * a compliance requirement recorded under a name the canonical list does not
   * have (see `kind` below) — same problem, same answer. The suffix is there
   * because "offered to everyone" and "still shown because you already picked
   * them" must not read as the same thing.
   */
  const assignableContractors = workspace.contractors.filter((item) => item.active);
  const assignedElsewhere =
    assignedContractorId &&
    !assignableContractors.some((item) => item.id === assignedContractorId)
      ? workspace.contractors.find((item) => item.id === assignedContractorId)
      : null;
  const contractorOptions = [
    { value: "", label: "No contractor" },
    ...assignableContractors.map((item) => ({ value: item.id, label: item.name })),
    ...(assignedElsewhere
      ? [{ value: assignedElsewhere.id, label: `${assignedElsewhere.name} (archived)` }]
      : []),
  ];
  if (tab === "site") return [
    { key: "name", label: "Site name", required: true },
    /*
     * THE CONFIGURED LIST, PLUS WHATEVER THIS ROW ALREADY HOLDS.
     *
     * The second half is the same rule the Requirement select below already
     * applies: a value the registry does not offer is still shown while it is
     * the one saved, so opening a legacy row does not silently rewrite its type
     * to whichever option happens to sort first. Without it a `<select>` whose
     * value matches no option renders BLANK and one careless Save reassigns the
     * record — measured on the contractor select two tabs down, which is why
     * that one carries the same guard.
     */
    {
      key: "type",
      label: "Type",
      type: "select",
      options: siteTypes,
    },
    /*
     * FREE TEXT, DELIBERATELY, and this is a narrowing rather than a widening.
     *
     * It was a three-item select — UK, Europe, Other — and `region` is not one
     * of the option tables: there is no `site_region` list for an admin to
     * edit, and `app/(app)/portal/sites/site-form.tsx` says in its own comment
     * why it refuses to invent one here. Two screens edit this column and one
     * of them offered a vocabulary the other does not enforce, so a region
     * typed on the Sites form ("EMEA") could not be seen, kept or re-saved from
     * this tab: opening the record showed an empty select and saving wrote
     * whichever value the user picked instead. The hint names the values
     * already in the data, which is the honest version of the same guidance.
     */
    {
      key: "region",
      label: "Region",
      placeholder: "UK",
      hint: "How the portfolio is split for reporting. Existing sites use UK or Europe.",
    },
    /*
     * The two lifecycle words come from `SITE_LIFECYCLES`, which is also what
     * `PATCH /api/workspace` validates against. They were a literal here and
     * the route validated NOTHING, so the pair could not be checked against
     * each other at all — see app/lib/site-state.ts for what got stored.
     */
    {
      key: "lifecycle",
      label: "Lifecycle",
      type: "select",
      options: SITE_LIFECYCLES.map((value) => ({ value, label: value })),
    },
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
    /*
     * W06-06 — the postcode, as its own field.
     *
     * `address` is one free-text line, so nothing could sort, search or map on
     * where a contractor is. OPTIONAL, and not format-checked against a UK
     * pattern either here or on the route: the product admits non-UK
     * contractors — `coverageAreas` is full of "Europe" — so "75008" and
     * "1012 AB" are as legitimate as "SW1A 1AA", and a UK regex would refuse
     * them in a way that reads as a broken form rather than as a policy.
     */
    { key: "postcode", label: "Postcode", placeholder: "SW1A 1AA", hint: "Optional. Non-UK postal codes are accepted as typed." },
    /*
     * W06-06 — TRADES, FROM THE OPTION SET, not a comma box.
     *
     * This was free text, so "Electrical", "electrical" and " ElectRical" were
     * three trades: the register counted three, a filter on one found none of
     * the others, and the public application form — which offers exactly eleven
     * fixed trades — could not be matched against the register at all.
     * `contractor_trade` is seeded with those same eleven, verbatim and in the
     * form's order, so an applicant and a coordinator mean the same thing by
     * "Glazing".
     *
     * A value already stored that the set does not offer is still shown, still
     * ticked, and marked "(not configured)" — the same rule the Requirement
     * select above applies to a compliance record filed under a name the
     * canonical list has lost. Nothing is silently dropped; see
     * `contractorTradeValues` in the workspace API for the other half.
     */
    {
      key: "serviceCategories",
      label: "Trades",
      type: "multiselect",
      options: contractorTrades,
      hint: "The same eleven trades the public application form offers, so an applicant and the register mean the same thing.",
    },
    { key: "coverageAreas", label: "Coverage areas", placeholder: "UK, London, Midlands" },
    /*
     * The legacy names array. KEPT, and kept editable, because it is what every
     * contractor imported before certificates had dates of their own still
     * holds — removing the box would make that data unreachable rather than
     * migrated. The dated list below is where anything with an expiry belongs.
     */
    { key: "certifications", label: "Other certifications", placeholder: "Comma-separated", hint: "Names only, with no dates. Anything that expires belongs in the list below, where it can be tracked." },
    /*
     * W06-08 — certifications as ENTRIES, each with its own expiry.
     *
     * One `insurance_expiry` for a whole contractor could never answer "is
     * their gas ticket still valid". Each row here carries its own date and the
     * STATUS IS DERIVED from it by `expiryStatus` — the platform's one
     * classifier, at the platform's one 60-day amber threshold — so a
     * contractor's ticket and a store's certificate cannot mean different
     * things by "due soon".
     */
    { key: "certificationEntries", label: "Certifications with expiry dates", type: "certifications" },
    /*
     * W06-08 — the insurer and the policy, beside the date.
     *
     * The expiry alone can say WHEN cover ends and never WHAT ended, which is
     * why chasing a lapsed contractor used to start with a phone call asking
     * who their broker was. The date is now validated as a real calendar date
     * on both create and edit; it used to accept any forty characters.
     */
    { key: "insurerName", label: "Insurer", placeholder: "Who the cover is with" },
    { key: "policyNumber", label: "Policy number" },
    { key: "insuranceExpiry", label: "Insurance expiry", type: "date" },
    { key: "insuranceNotes", label: "Insurance notes", type: "textarea", placeholder: "Level of cover, exclusions, anything a claim would turn on" },
    /* Pounds here, pence in the column — see `ratePence` in the workspace API.
       Left empty it stays null, because no recorded rate is not a rate of £0. */
    { key: "dayRate", label: "Day rate (£)", type: "number", placeholder: "e.g. 320" },
    /*
     * W06-07 — the rest of the agreed rate card, all of it in pounds here and
     * integer pence in the column, all of it optional.
     *
     * AGREED TERMS, not money spent. Nothing sums these: spend is computed from
     * job cost alone, and `app/lib/contractor-attribution.ts` is pinned by test
     * never to name a rate column. `otherCostLabel` is what makes the figure
     * beside it legible — a number with no name is not a cost — and it is a
     * field of its own rather than a sentence in Notes, because a label buried
     * in prose is a label no column, filter or report can read.
     */
    { key: "hourlyRate", label: "Hourly rate (£)", type: "number", placeholder: "e.g. 65" },
    { key: "callOutCost", label: "Call-out cost (£)", type: "number", placeholder: "e.g. 85" },
    { key: "otherCost", label: "Other cost (£)", type: "number", placeholder: "e.g. 40" },
    { key: "otherCostLabel", label: "Other cost is for", placeholder: "Standby, congestion charge, parking…" },
    /*
     * W06-09 — TERMS, and a pointer at the ledger that holds the rest.
     *
     * THE APPROVED MODEL, AND ITS BOUNDARY. There is no bank account number,
     * sort code, IBAN or card field here, on the `contractors` table, or on the
     * route that writes it, and none may be added — a maintenance portal
     * holding payment credentials is a breach waiting for its first
     * misconfigured backup. `financeReference` points at the supplier record in
     * Xero, Sage, QuickBooks or an internal ledger, which is the system built
     * to hold them.
     */
    {
      key: "paymentTerms",
      label: "Payment terms",
      type: "select",
      options: contractorPaymentTerms,
      hint: "From the configured terms. Add a new one in Settings if the agreement is not listed.",
    },
    { key: "financeReference", label: "Finance reference", placeholder: "Supplier code in Xero, Sage or QuickBooks", hint: "An external reference only. Never record bank, sort code, IBAN or card details here." },
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

/**
 * W2C — WHERE A RECORD CAME FROM, read off the record and never off its name.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * "Manage dashboard data" is the workspace's INVENTORY, and it was showing the
 * canonical registers alone. On the live Preview that meant three contractors
 * listed and two missing — both created inside a custom Contractors section,
 * both real, and nothing on screen to say anything was absent. Sites had the
 * same hole. The fix is the two aggregate reads (`?registers=custom`), and the
 * moment records from several registers share one list they have to say which
 * one they came from, or the list becomes a set of duplicates nobody can tell
 * apart.
 *
 * ── WHY IT IS A BLOCK ON THE RECORD AND NOT A GUESS ───────────────────────
 *
 * The server stamps `register` on every aggregated record from the row's own
 * `board_id`. Two registers may legitimately hold one name — Contractors Alpha
 * and Contractors Beta may both have a "John Ltd", and the owner's own data
 * already has two contractors called "test", one canonical and one in a section
 * — so a name tells you nothing about which register a record is in. Nothing
 * here parses a name, a title or a URL.
 *
 * Canonical records have no block, or a block that says so, and are shown
 * without a badge: the workspace's own register is the unmarked default, and
 * badging every row would make the exception invisible again.
 */
function recordProvenance(record: Record<string, unknown>): RecordProvenance | null {
  const block = record.register;
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const value = block as Partial<RecordProvenance>;
  return value.isCustom === true ? (value as RecordProvenance) : null;
}

/**
 * The words. `(Custom · <Section Name>)`, following the section's CURRENT
 * display name because the server reads `workspace_sections.label` on every
 * request — rename a section and its records relabel themselves.
 *
 * The fallback is for a record whose register resolved to no live section: an
 * orphan, which `scopedRegisterRows` exists to prevent and which the aggregate
 * cannot currently produce. It says what is true rather than inventing a name,
 * because a made-up section name here would be exactly the display-name
 * isolation the model rules out, arrived at from the other end.
 */
function provenanceLabel(provenance: RecordProvenance) {
  return `(Custom · ${provenance.sectionDisplayName ?? "register not listed"})`;
}

/**
 * A site from the aggregate, wearing the two fields the snapshot derives.
 *
 * `GET /api/sites` answers with the `sites` ROW, which is right for the Sites
 * register; the workspace snapshot answers with `StoreRecord`, which resolves
 * `type` through the configured option value and prints "Unassigned" for a site
 * with no manager. This list draws both halves with one `recordTitle` and one
 * `recordSubtitle`, so without these two lines a custom site would show its
 * legacy type beside a canonical site showing its configured one, and an empty
 * Manager box would open where the canonical row shows a word.
 *
 * Only the fields THIS SCREEN reads are reconciled. Nothing here is injected
 * into `workspace.stores`: that list feeds the Compliance, Units and Planned
 * tabs' site pickers, and a picker is an assignment surface rather than an
 * inventory — offering another register's site there would attach a job to a
 * site the job's own register does not hold.
 */
function customSiteRecord(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    type: row.siteTypeValue ?? row.type,
    manager: row.manager ?? "Unassigned",
  };
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

/**
 * W06-08 — THE HALF OF AN EXPIRY DATE THAT WAS MISSING: SOMEBODY SEEING IT.
 *
 * `insurance_expiry` has been on this record since the beginning and appeared
 * NOWHERE except the edit form. No register column, no chip, no digest, no
 * alert — so a contractor's public liability could lapse and the only way to
 * find out was to open their record and read a date box. A field that is stored
 * and never surfaced is not a compliance control; it is a note.
 *
 * The state is preferred from the payload (`insuranceState`, classified once on
 * the server against one instant) and only DERIVED here when it is absent —
 * `app/lib/mock-data.ts` builds these records too and has no classifier behind
 * them. Either way the verdict is `expiryStatus`, the platform's one
 * classifier at its one 60-day amber threshold, so this line and the
 * certificate chips in the editor cannot disagree.
 *
 * Worst-first, and at most one phrase: this sits at the end of a list subtitle
 * that already carries three facts, and a row that says four things says none
 * of them. Expired outranks due-soon, and insurance outranks a certificate
 * because it is the one that stops a contractor being sent to site at all.
 * Silence means nothing is expiring, which is the common case and should cost
 * the reader nothing.
 */
function contractorExpiryWarning(record: Record<string, unknown>) {
  const insurance =
    typeof record.insuranceState === "string"
      ? record.insuranceState
      : expiryStatus(typeof record.insuranceExpiry === "string" ? record.insuranceExpiry : null)
          .state;
  const entries = Array.isArray(record.certificationEntries)
    ? (record.certificationEntries as WorkspaceCertification[])
    : [];
  const counted = (state: string) =>
    entries.filter(
      (entry) => (entry.expiryState ?? expiryStatus(entry.expiresOn).state) === state,
    ).length;
  const certificates = (count: number, word: string) =>
    ` · ${count} certificate${count === 1 ? "" : "s"} ${word}`;
  if (insurance === "expired") return " · Insurance expired";
  const expired = counted("expired");
  if (expired) return certificates(expired, "expired");
  if (insurance === "due-soon") return " · Insurance due soon";
  const dueSoon = counted("due-soon");
  if (dueSoon) return certificates(dueSoon, "due soon");
  return "";
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
  if (tab === "contractor") return `${record.active ? "Active" : "Archived"} · Availability: ${record.availability || "Not set"} · ${record.assignedJobs ?? 0} jobs${contractorExpiryWarning(record)}`;
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
  /*
   * W2C — the provenance line is IN the haystack, on every tab.
   *
   * It is printed, and this function's own note says the printed line stays in
   * the haystack because "archived" is a real thing to search for and exists
   * nowhere else. A section name is the same kind of thing: "show me everything
   * in North Region Contractors" is the question an owner asks of an inventory
   * that spans registers, and it has no other answer on this screen.
   */
  const custom = recordProvenance(record);
  const provenance = custom ? ` ${provenanceLabel(custom)}` : "";
  const printed = `${recordTitle(tab, record)} ${recordSubtitle(tab, record)}${provenance}`;
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
    // W06-06. The postcode is the field somebody holds when they are asking
    // "who do we already use near here", and it did not exist when the haystack
    // above was widened. Omitting it would repeat the exact bug that note
    // describes: a search that looks like it works.
    flat(record.postcode),
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
  /*
   * W06-07 — the same round trip for the three costs that joined it.
   *
   * Every one of these is pounds in the box and pence in the column, so the
   * plain key copy above finds none of them and the box would open empty on a
   * contractor whose rate card is filled in — after which one Save would wipe
   * all three. The day rate is stated on its own line above rather than folded
   * into this loop because a test pins that line as the proof this round trip
   * exists at all; the reasoning is identical.
   */
  if (tab === "contractor") {
    for (const [box, column] of [
      ["hourlyRate", "hourlyRatePence"],
      ["callOutCost", "callOutCostPence"],
      ["otherCost", "otherCostPence"],
    ] as const) {
      if (!(box in selected)) continue;
      const pence = record[column];
      selected[box] = typeof pence === "number" ? String(pence / 100) : "";
    }
  }
  /*
   * W06-08 — the certifications are RECORDS, not a string.
   *
   * Lifted out before `editorData`, whose `stringify` joins an array with
   * commas and would render each entry as "[object Object]", and put back
   * afterwards as the typed list the repeater binds to. `id` is carried so an
   * ordinary save updates the row that already exists instead of deleting and
   * re-creating it; a line added in the editor arrives with `id: ""`.
   */
  const certifications: EditorCertification[] =
    tab === "contractor"
      ? ((record.certificationEntries as WorkspaceCertification[] | undefined) ?? []).map(
          (entry) => ({
            id: entry.id,
            name: entry.name,
            reference: entry.reference ?? "",
            issuedOn: dateValue(entry.issuedOn),
            expiresOn: dateValue(entry.expiresOn),
          }),
        )
      : [];
  delete selected.certificationEntries;
  const editor = editorData(selected, ["expiry", "insuranceExpiry", "nextDueAt", "lastCompletedAt"]);
  if (tab === "contractor") editor.certificationEntries = certifications;
  return editor;
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
  /*
   * W2C — WHICH REGISTER THE OPEN RECORD BELONGS TO.
   *
   * Held beside the form rather than re-derived from the list, because the list
   * can be re-filtered, re-sorted and reloaded while the editor is open and the
   * record being edited must not change register underneath it. Null means the
   * canonical register, which is every record the snapshot supplied and every
   * record this screen creates.
   *
   * `initialRecordId` resolves against `recordsFor(initialTab, workspace)` —
   * the snapshot — so a deep link from the contractor drawer always opens a
   * canonical record and starts here at null, unchanged.
   */
  const [editorRegister, setEditorRegister] = useState<RecordProvenance | null>(null);
  /*
   * The reason a scoped save failed, on the editor rather than in a toast.
   *
   * The canonical path throws to `saveWorkspaceRecord`, which puts the API's
   * message in the dashboard toast. A scoped write does not go through it, so
   * without this a refusal — a section archived in another tab, a record moved
   * — would be swallowed by the same `catch {}` and the editor would simply not
   * close, which reads as the button not working.
   */
  const [scopedProblem, setScopedProblem] = useState<string | null>(null);
  const [scopedBusy, setScopedBusy] = useState(false);

  /*
   * ── W2C: WHAT THIS WORKSPACE HOLDS IN ITS OTHER REGISTERS ──────────────
   *
   * The snapshot in `workspace` is the CANONICAL registers and has always been
   * exactly that, deliberately — it has thirteen consumers and every one of
   * them means the workspace's own Sites and Contractors. This screen is the
   * one that means something wider: it is the inventory, so a contractor
   * created inside "North Region Contractors" belongs on it.
   *
   * Two requests, both `registers=custom`, both answered SERVER-SIDE against
   * the sections this organisation owns. `custom` rather than `all` because the
   * canonical rows are already in `workspace` and asking twice would put two
   * answers to one question on one screen — and because appending is the only
   * merge that leaves the existing list byte-identical when there are no
   * instances at all.
   *
   * `archived=all` on the contractor read matches the snapshot, which carries
   * inactive contractors so this screen can print "Archived" beside them; the
   * site aggregate includes closed sites for the same reason. Filtering to the
   * active ones here would make the two halves of one list obey different
   * rules, which is worse than either rule.
   */
  const [customRecords, setCustomRecords] = useState<{
    site: Array<Record<string, unknown>>;
    contractor: Array<Record<string, unknown>>;
  }>({ site: [], contractor: [] });
  /*
   * A FAILED AGGREGATE IS SAID OUT LOUD. The defect being fixed here is a list
   * that was silently short; falling back to the canonical rows without saying
   * so would reproduce it exactly, one layer further in.
   */
  const [aggregateProblem, setAggregateProblem] = useState<string | null>(null);
  /* Bumped after a scoped write, so the custom half of the list reloads. The
     canonical half is refreshed by the dashboard, which owns the snapshot. */
  const [aggregateToken, setAggregateToken] = useState(0);

  useEffect(() => {
    let live = true;
    const read = async (url: string, key: "contractors" | "sites") => {
      const response = await fetch(url);
      const payload = (await response.json()) as {
        error?: string;
        contractors?: Array<Record<string, unknown>>;
        sites?: Array<Record<string, unknown>>;
      };
      if (!response.ok) throw new Error(payload.error || "Register unavailable.");
      const rows = key === "contractors" ? payload.contractors : payload.sites;
      return Array.isArray(rows) ? rows : [];
    };
    void (async () => {
      try {
        const [contractorRows, siteRows] = await Promise.all([
          read("/api/contractors?registers=custom&archived=all", "contractors"),
          read("/api/sites?registers=custom", "sites"),
        ]);
        if (!live) return;
        setCustomRecords({
          contractor: contractorRows,
          site: siteRows.map(customSiteRecord),
        });
        setAggregateProblem(null);
      } catch {
        if (!live) return;
        setCustomRecords({ site: [], contractor: [] });
        setAggregateProblem(
          "Records held in this workspace's other registers could not be loaded, so this list is showing the workspace's own registers only.",
        );
      }
    })();
    return () => {
      live = false;
    };
  }, [aggregateToken]);

  const records = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // A pasted number brings its own spacing. Four digits, so a search for a
    // year or a house number does not start matching phone numbers.
    const digits = needle.replace(/\D/g, "");
    /*
     * ONE ALPHABETICAL INVENTORY, not two lists stacked.
     *
     * Both halves already arrive ordered by name — the snapshot orders by
     * `sites.name` and `contractors.name`, and so do the aggregate reads — so
     * re-sorting the union is what keeps a custom "Apex" next to a canonical
     * one instead of forty rows below it. `localeCompare` at base sensitivity
     * matches how a person reads a list rather than how bytes sort.
     *
     * With no instances the extra list is empty and the pool is the same array
     * `recordsFor` returned, in the same order, which is what makes this change
     * invisible to a workspace that has not created a section.
     */
    const extra =
      tab === "contractor"
        ? customRecords.contractor
        : tab === "site"
          ? customRecords.site
          : [];
    const pool = extra.length
      ? [...recordsFor(tab, workspace), ...extra].sort((first, second) =>
          recordTitle(tab, first).localeCompare(recordTitle(tab, second), undefined, {
            sensitivity: "base",
          }),
        )
      : recordsFor(tab, workspace);
    return pool.filter((record) => {
      if (!needle) return true;
      const hay = searchText(tab, record);
      return hay.includes(needle) || (digits.length >= 4 && hay.includes(digits));
    });
  }, [query, tab, workspace, customRecords]);
  const readOnlyTab = tab === "activity" || tab === "import";

  /*
   * W05-07 — the configured site types, fetched once.
   *
   * `WorkspaceSnapshot` does not carry the option registry and there is no
   * reason for it to: this is the only tab that needs one list, and the Sites
   * screen fetches its own the same way (`/api/options?key=access_method` in
   * sites-manager.tsx). A failure leaves the array empty rather than falling
   * back to a hardcoded list — the empty select is visible and asks a question;
   * a stale literal silently disagrees with the route that validates it.
   */
  const [siteTypes, setSiteTypes] = useState<Array<{ value: string; label: string }>>([]);
  /*
   * W06-06 and W06-09 — the two contractor vocabularies, fetched the same way
   * and for the same reason. `contractor_trade` replaces the free-text Service
   * categories box; `contractor_payment_terms` is the controlled half of the
   * approved payment model. `PATCH /api/workspace` validates against these same
   * two sets, so the screen and the route read one list rather than agreeing by
   * coincidence.
   */
  const [contractorTrades, setContractorTrades] = useState<Array<{ value: string; label: string }>>([]);
  const [paymentTerms, setPaymentTerms] = useState<Array<{ value: string; label: string }>>([]);
  useEffect(() => {
    let live = true;
    /*
     * One reader for all three lists.
     *
     * A failure leaves the array empty rather than falling back to a hardcoded
     * list — the empty select is visible and asks a question; a stale literal
     * silently disagrees with the route that validates it. The trades control
     * degrades further and better than a select can: with no options it still
     * renders whatever this contractor already holds, so a fetch that never
     * lands cannot make an existing record look blank.
     */
    const load = async (
      key: string,
      apply: (values: Array<{ value: string; label: string }>) => void,
    ) => {
      try {
        const response = await fetch(`/api/options?key=${key}`);
        if (!response.ok) return;
        const payload = (await response.json()) as {
          values?: Array<{ value: string; label: string; active?: boolean }>;
        };
        if (!live) return;
        apply(
          (payload.values ?? [])
            .filter((option) => option.active !== false)
            .map((option) => ({ value: option.value, label: option.label })),
        );
      } catch {
        // Offline or refused. The select stays empty and says so.
      }
    };
    void load("site_type", setSiteTypes);
    void load("contractor_trade", setContractorTrades);
    void load("contractor_payment_terms", setPaymentTerms);
    return () => {
      live = false;
    };
  }, []);

  /*
   * The open record's own contractor is handed to `fieldsFor` so the select can
   * keep showing somebody who has since been archived. `form` rather than the
   * record, because it is the value the control is actually bound to.
   */
  const fields = readOnlyTab
    ? []
    : fieldsFor(
        tab,
        workspace,
        typeof form?.contractorId === "string" ? form.contractorId : null,
        /*
         * The value this row already holds is kept as an option even when the
         * registry no longer offers it — otherwise a `<select>` bound to an
         * unlisted type renders blank and the next Save rewrites the column.
         */
        tab === "site" && typeof form?.type === "string" && form.type
          && !siteTypes.some((option) => option.value === form.type)
          ? [...siteTypes, { value: form.type, label: `${form.type} (not configured)` }]
          : siteTypes,
        contractorTrades,
        /*
         * Same guard as the site type above, one control down. A payment term
         * this contractor already holds that the registry no longer offers
         * stays selectable, so opening the record does not render a blank
         * select and let the next Save rewrite an agreement nobody discussed.
         */
        typeof form?.paymentTerms === "string" && form.paymentTerms
          && !paymentTerms.some((option) => option.value === form.paymentTerms)
          ? [...paymentTerms, { value: form.paymentTerms, label: `${form.paymentTerms} (not configured)` }]
          : paymentTerms,
      );
  const activeTabLabel = tabs.find((item) => item.key === tab)?.label ?? "records";

  const startNew = () => {
    if (readOnlyTab) return;
    const defaults = { ...emptyDefaults[tab] };
    if ("siteId" in defaults && !defaults.siteId) defaults.siteId = workspace.stores[0]?.id ?? "";
    // The workspace's own first site type, the same way the site above is the
    // workspace's own first site. See `emptyDefaults`.
    if (tab === "site" && !defaults.type) defaults.type = siteTypes[0]?.value ?? "";
    setEditorId(null);
    setForm(defaults);
    /*
     * NEW RECORDS ARE CANONICAL, and that is the existing policy stated rather
     * than changed. This screen is the workspace's own register manager; a
     * section's register is created from inside that section, which is where an
     * owner is when they mean "add one of these to THIS list". Defaulting a
     * creation here into whichever register happened to be highlighted would be
     * the kind of implicit scope the model exists to remove.
     */
    setEditorRegister(null);
    setScopedProblem(null);
  };

  const editRecord = (record: Record<string, unknown>) => {
    if (readOnlyTab) return;
    setEditorId(String(record.id));
    setForm(recordToEditor(tab, record));
    /* The register travels with the record, from the server's own block. This
       is what a save and an archive are routed by — never the name printed
       above them, and never the section the dashboard happens to be showing. */
    setEditorRegister(recordProvenance(record));
    setScopedProblem(null);
  };

  /**
   * THE STORED RECORD BEHIND THE OPEN EDITOR, wherever this workspace keeps it.
   *
   * The two closure confirmations compare the FORM against what is STORED —
   * "is this save the one that takes them off the roster" — and both used to
   * look only in the snapshot. With custom records on the list that lookup
   * misses them, `stored` comes back undefined, and both guards fall silent:
   * closing a custom site or unticking a custom contractor's Active box would
   * go straight through with no question asked, which is the exact defect
   * W05-05 and W06-04 were written to close, reappearing on the rows they never
   * covered.
   *
   * Normalised to the three fields the guards read, so a snapshot record and an
   * aggregate record are compared the same way rather than by whichever shape
   * each half happens to have.
   */
  const storedRecordFor = (entity: "site" | "contractor") => {
    if (!editorId) return undefined;
    const canonical =
      entity === "site"
        ? (workspace.stores as unknown as Array<Record<string, unknown>>)
        : (workspace.contractors as unknown as Array<Record<string, unknown>>);
    const custom = entity === "site" ? customRecords.site : customRecords.contractor;
    const found = [...canonical, ...custom].find((item) => item.id === editorId);
    if (!found) return undefined;
    return {
      name: String(found.name ?? ""),
      lifecycle: typeof found.lifecycle === "string" ? found.lifecycle : "",
      active: Boolean(found.active),
    };
  };

  /**
   * A WRITE THAT NAMES THE REGISTER IT IS AIMED AT — W2C.
   *
   * ── WHY IT IS NOT `onSave` ────────────────────────────────────────────────
   *
   * `onSave` and `onArchive` post to `/api/workspace`, and the dashboard picks
   * that URL from the section it is CURRENTLY SHOWING. That is right for the
   * canonical rows and wrong for these: this screen can be opened from the job
   * board and still list a contractor that lives in "North Region Contractors",
   * and a write routed by the surface behind the modal would land in the
   * canonical register — creating or editing the wrong record entirely, which
   * is the isolation failure this workstream exists to prevent.
   *
   * ── WHAT IT CARRIES ───────────────────────────────────────────────────────
   *
   * The record's ID and the SECTION KEY the server stamped on it. Not the name,
   * not the label a person reads: `resolveRegisterScope` re-resolves that key
   * inside the caller's own organisation, checks the section's template and
   * reads the board back before a single column is written. The label on screen
   * is text; the key is what the server is asked to prove.
   *
   * A record whose section key is missing is REFUSED here rather than sent
   * without one — an absent `section` means the canonical register to
   * `/api/workspace`, so a silent omission would edit a canonical record while
   * the operator was looking at a custom one.
   */
  const scopedWrite = async (
    entity: Exclude<ManagerTab, "activity" | "import">,
    register: RecordProvenance,
    method: "PATCH" | "DELETE",
    id: string,
    data?: Record<string, unknown>,
  ) => {
    if (!register.sectionKey) {
      throw new Error(
        "This record's register is no longer listed in this workspace, so it cannot be changed from here.",
      );
    }
    const response = await fetch(
      `/api/workspace?section=${encodeURIComponent(register.sectionKey)}`,
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(method === "DELETE" ? { entity, id } : { entity, id, data }),
      },
    );
    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw new Error(payload.error || "The record could not be saved.");
    }
    /* The custom half of the list is this component's own; the canonical half
       and every dashboard total belong to the page, which reloads the snapshot
       through the hook it already has for a write it did not make itself. */
    setAggregateToken((token) => token + 1);
    onImported?.();
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
            {/*
              W2C — a list that could not load half of itself says so.

              The defect this whole change closes is a list that was silently
              short. Falling back to the canonical rows without a word would
              reproduce it exactly, so the failure is stated where the missing
              rows would have been.
            */}
            {aggregateProblem && (tab === "site" || tab === "contractor") ? (
              <p
                role="status"
                style={{
                  margin: "0 8px 4px",
                  padding: "8px 10px",
                  borderRadius: "8px",
                  background: "var(--surface-hover)",
                  color: "var(--red-600)",
                  fontSize: "12px",
                  lineHeight: 1.4,
                }}
              >
                {aggregateProblem}
              </p>
            ) : null}
            <div className="workspace-record-list">
              {records.map((record) => {
                /*
                  W2C — THE PROVENANCE LINE.

                  Its own element between the name and the subtitle, inside the
                  grid the list item already uses, so it reads as a second line
                  under the name rather than as more of the status line. 12px
                  against the name's 13px and the subtitle's 11px: smaller than
                  the name, deliberately NOT the smallest thing in the row, and
                  muted rather than coloured, because it is context and not a
                  warning about the record.

                  Inline styles rather than a class: this component's CSS lives
                  in `app/brand-overrides.css`, which two other workstreams are
                  editing concurrently. `overflowWrap` instead of the row's
                  ellipsis so a long section name is READ rather than truncated
                  — the whole purpose of the line is to tell two same-named
                  records apart, and "(Custom · North Regi…" tells you nothing
                  when the other one says "(Custom · North Regio…".

                  Canonical records get nothing at all. The workspace's own
                  register is the unmarked default; badging every row would make
                  the exception invisible again.
                */
                const from = recordProvenance(record);
                return (
                  <button key={String(record.id)} type="button" className={editorId === record.id ? "is-active" : ""} onClick={() => editRecord(record)}>
                    <span>
                      <strong>{recordTitle(tab, record)}</strong>
                      {from ? (
                        <span
                          style={{
                            color: "var(--muted)",
                            fontSize: "12px",
                            lineHeight: 1.3,
                            overflowWrap: "anywhere",
                          }}
                        >
                          {provenanceLabel(from)}
                        </span>
                      ) : null}
                      <small>{recordSubtitle(tab, record)}</small>
                    </span>
                    {!readOnlyTab && <Icon name="chevron" size={15} />}
                  </button>
                );
              })}
              {!records.length && <div className="workspace-record-list__empty"><Icon name="search" size={22} /><strong>No records found</strong><span>Try another search or add a new record.</span></div>}
            </div>
          </div>
          )}
          {form && !readOnlyTab && (
            /*
              W05-05 — CLOSING A SITE FROM HERE ASKS FIRST.

              The Lifecycle select on the Sites tab reaches
              `PATCH /api/workspace`, which writes the identical
              `{ status: 'closed', active: false, lifecycle: 'Closed' }` that
              the Sites register's Close button writes — and this path asked
              NOTHING. Choose Closed, press Save, and the site is off every
              location picker in the product with no dialog and no undo. A
              confirmation that guards one of two doors is not a confirmation.

              Only a real closure is confirmed: an existing record whose stored
              lifecycle is not already Closed. Re-saving a site that is closed
              already, and creating one, both go straight through — asking
              about something that is not happening is how people learn to
              click Yes without reading.

              CANCEL COSTS NOTHING. This returns before `onSave`, so no request
              is made, the editor stays open with the user's edit intact, and
              nothing on the dashboard moves.
            */
            /*
              W06-04 — AND UNTICKING "ACTIVE CONTRACTOR" ASKS THE SAME WAY.

              This was the door nobody was watching. The Archive button at
              least asked something; the tick box asked NOTHING, and pressing
              Save with it cleared writes the identical `active: false` through
              `PATCH /api/workspace` that Archive writes. `assignableContractors`
              above filters on `active` alone, so that one box removes a
              contractor from every assignment select just as completely — with
              no dialog, no undo, and sitting two rows under an Availability
              select that already offers the word "Inactive".

              Only the TRANSITION is confirmed: `leavesContractorRoster` asks
              whether the STORED record was on the roster and this save takes
              them off it. Re-saving somebody already archived goes straight
              through, and creating a contractor with the box cleared goes
              straight through — asking about something that is not happening
              is how people learn to click Yes without reading. Ordinary
              Availability changes are not this and never prompt.

              CANCEL COSTS NOTHING. This returns before `onSave`, so no request
              is made, the editor stays open with the tick box exactly as the
              user left it, and nothing on the dashboard moves.
            */
            /*
              W2C — THE SAVE GOES BACK TO THE REGISTER THE RECORD CAME FROM.

              `editorRegister` is the block the server stamped on the record, so
              a custom record's PATCH carries its own section key and can only
              land in that register. The canonical path is untouched and still
              goes through `onSave`, which is the dashboard's one writer for the
              workspace's own registers.

              Both closure confirmations run FIRST and unchanged, for both
              halves of the list — see `storedRecordFor`, which is what stops a
              custom record slipping past a question a canonical one is asked.
            */
            <form className="workspace-record-editor" onSubmit={async (event) => { event.preventDefault(); setScopedProblem(null); if (tab === "site" && editorId && String(form.lifecycle ?? "") === SITE_LIFECYCLE_CLOSED) { const stored = storedRecordFor("site"); if (stored && stored.lifecycle !== SITE_LIFECYCLE_CLOSED && !confirmSiteClosure(String(form.name ?? stored.name))) return; } if (tab === "contractor" && editorId) { const stored = storedRecordFor("contractor"); if (leavesContractorRoster(stored, Boolean(form.active)) && !confirmContractorRosterExit(String(form.name ?? stored?.name ?? ""))) return; } if (editorRegister && editorId) { setScopedBusy(true); try { await scopedWrite(tab, editorRegister, "PATCH", editorId, form); setForm(null); setEditorId(null); setEditorRegister(null); } catch (error) { setScopedProblem(error instanceof Error ? error.message : "The record could not be saved."); } finally { setScopedBusy(false); } return; } try { await onSave(tab, editorId, form); setForm(null); setEditorId(null); } catch { /* The dashboard toast reports the API error. */ } }}>
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
                  /*
                    W06-06 — THE TRADE LIST, AND THE VALUES IT DOES NOT OFFER.

                    Tick boxes over the same comma-separated string the field
                    always held, so nothing about the wire format changes and
                    `stringArray` on the route reads it exactly as before. What
                    changes is that the vocabulary now comes from
                    `contractor_trade` instead of from whatever somebody typed,
                    which is what stops "Electrical", "electrical" and
                    " ElectRical" being three trades.

                    ANYTHING ALREADY STORED THAT THE SET DOES NOT OFFER IS
                    STILL SHOWN, still ticked, and marked "(not configured)" —
                    the same rule the compliance Requirement select applies to a
                    certificate filed under a name the canonical list has lost,
                    and the same one the Sites tab's Type select applies. A
                    control that silently dropped those would turn one careless
                    Save into data loss on every legacy contractor in the
                    register.
                  */
                  if (field.type === "multiselect") {
                    const chosen = String(value)
                      .split(",")
                      .map((entry) => entry.trim())
                      .filter(Boolean);
                    const configured = field.options ?? [];
                    const offered = [
                      ...configured,
                      ...chosen
                        .filter((entry) => !configured.some((option) => option.value === entry))
                        .map((entry) => ({ value: entry, label: `${entry} (not configured)` })),
                    ];
                    return (
                      <fieldset className="workspace-multiselect" key={field.key}>
                        <legend>{field.label}</legend>
                        <div className="workspace-multiselect__options">
                          {offered.map((option) => (
                            <label key={option.value}>
                              <input
                                type="checkbox"
                                checked={chosen.includes(option.value)}
                                onChange={(event) => {
                                  // Order is preserved on the way in and out:
                                  // ticking appends, unticking removes, and a
                                  // list somebody arranged stays arranged.
                                  const next = event.target.checked
                                    ? [...chosen, option.value]
                                    : chosen.filter((entry) => entry !== option.value);
                                  setForm((current) =>
                                    current ? { ...current, [field.key]: next.join(", ") } : current,
                                  );
                                }}
                              />
                              <span>{option.label}</span>
                            </label>
                          ))}
                        </div>
                        {offered.length === 0 ? (
                          <small className="form-hint">
                            No trades are configured yet. Add them in Settings.
                          </small>
                        ) : null}
                        {field.hint ? <small className="form-hint">{field.hint}</small> : null}
                      </fieldset>
                    );
                  }
                  /*
                    W06-08 — CERTIFICATIONS, EACH WITH ITS OWN EXPIRY.

                    The one control here that edits a list of records rather
                    than a value. The STATUS beside each row is DERIVED from the
                    date in the box next to it by `expiryStatus` — the
                    platform's one classifier at its one 60-day amber threshold
                    — and is never stored: a status written into a column stops
                    being true the day after it is written, which is exactly how
                    `compliance_documents.status` came to say "Compliant" about
                    a certificate that had expired months earlier.

                    It updates as the date is typed, so the consequence of the
                    date is visible before Save rather than after a reload.
                  */
                  if (field.type === "certifications") {
                    const entries = Array.isArray(value) ? value : [];
                    const write = (next: EditorCertification[]) =>
                      setForm((current) => (current ? { ...current, [field.key]: next } : current));
                    const amend = (index: number, patch: Partial<EditorCertification>) =>
                      write(entries.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)));
                    return (
                      <fieldset className="workspace-certifications" key={field.key}>
                        <legend>{field.label}</legend>
                        {entries.map((entry, index) => {
                          const status = expiryStatus(entry.expiresOn || null);
                          return (
                            <div
                              className="workspace-certification"
                              key={entry.id || `unsaved-${index}`}
                            >
                              <label className="form-field">
                                <span>Certificate</span>
                                <input
                                  type="text"
                                  value={entry.name}
                                  placeholder="Gas Safe, IPAF, Asbestos awareness…"
                                  onChange={(event) => amend(index, { name: event.target.value })}
                                />
                              </label>
                              <label className="form-field">
                                <span>Reference</span>
                                <input
                                  type="text"
                                  value={entry.reference}
                                  onChange={(event) => amend(index, { reference: event.target.value })}
                                />
                              </label>
                              <label className="form-field">
                                <span>Issued</span>
                                <input
                                  type="date"
                                  value={entry.issuedOn}
                                  onChange={(event) => amend(index, { issuedOn: event.target.value })}
                                />
                              </label>
                              <label className="form-field">
                                <span>Expires</span>
                                <input
                                  type="date"
                                  value={entry.expiresOn}
                                  onChange={(event) => amend(index, { expiresOn: event.target.value })}
                                />
                              </label>
                              {/*
                                The word as well as the colour. A chip that says
                                only "amber" says nothing to anybody who cannot
                                see it, and `status.description` is written to
                                read correctly after the certificate's name.
                              */}
                              <span
                                className={`workspace-expiry-chip is-${status.state}`}
                                title={status.description}
                              >
                                {status.label}
                              </span>
                              <button
                                className="icon-button"
                                type="button"
                                aria-label={`Remove ${entry.name || "this certification"}`}
                                onClick={() => write(entries.filter((_, at) => at !== index))}
                              >
                                <Icon name="close" size={16} />
                              </button>
                            </div>
                          );
                        })}
                        {!entries.length ? (
                          <p className="form-hint">
                            Nothing recorded. Anything that expires belongs here, so it can be
                            chased before it lapses.
                          </p>
                        ) : null}
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() =>
                            // `id: ""` is what tells the route this is a new
                            // row rather than an edit of an existing one.
                            write([
                              ...entries,
                              { id: "", name: "", reference: "", issuedOn: "", expiresOn: "" },
                            ])
                          }
                        >
                          <Icon name="plus" size={16} />
                          Add a certification
                        </button>
                      </fieldset>
                    );
                  }
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
                      {/*
                        `hint` was rendered for checkboxes only, so a
                        `FieldDefinition` could declare guidance on any other
                        control and it went nowhere. Nothing but the Sites
                        tab's Region field uses it yet, so nothing else moves.
                      */}
                      {field.hint ? <small className="form-hint">{field.hint}</small> : null}
                    </label>
                  );
                })}
              </div>
              {/*
                W2C — WHY A SCOPED WRITE SAYS ITS OWN REFUSAL HERE.

                The canonical path throws to the dashboard, which owns the
                toast. A scoped write is made by this component, so its refusal
                has nowhere else to go — and the refusals it can hit are real
                and worth reading: a section archived in another tab, a record
                whose register was purged, a name another contractor on that
                register already answers to. Without this the editor would
                simply fail to close, which reads as a button that does nothing.

                `role="alert"` so it is announced when it appears; the message
                is the server's own words, which name the register.
              */}
              {scopedProblem ? (
                <p
                  role="alert"
                  style={{
                    margin: "0 16px",
                    color: "var(--red-600)",
                    fontSize: "12px",
                    lineHeight: 1.4,
                  }}
                >
                  {scopedProblem}
                </p>
              ) : null}
              <footer>
                {/*
                  W05-05 — the Archive button is the drawer's THIRD route to
                  the same closure, and its generic sentence does not name the
                  record, does not say the site leaves the active register and
                  does not say what survives. For a site it now asks the same
                  question the other two doors ask; every other register keeps
                  the wording it had.
                */}
                {/*
                  W06-04 — and a contractor gets the same treatment, from the
                  same helper, for the same reason.

                  The generic sentence — "Archive this record? It will remain in
                  the activity history." — does not name the contractor, does
                  not say they leave the assignment roster, and describes what
                  survives as "the activity history" when what actually survives
                  is every job, document and performance figure they have.
                  `contractor-closure.ts` owns those words and the tick-box path
                  above calls the same function, so the two doors onto one
                  outcome cannot drift apart again.

                  Sites and contractors now ask; every other register keeps the
                  wording it had, because nothing else here has a second door.
                */}
                {/*
                  W2C — and the archive goes back to the same register.

                  The scoped branch sits AFTER the confirmation and before the
                  canonical one, so a declined question still writes nothing and
                  the canonical path below is exactly the code it always was.
                  The names offered to both questions now come from
                  `storedRecordFor`, which looks in both halves of the list — a
                  custom record used to produce an empty name here, so the
                  dialog asked about "" and the operator was asked to confirm
                  the closure of nothing in particular.
                */}
                {editorId && <button className="secondary-button workspace-archive-button" type="button" disabled={busy || scopedBusy} onClick={async () => { setScopedProblem(null); const named = (fallback: string) => String(form.name ?? fallback ?? ""); const agreed = tab === "site" ? confirmSiteClosure(named(storedRecordFor("site")?.name ?? "")) : tab === "contractor" ? confirmContractorRosterExit(named(storedRecordFor("contractor")?.name ?? "")) : window.confirm("Archive this record? It will remain in the activity history."); if (agreed && editorRegister) { setScopedBusy(true); try { await scopedWrite(tab, editorRegister, "DELETE", editorId); setForm(null); setEditorId(null); setEditorRegister(null); } catch (error) { setScopedProblem(error instanceof Error ? error.message : "The record could not be archived."); } finally { setScopedBusy(false); } return; } if (agreed) { try { await onArchive(tab, editorId); setForm(null); setEditorId(null); } catch { /* The dashboard toast reports the API error. */ } } }}>Archive</button>}
                <button className="secondary-button" type="button" onClick={() => setForm(null)}>Cancel</button>
                <button className="primary-button" type="submit" disabled={busy || scopedBusy}>{busy || scopedBusy ? "Saving…" : "Save changes"}</button>
              </footer>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}

export type { ManagerTab };
