"use client";

import { useState, type ReactNode } from "react";

/**
 * SECTION 7 — Pricing.
 *
 * WHAT THE PAGE SAYS: two plans a reader chooses between, one smaller option
 * beside them, four portfolio bands, and the actual numbers — except above
 * fifty stores, where the honest answer is a conversation and the card says so
 * rather than inventing a rate.
 *
 * THE READER GIVES ONE NUMBER. A slider for how many stores they have; the band
 * follows, the per-store rate follows, and each card shows what that costs them
 * per month. Asking someone to pick a band first asks them to work out which
 * band fourteen stores is in, which is the calculator's job.
 *
 * ── WHAT CHANGED IN THIS REVISION, AND WHY EACH ONE MATTERS ───────────────
 *
 * TWO MAIN CARDS, NOT THREE EQUAL ONES. Essential and Complete are the choice;
 * Compliance Administration is a smaller option beside them. Three equal cards
 * asked the reader to compare three things when only two of them are the
 * decision — and the third is a component of the second, which a row of equals
 * cannot say.
 *
 * THE MATRIX IS GONE. Below 768px this section used to swap the cards for a
 * nineteen-row comparison table, because three stacked cards ran to 2294px.
 * Two cards and a compact third do not, so the table is deleted rather than
 * kept for a problem that no longer exists. It took a `(min-width:601px)`
 * media query with it, which was the one width in this stylesheet outside the
 * five the parity tests permit.
 *
 * THE TOP BAND CARRIES NO NUMBER, and that is deliberate. Fifty-one stores and
 * up is "Book a Portfolio Review", so `rate` is `null` there and every place
 * that would print a figure asks first. A made-up rate for a portfolio nobody
 * has scoped is worse than an invitation to talk.
 *
 * THE SAVING IS COMPUTED, NOT TYPED. Essential + Compliance − Complete at
 * whatever band is showing: £20 at every band that has numbers (55+50−85,
 * 50+48−78, 45+45−70). Deriving it means the badge cannot come to contradict
 * the cards above it after a price change.
 *
 * NO PRICE CARRIES "+ VAT", AND THAT IS THE RULE. This comment used to say the
 * opposite and was enforced by a test named "every price is shown + VAT";
 * Homepage V3 reversed both. It is a REMOVAL, not a substitution — "excluding
 * VAT" and "ex. VAT" are the same qualifier wearing a different hat, so none of
 * them replaced it. The inverted test is
 * `tests/stage-twentyeight-landing-rebuild.test.mjs`.
 */

/**
 * The four bands, at the approved rates.
 *
 * `null` is the top band's rate and means "Book a Portfolio Review". It is
 * `null` rather than 0 or a sentinel string so that anything printing a figure
 * has to handle its absence in the type system rather than by remembering to.
 */
const BANDS = [
  { id: "b5", label: "5–10 stores", min: 5, max: 10, essential: 55, compliance: 50, complete: 85 },
  { id: "b11", label: "11–25 stores", min: 11, max: 25, essential: 50, compliance: 48, complete: 78 },
  { id: "b26", label: "26–50 stores", min: 26, max: 50, essential: 45, compliance: 45, complete: 70 },
  {
    id: "b51",
    label: "51+ stores",
    min: 51,
    max: Infinity,
    essential: null,
    compliance: null,
    complete: null,
  },
] as const;

/** The band a portfolio of `count` stores falls in. */
function bandForCount(count: number) {
  return BANDS.find((entry) => count <= entry.max) ?? BANDS[BANDS.length - 1];
}

/* The slider opens at the bottom of the bottom band and reaches past the top
   one, so a reader with sixty stores can arrive at "Book a Portfolio Review"
   by dragging rather than by reading a footnote. */
const SLIDER_MIN = 5;
const SLIDER_MAX = 60;

type Band = (typeof BANDS)[number];
type PlanKey = "essential" | "compliance" | "complete";

/** The portfolio floor, and the onboarding fee, in one place each. */
const PORTFOLIO_MINIMUM = 300;
const ONBOARDING_PER_STORE = 75;
const ONBOARDING_CAP = 1200;
const OUT_OF_HOURS_P1 = 125;
const REVIEW = "Book a Portfolio Review";

const CHECK = <path d="M20 6 9 17l-5-5" />;

function Tick() {
  return (
    <svg
      className="ic ic--sm"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {CHECK}
    </svg>
  );
}

