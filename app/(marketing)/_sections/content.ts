/**
 * Marketing content — Stage 11, Group B.
 *
 * Ported verbatim from the JS data arrays inside the old public/landing.html.
 * The copy is the client's own and was not rewritten: the point of this stage
 * is to make it indexable, not to change what it says.
 */

/**
 * WHERE "Book a Portfolio Review" GOES.
 *
 * The hero CTA and the final CTA panel both open this, in a new tab. It is
 * here rather than typed into each of them because two copies of a booking
 * link is one copy that can be changed and one that cannot, and the one left
 * behind sends people to a calendar that is no longer being read.
 *
 * The on-page enquiry form is deliberately still there as the fallback for
 * anyone who would rather write than book a slot.
 */
import { MANAGED_PLAN_MINIMUM_SITES, TERMS, inWords } from "./rates";

/*
 * THE BOOKING DESTINATION, WITH THE SLUG THAT ACTUALLY EXISTS.
 *
 * This was `https://cal.com/maintsupp/portfolio-review`, which 404s: the real
 * event on the maintsupp Cal.com account is
 * `portfolio-review-30-minutes` — "Portfolio Review — 30 minutes", 30m, Cal
 * Video, Europe/London, booking into anwar@maintsupp.com. Every CTA on the
 * site sent a visitor who had already decided to talk to a dead Cal.com page,
 * because the slug was typed here from memory and nothing checked it.
 *
 * It is read from `NEXT_PUBLIC_BOOKING_URL` when that is set, so renaming the
 * event or moving to another calendar is a deployment variable rather than a
 * release — the failure above is exactly what a hard-coded URL costs.
 */
export const BOOKING_URL =
  process.env.NEXT_PUBLIC_BOOKING_URL?.trim() ||
  "https://cal.com/maintsupp/portfolio-review-30-minutes";

export const BOOKING_IS_EXTERNAL = /^https?:\/\//i.test(BOOKING_URL);

export const trades = [
  {
    "id": "electrical",
    "label": "Electrical & Lighting",
    "faults": [
      "Lighting circuit tripping",
      "No power to a till bank or zone",
      "Emergency lighting failure",
      "Distribution board alarm",
      "External sign not illuminating"
    ],
    "note": "Fixed-wire testing and certification are carried out by qualified electrical contractors — we schedule and record them."
  },
  {
    "id": "doors",
    "label": "Doors & Shutters",
    "faults": [
      "Roller shutter jammed or off track",
      "Automatic door not closing",
      "Fire door closer failed",
      "Lock or access control fault",
      "Barrier or gate damage"
    ],
    "note": "A shutter that will not close is a security and trading issue — these are triaged as P1 or P2 by default."
  },
  {
    "id": "leaks",
    "label": "Leaks & Drainage",
    "faults": [
      "Leak above a customer area",
      "WC or urinal blockage",
      "No hot water",
      "Drain smell in back of house",
      "Roof or gutter water ingress"
    ],
    "note": "Water near electrics escalates automatically. Make-safe first, permanent repair scheduled after."
  },
  {
    "id": "hvac",
    "label": "Heating & Air Con",
    "faults": [
      "Air conditioning not cooling",
      "Heating not reaching set point",
      "Condensate leak from a cassette",
      "Ventilation fan noise",
      "AHU filter alarm"
    ],
    "note": "Recurring HVAC faults are flagged for a planned intervention rather than repeated call-outs."
  },
  {
    "id": "cctv",
    "label": "CCTV & Security",
    "faults": [
      "Camera offline or no recording",
      "Access control fault",
      "Intruder alarm activation",
      "Intercom or entry fault",
      "Damaged security fixture"
    ],
    "note": "Security faults are coordinated with your own security provider where one is contracted."
  },
  {
    "id": "fabric",
    "label": "Fabric & Finishes",
    "faults": [
      "Ceiling tile water damage",
      "Flooring lifting at an entrance",
      "Damaged wall or counter finish",
      "Broken shelf or fixture bracket",
      "Graffiti to the shopfront"
    ],
    "note": "Cosmetic works are usually batched into a planned visit to avoid paying multiple call-out charges."
  },
  {
    "id": "refrigeration",
    "label": "Refrigeration",
    "faults": [
      "Display chiller running warm",
      "Freezer icing up",
      "Cabinet door seal failure",
      "Condenser fan fault",
      "Temperature alarm"
    ],
    "note": "Stock-at-risk faults are treated as P1 regardless of trading impact."
  },
  {
    "id": "signage",
    "label": "Signage & Glazing",
    "faults": [
      "Cracked or broken glazing",
      "Fascia sign panel damage",
      "Illumination failure to signage",
      "Window film or vinyl damage",
      "Shopfront impact damage"
    ],
    "note": "Broken glazing gets a make-safe attendance first, with permanent replacement scheduled after survey."
  }
] as const;

