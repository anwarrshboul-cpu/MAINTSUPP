/**
 * NARRATIVE BLOCKS — computed first, written second, reviewed third.
 *
 * Module 4 §4.3 turns the prose sections of the maintenance report into named,
 * individually regenerable blocks, and states the rule the whole design serves:
 *
 *     The model writes sentences around figures it is given.
 *     It never produces a figure.
 *
 * This file is the first half of making that true. It holds the block model,
 * the three states a block can be in, and — the part that matters — the LOCKED
 * FIGURE SET: every number, amount, percentage and date the computed payload
 * legitimately contains, canonicalised, so that `figure-validator.ts` can
 * refuse any prose that states something else.
 *
 * ── WHY THE ORDER IS COMPUTE, THEN WRITE ───────────────────────────────────
 *
 * The engine has already produced every figure before a model is asked for a
 * sentence. Nothing here recomputes one, nothing here rounds one, and the
 * generation request carries the figures as data rather than as a question. A
 * model that is handed "completedMaintenancePence: 175800" and told to write a
 * paragraph cannot arrive at £1,760 by accident, because the only route to a
 * number in the output is one that was in the input — and the validator checks
 * that route on the way back.
 *
 * ── THE THREE STATES, AND WHAT THE BADGE MEANS ─────────────────────────────
 *
 *   empty      Nothing written. Not a gap in the document: a block with
 *              nothing to describe is not planned at all (see
 *              `plannedNarrativeBlocks`), so `empty` means "planned, not yet
 *              drafted" and the operator can see the difference.
 *   ai-draft   A model wrote it and no human has looked. This is the state the
 *              "AI draft — not yet reviewed" badge renders, and §4.3 requires
 *              finalisation to be blocked while any block is in it.
 *   reviewed   A human edited or accepted it. The badge clears.
 *
 * REGENERATING A REVIEWED BLOCK PUTS IT BACK TO `ai-draft`. It must: the
 * sentence a person approved is gone, replaced by one nobody has read, and
 * carrying the old approval forward onto new text is precisely the failure the
 * badge exists to prevent.
 *
 * ── DETERMINISTIC PROSE IS NOT AN AI DRAFT ─────────────────────────────────
 *
 * `narrative.ts` builds the executive summary from the counts with no model
 * anywhere near it, and that path must keep working when no provider is
 * configured — §4.3's blocks are an enhancement of the report, not a
 * precondition for it. Prose from that path is stored `reviewed` with
 * `source: "deterministic"`, and the honest reason is that there is nothing for
 * a review to catch: the sentences were generated FROM the figures by code in
 * this repository, so they cannot contain one that is not in the data. The
 * badge is a warning about invention, and computation does not invent.
 *
 * ── PURE, AND IMPORTING ONLY TYPES ─────────────────────────────────────────
 *
 * Types from `contract.ts`, values from `figure-validator.ts`, and nothing
 * else. No database handle, no provider, no clock. `blockers.ts` can therefore
 * call `narrativeReviewComplete()` without acquiring a dependency it cannot
 * carry — though see the note on that function about how the report suites
 * stage modules.
 */

import type {
  CombinedReportPayload,
  FinalisationBlocker,
  HoldRow,
  IsoDate,
} from "./contract";
import { canonicalNumber, type LockedFigureSet } from "./figure-validator";

export type { LockedFigureSet } from "./figure-validator";

/* ------------------------------------------------------------ the blocks -- */

/**
 * The six prose sections §4.3 names, in the order they appear in the document.
 *
 * `hold-explanation` is the only one that repeats: the specification asks for
 * "a per-job explanation for each hold", so one block is planned per hold row
 * and each is regenerated, edited and reviewed on its own. A single block
 * covering every hold would mean one edit re-opening every other hold's
 * approval, and a regenerate rewriting explanations a person had already
 * accepted.
 */
export const NARRATIVE_BLOCK_KINDS = [
  "executive-summary",
  "spend",
  "requiring-attention",
  "hold-explanation",
  "open-items-priority",
  "special-projects",
] as const;

export type NarrativeBlockKind = (typeof NARRATIVE_BLOCK_KINDS)[number];

