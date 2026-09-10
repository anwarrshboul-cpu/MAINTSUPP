import type { Metadata } from "next";

/*
 * FOURTEEN SECTIONS, IN THIS ORDER, EACH EXACTLY ONCE.
 *
 * Was eleven. Homepage V3 is a DELTA on the v2 order, not another rebuild:
 * every section that was here is still here, three are added, and one moved.
 *
 *   ADDED  WhatThisReplaces  — what the reader stops paying for and stops
 *                              doing; the buying question the symptom-level
 *                              comparison in Problem never answered
 *   ADDED  ContractorChoice  — "your contractors or ours", sitting between the
 *                              process and the price because that is where the
 *                              objection lands
 *   ADDED  Faq               — back on the homepage, sharing `content.ts` with
 *                              /faqs rather than copying it (see faq.tsx)
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
 * asked for the same booking. The list below IS the contract — a test asserts
 * these fourteen and only these fourteen.
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

export const metadata: Metadata = {
  title: "Maintsupp — Multi-Site Commercial Maintenance Coordination, UK",
  description:
    "One point of contact for reactive repairs, planned maintenance and compliance across your retail or commercial portfolio. Vetted UK contractor network, verified close-outs, per-store pricing.",
  alternates: { canonical: "https://www.maintsupp.com/" },
  openGraph: {
    title: "Maintsupp — Multi-Site Commercial Maintenance Coordination, UK",
    description:
      "One point of contact for reactive repairs, planned maintenance and compliance across your retail or commercial portfolio.",
    url: "https://www.maintsupp.com/",
    siteName: "Maintsupp",
    locale: "en_GB",
    type: "website",
  },
};

export default function HomePage() {
  return (
    <main id="top">
      <Hero />
      <WhoWeHelp />
      <Services />
      <Problem />
      {/* Straight after the problem, and before the process: the reader has
          just seen what goes wrong, so this is the moment they will accept a
          list of what stops being their job. */}
      <WhatThisReplaces />
      <HowItWorks />
      {/* Between the process and the price. "Do I have to change my
          contractors?" is the question a reader asks in exactly that gap, and
          it used to be answered only in the eighth FAQ on another page. */}
      <ContractorChoice />
      <Pricing />
      <CaseStudy />
      <Founder />
      <Portal />
      {/* The questions, after every argument that raises them and before the
          form that asks for a meeting — sharing `content.ts` with /faqs. */}
      <Faq />
      {/* The trust strip and the CTA panel are ONE section in two components,
          because one is a dark full-bleed band and the other is the form
          beneath it. */}
      <TrustStrip />
      <FinalCta />
      {/* LAST, and directly above the footer — the layout renders SiteFooter
          straight after {children} and nothing sits between the two. (Written
          as a name rather than as JSX on purpose: the tests that assert this
          page's section order read it by matching self-closing tags in this
          file, and a component named inside a comment would be counted as one
          of them.) It is the store manager's door rather than a step in the
          sales argument — see the note at the top of this file. The #report
          anchor travels with the section, so the utility bar, the header, the
          hero's secondary button and the footer's "Report a Job" all still
          land on it without any of them changing. */}
      <ReportJob />

      {/*
        Organization only — and STILL only, now that the FAQ is back.

        The reason has changed and the outcome has not. It used to be that the
        homepage had no FAQ section, so claiming `FAQPage` here would have been
        markup pointing at content that was not on the page — the kind of thing
        that earns a manual action rather than a rich result. V3 renders the
        questions again, so that objection is gone and this block COULD carry
        the markup. It still does not, because /faqs publishes the same
        `FAQPage` from the same `content.ts` array, and two URLs claiming the
        same nine questions is a duplicate rather than twice the coverage. One
        canonical home for the schema, on the page whose whole subject is the
        questions; the homepage renders them visibly and says nothing about it
        in JSON-LD.
      */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Organization",
            name: "Maintsupp",
            legalName: "Maintauk Ltd",
            url: "https://www.maintsupp.com/",
            telephone: "+44 7852 224644",
            email: "info@maintsupp.com",
            identifier: "17262302",
            areaServed: "GB",
          }),
        }}
      />
    </main>
  );
}
