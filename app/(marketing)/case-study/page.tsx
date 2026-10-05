import type { Metadata } from "next";
import { FeatureRow, HeroActions, PageCta, PageHero, PageSection } from "../_components/page-parts";
import { ApprovedPhoto } from "../_sections/approved-photo";
import { CaseStudy } from "../_sections/case-study";
import { Founder } from "../_sections/founder";
import { Portal } from "../_sections/portal";
import { readPublicSiteContent } from "../../lib/site-content-public.ts";
import { pageSocial } from "../../lib/page-social";

/**
 * /case-study — the one portfolio Maintsupp can describe.
 *
 * Was the `#case-study` anchor on the homepage, and it stays as ANONYMOUS as that
 * section is: no client name, no logo, nothing beyond the shape of the
 * portfolio. Every statement below restates something the homepage section
 * already says — the brief, what Maintsupp runs, what the client receives — at
 * greater length. There are no new figures: the section's own comment explains
 * why the stat tiles that once claimed percentages were removed, and a longer
 * page is not a licence to bring them back.
 */

const TITLE = "Case Study: Maintenance for a 27-Store Retailer";
const DESCRIPTION =
  "How MAINTSUPP coordinates maintenance for a UK fragrance retailer with 27 stores and kiosks: one contact, vetted contractors and photo-verified close-outs.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "https://maintsupp.com/case-study" },
  ...pageSocial("/case-study", TITLE, DESCRIPTION),
};

const SIZES = "(min-width: 1024px) 560px, 100vw";

export default async function CaseStudyPage() {
  const { home } = await readPublicSiteContent();
  return (
    <main id="top">
      <PageHero
        crumbs={[{ name: "Home", path: "/" }, { name: "Case Study", path: "/case-study" }]}
        eyebrow="Case study"
        title="A UK fragrance retailer: 27 stores and kiosks, one point of contact"
        lede="Stores on the high street and kiosks in shopping centres, each with its own access rules, contractors and compliance dates — now run through one accountable coordinator and one monthly report."
        media={
          <ApprovedPhoto
            src="/assets/pages/page-case-study-hero-v1.jpg"
            alt="A Maintsupp engineer adjusting a spotlight on a dark green and gold fragrance kiosk in a shopping centre"
            sizes="(min-width: 1024px) 600px, 100vw"
            loading="eager"
            className="pagehero__photo"
          />
        }
      >
        <HeroActions />
      </PageHero>

      <CaseStudy copy={home.copy.caseStudy} />

      <PageSection tint eyebrow="The engagement" heading="The brief, the work and what the client sees">
        <div className="featurerows">
          <FeatureRow
            title="The brief"
            body="A portfolio of 27 stores and kiosks needed one accountable contact for every repair, every compliance date and every store project — instead of store managers each finding and chasing their own contractors."
            points={[
              "High-street stores and shopping-centre kiosks",
              "Centre permits and access windows to respect",
              "Repairs, compliance and store works in one place",
            ]}
            media={
              <ApprovedPhoto
                src="/assets/pages/case-brief-v1.jpg"
                alt="A woman in a Maintsupp jacket photographing a water-stained ceiling tile in a fragrance shop with her phone"
                sizes={SIZES}
                className="featurerow__photo"
              />
            }
          />
          <FeatureRow
            title="What Maintsupp runs"
            body="Every job comes through one intake. We triage it, assign a vetted contractor, chase attendance and verify completion with photo evidence before it is closed."
            points={[
              "Intake and triage for every store and kiosk",
              "Vetted contractors assigned by trade and region",
              "Attendance chased until the job is done",
              "Completion verified with photo evidence",
            ]}
            media={
              <ApprovedPhoto
                src="/assets/pages/case-work-v1.jpg"
                alt="A Maintsupp contractor in a hi-vis vest carrying a toolbag into a shopping centre while checking the job on his phone"
                sizes={SIZES}
                className="featurerow__photo"
              />
            }
          />
          <FeatureRow
            title="What the client receives"
            body="A monthly report on jobs, spend and compliance status across the whole portfolio, and a portal where the evidence behind every job can be opened."
            points={[
              "One monthly report for the portfolio",
              "Jobs, spend and compliance status in one view",
              "Photographs and certificates kept against each job",
            ]}
            media={
              <ApprovedPhoto
                src="/assets/pages/case-results-v1.jpg"
                alt="Two managers reviewing a printed Maintsupp monthly report with charts beside a laptop dashboard"
                sizes={SIZES}
                className="featurerow__photo"
              />
            }
          />
        </div>
      </PageSection>

      <Founder copy={home.copy.founder} />
      <Portal copy={home.copy.portal} />
      <PageCta heading="Running a portfolio like this one?" />
    </main>
  );
}
