import type { LandingCard, LandingFaq, LandingPage } from "./types.ts";

/**
 * THE LONDON HUB, THE THREE PRIORITY CENTRES AND THE FOUR AREAS.
 *
 * THE ORDER IS THE OWNER'S. North London first, then East, then West, and South
 * last; and above all of them the three centres that matter most — Westfield
 * Stratford City, Westfield London at White City, and Brent Cross. The hub lists
 * the areas in that order and every "related" list follows it.
 *
 * WHAT IS CLAIMED ABOUT A CENTRE, AND WHAT IS NOT.
 *
 *   - MAINTSUPP HAS coordinated jobs inside all three priority centres. The
 *     owner confirmed each one on 4 October 2026, so each page says so. No other
 *     centre is described as somewhere the company has worked: the area pages
 *     say which centres it TAKES jobs at, which is a statement about the service
 *     area and not about history.
 *   - MAINTSUPP IS NOT an approved, nominated or authorised contractor of any
 *     centre, and no page says or implies it. A centre keeps its own list. The
 *     pages say the opposite, in an FAQ, because the question is asked.
 *   - A centre's rules are described as what centres USUALLY ask for. They are
 *     set by each centre's management and they change; nothing here quotes a
 *     rule as if it were that centre's published requirement.
 *   - No store counts, floor areas or owners. They move, and a page that names a
 *     landlord who sold last quarter is wrong in a way a reader notices.
 *
 * WHY THE AREA PAGES ARE NOT FOUR COPIES OF ONE PAGE. The earlier keyword map
 * refused city pages for exactly that reason: "do not generate six noun-swapped
 * pages". Each area page here carries what is different about that area — its
 * boroughs, its named centres and streets, and its priority centre — and shares
 * only the services, which are the same everywhere because they are.
 */

const TRADES: readonly LandingCard[] = [
  {
    title: "Repairs and emergencies",
    body: "Shutters, doors, lighting, leaks, glazing and locks, with a line answered 24 hours a day.",
    href: "/london/emergency-repairs",
    linkLabel: "24-hour emergency repairs",
  },
  {
    title: "Kiosks, stalls and RMUs",
    body: "Installed, connected, repaired, relocated and removed, overnight and under the centre’s permit.",
    href: "/london/kiosk-installation",
    linkLabel: "Kiosk installation and removal",
  },
  {
    title: "Electricians",
    body: "Shop lighting, faults, emergency lighting, sign power and testing by qualified electrical contractors.",
    href: "/london/commercial-electrician",
    linkLabel: "Commercial electrician",
  },
  {
    title: "Handyman, carpentry and decorating",
    body: "The small repairs, the joinery and the painting that keep a unit presentable.",
    href: "/london/commercial-handyman",
    linkLabel: "Commercial handyman",
  },
  {
    title: "Closing a unit",
    body: "Strip-out, fixture and sign removal, clearance and making good before handback.",
    href: "/london/shop-strip-out",
    linkLabel: "Shop strip-out",
  },
  {
    title: "Opening a unit",
    body: "Electrics, decorating, fixtures, signage and snagging before opening day.",
    href: "/london/shop-fit-out",
    linkLabel: "Shop fit-out",
  },
];

const CENTRE_STEPS = (centre: string): readonly LandingCard[] => [
  {
    title: "Before the job",
    body: `We confirm with ${centre}’s management what the works need. Typically that is a risk assessment and method statement, proof of insurance and a permit for out-of-hours works.`,
  },
  {
    title: "Access",
    body: "Works and deliveries are booked for outside trading hours, through the service yard and corridors rather than across the mall.",
  },
  {
    title: "On the night",
    body: "Contractors sign in with the centre’s security, work inside the permitted window, and leave the unit and the mall clean.",
  },
  {
    title: "Afterwards",
    body: "You receive before and after photographs and any certificates. The job is closed only when the evidence has been checked.",
  },
];

