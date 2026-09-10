/**
 * §5's STATUS MODEL, AS THE SCREEN SEES IT. No JSX, no fetch, no React.
 *
 * ── WHY A SEPARATE MODULE ─────────────────────────────────────────────────
 *
 * Six tabs render a status. If each one carried its own `switch`, recolouring
 * "Query raised" would be six edits and the sixth would be missed — which is
 * precisely the failure §5 legislates against by putting the vocabulary in an
 * editable table in the first place. So the mapping lives here once, and every
 * component asks it.
 *
 * ── THE COLOUR IS A TOKEN, NOT A HEX ──────────────────────────────────────
 *
 * `finance.css` holds §5's ten colours in one token block with a dark variant,
 * and this module returns the token NAME. A component therefore never writes a
 * colour, and the dark canvas needs no second copy of this mapping.
 *
 * The one exception is DATA: `invoice_status_map.colour_hex` is a colour an
 * administrator typed, and when the server supplies one it wins. That is not a
 * literal in the source — it is the workspace's own decision arriving at
 * runtime, which is the whole point of §5's editable table.
 *
 * ── COLOUR IS NEVER THE ONLY SIGNAL ───────────────────────────────────────
 *
 * §5: "each row also carries a days-overdue badge and a status icon". Every
 * presentation below therefore carries an `icon` and a `label` as well as a
 * `tone`, and the void group carries `struck` so that "this invoice is
 * withdrawn" survives a greyscale print. Nothing on this page is legible only
 * in colour.
 *
 * ── AN UNMAPPED STATUS NEVER DISAPPEARS ───────────────────────────────────
 *
 * §5 again, and it is the rule with the most expensive failure mode: a ledger
 * that hides a status it does not recognise hides the INVOICE with it, and the
 * money with the invoice. `presentStatus` therefore never returns null and
 * never filters. An unknown key comes back grey, carrying the raw label it
 * arrived with and `mapped: false`, and the caller raises the admin notice.
 */

import type { IconName } from "../../../components";
import {
  financeStatusKey,
  isTerminalStatus,
  type InvoiceDirection,
} from "../../../lib/finance/model";
import { ageingFor, type AgeingBucket } from "../../../lib/finance/rules";

export interface StatusPresentation {
  /** The normalised key, or the normalisation of whatever arrived. */
  key: string;
  /** What the chip says. The workspace's label when it has one, else ours. */
  label: string;
  /** A CSS custom property reference — `var(--fin-…)` — or a colour from the map. */
  tone: string;
  icon: IconName;
  /** §5: voided and written off are struck through. */
  struck: boolean;
  /** False when nothing in this module or in the workspace's map knows the key. */
  mapped: boolean;
  /** Nothing further will happen to this invoice of its own accord. */
  terminal: boolean;
}

/**
 * One row of the workspace's `invoice_status_map`, as a screen receives it.
 *
 * `statusKey`, `displayLabel` and `colourHex` are all `presentStatus` reads.
 * The rest are here because the SETTINGS tab edits these rows and has to send
 * them back — `PUT /api/finance/settings` matches on `id` and ignores a row
 * without one, so a type that dropped the id would produce a save that appeared
 * to work and changed nothing.
 */
export interface StatusMapEntry {
  id?: string;
  statusKey: string;
  displayLabel?: string | null;
  colourHex?: string | null;
  icon?: string | null;
  direction?: string | null;
  countsAsOpen?: boolean;
  countsAsOverdueEligible?: boolean;
  isTerminal?: boolean;
  sortOrder?: number;
  active?: boolean;
}

interface Group {
  label: string;
  tone: string;
  icon: IconName;
  struck?: boolean;
}

/*
 * §5's ten groups, keyed by every status on both ladders.
 *
 * Four keys the colour table does not name, and the reasoning for each, because
 * a silent choice here is a colour nobody can account for later:
 *
 *   · `issued` — the receivable twin of `received`: the record exists and has
 *     not gone anywhere yet. Slate, with Draft, rather than the teal of "Sent".
 *   · `viewed` — the client has opened it, which is progress on the same track
 *     as Sent. Teal.
 *   · `part_paid` — money has moved and more is expected. Teal, the "in
 *     flight" colour, NOT amber: amber on this page means somebody has to do
 *     something, and a part-paid invoice on terms does not.
 *   · `credited` — terminal, and grey with Voided, but NOT struck through. The
 *     invoice was real and the credit note is the record of what happened to
 *     it; striking it out would say it never existed.
 */
