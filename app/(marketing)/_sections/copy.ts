/**
 * THE BUILT-IN PAGES' COPY, AS DATA — decision L.
 *
 * Every word on this page used to be a literal inside the component that drew
 * it. It is the same copy, in the same order, moved here so that ONE resolver
 * can decide what a section says: the value MAINTSUPP staff saved, or — when
 * they have saved nothing — exactly this. There is no second renderer and no
 * second copy of the design: the components below still own the markup, and
 * read their words from the object they are handed.
 *
 * THIS IS WHY THE SITE CANNOT GO EMPTY. The CMS tables start empty and may stay
 * empty for ever; the page then renders this file, which is the page as it
 * shipped. A stored value is an OVERRIDE of one field, never a replacement of
 * the page.
 *
 * It stays inside `app/(marketing)` deliberately: three test files walk this
 * tree for the copy rules the brief forbids (the six phrases, the VAT
 * qualifiers, a price outside `pricing.tsx`), and copy that left the tree would
 * leave those rules covering nothing. `CONTENT_RULES` in `app/lib/cms-blocks.ts`
 * applies the same rules to anything staff save.
 *
 * A PLAIN MODULE, not a "use client" one: the sections are client components and
 * the content registry (`app/lib/site-content.ts`) is server code, and both read
 * these defaults. A value exported from a "use client" file is a client
 * reference on the server, which is the trap `app/lib/site-navigation.ts`
 * records.
 */

export const HOME_COPY = {
  /* Hero */
  hero: {
    kicker: "Commercial maintenance across the UK",
    titleLead: "Multi-site commercial maintenance,",
    titleAccent: "managed through one point of contact.",
    lede: "Maintsupp coordinates reactive repairs, planned maintenance and compliance services for retailers and commercial operators across the UK — through one managed contact and a vetted contractor network.",
    pills: [
      "Vetted UK contractor network",
      "Evidence-based close-out",
      "21 stores currently coordinated"
    ],
    bookLabel: "Book a Portfolio Review",
    reportLabel: "Report a Job",
  },

  /* Who we help */
  whoWeHelp: {
    eyebrow: "Who we help",
    heading: "Built for multi-site operators without an in-house FM team.",
    note: "Typically 5–50 locations spread across regions — managed today through scattered calls and spreadsheets.",
  },

  /* Services */
  services: {
    eyebrow: "What we offer",
    heading: "If it breaks at a commercial site, we coordinate the repair.",
    faultsHeading: "Faults we handle most",
  },

  /* The operating problem */
  problem: {
    eyebrow: "The operating problem",
    heading: "Stop managing maintenance through scattered calls and spreadsheets.",
  },

  /* What this replaces */
  replaces: {
    eyebrow: "What this replaces",
    heading: "One coordination layer instead of six half-jobs.",
    lede: "Maintsupp is not another system to keep up to date alongside the ones you already have. It takes over the work those were standing in for.",
  },

  /* How it works */
  how: {
    eyebrow: "How it works",
    heading: "When something breaks, one coordinator owns it until it’s verified complete.",
    lede: "Follow every job from report to result — reporting, assignment, tracking and analysis in one place. Step through the seven stages to see who does what and what the system records.",
  },

  /* Your contractors or ours */
  yourContractors: {
    eyebrow: "Your contractors or ours",
    heading: "Keep the trades you trust. Use ours for the rest.",
    lede: "Coming to Maintsupp does not mean replacing your contractors. Bring the ones who already know your sites, use our vetted panel where you have no cover, and run both through one process — with one report at the end of the month.",
  },

  /* Pricing */
  pricing: {
    eyebrow: "Pricing",
    heading: "Simple per-store pricing. No hidden markups.",
    lede: "Contractors invoice you directly at their agreed rates — we never mark up trades. You pay one clear coordination fee.",
  },

  /* Case study */
  caseStudy: {
    eyebrow: "Case study",
    heading: "21 stores. One point of contact.",
    lede: "A UK fragrance retailer with 21 stores and kiosks needed one accountable contact for every repair, compliance date and store project. Maintsupp runs intake and triage, assigns vetted contractors, chases attendance, verifies completion with photo evidence, and reports monthly on jobs, spend and compliance status.",
  },

  /* Who runs Maintsupp */
  founder: {
    heading: "Who runs Maintsupp",
    lede: "Maintsupp is founder-led. Anwar has over five years’ experience in facilities management for commercial stores across the UK — intake, triage, contractor management and verified close-out, day in, day out. Every client portfolio gets one named coordinator who owns each job until it’s verified complete. You deal with a person accountable for the outcome, not a ticket queue.",
  },

  /* Client portal */
  portal: {
    eyebrow: "Client portal",
    heading: "Total visibility. Total control.",
    lede: "Authorised users see live jobs, compliance dates, approvals, spend and evidence across their permitted sites — and nothing from anyone else’s portfolio.",
    promise: "Every client gets portfolio visibility — no spreadsheets, no chasing for updates.",
  },

  /* Questions */
  faq: {
    eyebrow: "Straight answers",
    heading: "Frequently asked questions",
    lede: "The questions we are asked before every portfolio review, answered the way we answer them on the call.",
  },

  /* Contact and booking */
  finalCta: {
    eyebrow: "Contact us or book a portfolio review",
    heading: "Not sure where your maintenance is leaking time and money?",
    lede: "Book a free portfolio review — 30 minutes, no obligation. Or use the same form to tell us what you need.",
    note: "Best suited to multi-site commercial operators seeking ongoing coordination rather than one-off domestic repairs.",
  },
  /* Report a Job — the form section's own heading and eyebrow. Its intro line
     stays in the component because it carries markup (the required-field
     asterisk), and a field here is a string, never markup; the eleven FIELDS and
     their labels stay there too, because they are a form and not copy. */
  reportJob: {
    eyebrow: "Report a job",
    heading: "Report a Job",
  },
} as const;

