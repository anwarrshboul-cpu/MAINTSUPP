import type { Metadata } from "next";

export const metadata: Metadata = {
  // `absolute` — the root layout's `%s | MAINTSUPP` template would otherwise
  // append the brand a second time. See the note in faqs/page.tsx.
  title: { absolute: "Cookies | MAINTSUPP" },
  description: "What cookies and similar storage Maintsupp uses, and why.",
};

export default function CookiesPage() {
  return (
    <main className="m-section">
      <div className="m-shell m-shell--narrow m-prose">
        <h1>Cookie notice</h1>

        <h2>The short version</h2>
        <p>
          The public website sets no advertising or tracking cookies. We do not use
          Google Analytics, and we do not sell or share browsing data.
        </p>

        <h2>What is actually stored</h2>
        <ul>
          <li>
            <strong>Portfolio review draft.</strong> While you are filling in the
            enquiry form, your answers are held in your browser&rsquo;s session
            storage so a mis-tap does not lose them. It is cleared when you submit
            or close the tab, and it never leaves your device.
          </li>
          <li>
            <strong>Client portal session.</strong> If you sign in to the portal, a
            cookie identifies your session. This is necessary for the portal to work.
          </li>
        </ul>

        {/* The vendor is deliberately unnamed. This said "Cloudflare Web
            Analytics", chosen when the product ran on Cloudflare; it now runs
            on Vercel, Railway and Supabase, so naming that vendor described a
            plan nobody holds. The commitment — cookieless, no fingerprinting,
            this notice updated first — is the part that binds us, and it is
            kept. Name the vendor here once one is actually chosen. */}
        <h2>If we add analytics</h2>
        <p>
          Should we add measurement, we will use a cookieless service that does
          not fingerprint visitors, and we will name it here and update this
          notice before it is switched on.
        </p>
      </div>
    </main>
  );
}
