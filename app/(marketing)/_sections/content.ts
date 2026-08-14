/**
 * Marketing content — Stage 11, Group B.
 *
 * Ported verbatim from the JS data arrays inside the old public/landing.html.
 * The copy is the client's own and was not rewritten: the point of this stage
 * is to make it indexable, not to change what it says.
 */

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

