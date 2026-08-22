import type { Metadata } from "next";

/*
 * ELEVEN SECTIONS, IN THIS ORDER, EACH EXACTLY ONCE.
 *
 * Was ten. The v2 positioning edit moved Report a Job from second to fourth and
 * added "Who runs Maintsupp" between the case study and the portal — so the
 * page now argues who it is for, what it covers, and only then asks for the
 * form, and closes by naming the person accountable before showing the tool.
 *
 * The page was sixteen: hero, proof, process, trades, problem, services, an
 * early CTA band, how it works, portal, packages, calculator, sectors,
 * evidence, trust, FAQ and the final CTA. Four of those described the same
 * seven-stage process in four different shapes, and two more asked for the same
 * booking. The order below is the brief's, and the list IS the contract — a
 * test asserts these ten and only these ten.
 *
 * WHAT WENT, and why it is not simply hiding somewhere:
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
 *   Faq         — see the note on structured data below
 */
import { Hero } from "./_sections/hero";
import { ReportJob } from "./_sections/report-job";
import { WhoWeHelp } from "./_sections/who-we-help";
import { Services } from "./_sections/services";
import { Problem } from "./_sections/problem";
import { Workflow as HowItWorks } from "./_sections/workflow";
import { Pricing } from "./_sections/pricing";
import { CaseStudy } from "./_sections/case-study";
import { Founder } from "./_sections/founder";
import { Portal } from "./_sections/portal";
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
      {/* Moved down from second. The fold now opens on who this is for and what
          it covers, and the eleven-field form is met after the reader has a
          reason to fill it in. Its #report anchor travels with it, so the nav
          button and the hero's secondary CTA land on the form in its new
          position without either of them changing. */}
      <ReportJob />
      <Problem />
      <HowItWorks />
      <Pricing />
      <CaseStudy />
      <Founder />
      <Portal />
      {/* Section 10 is the trust strip and the CTA panel — one section of the
          ten, in two components because one is a dark full-bleed band and the
          other is the form beneath it. */}
      <TrustStrip />
      <FinalCta />

      {/*
        Organization only. The `FAQPage` block is not lost with the accordion.

        Removing the FAQ section takes its structured data with it, which would
        normally cost a rich result. Checked before deleting: /faqs already
        publishes its own `FAQPage`, built from `content.ts`, and the two
        question sets are IDENTICAL — nine questions, same nine strings. The
        block here was a duplicate of a page that renders the answers visibly,
        which is where the markup belongs anyway. Nothing needed moving and
        nothing was given up.
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
