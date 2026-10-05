import Link from "next/link";
import { PageHero, PageSection } from "../_components/page-parts";
import {
  faqPageData,
  jsonLd,
  serviceData,
  type BreadcrumbItem,
} from "../_components/structured-data";
import { readPagePicture } from "../../lib/page-pictures-public";
import type { PagePicture } from "../../lib/page-pictures";
import { ApprovedPhoto } from "../_sections/approved-photo";
import { EMAIL, PHONE_DISPLAY, PHONE_HREF, type LandingCard, type LandingPage as Page } from "./types";

/**
 * THE ONE RENDERER FOR EVERY LONDON PAGE.
 *
 * Built from the same parts as the menu's own pages — `PageHero`, `PageSection`
 * and the classes in `page-parts.css` — so these pages add no stylesheet and no
 * client code. What differs between seventeen pages is the object they are
 * handed (`./services.ts`, `./places.ts`); what they share is here once.
 *
 * THE BUTTONS ARE A PHONE NUMBER AND AN EMAIL, NOT "BOOK A PORTFOLIO REVIEW".
 * That booking is the right ask for a buyer with thirty stores and the wrong one
 * for a shop manager with a shutter that will not close. `Analytics` already
 * reports every `tel:` and `mailto:` click as `contact_click`, so both buttons
 * are measured without anything added here.
 *
 * THE EMAIL BUTTON CARRIES A SUBJECT. The website's enquiry form has no field
 * for describing a job — it asks how many sites a portfolio has — so the email
 * is the route that lets somebody say what they need, and the subject tells the
 * inbox which page it came from.
 *
 * THE PICTURE CAN BE CHANGED FROM THE CONSOLE. Each page ships with a
 * photograph from the approved pack. An image in the media library whose title
 * is the page's address — `/london/brent-cross` — and which has alt text takes
 * its place (`app/lib/page-pictures.ts` gives the rule and the reasons). The
 * read is cached and can only ever answer "no library picture", so a page is
 * never waiting on it and never fails because of it.
 */

function mailto(subject: string): string {
  return `mailto:${EMAIL}?subject=${encodeURIComponent(subject)}`;
}

function crumbsFor(page: Page): readonly BreadcrumbItem[] {
  const trail: BreadcrumbItem[] = [
    { name: "Home", path: "/" },
    { name: "London", path: "/london" },
  ];
  if (page.kind !== "hub") trail.push({ name: page.crumb, path: page.path });
  return trail;
}

/** A card's own link, when it stands for another page. */
function CardLink({ card }: { card: LandingCard }) {
  if (!card.href) return null;
  return (
    <Link className="contactcard__link" href={card.href}>
      {card.linkLabel ?? card.title}
    </Link>
  );
}

/**
 * A library picture, in the same box the approved photograph fills. A real
 * `<img>` inside a `<picture>` — the shape `page-parts.css` positions, and the
 * one `@next/next/no-img-element` does not object to — from this app's own
 * immutable `/media/...` route, already web-sized by the upload.
 */
function LibraryPicture({ picture }: { picture: PagePicture }) {
  return (
    <picture>
      <img
        className="pagehero__photo"
        src={picture.src}
        alt={picture.alt}
        loading="eager"
        decoding="async"
        {...(picture.width && picture.height ? { width: picture.width, height: picture.height } : {})}
      />
    </picture>
  );
}