/**
 * The price line.
 *
 * `amount` is `null` in the top band, where the card offers a conversation
 * instead of a number. `was` is the same plan's entry-band rate, struck through
 * only once the reader has moved past that band — a "was £55" beside £55 is
 * noise, and beside £45 it is the discount.
 */
function Price({ amount, was }: { amount: number | null; was: number }) {
  if (amount === null) {
    return (
      <div className="pkg__price pkg__price--talk">
        <span className="pkg__talk">{REVIEW}</span>
        <span className="pkg__per">for portfolios over 50 stores</span>
      </div>
    );
  }
  return (
    <div className="pkg__price">
      <span className="pkg__num">£{amount}</span>
      {was > amount && (
        <s className="pkg__was" aria-label={`Down from £${was} per store`}>
          £{was}
        </s>
      )}
      <span className="pkg__per">per store / month</span>
    </div>
  );
}

type Plan = {
  key: PlanKey;
  title: string;
  for: string;
  icon: ReactNode;
  /** The plans whose entire feature set this plan contains. */
  rollup?: readonly PlanKey[];
};

/**
 * The two plans the reader is choosing between.
 *
 * Compliance Administration is deliberately NOT in this list — it is rendered
 * once, smaller, below them. Keeping it out of `MAIN_PLANS` is what stops a
 * later edit quietly restoring it to a third equal column.
 */
const MAIN_PLANS: readonly Plan[] = [
  {
    key: "essential",
    title: "Essential",
    for: "Reactive repairs, run end to end.",
    icon: <path d="M14.7 6.3a4 4 0 1 0 5 5L21 21H3l9.7-9.7a4 4 0 0 1 2-4.9Z" />,
  },
  {
    key: "complete",
    title: "Complete",
    for: "Repairs and compliance together, plus a quarterly portfolio review.",
    icon: (
      <>
        <path d="m12 2 9 5v10l-9 5-9-5V7Z" />
        <path d="m3 7 9 5 9-5M12 12v10" />
      </>
    ),
    rollup: ["essential", "compliance"],
  },
];

