"use client";

import { useState } from "react";

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

const PLANS = [
  {
    key: "coordination" as const,
    title: "Maintenance Coordination",
    for: "Reactive repairs, run end to end.",
    icon: (
      <path d="M14.7 6.3a4 4 0 1 0 5 5L21 21H3l9.7-9.7a4 4 0 0 1 2-4.9Z" />
    ),
    points: [
      "Intake & triage",
      "Contractor assignment",
      "Quote control",
      "Attendance chasing",
      "Photo-verified close-out",
      "Monthly report",
    ],
  },
  {
    key: "compliance" as const,
    title: "Compliance Administration",
    for: "Certificates tracked before they expire.",
    icon: (
      <>
        <path d="M12 21s8-3.5 8-9V5l-8-3-8 3v7c0 5.5 8 9 8 9Z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    points: [
      "Certificate register",
      "90/60/30-day reminders",
      "Provider booking",
      "Certificate chasing",
      "Remedial tracking",
      "Traffic-light compliance dashboard",
    ],
    footnote: "One-off setup from £25/store + VAT.",
  },
  {
    key: "total" as const,
    title: "Total Care",
    for: "Both, plus a quarterly portfolio review.",
    icon: (
      <>
        <path d="m12 2 9 5v10l-9 5-9-5V7Z" />
        <path d="m3 7 9 5 9-5M12 12v10" />
      </>
    ),
    points: [
      "Everything in Maintenance Coordination",
      "Everything in Compliance Administration",
      "Quarterly portfolio review",
    ],
  },
];

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
          <p id="pricing-band-note" className="pricing__band-note">
            {band.id === "small"
              ? `At ${storeCount} ${storeCount === 1 ? "store" : "stores"} you are on the ${band.label} rate.`
              : `You have unlocked the ${band.label} rate — save £${
                  entryBand.total - band.total
                } per store on Total Care.`}
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

        <div className="pkgs reveal">
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
                  {plan.points.map((point) => (
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
