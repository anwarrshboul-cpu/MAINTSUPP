import type { LandingPage } from "./types.ts";

/**
 * THE NINE LONDON SERVICE PAGES.
 *
 * Each owns one search intent and says so in its title; `docs/seo-keyword-map.md`
 * records which. The wording follows what people type, which the October 2026
 * research measured rather than guessed:
 *
 *   - "kiosk" alone is polluted by self-service terminals and kiosk-mode
 *     software, so the kiosk page always says RETAIL kiosk and names the
 *     shopping centre; "stall" and "RMU" sit beside it because both are typed.
 *   - nobody types "shop strip out london"; they type "strip out contractors
 *     london" and "retail strip out", so that page carries those words.
 *   - "shop electrician" returns car electricians. "Commercial electrician" and
 *     "retail" are the clean terms.
 *   - "commercial carpentry london" and "commercial joinery london" are what
 *     Google completes; "commercial carpenter london" is rewritten to them.
 *
 * EVERY PAGE SAYS WHO DOES THE WORK. Competitors sell against subcontracting
 * ("no subcontractors", "directly employed"). MAINTSUPP is the opposite model
 * and the site has always said so plainly; these pages keep that, because a
 * buyer who finds out afterwards is a complaint, and one who is told up front
 * is choosing accountability over a logo on a van.
 */

const CENTRES_ANSWER =
  "Yes. Works inside a centre are done under its own permit and access rules, usually outside trading hours. MAINTSUPP has already coordinated jobs inside Westfield Stratford City, Westfield London at White City and Brent Cross.";

const DOMESTIC_ANSWER =
  "No. MAINTSUPP works for commercial premises only: shops, kiosks, restaurants, offices, gyms and clinics.";

const WHO_ANSWER =
  "Vetted independent contractors. MAINTSUPP does not employ tradespeople: it checks each contractor’s insurance and competence, briefs them, follows the job and checks the evidence before the job is closed. You deal with one coordinator throughout.";

const PRICE_ANSWER =
  "Each job is quoted individually, and you have the price before any work is booked.";

