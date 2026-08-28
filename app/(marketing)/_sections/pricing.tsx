"use client";

import { useState, type ReactNode } from "react";

/**
 * SECTION 7 — Pricing.
 *
 * New. It replaces `Packages` ("Four tiers. Each one includes everything below
 * it.") and the `Calculator` that followed it — a slider estimating what an
 * in-house team costs, which is a persuasion device, not a price.
 *
 * WHAT THE PAGE NOW SAYS: three products, three portfolio bands, and the actual
 * numbers — including on 26+, which used to be a "Custom" card and a button.
 *
 * THE READER GIVES ONE NUMBER. A slider for how many stores they have; the band
 * follows, the per-store rate follows, and each card shows what that actually
 * costs them per month. Asking someone to pick a band first asks them to work
 * out which band 14 stores is in, which is the calculator's job.
 *
 * THE SAVING IS COMPUTED, NOT TYPED. "Most popular — save £N per store" is
 * Coordination + Compliance − Total Care at whatever band is showing: £20 at
 * 1–10 (65 + 55 − 100), £18 at 11–25 (58 + 48 − 88), £16 at 26+ (52 + 42 − 78).
 * Deriving it means the badge cannot come to contradict the cards above it
 * after a price change. The struck-through "was" price is derived the same way,
 * from the entry band, and only renders once the reader is past it.
 *
 * Every price carries "+ VAT", which is a rule of the brief and not a detail.
 *
 * TWO PRESENTATIONS, ONE SET OF FACTS. Wide enough for three columns, the
 * section is three cards. On a phone the three cards stacked ran to 2294px —
 * more than the whole desktop section — and a reader comparing them had to
 * hold one card's feature list in their head while scrolling to the next. So
 * below 768px the same data renders as a comparison matrix: features down the
 * left, the three plans across. Both presentations read `BANDS`, `PLANS` and
 * `FEATURES` below; neither of them contains a typed price or a typed feature
 * list of its own, because a second copy would be a second thing to keep true.
 */

/*
 * The three bands, at the rates the approved pricing reference carries.
 *
 * The top band used to hold no numbers — "the answer is a conversation" — and
 * the middle band was £60/£50/£90. Both are superseded: 26+ is a published
 * rate now, and the middle band came down to £58/£48/£88, so a reader can size
 * their own portfolio without booking a call to find out whether they can
 * afford one.
 */
const BANDS = [
  { id: "small", label: "1–10 stores", max: 10, coordination: 65, compliance: 55, total: 100 },
  { id: "mid", label: "11–25 stores", max: 25, coordination: 58, compliance: 48, total: 88 },
  { id: "large", label: "26+ stores", max: Infinity, coordination: 52, compliance: 42, total: 78 },
] as const;

/** The band a portfolio of `count` stores falls in. */
function bandForCount(count: number) {
  return BANDS.find((entry) => count <= entry.max) ?? BANDS[BANDS.length - 1];
}

const SLIDER_MIN = 1;
const SLIDER_MAX = 40;

type Band = (typeof BANDS)[number];
type PlanKey = "coordination" | "compliance" | "total";

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
 * The price line. `was` is the same plan's entry-band rate, shown struck
 * through only once the reader has actually moved past that band — a
 * "was £65" beside £65 is noise, and beside £52 it is the discount.
 */