const GROUPS: Record<string, Group> = {
  draft: { label: "Draft", tone: "var(--fin-draft)", icon: "edit" },
  received: { label: "Received", tone: "var(--fin-draft)", icon: "inbox" },
  issued: { label: "Issued", tone: "var(--fin-draft)", icon: "document" },

  under_review: { label: "Under review", tone: "var(--fin-review)", icon: "activity" },
  query_raised: { label: "Query raised", tone: "var(--fin-review)", icon: "message" },

  approved: { label: "Approved for payment", tone: "var(--fin-approved)", icon: "check" },
  scheduled: { label: "Scheduled for payment", tone: "var(--fin-approved)", icon: "calendar" },
  sent: { label: "Sent", tone: "var(--fin-approved)", icon: "share" },
  viewed: { label: "Viewed", tone: "var(--fin-approved)", icon: "search" },
  part_paid: { label: "Part paid", tone: "var(--fin-approved)", icon: "activity" },

  overdue: { label: "Overdue", tone: "var(--fin-overdue-30)", icon: "alert" },

  paid: { label: "Paid", tone: "var(--fin-paid)", icon: "thumb" },
  disputed: { label: "Disputed", tone: "var(--fin-disputed)", icon: "alert" },

  voided: { label: "Voided", tone: "var(--fin-void)", icon: "close", struck: true },
  written_off: { label: "Written off", tone: "var(--fin-void)", icon: "close", struck: true },
  credited: { label: "Credited", tone: "var(--fin-void)", icon: "reply" },
};

/** §3's quote ladder, which shares §5's colour language rather than inventing one. */
const QUOTE_GROUPS: Record<string, Group> = {
  requested: { label: "Requested", tone: "var(--fin-draft)", icon: "message" },
  received: { label: "Received", tone: "var(--fin-draft)", icon: "inbox" },
  under_review: { label: "Under review", tone: "var(--fin-review)", icon: "activity" },
  approved: { label: "Approved", tone: "var(--fin-approved)", icon: "check" },
  rejected: { label: "Rejected", tone: "var(--fin-void)", icon: "close", struck: true },
  expired: { label: "Expired", tone: "var(--fin-overdue-30)", icon: "clock" },
  superseded: { label: "Superseded", tone: "var(--fin-void)", icon: "reply" },
};