export type NarrativeBlockState = "empty" | "ai-draft" | "reviewed";

/**
 * Where the prose came from. Separate from `state` because they answer
 * different questions: `state` is "has a human taken responsibility for this",
 * `source` is "who wrote it", and a reviewed block may have been drafted by a
 * model, typed by a person or computed by `narrative.ts`.
 */
export type NarrativeBlockSource = "none" | "model" | "human" | "deterministic";

export interface NarrativeBlockDefinition {
  kind: NarrativeBlockKind;
  title: string;
  /** Shown under the title. Says what the block is FOR, in the owner's terms. */
  purpose: string;
  /** One per subject rather than one per document. */
  perSubject: boolean;
  /** Handed to the model as the brief. Never contains a figure. */
  instruction: string;
}

export const NARRATIVE_BLOCKS: Record<NarrativeBlockKind, NarrativeBlockDefinition> = {
  "executive-summary": {
    kind: "executive-summary",
    title: "Executive summary and headline",
    purpose:
      "The opening paragraph: what the period covered, the volume, the performance figure and its denominator.",
    perSubject: false,
    instruction:
      "Write the opening summary of the maintenance period. State the period, the number of jobs recorded and their split, and the performance figure together with the denominator it was measured against. If no performance figure is supplied, say plainly that none is stated and why.",
  },
  spend: {
    kind: "spend",
    title: "Spend paragraph",
    purpose:
      "Recorded spend on completed work, what is committed but unspent, and the service fee stated separately.",
    perSubject: false,
    instruction:
      "Write the spend paragraph. Recorded spend covers completed work only. Costs quoted against open jobs are committed but unspent and must be stated separately. The service fee is charged separately and must never read as maintenance expenditure.",
  },
  "requiring-attention": {
    kind: "requiring-attention",
    title: "Requiring attention",
    purpose: "What a reader should act on: delays, holds and unresolved data issues.",
    perSubject: false,
    instruction:
      "Write the paragraph on what requires attention. Cover open work past target, jobs on hold and any data issues that limit what the figures can be relied on for. Do not apologise and do not offer a cause the data does not record.",
  },
  "hold-explanation": {
    kind: "hold-explanation",
    title: "Hold explanation",
    purpose:
      "One or two sentences per hold, saying what the hold was and what it did to the measured duration.",
    perSubject: true,
    instruction:
      "Explain this single hold in one or two sentences: what it was, the dates it ran, and the effect of the held days on the measured duration. Say whether it was approved. An unapproved hold has not been subtracted from anything.",
  },
  "open-items-priority": {
    kind: "open-items-priority",
    title: "Priority note on open items past target",
    purpose: "Which of the open, overdue items a reader should look at first.",
    perSubject: false,
    instruction:
      "Write the priority note on open items past target. Say how many there are and which carry the highest priority or tier. Do not rank them by anything the data does not record.",
  },
  "special-projects": {
    kind: "special-projects",
    title: "Special project summary",
    purpose: "The projects in the period, their status and their variance against quote.",
    perSubject: false,
    instruction:
      "Summarise the special projects in the period: how many, their status, and the variance between approved quote and final cost where both are supplied. Special projects are excluded from the performance measurement; say so.",
  },
};

/** The badge §4.3 requires, as one string so panel and tests cannot drift. */
export const AI_DRAFT_BADGE = "AI draft — not yet reviewed";

export interface NarrativeBlock {
  /** `kind` for a document-level block, `kind:subjectId` for a per-hold one. */
  key: string;
  kind: NarrativeBlockKind;
  /** The hold this block explains, or null for a document-level block. */
  subjectId: string | null;
  /** The heading an operator reads. Carries the subject for a per-hold block. */
  title: string;
  prose: string;
  state: NarrativeBlockState;
  source: NarrativeBlockSource;
  /** The provider that drafted it, for the audit trail. Never a credential. */
  providerId: string | null;
  updatedAt: string | null;
  updatedByEmail: string | null;
}

export function narrativeBlockKey(
  kind: NarrativeBlockKind,
  subjectId?: string | null,
): string {
  return subjectId ? `${kind}:${subjectId}` : kind;
}

