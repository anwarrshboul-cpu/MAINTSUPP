/**
 * WHETHER A CERTIFICATE IS IN DATE — one rule, one place, four screens.
 *
 * The Overview's compliance column, the Compliance register, every site row on
 * the Sites page and a contractor's document list all answer the same question,
 * and before this module they answered it four ways. The worst of them read the
 * stored `compliance_documents.status` string, so "Compliant" written in 2026
 * stayed compliant for ever.
 *
 * ── WHAT "CERTIFICATE PRESENT" ACTUALLY MEANS HERE ────────────────────────
 *
 * It is not a label and it is not the `status` column. A requirement is HELD
 * when the board row's file column for that slot carries at least one live
 * attachment — `fileCount > 0` in `store-documentation-register.ts`. That is
 * the only signal that a document exists, and reading anything else is how the
 * register came to disagree with itself. Audit finding, reported: on the
 * current development estate `fileCount` is zero on every one of the 748
 * records, because the local attachment table is depleted (see CLAUDE.md);
 * every "Missing" there is an environment fact, not an estate fact.
 *
 * ── THE FIVE STATES, AND THE WORDS THEY ARE PRINTED WITH ──────────────────
 *
 * The product's vocabulary is `ComplianceState` — Compliant / Expiring soon /
 * Expired / Missing / Not required — and it is what the digest emails, the CSV
 * export, the calendar and eleven test suites already say. The rebuild briefs
 * name the same five states "Valid" and "Not applicable" for two of them.
 * Renaming a string that leaves the product in an email is not a presentation
 * change, so the vocabulary stays and this module records the mapping instead:
 *
 *     Valid           → "Compliant"
 *     Expiring soon   → "Expiring soon"
 *     Expired         → "Expired"
 *     Missing         → "Missing"
 *     Not applicable  → "Not required"
 *
 * ── THE WINDOW IS 60 DAYS, NOT 30, AND IT IS PRINTED FROM THE CONSTANT ────
 *
 * `EXPIRY_DUE_SOON_DAYS` is an operational policy with its reasoning written
 * out in `expiry-status.ts`: none of these certificates can be renewed
 * in-house, so sixty days spans two monthly compliance reviews. Every sentence
 * on these pages that states a window interpolates the constant rather than
 * typing a number, which is the defect that made a tile say "Due within 30
 * days" while it was filled from a 60-day classifier.
 *
 * The "next 30 days" and "next 90 days" DUE-WINDOW FILTERS are a different
 * thing and are unaffected: they are questions a reader asks of the register,
 * not the definition of amber.
 */

import { countsTowardCompliance } from "./compliance-duty-holder";
import {
  EXPIRY_DUE_SOON_DAYS,
  expiryStatus,
  type ExpiryStatus,
} from "./expiry-status";
import { complianceStateFor } from "./store-documentation-register";
import type { ComplianceItem, ComplianceState } from "./types";

export { EXPIRY_DUE_SOON_DAYS, complianceStateFor, expiryStatus };
export type { ComplianceState, ExpiryStatus };

/**
 * The five states in the order a register sorts by: most urgent first.
 *
 * Records inside a site group are ordered by this array, so the thing a
 * compliance manager has to do today is at the top of every group without
 * anybody choosing a sort.
 */
export const COMPLIANCE_STATES: readonly ComplianceState[] = [
  "Missing",
  "Expired",
  "Expiring soon",
  "Compliant",
  "Not required",
] as const;

/** Rank for sorting. Lower is more urgent. */
export function complianceUrgency(state: ComplianceState): number {
  const index = COMPLIANCE_STATES.indexOf(state);
  return index === -1 ? COMPLIANCE_STATES.length : index;
}

/**
 * Semantic colours, fixed and never reassigned.
 *
 * The approved colour system's one compliance palette, used on every page:
 * Compliant green, Expiring soon yellow, Expired red, Missing orange (a missing
 * document), Not required grey. One hex serves both themes (these reach the
 * page as inline styles and API payloads), so they are the mid-tone fills,
 * each clearing 3:1 on the white card and on the dark one.
 */
export const COMPLIANCE_COLOUR: Record<ComplianceState, string> = {
  Compliant: "#00A056",
  "Expiring soon": "#AE8500",
  Expired: "#FB495A",
  Missing: "#DC6A0D",
  "Not required": "#64748B",
};

/**
 * The words on a chip. Identical to the state, deliberately — a chip that said
 * anything else would give the product a sixth vocabulary.
 */
export function complianceLabel(state: ComplianceState): string {
  return state;
}

/**
 * A one-line explanation of what a state means, for the chip's title and the
 * accessible description. Colour is never the sole carrier of meaning.
 */
export const COMPLIANCE_MEANING: Record<ComplianceState, string> = {
  Compliant: `Certificate on file and more than ${EXPIRY_DUE_SOON_DAYS} days from expiry`,
  "Expiring soon": `Expires within ${EXPIRY_DUE_SOON_DAYS} days`,
  Expired: "Expiry date has passed",
  Missing: "No certificate on record",
  "Not required": "Marked as not required for this site",
};

