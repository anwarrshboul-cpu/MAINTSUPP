import type { Metadata } from "next";
import Link from "next/link";
import { PageCta, PageHero, PageSection } from "../_components/page-parts";
import { ContractorChoice } from "../_sections/contractor-choice";
import { faq as SHIPPED_QUESTIONS } from "../_sections/content";
import { ApprovedPhoto } from "../_sections/approved-photo";
import { Pricing } from "../_sections/pricing";
import { readPublicSiteContent } from "../../lib/site-content-public.ts";
import { TERMS } from "../_sections/rates";
import { pageSocial } from "../../lib/page-social";

/**
 * /pricing — how a job is priced, and what a visit costs.
 *
 * Was the `#pricing` anchor on the homepage, then a page that explained the
 * monthly coordination fee: a rate card, "one coordination fee", "contractors
 * invoice you directly". The owner withdrew the published plans on 2026-11-25
 * (`_sections/rates.ts` records why), so this page now explains the offer that
 * replaced them — pay per job, the price confirmed before work starts.
 *
 * It still draws the homepage's own `Pricing` section rather than a second
 * copy, and it still types no figure: `tests/homepage-v3.test.mjs` refuses a
 * price anywhere in the marketing tree, with no exception left. The commercial
 * terms are QUOTED from `TERMS` for the reason the rates used to be derived —
 * the cards, the FAQ and this page cannot then word the call-out promise three
 * ways. What this page adds is the explanation around those terms and the
 * pricing questions from the shared FAQ list (the resolved one, so a question
 * staff edit changes here too).
 */

/* "Pricing" alone rendered as "Pricing | MAINTSUPP". The title says what is
   priced and the one thing about it a buyer cares about — which used to be
   "per store, no trade markup" and is now "per job, no subscription". Kept
   under fifty characters, like every other page title here, because the
   layout appends " | MAINTSUPP" and a search result cuts the line at about
   sixty. */
const TITLE = "Maintenance Pricing: Pay Per Job, No Subscription";
/* At most 160 characters: a longer line is cut off in search results. */
const DESCRIPTION = "Pay per job for shop, kiosk and commercial repairs: the price is confirmed before work starts. No subscription. No call-out charge when we carry out the repair.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "https://maintsupp.com/pricing" },
  ...pageSocial("/pricing", TITLE, DESCRIPTION),
};

const HOW_PRICING_WORKS = [
  {
    title: "One price per job",
    body: "Send the job with a photograph. We confirm the price and the time with you, and nothing is booked until you approve it.",
  },
  {
    title: "No call-out charge with the repair",
    body: `${TERMS.callOut} ${TERMS.noRepairVisit}`,
  },
  {
    title: "Projects quoted separately",
    body: "Kiosk installs and removals, strip-outs, fit-outs, signage and multi-trade store works are scoped and quoted one by one, so a project never hides inside a repair.",
  },
] as const;

/* The questions a buyer asks about money, in the shared list's own words. */
const PRICING_QUESTIONS = [
  "What does it cost?",
  "Is there a minimum number of sites?",
  "Do you take one-off jobs for a single shop or kiosk?",
  "Who pays the contractor?",
  "Can we keep our current contractors?",
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
        title="Pay per job, with the price agreed before work starts"
        lede="Tell us what needs doing and we confirm the price and the time before anything is booked. No subscription, no minimum term, and no call-out charge when we carry out the repair."
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
        {/* The page's own two doors, in the order this reader needs them: get
            a job priced, or ask. `HeroActions` leads with the portfolio review,
            which is the right first button on every other page and the wrong
            one on the page that says you pay per job. */}
        <Link className="btn btn--primary btn--lg" href="/#report">
          Report a Job
        </Link>
        <Link className="btn btn--ghost btn--lg" href="/contact">
          Ask for a price
        </Link>
      </PageHero>

      <Pricing copy={home.copy.pricing} />

      <PageSection tint eyebrow="How pricing works" heading="Three things you know before any work starts">
        <ul className="factgrid factgrid--three reveal" role="list">
          {HOW_PRICING_WORKS.map((item, index) => (
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
        <PageSection eyebrow="Pricing questions" heading="What people ask before they book">
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

      <PageCta
        heading="Want a price for a job?"
        lede="Send the job with a photograph and we confirm the price and the time. Running several sites? Tell us about the portfolio and we will come back to you."
        primary={{ href: "/#report", label: "Report a Job" }}
      />
    </main>
  );
}
