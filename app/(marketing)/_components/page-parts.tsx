import Link from "next/link";
import type { ReactNode } from "react";
import { Breadcrumbs } from "./breadcrumbs";
import type { BreadcrumbItem } from "./structured-data";
import { BOOKING_IS_EXTERNAL, BOOKING_URL } from "../_sections/content";
import pagePartsCss from "./page-parts.css?url";

/**
 * THE PIECES EVERY STANDALONE MARKETING PAGE IS BUILT FROM.
 *
 * Services, How It Works, Pricing, Case Study and Contact were anchors on the
 * homepage; each is now a page of its own, reached from the header and the
 * phone menu. They share one shape — a banner with the page's single <h1> and a
 * photograph, the homepage section that already says the thing, the detail the
 * homepage had no room for, and one closing call to action — so that shape
 * lives here once rather than five times.
 *
 * Deliberately NOT under `_sections/`: `tests/stage-twelve-images.test.mjs`
 * pins exactly which section files draw photographs. A page passes its
 * photograph in as `media`, drawn by the existing `PhotoSlot` or
 * `ApprovedPhoto`, so every picture still goes through the responsive pipeline
 * and the alt-text registry those two enforce.
 */

export function PageHero({
  crumbs,
  eyebrow,
  title,
  lede,
  media,
  children,
}: {
  crumbs: readonly BreadcrumbItem[];
  eyebrow: string;
  title: string;
  lede: string;
  /** The banner photograph, already rendered. */
  media: ReactNode;
  /** Optional buttons under the lede. */
  children?: ReactNode;
}) {
  return (
    <section className="section pagehero">
      {/* Every one of these pages opens with this banner, so the pages' own
          stylesheet is linked here once — see the head of page-parts.css. */}
      <link rel="stylesheet" href={pagePartsCss} />
      <div className="wrap pagehero__grid">
        <div className="pagehero__text">
          <Breadcrumbs items={crumbs} />
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="h1 pagehero__title">{title}</h1>
          <p className="lede">{lede}</p>
          {children ? <div className="pagehero__actions">{children}</div> : null}
        </div>
        <div className="pagehero__media">{media}</div>
      </div>
    </section>
  );
}

/** The two buttons a banner offers: book the review, or get in touch. */
export function HeroActions({ secondary = { href: "/contact", label: "Contact us" } }: {
  secondary?: { href: string; label: string };
}) {
  return (
    <>
      <BookingButton className="btn btn--primary btn--lg" />
      <Link className="btn btn--ghost btn--lg" href={secondary.href}>
        {secondary.label}
      </Link>
    </>
  );
}

export function BookingButton({ className, label = "Book a Portfolio Review" }: { className: string; label?: string }) {
  return (
    <a
      className={className}
      href={BOOKING_URL}
      {...(BOOKING_IS_EXTERNAL ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {label}
    </a>
  );
}

/** A plain section with the eyebrow-and-heading opening every section uses. */
export function PageSection({
  eyebrow,
  heading,
  lede,
  tint = false,
  id,
  children,
}: {
  eyebrow: string;
  heading: string;
  lede?: string;
  tint?: boolean;
  id?: string;
  children: ReactNode;
}) {
  return (
    <section className={`section${tint ? " section--tint" : ""}`} id={id}>
      <div className="wrap">
        <div className="reveal">
          <p className="eyebrow">{eyebrow}</p>
          <h2 className="h2">{heading}</h2>
          {lede ? <p className="lede">{lede}</p> : null}
        </div>
        {children}
      </div>
    </section>
  );
}

/**
 * One row of a feature list: a photograph on one side, a heading, a paragraph
 * and a ticked list on the other. Rows alternate sides on wide screens and
 * stack on a phone.
 */
export function FeatureRow({
  media,
  title,
  body,
  points,
  note,
}: {
  media: ReactNode;
  title: string;
  body: string;
  points?: readonly string[];
  note?: string;
}) {
  return (
    <article className="featurerow reveal">
      <div className="featurerow__media">{media}</div>
      <div className="featurerow__text">
        <h3 className="featurerow__title">{title}</h3>
        <p>{body}</p>
        {points?.length ? (
          <ul className="ticklist" role="list">
            {points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        ) : null}
        {note ? <p className="featurerow__note">{note}</p> : null}
      </div>
    </article>
  );
}

/** The closing band on every page but Contact, which IS the form. */
export function PageCta({
  heading = "Want to see how this would run across your sites?",
  lede = "Book a free portfolio review — 30 minutes, no obligation. Or tell us what you need and we will come back to you.",
}: {
  heading?: string;
  lede?: string;
}) {
  return (
    <section className="section section--dark pagecta">
      <div className="wrap pagecta__inner reveal">
        <div>
          <p className="eyebrow">Next step</p>
          <h2 className="h2">{heading}</h2>
          <p className="lede">{lede}</p>
        </div>
        <div className="pagecta__actions">
          <BookingButton className="btn btn--primary btn--lg" />
          <Link className="btn btn--outline btn--lg" href="/contact">
            Contact us
          </Link>
        </div>
      </div>
    </section>
  );
}
