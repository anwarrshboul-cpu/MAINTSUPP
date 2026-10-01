import type { Metadata } from "next";
import { HeroActions, FeatureRow, PageCta, PageHero, PageSection } from "../_components/page-parts";
import { ApprovedPhoto } from "../_sections/approved-photo";
import { ContractorChoice } from "../_sections/contractor-choice";
import { services as SERVICE_DETAIL, trades as TRADE_DETAIL } from "../_sections/content";
import { PhotoSlot } from "../_sections/photo";
import { photoAlt } from "../_sections/photo-slot";
import { Services } from "../_sections/services";
import { WhoWeHelp } from "../_sections/who-we-help";
import { readPublicSiteContent } from "../../lib/site-content-public.ts";
import { pageSocial } from "../../lib/page-social";

/**
 * /services — what Maintsupp coordinates, in full.
 *
 * Was the `#services` anchor on the homepage, which still carries the short
 * version. This page opens with that same section (the words staff edit for the
 * homepage, so the two cannot disagree) and then gives what the homepage had no
 * room for: each service in detail and the faults handled trade by trade. That
 * detail is the client's own copy from `content.ts`, which no page drew until
 * now — nothing below was written for this page.
 */

const TITLE = "Maintenance Services";
const DESCRIPTION =
  "Reactive repairs, planned maintenance, compliance administration and store projects for UK multi-site commercial operators — coordinated through one point of contact.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "https://maintsupp.com/services" },
  ...pageSocial("/services", TITLE, DESCRIPTION),
};

/* The photograph that shows each service happening. */
const SERVICE_MEDIA: Record<(typeof SERVICE_DETAIL)[number]["id"], { src: string; alt: string }> = {
  reactive: {
    src: "/assets/pages/service-reactive-v1.jpg",
    alt: "A Maintsupp engineer kneeling at a shop entrance to repair a jammed roller shutter, with an open toolbox and phone beside him",
  },
  planned: {
    src: "/assets/pages/service-planned-v1.jpg",
    alt: "A Maintsupp technician in a hard hat checking a tablet checklist beside an open rooftop air-conditioning unit above the London skyline",
  },
  compliance: {
    src: "/assets/pages/service-compliance-v1.jpg",
    alt: "A Maintsupp technician testing an emergency light beside a red fire alarm panel in a back-of-house corridor",
  },
  projects: {
    src: "/assets/pages/service-projects-v1.jpg",
    alt: "A Maintsupp fit-out team installing a glass display kiosk in a shopping centre, one fitting a panel while another checks a drawing",
  },
};

/* Which photograph stands for which trade. Six are the trade photographs the
   homepage already draws (`/assets/photos`, through `PhotoSlot`); security and
   refrigeration had none, and are the two supplied with the page pack. */
const TRADE_PHOTO: Partial<Record<(typeof TRADE_DETAIL)[number]["id"], string>> = {
  electrical: "trade-electrical",
  doors: "trade-doors",
  leaks: "trade-leaks",
  hvac: "trade-hvac",
  fabric: "trade-fabric",
  signage: "trade-signage",
};
const TRADE_SUPPLIED: Partial<Record<(typeof TRADE_DETAIL)[number]["id"], { src: string; alt: string }>> = {
  cctv: {
    src: "/assets/pages/trade-cctv-v1.jpg",
    alt: "A Maintsupp engineer on a stepladder adjusting a ceiling dome CCTV camera beside a store entrance with an access-control keypad",
  },
  refrigeration: {
    src: "/assets/pages/trade-refrigeration-v1.jpg",
    alt: "A Maintsupp refrigeration engineer checking a display chiller of drinks and sandwiches with a digital temperature gauge",
  },
};
const TRADE_SIZES = "(min-width: 1024px) 300px, (min-width: 640px) 50vw, 100vw";

const SIZES = "(min-width: 1024px) 560px, 100vw";

