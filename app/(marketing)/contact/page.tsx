import type { Metadata } from "next";
import Link from "next/link";
import { BookingButton, PageHero, PageSection } from "../_components/page-parts";
import { ApprovedPhoto } from "../_sections/approved-photo";
import { FinalCta, TrustStrip } from "../_sections/final-cta";
import { readPublicSiteContent } from "../../lib/site-content-public.ts";
import { pageSocial } from "../../lib/page-social";

/**
 * /contact — every way to reach Maintsupp, and the enquiry form.
 *
 * Was the `#contact` anchor on the homepage. The form is the homepage's own
 * `FinalCta` — the same fields, the same `/api/leads` endpoint and the same
 * privacy wording — so an enquiry sent from here and one sent from the homepage
 * arrive identically. The phone number, email and hours are the footer's fixed
 * particulars (`FIXED_CHROME` in `app/lib/site-navigation.ts` says why they are
 * not editable), repeated here because a contact page that hid them behind a
 * form would be the wrong page.
 */

/* "24/7 Line" alone read as a line for the whole UK. The emergency line is
   London only, so the title says where; "Plans" is the portfolio review this
   page books. */
const TITLE = "Contact Us: Quotes, Plans & London 24/7 Line";
const DESCRIPTION =
  "Contact MAINTSUPP: call 07852 224644 at any hour for an emergency in London, email for a one-off quote, or book a free 30-minute portfolio review.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "https://maintsupp.com/contact" },
  ...pageSocial("/contact", TITLE, DESCRIPTION),
};

export default async function ContactPage() {
  const { home } = await readPublicSiteContent();
  return (
    <main id="top">
      <PageHero
        crumbs={[{ name: "Home", path: "/" }, { name: "Contact Us", path: "/contact" }]}
        eyebrow="Contact us"
        title="Talk to the person who will run your maintenance"
        lede="Book a free 30-minute portfolio review, call or email us, or send an enquiry below. We reply within one working day."
        media={
          <ApprovedPhoto
            src="/assets/pages/page-contact-hero-v1.jpg"
            alt="A smiling Maintsupp coordinator in a headset taking notes at a bright office desk"
            sizes="(min-width: 1024px) 600px, 100vw"
            loading="eager"
            className="pagehero__photo"
          />
        }
      >
        <BookingButton className="btn btn--primary btn--lg" />
        <a className="btn btn--ghost btn--lg" href="#contact">
          Send an enquiry
        </a>
      </PageHero>

      <PageSection tint eyebrow="Ways to reach us" heading="Choose whatever suits you">
        <ul className="contactcards reveal" role="list">
          <li className="contactcard">
            <h3 className="contactcard__title">Call</h3>
            <p>
              Speak to us directly, Monday to Friday, 8:30am to 5:30pm. For an emergency at a
              commercial site in London, call at any hour.
            </p>
            <a className="contactcard__link" href="tel:+447852224644">
              +44 7852 224644
            </a>
          </li>
          <li className="contactcard">
            <h3 className="contactcard__title">Email</h3>
            <p>Send details of the job or of your portfolio, and we will come back to you.</p>
            <a className="contactcard__link" href="mailto:info@maintsupp.com">
              info@maintsupp.com
            </a>
          </li>
          <li className="contactcard">
            <h3 className="contactcard__title">Already a client?</h3>
            <p>Report a fault at one of your sites, or sign in to follow your jobs in the portal.</p>
            <span className="contactcard__links">
              <Link className="contactcard__link" href="/#report">
                Report a job
              </Link>
              <Link className="contactcard__link" href="/portal">
                Portal login
              </Link>
            </span>
          </li>
          <li className="contactcard">
            <h3 className="contactcard__title">Contractors</h3>
            <p>Insured, competent trades can apply to join the Maintsupp contractor network.</p>
            <Link className="contactcard__link" href="/contractors">
              Apply to join
            </Link>
          </li>
        </ul>
      </PageSection>

      <TrustStrip />
      <FinalCta copy={home.copy.finalCta} />
    </main>
  );
}