const centreFaqs = (centre: string, owner: string): readonly LandingFaq[] => [
  {
    q: `Are you an approved contractor at ${centre}?`,
    a: `MAINTSUPP is independent of ${owner} and of the centre’s management, and works for the tenant. Each job is carried out under the centre’s own permit and access rules, and anything the centre reserves for its own nominated contractors stays with them.`,
  },
  {
    q: `Have you worked at ${centre} before?`,
    a: "Yes. MAINTSUPP has coordinated jobs inside the centre for an existing retail client.",
  },
  {
    q: `Can you install or remove a kiosk at ${centre}?`,
    a: "Yes: installation, electrical connection, repairs, relocation and removal, normally overnight. The space itself is licensed by the centre or its letting agent; we do the physical works once you have it.",
  },
  {
    q: "Do you only work for chains?",
    a: "No. A single shop or kiosk can book a one-off job. Portfolios of five sites and above can go on a monthly coordination plan.",
  },
  {
    q: "Can you attend in an emergency?",
    a: "Yes. The emergency line, 07852 224644, is answered 24 hours a day. Out of trading hours, entry is arranged with the centre’s security team.",
  },
  {
    q: "How is a job priced?",
    a: "Each job is quoted individually, and you have the price before any work is booked.",
  },
  {
    q: "Who carries out the work?",
    a: "Vetted independent contractors. MAINTSUPP does not employ tradespeople: it checks each contractor’s insurance and competence, briefs them, follows the job and checks the evidence before the job is closed.",
  },
];

const AREA_FAQ_TAIL: readonly LandingFaq[] = [
  {
    q: "Do you take one-off jobs?",
    a: "Yes. A single shop, kiosk, restaurant or office can book one job. Portfolios of five sites and above can go on a monthly coordination plan.",
  },
  {
    q: "Is there an emergency line?",
    a: "Yes. 07852 224644 is answered 24 hours a day for commercial premises in London. You are told the realistic attendance time before you commit.",
  },
  {
    q: "Do you work on homes?",
    a: "No. MAINTSUPP works for commercial premises only.",
  },
  {
    q: "Who carries out the work?",
    a: "Vetted independent contractors. MAINTSUPP does not employ tradespeople: it checks each contractor’s insurance and competence, briefs them, follows the job and checks the evidence before the job is closed.",
  },
];

