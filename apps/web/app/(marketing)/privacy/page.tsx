import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  // `absolute` — the root layout's `%s | MAINTSUPP` template would otherwise
  // append the brand a second time. See the note in faqs/page.tsx.
  title: { absolute: "Privacy notice | MAINTSUPP" },
  description:
    "How Maintsupp collects, uses and retains personal data, and the rights you have under UK GDPR.",
};

/**
 * Written from the code, not from a template: it describes what the platform
 * actually does — the enquiry form, the job reporting form, evidence
 * photographs and the contractor share link.
 *
 * TWO THINGS TO KEEP TRUE.
 *
 * The processors named under "Where it is held" are the real infrastructure.
 * They changed once already (Cloudflare → Vercel/Railway/Supabase) and the
 * notice went stale silently, which is a factual misstatement to data
 * subjects rather than a cosmetic drift. If the hosting moves again, this
 * section moves with it.
 *
 * The retention periods are conventional UK practice applied on the owner's
 * instruction, not legal advice. They are stated plainly rather than left as
 * placeholders, because this page backs the consent checkbox on the portfolio
 * review form and asking somebody to consent to "[TO CONFIRM]" is worse than
 * either alternative.
 */
export default function PrivacyPage() {
  return (
    <main className="m-section">
      <div className="m-shell m-shell--narrow m-prose">
        <h1>Privacy notice</h1>
        <h2>Who we are</h2>
        <p>
          Maintsupp is a trading name of Maintauk Ltd, registered in England and
          Wales, company number 17262302. We are the data controller for the
          personal data described here. Contact us at{" "}
          <a href="mailto:info@maintsupp.com">info@maintsupp.com</a> or +44 7852
          224644.
        </p>

        <h2>What we collect, and why</h2>
        <h3>When you request a portfolio review</h3>
        <p>
          We collect your name, organisation, email address, telephone number, an
          indication of how many sites you operate and anything you choose to write
          in the free-text field. We use it to respond to your enquiry and to
          prepare a proposal.
        </p>
        <p>
          <strong>Lawful basis:</strong> legitimate interests — responding to a
          business enquiry you initiated.
        </p>

        <h3>When you report a maintenance job</h3>
        <p>
          We collect the site, your name, a contact number, a description of the
          fault, and any photographs or video you upload. Photographs may
          incidentally include people or property. We use this to coordinate the
          repair and to hold a record that the work was completed.
        </p>
        <p>
          <strong>Lawful basis:</strong> contract, where you are acting for a client
          organisation; legitimate interests otherwise.
        </p>

        <h3>When a contractor uses a job link</h3>
        <p>
          We record the name a contractor gives, the evidence uploaded, any notes,
          and the fact that the link was opened and when. We use this to verify that
          work was carried out and to close the job on documented evidence.
        </p>

        <h2>Who we share it with</h2>
        <p>
          We share the minimum necessary with the contractor attending your site.
          A contractor job link shows the site, the address, the fault and the
          reporter&rsquo;s photographs. It does not show cost, invoices, other jobs
          or any other client.
        </p>
        <p>
          Our infrastructure is provided by Vercel, which serves the website;
          Railway, which runs the application; and Supabase, which hosts the
          database and the file storage. Transactional email is sent through
          Resend. All act as processors on our instructions.
        </p>

        <h2>Where it is held</h2>
        <p>
          Data is held in the United Kingdom and the European Economic Area.
          Some processing may take place outside the UK; where it does, it is
          covered by the safeguards in each processor&rsquo;s data processing
          terms.
        </p>

        <h2>How long we keep it</h2>
        <ul>
          <li>Enquiries that do not become clients: 12 months from the last contact.</li>
          <li>Job records and evidence for active clients: for the term of the contract and 6 years afterwards, which is the period a contractual claim can be brought.</li>
          <li>Compliance certificates: for as long as they are current and 6 years afterwards, so that the safety history of a site can be evidenced.</li>
          <li>Contractor job links: expire automatically, by default after 14 days</li>
        </ul>

        <h2>Your rights</h2>
        <p>
          You have the right to ask for a copy of your data, to have it corrected,
          to have it erased, to restrict or object to how we use it, and to receive
          it in a portable form. Email{" "}
          <a href="mailto:info@maintsupp.com">info@maintsupp.com</a>.
        </p>
        <p>
          If you are unhappy with how we have handled your data you can complain to
          the Information Commissioner&rsquo;s Office at ico.org.uk.
        </p>

        <h2>Cookies</h2>
        <p>
          See our <Link href="/cookies">cookie notice</Link>.
        </p>
      </div>
    </main>
  );
}
