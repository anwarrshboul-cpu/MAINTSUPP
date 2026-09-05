/**
 * THE DOCUMENT NUMBER — `MS-2026-001`. Format and guards, nothing else.
 *
 * ── WHAT THIS MODULE IS NOT ────────────────────────────────────────────────
 *
 * It is not an allocator, and it must not become one. `issueInvoiceNumber` in
 * `app/lib/billing/settings.ts` already allocates, and allocates correctly: a
 * compare-and-swap against `billing_settings.invoice_sequence` that advances the
 * counter only if it is still the value that was read, retried a bounded number
 * of times, with the partial UNIQUE index on `(organisation_id,
 * invoice_number)` as the backstop that proves no two documents took the same
 * value. Nothing here touches a database, and a second counter alongside that
 * one would be two answers to "what is the next number", which is the whole
 * failure the UNIQUE index exists to catch.
 *
 * What was wrong was the SHAPE. The old format was `MS-00042` — prefix and a
 * five-digit pad, with no year in it — and Module 4 §5.1 requires
 * `MS-YYYY-NNN`. So this module owns the format, the parse, the per-year reset
 * rule and the status guard, as pure functions, and the allocator calls into
 * them.
 *
 * ── WHY THE COUNTER ONLY EVER MOVES FORWARD ────────────────────────────────
 *
 * "Invoice numbers are … never reused after a void" is an acceptance criterion
 * (§10), and §7 says a voided document is retained, watermarked and its number
 * never reissued. That rules out the obvious implementation — `max(existing
 * number) + 1` — completely, and it is worth being explicit about why, because
 * `max + 1` looks correct and passes every test written against a tidy table:
 *
 *   MS-2026-004 is finalised, then voided. It is the highest number issued.
 *   `max + 1` now returns 004 again, and the next invoice — different client,
 *   different money — goes out carrying a number a client has already seen.
 *   Nobody can settle that dispute afterwards, because both documents are real.
 *
 * A stored counter cannot do that. It is advanced when a number is CONSUMED,
 * and voiding a document does not wind it back, so a voided number stays spent
 * and the sequence has a hole in it. The hole is the evidence. "Gapless" in
 * §5.1 means the counter issues consecutive values, not that every value ends
 * up on a live document.
 *
 * ── ALLOCATION HAPPENS ONCE, AT FINALISATION ───────────────────────────────
 *
 * §7 is precise about where: Approved is "locked, exportable, NOT YET NUMBERED";
 * Finalised is where "the invoice number is assigned and consumed". So the
 * number is taken during the Approved → Finalised transition and at no other
 * moment — not on save, not on approve, not on export. A draft that is
 * abandoned has therefore consumed nothing, which is what keeps the sequence
 * meaningful, and `canAssignNumber` is the guard that says so out loud.
 */

import type { InvoiceStatus } from "./contract";

/** The prefix the templates use. A workspace may override it in settings. */
export const DEFAULT_DOCUMENT_PREFIX = "MS";

/**
 * Three digits, and what happens at 1000.
 *
 * `MS-2026-001` is the template's shape and three digits covers a workspace
 * issuing up to 999 documents in a year, which is a long way past this client's
 * volume. Past that the number WIDENS to four digits rather than wrapping or
 * truncating: `MS-2026-1000`. Wrapping would reissue 001 and truncating would
 * collide with it, and both are the reuse §10 forbids — a longer number is
 * merely unusual, where a repeated one is a dispute.
 *
 * Consequence worth knowing: within a year, numbers no longer sort correctly as
 * TEXT once four digits appear (`MS-2026-1000` sorts before `MS-2026-999`).
 * Order by the stored sequence, which is an integer, not by the rendered string.
 */
export const DOCUMENT_NUMBER_DIGITS = 3;

/** The one status at which a number is taken. See the header. */
export const NUMBER_ASSIGNED_AT: InvoiceStatus = "Finalised";

const DOCUMENT_NUMBER = /^([^\s-]+)-(\d{4})-(\d{3,})$/;