export default async function ServicesPage() {
  const { home } = await readPublicSiteContent();
  return (
    <main id="top">
      <PageHero
        crumbs={[{ name: "Home", path: "/" }, { name: "Services", path: "/services" }]}
        eyebrow="Services"
        title="Maintenance services for multi-site commercial operators"
        lede="Reactive repairs, planned maintenance, compliance administration and store projects — run through one managed point of contact and a vetted UK contractor network, with photo evidence on every close-out."
        media={
          <ApprovedPhoto
            src="/assets/pages/page-services-hero-v1.jpg"
            alt="A Maintsupp engineer in a hi-vis vest on a stepladder repairing an illuminated shopfront sign on a rain-wet UK high street at dusk"
            sizes="(min-width: 1024px) 600px, 100vw"
            loading="eager"
            className="pagehero__photo"
          />
        }
      >
        <HeroActions />
      </PageHero>

      <Services copy={home.copy.services} />

      <PageSection
        tint
        eyebrow="In detail"
        heading="What each service covers"
        lede="Every service runs through the same coordinator, the same evidence standard and the same monthly report."
      >
        <div className="featurerows">
          {SERVICE_DETAIL.map((service) => (
            <FeatureRow
              key={service.id}
              title={service.label}
              body={`${service.heading} ${service.body}`}
              points={service.list}
              media={
                <ApprovedPhoto
                  src={SERVICE_MEDIA[service.id].src}
                  alt={SERVICE_MEDIA[service.id].alt}
                  sizes={SIZES}
                  className="featurerow__photo"
                />
              }
            />
          ))}
          <FeatureRow
            title="Reporting & Visibility"
            body="Monthly KPI, spend, ageing and compliance reporting across the portfolio — and a client portal where authorised users see live jobs, approvals, spend and evidence for their own sites."
            points={[
              "Monthly report on jobs, spend and compliance status",
              "Ageing of open jobs by site and priority",
              "Spend by site, trade and contractor",
              "Evidence and certificates kept against each job",
            ]}
            media={
              <PhotoSlot
                slot="dashboard-spend-v2"
                w={1672}
                h={941}
                art="room"
                alt={photoAlt["dashboard-spend-v2"]}
                sizes={SIZES}
                className="featurerow__photo"
              />
            }
          />
        </div>
      </PageSection>

      <PageSection
        eyebrow="Trade by trade"
        heading="The faults we coordinate most"
        lede="The common calls from retail and commercial sites, and how each one is handled."
      >
        <ul className="tradecards" role="list">
          {TRADE_DETAIL.map((trade) => (
            <li className="tradecard reveal" key={trade.id}>
              {TRADE_SUPPLIED[trade.id] ? (
                <div className="tradecard__photo">
                  <ApprovedPhoto
                    src={TRADE_SUPPLIED[trade.id]!.src}
                    alt={TRADE_SUPPLIED[trade.id]!.alt}
                    sizes={TRADE_SIZES}
                  />
                </div>
              ) : (
                <PhotoSlot
                  slot={TRADE_PHOTO[trade.id] ?? `trade-${trade.id}`}
                  w={600}
                  h={400}
                  art="tool"
                  alt={`${trade.label} work on a commercial site`}
                  desc={`${trade.label} work on a commercial site`}
                  sizes={TRADE_SIZES}
                  className="tradecard__photo"
                />
              )}
              <div className="tradecard__body">
                <h3 className="tradecard__title">{trade.label}</h3>
                <ul className="ticklist ticklist--compact" role="list">
                  {trade.faults.map((fault) => (
                    <li key={fault}>{fault}</li>
                  ))}
                </ul>
                <p className="tradecard__note">{trade.note}</p>
              </div>
            </li>
          ))}
        </ul>
      </PageSection>

      <WhoWeHelp copy={home.copy.whoWeHelp} />
      <ContractorChoice copy={home.copy.yourContractors} />
      <PageCta />
    </main>
  );
}
