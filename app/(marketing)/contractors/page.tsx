import type { Metadata } from "next";
import { ContractorApply } from "./apply-form";

export const metadata: Metadata = {
  /* `absolute`, because the layout appends "| MAINTSUPP" to every title and the
     brief specifies this one exactly — with the suffix it read "Join the
     Contractor Network — Maintsupp | MAINTSUPP". */
  title: { absolute: "Join the Contractor Network — Maintsupp" },
  description:
    "Maintsupp allocates multi-site commercial maintenance to vetted independent contractors across the UK. Apply to join the network.",
  alternates: { canonical: "https://www.maintsupp.com/contractors" },
};

/**
 * The public contractor application page.
 *
 * Linked from the footer only. The top nav is for the people the site is
 * selling to, and a contractor looking for work is not that reader — so the
 * page exists, is indexable, and is reached deliberately rather than competing
 * for attention with "Book a Portfolio Review".
 *
 * Header and footer come from the marketing layout, so this file is the page's
 * own content and nothing else.
 */
export default function ContractorsPage() {
  return (
    <main id="top">
      <section className="section">
        <div className="wrap wrap--narrow">
          <p className="eyebrow">Contractor network</p>
          <h1 className="h1">Join the Maintsupp contractor network</h1>
          <p className="lede">
            Maintsupp coordinates maintenance across multi-site commercial portfolios in
            the UK and allocates work to vetted independent contractors. We look for
            insured, competent trades who work to a documented evidence standard — before
            and after photos, reports and certificates on every job. Apply below. Approval
            requires document checks before any work is assigned.
          </p>
          <ContractorApply />
        </div>
      </section>
    </main>
  );
}