export type HomeCopy = typeof HOME_COPY;

/* ------------------------------------------------------------------ */
/* The other two marketing pages                                       */
/* ------------------------------------------------------------------ */

/**
 * `/contractors` and `/faqs`, in the same shape and for the same reason as
 * `HOME_COPY` above. Their questions are NOT here: `/faqs` and the homepage's
 * FAQ section share the `faq` array in `content.ts`, and the resolver overlays
 * saved questions on THAT — one list, still shared, still the source of the
 * FAQPage structured data.
 *
 * The three legal pages are deliberately absent. Their text is a notice pending
 * legal review (`privacy` and `terms` say so at the top of the file), their
 * titles are part of what they legally are, and
 * `tests/marketing-canonicals.test.mjs` pins those names after a live defect.
 * Nothing about them is editable from the console; they change in code, with
 * review, as they always have.
 */
export const PAGE_COPY = {
  contractors: {
    eyebrow: "Contractor network",
    heading: "Join the Maintsupp contractor network",
    lede: "Maintsupp coordinates maintenance across multi-site commercial portfolios in the UK and allocates work to vetted independent contractors. We look for insured, competent trades who work to a documented evidence standard — before and after photos, reports and certificates on every job. Apply below. Approval requires document checks before any work is assigned.",
  },
  faqs: {
    eyebrow: "Straight answers",
    heading: "Frequently asked questions",
  },
} as const;

export type PageCopy = typeof PAGE_COPY;

/* ------------------------------------------------------------------ */
/* What each page tells a search engine                                */
/* ------------------------------------------------------------------ */

/**
 * THE TITLE AND THE DESCRIPTION ONLY.
 *
 * Everything else a crawler reads stays in code and cannot be edited: the
 * canonical (each page names its own address — four pages once told Google they
 * were the homepage, which is what `tests/marketing-canonicals.test.mjs` exists
 * to stop), `robots`, the OpenGraph url, siteName, locale and type, the sitemap,
 * and the structured-data graph. A CMS that could change those could take the
 * site out of the index; one that can only change a title and a sentence cannot.
 *
 * NO " | MAINTSUPP" IN ANY OF THESE, and none may be saved either — the root
 * layout's template is `%s | MAINTSUPP` and adds it once. `/contractors` is the
 * exception that opts OUT of the template (`title: { absolute }`) because the
 * brief specifies its title exactly, so its stored title is used exactly too.
 *
 * `socialDescription` is the homepage's shorter OpenGraph line, kept apart
 * because it is the one that shows in a shared link. When staff change the
 * description and not this, the shared line stays as it shipped.
 */
export const SEO_COPY = {
  home: {
    title: "Maintsupp — Multi-Site Commercial Maintenance Coordination, UK",
    description: "One point of contact for reactive repairs, planned maintenance and compliance across your retail or commercial portfolio. Vetted UK contractor network, verified close-outs, per-store pricing.",
    socialDescription: "One point of contact for reactive repairs, planned maintenance and compliance across your retail or commercial portfolio.",
  },
  contractors: {
    title: "Join the Contractor Network — Maintsupp",
    description: "Maintsupp allocates multi-site commercial maintenance to vetted independent contractors across the UK. Apply to join the network.",
  },
  faqs: {
    title: "FAQs",
    description: "Straight answers to the questions operations teams ask about maintenance coordination, contractor management and compliance.",
  },
} as const;

export type SeoCopy = typeof SEO_COPY;
