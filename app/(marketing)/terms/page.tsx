import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms | MAINTSUPP",
  description: "Terms of use for the Maintsupp website and client portal.",
};

/** DRAFT — REQUIRES OWNER AND LEGAL REVIEW BEFORE PUBLICATION. */
export default function TermsPage() {
  return (
    <main className="m-section">
      <div className="m-shell m-shell--narrow m-prose">
        <h1>Terms of use</h1>
        <p className="m-note">
          <strong>Draft for review.</strong> These cover use of the website and
          portal. They are not a services agreement — commercial terms are set out
          separately in each client contract.
        </p>

        <h2>Who we are</h2>
        <p>
          Maintsupp is a trading name of Maintauk Ltd, registered in England and
          Wales, company number 17262302.
        </p>

        <h2>Using the website</h2>
        <p>
          The website is provided for information. Content may change without notice.
          Nothing here forms an offer or a commitment to provide services.
        </p>

        <h2>Using the client portal</h2>
        <p>
          Portal access is granted to named users of client organisations. You are
          responsible for keeping your access secure and for activity carried out
          under your account. Do not share access with anyone outside your
          organisation.
        </p>

        <h2>Contractor job links</h2>
        <p>
          A job link grants access to one job without a login. Treat it as
          confidential: anyone holding the link can see the site details and upload
          evidence against that job. Links expire, and can be revoked at any time.
        </p>

        <h2>Work carried out by others</h2>
        <p>
          Maintsupp coordinates independent trade contractors. Technical inspection,
          testing and certification are carried out by appropriately qualified
          independent contractors, and their certificates are issued in their own
          name.
        </p>

        <h2>Governing law</h2>
        <p>
          These terms are governed by the law of England and Wales.
        </p>
      </div>
    </main>
  );
}
