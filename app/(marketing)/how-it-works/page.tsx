import type { Metadata } from "next";
import { HeroActions, PageCta, PageHero, PageSection } from "../_components/page-parts";
import { ApprovedPhoto } from "../_sections/approved-photo";
import { stages as STAGES } from "../_sections/content";
import { Portal } from "../_sections/portal";
import { WhatThisReplaces } from "../_sections/what-this-replaces";
import { Workflow as HowItWorks } from "../_sections/workflow";
import { readPublicSiteContent } from "../../lib/site-content-public.ts";
import { pageSocial } from "../../lib/page-social";

/**
 * /how-it-works — one job, from report to verified close-out.
 *
 * Was the `#how` anchor on the homepage. The interactive seven-stage walk-through
 * is the homepage's own section, reused with the copy staff edit there; below it
 * the same seven stages as a table of who does what and what the record holds —
 * the `stages` data in `content.ts`, the client's own words, which the walk-through
 * shows one stage at a time and this shows all at once.
 */

const TITLE = "How Maintenance Coordination Works: 7 Stages";
const DESCRIPTION =
  "How MAINTSUPP runs a maintenance job from report to verified close-out: triage, approval, contractor assignment, attendance, photo evidence and reporting.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "https://maintsupp.com/how-it-works" },
  ...pageSocial("/how-it-works", TITLE, DESCRIPTION),
};

const PRINCIPLES = [
  {
    title: "One accountable coordinator",
    body: "Every job has a named owner from the moment it is reported until the evidence is checked. Nobody on your side chases a contractor.",
  },
  {
    title: "Spend inside your limits",
    body: "Quotes above the threshold you set come to you for approval before anyone is instructed, and the final cost is reconciled against the approved quote.",
  },
  {
    title: "Evidence before closure",
    body: "Before and after photographs, reports and certificates are checked against the job before it is closed — not taken on trust.",
  },
  {
    title: "Everything on the record",
    body: "Each decision is logged with who made it and when, so the monthly report and the portal show the same history.",
  },
] as const;

export default async function HowItWorksPage() {
  const { home } = await readPublicSiteContent();
  return (
    <main id="top">
      <PageHero
        crumbs={[{ name: "Home", path: "/" }, { name: "How It Works", path: "/how-it-works" }]}
        eyebrow="How it works"
        title="From the first report to a verified close-out"
        lede="Seven stages, one coordinator. The site tells us what is wrong; we triage it, get spend approved, brief a vetted contractor, follow attendance and check the evidence before the job is closed and reported."
        media={
          <ApprovedPhoto
            src="/assets/pages/page-how-it-works-hero-v1.jpg"
            alt="A Maintsupp coordinator in a headset working at two monitors that show a job board with coloured status columns"
            sizes="(min-width: 1024px) 600px, 100vw"
            loading="eager"
            className="pagehero__photo"
          />
        }
      >
        <HeroActions />
      </PageHero>

      <HowItWorks copy={home.copy.how} />

      <PageSection
        eyebrow="Who does what"
        heading="Every stage, and what it leaves on the record"
        lede="What you do, what we do, and what the system records at each step."
      >
        <div className="stagetable reveal">
          <table>
            <thead>
              <tr>
                <th scope="col">Stage</th>
                <th scope="col">What happens</th>
                <th scope="col">Your part</th>
                <th scope="col">What is recorded</th>
              </tr>
            </thead>
            <tbody>
              {STAGES.map((stage, index) => (
                <tr key={index}>
                  <th scope="row">
                    <span className="stagetable__n">{index + 1}</span>
                    {stage.name}
                  </th>
                  <td data-label="What happens">
                    <strong>{stage.heading}.</strong> {stage.body}
                  </td>
                  <td data-label="Your part">{stage.you}</td>
                  <td data-label="What is recorded">{stage.records}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageSection>

      <PageSection tint eyebrow="The principles" heading="Four rules every job follows">
        <ul className="factgrid reveal" role="list">
          {PRINCIPLES.map((principle) => (
            <li className="factcard" key={principle.title}>
              <h3 className="factcard__title">{principle.title}</h3>
              <p>{principle.body}</p>
            </li>
          ))}
        </ul>
      </PageSection>

      <WhatThisReplaces copy={home.copy.replaces} />
      <Portal copy={home.copy.portal} />
      <PageCta />
    </main>
  );
}