export const SERVICE_PAGES: readonly LandingPage[] = [
  /* ---------------------------------------------------------------- */
  {
    path: "/london/kiosk-installation",
    kind: "service",
    crumb: "Kiosk installation",
    title: "Retail Kiosk Installation & Removal London",
    description:
      "Kiosk, stall and RMU installation, dismantling, relocation and removal in London shopping centres. Overnight works, permits and RAMS handled. Quoted per job.",
    eyebrow: "Kiosks, stalls and RMUs",
    h1: "Retail kiosk installation, dismantling and removal in London shopping centres",
    lede: "Opening a kiosk, moving it to a new pitch or handing the space back? MAINTSUPP coordinates the install, the electrical connection, the dismantle and the making good — overnight, inside the centre’s own rules — for kiosks, stalls, retail merchandising units (RMUs), carts and pop-up units across London.",
    photo: {
      src: "/assets/pages/service-projects-v1.jpg",
      alt: "A fitting team installing a glass display kiosk in a shopping centre, one fitting a panel while another checks a drawing",
    },
    cards: {
      eyebrow: "What we do",
      heading: "Every stage of a kiosk’s life on the mall",
      lede: "For units of any make, including one you bought from a manufacturer who does not install.",
      items: [
        {
          title: "Installation and assembly",
          body: "Flat-packed or part-built units received, assembled and fixed on the pitch — including units supplied by another manufacturer or shipped from overseas.",
        },
        {
          title: "Dismantling and removal",
          body: "The unit taken down at the end of a licence or lease, removed from the centre, and the pitch left the way the landlord expects it.",
        },
        {
          title: "Relocation",
          body: "A kiosk moved to a new pitch in the same centre, or to another centre, after a landlord’s relocation notice or a move of your own.",
        },
        {
          title: "Electrical connection",
          body: "A qualified electrical contractor connects the unit to the supply point, or isolates and disconnects it before removal — alongside the centre’s own electrician where the centre requires one.",
        },
        {
          title: "Repairs and refresh",
          body: "Shutters and locks, lighting, counters, panels, graphics and signage on a trading unit, done before opening or after closing.",
        },
        {
          title: "Disposal",
          body: "A unit that is no longer needed is broken down and taken away by a registered waste carrier, and the waste transfer note is passed to you.",
        },
      ],
    },
    steps: {
      eyebrow: "How it runs",
      heading: "From your dates to a trading unit",
      items: [
        {
          title: "Send us the details",
          body: "The centre, the pitch, drawings or photographs of the unit, and your dates. We tell you what the centre is likely to ask for.",
        },
        {
          title: "Quote and paperwork",
          body: "A written quote, agreed before anything is booked. The risk assessments, method statements and insurance documents are prepared for centre management.",
        },
        {
          title: "The overnight slot",
          body: "Most centres only allow this work when the mall is closed, so the delivery, the loading bay and the access window are booked with the centre in advance.",
        },
        {
          title: "Done, and evidenced",
          body: "The work is carried out in the booked slot, the area is left clean, and you receive before and after photographs.",
        },
      ],
    },
    points: {
      eyebrow: "Before work starts",
      heading: "What a shopping centre usually asks for",
      items: [
        "A risk assessment and method statement (RAMS) for the work",
        "Proof of public liability insurance",
        "A permit for out-of-hours works, applied for in advance",
        "A booked delivery or loading bay slot",
        "Test records for any electrical item that plugs in",
      ],
      note: "Each centre’s management sets its own requirements and changes them. We confirm the current ones for every job rather than assume.",
    },
    faqs: [
      {
        q: "Can you install a kiosk that somebody else built?",
        a: "Yes. Many units arrive flat-packed from a manufacturer in the UK or overseas with nobody to assemble them. We coordinate a fitting team to build and fix the unit from the maker’s drawings. We need the drawings, the packing list, and the unit’s weight and power requirements.",
      },
      {
        q: "Why do kiosk installations happen at night?",
        a: "Centres do not allow building work on the mall while customers are there, so installs, removals and deliveries are booked for after closing, in a slot agreed with centre management.",
      },
      {
        q: "Who applies for the centre’s permit?",
        a: "We prepare the risk assessments, method statements and insurance documents for the contractors we send, and submit them to centre management. The agreement for the space itself — your licence or lease — stays between you and the centre or its letting agent.",
      },
      {
        q: "Do you rent out kiosk space?",
        a: "No. Space is let by the centre or by its commercialisation agent. MAINTSUPP does the physical works once you have the space: install, electrics, repairs, relocation and removal.",
      },
      {
        q: "How much does kiosk installation or removal cost?",
        a: "It depends on the unit, the centre, the access window and whether electrics, flooring or disposal are involved. Each job is quoted individually, and you have the price in writing before anything is booked.",
      },
      {
        q: "Do you install pop-up shops and promotional stands?",
        a: "Yes. A pop-up shop, a promotional stand or a seasonal stall is installed and de-rigged the same way as a kiosk: in a booked slot outside trading hours, under the centre’s permit. Tell us the dates the space is yours, and the install and the de-rig are planned around them.",
      },
      {
        q: "Do you fit out a kiosk as well as install it?",
        a: "Yes. A kiosk fit-out — the lighting and power, counters, graphics and signage that finish a unit — runs through the same coordinator as the installation, and is quoted with it.",
      },
      { q: "Which shopping centres do you cover?", a: CENTRES_ANSWER.replace(/^Yes\. /, "Any shopping centre in London. ") },
      { q: "Who carries out the work?", a: WHO_ANSWER },
    ],
    related: [
      { href: "/london/westfield-stratford-city", label: "Westfield Stratford City" },
      { href: "/london/westfield-london-white-city", label: "Westfield London, White City" },
      { href: "/london/brent-cross", label: "Brent Cross" },
      { href: "/london/shop-strip-out", label: "Shop strip-out and closure" },
      { href: "/london/commercial-electrician", label: "Commercial electrician" },
    ],
    cta: {
      heading: "Have a kiosk to install, move or remove?",
      lede: "Tell us the centre and your dates. We come back with what the centre will need and a quote for the job.",
    },
    serviceType: "Retail kiosk installation, dismantling and removal",
    emailSubject: "Quote request: kiosk installation or removal (London)",
  },

  /* ---------------------------------------------------------------- */
  {
    path: "/london/shop-strip-out",
    kind: "service",
    crumb: "Shop strip-out",
    title: "Shop Strip Out Contractors London | Retail Units",
    description:
      "Closing a shop or kiosk in London? Retail strip-out, fixture and sign removal, clearance and making good, planned around your lease end and the centre’s rules.",
    eyebrow: "Closing a shop",
    h1: "Shop strip-out and closure works in London",
    lede: "Closing a shop, a concession or a kiosk? MAINTSUPP coordinates the strip-out contractors, the removal of fixtures and signs, the clearance and the making good — around your lease-end date and the landlord’s rules — so the unit goes back in the condition your lease asks for.",
    photo: {
      src: "/assets/pages/case-work-v1.jpg",
      alt: "A contractor in a hi-vis vest carrying a toolbag into a shopping centre while checking the job on his phone",
    },
    cards: {
      eyebrow: "What we do",
      heading: "A retail strip-out, start to handback",
      items: [
        {
          title: "Fixtures and fittings removed",
          body: "Shelving, counters, display units, till points, stockroom racking and back-of-house fittings taken out and removed from site.",
        },
        {
          title: "Signage and branding removed",
          body: "Fascia signs, window graphics and internal branding taken down, with illuminated signs isolated by a qualified electrical contractor first.",
        },
        {
          title: "Clearance and waste",
          body: "Stock, furniture and strip-out waste cleared by a registered waste carrier, with the waste transfer notes kept for your handback file.",
        },
        {
          title: "Making good",
          body: "Fixing holes filled, walls and ceilings repaired and decorated, and floors made good, so the unit matches what the lease requires — back to shell, where that is what it asks for.",
        },
        {
          title: "Services made safe",
          body: "Electrical circuits, lighting, data and plumbing to the removed fittings isolated and terminated safely by the right trade.",
        },
        {
          title: "Evidence for handback",
          body: "Before and after photographs of every area, so there is a record of the condition the unit was returned in.",
        },
      ],
    },
    steps: {
      eyebrow: "How it runs",
      heading: "Worked back from your lease-end date",
      items: [
        {
          title: "Tell us the date",
          body: "And send what the landlord has asked for, if you have it: a schedule of dilapidations, the reinstatement clause, or the centre’s handback checklist.",
        },
        {
          title: "Survey and quote",
          body: "We look at the unit, list what stays and what goes, and quote for the works with a programme that ends before your deadline.",
        },
        {
          title: "Permits and access",
          body: "Method statements, insurance documents, out-of-hours permits, the loading bay and the waste route are arranged with centre management or the landlord.",
        },
        {
          title: "Strip-out and handback",
          body: "The work is done in the agreed window and the unit is left clean. You receive the photographs and the waste paperwork.",
        },
      ],
    },
    points: {
      eyebrow: "To quote quickly",
      heading: "What to send us",
      items: [
        "The address of the unit and your lease-end or handback date",
        "Anything the landlord has put in writing about the condition they expect",
        "Photographs or a short video of the shop floor and back of house",
        "A list of anything that is to be kept, moved to another store or returned",
        "How access works: keys, alarm, centre security and trading hours",
      ],
    },
    faqs: [
      {
        q: "What is a shop strip-out?",
        a: "The removal of what a tenant added to a unit — fixtures, fittings and signage, and sometimes partitions, flooring and services — so the unit can be handed back to the landlord or fitted out again. A soft strip removes the non-structural items only. Some firms call the same job shop fitting removal, or a shop clearance.",
      },
      {
        q: "What has to be removed when a shop lease ends?",
        a: "It depends on your lease. Many leases require the tenant to remove their fixtures, fittings and signage and to reinstate their alterations, and a landlord may also serve a schedule of dilapidations listing repairs. Send us the documents and we scope the works against them. We are not solicitors or surveyors: where the wording is in dispute, take professional advice.",
      },
      {
        q: "Can a strip-out be done inside a shopping centre?",
        a: "Yes. The work is done outside trading hours under the centre’s permit, with deliveries and waste taken through the service corridors and the loading bay at booked times.",
      },
      {
        q: "How long does a shop strip-out take?",
        a: "It depends on the size of the unit and on the access window the centre or landlord allows. You get a programme with the quote, worked back from your handback date.",
      },
      { q: "How much does a shop strip-out cost in London?", a: `It depends on the size of the unit, what has to be removed, the making good and the access hours. ${PRICE_ANSWER}` },
      {
        q: "Can you carry out the dilapidations repairs as well?",
        a: "Yes, as part of an end-of-lease strip-out: making good, decorating, flooring repairs and electrical remedial works can be in the same job. Structural works, and anything that needs a surveyor’s sign-off, are scoped separately.",
      },
      {
        q: "Can you close several stores at once?",
        a: "Yes. A store closure programme across several sites runs through one coordinator, with the same evidence standard at every store and one report at the end.",
      },
      { q: "Who carries out the work?", a: WHO_ANSWER },
      { q: "Do you strip out homes or flats?", a: DOMESTIC_ANSWER },
    ],
    related: [
      { href: "/london/kiosk-installation", label: "Kiosk dismantling and removal" },
      { href: "/london/shop-fit-out", label: "Shop fit-out and opening works" },
      { href: "/london/commercial-painters-decorators", label: "Commercial painters and decorators" },
      { href: "/london/commercial-electrician", label: "Commercial electrician" },
      { href: "/london", label: "All London services" },
    ],
    cta: {
      heading: "Handing a unit back?",
      lede: "Tell us the address and the date. We come back with a scope, a programme and a quote.",
    },
    serviceType: "Retail strip-out and shop closure works",
    emailSubject: "Quote request: shop strip-out (London)",
  },

  /* ---------------------------------------------------------------- */
  {
    path: "/london/shop-fit-out",
    kind: "service",
    crumb: "Shop fit-out",
    title: "Shop Fit Out London | New Shop Opening Works",
    description:
      "Opening a shop or kiosk in London? Electrics, decorating, fixtures, signage and snagging coordinated, with centre permits and out-of-hours access arranged.",
    eyebrow: "Opening a shop",
    h1: "Shop fit-out and new shop opening works in London",
    lede: "Opening a shop, a concession or a kiosk in London? MAINTSUPP coordinates the trades that get a unit ready to trade — electrics and lighting, decorating, carpentry, fixtures, signage and snagging — with the centre permits and the out-of-hours access arranged for you.",
    photo: {
      src: "/assets/pages/page-case-study-hero-v1.jpg",
      alt: "A tradesperson adjusting a spotlight on a dark green and gold fragrance kiosk in a shopping centre",
    },
    cards: {
      eyebrow: "What we do",
      heading: "The trades a new shop needs, through one contact",
      lede: "You bring the layout — yours, your designer’s or your shopfitter’s. We coordinate the work that turns it into a shop.",
      items: [
        {
          title: "Electrics and lighting",
          body: "Shop lighting, power for tills and displays, sign supplies and emergency lighting, installed and tested by qualified electrical contractors.",
        },
        {
          title: "Decorating",
          body: "Walls, ceilings, shopfronts and joinery painted in your brand colours, out of hours where the centre requires it.",
        },
        {
          title: "Fixtures, shelving and counters",
          body: "Display fixtures, shelving, counters and stockroom racking assembled and fixed, including fixtures supplied by your own shopfitter.",
        },
        {
          title: "Signage and graphics",
          body: "Fascia signs, window graphics and internal branding fitted, with the electrical supply for illuminated signs.",
        },
        {
          title: "Flooring and finishes",
          body: "Floor repairs and new finishes, ceiling tiles, wall finishes and the making good after other trades.",
        },
        {
          title: "Snagging before opening day",
          body: "The last list worked through before you trade: the doors, locks, lights and fittings that were not quite finished.",
        },
      ],
    },
    steps: {
      eyebrow: "How it runs",
      heading: "Worked back from your opening date",
      items: [
        {
          title: "Send the layout and the date",
          body: "Drawings or a marked-up plan, the unit’s address, and the day you want to open.",
        },
        {
          title: "Scope and quote",
          body: "We list the trades, the order they work in and the out-of-hours windows they need, and quote for the works.",
        },
        {
          title: "Approvals and permits",
          body: "Where the lease or the centre requires approval, you or your designer submit the drawings. We supply the contractor documents and book the working windows.",
        },
        {
          title: "Works, snagging, photographs",
          body: "The trades are sequenced and followed, the snag list is closed, and at handover you receive the photographs and certificates, before opening day.",
        },
      ],
    },
    faqs: [
      {
        q: "Are you shopfitters?",
        a: "We coordinate the trades a fit-out needs; we do not design and manufacture shop interiors. If you need a bespoke interior designed and built, you want a design-and-build shopfitter — some call them shop fitters, or retail fit-out contractors. If you have the layout and need the unit made ready — electrics, decorating, fixtures fitted, signs up, snags closed — that is this service. We also work alongside your shopfitter on the trades they do not cover.",
      },
      {
        q: "Do you fit out small shops and kiosks?",
        a: "Yes. Small units, concessions and kiosks are the core of this service, and a one-off job is welcome.",
      },
      {
        q: "Can the works be done out of hours?",
        a: "Yes. In a shopping centre that is usually a condition of the permit, and on a high street it avoids losing trading days at the shops either side of you.",
      },
      {
        q: "Do I need the landlord’s approval to fit out a shop?",
        a: "Usually, for alterations. Many leases require a licence for alterations, and shopping centres publish their own fit-out rules. Check your lease and ask centre management early. We supply the contractor paperwork they ask for; we do not give legal advice.",
      },
      {
        q: "Do you take on a shop refit or refurbishment?",
        a: "Yes. A refit or refurbishment of a shop that is already trading is planned in sections and done out of hours, so the shop opens as normal between visits. The same goes for a rebrand, or for a commercial unit you have just taken on.",
      },
      { q: "How much does a shop fit-out cost in London?", a: `It depends on the size of the unit, the finish and how many trades are involved. ${PRICE_ANSWER}` },
      {
        q: "Can you look after the shop once it is open?",
        a: "Yes. Repairs can be booked one job at a time, and portfolios of five sites and above can go on a monthly coordination plan with published per-store pricing.",
      },
      { q: "Who carries out the work?", a: WHO_ANSWER },
      { q: "Do you fit out homes?", a: DOMESTIC_ANSWER },
    ],
    related: [
      { href: "/london/kiosk-installation", label: "Kiosk installation" },
      { href: "/london/commercial-electrician", label: "Commercial electrician" },
      { href: "/london/commercial-painters-decorators", label: "Commercial painters and decorators" },
      { href: "/london/commercial-carpentry", label: "Commercial carpentry and joinery" },
      { href: "/london/shop-maintenance", label: "Retail and shop maintenance" },
    ],
    cta: {
      heading: "Opening soon?",
      lede: "Send the layout and the date. We come back with the trades, the programme and a quote.",
    },
    serviceType: "Shop fit-out and new shop opening works",
    emailSubject: "Quote request: shop fit-out or opening works (London)",
  },

  /* ---------------------------------------------------------------- */
  {
    path: "/london/commercial-electrician",
    kind: "service",
    crumb: "Commercial electrician",
    title: "Commercial Electrician London | Shops, 24/7",
    description:
      "Commercial electricians for shops, kiosks and retail units in London: lighting, faults, emergency lighting, EICR and sign power. Out of hours, 24/7 emergencies.",
    eyebrow: "Commercial electrician",
    h1: "Commercial electricians for shops and retail units in London",
    lede: "Lights out over the shop floor, a circuit that keeps tripping, no power to the tills or an emergency light that failed its test? MAINTSUPP sends a vetted, qualified commercial electrician to shops, kiosks, restaurants and offices across London — before opening or after closing, and at any hour in an emergency.",
    photo: {
      src: "/assets/pages/service-compliance-v1.jpg",
      alt: "A technician testing an emergency light beside a red fire alarm panel in a back-of-house corridor",
    },
    cards: {
      eyebrow: "What we do",
      heading: "Electrical work for retail and commercial premises",
      lede: "A retail electrician is booked around the shop: before the doors open, after they close, or overnight inside a centre.",
      items: [
        {
          title: "Faults and call-outs",
          body: "Tripping circuits, loss of power to the tills or to a zone, faulty sockets, distribution board alarms and burning smells made safe and repaired.",
        },
        {
          title: "Shop lighting",
          body: "Lighting repairs, lamp and driver replacement, LED upgrades and display lighting, on the shop floor and in the stockroom.",
        },
        {
          title: "Emergency lighting",
          body: "Failed fittings replaced and the periodic emergency lighting tests scheduled, with the test record kept.",
        },
        {
          title: "Sign power",
          body: "Supplies to illuminated fascia signs and window displays repaired or installed.",
        },
        {
          title: "Tills, kiosks and equipment",
          body: "New circuits and sockets for till points, EPOS, fridges and displays, and the connection or disconnection of a kiosk.",
        },
        {
          title: "Testing and certificates",
          body: "EICR fixed-wire inspections, PAT testing and the remedial works arranged with qualified electrical contractors, and the certificates stored against the site.",
        },
      ],
    },
    points: {
      eyebrow: "Why shops use us",
      heading: "An electrician, with the coordination done",
      items: [
        "Commercial premises only: shops, kiosks, restaurants, offices, gyms and clinics",
        "Qualified electrical contractors, insurance and competence checked before any work is released",
        "Work arranged before opening, after closing or overnight",
        "Centre permits, method statements and access handled for you",
        "Before and after photographs and the paperwork on every job",
        "One contact for the next trade you need as well",
      ],
    },
    faqs: [
      {
        q: "Do you employ the electricians?",
        a: "No. MAINTSUPP coordinates vetted independent electrical contractors. We check their insurance and qualifications, brief them, follow the job and check the evidence before it is closed. You deal with one coordinator.",
      },
      {
        q: "Can an electrician attend at night or before the shop opens?",
        a: "Yes. Most retail electrical work is booked for before opening, after closing or overnight, and in a shopping centre that is normally a condition of the permit.",
      },
      {
        q: "Is there a 24-hour emergency electrician for commercial premises?",
        a: "Yes, in London. Call 07852 224644 at any hour. We tell you the realistic attendance time before you commit, and the first priority is making the site safe.",
      },
      {
        q: "Do you carry out EICRs for shops?",
        a: "The inspection and the certificate are carried out by qualified electrical contractors. We arrange the visit, chase the certificate, track any remedial works and record the next due date.",
      },
      { q: "How much does a commercial electrician cost in London?", a: `${PRICE_ANSWER} For an emergency you are told how the call-out is charged before anyone is sent.` },
      { q: "Do you work inside shopping centres?", a: CENTRES_ANSWER },
      { q: "Do you take domestic electrical work?", a: DOMESTIC_ANSWER },
    ],
    related: [
      { href: "/london/emergency-repairs", label: "24-hour emergency repairs" },
      { href: "/london/kiosk-installation", label: "Kiosk installation and electrics" },
      { href: "/london/shop-fit-out", label: "Shop fit-out and opening works" },
      { href: "/london/commercial-handyman", label: "Commercial handyman" },
      { href: "/london/shop-maintenance", label: "Retail and shop maintenance" },
    ],
    cta: {
      heading: "Need a commercial electrician in London?",
      lede: "Call for an emergency. For planned work, tell us the site and the job and we come back with a quote.",
    },
    serviceType: "Commercial electrician",
    emailSubject: "Quote request: commercial electrician (London)",
  },

  /* ---------------------------------------------------------------- */
  {
    path: "/london/commercial-handyman",
    kind: "service",
    crumb: "Commercial handyman",
    title: "Commercial Handyman London | Shops & Offices",
    description:
      "Commercial handyman services for shops, kiosks and offices in London. Doors, shelving, ceilings, signs and snag lists, out of hours. Vetted, insured trades.",
    eyebrow: "Commercial handyman",
    h1: "Commercial handyman services for shops and offices in London",
    lede: "The small jobs that keep a shop presentable and safe — a door that will not close, a loose shelf, a stained ceiling tile, a sign that needs fixing — handled by vetted, insured tradespeople who work around your trading hours. One job or a list of them, anywhere in London.",
    photo: {
      src: "/assets/pages/trade-cctv-v1.jpg",
      alt: "A tradesperson on a stepladder adjusting a ceiling-mounted camera beside a store entrance with an access-control keypad",
    },
    cards: {
      eyebrow: "What we do",
      heading: "General repairs for commercial premises",
      items: [
        {
          title: "Doors, locks and closers",
          body: "Sticking doors, failed door closers, handles, locks and stockroom doors repaired or replaced.",
        },
        {
          title: "Shelving, fixtures and displays",
          body: "Shelves, brackets, display fixtures, mirrors, rails and noticeboards fixed, moved or made safe.",
        },
        {
          title: "Ceilings, walls and floors",
          body: "Stained or broken ceiling tiles, wall damage, lifting floor edges and trip hazards put right.",
        },
        {
          title: "Signs and fittings",
          body: "Internal signs, menu and price boards, poster frames, blinds and fittings mounted or re-fixed.",
        },
        {
          title: "Snag lists",
          body: "A list of small jobs worked through in one visit, so you pay for one attendance rather than five.",
        },
        {
          title: "Make-safe visits",
          body: "Something broken or dangerous made safe quickly, with the permanent repair arranged afterwards.",
        },
      ],
    },
    points: {
      eyebrow: "Why shops use us",
      heading: "A handyman who can work in a managed building",
      items: [
        "Commercial premises only: shops, kiosks, restaurants, offices, gyms and clinics",
        "Insurance and competence checked before any work is released",
        "Visits before opening, after closing or overnight",
        "Risk assessments, method statements and insurance documents supplied when a centre or landlord asks",
        "Before and after photographs of every job",
        "The right trade sent instead when a job needs an electrician, a plumber or a glazier",
      ],
    },
    faqs: [
      {
        q: "Can a handyman work on commercial property?",
        a: "Yes, for general repairs and maintenance. Work the law reserves for qualified trades — gas, and most electrical work — goes to the right contractor instead, and we arrange that under the same job.",
      },
      {
        q: "Can you do several jobs in one visit?",
        a: "Yes, and it is the cheapest way to use the service. Send the list with photographs and we plan one visit with the right materials.",
      },
      {
        q: "Can the work be done outside opening hours?",
        a: "Yes. Out-of-hours visits — early mornings, evenings and overnight — are normal for retail, and inside a shopping centre they are usually required.",
      },
      {
        q: "Do you provide RAMS and insurance documents?",
        a: "Yes. When a centre or landlord asks for them, the contractor’s risk assessment, method statement and proof of insurance are supplied before the visit.",
      },
      { q: "How much does a commercial handyman cost in London?", a: `It depends on the list, the materials and the hours the site allows. ${PRICE_ANSWER}` },
      { q: "Do you work inside shopping centres?", a: CENTRES_ANSWER },
      { q: "Who carries out the work?", a: WHO_ANSWER },
      { q: "Do you take domestic handyman jobs?", a: DOMESTIC_ANSWER },
    ],
    related: [
      { href: "/london/commercial-carpentry", label: "Commercial carpentry and joinery" },
      { href: "/london/commercial-painters-decorators", label: "Commercial painters and decorators" },
      { href: "/london/commercial-electrician", label: "Commercial electrician" },
      { href: "/london/emergency-repairs", label: "24-hour emergency repairs" },
      { href: "/london/shop-maintenance", label: "Retail and shop maintenance" },
    ],
    cta: {
      heading: "Got a list of small jobs?",
      lede: "Send the list and a few photographs. We plan one visit and quote for it.",
    },
    serviceType: "Commercial handyman services",
    emailSubject: "Quote request: commercial handyman (London)",
  },

  /* ---------------------------------------------------------------- */
  {
    path: "/london/commercial-painters-decorators",
    kind: "service",
    crumb: "Painters and decorators",
    title: "Commercial Painters & Decorators London | Shops",
    description:
      "Commercial painters and decorators for shops, shopfronts and offices in London. Overnight and out-of-hours work, brand colours, end-of-lease redecoration.",
    eyebrow: "Commercial painters and decorators",
    h1: "Commercial painters and decorators for shops in London",
    lede: "Shop floors, shopfronts, stockrooms, offices and common areas painted by vetted commercial decorators — overnight or before opening, so you do not lose a day’s trade. One-off jobs, end-of-lease redecoration and brand refreshes across London.",
    photo: {
      src: "/assets/pages/case-brief-v1.jpg",
      alt: "A coordinator photographing a water-stained ceiling tile in a fragrance shop with her phone",
    },
    cards: {
      eyebrow: "What we do",
      heading: "Decorating for retail and commercial premises",
      items: [
        {
          title: "Shop floor and back of house",
          body: "Walls, ceilings and woodwork on the shop floor, and the stockrooms and staff areas behind it.",
        },
        {
          title: "Shopfronts",
          body: "Shopfront frames, doors, fascias and shutters prepared and repainted.",
        },
        {
          title: "Brand refresh",
          body: "Your brand colours applied consistently across one shop or a group of them.",
        },
        {
          title: "End-of-lease redecoration",
          body: "The decorating a lease or a schedule of dilapidations requires before the unit is handed back.",
        },
        {
          title: "Repairs before paint",
          body: "Filling, patch plastering, stain blocking after a leak and minor wall repairs, done as part of the job.",
        },
        {
          title: "Kiosks and fixtures",
          body: "Counters, kiosk panels, display fixtures and joinery repainted or touched up.",
        },
      ],
    },
    points: {
      eyebrow: "Why shops use us",
      heading: "Decorators who work when you are closed",
      items: [
        "Commercial premises only: shops, kiosks, restaurants, offices, gyms and clinics",
        "Work planned for overnight or before opening, in sections",
        "Stock, fixtures and floors protected before work starts",
        "Method statements and insurance documents supplied when a centre or landlord asks",
        "Before and after photographs of every area",
        "The repairs behind the paint — a leak, a damaged wall — handled under the same job",
      ],
    },
    faqs: [
      {
        q: "Can you paint a shop without closing it?",
        a: "In most cases, yes. The work is planned for overnight or before opening and done in sections, with each area dry and clear before you trade.",
      },
      {
        q: "Can you match our brand colours?",
        a: "Yes. Send the colour references — RAL, Pantone or the paint maker’s own code — and the finish you use.",
      },
      {
        q: "Do you redecorate at the end of a lease?",
        a: "Yes. Send the lease clause or the schedule of dilapidations and we scope the decorating against it, together with any making good.",
      },
      { q: "How much do commercial painters and decorators cost in London?", a: `It depends on the area, the preparation needed and the hours the site allows. ${PRICE_ANSWER}` },
      { q: "Do you work inside shopping centres?", a: CENTRES_ANSWER },
      { q: "Who carries out the work?", a: WHO_ANSWER },
      { q: "Do you take domestic decorating?", a: DOMESTIC_ANSWER },
    ],
    related: [
      { href: "/london/shop-fit-out", label: "Shop fit-out and opening works" },
      { href: "/london/shop-strip-out", label: "Shop strip-out and closure" },
      { href: "/london/commercial-carpentry", label: "Commercial carpentry and joinery" },
      { href: "/london/commercial-handyman", label: "Commercial handyman" },
      { href: "/london", label: "All London services" },
    ],
    cta: {
      heading: "A shop that needs decorating?",
      lede: "Send the address and a few photographs. We come back with a quote and the nights it would take.",
    },
    serviceType: "Commercial painting and decorating",
    emailSubject: "Quote request: commercial painting and decorating (London)",
  },

  /* ---------------------------------------------------------------- */
  {
    path: "/london/commercial-carpentry",
    kind: "service",
    crumb: "Carpentry and joinery",
    title: "Commercial Carpentry & Joinery London | Shops",
    description:
      "Commercial carpenters and joiners for shops, kiosks and offices in London. Counters, till points, doors, shelving and partitions repaired or built out of hours.",
    eyebrow: "Commercial carpentry and joinery",
    h1: "Commercial carpentry and joinery for shops in London",
    lede: "Counters, till points, shop doors, shelving, partitions and stockroom fittings repaired, adjusted or built by vetted carpenters and joiners — for shops, kiosks, restaurants and offices across London, outside trading hours where needed.",
    photo: {
      src: "/assets/pages/service-reactive-v1.jpg",
      alt: "A tradesperson kneeling at a shop entrance to repair a jammed roller shutter, with an open toolbox and phone beside him",
    },
    cards: {
      eyebrow: "What we do",
      heading: "Carpentry and joinery for retail and commercial premises",
      lede: "A shop carpenter for the repair in front of you, and shop joinery built to match what is already there.",
      items: [
        {
          title: "Counters and till points",
          body: "Damaged counter tops, panels, doors and drawers repaired, and till points altered or rebuilt.",
        },
        {
          title: "Doors and fire doors",
          body: "Doors eased, re-hung and repaired, and closers, hinges and seals replaced. Fire door inspections and certified repairs are arranged with competent specialists.",
        },
        {
          title: "Shelving and display joinery",
          body: "Shelving, display units, plinths and wall bays built, altered or made safe.",
        },
        {
          title: "Partitions and stockrooms",
          body: "Stud partitions, stockroom fittings, hatches and boxing-in.",
        },
        {
          title: "Kiosk carpentry",
          body: "Kiosk panels, counters, flaps and lockable cupboards repaired on the unit.",
        },
        {
          title: "Making good",
          body: "Skirting, architraves, floor trims and damaged joinery put right after other works.",
        },
      ],
    },
    points: {
      eyebrow: "Why shops use us",
      heading: "Carpenters who can work in a trading shop",
      items: [
        "Commercial premises only: shops, kiosks, restaurants, offices, gyms and clinics",
        "Insurance and competence checked before any work is released",
        "Work before opening, after closing or overnight",
        "Method statements and insurance documents supplied when a centre or landlord asks",
        "Before and after photographs of every job",
        "Decorating, electrics and locks arranged under the same job when the repair needs them",
      ],
    },
    faqs: [
      {
        q: "Can a carpenter attend urgently if a shop door will not lock?",
        a: "Yes. Call 07852 224644 at any hour. The first visit makes the entrance secure, and the permanent repair follows.",
      },
      {
        q: "Can you match the existing counter or joinery?",
        a: "Usually. Send photographs and, where you have them, the finish and the supplier. Where an exact match is not available we say so before the work is booked.",
      },
      {
        q: "Do you build bespoke shop interiors?",
        a: "Small bespoke items — a counter, a run of shelving, a cupboard — yes. A whole interior designed and manufactured from scratch is a shopfitter’s job, and we can work alongside yours.",
      },
      {
        q: "Do you inspect and certify fire doors?",
        a: "Inspection and certification are carried out by competent specialists. We arrange the visit, record the result and follow the remedial works through.",
      },
      { q: "How much does commercial carpentry cost in London?", a: `It depends on the job, the materials and the hours the site allows. ${PRICE_ANSWER}` },
      { q: "Do you work inside shopping centres?", a: CENTRES_ANSWER },
      { q: "Who carries out the work?", a: WHO_ANSWER },
      { q: "Do you take domestic carpentry?", a: DOMESTIC_ANSWER },
    ],
    related: [
      { href: "/london/commercial-handyman", label: "Commercial handyman" },
      { href: "/london/shop-fit-out", label: "Shop fit-out and opening works" },
      { href: "/london/commercial-painters-decorators", label: "Commercial painters and decorators" },
      { href: "/london/kiosk-installation", label: "Kiosk installation and repairs" },
      { href: "/london/emergency-repairs", label: "24-hour emergency repairs" },
    ],
    cta: {
      heading: "Joinery that needs repairing or building?",
      lede: "Send photographs and the address. We come back with a quote and a time that suits your trading hours.",
    },
    serviceType: "Commercial carpentry and joinery",
    emailSubject: "Quote request: commercial carpentry and joinery (London)",
  },

  /* ---------------------------------------------------------------- */
  {
    path: "/london/emergency-repairs",
    kind: "service",
    crumb: "Emergency repairs",
    title: "24 Hour Emergency Commercial Repairs London",
    description:
      "24-hour emergency repairs for shops and commercial premises in London: shutters, power, leaks, glazing, locks. Call 07852 224644. Made safe, then repaired.",
    eyebrow: "24-hour emergency line",
    h1: "24-hour emergency repairs for shops and commercial premises in London",
    lede: "A shutter that will not close, a leak over the shop floor, no power, a smashed shopfront, a door that will not lock: call 07852 224644 at any hour. MAINTSUPP takes the call, tells you the realistic attendance time, sends a vetted contractor to make the site safe, and arranges the permanent repair.",
    photo: {
      src: "/assets/pages/page-how-it-works-hero-v1.jpg",
      alt: "A coordinator in a headset working at two monitors that show a job board with coloured status columns",
    },
    cards: {
      eyebrow: "What we attend",
      heading: "The faults that cannot wait until morning",
      lede: "Emergency maintenance is reactive maintenance at its most urgent: the first visit makes the site safe, and the repair is finished after it.",
      items: [
        {
          title: "Shutters and doors",
          body: "Roller shutters stuck open or closed, doors that will not lock, failed closers and damaged entrances secured, and the shutter repair followed through.",
        },
        {
          title: "Electrical faults",
          body: "Loss of power, tripping boards, burning smells, failed lighting and unsafe illuminated signs made safe by qualified electrical contractors.",
        },
        {
          title: "Leaks and floods",
          body: "Leaks through ceilings, burst pipes, and blocked toilets and drains contained and repaired by a commercial plumber.",
        },
        {
          title: "Glazing and shopfronts",
          body: "Smashed or cracked shopfront glass made safe by emergency boarding up, with a glazier arranged to replace the pane once it is measured.",
        },
        {
          title: "Locks and security",
          body: "Lost keys, snapped keys, forced locks and break-in damage secured by a commercial locksmith.",
        },
        {
          title: "Heating, cooling and refrigeration",
          body: "Air conditioning, heating and display refrigeration failures attended, with stock-at-risk faults put first.",
        },
      ],
    },
    steps: {
      eyebrow: "What happens when you call",
      heading: "Four steps, and you know where you stand at each",
      items: [
        {
          title: "Call 07852 224644",
          body: "Any hour, any day. Tell us the site, the fault and whether anybody is at risk.",
        },
        {
          title: "We tell you what happens next",
          body: "The trade being sent, the realistic time to attend and how the call-out is charged — before you commit.",
        },
        {
          title: "Made safe",
          body: "The contractor attends, makes the site safe and secure, and photographs what they find.",
        },
        {
          title: "Permanent repair",
          body: "Parts, a return visit or a second trade are arranged and followed through until the job is finished.",
        },
      ],
    },
    points: {
      eyebrow: "Straight answers",
      heading: "What this service is, and is not",
      items: [
        "For commercial premises in London, at any hour of any day",
        "Vetted independent contractors: MAINTSUPP coordinates, it does not employ tradespeople",
        "No arrival time is promised that cannot be kept — you are told the realistic one on the call",
        "No contract needed: a single shop can call",
      ],
      note: "If anybody is in danger, call 999 first. If you smell gas, call the National Gas Emergency Service on 0800 111 999.",
    },
    faqs: [
      {
        q: "Is the emergency line answered 24 hours a day?",
        a: "Yes, for commercial premises in London. Call 07852 224644.",
      },
      {
        q: "How quickly can somebody attend?",
        a: "It depends on the trade, where the site is and the time of night. We give you the realistic time on the call, before you commit. We do not promise a fixed arrival time, because nobody can honestly keep one across every trade and postcode.",
      },
      {
        q: "What does an emergency call-out cost?",
        a: "You are told how the call-out is charged before anyone is sent. Clients on a monthly coordination plan pay the out-of-hours fee published on the pricing page, and the contractor’s own charge for the work.",
      },
      {
        q: "Do I need a contract to use the emergency line?",
        a: "No. A single shop, kiosk, restaurant or office can call for a one-off emergency.",
      },
      {
        q: "Will the repair be finished on the first visit?",
        a: "Not always. The first job is to make the site safe and secure. Where a part, a pane of glass or a second trade is needed, the permanent repair is arranged and followed through.",
      },
      {
        q: "Can you attend inside a shopping centre at night?",
        a: "Yes. Access is arranged with the centre’s security or management team, who control entry outside trading hours.",
      },
      { q: "Do you attend homes?", a: DOMESTIC_ANSWER },
    ],
    related: [
      { href: "/london/commercial-electrician", label: "Commercial electrician" },
      { href: "/london/commercial-handyman", label: "Commercial handyman" },
      { href: "/london/commercial-carpentry", label: "Commercial carpentry and joinery" },
      { href: "/london/shop-maintenance", label: "Retail and shop maintenance" },
      { href: "/london", label: "All London services" },
    ],
    cta: {
      heading: "Something broken right now?",
      lede: "Call the emergency line. For anything that can wait until the morning, send the details and we come back with a quote.",
    },
    serviceType: "Emergency commercial repairs",
    emailSubject: "Repair request (London)",
  },

  /* ---------------------------------------------------------------- */
  {
    path: "/london/shop-maintenance",
    kind: "service",
    crumb: "Retail and shop maintenance",
    title: "Retail & Shop Maintenance Services London",
    description:
      "Retail maintenance in London for shops, kiosks and stores: reactive repairs, planned maintenance and compliance. One-off jobs or a monthly plan per store.",
    eyebrow: "Retail maintenance",
    h1: "Retail and shop maintenance in London",
    lede: "Reactive repairs, planned maintenance and compliance for shops, kiosks and retail units across London. Use MAINTSUPP for one job, or put every store on a monthly plan with published per-store pricing — either way you deal with one coordinator and see the photo evidence before a job is closed.",
    photo: {
      src: "/assets/pages/page-services-hero-v1.jpg",
      alt: "A tradesperson in a hi-vis vest on a stepladder repairing an illuminated shopfront sign on a rain-wet high street at dusk",
    },
    cards: {
      eyebrow: "What we do",
      heading: "Everything a shop needs kept working",
      lede: "Retail maintenance, store maintenance, retail property maintenance: three names for the same list of things a shop needs kept working.",
      items: [
        {
          title: "Reactive repairs",
          body: "Shutters, doors, lighting, leaks, air conditioning, glazing and signage repaired when they fail, with one coordinator following the job to the end.",
          href: "/services",
          linkLabel: "All services",
        },
        {
          title: "Planned maintenance",
          body: "Planned preventative maintenance (PPM): servicing and recurring visits scheduled before faults become urgent, with reminders and an asset history.",
          href: "/services",
          linkLabel: "Planned maintenance",
        },
        {
          title: "Compliance administration",
          body: "A certificate register, due-date reminders and provider bookings. Inspections and certificates are carried out by competent certified providers.",
          href: "/services",
          linkLabel: "Compliance",
        },
        {
          title: "Store works",
          body: "Kiosk moves, refreshes, strip-outs and opening works, each scoped and quoted separately.",
          href: "/london/shop-fit-out",
          linkLabel: "Shop fit-out",
        },
        {
          title: "Emergency call-outs",
          body: "A line answered 24 hours a day for commercial premises in London.",
          href: "/london/emergency-repairs",
          linkLabel: "Emergency repairs",
        },
        {
          title: "Reporting",
          body: "A client portal and a monthly report on jobs, spend and compliance for stores on a plan.",
          href: "/how-it-works",
          linkLabel: "How it works",
        },
      ],
    },
    points: {
      eyebrow: "Two ways to use us",
      heading: "One job, or every store",
      items: [
        "One-off jobs: any shop, kiosk or retail unit in London, quoted before work starts",
        "Monthly multi-site coordination: portfolios of five sites and above, with the per-store rates published on the pricing page",
        "On a plan, contractors invoice you directly at their own rates, with no markup on trades",
        "Keep the contractors you already trust, and use the vetted network where you have no cover",
        "Photo evidence checked before any job is closed",
      ],
    },
    faqs: [
      {
        q: "Do you maintain single shops, or only chains?",
        a: "Both. A single shop or kiosk can book a one-off job. Portfolios of five sites and above can go on a monthly coordination plan.",
      },
      {
        q: "Who is responsible for shop repairs, the tenant or the landlord?",
        a: "It depends on the lease. In a shopping centre the tenant is commonly responsible for the inside of the unit and its shopfront, and the landlord for the structure and the shared systems, but leases differ. Check yours. On a plan we record who is responsible for what at each site, so a fault goes to the right party first time.",
      },
      {
        q: "What is the difference between reactive and planned maintenance?",
        a: "Reactive maintenance repairs something after it fails. Planned maintenance services it on a schedule so that it fails less often and the statutory checks are not missed. Most shops need both.",
      },
      {
        q: "Is this the same as facilities management?",
        a: "It is the maintenance side of facilities management: the repairs, the planned maintenance and the compliance visits, coordinated for retailers who have no facilities team of their own.",
      },
      {
        q: "Do you mark up contractors’ prices?",
        a: "On a monthly plan, no: the contractor invoices you directly at their agreed rate and MAINTSUPP charges its coordination fee and nothing on top. A one-off job is quoted before work starts.",
      },
      {
        q: "Can we keep our existing contractors?",
        a: "Yes. Your contractors or ours, and most portfolios run a mix. Existing contractors are onboarded on insurance, qualifications and documentation.",
      },
      {
        q: "How much does retail maintenance cost?",
        a: "The monthly per-store rates are published on the pricing page. A one-off job is quoted individually before work starts.",
      },
      { q: "Who carries out the work?", a: WHO_ANSWER },
      { q: "Do you work inside shopping centres?", a: CENTRES_ANSWER },
    ],
    related: [
      { href: "/pricing", label: "Pricing for monthly plans" },
      { href: "/how-it-works", label: "How a job runs" },
      { href: "/case-study", label: "Case study: 27 stores" },
      { href: "/london/emergency-repairs", label: "24-hour emergency repairs" },
      { href: "/london", label: "All London services" },
    ],
    cta: {
      heading: "One shop, or thirty?",
      lede: "Tell us the job, or how many stores you run. We come back with a quote or a plan.",
    },
    serviceType: "Retail and shop maintenance",
    emailSubject: "Enquiry: retail and shop maintenance (London)",
  },
];
