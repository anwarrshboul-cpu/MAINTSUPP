"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { HOME_COPY, type HomeCopy } from "./copy";
import { TERMS } from "./rates";

/**
 * SECTION 7 — Pricing.
 *
 * WHAT THE PAGE SAYS NOW: you pay per job, and you have the price before any
 * work starts. Three cards say the three things a first-time buyer needs to
 * know before they send a job — how it is priced, what a call-out costs, and
 * what comes with it — and one line beneath them says a managed monthly plan
 * exists for portfolios, on request.
 *
 * ── WHAT WAS HERE, AND WHY IT WENT ────────────────────────────────────────
 *
 * Until 2026-11-25 this section was a calculator: a store-count slider, four
 * portfolio bands, two plan cards (Essential and Complete) with per-store
 * monthly rates, a full rate card behind a disclosure, and thirteen footnotes —
 * portfolio minimum, included jobs, onboarding fee, out-of-hours fee, project
 * percentage, initial term. All of it described ONE product: a monthly
 * coordination subscription for portfolios of five sites and above.
 *
 * The owner withdrew it (decided 2026-11-19, released 2026-11-25). Nobody was
 * buying the subscription, the outreach that sends people here promises "no
 * subscription", and the reader this page is now written for runs one shop or
 * one kiosk and wants one thing fixed. A slider that opens at five stores told
 * that reader the page was not for them. `./rates.ts` records the decision and
 * what would have to be true to publish a rate again.
 *
 * ── THE RULES THAT SURVIVE ────────────────────────────────────────────────
 *
 * NO FIGURE IS TYPED HERE — and now none is derived here either. This file was
 * the one place in the marketing tree allowed a pound sign followed by a digit;
 * `tests/homepage-v3.test.mjs` no longer makes that exception, because there is
 * no price left to print. Do not add one to a card to "make it concrete": a
 * typed rate is the thing that goes stale, and the owner quotes each job.
 *
 * THE TERMS ARE QUOTED, NOT RESTATED. The call-out line is a promise about
 * money. It is written once, in `rates.ts` (`TERMS`), and this section, the
 * cost FAQ, `/pricing` and the London pages all read it from there, so the
 * promise cannot come to be worded two ways.
 *
 * THE CALL-OUT IS FREE WITH THE REPAIR, NOT FREE. The owner chose that form
 * deliberately (2026-11-25): a contractor who attends and repairs nothing
 * still has to be paid, so an unconditional "no call-out fee" would be a cost
 * the business absorbs every time a visit finds nothing to fix. The second
 * half — a visit with no repair to follow is priced first — is on the same
 * card for that reason and must stay beside the first.
 *
 * THREE CARDS, EQUAL. The old section had two cards and a highlighted one
 * because it was a choice between plans. These are not a choice: every job
 * gets all three, so none of them carries the `is-match` highlight or a flag.
 *
 * NO PRICE CARRIES "+ VAT", AND THAT IS STILL THE RULE. The footnote keeps the
 * positive form — the price quoted is the price payable, and MAINTSUPP LTD is
 * not VAT registered — which is a statement of fact about the company rather
 * than a qualifier on a number.
 *
 * NO NEW CSS. The cards reuse `.pkgs` / `.pkg` and the notes reuse
 * `.pricing__notes` from marketing.css, so the section keeps the page's
 * rhythm and adds no breakpoint. The calculator and rate-card rules are left
 * in the stylesheet, unused, rather than deleted in the same change.
 */

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