export const services = [
  {
    "id": "reactive",
    "label": "Reactive Maintenance",
    "slot": "service-reactive",
    "alt": "Engineer attending a fault on a commercial site",
    "heading": "When something breaks, one coordinator owns it until it is verified complete.",
    "body": "We receive the request, confirm priority and access, coordinate a suitable contractor, follow attendance and check the evidence before closure.",
    "list": [
      "Structured intake with site, photos, urgency and access",
      "Priority set at triage — P1 to P3 plus compliance",
      "Quote and variation approvals against agreed limits",
      "Before and after evidence at close-out",
      "Cost reconciled against the approved quote"
    ]
  },
  {
    "id": "planned",
    "label": "Planned & PPM",
    "slot": "service-planned",
    "alt": "Planned service visit — engineer with a checklist or servicing plant",
    "heading": "Plan recurring maintenance before faults become urgent.",
    "body": "Planned visits, reminders, contractor attendance, asset records and follow-up, so recurring requirements never depend on one person’s calendar.",
    "list": [
      "Site and asset register built during mobilisation",
      "90/60/30-day reminders or your own lead times",
      "Contractor booking, permits and access confirmed",
      "Asset history: last service, next due, parts fitted",
      "Recommendations tracked as remedial actions"
    ]
  },
  {
    "id": "compliance",
    "label": "Compliance",
    "slot": "service-compliance",
    "alt": "Fire alarm panel, emergency lighting test or certificate paperwork",
    "heading": "Keep recurring compliance visible before it becomes overdue.",
    "body": "We maintain the administrative control layer: responsibility mapping, due dates, competent-provider bookings, certificate capture and remedial tracking.",
    "list": [
      "Responsibility recorded per site — client, landlord or centre",
      "Requirements register maintained per site and asset",
      "Competent-provider qualification checks",
      "Certificates captured with expiry tracked",
      "Remedials converted to actions with owner and deadline"
    ]
  },
  {
    "id": "projects",
    "label": "Projects & Store Works",
    "slot": "service-projects",
    "alt": "Store fit-out or kiosk installation in progress",
    "heading": "Coordinate site works through one project owner and one evidence trail.",
    "body": "Scope, contractors, shopping-centre permits, RAMS, access, logistics, attendance and close-out for agreed commercial site projects.",
    "list": [
      "Scope development with drawings, surveys and exclusions",
      "Permits, RAMS and access windows arranged",
      "Multiple trades sequenced with dependencies",
      "Live action, owner, date and risk tracking",
      "Handover with snagging, certificates and final cost"
    ]
  }
] as const;

