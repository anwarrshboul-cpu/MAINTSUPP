import { Breadcrumbs } from "../_components/breadcrumbs";
import type { Metadata } from "next";
import { ORGANIZATION_ID, WEBSITE_ID } from "../_components/structured-data";
import { faq as SHIPPED_QUESTIONS } from "../_sections/content";
import { readPublicSiteContent } from "../../lib/site-content-public.ts";

/**
 * The title and the description staff have saved, or the shipped ones
 * (`SEO_COPY.faqs` in `_sections/copy.ts`) — decision L.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { faqs } = await readPublicSiteContent();
  return {
    /*
     * The BARE title, so the root template in `app/layout.tsx` supplies the suffix
     * once. This read `"FAQs | MAINTSUPP"`, and the template is `%s | MAINTSUPP`,
     * so the rendered title was `"FAQs | MAINTSUPP | MAINTSUPP"`.
     * `contractors/page.tsx` records the same lesson from the same cause; it needed
     * `absolute` because it wants a shape the template does not give. This page wants
     * exactly what the template gives, so it says only its own name — and a SAVED
     * title is held to the same rule by the save route, which refuses one carrying
     * the suffix.
     */
    title: faqs.seo.title,
    description: faqs.seo.description,
    /*
     * DECLARED, because the root declares one. `app/layout.tsx` sets
     * `alternates: { canonical: "/" }` and a page that declares none inherits it,
     * resolved against `metadataBase` — so this page used to emit
     * `<link rel="canonical" href="https://maintsupp.com/">` and tell every crawler
     * it was the homepage, while `public/sitemap.xml` submitted it as its own URL.
     * `tests/marketing-canonicals.test.mjs` now refuses a marketing page that
     * declares none. It is CODE, not content: no console may change it.
     */
    alternates: { canonical: "https://maintsupp.com/faqs" },
  };
}

export default async function FaqsPage() {
  const { faqs } = await readPublicSiteContent();
  const copy = faqs.copy;
  /*
   * THE QUESTIONS IN FORCE, under the name the shared array has always had here,
   * because everything below is written against it — the list and the FAQPage
   * graph alike. `SHIPPED_QUESTIONS` is the default the resolver falls back to, so
   * with nothing saved this page is what it was; with questions saved, the
   * homepage's accordion reads the SAME resolved list, which is what keeps both
   * pages and the structured data telling one story.
   */
  const faq: readonly { q: string; a: string }[] = faqs.questions.length ? faqs.questions : SHIPPED_QUESTIONS;
  return (
    <main className="m-section">
      <div className="m-shell m-shell--narrow">
          <Breadcrumbs items={[{ name: "Home", path: "/" }, { name: "FAQs", path: "/faqs" }]} />
        <p className="m-eyebrow">{copy.eyebrow}</p>
        <h1>{copy.heading}</h1>
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
