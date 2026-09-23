import { Breadcrumbs } from "../_components/breadcrumbs";
import type { Metadata } from "next";
import { ContractorApply } from "./apply-form";
import { readPublicSiteContent } from "../../lib/site-content-public.ts";

/**
 * The title and the description staff have saved, or the shipped ones
 * (`SEO_COPY.contractors`) — decision L. The canonical stays here, in code: this
 * page is `https://maintsupp.com/contractors` and nothing in a console may say
 * otherwise (`tests/marketing-canonicals.test.mjs`).
 */
export async function generateMetadata(): Promise<Metadata> {
  const { contractors } = await readPublicSiteContent();
  return {
    /* `absolute`, because the layout appends "| MAINTSUPP" to every title and the
       brief specifies this one exactly — with the suffix it read "Join the
       Contractor Network — Maintsupp | MAINTSUPP". A saved title is used exactly
       as saved for the same reason; the save route refuses one carrying the
       suffix, so it cannot be doubled by hand either. */
    title: { absolute: contractors.seo.title },
    description: contractors.seo.description,
    alternates: { canonical: "https://maintsupp.com/contractors" },
  };
}

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
export default async function ContractorsPage() {
  const { contractors } = await readPublicSiteContent();
  const copy = contractors.copy;
  return (
    <main id="top">
      <section className="section">
        <div className="wrap wrap--narrow">
          <Breadcrumbs items={[{ name: "Home", path: "/" }, { name: "Contractor network", path: "/contractors" }]} />
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1 className="h1">{copy.heading}</h1>
          <p className="lede">{copy.lede}</p>
          <ContractorApply />
        </div>
      </section>
    </main>
  );
}