export function parseNarrativeBlockKey(
  key: string,
): { kind: NarrativeBlockKind; subjectId: string | null } | null {
  const separator = key.indexOf(":");
  const kind = (separator === -1 ? key : key.slice(0, separator)) as NarrativeBlockKind;
  if (!(NARRATIVE_BLOCK_KINDS as readonly string[]).includes(kind)) return null;
  const subjectId = separator === -1 ? null : key.slice(separator + 1) || null;
  if (NARRATIVE_BLOCKS[kind].perSubject !== Boolean(subjectId)) return null;
  return { kind, subjectId };
}

function holdTitle(hold: HoldRow): string {
  const reference = hold.reference ?? hold.requestId;
  return `Hold — ${reference}${hold.siteName ? ` (${hold.siteName})` : ""}`;
}

/**
 * The blocks THIS payload calls for.
 *
 * A block is planned only when the document has something for it to describe.
 * That is not a convenience: `narrativeReviewComplete` gates finalisation, so
 * planning a special-project paragraph for a period with no special projects
 * would mean a document that cannot be finalised until somebody reviews a
 * paragraph about nothing — and the reliable way out of that is to review it
 * without reading it, which trains people to dismiss the badge.
 */
export function plannedNarrativeBlocks(
  payload: CombinedReportPayload,
): Array<{ key: string; kind: NarrativeBlockKind; subjectId: string | null; title: string }> {
  const planned: Array<{
    key: string;
    kind: NarrativeBlockKind;
    subjectId: string | null;
    title: string;
  }> = [];
  const add = (kind: NarrativeBlockKind, subjectId: string | null, title: string) =>
    planned.push({ key: narrativeBlockKey(kind, subjectId), kind, subjectId, title });

  const maintenance = payload.maintenance;

  add("executive-summary", null, NARRATIVE_BLOCKS["executive-summary"].title);
  add("spend", null, NARRATIVE_BLOCKS.spend.title);
  add("requiring-attention", null, NARRATIVE_BLOCKS["requiring-attention"].title);

  for (const hold of maintenance.holds) {
    add("hold-explanation", hold.holdId, holdTitle(hold));
  }
  if (maintenance.openPastTarget.length > 0) {
    add("open-items-priority", null, NARRATIVE_BLOCKS["open-items-priority"].title);
  }
  if (maintenance.specialProjects.length > 0) {
    add("special-projects", null, NARRATIVE_BLOCKS["special-projects"].title);
  }

  return planned;
}

export function emptyNarrativeBlock(planned: {
  key: string;
  kind: NarrativeBlockKind;
  subjectId: string | null;
  title: string;
}): NarrativeBlock {
  return {
    key: planned.key,
    kind: planned.kind,
    subjectId: planned.subjectId,
    title: planned.title,
    prose: "",
    state: "empty",
    source: "none",
    providerId: null,
    updatedAt: null,
    updatedByEmail: null,
  };
}

/* ------------------------------------------------------ state transitions -- */

/**
 * A model draft has landed. Always `ai-draft`, whatever the block was before.
 *
 * The prose reaching here has ALREADY passed the validator — see
 * `draftNarrativeBlock` in `narrative-provider.ts`. This function does not
 * validate, because a function that sometimes validates is one a caller
 * eventually uses on the path where it does not.
 */
export function draftedBlock(
  block: NarrativeBlock,
  prose: string,
  providerId: string,
  at: string,
): NarrativeBlock {
  return {
    ...block,
    prose,
    state: "ai-draft",
    source: "model",
    providerId,
    updatedAt: at,
    updatedByEmail: null,
  };
}

/** A person typed. Editing IS reviewing — §4.3 says the badge clears on edit. */
export function editedBlock(
  block: NarrativeBlock,
  prose: string,
  email: string | null,
  at: string,
): NarrativeBlock {
  const trimmed = prose.trim();
  return {
    ...block,
    prose: trimmed,
    /* Emptying a block is not approving it. It goes back to having nothing. */
    state: trimmed ? "reviewed" : "empty",
    source: trimmed ? "human" : "none",
    providerId: trimmed ? block.providerId : null,
    updatedAt: at,
    updatedByEmail: email,
  };
}

