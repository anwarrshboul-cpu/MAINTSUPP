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

/* ── The words a CONTROL needs, so nothing retypes the vocabulary ─────────── */

/**
 * The four answers, each already carrying the word a person reads.
 *
 * Built from `DUTY_HOLDERS` and `dutyHolderLabel` rather than written out
 * again, because a hand-typed option list is how a fifth spelling of "centre"
 * reaches the database. Every control that offers the choice — the per-record
 * select on the register, the bulk bar in the confirmation queue — renders this
 * array and posts `value`, so the string the browser sends is by construction
 * one `isDutyHolder` accepts.
 *
 * `unconfirmed` is deliberately absent. It is not an answer a person may give;
 * it is the machine's statement that nobody has given one, and offering it in a
 * menu would invite somebody to "set" a requirement back to unanswered by
 * choosing it — which is what clearing the value does, and clearing is offered
 * separately as "Not recorded".
 */
export const DUTY_HOLDER_CHOICES: ReadonlyArray<{ value: DutyHolder; label: string }> =
  DUTY_HOLDERS.map((value) => ({ value, label: dutyHolderLabel(value) }));

/**
 * A one-line explanation of what each answer commits the product to.
 *
 * Used as the control's `title` and its accessible description, for the same
 * reason `COMPLIANCE_MEANING` exists beside the status chips: a reader picking
 * "Landlord" is deciding that this requirement leaves the compliance
 * percentage, and a menu that does not say so is asking them to guess.
 */
export function dutyHolderMeaning(value: string | null | undefined): string {
  switch (value) {
    case "client":
      return "Ours to administer. Scheduled, chased, and counted in the compliance score.";
    case "landlord":
      return "The landlord's obligation. Recorded and displayed, not scored against us.";
    case "centre":
      return "The shopping centre's obligation. Recorded and displayed, not scored against us.";
    case "not_applicable":
      return "The asset is not at this unit, so there is no obligation to be in date about.";
    case DUTY_HOLDER_UNCONFIRMED:
      return "Created by this system and waiting on somebody to say whose it is. Not scored.";
    default:
      return "Nobody has been asked. Counts exactly as it did before responsibilities were recorded.";
  }
}

/* ── Coverage: how much of a register has been answered for ───────────────── */

/**
 * WHAT THE READER IS TOLD ABOUT HOW MUCH HAS BEEN CONFIRMED — and why it can
 * never be a percentage.
 *
 * `complianceCompletion().percent` is a claim about CERTIFICATES; this is a
 * count of ANSWERS. Printing the second as a percentage is the exact defect the
 * duty-holder design exists to prevent: a brand-new site has twelve
 * requirements, none of them confirmed, and "0%" beside the word compliance is
 * read as "this store is failing" by every person who has ever seen a
 * dashboard. It is not failing. Nobody has been asked yet.
 *
 * So there are two sentences and no third:
 *
 *   "3 of 12 requirements confirmed"   at least one answer exists
 *   "Not yet confirmed"                no answer exists       — NEVER "0%"
 *
 * `total === 0` is a third fact again — there is nothing to confirm — and gets
 * the phrase the register already uses for it, so the queue and the group
 * header do not describe an empty site two ways.
 */
export const RESPONSIBILITY_NOT_CONFIRMED = "Not yet confirmed";

/** The phrase for a site that has no requirements at all to confirm. */
export const RESPONSIBILITY_NOTHING_TO_CONFIRM = "No requirements set";

export type ResponsibilityCoverage = {
  /** Requirements carrying one of the four real answers. */
  confirmed: number;
  /** Requirements this system created and is explicitly waiting on. */
  unconfirmed: number;
  /**
   * Requirements nobody has ever been asked about — the NULL estate.
   *
   * Counted apart from `unconfirmed` for the reason argued at the top of this
   * file: they are different facts, and only the second belongs in a queue that
   * says "these are waiting on you". Every row that predates the column is in
   * here, and pulling them into the queue would invite one pass of clicking to
   * restate the compliance figure for an estate nobody had changed.
   */
  neverAsked: number;
  total: number;
  /** Every requirement has an answer. */
  complete: boolean;
  /** The sentence to print. NEVER contains a percent sign. */
  label: string;
};

/**
 * Coverage over a set of records — one site's, or a whole portfolio's.
 *
 * Takes the same loose record shape `complianceCompletion` takes, so a caller
 * that already has `ComplianceRow[]` or `ComplianceItem[]` passes them straight
 * through and the two numbers on screen are computed from one array.
 */
export function responsibilityCoverage(
  records: readonly { dutyHolder?: string | null }[],
): ResponsibilityCoverage {
  let confirmed = 0;
  let unconfirmed = 0;
  let neverAsked = 0;
  for (const record of records) {
    const value = record.dutyHolder;
    if (isDutyHolder(value)) confirmed += 1;
    else if (value === DUTY_HOLDER_UNCONFIRMED) unconfirmed += 1;
    else neverAsked += 1;
  }
  const total = records.length;
  return {
    confirmed,
    unconfirmed,
    neverAsked,
    total,
    complete: total > 0 && confirmed === total,
    label: !total
      ? RESPONSIBILITY_NOTHING_TO_CONFIRM
      : confirmed === 0
        ? RESPONSIBILITY_NOT_CONFIRMED
        : `${confirmed} of ${total} requirement${total === 1 ? "" : "s"} confirmed`,
  };
}

/**
 * WHAT "NOT REQUIRED" MUST BE AFTER A RESPONSIBILITY IS CHANGED.
 *
 * `isNotApplicable` explains why the answer "Not applicable" is stored as the
 * `not_required` flag rather than as a sixth `ComplianceState`. That mapping
 * has a direction nobody had needed until a control existed to change an answer
 * a SECOND time, and getting it wrong makes the answer a one-way door: mark a
 * kiosk's gas certificate Not applicable, realise it was the wrong store,
 * change it to Landlord — and the requirement stays flagged not-required
 * forever, out of the register's applicable count, with nothing on screen
 * explaining why.
 *
 * So the flag follows the answer that set it, and only that one:
 *
 *   next is not_applicable        → true.  The answer means the asset is absent.
 *   stored WAS not_applicable     → false. That answer has been withdrawn.
 *   neither                       → unchanged. Somebody ticked "Not required"
 *                                   in Manage register for their own reasons and
 *                                   a responsibility edit is not the place to
 *                                   silently undo it.
 *
 * Stated as a pure function here, in the module that owns the vocabulary,
 * rather than inline in a route handler — there are now two write paths and
 * they must not disagree about it.
 */
export function notRequiredAfterDutyHolder(
  stored: string | null | undefined,
  next: string | null,
  notRequired: boolean,
): boolean {
  if (isNotApplicable(next)) return true;
  if (isNotApplicable(stored)) return false;
  return notRequired;
}
