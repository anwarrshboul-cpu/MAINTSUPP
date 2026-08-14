import type { Metadata } from "next";
import { faq } from "../_sections/content";

export const metadata: Metadata = {
  title: "FAQs | MAINTSUPP",
  description:
    "Straight answers to the questions operations teams ask about maintenance coordination, contractor management and compliance.",
};

export default function FaqsPage() {
  return (
    <main className="m-section">
      <div className="m-shell m-shell--narrow">
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
