/**
 * Marketing content — the FAQ list, copied verbatim from the legacy
 * `app/(marketing)/_sections/content.ts`.
 *
 * Only the `faq` export came across. The legacy file also carried the trades,
 * services, stages, packages, sectors and testimonials arrays, but the ported
 * section components inline that copy themselves; bringing the arrays over as
 * well would leave two sources of truth for the same words, free to drift.
 * The FAQ list has no such twin — /faqs is its only consumer, here and in the
 * FAQPage structured data on the same page.
 */

export const faq = [
  {
    "q": "Do you employ your own engineers?",
    "a": "No, and we will not pretend otherwise. Maintsupp is a coordination and control layer. We source, vet, assign and performance-manage independent trade contractors according to your portfolio, trade and region."
  },
  {
    "q": "Can you cover sites outside London?",
    "a": "Yes. Contractor depth is strongest in London and the South East, and regional coverage is mobilised for each client’s wider UK portfolio, prioritised by where your sites cluster. We will tell you plainly which regions are established and which are still being built before you commit sites."
  },
  {
    "q": "What will you not claim?",
    "a": "We do not advertise nationwide employed engineers, guaranteed same-day UK coverage or a 24/7 national team. Where dedicated coverage is still being established, urgent work is handled through controlled interim sourcing rather than left unmanaged — and we tell you which is which before you commit sites."
  },
  {
    "q": "Can we keep our current contractors?",
    "a": "Yes. Existing contractors can be retained subject to agreed onboarding, insurance, documentation and performance requirements. Plenty of clients start that way."
  },
  {
    "q": "Who pays the contractor?",
    "a": "The standard starting model is that the contractor invoices you directly for technical work, and Maintsupp invoices its coordination fee separately. Alternative arrangements need separate agreement."
  },
  {
    "q": "Do you guarantee a first-time fix?",
    "a": "No responsible provider can guarantee every fault is fixed on the first attendance. What we can do is improve the odds through better site data, photographs and asset records before anyone travels."
  },
  {
    "q": "How quickly can mobilisation begin?",
    "a": "Typically one to two weeks, depending on portfolio size, the quality of your site data, contractor coverage in your regions and any integrations required."
  },
  {
    "q": "What does it cost?",
    "a": "We do not publish fixed fees, because a small reactive-only estate and a large fully managed portfolio are not the same product. Scope and commercial terms are agreed after the portfolio review."
  },
  {
    "q": "Can store teams report jobs directly?",
    "a": "Yes. Approved users submit a structured request with site, fault type, urgency, photographs and access details. Permissions and approval rules are set during onboarding."
  }
] as const;