/** The smaller option beside them. */
const COMPLIANCE_PLAN: Plan = {
  key: "compliance",
  title: "Compliance Administration",
  for: "Certificates tracked before they expire.",
  icon: (
    <>
      <path d="M12 21s8-3.5 8-9V5l-8-3-8 3v7c0 5.5 8 9 8 9Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
};

const ALL_PLANS: readonly Plan[] = [MAIN_PLANS[0]!, COMPLIANCE_PLAN, MAIN_PLANS[1]!];

/* Every feature, once, against the plan that introduces it. The cards derive
   their bullet lists from this, so "Everything in Essential" on the Complete
   card cannot come to describe a set the Essential card no longer lists. */
const FEATURES: readonly { label: string; plan: PlanKey }[] = [
  { label: "Intake & triage", plan: "essential" },
  { label: "Contractor assignment", plan: "essential" },
  { label: "Quote control", plan: "essential" },
  { label: "Attendance chasing", plan: "essential" },
  { label: "Photo-verified close-out", plan: "essential" },
  { label: "Monthly report", plan: "essential" },
  { label: "Certificate register", plan: "compliance" },
  { label: "90/60/30-day reminders", plan: "compliance" },
  { label: "Provider booking", plan: "compliance" },
  { label: "Certificate chasing", plan: "compliance" },
  { label: "Remedial tracking", plan: "compliance" },
  { label: "Traffic-light compliance dashboard", plan: "compliance" },
  { label: "Quarterly portfolio review", plan: "complete" },
];

/**
 * The card's bullet list: a plan's own features, preceded by one line per
 * rolled-up plan. Complete therefore reads "Everything in Essential /
 * Everything in Compliance Administration / Quarterly portfolio review" —
 * derived, so it cannot drift from what the other cards claim.
 */
function cardPoints(plan: Plan) {
  const own = FEATURES.filter((feature) => feature.plan === plan.key).map((f) => f.label);
  if (!plan.rollup) return own;
  const titleOf = (key: PlanKey) => ALL_PLANS.find((entry) => entry.key === key)?.title ?? key;
  return [...plan.rollup.map((key) => `Everything in ${titleOf(key)}`), ...own];
}

function PlanIcon({ icon }: { icon: ReactNode }) {
  return (
    <span className="pkg__icon">
      <svg
        className="ic"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {icon}
      </svg>
    </span>
  );
}

export function Pricing() {
  /*
   * The store count is the single input, and the band follows from it. The
   * band buttons stay as a keyboard-friendly way to jump between bands, and
   * setting one moves the slider to that band's low end so the two controls
   * can never disagree.
   *
   * IT OPENS AT FIVE. Five is the bottom of the bottom band and the number the
   * page already tells the reader it is for — "typically 5–50 locations" on the
   * Who we help note — so the calculator opens on the bottom of the range the
   * site claims to serve rather than in the middle of it.
   */
  const [storeCount, setStoreCount] = useState(SLIDER_MIN);
  const band = bandForCount(storeCount);
  const bandId = band.id;
  const setBandId = (id: Band["id"]) => {
    const target = BANDS.find((entry) => entry.id === id) ?? BANDS[0];
    setStoreCount(target.min);
  };

  const entryBand = BANDS[0];
  /* Both parts bought separately, against Complete — computed, never typed,
     and absent in the band that carries no rates. */
  const saving =
    band.essential !== null && band.compliance !== null && band.complete !== null
      ? band.essential + band.compliance - band.complete
      : null;

  const plural = storeCount === 1 ? "store" : "stores";

  /* The sentence under the slider, for ANY band at ANY count rather than only
     the current pair — hidden twins of it are what reserve the row's height. */
  const noteForBand = (entry: Band, count: number) => {
    const head = `At ${count} ${count === 1 ? "store" : "stores"} you are on the ${entry.label} rate`;
    if (entry.complete === null) {
      return `${head} — above fifty stores we scope the portfolio with you before quoting.`;
    }
    if (entry.id === entryBand.id) return `${head}.`;
    return `${head} — £${entryBand.complete - entry.complete} per store below the ${entryBand.label} rate on Complete.`;
  };
  const rateFor = (plan: Plan) => band[plan.key] as number | null;
  const monthlyFor = (plan: Plan) => {
    const rate = rateFor(plan);
    return rate === null ? null : rate * storeCount;
  };
  /* The onboarding fee a reader would actually pay, capped. */
  const onboarding = Math.min(ONBOARDING_PER_STORE * storeCount, ONBOARDING_CAP);

  return (
    <section className="section section--tint" id="pricing">
      <div className="wrap">
        <div className="reveal">
          <p className="eyebrow">Pricing</p>
          <h2 className="h2">Simple per-store pricing. No hidden markups.</h2>
          <p className="lede">
            Contractors invoice you directly at their agreed rates — we never mark up
            trades. You pay one clear coordination fee.
          </p>
        </div>

        {/* The calculator: one number in, every price on the section follows. */}
        <div className="pricing__calc reveal">
          <div className="pricing__calc-top">
            <label htmlFor="pricing-store-count">How many stores do you have?</label>
            <p className="pricing__readout">
              <strong>{storeCount}</strong>
              <span>{plural}</span>
            </p>
          </div>
          <input
            id="pricing-store-count"
            className="pricing__slider"
            type="range"
            min={SLIDER_MIN}
            max={SLIDER_MAX}
            value={storeCount}
            onChange={(event) => setStoreCount(Number(event.target.value))}
            aria-describedby="pricing-band-note"
          />
          {/*
            * ONE VISIBLE SENTENCE, AND A HIDDEN TWIN OF THE LONGEST SENTENCE
            * EACH BAND CAN PRODUCE, ALL IN ONE GRID CELL.
            *
            * The buttons below used to move 21px under the thumb that had just
            * pressed them, because a band note is one line for some bands and
            * two or three for others. That was fixed twice with min-height
            * media queries measured against the copy of the day, and this
            * rebuild broke it a third time.
            *
            * So the height is no longer measured. A grid row is as tall as its
            * tallest item, so hidden twins reserve exactly what the longest
            * sentence needs at any width, with nothing to re-measure when a
            * word changes.
            *
            * THE TWINS CARRY EACH BAND'S HIGHEST STORE COUNT, not the current
            * one, because the count changes the wrap as well: at 407px "At 5
            * stores..." takes two lines and "At 51 stores..." takes three, and
            * a set of twins that all say "5" reserves for neither. With
            * `tabular-nums` in the stylesheet every two-digit count is exactly
            * as wide as every other, so a twin at the top of its band covers
            * every count inside it.
            */}
          <p id="pricing-band-note" className="pricing__band-note">
            <span data-active="true">{noteForBand(band, storeCount)}</span>
            {BANDS.map((entry) => (
              <span key={entry.id} aria-hidden="true">
                {noteForBand(entry, Math.min(entry.max, SLIDER_MAX))}
              </span>
            ))}
          </p>
        </div>

        <div
          className="switcher pricing__bands reveal"
          role="group"
          aria-label="Choose your portfolio size"
        >
          {BANDS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={entry.id === bandId ? "is-on" : undefined}
              aria-pressed={entry.id === bandId}
              onClick={() => setBandId(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="pricing__plans reveal">
          {/*
            THE TWO PLANS THE READER IS CHOOSING BETWEEN. One grid, every width
            — the nineteen-row comparison matrix this used to swap to below
            768px existed because THREE stacked cards ran to 2294px on a phone,
            and two do not.
          */}
          <div className="pkgs pkgs--two">
            {MAIN_PLANS.map((plan) => {
              const isComplete = plan.key === "complete";
              const rate = rateFor(plan);
              const monthly = monthlyFor(plan);
              return (
                <article className={`pkg${isComplete ? " is-match" : ""}`} key={plan.key}>
                  {isComplete && saving !== null && (
                    <span className="pkg__flag">Most popular — save £{saving} per store</span>
                  )}
                  <PlanIcon icon={plan.icon} />
                  <h3>{plan.title}</h3>
                  <p className="pkg__for">{plan.for}</p>
                  <Price amount={rate} was={entryBand[plan.key]} />
                  {monthly !== null ? (
                    <p className="pkg__total">
                      ≈ <strong>£{monthly.toLocaleString("en-GB")}</strong>
                      /month for {storeCount} {plural}
                    </p>
                  ) : (
                    <p className="pkg__total pkg__total--talk">
                      Priced against your own portfolio at the review.
                    </p>
                  )}
                  <ul className="pkg__list">
                    {cardPoints(plan).map((point) => (
                      <li key={point}>
                        <Tick />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })}
          </div>

          {/*
            THE SMALLER OPTION, not a third column.

            Compliance Administration is part of Complete and is offered alone
            for an estate that already has its repairs handled. Rendering it as
            an equal card asked the reader to compare three things when the
            decision is between two — so it sits below them, narrower, with the
            same rate mechanics and no "most popular" flag to compete for.
          */}
          <aside className="pkgalt" aria-label="Compliance Administration, available on its own">
            <div className="pkgalt__head">
              <PlanIcon icon={COMPLIANCE_PLAN.icon} />
              <div>
                <h3>{COMPLIANCE_PLAN.title}</h3>
                <p className="pkg__for">{COMPLIANCE_PLAN.for}</p>
              </div>
              <Price amount={rateFor(COMPLIANCE_PLAN)} was={entryBand.compliance} />
            </div>
            <p className="pkgalt__note">
              Included in <strong>Complete</strong>. Available on its own when repairs are
              already handled
              {monthlyFor(COMPLIANCE_PLAN) !== null
                ? ` — ≈ £${monthlyFor(COMPLIANCE_PLAN)!.toLocaleString("en-GB")}/month for ${storeCount} ${plural}.`
                : "."}
            </p>
            <ul className="pkgalt__list">
              {cardPoints(COMPLIANCE_PLAN).map((point) => (
                <li key={point}>
                  <Tick />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </aside>
        </div>

        <div className="pkgfoot reveal">
          <ul className="pricing__notes">
            <li>Portfolio minimum £{PORTFOLIO_MINIMUM}/month.</li>
            <li>
              Onboarding and asset capture £{ONBOARDING_PER_STORE}/store, capped at £
              {ONBOARDING_CAP.toLocaleString("en-GB")}
              {" — "}
              {`£${onboarding.toLocaleString("en-GB")} at ${storeCount} ${plural}`}. Waived on a
              12-month term.
            </li>
            <li>
              Includes 2 coordinated jobs per store per month, pooled across your portfolio
              over a rolling quarter.
            </li>
            <li>
              Projects, kiosk works and out-of-hours P1 incidents (£{OUT_OF_HOURS_P1} each) are
              quoted and charged separately.
            </li>
            <li>Compliance pricing assumes a standard retail asset profile.</li>
            {/* Contractor invoices are the other half of what a reader pays and
                they are not ours, so the note says so where the fees are. */}
            <li>
              Contractor invoices are separate and come from the contractor at their own
              agreed rates. Maintsupp charges the coordination fee and nothing on top.
            </li>
            <li>Final quote confirmed at your free portfolio review.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
