"use client";

import { useState, type ReactNode } from "react";
import {
  ADDITIONAL_JOB,
  BANDS,
  ENTRY_BAND,
  INCLUDED_JOBS,
  ONBOARDING_CAP,
  ONBOARDING_PER_STORE,
  OUT_OF_HOURS_P1,
  PORTFOLIO_MINIMUM,
  PROJECT_MINIMUM,
  PROJECT_PERCENT,
  SLIDER_MAX,
  SLIDER_MIN,
  bandForCount,
  type Band,
} from "./rates";

/**
 * SECTION 7 — Pricing.
 *
 * WHAT THE PAGE SAYS: two plans a reader chooses between, four portfolio bands,
 * and the actual numbers — except above fifty stores, where the honest answer is
 * a conversation and the card says so rather than inventing a rate.
 *
 * THE READER GIVES ONE NUMBER. A slider for how many stores they have; the band
 * follows, the per-store rate follows, and each card shows what that costs them
 * per month. Asking someone to pick a band first asks them to work out which
 * band fourteen stores is in, which is the calculator's job.
 *
 * ── WHAT CHANGED IN THIS REVISION, AND WHY EACH ONE MATTERS ───────────────
 *
 * THE RATES MOVED OUT, to `./rates.ts`. The cost FAQ now quotes the entry rates
 * too, and the brief requires every figure to agree across the cards, the rate
 * card, the totals, the footnotes and that answer. One module knows the numbers
 * and three places render them; see the header there for the rule this keeps
 * rather than breaks.
 *
 * TWO CARDS, AND NO THIRD. Essential and Complete are the decision. Compliance
 * administration is still sold on its own and is still priced — it is a LINE OF
 * SMALL PRINT under the cards and a row in the rate card, not a card. It was a
 * card, and an equal-looking third option asked the reader to compare three
 * things when only two of them are the choice.
 *
 * THE PORTFOLIO TOTAL IS THE BIG NUMBER NOW. The per-store rate is the unit;
 * the total is what the client actually pays, and it was the smaller of the two.
 *
 * THE BAND NOTE IS ONE SENTENCE. It used to run on — "At 5 stores you are on the
 * 5-10 stores rate — £7 per store below the 5-10 stores rate on Complete" — which
 * says the same thing twice at the entry band and does arithmetic the cards
 * already show.
 *
 * THE FULL RATE CARD IS BEHIND A DISCLOSURE, using the page's existing
 * `<details>`/`<summary>` pattern — the same one the FAQ uses — because a
 * twelve-cell table above the fold competes with the two cards that are the
 * actual decision. It scrolls horizontally rather than overflowing; see
 * `.ratecard__scroll` in marketing.css.
 *
 * NO PRICE CARRIES "+ VAT", AND THAT IS STILL THE RULE. What the footnotes now
 * say instead is the positive form — the price shown is the price payable, and
 * Maintauk Ltd is not VAT registered — which is a statement of fact about the
 * company rather than a qualifier on a number.
 *
 * THE SAVING IS COMPUTED, NOT TYPED. Essential + Compliance − Complete at
 * whatever band is showing: £15 at every band that has numbers (60+55−100,
 * 56+51−92, 52+47−84). Deriving it means the badge cannot come to contradict
 * the cards above it after a price change.
 */

type PlanKey = "essential" | "complete";

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

const REVIEW = "Book a Portfolio Review";

/** Pounds, with a thousands separator and no decimals. */
function money(amount: number) {
  return amount.toLocaleString("en-GB");
}

/**
 * The price line.
 *
 * `amount` is `null` in the top band, where the card offers a conversation
 * instead of a number. `was` is the same plan's entry-band rate, struck through
 * only once the reader has moved past that band — a "was £60" beside £60 is
 * noise, and beside £52 it is the discount.
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
 * The two plans the reader is choosing between, and there are only two.
 *
 * Compliance administration is deliberately NOT a plan object any more. It is a
 * rate (`BANDS[].compliance`) rendered as one line of small print beneath the
 * cards and as one row of the rate card. Keeping it out of this list is what
 * stops a later edit quietly restoring it to a third equal column.
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
    rollup: ["essential"],
  },
];

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
  { label: "Certificate register", plan: "complete" },
  { label: "90/60/30-day reminders", plan: "complete" },
  { label: "Provider booking and certificate chasing", plan: "complete" },
  { label: "Remedial tracking", plan: "complete" },
  { label: "Traffic-light compliance dashboard", plan: "complete" },
  { label: "Quarterly portfolio review", plan: "complete" },
];

/**
 * The card's bullet list: a plan's own features, preceded by one line per
 * rolled-up plan. Complete therefore reads "Everything in Essential" and then
 * the compliance and review lines — derived, so it cannot drift from what the
 * other card claims.
 */