/**
 * `MS-2026-001`.
 *
 * Rejects nothing and throws nothing — it is a formatter, and the caller that
 * hands it a year of 0 or a sequence of −1 has a fault upstream of here that a
 * thrown error at the last moment would only disguise. A sequence below 1 is
 * clamped to 1 because there is no zeroth document; the counter starts at one.
 */
export function formatDocumentNumber(
  prefix: string,
  year: number,
  sequence: number,
): string {
  const cleanPrefix = (prefix ?? "").trim() || DEFAULT_DOCUMENT_PREFIX;
  const safeYear = Math.trunc(year);
  const safeSequence = Math.max(1, Math.trunc(sequence));
  return `${cleanPrefix}-${String(safeYear).padStart(4, "0")}-${String(safeSequence).padStart(
    DOCUMENT_NUMBER_DIGITS,
    "0",
  )}`;
}

export interface ParsedDocumentNumber {
  prefix: string;
  year: number;
  sequence: number;
}

/**
 * A document number read back apart, or null.
 *
 * Deliberately strict about the padding: `MS-2026-0001` is REJECTED even though
 * it is legible, because this product never writes it — four digits appear only
 * above 999, where there is no leading zero. The parse exists to recognise a
 * number this system issued, and accepting spellings it does not issue is how a
 * hand-typed reference gets treated as a match for a document that has a
 * different one.
 */
export function parseDocumentNumber(value: string | null | undefined): ParsedDocumentNumber | null {
  if (typeof value !== "string") return null;
  const match = DOCUMENT_NUMBER.exec(value.trim());
  if (!match) return null;
  const digits = match[3];
  if (digits.length > DOCUMENT_NUMBER_DIGITS && digits.startsWith("0")) return null;
  const sequence = Number(digits);
  if (!Number.isFinite(sequence) || sequence < 1) return null;
  return { prefix: match[1], year: Number(match[2]), sequence };
}

export interface NextDocumentNumber {
  year: number;
  sequence: number;
}

/**
 * The counter's next position — the pair, not just the number.
 *
 * The year and the sequence move TOGETHER: on a rollover the sequence resets to
 * 1 and the year changes in the same step, so returning only a sequence would
 * leave the caller to work out which year it belongs to, and getting that wrong
 * writes MS-2027-001 while the stored year still says 2026. The pair is what
 * gets both stored on the counter and formatted onto the document.
 *
 * The rules, and why each one is the way round it is:
 *
 *   · A LATER year resets to 001. §5.1's format carries the year, so the
 *     sequence is per-year by construction; without the reset the first invoice
 *     of 2027 would be MS-2027-138 and the year would be decoration.
 *   · The SAME year increments, always by one, from the stored value. Never
 *     from `max(existing) + 1` — see the header for the void that reissues.
 *   · An EARLIER target year does NOT reset. A backdated document, or a clock
 *     that steps backwards, must not send the counter back through numbers it
 *     has already spent, so the stored year wins and the sequence simply
 *     advances. That is a strange-looking number on an unusual document, which
 *     is the right kind of wrong: visible, and not a duplicate.
 */
export function nextSequenceForYear(
  currentYear: number,
  currentSequence: number,
  targetYear: number,
): NextDocumentNumber {
  const storedYear = Math.trunc(currentYear);
  const stored = Math.max(0, Math.trunc(currentSequence));
  const wanted = Math.trunc(targetYear);
  if (wanted > storedYear) return { year: wanted, sequence: 1 };
  return { year: storedYear, sequence: stored + 1 };
}

/**
 * Whether a number may be assigned as part of this transition.
 *
 * The argument is the status the document is moving TO, and the only answer is
 * Finalised. Approved is rejected on purpose rather than by omission — §7 calls
 * an approved document "not yet numbered", and numbering at approval would burn
 * a number on a document that can still be sent back for review. Draft and
 * Ready for Review have nothing to number. Voided is rejected because a void
 * consumes nothing and returns nothing: the number it held stays held.
 *
 * Typed against `string` rather than `InvoiceStatus` because the value reaching
 * this guard is usually a column read, and a status the state machine does not
 * recognise must be refused rather than assumed benign.
 */
export function canAssignNumber(status: string | null | undefined): boolean {
  return status === NUMBER_ASSIGNED_AT;
}