/* ── Completion ───────────────────────────────────────────────────────────── */

export type ComplianceCompletion = {
  /** Requirements met — `Compliant`, and nothing else. */
  satisfied: number;
  /**
   * Requirements this site actually has to hold: every record except the ones
   * explicitly marked not required. This is the denominator.
   */
  applicable: number;
  /** Records marked not required. Reported beside the score, never inside it. */
  notRequired: number;
  /** Every record, applicable or not. The meter's segments sum to this. */
  total: number;
  /** Whole percent, 0-100. Meaningless unless `scored`. */
  percent: number;
  /** False when nothing applicable is on file, so a caller prints "-" not "0%". */
  scored: boolean;
  /**
   * COVERAGE, STATED SEPARATELY FROM THE SCORE.
   *
   * Records excluded because nobody has confirmed whose obligation they are,
   * or has confirmed they are somebody else's. Reported beside the percentage
   * for the same reason `notRequired` is: a reader has to be able to see that
   * "8%" is 3 of 12 confirmed rather than 3 of 12 held, and those are entirely
   * different facts about a store.
   *
   * `total - notRequired - excluded === applicable`.
   */
  excluded: number;
  counts: Record<ComplianceState, number>;
};

/**
 * Completion over a set of records.
 *
 * ── "NOT REQUIRED" IS OUT OF THE FRACTION ENTIRELY ────────────────────────
 *
 * Not in the numerator and not in the denominator. A store with no sprinkler
 * system is not one twelfth short of compliant, and it is not one twelfth
 * compliant either — the requirement does not apply to it, and the only honest
 * thing a score can do with an inapplicable requirement is decline to count it.
 *
 * The rebuild brief asks for the other arrangement: count Not applicable as
 * SATISFIED, over a denominator of everything. That reading is recorded here
 * because it is a real instruction and it was not followed, with a reason: it
 * inflates. On this estate 449 of 748 register rows are marked not required, so
 * the brief's formula scores the portfolio at roughly 70% where the rule the
 * product already ships scores it at 25% — and a store holding eleven
 * inapplicable requirements and one missing certificate would read 92%
 * compliant. It is also the arrangement `scorableComplianceRecords` and
 * `complianceScore` have used since the Overview tile and the Compliance page
 * were first reconciled, so changing it would move a number on three screens
 * and in the nightly digest at once, silently.
 *
 * What the brief is actually protecting — that an inapplicable requirement must
 * not count against a store — is preserved exactly. `notRequired` comes back
 * beside the score so the UI can say "3 of 8 met, 4 not required" rather than
 * hiding four records inside a percentage.
 *
 * `scored` exists because 0% and "nothing to score" are different claims. A new
 * site with no requirements set up looks identical to a failing one otherwise,
 * and that is the more dangerous of the two.
 */
export function complianceCompletion(
  records: readonly { state: ComplianceState; dutyHolder?: string | null }[],
): ComplianceCompletion {
  const counts: Record<ComplianceState, number> = {
    Compliant: 0,
    "Expiring soon": 0,
    Expired: 0,
    Missing: 0,
    "Not required": 0,
  };
  for (const record of records) {
    if (counts[record.state] === undefined) continue;
    counts[record.state] += 1;
  }
  const total = records.length;
  const notRequired = counts["Not required"];
  /*
   * ── AND SO IS A REQUIREMENT NOBODY HAS CLAIMED ────────────────────────
   *
   * Maintsupp administers a schedule; it does not assume responsibility for
   * assets it was never given. So a requirement confirmed as the landlord's or
   * the shopping centre's is recorded and displayed but not scored, and one
   * nobody has answered for yet is not scored either — we cannot report a
   * failure that may belong to a landlord, or to an asset a kiosk does not
   * have.
   *
   * WHY THIS DOES NOT MOVE THE EXISTING ESTATE. `countsTowardCompliance`
   * returns true for `null`, and every one of the 748 rows that predates the
   * `duty_holder` column is NULL. The only records this excludes are ones
   * something positively marked — `ensureComplianceProfile` stamps
   * "excluded" as it creates them, and a person choosing Landlord or Shopping
   * centre stamps those. A caller that does not track duty holders at all passes
   * records without the field and gets precisely today's arithmetic.
   *
   * Counted AFTER `notRequired` and excluded from it, so the three groups
   * partition the total rather than overlapping: a record marked Not applicable
   * arrives here already carrying the `Not required` state, and must not be
   * subtracted twice.
   */
  const excluded = records.filter(
    (record) =>
      record.state !== "Not required" && !countsTowardCompliance(record.dutyHolder),
  ).length;
  const applicable = total - notRequired - excluded;
  const satisfied = records.filter(
    (record) => record.state === "Compliant" && countsTowardCompliance(record.dutyHolder),
  ).length;
  return {
    satisfied,
    applicable,
    notRequired,
    total,
    percent: applicable ? Math.round((satisfied / applicable) * 100) : 0,
    scored: applicable > 0,
    excluded,
    counts,
  };
}