function Price({ amount, was }: { amount: number; was: number }) {
  return (
    <div className="pkg__price">
      <span className="pkg__num">£{amount}</span>
      {was > amount && (
        <s className="pkg__was" aria-label={`Down from £${was} per store`}>
          £{was}
        </s>
      )}
      <span className="pkg__per">
        per store / month
        <br />+ VAT
      </span>
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
  footnote?: string;
};

const PLANS: readonly Plan[] = [
  {
    key: "coordination",
    title: "Maintenance Coordination",
    for: "Reactive repairs, run end to end.",
    icon: (
      <path d="M14.7 6.3a4 4 0 1 0 5 5L21 21H3l9.7-9.7a4 4 0 0 1 2-4.9Z" />
    ),
  },
  {
    key: "compliance",
    title: "Compliance Administration",
    for: "Certificates tracked before they expire.",
    icon: (
      <>
        <path d="M12 21s8-3.5 8-9V5l-8-3-8 3v7c0 5.5 8 9 8 9Z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    footnote: "One-off setup from £25/store + VAT.",
  },
  {
    key: "total",
    title: "Total Care",
    for: "Both, plus a quarterly portfolio review.",
    icon: (
      <>
        <path d="m12 2 9 5v10l-9 5-9-5V7Z" />
        <path d="m3 7 9 5 9-5M12 12v10" />
      </>
    ),
    rollup: ["coordination", "compliance"],
  },
];

/*
 * EVERY FEATURE, ONCE, AGAINST THE PLAN THAT INTRODUCES IT.
 *
 * The cards used to carry three hardcoded bullet lists and Total Care's read
 * "Everything in Maintenance Coordination / Everything in Compliance
 * Administration / Quarterly portfolio review" — which is the right thing for
 * a card and useless in a matrix, where the reader wants to see the tick land
 * on the row. Holding the features here and the roll-up on the plan lets the
 * card keep its summary wording and the matrix enumerate what the summary
 * stands for, without either one being typed twice.
 */
const FEATURES: readonly { label: string; plan: PlanKey }[] = [
  { label: "Intake & triage", plan: "coordination" },
  { label: "Contractor assignment", plan: "coordination" },
  { label: "Quote control", plan: "coordination" },
  { label: "Attendance chasing", plan: "coordination" },
  { label: "Photo-verified close-out", plan: "coordination" },
  { label: "Monthly report", plan: "coordination" },
  { label: "Certificate register", plan: "compliance" },
  { label: "90/60/30-day reminders", plan: "compliance" },
  { label: "Provider booking", plan: "compliance" },
  { label: "Certificate chasing", plan: "compliance" },
  { label: "Remedial tracking", plan: "compliance" },
  { label: "Traffic-light compliance dashboard", plan: "compliance" },
  { label: "Quarterly portfolio review", plan: "total" },
];

/** Whether `plan` includes `feature`, directly or through its roll-up. */
function planHas(plan: Plan, feature: (typeof FEATURES)[number]) {
  return feature.plan === plan.key || (plan.rollup?.includes(feature.plan) ?? false);
}

/**
 * The card's bullet list: a plan's own features, preceded by one line per
 * rolled-up plan. Total Care therefore still reads "Everything in Maintenance
 * Coordination / Everything in Compliance Administration / Quarterly portfolio
 * review" — derived, so the summary cannot come to describe a set the matrix
 * beside it no longer ticks.
 */
function cardPoints(plan: Plan) {
  const own = FEATURES.filter((feature) => feature.plan === plan.key).map((f) => f.label);
  if (!plan.rollup) return own;
  const titleOf = (key: PlanKey) => PLANS.find((entry) => entry.key === key)?.title ?? key;
  return [...plan.rollup.map((key) => `Everything in ${titleOf(key)}`), ...own];
}

/** A matrix cell that is not included. Never colour alone — a glyph and a name. */
function NotIncluded({ label = "Not included" }: { label?: string }) {
  return (
    <>
      <span className="pmx__no" aria-hidden="true">
        —
      </span>
      <span className="vh">{label}</span>
    </>
  );
}

export function Pricing() {
  /*
   * The store count is the single input, and the band follows from it.
   *
   * Previously the three bands were buttons and the reader picked one, which
   * asks them to know which band 14 stores lands in. The approved reference
   * turns it round: a slider for the number they actually have, and the band
   * lights up on its own. The buttons stay as a keyboard-friendly way to jump
   * between bands, and setting one moves the slider to that band's low end so
   * the two controls can never disagree.
   */
  const [storeCount, setStoreCount] = useState(8);
  const band = bandForCount(storeCount);
  const bandId = band.id;
  const setBandId = (id: Band["id"]) => {
    const target = BANDS.find((entry) => entry.id === id) ?? BANDS[0];
    const index = BANDS.indexOf(target);
    const low = index === 0 ? SLIDER_MIN : (BANDS[index - 1]!.max as number) + 1;
    setStoreCount(low);
  };

  /* Both parts bought separately, against Total Care — computed, never typed. */
  const saving = band.coordination + band.compliance - band.total;
  /* What the same plan costs at the entry band, so a discount can be shown as
     a discount rather than asserted. */
  const entryBand = BANDS[0];

  const stores = `${storeCount} ${storeCount === 1 ? "store" : "stores"}`;
  const monthly = (plan: Plan) => (band[plan.key] * storeCount).toLocaleString("en-GB");

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
              <span>{storeCount === 1 ? "store" : "stores"}</span>
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
            The same sentence shape for every band. The two bigger bands used to
            say "save £12 per store on Total Care" while the Total Care card
            beside them said "save £18 per store" — both true (one is the drop
            from the entry rate, the other the bundle saving) and, read
            together, a contradiction. The figure here now says what it is.
          */}
          <p id="pricing-band-note" className="pricing__band-note">
            {`At ${storeCount} ${storeCount === 1 ? "store" : "stores"} you are on the ${band.label} rate`}
            {band.id === "small"
              ? "."
              : ` — £${entryBand.total - band.total} per store below the ${entryBand.label} rate on Total Care.`}
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

        {/*
          One reveal wrapper around both presentations. The observer that adds
          `is-in` never fires on a `display:none` element, so giving each of
          them the class of its own would leave whichever one is showing after
          a resize stuck at opacity 0.
        */}
        <div className="pricing__plans reveal">
          {/* Wide: three cards. */}
          <div className="pkgs">
            {PLANS.map((plan) => {
              const amount = band[plan.key];
              const isTotal = plan.key === "total";
              return (
                <article
                  className={`pkg${isTotal ? " is-match" : ""}`}
                  key={plan.key}
                >
                  {isTotal && (
                    <span className="pkg__flag">Most popular — save £{saving} per store</span>
                  )}
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
                      {plan.icon}
                    </svg>
                  </span>
                  <h3>{plan.title}</h3>
                  <p className="pkg__for">{plan.for}</p>
                  <Price amount={amount} was={entryBand[plan.key]} />
                  {/* What it actually costs this reader, which is the number
                      they came for. Computed from the same rate above. */}
                  <p className="pkg__total">
                    ≈ <strong>£{(amount * storeCount).toLocaleString("en-GB")}</strong>
                    /month for {storeCount} {storeCount === 1 ? "store" : "stores"}
                  </p>
                  <ul className="pkg__list">
                    {cardPoints(plan).map((point) => (
                      <li key={point}>
                        <Tick />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                  {plan.footnote && <p className="pkg__setup">{plan.footnote}</p>}
                </article>
              );
            })}
          </div>

          {/*
            Narrow: the same three plans as a comparison matrix.

            It is a real <table> because it is real tabular data — a row header
            and three column headers give a screen reader the two coordinates
            of every tick, which a grid of divs cannot. The feature column is
            sticky, so on the two narrowest phones, where the three plan
            columns cannot all fit, the row a reader is scrolling stays named.
          */}
          <div className="pmx">
            <div
              className="pmx__scroll"
              tabIndex={0}
              role="region"
              aria-label="Plan comparison table"
            >
              <table className="pmx__table">
                <caption className="vh">
                  {`The three plans compared at ${stores}, on the ${band.label} rate.`}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="pmx__corner">
                      <span className="vh">Feature</span>
                    </th>
                    {PLANS.map((plan) => (
                      <th
                        scope="col"
                        key={plan.key}
                        className={`pmx__plan${plan.key === "total" ? " is-match" : ""}`}
                      >
                        <span className="pmx__planname">{plan.title}</span>
                        {plan.key === "total" && (
                          <span className="pmx__pop">Most popular</span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="pmx__row--says">
                    <th scope="row">What it is for</th>
                    {PLANS.map((plan) => (
                      <td key={plan.key} className={plan.key === "total" ? "is-match" : undefined}>
                        {plan.for}
                      </td>
                    ))}
                  </tr>
                  <tr className="pmx__row--price">
                    <th scope="row">Per store / month</th>
                    {PLANS.map((plan) => {
                      const amount = band[plan.key];
                      const was = entryBand[plan.key];
                      return (
                        <td key={plan.key} className={plan.key === "total" ? "is-match" : undefined}>
                          <span className="pmx__price">£{amount}</span>
                          {was > amount && (
                            <s className="pkg__was" aria-label={`Down from £${was} per store`}>
                              £{was}
                            </s>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                  <tr>
                    <th scope="row">VAT</th>
                    {PLANS.map((plan) => (
                      <td key={plan.key} className={plan.key === "total" ? "is-match" : undefined}>
                        + VAT on top
                      </td>
                    ))}
                  </tr>
                  {/*
                    The row header carries "per month" and the store count, so
                    the cell is the figure alone — "≈ £520/month" broke as
                    "£520/mon th" in an 80px column, and the sentence the card
                    prints ("≈ £520/month for 8 stores") is here in full,
                    split across the header and the cell rather than crushed
                    into one of them.
                  */}
                  <tr className="pmx__row--total">
                    <th scope="row">
                      Your total per month
                      <span className="pmx__sub">at {stores}</span>
                    </th>
                    {PLANS.map((plan) => (
                      <td key={plan.key} className={plan.key === "total" ? "is-match" : undefined}>
                        ≈ <strong>£{monthly(plan)}</strong>
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row">Bundle saving</th>
                    {PLANS.map((plan) => (
                      <td key={plan.key} className={plan.key === "total" ? "is-match" : undefined}>
                        {plan.rollup ? (
                          <strong>Save £{saving} per store</strong>
                        ) : (
                          <NotIncluded label="No bundle saving" />
                        )}
                      </td>
                    ))}
                  </tr>
                  <tr className="pmx__row--says">
                    <th scope="row">One-off setup</th>
                    {PLANS.map((plan) => (
                      <td key={plan.key} className={plan.key === "total" ? "is-match" : undefined}>
                        {plan.footnote ?? <NotIncluded label="None listed" />}
                      </td>
                    ))}
                  </tr>
                  {FEATURES.map((feature) => (
                    <tr key={feature.label}>
                      <th scope="row">{feature.label}</th>
                      {PLANS.map((plan) => (
                        <td
                          key={plan.key}
                          className={`pmx__mark${plan.key === "total" ? " is-match" : ""}`}
                        >
                          {planHas(plan, feature) ? (
                            <>
                              <span className="pmx__yes">
                                <Tick />
                              </span>
                              <span className="vh">Included</span>
                            </>
                          ) : (
                            <NotIncluded />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/*
              The card's own summary of Total Care, in the card's own words and
              built from the same table the matrix ticks. The matrix enumerates
              what "everything in" stands for, which is the more useful thing
              to show; this keeps the sentence a reader on a phone would
              otherwise only meet on a wider screen.
            */}
            {PLANS.filter((plan) => plan.rollup).map((plan) => (
              <p className="pmx__foot" key={plan.key}>
                <strong>{plan.title}:</strong> {cardPoints(plan).join(" · ")}. Most popular —
                save £{saving} per store.
              </p>
            ))}
          </div>
        </div>

        <div className="pkgfoot reveal">
          <ul className="pricing__notes">
            <li>Portfolio minimum £295/month + VAT.</li>
            <li>
              Includes up to 2 coordinated jobs per store per month, pooled across your
              portfolio. Additional jobs from £65 each + VAT; complex or multi-trade work
              quoted separately.
            </li>
            <li>
              Projects, kiosk works and out-of-hours P1 escalation (£125 per incident + VAT)
              are quoted and charged separately.
            </li>
            <li>Compliance pricing assumes a standard retail asset profile.</li>
            <li>Final quote confirmed at your free portfolio review.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