export const stages = [
  {
    "name": "Report",
    "heading": "Logged with the detail that matters",
    "body": "The site logs the requirement with location, photographs, urgency and access information. A reference is issued immediately.",
    "you": "You tell us what, where and how urgent.",
    "records": "Ticket created with reference and timestamp.",
    "alt": "Store manager photographing a fault on a phone"
  },
  {
    "name": "Triage",
    "heading": "Priority set by someone accountable",
    "body": "Priority, safety implications, access restrictions and the next action are assessed against the agreed framework — not by whoever shouts loudest.",
    "you": "We confirm priority, trading impact and trade.",
    "records": "Priority confirmed and route decided.",
    "alt": "Coordinator at a desk reviewing incoming jobs"
  },
  {
    "name": "Approve",
    "heading": "Spend confirmed against agreed limits",
    "body": "Scope, quote and spend are checked against your approval thresholds before anyone is instructed.",
    "you": "You approve quotes above the agreed threshold.",
    "records": "Decision, approver and timestamp recorded.",
    "alt": "Manager approving a quote on a laptop or tablet"
  },
  {
    "name": "Assign",
    "heading": "The right contractor, properly briefed",
    "body": "A vetted contractor is selected by trade, region, availability and suitability, and issued a work order with scope, access and evidence conditions.",
    "you": "Nothing — this is ours to run.",
    "records": "Contractor, target date and work-order reference.",
    "alt": "Contractor receiving a work order, van or toolbag visible"
  },
  {
    "name": "Attend",
    "heading": "On site, with the context they need",
    "body": "The contractor attends, resolves or makes safe, and records findings with before and after photographs.",
    "you": "Site provides access as arranged.",
    "records": "Attendance time and findings logged.",
    "alt": "Engineer working on site in a commercial unit"
  },
  {
    "name": "Verify",
    "heading": "Closed on evidence, not assurance",
    "body": "Evidence, certificates, costs and completion details are checked before the job is allowed to close.",
    "you": "You can accept or query the closure.",
    "records": "Evidence accepted, job closed, cost reconciled.",
    "alt": "Completed repair being photographed and checked"
  },
  {
    "name": "Report",
    "heading": "A portfolio view you can act on",
    "body": "Live dashboard plus a monthly portfolio report covering jobs, compliance, spend, repeat faults and recommendations.",
    "you": "You review and set priorities for next month.",
    "records": "Performance measures and recommendations.",
    "alt": "Operations team reviewing a report or dashboard screen"
  }
] as const;

export const packages = [
  {
    "id": "essentials",
    "name": "Essentials",
    "price": 45,
    "audience": "A small group of sites where reactive repairs are the whole job.",
    "includes": null,
    "list": [
      "Reactive coordination, one point of contact",
      "Priority framework and agreed approval limits",
      "Photo evidence at close-out",
      "Monthly summary of jobs and spend"
    ]
  },
  {
    "id": "multisite",
    "name": "Multi-Site Managed",
    "price": 85,
    "audience": "A growing estate that needs the contractors controlled, not just called.",
    "includes": "Essentials",
    "list": [
      "Contractor vetting, documents and performance",
      "Evidence standard enforced before closure",
      "Client portal access for your team",
      "Monthly portfolio report and review"
    ]
  },
  {
    "id": "compliance",
    "name": "Compliance & PPM",
    "price": 115,
    "audience": "Estates where statutory deadlines are the real pressure point.",
    "includes": "Multi-Site Managed",
    "list": [
      "Planned maintenance schedule per site",
      "Compliance calendar with 90/60/30-day reminders",
      "Certificates captured with expiry tracked",
      "Remedial actions tracked to closure"
    ]
  },
  {
    "id": "full",
    "name": "Fully Managed Portfolio",
    "price": 165,
    "audience": "Larger portfolios handing over the whole coordination layer.",
    "includes": "Compliance & PPM",
    "list": [
      "Projects and store works coordinated",
      "Approval routes and escalation paths agreed",
      "Named coordinator and quarterly reviews",
      "Board-ready portfolio reporting"
    ]
  }
] as const;

export const sectors = [
  {
    "id": "retail",
    "label": "Retail Stores",
    "alt": "Retail store interior with shelving and lighting",
    "body": "Stores, kiosks, fragrance, beauty, jewellery and fashion portfolios where a closed door is lost trade.",
    "points": [
      "Shopfront, shutter and door faults",
      "Lighting and display electrics",
      "Air conditioning in customer areas",
      "Shopping-centre permits and access windows"
    ],
    "out": "Manufacturer-only fixture systems sit outside scope unless separately agreed."
  },
  {
    "id": "kiosks",
    "label": "Kiosks",
    "alt": "Shopping-centre kiosk or concession unit, lit",
    "body": "Concession units and kiosks inside centres and stations, where access windows are tight and permits are mandatory.",
    "points": [
      "Roller shutter and lock faults",
      "Power and lighting within the unit",
      "Signage and fascia repairs",
      "Centre permit and out-of-hours coordination"
    ],
    "out": "Centre landlord works remain the landlord’s responsibility, tracked in the matrix."
  },
  {
    "id": "commercial",
    "label": "Commercial Buildings",
    "alt": "Modern commercial office building exterior at dusk",
    "body": "Clinics, offices and hospitality groups with repeat-site portfolios and recurring compliance obligations.",
    "points": [
      "Fabric, electrical and mechanical upkeep",
      "Compliance administration per site",
      "Planned schedules and asset records",
      "Portfolio-level reporting"
    ],
    "out": "Clinical regulation and specialist medical equipment are excluded unless scoped."
  },
  {
    "id": "gyms",
    "label": "Gyms & Fitness",
    "alt": "Gym floor with equipment, wide angle, no identifiable members",
    "body": "Sites with heavy HVAC, water hygiene and fabric demand, and members on the floor all day.",
    "points": [
      "Air handling and ventilation",
      "Showers, drainage and water hygiene",
      "Flooring and fabric repairs",
      "Compliance calendar per site"
    ],
    "out": "Specialist gym equipment servicing is usually manufacturer-only and excluded."
  },
  {
    "id": "cinemas",
    "label": "Cinemas & Leisure",
    "alt": "Cinema auditorium seating facing a lit screen",
    "body": "Cinemas, bowling, family entertainment and leisure venues with long public hours and large plant.",
    "points": [
      "Plant and HVAC across large volumes",
      "Seating, fabric and finishes",
      "Fire and emergency systems",
      "Out-of-hours attendance windows"
    ],
    "out": "Projection and specialist AV equipment sit outside scope unless separately agreed."
  }
] as const;

