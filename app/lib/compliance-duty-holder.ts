/**
 * WHOSE OBLIGATION A COMPLIANCE REQUIREMENT IS — and whether it has been said
 * out loud yet.
 *
 * ── WHY THIS IS NOT CALLED `responsibility` ───────────────────────────────
 *
 * Because that name is taken, by a different question. `StoreDocumentSlot.
 * responsibility` in `db/monday-board-spec.ts` and `responsibilityFor()` in
 * `app/lib/compliance-view.ts` answer "WHO CHASES THIS CERTIFICATE" — a static
 * per-slot string reading Contractor, Fire safety partner, Insurance broker,
 * Electrical contractor, Water hygiene partner or Projects team, falling back
 * to the site manager. It is already a filter dimension on the register (`?who=`).
 *
 * This module answers "WHOSE DUTY IS THE UNDERLYING OBLIGATION" — the client's,
 * the landlord's, the shopping centre's, or nobody's because the asset does not
 * exist at that unit. Those are orthogonal: a fire alarm service can be chased
 * by the fire safety partner and still be the landlord's liability in a mall.
 *
 * Two axes with one name is how a filter starts quietly answering the wrong
 * question, so the column and the type are `duty_holder`. The words a person
 * reads are still "Responsibility" and "Responsibility not confirmed", because
 * that is the product's own language — `dutyHolderLabel` is the only place the
 * two vocabularies meet.
 *
 * ── WHY `null` AND `"unconfirmed"` ARE DIFFERENT, AND MUST STAY DIFFERENT ──
 *
 * This is the whole design, and getting it wrong would silently rewrite the
 * headline compliance figure for an estate of 748 records.
 *
 *   null           A requirement nobody has ever been asked about. Every row
 *                  that existed before this column did. It counts EXACTLY as it
 *                  counted before — see `countsTowardCompliance`. Absence of an
 *                  answer is not an answer, and must not be read as one.
 *
 *   "unconfirmed"  A requirement this system CREATED and is explicitly waiting
 *                  on. Written positively, by `ensureComplianceProfile`, at the
 *                  moment the row is made. Excluded from the percentage.
 *
 * If auto-created rows were left NULL instead, they would be indistinguishable
 * from the pre-existing estate, and the only way to exclude them would be to
 * exclude everything — turning a 15% portfolio figure into "nothing is
 * confirmed anywhere". If instead the pre-existing estate were treated as
 * unconfirmed, the same thing happens from the other direction. The marker has
 * to be positive, and it has to be written at creation.
 *
 * This is the "omitted versus cleared" distinction that has bitten the four
 * site write paths before. It is stated here so it is not rediscovered.
 */

/** The answers a person may give. `unconfirmed` is the absence of one. */
export const DUTY_HOLDERS = ["client", "landlord", "centre", "not_applicable"] as const;

export type DutyHolder = (typeof DUTY_HOLDERS)[number];

/**
 * What an auto-created requirement is stamped with.
 *
 * A real stored value rather than NULL, for the reason argued above. It is not
 * in `DUTY_HOLDERS` because it is not a duty holder — it is the statement that
 * nobody has named one.
 */
export const DUTY_HOLDER_UNCONFIRMED = "unconfirmed";

/** Everything the column may legally hold, for validating a write. */
export const DUTY_HOLDER_VALUES: readonly string[] = [
  ...DUTY_HOLDERS,
  DUTY_HOLDER_UNCONFIRMED,
];

export function isDutyHolder(value: unknown): value is DutyHolder {
  return typeof value === "string" && (DUTY_HOLDERS as readonly string[]).includes(value);
}

/**
 * The words the product prints. See the naming note above for why these say
 * "Responsibility" while the field says duty holder.
 */