function CardIcon({ icon }: { icon: ReactNode }) {
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

type Card = {
  key: string;
  title: string;
  for: string;
  icon: ReactNode;
  points: readonly string[];
};

/**
 * What a first-time buyer is told, in the order they ask it: what will it
 * cost, what does a visit cost, and what do I get.
 *
 * The first two points of the call-out card are sentences from `TERMS`, so
 * the card and the FAQ answer are the same words. They are whole sentences
 * with their full stops, which is why the third point on that card has one
 * too and the fragments on the other two cards do not.
 */
const CARDS: readonly Card[] = [
  {
    key: "per-job",
    title: "Priced per job",
    for: "One price for the job, confirmed before work starts.",
    /* A price tag: the card is about what the job will cost. */
    icon: (
      <>
        <path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4Z" />
        <path d="M7.5 7.5h.01" />
      </>
    ),
    points: [
      "You approve the price before anything is booked",
      "No subscription and no minimum term",
      "No minimum number of sites: one kiosk, one job",
    ],
  },
  {
    key: "call-out",
    title: "No call-out charge with the repair",
    for: "When we carry out the repair, you pay for the repair.",
    icon: (
      <>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    points: [
      TERMS.callOut,
      TERMS.noRepairVisit,
      "Emergencies in London: the price and the attendance time before you commit.",
    ],
  },
  {
    key: "portal",
    title: "Portal included",
    for: "Every customer gets the MAINTSUPP portal at no extra cost.",
    icon: (
      <>
        <rect x="3" y="4" width="18" height="14" rx="2" />
        <path d="M3 9h18M8 22h8M12 18v4" />
      </>
    ),
    points: [
      "Live status for every job",
      "Before and after photographs",
      "Reports and documents in one place",
    ],
  },
];

export function Pricing({ copy = HOME_COPY.pricing }: { copy?: HomeCopy["pricing"] }) {
  return (
    <section className="section section--tint" id="pricing">
      <div className="wrap">
        <div className="reveal">
          <p className="eyebrow">{copy.eyebrow}</p>
          <h2 className="h2">{copy.heading}</h2>
          <p className="lede">{copy.lede}</p>
        </div>

        <div className="pricing__plans reveal">
          {/*
            THREE THINGS EVERY JOB GETS, not three options to choose between —
            which is why none is highlighted. `.pkgs` is an auto-fit grid, so
            they sit three across on a desktop and stack on a phone with no
            breakpoint of their own.

            `alignItems: "stretch"` is the one override. The grid aligns its
            cards to the top, which suited plan cards of deliberately different
            weight; three equal statements with a ragged bottom edge read as
            three sizes of thing. It is set here rather than in marketing.css
            because it belongs to this arrangement of cards and to nothing else
            that uses the class.
          */}
          <div className="pkgs" style={{ alignItems: "stretch" }}>
            {CARDS.map((card) => (
              <article className="pkg" key={card.key}>
                <CardIcon icon={card.icon} />
                <h3>{card.title}</h3>
                <p className="pkg__for">{card.for}</p>
                <ul className="pkg__list">
                  {card.points.map((point) => (
                    <li key={point}>
                      <Tick />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          {/*
            THE MANAGED PLAN, AS ONE LINE RATHER THAN A CARD.

            It still exists and a portfolio can still have it, but it is no
            longer what the page sells, so it is told to the reader it applies
            to and priced in a conversation. The sentence is `TERMS.managedPlan`
            — the same one the FAQ and the landing pages quote.
          */}
          <p className="pkgfine">
            {TERMS.managedPlan} It adds one named coordinator, planned maintenance and
            compliance dates across every site. <Link href="/contact">Ask us about a managed plan</Link>.
          </p>
        </div>

        <div className="pkgfoot reveal">
          <ul className="pricing__notes">
            {/*
              NOT REPEATED HERE: the call-out terms. They are the second card,
              word for word, an inch above this list — a note saying the same
              two sentences again was the page talking to itself.
            */}
            <li>{TERMS.perJob} Nothing is booked until you approve it.</li>
            <li>
              Kiosk installs and removals, strip-outs, fit-outs and other projects are
              scoped and quoted separately.
            </li>
            <li>
              To get a price, <Link href="/#report">report the job</Link> with a photograph, or
              call us. We confirm the price and the time with you.
            </li>
            <li>Office hours Mon–Fri, 8:30am–5:30pm. Emergencies in London, 24 hours.</li>
            {/*
              THE POSITIVE FORM, deliberately. "+ VAT" and every synonym for it
              are withdrawn from this site; what replaces them is not silence
              but the statement that the price quoted is the price payable.
            */}
            <li>
              Prices quoted are the total payable. MAINTSUPP LTD is not currently VAT
              registered.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
