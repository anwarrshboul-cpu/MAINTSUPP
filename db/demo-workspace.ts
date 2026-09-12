/**
 * THE DEMONSTRATION WORKSPACE — a tenant that exists to be shown to people.
 *
 * ── WHY THIS IS NOT `app/lib/seed/` ────────────────────────────────────────
 *
 * The repository already holds a seed subsystem: `app/lib/seed/{dataset,loader,
 * reconcile,guards}.ts`, ~4,400 lines, deterministic, reconciled, and pointed
 * at `DEMO_ORGANISATION_ID` ("Demo Client Ltd"). None of it is reused here, for
 * three reasons, and each of them is a reason not to touch it:
 *
 *   1. It REFUSES TO RUN ON PRODUCTION, deliberately and with two independent
 *      guards (`guards.ts`), because every one of its actions — `seed`
 *      included — deletes before it writes. Those guards are the last thing
 *      standing between a purge and the client's real jobs. This file must
 *      never make them weaker, so it does not go near them.
 *   2. Its dataset is QA-shaped on purpose: every store is named `ZZ-DEMO — …`
 *      so that a row can never be mistaken for a real one. That is exactly
 *      right for a test estate and exactly wrong for a workspace shown to a
 *      prospective customer.
 *   3. Its target organisation is a CONSTANT, not a parameter — again
 *      deliberately, so a caller cannot point the loader at a client. Reusing
 *      it would mean either changing that or sharing a tenant with a purge.
 *
 * So this is a different thing with a different risk profile: **additive
 * only**. It contains no DELETE, no UPDATE of anything outside its own
 * organisation, and no purge. That is what makes it safe where the QA loader
 * correctly is not.
 *
 * ── WHY IT RUNS ON THE BOOT PATH ───────────────────────────────────────────
 *
 * `db/init.ts` is the product's own additive migration mechanism, and it is
 * already how the second tenant comes into existence on every deployment
 * including Production (`ensureDemoClientOrganisation`). Seeding here therefore
 * needs no credential, no one-off script and no data-writing admin route added
 * to a live product — the deployment that ships the code is the deployment that
 * has the workspace.
 *
 * The cost of living on a path that runs at every cold start is paid once:
 * `seedDemoWorkspaceData` opens with a single `SELECT 1 … LIMIT 1` against a
 * marker row and returns immediately once the workspace is populated. Every
 * statement is `INSERT OR IGNORE`, so an interrupted first run resumes instead
 * of duplicating, and a second run writes nothing.
 *
 * ── ISOLATION, WHICH IS THE WHOLE POINT ────────────────────────────────────
 *
 *   · every insert names `DEMO_WORKSPACE_ID` as a literal;
 *   · every row id begins `demo-`, so a demo row is identifiable from its
 *     primary key alone, with no new column and no join;
 *   · nothing here reads, updates or deletes a row belonging to any other
 *     organisation. The option-set copy that `ensureDemoClientOrganisation`
 *     performs is NOT repeated — this workspace builds its vocabulary from the
 *     product's own board specification, so no customer configuration is
 *     cloned either.
 *
 * ── NOTHING LEAVES THE BUILDING ────────────────────────────────────────────
 *
 * Every outbound effect in the product — mail, the reminder cascade, board
 * automations — lives in an API route handler or in `executeAction`. There are
 * no database triggers. Writing rows with the D1 handle therefore sends
 * nothing, queues nothing and fires nothing. Two further belts: a new
 * organisation has zero `board_automations` rows (nothing seeds any), and
 * `reminder_rules` are written only by the reminders repository, so a
 * compliance row created here gives the nightly cron nothing to dispatch.
 * Every contact address is `@example.com`, a reserved domain that cannot
 * receive mail, so even a misconfiguration has nowhere to send.
 *
 * ── EVERY DATE IS RELATIVE ─────────────────────────────────────────────────
 *
 * There is not one hardcoded calendar date below. A demo whose certificates all
 * expired in 2026 stops demonstrating anything the following year, and a
 * "due in 12 days" that silently becomes "overdue by 300" is worse than no
 * data. Offsets are in days from the boot date, so the workspace is as good on
 * its thousandth day as its first.
 */

import { getD1 } from ".";

/** The same handle `db/init.ts` works with; declared the same way it declares it. */
type D1DatabaseLike = Awaited<ReturnType<typeof getD1>>;

export const DEMO_WORKSPACE_ID = "org_maintsupp_demo_workspace";
export const DEMO_WORKSPACE_SLUG = "maintsupp-demo";
export const DEMO_WORKSPACE_NAME = "MAINTSUPP Demo";

/**
 * The lane finished work is filed in.
 *
 * The canonical board's 38 groups include 28 named after THIS estate's stores
 * ("Bluewater completed") and three dated month archives. `seedBoardStructure`
 * takes a subset for exactly that reason, and this workspace takes the six
 * operational lanes — the same set a Jobs section is created with. None of
 * those six is a completed lane, so one is added here, owned by this
 * organisation and no other.
 */
const DEMO_COMPLETED_GROUP = `demo-group-${DEMO_WORKSPACE_ID}-completed`;

