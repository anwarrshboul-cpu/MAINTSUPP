import { Breadcrumbs } from "../_components/breadcrumbs";
import type { Metadata } from "next";
import { ORGANIZATION_ID, WEBSITE_ID } from "../_components/structured-data";
import { faq } from "../_sections/content";

export const metadata: Metadata = {
  /*
   * The BARE title, so the root template in `app/layout.tsx` supplies the suffix
   * once. This read `"FAQs | MAINTSUPP"`, and the template is `%s | MAINTSUPP`,
   * so the rendered title was `"FAQs | MAINTSUPP | MAINTSUPP"`.
   * `contractors/page.tsx` records the same lesson from the same cause; it needed
   * `absolute` because it wants a shape the template does not give. This page wants
   * exactly what the template gives, so it says only its own name.
   */
  title: "FAQs",
  description:
    "Straight answers to the questions operations teams ask about maintenance coordination, contractor management and compliance.",
  /*
   * DECLARED, because the root declares one. `app/layout.tsx` sets
   * `alternates: { canonical: "/" }` and a page that declares none inherits it,
   * resolved against `metadataBase` — so this page used to emit
   * `<link rel="canonical" href="https://maintsupp.com/">` and tell every crawler
   * it was the homepage, while `public/sitemap.xml` submitted it as its own URL.
   * `tests/marketing-canonicals.test.mjs` now refuses a marketing page that
   * declares none.
   */
  alternates: { canonical: "https://maintsupp.com/faqs" },
};

export default function FaqsPage() {
  return (
    <main className="m-section">
      <div className="m-shell m-shell--narrow">
          <Breadcrumbs items={[{ name: "Home", path: "/" }, { name: "FAQs", path: "/faqs" }]} />
        <p className="m-eyebrow">Straight answers</p>
        <h1>Frequently asked questions</h1>
        <div className="m-faq m-faq--static">
          {faq.map((entry) => (
            <article key={entry.q}>
              <h2>{entry.q}</h2>
              <p>{entry.a}</p>
            </article>
          ))}
        </div>
      </div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "@id": "https://maintsupp.com/faqs#faq",
            url: "https://maintsupp.com/faqs",
            inLanguage: "en-GB",
            publisher: { "@id": ORGANIZATION_ID },
            isPartOf: { "@id": WEBSITE_ID },
            mainEntity: faq.map((entry) => ({
              "@type": "Question",
              name: entry.q,
              acceptedAnswer: { "@type": "Answer", text: entry.a },
            })),
          }),
        }}
      />
    </main>
  );
}
