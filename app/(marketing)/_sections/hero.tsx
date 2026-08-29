"use client";

import { useEffect, useState } from "react";
import { PhotoSlot } from "./photo";

/* ================================================== 1. HERO BANNER
 * A port of the standalone landing page's hero. Class names, icon geometry and
 * the banner photograph are the source's; the headline, the lede and the three
 * chips are the rebuild's.
 *
 * THE INTAKE FORM USED TO LIVE HERE, as the second column of `.hero__inner`.
 * It is `report-job.tsx` now — its own section, which is what let this one be
 * a hero rather than a headline sharing the fold with eleven fields.
 */

/* ── hero feed ────────────────────────────────────────────────────────────── */

const feedLines: Array<[string, string]> = [
  /*
   * "same day", not "in 14 minutes". A minute count on a rotating chip reads as
   * a response time the reader can hold us to, and this feed is an
   * illustration of the kind of thing that moves through the system — which is
   * what the "Example" tag beside it now says out loud.
   */
  ["Shutter fault reported", "Retail unit, Manchester — contractor assigned same day"],
  ["Fire alarm service booked", "Leisure venue, Cardiff — certificate due in 21 days"],
  ["Job closed with evidence", "Kiosk, Leeds — before/after photos and cost reconciled"],
  ["No power to till bank", "Store, Birmingham — escalated to P1, engineer en route"],
  ["Quote approved", "Gym, Bristol — HVAC repair released to contractor"],
  ["Emergency lighting test", "Office, Reading — remedial actions logged and owned"],
];

function HeroFeed() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    const timer = window.setInterval(() => setIndex((current) => current + 1), 4200);
    return () => window.clearInterval(timer);
  }, []);

  const [title, detail] = feedLines[index % feedLines.length];

  return (
    <div className="hero__feed" id="heroFeed">
      {/* Keyed on the index so React remounts the node and the CSS entry
          animation replays, exactly as the source's innerHTML swap did. */}
      <span className="feedline" key={index}>
        {/* Marks the whole chip as an illustration rather than a claim. It is
            the first thing in the reading order, so it qualifies the line
            before the line is read. */}
        <em className="feedline__tag">Example</em>
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
    </div>
  );
}

/* ── hero ─────────────────────────────────────────────────────────────────── */

export function Hero() {
  return (
    <section className="hero" id="hero">
      {/* The source marked this whole block aria-hidden because the photograph
          was a CSS background with no alt text. PhotoSlot renders a real <img>,
          so only the scrim stays hidden and the photograph is described. */}
      <div className="hero__media">
        {/*
          THE APPROVED v4 PHOTOGRAPH, ON A URL NOBODY HAS EVER FETCHED.

          The slot stem carries the version — `hero-maintenance-v4` — because
          every derived variant inherits it, and this repo has been burned once
          by replacing variant CONTENT at unchanged variant PATHS: those files
          are served `Cache-Control: immutable`, so returning visitors kept the
          old bytes. `hero-london-maintenance*` still sits on disk, unchanged
          and now referenced by nothing.

          `w`/`h` are the source's real 1916x821, so the fallback artwork behind
          the photograph is drawn at the photograph's own shape.

          `sizes` is the correction that matters for weight. The default hint is
          `620px` at desktop — written for the section tiles — and this is a
          full-bleed background that paints at 100vw and then some, so the
          browser was picking a variant roughly a third of the width it needed
          and upscaling it across the fold.

          AND A SECOND PLATE FOR PHONES, WHICH IS ART DIRECTION, NOT RESIZING.
          The approved desktop file is 2.33:1 and a phone viewport is about
          0.47:1. There is no framing of a plate that shape which survives a
          portrait screen — every variant of it that has been tried cropped
          away either the plant panel or the access platform, and the shipped
          one showed a third of the width and one hard hat. So the owner shot
          the scene again in portrait, 941x1452, with a tall clean sky for the
          headline and every subject in the lower half; `narrow` hands it to
          the browser behind a `media` query and the browser fetches exactly
          one of the two. The breakpoint is the stylesheet's own 620px, so the
          picture the CSS is framing is always the picture on screen.

          The `alt` describes what is common to both plates, because an `<img>`
          carries one alt whichever `<source>` wins.
        */}
        <PhotoSlot
          slot="hero-maintenance-v4"
          narrow={{ slot: "hero-maintenance-mobile-v5", media: "(max-width: 620px)" }}
          w={1916}
          h={821}
          art="city"
          sizes="100vw"
          alt="Two maintenance engineers in hi-vis jackets and hard hats working at an open plant panel on a London rooftop at dusk, the lit City skyline behind them and an access platform raised nearby"
          desc="London rooftop at dusk: engineers at a plant panel on the left, the City skyline centre, an access platform right"
          priority
        />
        <div className="hero__scrim" aria-hidden="true" />
      </div>

      <div className="wrap hero__inner">
        <div>
          <span className="hero__kicker">
            <svg
              className="ic ic--xs"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M14.7 6.3a4 4 0 1 0 5 5L21 21H3l9.7-9.7a4 4 0 0 1 2-4.9Z" />
            </svg>
            Commercial maintenance across the UK
          </span>
          {/* The H1 carries the proposition in one sentence now. It was
              "Maintenance Coordination. / Done Right." — a claim about us. The
              accent span is kept because it is the hero's typographic identity;
              it just falls on the half that says what the reader gets. */}
          <h1 className="hero__title">
            <span>Multi-site commercial maintenance,</span>
            <span className="hero__accent">managed through one point of contact.</span>
          </h1>
          <p className="hero__lede">
            Maintsupp coordinates reactive repairs, planned maintenance and compliance
            services for retailers and commercial operators across the UK — through one
            managed contact and a vetted contractor network.
          </p>
          {/*
            THREE TRUST CHIPS, and each one is now a checkable fact.

            They read "Faster Response", "Complete Visibility" and "Proven
            Compliance" — three claims with no evidence behind any of them, and
            the middle one is the sort of thing the copy rules exist to stop.
            What replaces them is a network we can describe, a standard we
            actually apply, and a number we can stand behind.

            Same `.hero__pills` markup and the same icon grid, so the chip
            styling is untouched.
          */}
          <ul className="hero__pills">
            <li>
              <svg
                className="ic ic--sm"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 21s8-3.5 8-9V5l-8-3-8 3v7c0 5.5 8 9 8 9Z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
              <span>Vetted UK contractor network</span>
            </li>
            <li>
              <svg
                className="ic ic--sm"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
              <span>Evidence-based close-out</span>
            </li>
            <li>
              <svg
                className="ic ic--sm"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 21V9l6-4 6 4v12" />
                <path d="M15 21V13h6v8" />
                <path d="M2 21h20M7 12h2M7 16h2" />
              </svg>
              <span>+20 stores currently coordinated</span>
            </li>
          </ul>
          <div className="hero__actions">
            <a className="btn btn--primary btn--lg" href="#review">
              Book a Portfolio Review
              <svg
                className="ic ic--xs"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </a>
            {/* The secondary action goes to the form, not to the explanation.
                Somebody with a broken shutter is not here to read seven
                stages. */}
            <a className="btn btn--outline btn--lg" href="#report">
              <svg
                className="ic ic--sm"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="8" y="2" width="8" height="4" rx="1" />
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                <path d="M12 11v6M9 14h6" />
              </svg>
              Report a Job
            </a>
          </div>
          <div className="hero__live" aria-live="off">
            <span className="hero__pulse" aria-hidden="true" />
            <HeroFeed />
          </div>
        </div>
      </div>
    </section>
  );
}
