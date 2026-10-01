import type { Metadata } from "next";
import { HeroActions, PageCta, PageHero, PageSection } from "../_components/page-parts";
import { ContractorChoice } from "../_sections/contractor-choice";
import { faq as SHIPPED_QUESTIONS } from "../_sections/content";
import { ApprovedPhoto } from "../_sections/approved-photo";
import { Pricing } from "../_sections/pricing";
import { readPublicSiteContent } from "../../lib/site-content-public.ts";
import { pageSocial } from "../../lib/page-social";

/**
 * /pricing — the coordination fee, and how the money moves.
 *
 * Was the `#pricing` anchor on the homepage. Every figure on this page is drawn
 * by the homepage's own `Pricing` section from `rates.ts`, so there is one rate
 * card and it cannot disagree with itself; `tests/homepage-v3.test.mjs` refuses a
 * price typed anywhere else in the marketing tree, and this file types none.
 * What this page adds is the explanation around those numbers and the pricing
 * questions from the shared FAQ list (the resolved one, so a question staff
 * edit changes here too).
 */

const TITLE = "Pricing";
const DESCRIPTION =
  "Simple per-store pricing for multi-site maintenance coordination. Contractors invoice you directly at their agreed rates — no hidden markups on trades.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "https://maintsupp.com/pricing" },
  ...pageSocial("/pricing", TITLE, DESCRIPTION),
};

const BILLING = [
  {
    title: "One coordination fee",
    body: "A monthly fee per store for the coordination itself — intake, triage, contractor management, evidence checks and reporting. The rate card above shows exactly what each plan includes.",
  },
  {
    title: "Contractors invoice you directly",
    body: "Trades bill you at their agreed rates. We reconcile every invoice against the approved quote, and we never add a markup to a contractor’s price.",
  },
  {
    title: "Projects quoted separately",
    body: "Kiosk moves, refreshes, signage and multi-trade store works are scoped and quoted one by one, so a project never hides inside a monthly fee.",
  },
] as const;

/* The questions a buyer asks about money, in the shared list's own words. */
const PRICING_QUESTIONS = [
  "What does it cost?",
  "Who pays the contractor?",
  "What if we only have three or four sites?",
  "Can we keep our current contractors?",
  "How quickly can mobilisation begin?",
];

export default async function PricingPage() {
  const { home, faqs } = await readPublicSiteContent();
  /* The resolved list, or the shipped one when it is empty — the rule /faqs follows. */
  const list: readonly { q: string; a: string }[] = faqs.questions.length ? faqs.questions : SHIPPED_QUESTIONS;
  const questions = PRICING_QUESTIONS.map((q) => list.find((entry) => entry.q === q)).filter(
    (entry): entry is { q: string; a: string } => Boolean(entry),
  );
  return (
    <main id="top">
      <PageHero
        crumbs={[{ name: "Home", path: "/" }, { name: "Pricing", path: "/pricing" }]}
        eyebrow="Pricing"
        title="Clear per-store pricing, with no markup on trades"
        lede="You pay one coordination fee per store. Contractors invoice you directly at their agreed rates, and every cost is reconciled against the approved quote."
        media={
          <ApprovedPhoto
            src="/assets/pages/page-pricing-hero-v1.jpg"
            alt="A facilities manager reviewing an invoice on a laptop beside a printed maintenance summary report"
            sizes="(min-width: 1024px) 600px, 100vw"
            loading="eager"
            className="pagehero__photo"
          />
        }
      >
        <HeroActions secondary={{ href: "/contact", label: "Ask for a quote" }} />
      </PageHero>

      <Pricing copy={home.copy.pricing} />

      <PageSection tint eyebrow="How billing works" heading="Three lines on the bill, and nothing hidden between them">
        <ul className="factgrid factgrid--three reveal" role="list">
          {BILLING.map((item, index) => (
            <li className="factcard" key={item.title}>
              <span className="factcard__n">{index + 1}</span>
              <h3 className="factcard__title">{item.title}</h3>
              <p>{item.body}</p>
            </li>
          ))}
        </ul>
      </PageSection>

      <ContractorChoice copy={home.copy.yourContractors} />

      {questions.length ? (
        <PageSection eyebrow="Pricing questions" heading="What people ask before they sign">
          <div className="pagefaq reveal">
            {questions.map((entry) => (
              <details key={entry.q}>
                <summary>{entry.q}</summary>
                <p>{entry.a}</p>
              </details>
            ))}
          </div>
        </PageSection>
      ) : null}

      <PageCta heading="Want a figure for your own portfolio?" />
    </main>
  );
}