/** Title case from a snake_case key, for a status nobody has a label for. */
function rawLabel(value: string | null | undefined): string {
  const words = (value ?? "").trim().replace(/[_-]+/g, " ").trim();
  if (!words) return "No status";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fromMap(
  key: string,
  entry: StatusMapEntry | undefined,
  group: Group | undefined,
): StatusPresentation {
  const label = entry?.displayLabel?.trim() || group?.label || rawLabel(key);
  return {
    key,
    label,
    /* The administrator's colour when the workspace set one; ours otherwise. */
    tone: entry?.colourHex?.trim() || group?.tone || "var(--fin-unmapped)",
    icon: group?.icon ?? "alert",
    struck: group?.struck === true,
    mapped: Boolean(group || entry),
    terminal: isTerminalStatus(key),
  };
}

/**
 * How one invoice status should be drawn. Never null, never filtered.
 *
 * `statusMap` is the workspace's own `invoice_status_map`, when a screen has
 * loaded it. Where it has not — the settings endpoint is one of Module 5's
 * later routes — the built-in groups answer, which is the fallback §5's own
 * key ladder exists for.
 */
export function presentStatus(
  status: string | null | undefined,
  statusMap?: readonly StatusMapEntry[] | null,
): StatusPresentation {
  const key = financeStatusKey(status);
  const entry = statusMap?.find((row) => financeStatusKey(row.statusKey) === key);
  return fromMap(key, entry, GROUPS[key]);
}

/** The same for §3's quote ladder. */
export function presentQuoteStatus(status: string | null | undefined): StatusPresentation {
  const key = financeStatusKey(status) === "awaiting_approval"
    ? "under_review"
    : financeStatusKey(status);
  return fromMap(key, undefined, QUOTE_GROUPS[key]);
}

/**
 * §5's PROXIMITY BANDS, which are a different question from the status.
 *
 * An invoice can be "Approved for payment" AND forty days late, and §5 wants
 * both facts on the row: the status chip says what stage it is at, this says
 * how close the money is. The four bands are the spec's own, read literally:
 *
 *   due in 0…7 days  ->  yellow
 *   1…30 late        ->  orange
 *   31…60 late       ->  red
 *   61 and beyond    ->  dark red
 *
 * §9's ageing buckets split that last band at ninety days for the aged-debtor
 * report; §5's colour table does not, and stops at "60+". Both are honoured:
 * `ageingFor` decides the BUCKET and this decides the COLOUR, and neither
 * re-implements the other. `ageingFor` is also the only thing that knows what
 * "overdue" means, so nothing here counts days for itself.
 */
export interface ProximityBand {
  tone: string;
  /** "42 days overdue", "Due in 3 days", "Due today", or null when neither. */
  sentence: string | null;
  daysOverdue: number;
  bucket: AgeingBucket;
  overdue: boolean;
}

export function proximityBand(
  dueDay: string | null | undefined,
  todayDay: string,
  daysUntilDue: number | null = null,
): ProximityBand {
  const { ageingBucket, daysOverdue } = ageingFor(dueDay ?? null, todayDay);

  if (daysOverdue > 60) {
    return band("var(--fin-overdue-90)", `${daysOverdue} days overdue`, daysOverdue, ageingBucket, true);
  }
  if (daysOverdue > 30) {
    return band("var(--fin-overdue-60)", `${daysOverdue} days overdue`, daysOverdue, ageingBucket, true);
  }
  if (daysOverdue > 0) {
    const word = daysOverdue === 1 ? "1 day overdue" : `${daysOverdue} days overdue`;
    return band("var(--fin-overdue-30)", word, daysOverdue, ageingBucket, true);
  }
  if (daysUntilDue !== null && daysUntilDue >= 0 && daysUntilDue <= 7) {
    const word = daysUntilDue === 0 ? "Due today" : `Due in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"}`;
    return band("var(--fin-due-soon)", word, 0, ageingBucket, false);
  }
  return band("var(--fin-draft)", null, 0, ageingBucket, false);
}

function band(
  tone: string,
  sentence: string | null,
  daysOverdue: number,
  bucket: AgeingBucket,
  overdue: boolean,
): ProximityBand {
  return { tone, sentence, daysOverdue, bucket, overdue };
}

/* ── Terminology, which differs per side. §4 and §16 ──────────────────────── */

export interface DirectionWords {
  /** "Payable" / "Receivable" — the tab and the page heading. */
  title: string;
  /** "Received from" / "Issued to" — the counterparty's column heading. */
  counterparty: string;
  /** "Received date" / "Sent date" — §4's asymmetric date. */
  dateLabel: string;
  /** The body field that date is sent as. */
  dateField: "receivedDate" | "sentDate";
  /** "Supplier invoice number" / "Invoice number (MS-…)". §4. */
  numberLabel: string;
  numberHint: string;
  /** "Contractor or supplier" / "Client". */
  counterpartyHint: string;
  /** "Received from department" / "Issued to department". §4. */
  departmentLabel: string;
  departmentField: "fromDepartment" | "toDepartment";
  /** The reference series a new record is given. §4. */
  referencePrefix: string;
  /** What "approve" does on this side, in the operator's words. */
  approveLabel: string;
  /** What money moving looks like from here. */
  settlement: string;
}

export const DIRECTION_WORDS: Record<InvoiceDirection, DirectionWords> = {
  payable: {
    title: "Payable",
    counterparty: "Received from",
    dateLabel: "Received date",
    dateField: "receivedDate",
    numberLabel: "Supplier invoice number",
    numberHint: "The supplier's own number, exactly as printed on their document.",
    counterpartyHint: "Contractor or supplier",
    departmentLabel: "Received from department",
    departmentField: "fromDepartment",
    referencePrefix: "AP-",
    approveLabel: "Approve for payment",
    settlement: "Payment out",
  },
  receivable: {
    title: "Receivable",
    counterparty: "Issued to",
    dateLabel: "Sent date",
    dateField: "sentDate",
    numberLabel: "Invoice number",
    numberHint: "Ours — MS-YYYY-NNN, from the invoice generator.",
    counterpartyHint: "Client",
    departmentLabel: "Issued to department",
    departmentField: "toDepartment",
    referencePrefix: "AR-",
    approveLabel: "Approve and send",
    settlement: "Receipt in",
  },
};

/* ── §7's flags, in words an operator can act on ──────────────────────────── */

export const FLAG_WORDS: Record<string, { name: string; why: string }> = {
  no_approved_quote: {
    name: "No approved quote",
    why: "This work was invoiced against a job with no approved quote behind it.",
  },
  over_quote: {
    name: "Over quote",
    why: "The invoice exceeds the approved quote by more than the tolerance in settings.",
  },
  job_not_complete: {
    name: "Job not complete",
    why: "The job this is billed against is still open.",
  },
  site_mismatch: {
    name: "Site mismatch",
    why: "The invoice names a different site from the job it is allocated to.",
  },
  possible_duplicate: {
    name: "Possible duplicate",
    why: "Same supplier, same amount, or the same invoice number reused inside the duplicate window.",
  },
  no_linked_job: {
    name: "No linked job",
    why: "Nothing on this invoice points at a job, so no cost can land anywhere.",
  },
  vat_anomaly: {
    name: "VAT anomaly",
    why: "VAT is charged by a supplier with no VAT number recorded.",
  },
  outside_agreement: {
    name: "Outside agreement",
    why: "This category is not one the client agreement covers.",
  },
};

export function flagName(flagType: string): string {
  return FLAG_WORDS[flagType]?.name ?? rawLabel(flagType);
}

export function flagWhy(flagType: string): string {
  return FLAG_WORDS[flagType]?.why ?? "The match engine raised this and did not explain itself.";
}
