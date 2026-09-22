import { organization, website, jsonLd } from "./_components/structured-data";
import type { Metadata } from "next";
import { Fragment, type ReactNode } from "react";
import { readPublicSiteContent, type PublicSiteContent } from "../lib/site-content-public.ts";
import type { HomeSectionKey } from "../lib/site-content.ts";

/*
 * FOURTEEN SECTIONS, EACH EXACTLY ONCE — AND THE ORDER IS DATA NOW.
 *
 * Decision L moved the list itself to `HOME_SECTION_ORDER` in
 * `app/lib/site-content.ts`, which is where the fourteen and their shipped
 * sequence are declared and where the tests read them. This file holds the other
 * half: which component draws each of them. The page renders
 * `content.home.sections` — the shipped order unless MAINTSUPP staff have saved
 * another, with any hidden section left out — so the argument below is still the
 * default, and still what a visitor sees until someone deliberately changes it.
 *
 * Three sections cannot be moved or hidden, for reasons written beside them in
 * the registry: the hero carries the H1, the contact panel is the only form that
 * asks who you are, and Report a Job is the store manager's door whose `#report`
 * anchor is a LOCKED navigation link. The eleven between them may be reordered,
 * and hidden while nothing in the header or footer points at them.
 *
 * Was eleven sections. Homepage V3 is a DELTA on the v2 order, not another
 * rebuild: every section that was here is still here, three are added, and one
 * moved.
 *
 *   ADDED  WhatThisReplaces  — what the reader stops paying for and stops
 *                              doing; the buying question the symptom-level
 *                              comparison in Problem never answered
 *   ADDED  ContractorChoice  — "your contractors or ours", sitting between the
 *                              process and the price because that is where the
 *                              objection lands
 *   ADDED  Faq               — back on the homepage, sharing its questions with
 *                              /faqs rather than copying them (see faq.tsx)
 *   MOVED  ReportJob         — from fourth to LAST, directly above the footer
 *
 * WHY REPORT A JOB IS LAST. It is not a conversion step in the sales argument
 * at all: it is the door a store manager at an EXISTING client walks through
 * with a broken shutter, and they arrive by bookmark, by the header's "Report a
 * Job" or by the hero's second button — never by scrolling. Sitting fourth, an
 * eleven-field form interrupted the argument for every reader who was not that
 * person. At the bottom it is where a utility belongs and where the people who
 * want it already know to look, and the three routes into it are unchanged
 * because the `#report` anchor travels with the section.
 *
 * The page was sixteen before the v2 rebuild: hero, proof, process, trades,
 * problem, services, an early CTA band, how it works, portal, packages,
 * calculator, sectors, evidence, trust, FAQ and the final CTA. Four of those
 * described the same seven-stage process in four different shapes, and two more
 * asked for the same booking.
 *
 * WHAT WENT THEN, and why it is not simply hiding somewhere:
 *   proof       — stat tiles carrying numbers nobody could produce on request
 *   process     — "We Report / We Coordinate / Work Completed / Sign-off", the
 *                 first of the four process blocks; absorbed into HowItWorks
 *   trades      — a second photo grid of the same trades; now one row in
 *                 Services
 *   CtaBand     — the mid-page "leaking time and money" band, whose headline is
 *                 the final CTA's now
 *   evidence    — the chat/timeline retelling of the process; its close-out
 *                 photograph moved to the case study
 *   packages    — four tiers with no prices, replaced by Pricing
 *   calculator  — a slider estimating in-house cost; a persuasion device, not a
 *                 price
 *   sectors     — five photo tiles and a detail panel, replaced by WhoWeHelp
 *   faq-section — the hand-rolled accordion with its own second copy of the
 *                 questions. The QUESTIONS are back; that component is not —
 *                 `faq.tsx` is <details> over the shared array.
 */
