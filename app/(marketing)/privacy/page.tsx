import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy notice | MAINTSUPP",
  description:
    "How Maintsupp collects, uses and retains personal data, and the rights you have under UK GDPR.",
};

/**
 * DRAFT — REQUIRES OWNER REVIEW BEFORE PUBLICATION.
 *
 * This covers what the platform actually does today: the enquiry form, the job
 * reporting form, evidence photographs and the contractor link. It is written
 * from the code, not from a template, but it is not legal advice and the
 * retention periods in particular are placeholders the owner must confirm.
 */
export default function PrivacyPage() {
  return (
    <main className="m-section">
      <div className="m-shell m-shell--narrow m-prose">
        <h1>Privacy notice</h1>
        <p className="m-note">
          <strong>Draft for review.</strong> Retention periods marked
          [TO CONFIRM] must be agreed before this is published.
        </p>

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
          Our infrastructure is provided by Cloudflare, which hosts the application,
          the database and the file storage. Transactional email is sent through
          Resend. Both act as processors on our instructions.
        </p>

        <h2>Where it is held</h2>
        <p>
          Data is held on Cloudflare infrastructure. Some processing may take place
          outside the UK; where it does, it is covered by the safeguards in
          Cloudflare&rsquo;s data processing terms.
        </p>

        <h2>How long we keep it</h2>
        <ul>
          <li>Enquiries that do not become clients: [TO CONFIRM — suggested 12 months]</li>
          <li>Job records and evidence for active clients: for the term of the contract plus [TO CONFIRM]</li>
          <li>Compliance certificates: for as long as they are current, plus [TO CONFIRM]</li>
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