function cardPoints(plan: Plan) {
  const own = FEATURES.filter((feature) => feature.plan === plan.key).map((f) => f.label);
  if (!plan.rollup) return own;
  const titleOf = (key: PlanKey) => MAIN_PLANS.find((entry) => entry.key === key)?.title ?? key;
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

/** A rate as it appears in the rate-card table: a figure, or "Bespoke". */
function rateCell(value: number | null) {
  return value === null ? "Bespoke" : `£${value}`;
}

export function Pricing() {
  /*
   * The store count is the single input, and the band follows from it. The
   * band buttons stay as a keyboard-friendly way to jump between bands, and
   * setting one moves the slider to that band's low end so the two controls
   * can never disagree.
   *
   * IT OPENS AT FIVE, which is the floor rather than a default — Maintsupp
   * coordinates portfolios of five sites and above, so the calculator must not
   * be able to describe a portfolio the business will not take.
   */
  const [storeCount, setStoreCount] = useState(SLIDER_MIN);
  const band = bandForCount(storeCount);
  const bandId = band.id;
  const setBandId = (id: Band["id"]) => {
    const target = BANDS.find((entry) => entry.id === id) ?? BANDS[0];
    setStoreCount(target.min);
  };

  const entryBand = ENTRY_BAND;
  /* Both parts bought separately, against Complete — computed, never typed,
     and absent in the band that carries no rates. */
  const saving =
    band.essential !== null && band.compliance !== null && band.complete !== null
      ? band.essential + band.compliance - band.complete
      : null;

  const plural = storeCount === 1 ? "store" : "stores";

  /* The sentence under the slider, for ANY band at ANY count rather than only
     the current pair — hidden twins of it are what reserve the row's height. */
  const noteForBand = (entry: Band, count: number) =>
    `At ${count} ${count === 1 ? "store" : "stores"} you are on the ${entry.label} rate.`;

  const rateFor = (plan: Plan) => band[plan.key] as number | null;
  const monthlyFor = (plan: Plan) => {
    const rate = rateFor(plan);
    return rate === null ? null : rate * storeCount;
  };

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
            * media queries measured against the copy of the day, and a rebuild
            * broke it a third time.
            *
            * So the height is no longer measured. A grid row is as tall as its
            * tallest item, so hidden twins reserve exactly what the longest
            * sentence needs at any width, with nothing to re-measure when a
            * word changes. The sentence is one line now rather than three, and
            * the twins stay: the mechanism costs nothing and the next copy
            * change does not have to remember to reinstate it.
            *
            * THE TWINS CARRY EACH BAND'S HIGHEST STORE COUNT, not the current
            * one, because the count changes the wrap as well. With
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

          {/*
            THE FULL RATE CARD, behind the page's existing disclosure pattern.

            `<details>`/`<summary>` is what the FAQ uses, so this introduces no
            new component and no JavaScript — and it collapses by default
            because the two cards below are the decision, not the twelve-cell
            table. The table scrolls inside its own container rather than
            widening the page; §10 of the brief asks for exactly that, and the
            stylesheet does it with one `overflow-x`.
          */}
          <details className="ratecard">
            <summary className="ratecard__toggle">See the full rate card</summary>
            <div className="ratecard__scroll">
              <table className="ratecard__table">
                <caption className="vh">
                  Coordination rates per store per month, by portfolio size
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Per store / month</th>
                    {BANDS.map((entry) => (
                      <th scope="col" key={entry.id}>
                        {entry.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {MAIN_PLANS.map((plan) => (
                    <tr key={plan.key}>
                      <th scope="row">{plan.title}</th>
                      {BANDS.map((entry) => (
                        <td key={entry.id}>{rateCell(entry[plan.key])}</td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <th scope="row">Compliance only</th>
                    {BANDS.map((entry) => (
                      <td key={entry.id}>{rateCell(entry.compliance)}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="ratecard__note">
              Compliance administration on its own:{" "}
              {BANDS.map((entry) => rateCell(entry.compliance)).join(" · ")}.
            </p>
          </details>
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
                      ≈ <strong>£{money(monthly)}</strong>
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
            COMPLIANCE ADMINISTRATION, AS SMALL PRINT RATHER THAN A CARD.

            It is part of Complete and is offered alone for an estate that
            already has its repairs handled. As an equal card it asked the
            reader to compare three things when the decision is between two, so
            what remains is the one sentence that tells somebody in that
            position the option exists, and the rate card behind the disclosure
            above, which prices it at every band.
          */}
          <p className="pkgfine">
            Compliance administration is also available on its own, where repairs are
            already handled — from £{entryBand.compliance} per store / month, portfolios
            of five sites and above.
          </p>
        </div>

        <div className="pkgfoot reveal">
          <ul className="pricing__notes">
            <li>
              Maintsupp coordinates portfolios of five sites and above. Portfolio minimum
              £{PORTFOLIO_MINIMUM} per month.
            </li>
            <li>
              Includes {INCLUDED_JOBS} coordinated jobs per store per month, pooled across
              your portfolio over a rolling quarter. Additional coordinated jobs £
              {ADDITIONAL_JOB} each.
            </li>
            <li>
              If a portfolio exceeds its allowance for two consecutive quarters, we move it
              to a lower per-store band rather than keep charging per job.
            </li>
            <li>
              Onboarding and asset capture £{ONBOARDING_PER_STORE} per store, capped at £
              {money(ONBOARDING_CAP)} — covering site register, access rules, asset capture
              and certificate baseline.
            </li>
            <li>Out-of-hours and P1 escalation £{OUT_OF_HOURS_P1} per incident.</li>
            <li>
              Projects and kiosk works are scoped and quoted separately — a fixed fee, or{" "}
              {PROJECT_PERCENT}% of third-party project spend, minimum £{PROJECT_MINIMUM}.
            </li>
            <li>
              Sites added mid-term are charged pro-rata at your current band, plus £
              {ONBOARDING_PER_STORE} onboarding.
            </li>
            <li>Service hours Mon–Fri, 8:30am–5:30pm.</li>
            <li>Three-month initial term, then 30 days&rsquo; notice.</li>
            {/* Contractor invoices are the other half of what a reader pays and
                they are not ours, so the note says so where the fees are. */}
            <li>
              Contractor invoices are separate and come from the contractor at their own
              agreed rates. Maintsupp charges the coordination fee and nothing on top.
            </li>
            {/*
              THE POSITIVE FORM, deliberately. "+ VAT" and every synonym for it
              are withdrawn from this site; what replaces them is not silence
              but the statement that the number shown is the number payable.
            */}
            <li>
              Prices shown are the total payable. MAINTSUPP LTD is not currently VAT
              registered.
            </li>
            <li>Final quote confirmed at your free portfolio review.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