import { Hero } from "./_sections/hero";
import { ReportJob } from "./_sections/report-job";
import { WhoWeHelp } from "./_sections/who-we-help";
import { Services } from "./_sections/services";
import { Problem } from "./_sections/problem";
import { WhatThisReplaces } from "./_sections/what-this-replaces";
import { Workflow as HowItWorks } from "./_sections/workflow";
import { ContractorChoice } from "./_sections/contractor-choice";
import { Pricing } from "./_sections/pricing";
import { CaseStudy } from "./_sections/case-study";
import { Founder } from "./_sections/founder";
import { Portal } from "./_sections/portal";
import { Faq } from "./_sections/faq";
import { FinalCta, TrustStrip } from "./_sections/final-cta";

/**
 * The title and the description staff have saved, or the ones the site ships
 * with (`SEO_COPY.home` in `_sections/copy.ts`) — resolved by the same read the
 * page body uses, so the two cannot disagree.
 *
 * EVERYTHING ELSE HERE IS CODE AND STAYS CODE: the canonical (this page is
 * `https://maintsupp.com/`, and four pages once told Google they were this one —
 * see `tests/marketing-canonicals.test.mjs`), and the OpenGraph url, siteName,
 * locale and type. A console that could edit those could take the site out of the
 * index.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { home } = await readPublicSiteContent();
  return {
    title: home.seo.title,
    description: home.seo.description,
    alternates: { canonical: "https://maintsupp.com/" },
    openGraph: {
      title: home.seo.title,
      /* The shorter line, which is what a shared link shows. */
      description: home.seo.socialDescription,
      url: "https://maintsupp.com/",
      siteName: "Maintsupp",
      locale: "en_GB",
      type: "website",
    },
  };
}

/**
 * WHICH COMPONENT DRAWS EACH SECTION. One entry per key in
 * `HOME_SECTION_ORDER`, and TypeScript requires the record to be complete — so a
 * section added to the registry cannot be forgotten here, and one removed from it
 * cannot be left behind.
 *
 * `finalCta` is two components — a dark full-bleed band and the form beneath it —
 * which is why there are fourteen sections and fifteen components. They are one
 * entry because they are one decision: the band is the form's own heading.
 */
const SECTIONS: Record<HomeSectionKey, (content: PublicSiteContent) => ReactNode> = {
  hero: ({ home, heroImage }) => <Hero copy={home.copy.hero} image={heroImage} />,
  whoWeHelp: ({ home }) => <WhoWeHelp copy={home.copy.whoWeHelp} />,
  services: ({ home }) => <Services copy={home.copy.services} />,
  problem: ({ home }) => <Problem copy={home.copy.problem} />,
  replaces: ({ home }) => <WhatThisReplaces copy={home.copy.replaces} />,
  how: ({ home }) => <HowItWorks copy={home.copy.how} />,
  yourContractors: ({ home }) => <ContractorChoice copy={home.copy.yourContractors} />,
  pricing: ({ home }) => <Pricing copy={home.copy.pricing} />,
  caseStudy: ({ home }) => <CaseStudy copy={home.copy.caseStudy} />,
  founder: ({ home }) => <Founder copy={home.copy.founder} />,
  portal: ({ home }) => <Portal copy={home.copy.portal} />,
  /* The questions are the FAQ page's list, so the accordion here and the page at
     /faqs cannot come to answer the same question differently. */
  faq: ({ home, faqs }) => <Faq copy={home.copy.faq} items={faqs.questions} />,
  finalCta: ({ home }) => (
    <>
      <TrustStrip />
      <FinalCta copy={home.copy.finalCta} />
    </>
  ),
  reportJob: ({ home }) => <ReportJob copy={home.copy.reportJob} />,
};

export default async function HomePage() {
  const content = await readPublicSiteContent();
  return (
    <main id="top">
      {content.home.sections.map((key) => (
        <Fragment key={key}>{SECTIONS[key](content)}</Fragment>
      ))}

      {/* The homepage owns the business and WebSite graph. FAQPage stays on
          /faqs, where the shared questions already have their canonical home. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd({
            "@context": "https://schema.org",
            "@graph": [organization, website],
          }),
        }}
      />
    </main>
  );
}
