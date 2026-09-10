import Link from "next/link";
import { faq } from "./content";

/**
 * SECTION — Frequently asked questions. Back on the homepage in V3.
 *
 * IT WAS REMOVED ONCE, AND THIS IS NOT THAT COMPONENT. The rebuild deleted
 * `faq-section.tsx` — a hand-rolled accordion with its own `faq-items.ts` copy
 * of the questions — and left `/faqs` as the only place they were answered. Two
 * things were wrong with that: the reader who needs the answers is the one on
 * the homepage deciding, not the one who has already gone looking; and the two
 * files meant two copies of nine strings that nothing kept in step.
 *
 * SHARED, NOT COPIED AND NOT SUPERSEDED. `content.ts` holds the questions and
 * `/faqs` still renders them at their own URL. This section reads the same
 * array, so an edit to an answer lands in both places by construction and
 * neither page can come to answer a question differently from the other. That
 * is also why there is no second list of "homepage questions" here: a subset
 * would be a third thing to keep true, and nine collapsed rows cost about the
 * height of one open answer.
 *
 * <details>, NOT A REACT ACCORDION. The old one carried state, a click
 * handler, `aria-expanded` and a height transition. The element does all four
 * natively, works before hydration and works with JavaScript off, and this is
 * the section a reader reaches after a page of arguments — the one place on the
 * page where a component failing to hydrate would silently hide the content.
 *
 * THE STRUCTURED DATA STAYS ON /faqs, deliberately — see the note in
 * `page.tsx`. Two URLs publishing the same `FAQPage` for the same nine
 * questions is a duplicate, not twice the coverage.
 */
export function Faq() {
  return (
    <section className="section section--tint" id="faq">
      <div className="wrap">
        <div className="reveal">
          <p className="eyebrow">Straight answers</p>
          <h2 className="h2">Frequently asked questions</h2>
          {/* No count in the copy. "The nine below" would be a number this
              section does not own — the array is in content.ts and /faqs
              renders it too — so a tenth question would silently make the
              sentence false. */}
          <p className="lede">
            The questions we are asked before every portfolio review, answered the way we
            answer them on the call.
          </p>
        </div>

        {/*
          THE CLASS NAMES ARE THE OLD ACCORDION'S, ON PURPOSE. `.faq__item`,
          `.faq__q` and `.faq__a` survived the section's removal as dead rules
          in marketing.css — the styling for a component nothing rendered. They
          are adopted here rather than duplicated under a new prefix, so the
          stylesheet loses a dead block instead of gaining a second live one.
          What changed in CSS is the open/closed hook: a button carried
          `aria-expanded`, <details> carries `[open]`.
        */}
        <div className="faq__list reveal">
          {faq.map((entry, index) => (
            /*
              The first is open. A column of closed rows gives a reader nothing
              to judge the answers by, and the first question — whether
              Maintsupp employs its own engineers — is the one the rest of the
              page depends on being answered honestly.
            */
            <details className="faq__item" key={entry.q} open={index === 0}>
              <summary className="faq__q">
                <span>{entry.q}</span>
                {/* Rotated by CSS on `[open]`; `aria-hidden` because <summary>
                    already announces its own expanded state. */}
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
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </summary>
              <div className="faq__a">
                <p>{entry.a}</p>
              </div>
            </details>
          ))}
        </div>

        <p className="faq__more reveal">
          Still deciding? <Link href="/faqs">Read the FAQs on their own page</Link>, or ask
          us directly at <a href="mailto:info@maintsupp.com">info@maintsupp.com</a>.
        </p>
      </div>
    </section>
  );
}