/** `YYYY-MM-DD`, `offset` days from `today`. Negative is the past. */
function day(today: string, offset: number): string {
  const base = new Date(`${today}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}

/* ── The estate ───────────────────────────────────────────────────────────── */

/**
 * Eight fictional UK retail sites.
 *
 * Invented outright — the names, the streets and the postcodes belong to no
 * real business and no real address. They are ordinary enough to read as a real
 * portfolio in a demonstration, which is the requirement, and varied enough
 * (flagship, high-street store, kiosk, warehouse; six regions) that the Sites
 * register, the portfolio filters and the regional breakdowns all have
 * something to show.
 */
const DEMO_SITES: ReadonlyArray<{
  key: string;
  name: string;
  type: string;
  region: string;
  city: string;
  postcode: string;
  address: string;
  manager: string;
}> = [
  { key: "kingsway", name: "Kingsway Central", type: "Flagship", region: "London", city: "London", postcode: "EC2V 7JH", address: "14 Kingsway Parade, London", manager: "Priya Raman" },
  { key: "harbour", name: "Harbour Point", type: "Store", region: "South West", city: "Bristol", postcode: "BS1 5TY", address: "8 Harbour Point, Bristol", manager: "Daniel Okafor" },
  { key: "meadowbank", name: "Meadowbank", type: "Store", region: "Scotland", city: "Edinburgh", postcode: "EH8 7AE", address: "221 Meadowbank Row, Edinburgh", manager: "Iona Fraser" },
  { key: "castle", name: "Castle Quarter", type: "Kiosk", region: "East", city: "Norwich", postcode: "NR1 3DD", address: "Unit 12, Castle Quarter, Norwich", manager: "Tom Ellery" },
  { key: "riverside", name: "Riverside Walk", type: "Store", region: "North West", city: "Manchester", postcode: "M3 4LZ", address: "5 Riverside Walk, Manchester", manager: "Sofia Marchetti" },
  { key: "abbeygate", name: "Abbey Gate", type: "Store", region: "Yorkshire", city: "Leeds", postcode: "LS1 6QR", address: "44 Abbey Gate, Leeds", manager: "Callum Reid" },
  { key: "priory", name: "Priory Court", type: "Kiosk", region: "Wales", city: "Cardiff", postcode: "CF10 2HG", address: "Unit 3, Priory Court, Cardiff", manager: "Rhian Davies" },
  { key: "oldmill", name: "Old Mill Depot", type: "Warehouse", region: "Midlands", city: "Birmingham", postcode: "B7 4QN", address: "Old Mill Industrial Estate, Birmingham", manager: "Marcus Bell" },
];

/**
 * Seven fictional suppliers, one per trade the estate actually calls out.
 *
 * The trades match the vocabulary the product already offers on the contractor
 * application form, so the Contractors register filters by trade rather than by
 * free text.
 */
const DEMO_CONTRACTORS: ReadonlyArray<{
  key: string;
  name: string;
  trade: string;
  contact: string;
  phone: string;
}> = [
  { key: "brightwell", name: "Brightwell Electrical Services", trade: "Electrical", contact: "Alan Brightwell", phone: "0113 496 0118" },
  { key: "crestwood", name: "Crestwood Plumbing & Heating", trade: "Plumbing", contact: "Nia Crestwood", phone: "0117 496 0224" },
  { key: "halewood", name: "Halewood Refrigeration", trade: "Refrigeration", contact: "Peter Halewood", phone: "0161 496 0337" },
  { key: "stonebridge", name: "Stonebridge Fire & Security", trade: "Fire safety", contact: "Ruth Stonebridge", phone: "0131 496 0441" },
  { key: "vantage", name: "Vantage Facilities Cleaning", trade: "Cleaning", contact: "Owen Vantage", phone: "029 2049 0556" },
  { key: "ironside", name: "Ironside Shopfitting", trade: "Carpentry", contact: "Grace Ironside", phone: "0121 496 0669" },
  { key: "meridian", name: "Meridian Lift Services", trade: "Lifts", contact: "Sam Meridian", phone: "0203 496 0772" },
];

/**
 * The compliance requirements each site carries.
 *
 * Seven of the product's twelve certificate slots, named exactly as
 * `storeDocumentationCertificates` names them so the register groups them with
 * the real vocabulary rather than inventing an eighth spelling.
 */
const DEMO_REQUIREMENTS: readonly string[] = [
  "Fire Alarm",
  "Fire Extinguisher",
  "Emergency Lighting",
  "Electrical Wiring",
  "PAT Test",
  "Water Hygiene",
  "PLI",
];

/**
 * WHERE EACH REQUIREMENT SITS IN ITS LIFE, PER SITE.
 *
 * The register is only worth showing if it has something to say, so the spread
 * is designed rather than random: every band of the compliance dashboard has
 * members, one site is deliberately in poor shape, and one is perfect.
 *
 * The number is an offset in days from today for the expiry date; `null` means
 * the certificate has never been provided, which reads as Missing. Negative is
 * expired. The classifier recomputes state from this date — the stored `status`
 * column is never read as truth (`app/lib/compliance-status.ts`), so the date
 * is the only thing that decides what a reader sees.
 */
const DEMO_EXPIRY_OFFSETS: Readonly<Record<string, ReadonlyArray<number | null>>> = {
  /*                 Alarm  Exting  EmLight  Elec   PAT    Water   PLI   */
  kingsway:     [   210,   175,    140,    520,    95,    260,   300 ],
  harbour:      [    47,   320,     18,    610,   150,     73,   410 ],
  meadowbank:   [   280,    62,    205,    390,    26,    330,   250 ],
  castle:       [   -12,    88,    -40,    170,   115,   null,   190 ],
  riverside:    [   340,   240,    310,    700,   220,    180,   365 ],
  abbeygate:    [     9,   135,     55,    -21,    70,    290,   120 ],
  priory:       [  null,    31,    160,    240,  null,    145,    84 ],
  oldmill:      [   420,   380,    450,    560,   275,    400,   330 ],
};

/* ── The work ─────────────────────────────────────────────────────────────── */

type DemoJob = {
  key: string;
  site: string;
  title: string;
  description: string;
  location: string;
  category: string;
  trade: string;
  contractor: string | null;
  priority: string;
  /** `null` for work still open. Days ago the job was completed. */
  completedDaysAgo: number | null;
  /** Days from today the job is due. Past + open = overdue, on purpose. */
  dueInDays: number | null;
  /** Days ago the job was raised. */
  raisedDaysAgo: number;
  /** Pounds. `null` for open work that has not been priced. */
  cost: number | null;
  status: string;
  stage: string;
  group: string;
  tier: number;
};

/**
 * SEVENTY-SEVEN JOBS, SHAPED SO THE DASHBOARDS HAVE SOMETHING TRUE TO SAY.
 *
 * Written out rather than generated. A generator would be shorter and would
 * produce a portfolio nobody chose: the point of a demonstration estate is that
 * the numbers hang together — the overdue ones are the ones a manager would
 * actually be chasing, the expensive ones are the ones that would actually cost
 * that much, and the repeat visits are at the site whose refrigeration keeps
 * failing. That is a judgement per row, and it is why they are listed.
 *
 * The spread, by design:
 *   · 51 completed across the last twelve months, every one with a cost and a
 *     completion date, so the spend trend has twelve real months in it;
 *   · 26 open — of which 6 are overdue, 9 booked (two of them awaiting site
 *     access), 5 in progress, 2 on hold, and 4 newly reported and unapproved;
 *   · four priorities, eight categories, all eight sites, all seven suppliers.
 */
const DEMO_JOBS: readonly DemoJob[] = [
  /* ── Open: overdue ─────────────────────────────────────────────────────── */
  j("od1", "harbour", "Chiller cabinet losing temperature overnight", "Front-of-house chiller is reading 9°C each morning and recovering by mid-morning. Stock at risk.", "Shop floor — chiller run", "Refrigeration", "halewood", "High", null, -9, 24, null, "In Progress", "Attention", "needs-attention", 3),
  j("od2", "castle", "Emergency lighting failed monthly test", "Two of six emergency luminaires did not hold charge during the monthly drop test.", "Back corridor", "Fire safety", "stonebridge", "Urgent", null, -4, 16, null, "Awaiting parts", "Attention", "needs-attention", 4),
  j("od3", "abbeygate", "Main shutter jamming at three-quarter height", "Roller shutter stalls on the way down and has to be walked shut by hand.", "Front entrance", "Fabric", "ironside", "High", null, -15, 31, null, "Job Scheduled", "Booked", "jobs-booked", 3),
  j("od4", "priory", "Hot water intermittent at staff sink", "No hot water most mornings; returns by lunchtime. Reported twice.", "Staff area", "Plumbing", "crestwood", "Medium", null, -6, 19, null, "In Progress", "Attention", "needs-attention", 2),
  j("od5", "kingsway", "Lift 2 out of service", "Passenger lift 2 stopped between floors and has been isolated pending an engineer.", "Rear lift lobby", "Lifts", "meridian", "Urgent", null, -2, 11, null, "Job Scheduled", "Booked", "jobs-booked", 4),
  j("od6", "riverside", "Air curtain not running at main door", "Air curtain silent since the weekend; shop floor cold at the entrance.", "Main entrance", "HVAC", "brightwell", "Medium", null, -20, 38, null, "On Hold", "Attention", "needs-attention", 2),

  /* ── Open: booked ──────────────────────────────────────────────────────── */
  j("bk1", "meadowbank", "Annual fixed wire testing", "Five-yearly fixed wire inspection and certification.", "Whole site", "Compliance", "brightwell", "Medium", null, 12, 8, null, "Job Scheduled", "Booked", "jobs-booked", 5),
  j("bk2", "oldmill", "Loading bay door service", "Planned service of both loading bay doors and dock levellers.", "Loading bay", "Fabric", "ironside", "Low", null, 21, 14, null, "Job Scheduled", "Booked", "jobs-booked", 5),
  j("bk3", "kingsway", "Quarterly fire alarm inspection", "Scheduled quarterly inspection and log book sign-off.", "Whole site", "Compliance", "stonebridge", "Medium", null, 6, 9, null, "Job Scheduled", "Booked", "jobs-booked", 5),
  j("bk4", "harbour", "Deep clean — back of house", "Scheduled deep clean of prep areas, drains and staff facilities.", "Back of house", "Cleaning", "vantage", "Low", null, 18, 6, null, "Job Scheduled", "Booked", "jobs-booked", 5),
  j("bk5", "abbeygate", "Replace failed display lighting track", "Two metres of track lighting over the window display to be replaced.", "Window display", "Electrical", "brightwell", "Medium", null, 9, 12, null, "Job Scheduled", "Booked", "jobs-booked", 2),
  j("bk6", "riverside", "Six-monthly lift service", "Routine service and safety check on the goods lift.", "Goods lift", "Lifts", "meridian", "Medium", null, 27, 5, null, "Job Scheduled", "Booked", "jobs-booked", 5),
  j("bk7", "castle", "Water hygiene sampling visit", "Legionella risk sampling at the kiosk's two outlets.", "Whole site", "Compliance", "crestwood", "Medium", null, 15, 7, null, "Job Scheduled", "Booked", "jobs-booked", 5),

  /* ── Open: in progress, reported, held ─────────────────────────────────── */
  j("ip1", "oldmill", "Racking damage in aisle 4", "Upright leg struck by an MHE unit; bay off-loaded and cordoned.", "Warehouse aisle 4", "Fabric", "ironside", "High", null, 4, 10, null, "In Progress", "Attention", "needs-attention", 3),
  j("ip2", "meadowbank", "Till point socket tripping", "RCD trips when the second till is powered on.", "Till point 2", "Electrical", "brightwell", "High", null, 3, 5, null, "In Progress", "Attention", "needs-attention", 3),
  j("ip3", "kingsway", "Leak above stockroom ceiling tile", "Slow drip staining tiles; tray in place. Source not yet found.", "Stockroom", "Plumbing", "crestwood", "High", null, 2, 4, null, "In Progress", "Attention", "needs-attention", 3),
  j("ip4", "priory", "Shutter key switch replacement", "Key switch worn; shutter operable but unreliable.", "Front entrance", "Fabric", "ironside", "Medium", null, 13, 8, null, "In Progress", "Attention", "needs-attention", 2),
  j("ip5", "harbour", "Extraction fan noisy", "Kitchen extraction rattling at high speed.", "Prep kitchen", "HVAC", "brightwell", "Low", null, 25, 9, null, "In Progress", "Attention", "needs-attention", 1),
  j("rp1", "abbeygate", "Cracked floor tile at entrance", "Single cracked tile inside the entrance matting. Trip risk.", "Main entrance", "Fabric", null, "Medium", null, 20, 1, null, "Pending Approval", "Incoming", "topics", 2),
  j("rp2", "riverside", "Staff WC door will not latch", "Door catch worn, door swings open.", "Staff WC", "Fabric", null, "Low", null, 30, 2, null, "Pending Approval", "Incoming", "topics", 1),
  j("rp3", "castle", "Signage light flickering", "External fascia sign flickering after dark.", "Shopfront", "Electrical", null, "Low", null, 28, 3, null, "Pending Approval", "Incoming", "topics", 1),
  j("rp4", "oldmill", "Request for additional bike racks", "Staff request for two further bike racks in the yard.", "Yard", "Fabric", null, "Low", null, 45, 6, null, "Pending Approval", "Incoming", "topics", 1),
  j("hl1", "meadowbank", "Shopfront repaint — quote held", "Repaint quoted; held pending next capital cycle.", "Shopfront", "Fabric", "ironside", "Low", null, 60, 30, null, "On Hold", "Attention", "on-hold", 1),
  j("hl2", "priory", "Awaiting landlord approval for extract", "Extract upgrade needs landlord consent before ordering.", "Roof", "HVAC", "brightwell", "Medium", null, 40, 22, null, "On Hold", "Attention", "on-hold", 2),
  j("ac1", "kingsway", "Out-of-hours access for duct cleaning", "Access arrangements to be confirmed with centre management.", "Whole site", "Cleaning", "vantage", "Low", null, 35, 4, null, "Job Scheduled", "Booked", "access-requests", 1),
  j("ac2", "riverside", "Night works permit — electrical isolation", "Permit required for the main board isolation.", "Plant room", "Electrical", "brightwell", "Medium", null, 33, 7, null, "Job Scheduled", "Booked", "access-requests", 2),

  /* ── Completed: the last six months ────────────────────────────────────── */
  j("c01", "kingsway", "Replace failed ballast — ceiling grid", "Two failed ballasts replaced on the sales floor grid.", "Sales floor", "Electrical", "brightwell", "Medium", 6, null, 14, 285, "Job Completed", "Completed", "completed", 2),
  j("c02", "harbour", "Chiller compressor replacement", "Compressor replaced under planned works after repeated call-outs.", "Chiller run", "Refrigeration", "halewood", "High", 11, null, 22, 2450, "Job Completed", "Completed", "completed", 4),
  j("c03", "meadowbank", "Annual fire extinguisher service", "All twelve units serviced and tagged.", "Whole site", "Compliance", "stonebridge", "Medium", 18, null, 26, 340, "Job Completed", "Completed", "completed", 5),
  j("c04", "castle", "Kiosk shutter motor replacement", "Motor replaced and shutter realigned.", "Shopfront", "Fabric", "ironside", "High", 24, null, 33, 1180, "Job Completed", "Completed", "completed", 3),
  j("c05", "riverside", "Blocked drain — staff kitchen", "Drain jetted and trap cleared.", "Staff kitchen", "Plumbing", "crestwood", "High", 29, null, 31, 395, "Job Completed", "Completed", "completed", 3),
  j("c06", "abbeygate", "PAT testing — all portable appliances", "68 appliances tested; two failed and were withdrawn.", "Whole site", "Compliance", "brightwell", "Medium", 33, null, 40, 420, "Job Completed", "Completed", "completed", 5),
  j("c07", "oldmill", "Dock leveller hydraulic repair", "Hydraulic ram reseal on dock 2.", "Loading bay", "Fabric", "ironside", "Medium", 38, null, 45, 860, "Job Completed", "Completed", "completed", 3),
  j("c08", "priory", "Emergency lighting remedials", "Three luminaires replaced following the annual test.", "Whole site", "Fire safety", "stonebridge", "High", 42, null, 50, 510, "Job Completed", "Completed", "completed", 4),
  j("c09", "kingsway", "Lift 1 annual service", "Annual service and LOLER examination.", "Front lift", "Lifts", "meridian", "Medium", 47, null, 55, 1240, "Job Completed", "Completed", "completed", 5),
  j("c10", "harbour", "Chiller cabinet fan motor", "Evaporator fan motor replaced.", "Chiller run", "Refrigeration", "halewood", "High", 52, null, 56, 465, "Job Completed", "Completed", "completed", 3),
  j("c11", "meadowbank", "Window display rewire", "Display lighting rewired after the seasonal reset.", "Window display", "Electrical", "brightwell", "Low", 57, null, 66, 720, "Job Completed", "Completed", "completed", 2),
  j("c12", "riverside", "Quarterly deep clean", "Scheduled quarterly deep clean.", "Whole site", "Cleaning", "vantage", "Low", 61, null, 68, 640, "Job Completed", "Completed", "completed", 5),
  j("c13", "castle", "Fire alarm panel fault", "Zone 2 fault traced to a damaged detector base.", "Back corridor", "Fire safety", "stonebridge", "Urgent", 66, null, 67, 380, "Job Completed", "Completed", "completed", 4),
  j("c14", "abbeygate", "Leaking urinal — staff WC", "Flush valve replaced.", "Staff WC", "Plumbing", "crestwood", "Medium", 70, null, 76, 210, "Job Completed", "Completed", "completed", 2),
  j("c15", "oldmill", "Warehouse lighting upgrade — phase 1", "First bay converted to LED high bays.", "Warehouse", "Electrical", "brightwell", "Medium", 75, null, 95, 5400, "Job Completed", "Completed", "completed", 5),
  j("c16", "kingsway", "Air handling unit belt replacement", "Belts and filters replaced on AHU 1.", "Plant room", "HVAC", "brightwell", "Medium", 80, null, 88, 540, "Job Completed", "Completed", "completed", 5),
  j("c17", "priory", "Shopfront glass replacement", "Cracked pane replaced overnight.", "Shopfront", "Fabric", "ironside", "Urgent", 84, null, 85, 1320, "Job Completed", "Completed", "completed", 4),
  j("c18", "harbour", "Water hygiene — annual risk assessment", "Legionella risk assessment refreshed.", "Whole site", "Compliance", "crestwood", "Medium", 89, null, 98, 480, "Job Completed", "Completed", "completed", 5),
  j("c19", "meadowbank", "Till point socket replacement", "Two double sockets replaced at till points.", "Till points", "Electrical", "brightwell", "Medium", 94, null, 101, 260, "Job Completed", "Completed", "completed", 2),
  j("c20", "riverside", "Goods lift door adjustment", "Door timing adjusted after nuisance stops.", "Goods lift", "Lifts", "meridian", "Medium", 98, null, 104, 390, "Job Completed", "Completed", "completed", 3),
  j("c21", "castle", "Kiosk deep clean", "Full clean after the seasonal fit-out.", "Whole site", "Cleaning", "vantage", "Low", 103, null, 108, 230, "Job Completed", "Completed", "completed", 1),
  j("c22", "abbeygate", "Fire door remedial works", "Two fire doors adjusted and intumescent strips replaced.", "Back corridor", "Fire safety", "ironside", "High", 108, null, 116, 690, "Job Completed", "Completed", "completed", 4),
  j("c23", "oldmill", "Racking inspection remedials", "Three damaged beams replaced following the annual inspection.", "Warehouse", "Fabric", "ironside", "High", 112, null, 122, 1450, "Job Completed", "Completed", "completed", 4),
  j("c24", "kingsway", "Escalator handrail replacement", "Handrail replaced on the up escalator.", "Ground floor", "Lifts", "meridian", "Medium", 117, null, 128, 2100, "Job Completed", "Completed", "completed", 4),
  j("c25", "harbour", "Chiller gas top-up", "Refrigerant topped up and leak test carried out.", "Chiller run", "Refrigeration", "halewood", "Medium", 121, null, 125, 340, "Job Completed", "Completed", "completed", 3),
  j("c26", "priory", "Annual PAT testing", "31 appliances tested.", "Whole site", "Compliance", "brightwell", "Medium", 126, null, 133, 190, "Job Completed", "Completed", "completed", 5),
  j("c27", "meadowbank", "Roof leak repair", "Flashing resealed above the stockroom.", "Roof", "Fabric", "ironside", "High", 131, null, 136, 980, "Job Completed", "Completed", "completed", 4),
  j("c28", "riverside", "Emergency lighting annual test", "Three-hour discharge test and certification.", "Whole site", "Compliance", "stonebridge", "Medium", 135, null, 142, 410, "Job Completed", "Completed", "completed", 5),
  j("c29", "castle", "Extract fan replacement", "Failed extract fan replaced.", "Prep area", "HVAC", "brightwell", "Medium", 140, null, 147, 620, "Job Completed", "Completed", "completed", 3),
  j("c30", "abbeygate", "Shopfront deep clean", "External fascia and glazing cleaned.", "Shopfront", "Cleaning", "vantage", "Low", 144, null, 149, 180, "Job Completed", "Completed", "completed", 1),
  j("c31", "oldmill", "Sprinkler head replacement", "Two damaged heads replaced in the loading bay.", "Loading bay", "Fire safety", "stonebridge", "High", 149, null, 155, 560, "Job Completed", "Completed", "completed", 4),
  j("c32", "kingsway", "Fixed wire remedials — C2 items", "Six C2 items cleared following the fixed wire report.", "Whole site", "Electrical", "brightwell", "High", 153, null, 168, 3250, "Job Completed", "Completed", "completed", 5),
  j("c33", "harbour", "Cold room door seal", "Door seal replaced on the walk-in.", "Cold room", "Refrigeration", "halewood", "Medium", 158, null, 162, 275, "Job Completed", "Completed", "completed", 2),
  j("c34", "meadowbank", "Fire alarm annual service", "Annual service and certification.", "Whole site", "Compliance", "stonebridge", "Medium", 162, null, 170, 450, "Job Completed", "Completed", "completed", 5),
  j("c35", "priory", "Counter refit", "Serving counter rebuilt after water damage.", "Serving counter", "Fabric", "ironside", "Medium", 167, null, 181, 2650, "Job Completed", "Completed", "completed", 5),
  j("c36", "riverside", "Heating circulation pump", "Failed circulation pump replaced.", "Plant room", "Plumbing", "crestwood", "High", 171, null, 176, 840, "Job Completed", "Completed", "completed", 3),
  j("c37", "castle", "Public liability certificate renewal", "Renewal evidence collected and filed.", "Whole site", "Compliance", null, "Low", 176, null, 180, 0, "Job Completed", "Completed", "completed", 5),
  j("c38", "abbeygate", "Lighting control timer fault", "Timeclock replaced; schedule reset.", "Plant room", "Electrical", "brightwell", "Medium", 180, null, 186, 310, "Job Completed", "Completed", "completed", 2),
  j("c39", "oldmill", "Yard line marking", "Yard bays and walkways remarked.", "Yard", "Fabric", "ironside", "Low", 184, null, 192, 1150, "Job Completed", "Completed", "completed", 5),
  j("c40", "kingsway", "Quarterly deep clean", "Scheduled quarterly deep clean.", "Whole site", "Cleaning", "vantage", "Low", 172, null, 178, 890, "Job Completed", "Completed", "completed", 5),
  j("c41", "harbour", "Chiller controller replacement", "Failed controller replaced — third visit to this cabinet.", "Chiller run", "Refrigeration", "halewood", "High", 135, null, 139, 720, "Job Completed", "Completed", "completed", 3),

  /*
   * The year before last quarter. These exist so the spend trend has TWELVE
   * months in it rather than seven: a chart whose first five columns are empty
   * reads as a broken chart, not as a young workspace.
   */
  j("c42", "kingsway", "Annual fixed wire inspection", "Five-yearly fixed wire inspection across both floors.", "Whole site", "Compliance", "brightwell", "Medium", 198, null, 212, 2850, "Job Completed", "Completed", "completed", 5),
  j("c43", "riverside", "Shopfront sign replacement", "Illuminated fascia sign replaced after storm damage.", "Shopfront", "Fabric", "ironside", "High", 214, null, 224, 3400, "Job Completed", "Completed", "completed", 4),
  j("c44", "meadowbank", "Heating system service", "Annual service of the gas heating plant.", "Plant room", "HVAC", "crestwood", "Medium", 232, null, 240, 780, "Job Completed", "Completed", "completed", 5),
  j("c45", "oldmill", "Sprinkler annual certification", "Annual sprinkler inspection and certification.", "Whole site", "Compliance", "stonebridge", "Medium", 247, null, 255, 1340, "Job Completed", "Completed", "completed", 5),
  j("c46", "abbeygate", "Chiller relocation", "Cabinet relocated as part of the floor reset.", "Sales floor", "Refrigeration", "halewood", "Medium", 263, null, 278, 1980, "Job Completed", "Completed", "completed", 4),
  j("c47", "harbour", "Drainage survey", "CCTV survey following repeated blockages.", "Back of house", "Plumbing", "crestwood", "Medium", 279, null, 286, 640, "Job Completed", "Completed", "completed", 3),
  j("c48", "castle", "Kiosk fit-out snagging", "Snagging works after the kiosk fit-out.", "Whole site", "Fabric", "ironside", "Low", 294, null, 305, 1120, "Job Completed", "Completed", "completed", 2),
  j("c49", "priory", "Electrical remedials — C2", "Four C2 items cleared from the fixed wire report.", "Whole site", "Electrical", "brightwell", "High", 311, null, 322, 1460, "Job Completed", "Completed", "completed", 4),
  j("c50", "kingsway", "Escalator annual inspection", "Annual inspection of both escalators.", "Ground floor", "Lifts", "meridian", "Medium", 327, null, 336, 1890, "Job Completed", "Completed", "completed", 5),
  j("c51", "riverside", "Quarterly deep clean", "Scheduled quarterly deep clean.", "Whole site", "Cleaning", "vantage", "Low", 340, null, 346, 610, "Job Completed", "Completed", "completed", 5),
];

/**
 * THE ASSET REGISTER — three units per site.
 *
 * The Overview carries an "Active units" figure, and a demonstration estate
 * with no assets reads zero there however busy the rest of the workspace looks.
 * Each unit is the kind of plant the jobs above actually refer to, so the two
 * halves of the workspace describe the same building.
 */
const DEMO_UNITS: ReadonlyArray<{ name: string; category: string; make: string }> = [
  { name: "Multideck chiller", category: "Refrigeration", make: "Halewood HX-400" },
  { name: "Air handling unit", category: "HVAC", make: "Airflow AHU-2" },
  { name: "Distribution board", category: "Electrical", make: "Brightwell DB-12" },
];

/** A row, positionally, so the table above stays readable. */
function j(
  key: string,
  site: string,
  title: string,
  description: string,
  location: string,
  category: string,
  contractor: string | null,
  priority: string,
  completedDaysAgo: number | null,
  dueInDays: number | null,
  raisedDaysAgo: number,
  cost: number | null,
  status: string,
  stage: string,
  group: string,
  tier: number,
): DemoJob {
  return {
    key,
    site,
    title,
    description,
    location,
    category,
    trade: category,
    contractor,
    priority,
    completedDaysAgo,
    dueInDays,
    raisedDaysAgo,
    cost,
    status,
    stage,
    group,
    tier,
  };
}

/**
 * WHO THE REQUIREMENT BELONGS TO — and therefore whether it is scored.
 *
 * `countsTowardCompliance` scores `client` and NULL, and deliberately does not
 * score `landlord`, `centre` or `unconfirmed`: Maintsupp administers a
 * schedule, it does not claim responsibility for assets it was never given. The
 * vocabulary is lower-case and an unrecognised string counts as NOT scored, so
 * a capitalised "Landlord" silently removes a requirement from the percentage —
 * which is exactly what happened on the first run of this seed: all 56 rows
 * were excluded and the compliance gauge read "–" instead of a number.
 *
 * Most requirements are the client's, so the gauge has something to say. Three
 * are not, so the demonstration can show the distinction the product makes:
 * two landlord-owned insurance certificates, recorded and displayed but not
 * scored, and one requirement nobody has confirmed ownership of yet.
 */
function dutyHolderFor(siteKey: string, requirement: string): string {
  if (requirement === "PLI" && (siteKey === "priory" || siteKey === "castle")) return "landlord";
  if (requirement === "Water Hygiene" && siteKey === "oldmill") return "unconfirmed";
  return "client";
}

/* ── Writing it ───────────────────────────────────────────────────────────── */

const siteId = (key: string) => `demo-site-${key}`;
const contractorId = (key: string) => `demo-contractor-${key}`;
const jobId = (key: string) => `demo-job-${key}`;

/**
 * The organisation itself, and the owner's access to it.
 *
 * Called EARLY in `initialize()` — beside `ensureDemoClientOrganisation` and
 * before the stages whose `INSERT … SELECT … FROM organisations` fan out across
 * every active tenant. Sitting there is what gives this workspace its
 * `job_status_map`, `reminder_defaults`, `dashboard_meters`, form
 * configuration, `boards` row and Store Documentation board through the same
 * code path every other tenant uses, rather than through a copy of it.
 */
export async function ensureDemoWorkspaceOrganisation(d1: D1DatabaseLike): Promise<void> {
  await d1
    .prepare(
      `INSERT OR IGNORE INTO organisations (id, name, slug, primary_colour, plan_tier, status)
       VALUES (?, ?, ?, '#12B4A8', 'development', 'active')`,
    )
    .bind(DEMO_WORKSPACE_ID, DEMO_WORKSPACE_NAME, DEMO_WORKSPACE_SLUG)
    .run();

  /*
   * A membership for every super admin this database already has.
   *
   * `resolveTenantAccess` gives a `super_admin` every active organisation
   * regardless of membership, so the workspace switcher would already offer
   * this tenant with no row here at all. The row is written anyway, because
   * access that exists only as a consequence of a role is access nobody can
   * see: a membership makes it legible in the data, and makes a future
   * demo-only account a one-row change rather than a code change.
   *
   * It grants nothing that was not already granted, and it touches no other
   * organisation's memberships.
   */
  await d1
    .prepare(
      `INSERT OR IGNORE INTO memberships (id, user_id, organisation_id, role, status)
       SELECT 'demo-member-' || m.user_id, m.user_id, ?, 'super_admin', 'active'
         FROM memberships m
        WHERE m.role = 'super_admin' AND m.status = 'active'
        GROUP BY m.user_id`,
    )
    .bind(DEMO_WORKSPACE_ID)
    .run();
}

/**
 * Whether the workspace has already been filled in.
 *
 * One indexed primary-key lookup. This runs on the first request of every
 * instance for the life of the deployment, so it is the cheapest question that
 * answers "is there anything left to do".
 */
async function alreadySeeded(d1: D1DatabaseLike): Promise<boolean> {
  const row = (await d1
    .prepare("SELECT id FROM sites WHERE id = ? LIMIT 1")
    .bind(siteId(DEMO_SITES[DEMO_SITES.length - 1].key))
    .first()) as { id?: string } | null;
  return Boolean(row?.id);
}

/**
 * The demonstration data.
 *
 * Additive throughout: `INSERT OR IGNORE` only, every row owned by
 * `DEMO_WORKSPACE_ID`, and the single `UPDATE` is scoped to this
 * organisation's own board groups. Nothing here can alter a row belonging to
 * another tenant even if it were called with the wrong argument, because there
 * is no argument — the organisation is a constant.
 */
export async function seedDemoWorkspaceData(d1: D1DatabaseLike, today: string): Promise<void> {
  const demo = (await d1
    .prepare("SELECT id FROM organisations WHERE id = ? AND status = 'active' LIMIT 1")
    .bind(DEMO_WORKSPACE_ID)
    .first()) as { id?: string } | null;
  if (!demo?.id) return;
  if (await alreadySeeded(d1)) return;

  /*
   * The finished-work lane. The six operational groups come from
   * `seedBoardStructure`'s subset; none of them is a completed lane, and the
   * canonical board's completed lanes are named after another estate's stores.
   * Position 6 follows the six seeded lanes — `maintenance_groups` is unique on
   * (organisation, board, position).
   */
  await d1
    .prepare(
      `INSERT OR IGNORE INTO maintenance_groups
         (id, organisation_id, board_id, name, color, position, collapsed, archived, description, stage_key)
       VALUES (?, ?, 'maintenance', 'Completed work', '#00c875', 6, 0, 0, ?, 'Completed')`,
    )
    .bind(DEMO_COMPLETED_GROUP, DEMO_WORKSPACE_ID, "Work signed off in the last six months")
    .run();

  for (const site of DEMO_SITES) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO sites
           (id, organisation_id, name, type, site_type_value, region, lifecycle, status,
            address, address_line1, city, postcode, country, manager, manager_name,
            manager_email, manager_phone, slug, position, active)
         VALUES (?, ?, ?, ?, ?, ?, 'Current', 'active', ?, ?, ?, ?, 'United Kingdom', ?, ?, ?, ?, ?, ?, 1)`,
      )
      .bind(
        siteId(site.key),
        DEMO_WORKSPACE_ID,
        site.name,
        site.type,
        site.type,
        site.region,
        site.address,
        site.address,
        site.city,
        site.postcode,
        site.manager,
        site.manager,
        `${site.key}@example.com`,
        "0300 123 0000",
        site.key,
        DEMO_SITES.indexOf(site),
      )
      .run();
  }

  for (const contractor of DEMO_CONTRACTORS) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO contractors
           (id, organisation_id, name, contact_name, email, phone, service_categories,
            coverage_areas, certifications, availability, active, payment_terms)
         VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', 'Available', 1, '30 days')`,
      )
      .bind(
        contractorId(contractor.key),
        DEMO_WORKSPACE_ID,
        contractor.name,
        contractor.contact,
        `${contractor.key}@example.com`,
        contractor.phone,
        JSON.stringify([contractor.trade]),
      )
      .run();
  }

  for (const site of DEMO_SITES) {
    for (const [index, unit] of DEMO_UNITS.entries()) {
      await d1
        .prepare(
          `INSERT OR IGNORE INTO units
             (id, organisation_id, site_id, name, category, manufacturer, model,
              serial_number, status, location_in_site, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?)`,
        )
        .bind(
          `demo-unit-${site.key}-${index}`,
          DEMO_WORKSPACE_ID,
          siteId(site.key),
          unit.name,
          unit.category,
          unit.make.split(" ")[0],
          unit.make,
          `DEMO-${site.key.toUpperCase()}-${index + 1}`,
          "Plant room",
          index,
        )
        .run();
    }
  }

  for (const site of DEMO_SITES) {
    const offsets = DEMO_EXPIRY_OFFSETS[site.key] ?? [];
    for (const [index, requirement] of DEMO_REQUIREMENTS.entries()) {
      const offset = offsets[index];
      await d1
        .prepare(
          `INSERT OR IGNORE INTO compliance_documents
             (id, organisation_id, site_id, kind, status, expiry_date, issued_by, duty_holder)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `demo-compliance-${site.key}-${index}`,
          DEMO_WORKSPACE_ID,
          siteId(site.key),
          requirement,
          offset === null || offset === undefined ? "Missing" : "Compliant",
          offset === null || offset === undefined ? null : day(today, offset),
          offset === null || offset === undefined ? null : "Demo Compliance Partner",
          dutyHolderFor(site.key, requirement),
        )
        .run();
    }
  }

  for (const job of DEMO_JOBS) {
    const site = DEMO_SITES.find((entry) => entry.key === job.site);
    if (!site) continue;
    const supplier = job.contractor
      ? DEMO_CONTRACTORS.find((entry) => entry.key === job.contractor)
      : null;
    await d1
      .prepare(
        `INSERT OR IGNORE INTO maintenance_requests
           (id, organisation_id, site_id, source, title, description, location, requester,
            contact, category, engineer, tier, priority, stage, status, contractor,
            contractor_id, assignee, requested_at, due_at, completed_at, cost, archived,
            created_by_email, reference)
         VALUES (?, ?, ?, 'Portal form', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .bind(
        jobId(job.key),
        DEMO_WORKSPACE_ID,
        siteId(site.key),
        job.title,
        job.description,
        job.location,
        site.manager,
        `${site.key}@example.com`,
        job.category,
        job.trade,
        job.tier,
        job.priority,
        job.stage,
        job.status,
        supplier ? supplier.name : "",
        supplier ? contractorId(supplier.key) : null,
        supplier ? supplier.contact : "",
        day(today, -job.raisedDaysAgo),
        job.dueInDays === null ? null : day(today, job.dueInDays),
        job.completedDaysAgo === null ? null : day(today, -job.completedDaysAgo),
        job.cost,
        `${site.key}@example.com`,
        `DEMO-${job.key.toUpperCase()}`,
      )
      .run();

    await d1
      .prepare(
        `INSERT OR IGNORE INTO maintenance_group_items
           (request_id, organisation_id, board_id, group_id, position)
         VALUES (?, ?, 'maintenance', ?, ?)`,
      )
      .bind(
        jobId(job.key),
        DEMO_WORKSPACE_ID,
        job.group === "completed"
          ? DEMO_COMPLETED_GROUP
          : `seed-${DEMO_WORKSPACE_ID}-maintenance-${job.group}`,
        DEMO_JOBS.indexOf(job),
      )
      .run();
  }
}


/* ── The asset register ───────────────────────────────────────────────────── */

/**
 * THE ASSETS EACH DEMONSTRATION STORE IS FITTED WITH.
 *
 * Invented outright. Every brand below — Lumaflex, Voltarc, Wexford, Kestrel,
 * Aldermoor, Northgate — belongs to no real company, and every model and part
 * number is made up to look like one rather than to be one. Nothing here is
 * copied from a customer's estate, which is the rule the whole of this file is
 * written to.
 *
 * ── WHAT IT IS BUILT TO DEMONSTRATE ────────────────────────────────────────
 *
 * The catalogue is shaped by the questions the section exists to answer, so
 * each one has a visible answer on screen:
 *
 *   · "What exact LED strip does this store use?"  — a component with five
 *     typed specifications, a part number and a supplier.
 *   · "What transformer should we order?"          — the driver beneath it,
 *     with its own replacement part number and cost.
 *   · "What paint reference is on this kiosk?"     — a Reference-kind asset
 *     that is a specification rather than an object.
 *   · "What is inside the display cabinet?"        — a four-child parent, which
 *     is what the relationship model is for.
 *   · "What is about to fail?"                     — two per store carry
 *     `Needs replacement`, so the KPI tile and the filter have members.
 *   · "What did we use before?"                    — a replacement event on the
 *     driver, naming the part that came out.
 *
 * `parent` names another entry's `key` in this same list. Both rows are written
 * in one pass over one site, so the parent always exists by the time the child
 * references it, and both ids are derived from the same two strings.
 */
type DemoAsset = {
  key: string;
  name: string;
  kind: "equipment" | "component" | "replacement_part" | "reference";
  category: string;
  parent?: string;
  manufacturer?: string;
  model?: string;
  partNumber?: string;
  specification?: string;
  paintReference?: string;
  colour?: string;
  location: string;
  supplierKey?: string;
  supplierReference?: string;
  replacementPartNumber?: string;
  replacementModel?: string;
  replacementCostPence?: number;
  replacementNotes?: string;
  quantity?: number;
  /** `[name, value, unit]`, exactly the shape `parseSpecs` reads back. */
  specs?: ReadonlyArray<readonly [string, string, string]>;
  /** Sites whose copy of this asset is on borrowed time, by site key. */
  needsReplacementAt?: readonly string[];
};

const DEMO_ASSETS: readonly DemoAsset[] = [
  {
    key: "cabinet",
    name: "Front display cabinet",
    kind: "equipment",
    category: "Cabinetry & furniture",
    manufacturer: "Wexford Shopfitting",
    model: "WX-DC1800",
    partNumber: "WX-DC1800-OAK",
    location: "Front of house",
    supplierKey: "joinery",
    supplierReference: "WX-2231",
    specification: "1800mm three-bay glazed display cabinet, oak veneer, integrated lighting",
    specs: [
      ["Width", "1800", "mm"],
      ["Depth", "600", "mm"],
      ["Height", "2100", "mm"],
      ["Finish", "Oak veneer", ""],
    ],
  },
  {
    key: "ledstrip",
    parent: "cabinet",
    name: "LED strip — display cabinet",
    kind: "component",
    category: "Lighting",
    manufacturer: "Lumaflex",
    model: "LF-STRIP-3000",
    partNumber: "LF-STRIP-3000-IP20-5M",
    location: "Front of house",
    supplierKey: "electrical",
    supplierReference: "LUM-3000-5M",
    specification: "24V warm white LED tape, 5 metre reel, cut to 300mm multiples",
    replacementPartNumber: "LF-STRIP-3000-IP20-5M",
    replacementModel: "Lumaflex LF-STRIP-3000",
    replacementCostPence: 4250,
    replacementNotes:
      "Cut to 300mm multiples only. Order the 5m reel — the 2m reel is a different connector.",
    quantity: 3,
    specs: [
      ["Voltage", "24", "V"],
      ["Power", "14.4", "W/m"],
      ["Colour temperature", "3000", "K"],
      ["IP rating", "20", ""],
      ["Width", "10", "mm"],
    ],
    needsReplacementAt: ["castle", "priory"],
  },
  {
    key: "driver",
    parent: "cabinet",
    name: "LED driver / transformer",
    kind: "component",
    category: "Electrical",
    manufacturer: "Voltarc",
    model: "VT-LPV-60-24",
    partNumber: "VT-LPV-60-24",
    location: "Cabinet plinth",
    supplierKey: "electrical",
    supplierReference: "VLT-LPV6024",
    specification: "Constant-voltage LED driver, IP67 potted, screw terminals",
    replacementPartNumber: "VT-LPV-60-24",
    replacementModel: "Voltarc VT-LPV-60-24",
    replacementCostPence: 3180,
    replacementNotes: "Direct swap for the older VT-LPV-40-24. Do not fit the 12V unit.",
    specs: [
      ["Input voltage", "240", "V"],
      ["Output voltage", "24", "V"],
      ["Power", "60", "W"],
      ["IP rating", "67", ""],
    ],
  },
  {
    key: "lock",
    parent: "cabinet",
    name: "Cabinet lock",
    kind: "component",
    category: "Locks & security hardware",
    manufacturer: "Kestrel Hardware",
    model: "KH-CAM-22",
    partNumber: "KH-CAM-22-CP",
    location: "Front of house",
    supplierKey: "locksmith",
    supplierReference: "KES-CAM22",
    specification: "22mm cam lock, chrome plated, keyed alike across the cabinet run",
    replacementPartNumber: "KH-CAM-22-CP",
    replacementCostPence: 1150,
    replacementNotes: "Keyed alike — quote the suite number KA-4471 when ordering.",
    quantity: 3,
    specs: [
      ["Barrel length", "22", "mm"],
      ["Finish", "Chrome plated", ""],
      ["Keying", "Keyed alike KA-4471", ""],
    ],
  },
  {
    key: "hinge",
    parent: "cabinet",
    name: "Cabinet hinge",
    kind: "component",
    category: "Cabinetry & furniture",
    manufacturer: "Kestrel Hardware",
    model: "KH-CONC-110",
    partNumber: "KH-CONC-110-SC",
    location: "Front of house",
    supplierKey: "joinery",
    supplierReference: "KES-C110",
    specification: "110 degree concealed soft-close hinge, full overlay",
    replacementPartNumber: "KH-CONC-110-SC",
    replacementCostPence: 640,
    quantity: 6,
    specs: [
      ["Opening angle", "110", "deg"],
      ["Overlay", "Full", ""],
      ["Cup diameter", "35", "mm"],
    ],
  },
  {
    key: "ac",
    name: "Air conditioning indoor unit",
    kind: "equipment",
    category: "Air conditioning",
    manufacturer: "Northgate Climate",
    model: "NC-WM-12",
    partNumber: "NC-WM-12K-R32",
    location: "Shop floor, rear wall",
    supplierKey: "hvac",
    supplierReference: "NG-WM12",
    specification: "12,000 BTU wall-mounted split indoor unit",
    replacementPartNumber: "NC-FLT-12",
    replacementNotes: "Filters are the replaceable part — the unit itself is a specialist job.",
    replacementCostPence: 2400,
    specs: [
      ["Cooling capacity", "12000", "BTU"],
      ["Refrigerant", "R32", ""],
      ["Noise", "38", "dB"],
    ],
    needsReplacementAt: ["oldmill"],
  },
  {
    key: "accontrol",
    parent: "ac",
    name: "Air conditioning wall controller",
    kind: "component",
    category: "Air conditioning",
    manufacturer: "Northgate Climate",
    model: "NC-CTRL-3",
    partNumber: "NC-CTRL-3W",
    location: "Shop floor, rear wall",
    supplierKey: "hvac",
    specification: "Wired wall controller with weekly schedule and lockout",
    replacementPartNumber: "NC-CTRL-3W",
    replacementCostPence: 8900,
    specs: [
      ["Supply", "12", "V"],
      ["Cable", "4-core shielded", ""],
    ],
  },
  {
    key: "paint",
    name: "Shop floor wall paint",
    kind: "reference",
    category: "Paint & finishes",
    manufacturer: "Aldermoor Paints",
    model: "Durable Matt",
    paintReference: "AP 7016 Anthracite",
    colour: "Anthracite grey",
    location: "Shop floor",
    supplierKey: "decorating",
    supplierReference: "ALD-7016-M",
    specification: "Scrubbable matt emulsion. Two coats over the existing finish.",
    specs: [
      ["Finish", "Matt", ""],
      ["Coverage", "12", "m2/L"],
      ["Coats", "2", ""],
    ],
  },
  {
    key: "tap",
    name: "Back-of-house mixer tap",
    kind: "equipment",
    category: "Plumbing",
    manufacturer: "Brackenhall",
    model: "BH-MX-200",
    partNumber: "BH-MX-200-CH",
    location: "Staff kitchen",
    supplierKey: "plumbing",
    specification: "Single-lever monobloc mixer, chrome, 1/2 inch tails",
    replacementPartNumber: "BH-CART-35",
    replacementNotes: "The cartridge fails long before the tap. Order the 35mm cartridge first.",
    replacementCostPence: 1490,
    specs: [
      ["Cartridge", "35", "mm"],
      ["Connection", "1/2", "in"],
    ],
  },
  {
    key: "screen",
    name: "Window display screen",
    kind: "equipment",
    category: "Displays & AV",
    manufacturer: "Vantis Display",
    model: "VD-43-COM",
    partNumber: "VD-43-COM-P",
    location: "Window bay",
    supplierKey: "av",
    supplierReference: "VAN-43P",
    specification: "43 inch commercial portrait display, 24/7 rated, 700 nits",
    replacementPartNumber: "VD-PSU-43",
    replacementNotes: "Power supply is the usual failure. Panel replacement is a warranty claim.",
    replacementCostPence: 7600,
    specs: [
      ["Diagonal", "43", "in"],
      ["Brightness", "700", "nits"],
      ["Orientation", "Portrait", ""],
    ],
  },
  {
    key: "shutter",
    name: "Shopfront shutter motor",
    kind: "equipment",
    category: "Doors & shutters",
    manufacturer: "Thorne Access",
    model: "TA-RS-180",
    partNumber: "TA-RS-180-M",
    location: "Shopfront",
    supplierKey: "shutters",
    supplierReference: "THA-RS180",
    specification: "180Nm tubular shutter motor with manual override",
    replacementPartNumber: "TA-RS-180-M",
    replacementCostPence: 31500,
    replacementNotes: "Specialist fit. The override crank is a separate part, TA-CRANK-2.",
    specs: [
      ["Torque", "180", "Nm"],
      ["Supply", "240", "V"],
      ["Tube", "70", "mm"],
    ],
  },
  {
    key: "handle",
    name: "Entrance door handle",
    kind: "component",
    category: "Doors & shutters",
    manufacturer: "Kestrel Hardware",
    model: "KH-PULL-600",
    partNumber: "KH-PULL-600-SS",
    location: "Main entrance",
    supplierKey: "locksmith",
    specification: "600mm stainless back-to-back pull handle",
    replacementPartNumber: "KH-PULL-600-SS",
    replacementCostPence: 4300,
    specs: [
      ["Length", "600", "mm"],
      ["Finish", "Satin stainless", ""],
    ],
  },
  {
    key: "sparelock",
    name: "Spare cabinet lock (held on site)",
    kind: "replacement_part",
    category: "Locks & security hardware",
    manufacturer: "Kestrel Hardware",
    model: "KH-CAM-22",
    partNumber: "KH-CAM-22-CP",
    location: "Stock room",
    supplierKey: "locksmith",
    specification: "Held against the display cabinet run. Suite KA-4471.",
    quantity: 2,
    specs: [["Keying", "Keyed alike KA-4471", ""]],
  },
];

const assetId = (site: string, key: string) => `demo-asset-${site}-${key}`;

/**
 * WHICH DEMONSTRATION SUPPLIER SUPPLIES WHAT.
 *
 * The contractor rows this workspace already seeds are maintenance providers,
 * and several of them legitimately also supply the parts they fit — which is
 * exactly the case `supplier_contractor_id` exists for. Where a trade has no
 * matching contractor the asset carries a typed supplier name instead, which
 * is the other half of the same design.
 *
 * Resolved by TRADE rather than by a hardcoded contractor key, so this cannot
 * drift if the contractor list above is edited.
 */
const DEMO_ASSET_SUPPLIERS: Readonly<Record<string, string>> = {
  electrical: "Electrical",
  locksmith: "Carpentry",
  shutters: "Carpentry",
  joinery: "Carpentry",
  plumbing: "Plumbing",
  /*
   * `hvac`, `decorating` and `av` deliberately map to nothing. This workspace's
   * seven contractors do not include an air-conditioning firm, a decorator or
   * an AV installer, and inventing a link to the nearest one would be a lie in
   * the demonstration data. Those assets carry a typed supplier name and no
   * link — which is the other half of the supplier model, and worth showing.
   */
};

/**
 * Whether this workspace's assets have already been written.
 *
 * A SECOND guard, separate from `alreadySeeded`, and that separation is the
 * whole reason this is its own exported function rather than more lines at the
 * end of `seedDemoWorkspaceData`. That function returns early once the
 * workspace has sites — which it already does, on every deployment that has
 * booted since the workspace shipped — so assets appended inside it would never
 * have been written to any database that already exists.
 *
 * One indexed primary-key lookup on the last asset of the last site, for the
 * same reason its sibling is: this runs on the first request of every instance
 * for the life of the deployment.
 */
async function assetsAlreadySeeded(d1: D1DatabaseLike): Promise<boolean> {
  const row = (await d1
    .prepare("SELECT id FROM units WHERE id = ? LIMIT 1")
    .bind(
      assetId(
        DEMO_SITES[DEMO_SITES.length - 1].key,
        DEMO_ASSETS[DEMO_ASSETS.length - 1].key,
      ),
    )
    .first()) as { id?: string } | null;
  return Boolean(row?.id);
}

/**
 * The demonstration asset register, and the history behind two of its rows.
 *
 * Additive throughout and on the same terms as the rest of this file:
 * `INSERT OR IGNORE` only, `DEMO_WORKSPACE_ID` named as a literal in every
 * statement, every id beginning `demo-`, and no argument naming an
 * organisation — so it cannot be pointed at a client even by mistake.
 *
 * Dates are offsets from the boot date, never calendar dates, so an install
 * date does not drift into reading as absurd and a replacement recorded "eight
 * months ago" stays eight months ago for ever.
 */
export async function seedDemoWorkspaceAssets(
  d1: D1DatabaseLike,
  today: string,
): Promise<void> {
  const demo = (await d1
    .prepare("SELECT id FROM organisations WHERE id = ? AND status = 'active' LIMIT 1")
    .bind(DEMO_WORKSPACE_ID)
    .first()) as { id?: string } | null;
  if (!demo?.id) return;
  if (await assetsAlreadySeeded(d1)) return;

  /*
   * The suppliers, resolved once. A contractor whose trade matches an asset's
   * becomes a real `supplier_contractor_id`; the rest fall back to the typed
   * name. Read rather than assumed because a contractor row may have been
   * edited, and a dangling link is worse than no link.
   */
  const supplierByTrade = new Map<string, { id: string; name: string }>();
  for (const contractor of DEMO_CONTRACTORS) {
    supplierByTrade.set(contractor.trade, {
      id: contractorId(contractor.key),
      name: contractor.name,
    });
  }

  /*
   * The three trades with no contractor behind them still have a supplier —
   * they simply have a NAME and no link, which is the case the free-text half
   * of the supplier model exists for and the case worth demonstrating.
   */
  const unlinkedSupplier: Readonly<Record<string, string>> = {
    hvac: "Northgate Climate Direct",
    decorating: "Aldermoor Paints Trade Counter",
    av: "Vantis Display Supply",
  };

  for (const [siteIndex, site] of DEMO_SITES.entries()) {
    for (const [index, asset] of DEMO_ASSETS.entries()) {
      const trade = asset.supplierKey ? DEMO_ASSET_SUPPLIERS[asset.supplierKey] : undefined;
      const supplier = trade ? supplierByTrade.get(trade) : undefined;
      const needsReplacement = (asset.needsReplacementAt ?? []).includes(site.key);

      await d1
        .prepare(
          `INSERT OR IGNORE INTO units
             (id, organisation_id, site_id, name, category, kind, status,
              manufacturer, model, serial_number, part_number, asset_number,
              specification, colour, paint_reference, specs, quantity,
              location_in_site, installed_at, warranty_expiry,
              supplier, supplier_contractor_id, supplier_reference, supplier_url,
              replacement_part_number, replacement_model, replacement_notes,
              replacement_cost_pence, parent_unit_id, position,
              created_by_email, updated_by_email)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          assetId(site.key, asset.key),
          DEMO_WORKSPACE_ID,
          siteId(site.key),
          asset.name,
          asset.category,
          asset.kind,
          needsReplacement ? "Needs replacement" : "Active",
          asset.manufacturer ?? null,
          asset.model ?? null,
          `DEMO-${site.key.toUpperCase()}-${asset.key.toUpperCase()}`,
          asset.partNumber ?? null,
          /* A demonstration reference rather than the live counter: these rows
             are written straight to the table, and taking numbers from
             `organisations.asset_sequence` here would leave the workspace's own
             next asset starting at 97. */
          `AST-9${String(siteIndex * 100 + index).padStart(5, "0")}`,
          asset.specification ?? null,
          asset.colour ?? null,
          asset.paintReference ?? null,
          JSON.stringify(
            (asset.specs ?? []).map(([key, value, unit]) => ({ key, value, unit })),
          ),
          asset.quantity ?? null,
          asset.location,
          day(today, -420 - index * 11),
          day(today, 300 - index * 17),
          supplier?.name ?? (asset.supplierKey ? unlinkedSupplier[asset.supplierKey] ?? null : null),
          supplier?.id ?? null,
          asset.supplierReference ?? null,
          /* `example.com` is reserved and resolves to nothing anywhere, which
             is what makes it safe to put in a link a demonstration audience
             will click. */
          asset.supplierReference
            ? `https://parts.example.com/${asset.supplierReference.toLowerCase()}`
            : null,
          asset.replacementPartNumber ?? null,
          asset.replacementModel ?? null,
          asset.replacementNotes ?? null,
          asset.replacementCostPence ?? null,
          asset.parent ? assetId(site.key, asset.parent) : null,
          index,
          "demo@example.com",
          "demo@example.com",
        )
        .run();
    }
  }

  /*
   * THE HISTORY, which is the half that proves the point.
   *
   * Two events per store on the LED driver: the original install, and the
   * replacement that superseded it. `previous_detail` names the part that came
   * out — a model the asset row no longer carries anywhere, because the row now
   * describes what is fitted today. That is precisely the fact this table
   * exists to keep, and the one an overwrite of `model` would have destroyed.
   */
  for (const site of DEMO_SITES) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO unit_service_records
           (id, organisation_id, unit_id, site_id, performed_at, event_type,
            service_type, contractor_name, outcome, cost_pence,
            previous_detail, replacement_detail, notes, recorded_by_email)
         VALUES (?, ?, ?, ?, ?, 'Installed', 'Installation', ?, 'Completed', ?, NULL, ?, ?, ?)`,
      )
      .bind(
        `demo-asset-event-${site.key}-driver-install`,
        DEMO_WORKSPACE_ID,
        assetId(site.key, "driver"),
        siteId(site.key),
        day(today, -1180),
        "Brightwell Electrical Services",
        3180,
        "Voltarc VT-LPV-40-24",
        "Fitted with the cabinet at first fit-out.",
        "demo@example.com",
      )
      .run();

    await d1
      .prepare(
        `INSERT OR IGNORE INTO unit_service_records
           (id, organisation_id, unit_id, site_id, performed_at, event_type,
            service_type, contractor_name, outcome, cost_pence,
            previous_detail, replacement_detail, notes, recorded_by_email)
         VALUES (?, ?, ?, ?, ?, 'Replaced', 'Callout', ?, 'Completed', ?, ?, ?, ?, ?)`,
      )
      .bind(
        `demo-asset-event-${site.key}-driver-replaced`,
        DEMO_WORKSPACE_ID,
        assetId(site.key, "driver"),
        siteId(site.key),
        day(today, -240),
        "Brightwell Electrical Services",
        3180,
        "Voltarc VT-LPV-40-24 (40W) — failed after flickering",
        "Voltarc VT-LPV-60-24 (60W)",
        "Uprated to 60W. The 40W unit was at its limit with the third bay added.",
        "demo@example.com",
      )
      .run();

    await d1
      .prepare(
        `INSERT OR IGNORE INTO unit_service_records
           (id, organisation_id, unit_id, site_id, performed_at, event_type,
            service_type, contractor_name, outcome, cost_pence,
            previous_detail, replacement_detail, notes, recorded_by_email)
         VALUES (?, ?, ?, ?, ?, 'Serviced', 'Annual', ?, 'Completed', ?, NULL, NULL, ?, ?)`,
      )
      .bind(
        `demo-asset-event-${site.key}-ac-serviced`,
        DEMO_WORKSPACE_ID,
        assetId(site.key, "ac"),
        siteId(site.key),
        day(today, -95),
        "Brightwell Electrical Services",
        14500,
        "Annual service. Filters cleaned, gas pressure within range.",
        "demo@example.com",
      )
      .run();
  }
}
