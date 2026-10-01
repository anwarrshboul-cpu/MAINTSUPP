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

const TITLE = "Contact Us";
const DESCRIPTION =
  "Contact Maintsupp about multi-site maintenance coordination: book a free 30-minute portfolio review, call, email, or send an enquiry. Existing clients can report a job.";

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
            src="/assets/workflow/how-it-works-07-reporting-v3.png"
            alt="Two colleagues reviewing a performance dashboard on a large monitor"
            sizes="(min-width: 1024px) 560px, 100vw"
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
            <p>Speak to us directly, Monday to Friday, 8:30am to 5:30pm.</p>
            <a className="contactcard__link" href="tel:+447852224644">
              +44 7852 224644
            </a>
          </li>
          <li className="contactcard">
            <h3 className="contactcard__title">Email</h3>
            <p>Send details of your portfolio and what you need, and we will come back to you.</p>
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