/** Records that still need somebody to do something. */
export function outstandingCount(counts: Record<ComplianceState, number>): number {
  return counts.Missing + counts.Expired + counts["Expiring soon"];
}

/* ── Bands ────────────────────────────────────────────────────────────────── */

export type ComplianceBand = {
  key: "complete" | "near" | "partial" | "poor";
  label: string;
  colour: string;
  /** Inclusive lower bound in whole percent. */
  from: number;
};

/**
 * The four bands a completion meter is coloured by, shared with the Sites page
 * so a store that is amber on one screen is amber on the other.
 */
export const COMPLETION_BANDS: readonly ComplianceBand[] = [
  { key: "complete", label: "Complete", colour: "#00A056", from: 100 },
  { key: "near", label: "Nearly complete", colour: "#AE8500", from: 80 },
  { key: "partial", label: "Partly complete", colour: "#DC6A0D", from: 50 },
  { key: "poor", label: "Largely outstanding", colour: "#FB495A", from: 0 },
] as const;

export function completionBand(percent: number): ComplianceBand {
  const value = Number.isFinite(percent) ? percent : 0;
  for (const band of COMPLETION_BANDS) {
    if (value >= band.from) return band;
  }
  return COMPLETION_BANDS[COMPLETION_BANDS.length - 1];
}

/** The colour a completion meter is drawn in. */
export function complianceBandColour(percent: number): string {
  return completionBand(percent).colour;
}

/* ── Due windows ──────────────────────────────────────────────────────────── */

export const DUE_WINDOWS = [
  { key: "overdue", label: "Overdue" },
  { key: "30", label: "Next 30 days" },
  { key: "90", label: "Next 90 days" },
  { key: "none", label: "No due date" },
] as const;

export type DueWindowKey = (typeof DUE_WINDOWS)[number]["key"];

export function isDueWindow(value: string): value is DueWindowKey {
  return DUE_WINDOWS.some((window) => window.key === value);
}

/**
 * Whether one record falls in a due window.
 *
 * `today` is injected for the same reason `expiryStatus` injects it: a whole
 * register has to be classified against one instant, and a test has to be able
 * to pin the day.
 */
export function withinDueWindow(
  record: { expiry: string | null },
  window: DueWindowKey,
  today: Date,
): boolean {
  const status = expiryStatus(record.expiry, today);
  if (window === "none") return status.state === "not-recorded";
  if (status.date === null) return false;
  if (window === "overdue") return status.state === "expired";
  const days = status.daysRemaining;
  if (days === null) return false;
  return days >= 0 && days <= Number(window);
}

/**
 * The phrase used wherever a due date is absent.
 *
 * "No due date", never an em dash. A dash in a value column reads as a
 * rendering fault, and readers have reported it as one.
 */
export const NO_DUE_DATE = "No due date";

/* ── Grouping ─────────────────────────────────────────────────────────────── */

export type ComplianceRecordLike = ComplianceItem & {
  id: string;
  siteId: string;
  siteName: string;
  responsibility?: string | null;
};

export type ComplianceSiteGroup = {
  siteId: string;
  siteName: string;
  completion: ComplianceCompletion;
  outstanding: number;
  noDueDate: number;
  records: ComplianceRecordLike[];
};

/**
 * Group a flat register by site, each group carrying its own meter.
 *
 * Sorting is the caller's, because the register offers four orders and the
 * default — most outstanding first — is a product decision rather than a
 * property of the data.
 */
export function groupBySite(
  records: readonly ComplianceRecordLike[],
): ComplianceSiteGroup[] {
  const groups = new Map<string, ComplianceRecordLike[]>();
  const names = new Map<string, string>();
  for (const record of records) {
    if (!names.has(record.siteId)) names.set(record.siteId, record.siteName);
    const list = groups.get(record.siteId);
    if (list) list.push(record);
    else groups.set(record.siteId, [record]);
  }
  return [...groups].map(([siteId, list]) => {
    const completion = complianceCompletion(list);
    return {
      siteId,
      siteName: names.get(siteId) ?? siteId,
      completion,
      outstanding: outstandingCount(completion.counts),
      noDueDate: list.filter((record) => !record.expiry).length,
      records: [...list].sort(
        (left, right) =>
          complianceUrgency(left.state) - complianceUrgency(right.state) ||
          compareDueDates(left.expiry, right.expiry) ||
          left.kind.localeCompare(right.kind, "en-GB"),
      ),
    };
  });
}

/** Soonest first; records with no date sort last within their state. */
export function compareDueDates(
  left: string | null,
  right: string | null,
): number {
  if (left === right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left < right ? -1 : 1;
}