export function dutyHolderLabel(value: string | null | undefined): string {
  switch (value) {
    case "client":
      return "Client";
    case "landlord":
      return "Landlord";
    case "centre":
      return "Shopping centre";
    case "not_applicable":
      return "Not applicable";
    case DUTY_HOLDER_UNCONFIRMED:
      return "Responsibility not confirmed";
    default:
      // NULL — never asked. Not the same sentence as "asked and not answered".
      return "Responsibility not recorded";
  }
}

/**
 * DOES THIS REQUIREMENT BELONG IN THE COMPLIANCE PERCENTAGE?
 *
 * The one rule, so the portfolio meter, the per-site meter, the Sites row and
 * the Overview tile cannot disagree — the same reason `complianceCompletion`
 * exists at all.
 *
 *   null            YES. Today's behaviour, unchanged, for every row that
 *                   predates this column. Anything else would restate the
 *                   estate's compliance from a column nobody has filled in.
 *   "client"        YES. Confirmed as ours to administer: it is scheduled, it
 *                   generates due dates, and it is scored.
 *   "unconfirmed"   NO. We have not been told whose it is. Scoring it would
 *                   report a failure that may belong to a landlord, or to an
 *                   asset the unit does not have.
 *   "landlord"      NO. Recorded and displayed, not scheduled by Maintsupp, and
 *   "centre"        not scored against us. Maintsupp administers a schedule; it
 *                   does not assume responsibility for assets it was never
 *                   given.
 *   "not_applicable" NO. There is no obligation to be in date about.
 *
 * A value the column should not hold is treated as NOT counting, deliberately:
 * an unrecognised string is a defect, and the safe direction for a defect is to
 * leave a requirement out of a compliance claim rather than to assert one.
 */
export function countsTowardCompliance(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return value === "client";
}

/**
 * THE DUTY HOLDER FOR A REQUIREMENT THE BOARD ITSELF SPEAKS FOR.
 *
 * A defect this exists to prevent, found in review and confirmed by tracing
 * `registerRowFor` — the join, not a screen.
 *
 * `ensureComplianceProfile` writes one annotation row per requirement KIND, and
 * those kinds are `storeDocumentationKinds` — exactly the twelve labels a Store
 * Documentation board slot carries. `readComplianceRegister` looks an
 * annotation up by `${siteId}::${kind}`, so once a site has been given a
 * profile, every BOARD slot of that site finds one of these rows and adopts its
 * duty holder. A requirement with a real, in-date certificate on the board
 * would therefore inherit "unconfirmed" and drop out of the compliance score
 * entirely: a store reading 25% would read "—", and its satisfied requirements
 * would leave the numerator and the denominator together.
 *
 * The resolution is not to distrust the annotation but to read the placeholder
 * for what it is. "unconfirmed" means "this system created a requirement and
 * nobody has said whose it is". A BOARD ROW IS THAT ANSWER: somebody set this
 * store up on the compliance board and has been filing certificates against it,
 * which is positive evidence that the requirement is administered here. The
 * placeholder must not override it.
 *
 * A HUMAN answer still wins, which is the whole reason this is not simply
 * `?? null`: if somebody has said a board-tracked fire alarm is the landlord's,
 * that is a decision and it survives.
 *
 * Not reproducible on the development estate — its 192 board-derived
 * requirements belong to board rows whose titles match no site, so the join
 * never fires there. That is a property of the fixtures, not a defence.
 */
export function boardDutyHolder(stored: string | null | undefined): string | null {
  if (stored === DUTY_HOLDER_UNCONFIRMED) return null;
  return stored ?? null;
}

/**
 * Is this requirement hidden from the register?
 *
 * "Not applicable" is the duty-holder answer that means the asset is not there
 * — a kiosk with no gas and no stored water. It maps onto the state the product
 * already has a word for, `Not required`, rather than adding a sixth state that
 * eleven test suites, the digest email and the CSV export would all have to
 * learn. The REASON is kept, which is what the spec asks for: the row is still
 * there, still says "Not applicable", and can be changed back.
 */
export function isNotApplicable(value: string | null | undefined): boolean {
  return value === "not_applicable";
}