/** A person read it and left it alone. The badge clears; the text does not move. */
export function acceptedBlock(
  block: NarrativeBlock,
  email: string | null,
  at: string,
): NarrativeBlock {
  if (!block.prose.trim()) return block;
  return { ...block, state: "reviewed", updatedAt: at, updatedByEmail: email };
}

/** Prose computed by `narrative.ts`. Reviewed on arrival — see the header. */
export function deterministicBlock(
  block: NarrativeBlock,
  prose: string,
  at: string,
): NarrativeBlock {
  const trimmed = prose.trim();
  if (!trimmed) return block;
  return {
    ...block,
    prose: trimmed,
    state: "reviewed",
    source: "deterministic",
    providerId: null,
    updatedAt: at,
    updatedByEmail: null,
  };
}

/* -------------------------------------------------- the finalisation gate -- */

/**
 * Blocks still carrying the badge.
 *
 * `empty` is NOT awaiting review. An operator who leaves a paragraph unwritten
 * has made a decision about the document, and refusing to finalise until they
 * write one would be this module deciding what the report must contain. The
 * badge is about unread MACHINE prose, and nothing else.
 */
export function blocksAwaitingReview(
  blocks: readonly NarrativeBlock[],
): NarrativeBlock[] {
  return blocks.filter((block) => block.state === "ai-draft");
}

/**
 * The predicate `blockers.ts` calls. True when nothing carries the badge.
 *
 * NOTE FOR THE CALLER: `tests/w9-report-engine.test.mjs` stages `blockers.ts`
 * and a fixed list of its neighbours into a temp directory and imports them by
 * relative path, so a VALUE import of this module from `blockers.ts` needs this
 * file (and `figure-validator.ts`) added to that list. The alternative, and the
 * one this codebase already uses for exactly this problem, is to pass the
 * answer down as data the way `BlockerInput.waivedIssueKeys` is passed — the
 * route resolves it and hands `blockers.ts` a boolean.
 */
export function narrativeReviewComplete(blocks: readonly NarrativeBlock[]): boolean {
  return blocksAwaitingReview(blocks).length === 0;
}

export const NARRATIVE_BLOCKER_CODE = "narrative.unreviewed";

/**
 * The blocker entry, pre-shaped so the caller does not have to invent a
 * message. Null when nothing is outstanding.
 */
export function narrativeReviewBlocker(
  blocks: readonly NarrativeBlock[],
): FinalisationBlocker | null {
  const awaiting = blocksAwaitingReview(blocks);
  if (awaiting.length === 0) return null;
  return {
    code: NARRATIVE_BLOCKER_CODE,
    message:
      awaiting.length === 1
        ? `One narrative block is still an unreviewed AI draft and must be accepted or edited before finalising: ${awaiting[0].title}.`
        : `${awaiting.length} narrative blocks are still unreviewed AI drafts and must be accepted or edited before finalising. The first is: ${awaiting[0].title}.`,
  };
}

/* ------------------------------------------------------ the locked figures -- */

export type LockedFigureKind = "count" | "money" | "percent" | "date" | "identifier";

export interface LockedFigure {
  /** Where in the payload it came from. The prompt shows this as the label. */
  path: string;
  kind: LockedFigureKind;
  value: number | string;
  /** How the report would print it, so the model can copy rather than format. */
  display: string;
}

interface Builder {
  numbers: Set<string>;
  amounts: Set<string>;
  percentages: Set<string>;
  dates: Set<string>;
  months: Set<string>;
  years: Set<string>;
  identifiers: Set<string>;
  figures: LockedFigure[];
  seen: Set<string>;
}

function newBuilder(): Builder {
  return {
    numbers: new Set(),
    amounts: new Set(),
    percentages: new Set(),
    dates: new Set(),
    months: new Set(),
    years: new Set(),
    identifiers: new Set(),
    figures: [],
    seen: new Set(),
  };
}

