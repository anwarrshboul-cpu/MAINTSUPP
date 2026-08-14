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
 * numbers. The band is a toggle rather than three columns of nine figures,
 * because a reader knows how many stores they have and only one row is theirs.
 *
 * THE SAVING IS COMPUTED, NOT TYPED. "Most popular — save £20 per store" is
 * true at 1–10 (£65 + £55 = £120 against £100) and at 11–25 (£60 + £50 = £110
 * against £90). Deriving it means the badge cannot come to contradict the cards
 * above it after a price change, and it is why the badge does not appear on the
 * 26+ band at all: there is no number there to subtract.
 *
 * Every price carries "+ VAT", which is a rule of the brief and not a detail.
 */

const BANDS = [
  { id: "small", label: "1–10 stores", coordination: 65, compliance: 55, total: 100 },
  { id: "mid", label: "11–25 stores", coordination: 60, compliance: 50, total: 90 },
  /* No numbers on the top band — the answer is a conversation, so the card
     carries the button instead of a figure. */
  { id: "large", label: "26+ stores", coordination: null, compliance: null, total: null },
] as const;

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

/** The price line, or the button that stands in for one. */
function Price({ amount }: { amount: number | null }) {
  if (amount === null) {
    return (
      <div className="pkg__price pkg__price--custom">
        <span className="pkg__num">Custom</span>
        <span className="pkg__per">priced at your portfolio review</span>
      </div>
    );
  }
  return (
    <div className="pkg__price">
      <span className="pkg__num">£{amount}</span>
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
  const [bandId, setBandId] = useState<Band["id"]>("small");
  const band = BANDS.find((entry) => entry.id === bandId) ?? BANDS[0];

  /* Only claimable where both parts have a price. */
  const saving =
    band.coordination !== null && band.compliance !== null && band.total !== null
      ? band.coordination + band.compliance - band.total
      : null;

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
                className={`pkg${isTotal && saving !== null ? " is-match" : ""}`}
                key={plan.key}
              >
                {isTotal && saving !== null && (
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
                <Price amount={amount} />
                <ul className="pkg__list">
                  {plan.points.map((point) => (
                    <li key={point}>
                      <Tick />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
                {plan.footnote && <p className="pkg__setup">{plan.footnote}</p>}
                {amount === null && (
                  <a className="btn btn--primary btn--block pkg__cta" href="#review">
                    Book a Portfolio Review
                  </a>
                )}
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