export async function LandingPage({ page }: { page: Page }) {
  const picture = await readPagePicture(page.path);
  const area = page.kind === "area" ? page.crumb : undefined;
  /* The sections after the first alternate plain and tinted, whichever of the
     optional ones a page has — so a page without steps does not put two tinted
     bands next to each other. */
  let band = 0;
  const tint = () => band++ % 2 === 0;
  return (
    <main id="top">
      <PageHero
        crumbs={crumbsFor(page)}
        eyebrow={page.eyebrow}
        title={page.h1}
        lede={page.lede}
        media={
          picture ? (
            <LibraryPicture picture={picture} />
          ) : (
            <ApprovedPhoto
              src={page.photo.src}
              alt={page.photo.alt}
              sizes="(min-width: 1024px) 600px, 100vw"
              loading="eager"
              className="pagehero__photo"
            />
          )
        }
      >
        <a className="btn btn--primary btn--lg" href={PHONE_HREF}>
          Call {PHONE_DISPLAY}
        </a>
        <a className="btn btn--ghost btn--lg" href={mailto(page.emailSubject)}>
          Email for a quote
        </a>
      </PageHero>

      <PageSection eyebrow={page.cards.eyebrow} heading={page.cards.heading} lede={page.cards.lede}>
        <ul className="factgrid factgrid--three reveal" role="list">
          {page.cards.items.map((card) => (
            <li className="factcard" key={card.title}>
              <h3 className="factcard__title">{card.title}</h3>
              <p>{card.body}</p>
              <CardLink card={card} />
            </li>
          ))}
        </ul>
      </PageSection>

      {page.places ? (
        <PageSection tint={tint()} eyebrow={page.places.eyebrow} heading={page.places.heading} lede={page.places.lede}>
          <ul className="factgrid reveal" role="list">
            {page.places.items.map((place) => (
              <li className="factcard" key={place.name}>
                <h3 className="factcard__title">{place.name}</h3>
                <p>{place.where}</p>
                {place.href ? (
                  <Link className="contactcard__link" href={place.href}>
                    {place.name}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
          {page.places.note ? <p className="featurerow__note">{page.places.note}</p> : null}
        </PageSection>
      ) : null}

      {page.steps ? (
        <PageSection tint={tint()} eyebrow={page.steps.eyebrow} heading={page.steps.heading} lede={page.steps.lede}>
          <ol className="factgrid reveal" role="list">
            {page.steps.items.map((step, index) => (
              <li className="factcard" key={step.title}>
                <span className="factcard__n">{index + 1}</span>
                <h3 className="factcard__title">{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </PageSection>
      ) : null}

      {page.points ? (
        <PageSection
          tint={tint()}
          eyebrow={page.points.eyebrow}
          heading={page.points.heading}
          lede={page.points.lede}
        >
          <div className="pagefaq reveal">
            <ul className="ticklist" role="list">
              {page.points.items.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
            {page.points.note ? <p className="featurerow__note">{page.points.note}</p> : null}
          </div>
        </PageSection>
      ) : null}

      <PageSection tint={tint()} eyebrow="Questions" heading={`${page.crumb}: what people ask`} id="faq">
        <div className="pagefaq reveal">
          {page.faqs.map((entry, index) => (
            <details key={entry.q} open={index === 0}>
              <summary>{entry.q}</summary>
              <p>{entry.a}</p>
            </details>
          ))}
        </div>
      </PageSection>

      <PageSection tint={tint()} eyebrow="Related" heading="More from MAINTSUPP in London">
        <p className="contactcard__links reveal">
          {page.related.map((link) => (
            <Link className="contactcard__link" href={link.href} key={link.href}>
              {link.label}
            </Link>
          ))}
        </p>
      </PageSection>

      <section className="section section--dark pagecta">
        <div className="wrap pagecta__inner reveal">
          <div>
            <p className="eyebrow">Next step</p>
            <h2 className="h2">{page.cta.heading}</h2>
            <p className="lede">{page.cta.lede}</p>
          </div>
          <div className="pagecta__actions">
            <a className="btn btn--primary btn--lg" href={PHONE_HREF}>
              Call {PHONE_DISPLAY}
            </a>
            <a className="btn btn--outline btn--lg" href={mailto(page.emailSubject)}>
              Email for a quote
            </a>
          </div>
        </div>
      </section>

      {/* The page's own service and its own questions. The Organization is not
          restated: `provider` points at the homepage's by `@id`. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd({
            "@context": "https://schema.org",
            "@graph": [
              serviceData({
                path: page.path,
                name: page.h1,
                serviceType: page.serviceType,
                description: page.description,
                area,
                place: page.place,
              }),
              faqPageData(page.path, page.faqs),
            ],
          }),
        }}
      />
    </main>
  );
}