function poundsDisplay(pence: number): string {
  const negative = pence < 0;
  const whole = Math.floor(Math.abs(pence) / 100);
  const part = String(Math.abs(pence) % 100).padStart(2, "0");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}£${grouped}.${part}`;
}

function record(builder: Builder, figure: LockedFigure): void {
  const key = `${figure.path}=${figure.value}`;
  if (builder.seen.has(key)) return;
  builder.seen.add(key);
  builder.figures.push(figure);
}

function addCount(builder: Builder, path: string, value: number): void {
  if (!Number.isFinite(value)) return;
  builder.numbers.add(canonicalNumber(value));
  builder.numbers.add(canonicalNumber(Math.abs(value)));
  record(builder, { path, kind: "count", value, display: String(value) });
}

/**
 * A money figure, in BOTH denominations.
 *
 * The payload is integer pence and the prose is pounds, so 175800 is added as
 * "175800" and as "1758". Without both, "£1,758.00" — the only way a report
 * would ever write it — is an orphan against its own data.
 *
 * Magnitude and sign are both added because the validator reads money as a
 * magnitude (it cannot tell "£12.00 lower" from "-£12.00") while a bare number
 * in the prose may legitimately carry the sign the payload does.
 */
function addMoney(builder: Builder, path: string, pence: number): void {
  if (!Number.isFinite(pence)) return;
  for (const value of [pence, Math.abs(pence)]) {
    builder.amounts.add(canonicalNumber(value));
    builder.amounts.add(canonicalNumber(value / 100));
    builder.numbers.add(canonicalNumber(value));
    builder.numbers.add(canonicalNumber(value / 100));
  }
  record(builder, { path, kind: "money", value: pence, display: poundsDisplay(pence) });
}

function addPercent(builder: Builder, path: string, value: number): void {
  if (!Number.isFinite(value)) return;
  builder.percentages.add(canonicalNumber(value));
  builder.percentages.add(canonicalNumber(Math.abs(value)));
  builder.numbers.add(canonicalNumber(value));
  builder.numbers.add(canonicalNumber(Math.abs(value)));
  record(builder, { path, kind: "percent", value, display: `${value}%` });
}

function addDate(builder: Builder, path: string, iso: IsoDate): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
  builder.dates.add(iso);
  builder.months.add(iso.slice(0, 7));
  builder.years.add(iso.slice(0, 4));
  record(builder, { path, kind: "date", value: iso, display: iso });
}

/**
 * Free text from the payload, harvested for identifier-shaped tokens.
 *
 * The whole string goes in as well as its tokens, so both "MS-2026-003" and a
 * reference embedded in a sentence ("raised under JOB-1042") are recognised.
 * Upper-cased, because a reference is a label and its casing is presentation.
 */
function addText(builder: Builder, path: string, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (/\d/.test(trimmed) && /[A-Za-z]/.test(trimmed)) {
    builder.identifiers.add(trimmed.toUpperCase());
  }
  for (const token of trimmed.match(/\b[A-Za-z][A-Za-z0-9]*(?:[-_/][A-Za-z0-9]+)*\b/g) ?? []) {
    if (!/\d/.test(token)) continue;
    builder.identifiers.add(token.toUpperCase());
    record(builder, { path, kind: "identifier", value: token, display: token });
  }
}

/**
 * The recursive harvest.
 *
 * It reads the payload's own naming conventions rather than a hand-written list
 * of fields, and that is the point: `contract.ts` is disciplined about them —
 * `…Pence` is integer pence, `…Percent` is a percentage, `…BasisPoints` is a
 * hundredth of one — so a field added to the contract tomorrow is locked in
 * without anybody remembering to come back here. A field added under a NEW
 * convention is read as a plain count, which is the safe direction: it is
 * present in the set, so a true statement of it is not refused, and it is
 * present with its own value, so a false one still is.
 *
 * ARRAY LENGTHS ARE FIGURES. "3 data issues" is a number the report states and
 * the payload does not hold anywhere except as the size of a list.
 */
function harvest(builder: Builder, path: string, node: unknown, depth = 0): void {
  if (node === null || node === undefined || depth > 12) return;

  if (typeof node === "number") {
    if (/BasisPoints$/.test(path)) addPercent(builder, path, node / 100);
    else if (/Pence$/.test(path)) addMoney(builder, path, node);
    else if (/Percent$/.test(path)) addPercent(builder, path, node);
    else addCount(builder, path, node);
    return;
  }

  if (typeof node === "string") {
    const iso = /^(\d{4}-\d{2}-\d{2})/.exec(node);
    if (iso) addDate(builder, path, iso[1]);
    else addText(builder, path, node);
    return;
  }

  if (typeof node === "boolean") return;

  if (Array.isArray(node)) {
    addCount(builder, `${path}.length`, node.length);
    for (const [index, entry] of node.entries()) {
      harvest(builder, `${path}[${index}]`, entry, depth + 1);
    }
    return;
  }

  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      harvest(builder, path ? `${path}.${key}` : key, value, depth + 1);
    }
  }
}

/**
 * The comparisons, computed HERE so the model never has to.
 *
 * §4.2 requires the prior period's performance and volume to be carried for the
 * headline paragraph, which means the report states a DELTA — and a delta is
 * arithmetic on two payload figures, not a payload figure. If it were not
 * added here, a model that correctly wrote "6 fewer jobs than February" would
 * be refused for inventing 6, and the only ways out would be to weaken the
 * validator or to leave the comparison out of the report.
 *
 * These are exactly the derivations `narrative.ts` already performs, which is
 * what lets the deterministic executive summary pass its own validator.
 */
function addDerivedComparisons(builder: Builder, payload: CombinedReportPayload): void {
  const counts = payload.maintenance.executive.counts;
  const spend = payload.maintenance.spend;

  if (counts.previousTotalJobs !== null) {
    const change = counts.totalJobs - counts.previousTotalJobs;
    addCount(builder, "derived.jobVolumeChange", change);
    addCount(builder, "derived.jobVolumeChangeAbsolute", Math.abs(change));
    if (counts.previousTotalJobs > 0) {
      addPercent(
        builder,
        "derived.jobVolumeChangePercent",
        Math.round((Math.abs(change) / counts.previousTotalJobs) * 100),
      );
    }
  }

  if (spend.previousCompletedMaintenancePence !== null) {
    const change = spend.completedMaintenancePence - spend.previousCompletedMaintenancePence;
    addMoney(builder, "derived.completedSpendChangePence", change);
    addMoney(builder, "derived.completedSpendChangeAbsolutePence", Math.abs(change));
  }
}

/**
 * How many findings of each severity. Derived for the same reason the deltas
 * are: "3 data issues must be resolved before this document can be finalised"
 * is a sentence the report already writes, and 3 exists nowhere in the payload
 * except as the size of a filtered list. Without it the true sentence is
 * refused and the only ways out are to weaken the validator or to stop saying
 * how much the figures can be relied on.
 */
function addDerivedFindingCounts(builder: Builder, payload: CombinedReportPayload): void {
  const findings = payload.maintenance.dataQuality;
  for (const severity of ["blocking", "warning", "info"] as const) {
    addCount(
      builder,
      `derived.${severity}Findings`,
      findings.filter((finding) => finding.severity === severity).length,
    );
  }
}

function finish(builder: Builder): LockedFigureSet & { figures: LockedFigure[] } {
  return {
    numbers: builder.numbers,
    amounts: builder.amounts,
    percentages: builder.percentages,
    dates: builder.dates,
    months: builder.months,
    years: builder.years,
    identifiers: builder.identifiers,
    figures: builder.figures,
  };
}

export type LockedFigures = LockedFigureSet & { figures: LockedFigure[] };

/**
 * EVERY figure the payload legitimately contains.
 *
 * The whole document's set, for a caller that needs one — the export path, a
 * test, an operator wanting to see what the model may use. Generation uses
 * `lockedFiguresForBlock` instead, because a narrower set is a stricter check:
 * with the whole report in scope, a wrong spend figure has several hundred
 * unrelated counts to collide with; with only the spend subtree in scope it has
 * about a dozen.
 */
export function lockedFigureSet(payload: CombinedReportPayload): LockedFigures {
  const builder = newBuilder();
  harvest(builder, "", payload);
  addDerivedComparisons(builder, payload);
  addDerivedFindingCounts(builder, payload);
  return finish(builder);
}

/**
 * The subtrees each block is allowed to speak about.
 *
 * The period is in every one of them: every paragraph names the period it
 * describes, and a block that could not state its own dates would be refused
 * for its first sentence.
 */
function scopeFor(
  payload: CombinedReportPayload,
  kind: NarrativeBlockKind,
  subjectId: string | null,
): Array<[string, unknown]> {
  const maintenance = payload.maintenance;
  const base: Array<[string, unknown]> = [
    ["period", payload.period],
    ["previousPeriod", payload.previousPeriod],
    ["organisationName", payload.organisationName],
    ["invoice.invoiceNumber", payload.invoice.invoiceNumber],
  ];

  switch (kind) {
    case "executive-summary":
      return [
        ...base,
        ["maintenance.kpis", maintenance.kpis],
        ["maintenance.executive.counts", maintenance.executive.counts],
        ["maintenance.spend", maintenance.spend],
        ["maintenance.dataQuality", maintenance.dataQuality],
        ["invoice.totals.includedSites", payload.invoice.totals.includedSites],
      ];
    case "spend":
      return [
        ...base,
        ["maintenance.spend", maintenance.spend],
        ["maintenance.siteSummaryTotals", maintenance.siteSummaryTotals],
        ["maintenance.siteSummary", maintenance.siteSummary],
        ["maintenance.kpis", maintenance.kpis],
      ];
    case "requiring-attention":
      return [
        ...base,
        ["maintenance.kpis", maintenance.kpis],
        ["maintenance.openPastTarget", maintenance.openPastTarget],
        ["maintenance.criticalOpen", maintenance.criticalOpen],
        ["maintenance.holds", maintenance.holds],
        ["maintenance.dataQuality", maintenance.dataQuality],
      ];
    case "hold-explanation": {
      const hold = maintenance.holds.find((row) => row.holdId === subjectId);
      const sla = hold
        ? maintenance.sla.find((row) => row.requestId === hold.requestId)
        : undefined;
      return [
        ...base,
        ["maintenance.hold", hold ?? null],
        ["maintenance.holdSla", sla ?? null],
      ];
    }
    case "open-items-priority":
      return [
        ...base,
        ["maintenance.openPastTarget", maintenance.openPastTarget],
        ["maintenance.criticalOpen", maintenance.criticalOpen],
        ["maintenance.kpis.openJobsPastTarget", maintenance.kpis.openJobsPastTarget],
        ["maintenance.kpis.criticalOpenJobs", maintenance.kpis.criticalOpenJobs],
      ];
    case "special-projects":
      return [
        ...base,
        ["maintenance.specialProjects", maintenance.specialProjects],
        ["maintenance.spend.projectPence", maintenance.spend.projectPence],
      ];
    default:
      return base;
  }
}

/**
 * The locked block one narrative block is generated against.
 *
 * `subjectId` narrows a per-hold block to THAT hold and the SLA row it belongs
 * to. A hold explanation that could quote any hold's dates would be a hold
 * explanation that can quote the wrong ones and still pass.
 */
export function lockedFiguresForBlock(
  payload: CombinedReportPayload,
  key: string,
): LockedFigures {
  const parsed = parseNarrativeBlockKey(key);
  const builder = newBuilder();
  if (!parsed) return finish(builder);

  for (const [path, node] of scopeFor(payload, parsed.kind, parsed.subjectId)) {
    harvest(builder, path, node);
  }
  /* The comparison deltas belong to the headline and the spend paragraph. */
  if (parsed.kind === "executive-summary" || parsed.kind === "spend") {
    addDerivedComparisons(builder, payload);
  }
  /* The finding counts belong to the two paragraphs that qualify the figures. */
  if (parsed.kind === "executive-summary" || parsed.kind === "requiring-attention") {
    addDerivedFindingCounts(builder, payload);
  }
  return finish(builder);
}