export const PLACE_PAGES: readonly LandingPage[] = [
  /* ---------------------------------------------------------------- */
  /* The hub                                                           */
  /* ---------------------------------------------------------------- */
  {
    path: "/london",
    kind: "hub",
    crumb: "London",
    title: "Commercial Property Maintenance London, 24/7",
    description:
      "One call for shop repairs, commercial trades, kiosk installs and strip-outs across London. Vetted contractors, 24/7 emergency call-outs, commercial only.",
    eyebrow: "London",
    h1: "Commercial property maintenance in London, for shops, kiosks and shopping centres",
    lede: "MAINTSUPP coordinates repairs, trades and store works for commercial premises across London — one job at a single shop or kiosk, or every site you run. One point of contact, vetted independent contractors, photo evidence on every job, and an emergency line answered 24 hours a day.",
    photo: {
      src: "/assets/pages/service-planned-v1.jpg",
      alt: "A technician in a hard hat checking a tablet beside rooftop air-conditioning plant above the London skyline",
    },
    cards: {
      eyebrow: "What we take on",
      heading: "Services for commercial premises in London",
      lede: "Each is available as a one-off job, quoted before work starts.",
      items: [
        {
          title: "24-hour emergency repairs",
          body: "Shutters, power, leaks, glazing and locks made safe at any hour, then repaired properly.",
          href: "/london/emergency-repairs",
        },
        {
          title: "Kiosk installation and removal",
          body: "Kiosks, stalls and RMUs installed, connected, relocated and removed in shopping centres.",
          href: "/london/kiosk-installation",
        },
        {
          title: "Shop strip-out",
          body: "Closing a unit: fixtures and signs out, waste cleared, the unit made good for handback.",
          href: "/london/shop-strip-out",
        },
        {
          title: "Shop fit-out",
          body: "Opening a unit: electrics, decorating, fixtures, signage and snagging before opening day.",
          href: "/london/shop-fit-out",
        },
        {
          title: "Commercial electrician",
          body: "Shop lighting, faults, emergency lighting, sign power, EICR and PAT testing.",
          href: "/london/commercial-electrician",
        },
        {
          title: "Commercial handyman",
          body: "Doors, shelving, ceilings, signs and snag lists, done around your trading hours.",
          href: "/london/commercial-handyman",
        },
        {
          title: "Commercial painters and decorators",
          body: "Shop floors, shopfronts and offices painted overnight or before opening.",
          href: "/london/commercial-painters-decorators",
          linkLabel: "Painters and decorators",
        },
        {
          title: "Commercial carpentry and joinery",
          body: "Counters, till points, doors, shelving and partitions repaired or built.",
          href: "/london/commercial-carpentry",
          linkLabel: "Carpentry and joinery",
        },
        {
          title: "Retail and shop maintenance",
          body: "Reactive repairs, planned maintenance and compliance, one-off or on a monthly plan.",
          href: "/london/shop-maintenance",
        },
      ],
    },
    places: {
      eyebrow: "Where we work",
      heading: "Three priority centres, and every part of London",
      lede: "MAINTSUPP has coordinated jobs inside Westfield Stratford City, Westfield London and Brent Cross. Beyond them we take jobs across Greater London, area by area.",
      items: [
        { name: "Westfield Stratford City", where: "Stratford, E20", href: "/london/westfield-stratford-city" },
        { name: "Westfield London", where: "White City, W12", href: "/london/westfield-london-white-city" },
        { name: "Brent Cross Shopping Centre", where: "Hendon, NW4", href: "/london/brent-cross" },
        { name: "North London", where: "Barnet, Brent, Camden, Enfield, Haringey, Harrow, Islington", href: "/london/north-london" },
        { name: "East London", where: "Newham, Tower Hamlets, Hackney, Waltham Forest, Redbridge, Havering", href: "/london/east-london" },
        { name: "West London", where: "Hammersmith and Fulham, Kensington and Chelsea, Ealing, Hounslow, Hillingdon", href: "/london/west-london" },
        { name: "South London", where: "Wandsworth, Lambeth, Southwark, Lewisham, Bromley, Croydon, Kingston", href: "/london/south-london" },
      ],
    },
    steps: {
      eyebrow: "How a job runs",
      heading: "One contact, from the first call to the photographs",
      items: [
        {
          title: "Tell us the job",
          body: "Call, or email the address, the fault or the works, and a few photographs.",
        },
        {
          title: "We quote",
          body: "You have the price before any work is booked. For an emergency you are told how the call-out is charged before anyone is sent.",
        },
        {
          title: "Access is arranged",
          body: "Centre permits, method statements, insurance documents and the out-of-hours window are handled for you.",
        },
        {
          title: "Done, and evidenced",
          body: "A vetted contractor does the work. You receive before and after photographs, and the job is closed only when the evidence is checked.",
        },
      ],
    },
    faqs: [
      {
        q: "Do you take one-off jobs, or only contracts?",
        a: "Both. A single shop, kiosk, restaurant or office in London can book one job, quoted before work starts. Portfolios of five sites and above can go on a monthly coordination plan with per-store pricing published on the pricing page.",
      },
      {
        q: "Which parts of London do you cover?",
        a: "All of Greater London. The priority centres are Westfield Stratford City, Westfield London at White City and Brent Cross, and the work is organised by area: North London, East London, West London and South London.",
      },
      {
        q: "Do you work inside shopping centres?",
        a: "Yes. Works inside a centre are done under its own permit and access rules, usually outside trading hours. MAINTSUPP has already coordinated jobs inside Westfield Stratford City, Westfield London and Brent Cross.",
      },
      {
        q: "Is the emergency line really open 24 hours?",
        a: "Yes, for commercial premises in London. Call 07852 224644. We tell you the realistic attendance time before you commit, and the first priority is making the site safe.",
      },
      {
        q: "Who carries out the work?",
        a: "Vetted independent contractors. MAINTSUPP does not employ tradespeople: it checks each contractor’s insurance and competence, briefs them, follows the job and checks the evidence before the job is closed. You deal with one coordinator throughout.",
      },
      {
        q: "How is a one-off job priced?",
        a: "Each job is quoted individually, and you have the price before any work is booked.",
      },
      {
        q: "Do you work on homes?",
        a: "No. MAINTSUPP works for commercial premises only: shops, kiosks, restaurants, offices, gyms and clinics.",
      },
    ],
    related: [
      { href: "/services", label: "All services" },
      { href: "/pricing", label: "Pricing for monthly plans" },
      { href: "/how-it-works", label: "How a job runs" },
      { href: "/case-study", label: "Case study: 27 stores" },
      { href: "/contact", label: "Contact us" },
    ],
    cta: {
      heading: "A job in London?",
      lede: "Call for an emergency. For anything else, tell us the address and the job and we come back with a quote.",
    },
    serviceType: "Commercial property maintenance",
    emailSubject: "Quote request (London)",
  },

  /* ---------------------------------------------------------------- */
  /* The three priority centres                                        */
  /* ---------------------------------------------------------------- */
  {
    path: "/london/westfield-stratford-city",
    kind: "centre",
    crumb: "Westfield Stratford City",
    title: "Westfield Stratford Shop & Kiosk Maintenance",
    description:
      "Shop and kiosk maintenance at Westfield Stratford City, E20: repairs, electricians, kiosk installs and strip-outs, overnight under the centre’s permit rules.",
    eyebrow: "Westfield Stratford City, E20",
    h1: "Shop and kiosk maintenance at Westfield Stratford City",
    lede: "Repairs, trades, kiosk installs and store works for retailers trading at Westfield Stratford City. MAINTSUPP has coordinated jobs inside the centre for an existing retail client, so the permit, access and out-of-hours routine is familiar ground. One-off jobs are welcome, and the emergency line is answered 24 hours a day.",
    photo: {
      src: "/assets/pages/service-projects-v1.jpg",
      alt: "A fitting team installing a glass display kiosk in a shopping centre, one fitting a panel while another checks a drawing",
    },
    cards: {
      eyebrow: "What we do here",
      heading: "For shops, kiosks and restaurants in the centre",
      lede: "Westfield Stratford City is in Stratford, London E20, beside Stratford station and Queen Elizabeth Olympic Park.",
      items: TRADES,
    },
    steps: {
      eyebrow: "Working in the centre",
      heading: "How a job runs at Westfield Stratford City",
      items: CENTRE_STEPS("Westfield Stratford City"),
    },
    points: {
      eyebrow: "Before work starts",
      heading: "What a centre of this size usually asks for",
      items: [
        "A risk assessment and method statement (RAMS) for the work",
        "Proof of public liability insurance",
        "A permit for out-of-hours works, applied for in advance",
        "A booked delivery or loading bay slot",
        "Test records for any electrical item that plugs in",
      ],
      note: "The centre’s management sets its own requirements and changes them. We confirm the current ones for every job rather than assume.",
    },
    faqs: centreFaqs("Westfield Stratford City", "Westfield"),
    related: [
      { href: "/london/east-london", label: "East London" },
      { href: "/london/westfield-london-white-city", label: "Westfield London, White City" },
      { href: "/london/brent-cross", label: "Brent Cross" },
      { href: "/london/kiosk-installation", label: "Kiosk installation and removal" },
      { href: "/london", label: "All London services" },
    ],
    cta: {
      heading: "A job at Westfield Stratford City?",
      lede: "Tell us the unit and the job. We confirm what the centre will need and come back with a quote.",
    },
    serviceType: "Shop and kiosk maintenance",
    place: { name: "Westfield Stratford City", streetAddress: "Montfichet Road, Olympic Park", postalCode: "E20 1EJ" },
    emailSubject: "Quote request: Westfield Stratford City",
  },

  {
    path: "/london/westfield-london-white-city",
    kind: "centre",
    crumb: "Westfield London, White City",
    title: "Westfield London (White City) Shop & Kiosk Works",
    description:
      "Shop and kiosk maintenance at Westfield London, White City W12: repairs, electricians, kiosk installs, fit-out and strip-out, overnight under centre rules.",
    eyebrow: "Westfield London, White City, W12",
    h1: "Shop and kiosk maintenance at Westfield London, White City",
    lede: "For retailers trading at Westfield London in White City: repairs when something fails, the trades a unit needs, and the works to open, move or close a shop or kiosk. MAINTSUPP has coordinated jobs inside the centre and arranges the permits, the paperwork and the overnight access for each one.",
    photo: {
      src: "/assets/pages/case-work-v1.jpg",
      alt: "A contractor in a hi-vis vest carrying a toolbag into a shopping centre while checking the job on his phone",
    },
    cards: {
      eyebrow: "What we do here",
      heading: "For shops, kiosks and restaurants in the centre",
      lede: "Westfield London is at White City in Shepherd’s Bush, London W12, close to Shepherd’s Bush, Wood Lane and White City stations.",
      items: TRADES,
    },
    steps: {
      eyebrow: "Working in the centre",
      heading: "How a job runs at Westfield London",
      items: CENTRE_STEPS("Westfield London"),
    },
    points: {
      eyebrow: "What to send us",
      heading: "To quote for a job at Westfield London",
      items: [
        "The unit or kiosk, and where it is in the centre",
        "The job: a fault, a list of repairs, or the works you are planning",
        "Photographs or a short video",
        "Your dates, and any trading-hours limits",
        "Anything centre management has already told you about the works",
      ],
    },
    faqs: centreFaqs("Westfield London", "Westfield"),
    related: [
      { href: "/london/west-london", label: "West London" },
      { href: "/london/westfield-stratford-city", label: "Westfield Stratford City" },
      { href: "/london/brent-cross", label: "Brent Cross" },
      { href: "/london/shop-fit-out", label: "Shop fit-out and opening works" },
      { href: "/london", label: "All London services" },
    ],
    cta: {
      heading: "A job at Westfield London?",
      lede: "Tell us the unit and the job. We confirm what the centre will need and come back with a quote.",
    },
    serviceType: "Shop and kiosk maintenance",
    place: { name: "Westfield London", streetAddress: "Ariel Way, White City", postalCode: "W12 7GF" },
    emailSubject: "Quote request: Westfield London, White City",
  },

  {
    path: "/london/brent-cross",
    kind: "centre",
    crumb: "Brent Cross",
    title: "Brent Cross Shop & Kiosk Maintenance Contractors",
    description:
      "Shop and kiosk maintenance at Brent Cross Shopping Centre, NW4: repairs, electricians, handyman, kiosk installs and strip-outs. One-off jobs, 24/7 emergencies.",
    eyebrow: "Brent Cross Shopping Centre, NW4",
    h1: "Shop and kiosk maintenance at Brent Cross Shopping Centre",
    lede: "Brent Cross is our priority centre in North London. MAINTSUPP has coordinated jobs inside it, and takes repairs, trades, kiosk works and shop openings and closures for the retailers who trade there — one job at a time, or as part of a plan across every store you run.",
    photo: {
      src: "/assets/pages/page-case-study-hero-v1.jpg",
      alt: "A tradesperson adjusting a spotlight on a dark green and gold fragrance kiosk in a shopping centre",
    },
    cards: {
      eyebrow: "What we do here",
      heading: "For shops, kiosks and restaurants in the centre",
      lede: "Brent Cross Shopping Centre is in Hendon, London NW4, beside the North Circular, with Brent Cross and Hendon Central stations on the Northern line and Brent Cross West on Thameslink.",
      items: TRADES,
    },
    steps: {
      eyebrow: "Working in the centre",
      heading: "How a job runs at Brent Cross",
      items: CENTRE_STEPS("Brent Cross"),
    },
    points: {
      eyebrow: "Why retailers here use us",
      heading: "One contact for every trade",
      items: [
        "One-off jobs welcome: no contract and no minimum number of stores",
        "Contractors’ insurance and competence checked before any work is released",
        "Permits, method statements and out-of-hours access arranged with centre management",
        "Before and after photographs on every job",
        "The same coordinator for your other North London stores",
      ],
    },
    faqs: centreFaqs("Brent Cross", "Brent Cross’s owners"),
    related: [
      { href: "/london/north-london", label: "North London" },
      { href: "/london/westfield-stratford-city", label: "Westfield Stratford City" },
      { href: "/london/westfield-london-white-city", label: "Westfield London, White City" },
      { href: "/london/commercial-electrician", label: "Commercial electrician" },
      { href: "/london", label: "All London services" },
    ],
    cta: {
      heading: "A job at Brent Cross?",
      lede: "Tell us the unit and the job. We confirm what the centre will need and come back with a quote.",
    },
    serviceType: "Shop and kiosk maintenance",
    place: { name: "Brent Cross Shopping Centre", streetAddress: "Prince Charles Drive", postalCode: "NW4 3FP" },
    emailSubject: "Quote request: Brent Cross",
  },

  /* ---------------------------------------------------------------- */
  /* The four areas, in the owner's order                              */
  /* ---------------------------------------------------------------- */
  {
    path: "/london/north-london",
    kind: "area",
    crumb: "North London",
    title: "Shop & Commercial Maintenance North London",
    description:
      "Shop repairs, commercial trades and kiosk works across North London: Brent Cross, Wood Green, Edgware, Barnet, Enfield, Harrow, Wembley. 24/7 emergency line.",
    eyebrow: "North London",
    h1: "Shop and commercial maintenance in North London",
    lede: "Repairs, commercial trades, kiosk installs and store works for shops and commercial premises across North and North-West London — Barnet, Brent, Camden, Enfield, Haringey, Harrow and Islington — with Brent Cross as the priority centre.",
    photo: {
      src: "/assets/pages/page-services-hero-v1.jpg",
      alt: "A tradesperson in a hi-vis vest on a stepladder repairing an illuminated shopfront sign on a rain-wet high street at dusk",
    },
    cards: {
      eyebrow: "What we do",
      heading: "Services for North London’s shops and commercial premises",
      items: TRADES,
    },
    places: {
      eyebrow: "Where we work",
      heading: "Shopping centres and high streets in North London",
      lede: "MAINTSUPP takes jobs at shops and kiosks in these centres, and on the high streets between them.",
      items: [
        { name: "Brent Cross Shopping Centre", where: "Hendon, NW4", href: "/london/brent-cross" },
        { name: "The Mall Wood Green", where: "Wood Green, N22" },
        { name: "The Broadwalk Centre", where: "Edgware, HA8" },
        { name: "The Spires", where: "Barnet, EN5" },
        { name: "Palace Gardens and Palace Exchange", where: "Enfield, EN2" },
        { name: "Edmonton Green Shopping Centre", where: "Edmonton, N9" },
        { name: "Angel Central", where: "Islington, N1" },
        { name: "Nag’s Head Shopping Centre", where: "Holloway, N7" },
        { name: "Coal Drops Yard", where: "King’s Cross, N1C" },
        { name: "London Designer Outlet", where: "Wembley Park, HA9" },
        { name: "St Anns and St George’s", where: "Harrow, HA1" },
        { name: "High streets", where: "Camden, Finchley, Holloway Road, Kilburn, Muswell Hill and Wembley" },
      ],
    },
    faqs: [
      {
        q: "Which parts of North London do you cover?",
        a: "The boroughs of Barnet, Brent, Camden, Enfield, Haringey, Harrow and Islington, including Brent Cross, Wood Green, Edgware, Barnet, Enfield, Edmonton, Holloway, King’s Cross, Wembley and Harrow.",
      },
      {
        q: "Do you work at Brent Cross?",
        a: "Yes. Brent Cross is the priority centre in North London, and MAINTSUPP has coordinated jobs inside it.",
      },
      ...AREA_FAQ_TAIL,
    ],
    related: [
      { href: "/london/brent-cross", label: "Brent Cross" },
      { href: "/london/east-london", label: "East London" },
      { href: "/london/west-london", label: "West London" },
      { href: "/london/south-london", label: "South London" },
      { href: "/london", label: "All London services" },
    ],
    cta: {
      heading: "A job in North London?",
      lede: "Call for an emergency. For anything else, tell us the address and the job and we come back with a quote.",
    },
    serviceType: "Shop and commercial maintenance",
    emailSubject: "Quote request (North London)",
  },

  {
    path: "/london/east-london",
    kind: "area",
    crumb: "East London",
    title: "Shop & Commercial Maintenance East London",
    description:
      "Shop repairs, commercial trades and kiosk works across East London: Westfield Stratford City, Canary Wharf, Ilford, Romford, Walthamstow. 24/7 emergency line.",
    eyebrow: "East London",
    h1: "Shop and commercial maintenance in East London",
    lede: "Repairs, commercial trades, kiosk installs and store works for shops and commercial premises across East London — Newham, Tower Hamlets, Hackney, Waltham Forest, Redbridge, Barking and Dagenham, and Havering — with Westfield Stratford City as the priority centre.",
    photo: {
      src: "/assets/pages/service-reactive-v1.jpg",
      alt: "A tradesperson kneeling at a shop entrance to repair a jammed roller shutter, with an open toolbox and phone beside him",
    },
    cards: {
      eyebrow: "What we do",
      heading: "Services for East London’s shops and commercial premises",
      items: TRADES,
    },
    places: {
      eyebrow: "Where we work",
      heading: "Shopping centres and high streets in East London",
      lede: "MAINTSUPP takes jobs at shops and kiosks in these centres, and on the high streets between them.",
      items: [
        { name: "Westfield Stratford City", where: "Stratford, E20", href: "/london/westfield-stratford-city" },
        { name: "Stratford Centre", where: "Stratford, E15" },
        { name: "Canary Wharf shopping malls", where: "Canary Wharf, E14" },
        { name: "The Exchange", where: "Ilford, IG1" },
        { name: "The Liberty, The Brewery and The Mercury", where: "Romford, RM1" },
        { name: "17&Central", where: "Walthamstow, E17" },
        { name: "Kingsland Shopping Centre", where: "Dalston, E8" },
        { name: "Gallions Reach Shopping Park", where: "Beckton, E6" },
        { name: "Lakeside", where: "Thurrock, Essex, just outside London" },
        { name: "High streets", where: "Barking, Bethnal Green, East Ham, Green Street, Hackney and Leytonstone" },
      ],
    },
    faqs: [
      {
        q: "Which parts of East London do you cover?",
        a: "The boroughs of Newham, Tower Hamlets, Hackney, Waltham Forest, Redbridge, Barking and Dagenham, and Havering, including Stratford, Canary Wharf, Ilford, Romford, Walthamstow, Dalston and Beckton.",
      },
      {
        q: "Do you work at Westfield Stratford City?",
        a: "Yes. It is the priority centre in East London, and MAINTSUPP has coordinated jobs inside it.",
      },
      ...AREA_FAQ_TAIL,
    ],
    related: [
      { href: "/london/westfield-stratford-city", label: "Westfield Stratford City" },
      { href: "/london/north-london", label: "North London" },
      { href: "/london/west-london", label: "West London" },
      { href: "/london/south-london", label: "South London" },
      { href: "/london", label: "All London services" },
    ],
    cta: {
      heading: "A job in East London?",
      lede: "Call for an emergency. For anything else, tell us the address and the job and we come back with a quote.",
    },
    serviceType: "Shop and commercial maintenance",
    emailSubject: "Quote request (East London)",
  },

  {
    path: "/london/west-london",
    kind: "area",
    crumb: "West London",
    title: "Shop & Commercial Maintenance West London",
    description:
      "Shop repairs, commercial trades and kiosk works across West London: Westfield London at White City, Hammersmith, Ealing, Uxbridge. 24/7 emergency line.",
    eyebrow: "West London",
    h1: "Shop and commercial maintenance in West London",
    lede: "Repairs, commercial trades, kiosk installs and store works for shops and commercial premises across West London — Hammersmith and Fulham, Kensington and Chelsea, Ealing, Hounslow and Hillingdon — with Westfield London at White City as the priority centre.",
    photo: {
      src: "/assets/pages/trade-cctv-v1.jpg",
      alt: "A tradesperson on a stepladder adjusting a ceiling-mounted camera beside a store entrance with an access-control keypad",
    },
    cards: {
      eyebrow: "What we do",
      heading: "Services for West London’s shops and commercial premises",
      items: TRADES,
    },
    places: {
      eyebrow: "Where we work",
      heading: "Shopping centres and high streets in West London",
      lede: "MAINTSUPP takes jobs at shops and kiosks in these centres, and on the high streets between them.",
      items: [
        { name: "Westfield London", where: "White City, W12", href: "/london/westfield-london-white-city" },
        { name: "Livat Hammersmith", where: "Hammersmith, W6" },
        { name: "Ealing Broadway Shopping Centre", where: "Ealing, W5" },
        { name: "The Chimes and The Pavilions", where: "Uxbridge, UB8" },
        { name: "High streets", where: "Chiswick, Fulham, Hounslow, Kensington High Street, King’s Road and Southall" },
      ],
    },
    faqs: [
      {
        q: "Which parts of West London do you cover?",
        a: "The boroughs of Hammersmith and Fulham, Kensington and Chelsea, Ealing, Hounslow and Hillingdon, including White City, Shepherd’s Bush, Hammersmith, Kensington, Chiswick, Ealing and Uxbridge.",
      },
      {
        q: "Do you work at Westfield London in White City?",
        a: "Yes. It is the priority centre in West London, and MAINTSUPP has coordinated jobs inside it.",
      },
      ...AREA_FAQ_TAIL,
    ],
    related: [
      { href: "/london/westfield-london-white-city", label: "Westfield London, White City" },
      { href: "/london/north-london", label: "North London" },
      { href: "/london/east-london", label: "East London" },
      { href: "/london/south-london", label: "South London" },
      { href: "/london", label: "All London services" },
    ],
    cta: {
      heading: "A job in West London?",
      lede: "Call for an emergency. For anything else, tell us the address and the job and we come back with a quote.",
    },
    serviceType: "Shop and commercial maintenance",
    emailSubject: "Quote request (West London)",
  },

  {
    path: "/london/south-london",
    kind: "area",
    crumb: "South London",
    title: "Shop & Commercial Maintenance South London",
    description:
      "Shop repairs, commercial trades and kiosk works across South London: Battersea, Wandsworth, Kingston, Croydon, Bromley, Lewisham. 24/7 emergency line.",
    eyebrow: "South London",
    h1: "Shop and commercial maintenance in South London",
    lede: "Repairs, commercial trades, kiosk installs and store works for shops and commercial premises across South London — Wandsworth, Lambeth, Southwark, Lewisham, Greenwich, Bromley, Croydon, Kingston, Merton and Sutton.",
    photo: {
      src: "/assets/pages/service-compliance-v1.jpg",
      alt: "A technician testing an emergency light beside a red fire alarm panel in a back-of-house corridor",
    },
    cards: {
      eyebrow: "What we do",
      heading: "Services for South London’s shops and commercial premises",
      items: TRADES,
    },
    places: {
      eyebrow: "Where we work",
      heading: "Shopping centres and high streets in South London",
      lede: "MAINTSUPP takes jobs at shops and kiosks in these centres, and on the high streets between them.",
      items: [
        { name: "Battersea Power Station", where: "Battersea, SW11" },
        { name: "Southside", where: "Wandsworth, SW18" },
        { name: "Bentall Centre", where: "Kingston, KT1" },
        { name: "Centrale and the Whitgift Centre", where: "Croydon, CR0" },
        { name: "The Glades", where: "Bromley, BR1" },
        { name: "Lewisham Shopping Centre", where: "Lewisham, SE13" },
        { name: "Wimbledon Quarter", where: "Wimbledon, SW19" },
        { name: "Putney Exchange", where: "Putney, SW15" },
        { name: "St Nicholas Centre", where: "Sutton, SM1" },
        { name: "Broadway Shopping Centre", where: "Bexleyheath, DA6" },
        { name: "Bluewater", where: "Greenhithe, Kent, just outside London" },
        { name: "High streets", where: "Brixton, Clapham, Peckham, Streatham, Tooting and Woolwich" },
      ],
    },
    faqs: [
      {
        q: "Which parts of South London do you cover?",
        a: "The boroughs of Wandsworth, Lambeth, Southwark, Lewisham, Greenwich, Bromley, Croydon, Kingston, Merton and Sutton, including Battersea, Wimbledon, Putney, Kingston, Croydon, Bromley, Lewisham and Sutton.",
      },
      {
        q: "Do you work inside shopping centres in South London?",
        a: "Yes. Works inside a centre are done under its own permit and access rules, usually outside trading hours, and we arrange the paperwork and the access for each job.",
      },
      ...AREA_FAQ_TAIL,
    ],
    related: [
      { href: "/london/north-london", label: "North London" },
      { href: "/london/east-london", label: "East London" },
      { href: "/london/west-london", label: "West London" },
      { href: "/london/kiosk-installation", label: "Kiosk installation and removal" },
      { href: "/london", label: "All London services" },
    ],
    cta: {
      heading: "A job in South London?",
      lede: "Call for an emergency. For anything else, tell us the address and the job and we come back with a quote.",
    },
    serviceType: "Shop and commercial maintenance",
    emailSubject: "Quote request (South London)",
  },
];