export const testimonials = [
  {
    "quote": "Maintsupp gives us total visibility and peace of mind. One call, complete control.",
    "role": "Head of Facilities",
    "org": "Leading UK retail group",
    "slot": "testimonial-1"
  },
  {
    "quote": "The difference is that jobs actually close. We see the photographs, the certificate and the final cost before anything is signed off.",
    "role": "Operations Director",
    "org": "Multi-site leisure operator",
    "slot": "testimonial-2"
  },
  {
    "quote": "Our store managers stopped chasing contractors. That alone gave the team back most of a day a week.",
    "role": "Estates Manager",
    "org": "Franchise group",
    "slot": "testimonial-3"
  }
] as const;

export const faq = [
  {
    "q": "Do you employ your own engineers?",
    "a": "No, and we will not pretend otherwise. MAINTSUPP is a coordination and control layer. We source, vet, assign and performance-manage independent trade contractors according to your portfolio, trade and region."
  },
  {
    /* ADDED IN OCTOBER 2026, WITH THE NEXT ONE, when the owner widened the
       proposition: one-off jobs from a single shop or kiosk in London, and an
       emergency line answered at any hour. They sit second and third because
       they are now the first two things a London shop manager needs to know,
       and because the list below still said the opposite — "below five sites,
       call trades directly" — to exactly that reader. */
    "q": "Do you take one-off jobs for a single shop or kiosk?",
    /* REWORDED 2026-11-25. It ended "The monthly coordination plans are for
       portfolios of five sites and above", which made the one-off job sound
       like the exception to a subscription business. The published plans are
       withdrawn (`./rates.ts`); the one-off job is now the offer, and the
       answer says the two things that reader is checking for. */
    "a": `Yes. In London a single shop, kiosk, restaurant or office can book one job — a repair, an electrician, a kiosk install or removal, a strip-out. ${TERMS.perJob} There is no subscription and no minimum number of sites.`
  },
  {
    "q": "Do you offer 24/7 emergency call-outs?",
    "a": "Yes, for commercial premises in London. Call 07852 224644 at any hour. We tell you the price and the realistic attendance time before you commit, send a vetted contractor to make the site safe, and arrange the permanent repair. Office hours for everything else are Monday to Friday, 8:30am to 5:30pm."
  },
  {
    "q": "Can you cover sites outside London?",
    "a": "Yes. Contractor depth is strongest in London and the South East, and regional coverage is mobilised for each client’s wider UK portfolio, prioritised by where your sites cluster. We will tell you plainly which regions are established and which are still being built before you commit sites."
  },
  {
    "q": "What will you not claim?",
    /* The third item was "a 24/7 national team". It is narrowed, not dropped:
       there IS now a round-the-clock line, for London, so the claim that is
       still refused is the one that would be untrue — a promised arrival time,
       and round-the-clock cover everywhere. */
    "a": "We do not advertise nationwide employed engineers, guaranteed same-day UK coverage or a guaranteed arrival time. The 24-hour emergency line is for commercial premises in London. Outside London, where dedicated coverage is still being established, urgent work is handled through controlled interim sourcing rather than left unmanaged — and we tell you which is which before you commit sites."
  },
  {
    "q": "Can we keep our current contractors?",
    /* Widened for Homepage V3 to say what the "Your contractors or ours"
       section says. The old answer ("Yes. Existing contractors can be retained
       subject to agreed onboarding…") was correct and half the position: it
       answered whether you may keep yours and never said the two panels run
       side by side, which is what most portfolios actually do. The two must
       stay worded from the same facts — if one changes, change both. */
    "a": "Yes — your contractors or ours, and most portfolios run a mix. Existing contractors are retained subject to onboarding: insurance, qualifications, documentation and the same performance expectations everyone on the panel works to, at the rates you have already agreed with them. Where you have no cover for a trade, a region or an hour, we source from the vetted panel instead. The split is yours to set and yours to change."
  },
  {
    "q": "Who pays the contractor?",
    /* REWRITTEN 2026-11-25. The answer described the withdrawn model — the
       contractor invoices you, MAINTSUPP invoices a coordination fee — as "the
       standard starting model". A one-off job is one approved price, so that
       is what the first sentence says; direct invoicing survives only where it
       is still true, for contractors a client brings to a managed plan. */
    "a": "For a one-off job you approve one price before work starts, and that is the price you pay. On a managed monthly plan, contractors you already use can keep invoicing you directly at the rates you agreed with them; that is set out when the plan is arranged."
  },
  {
    "q": "Do you guarantee a first-time fix?",
    "a": "No responsible provider can guarantee every fault is fixed on the first attendance. What we can do is improve the odds through better site data, photographs and asset records before anyone travels."
  },
  {
    "q": "How quickly can mobilisation begin?",
    "a": "A one-off job can be booked as soon as you approve the price. Setting up a managed plan for a portfolio typically takes one to two weeks, depending on portfolio size, the quality of your site data, contractor coverage in your regions and any integrations required."
  },
  {
    "q": "What does it cost?",
    /* REWRITTEN 2026-11-25, for the third time and for the same reason as the
       second: it had come to contradict the page.

       It first said "We do not publish fixed fees". Homepage V3 published
       per-store rates and the answer was changed to quote them. The owner has
       now withdrawn those plans (`./rates.ts`), so an answer that opened
       "Coordination is priced per store per month and every rate is published
       on this page" would tell a reader the page was lying to them.

       EVERY COMMERCIAL TERM IN IT IS QUOTED FROM `TERMS`, NOT TYPED. That is
       the rule the interpolated rates kept, applied to sentences instead of
       numbers: the pricing cards, `/pricing` and the London pages read the
       same four sentences, so the call-out promise cannot be worded two ways.
       There is still no pound sign followed by a digit in this file, and
       `tests/homepage-v3.test.mjs` still refuses one. */
    "a": `${TERMS.perJob} Nothing is booked until you approve it. There is no subscription and no minimum term. ${TERMS.callOut} ${TERMS.noRepairVisit} Use of the MAINTSUPP portal is included. Kiosk installs and removals, strip-outs, fit-outs and other projects are scoped and quoted separately. ${TERMS.managedPlan}`
  },
  {
    /* WAS "What if we only have three or four sites?", added with the
       commercial update to turn a small operator away FROM THE MONTHLY PLAN in
       plain words, and changed in October 2026 to add that a one-off job in
       London was still possible.

       REWRITTEN 2026-11-25. With the published plans withdrawn there is no
       floor for that reader to be under, so the question is now the one they
       actually ask, and the answer is no. The managed plan's own starting
       size is still stated — derived from `rates.ts`, where it is the one
       figure left. */
    "q": "Is there a minimum number of sites?",
    "a": `No. One shop or one kiosk with one job is enough, and each job is priced before work starts. The only thing with a minimum is the managed monthly plan, which is arranged on request for portfolios of ${inWords(MANAGED_PLAN_MINIMUM_SITES)} sites and above.`
  },
  {
    "q": "Can store teams report jobs directly?",
    /* WIDENED 2026-11-25. "Approved users submit a structured request…
       Permissions and approval rules are set during onboarding" described an
       existing client only, while the Report a Job form on this page has
       always accepted a request from anyone. A first-time customer is now the
       reader the site is written for, so the answer says so. */
    "a": "Yes. Anyone at the site can report a job with the form on this site: the site, the fault, how urgent it is, photographs and access details. No account is needed for a first job. Regular customers get portal logins, so store teams can raise and track jobs themselves, with permissions and approval rules agreed at set-up."
  }
] as const;

