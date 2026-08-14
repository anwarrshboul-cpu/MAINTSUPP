/**
 * Demo data for development.
 *
 * A script, not a migration. Migrations define the schema and run everywhere;
 * this fills a local database with something worth looking at, and must never
 * run against a client's production data. Every row it writes carries
 * `is_demo = true`, so `delete from organisations where is_demo` clears it in
 * one statement when the real portfolio arrives.
 *
 * Idempotent: it keys on the job reference-free natural fields and bails if the
 * demo jobs are already present, so re-running does not multiply the board.
 *
 * Run:  node packages/db/src/seed-demo.ts
 * Note: PGlite is SINGLE-PROCESS. Stop the API server before running this
 *       against `.pglite`, or it will fail to acquire the data directory.
 */
import { getDb, type Db } from "./client.ts";

type JobSpec = {
  title: string;
  description: string;
  site: string;
  status: string;
  priority: "Urgent" | "Medium" | "Low";
  engineer: "Plummer" | "Electrician" | "Handyman" | "Other";
  fault: string;
  tier: number;
  requestedBy: string;
  phone: string;
  daysAgo: number;
  costPence?: number;
};

/*
 * Spread deliberately across all seven stages and all three priorities.
 *
 * A demo board where everything sits in one column hides exactly the bugs the
 * queue tabs and the stage grouping are there to have: an empty column that
 * should not be empty looks identical to one that is correctly empty.
 */
const JOBS: JobSpec[] = [
  {
    title: "Front shutter jammed open",
    description: "The roller shutter will not close. The store cannot be secured overnight.",
    site: "Aldgate – Whitechapel Road", status: "Escalated", priority: "Urgent",
    engineer: "Handyman", fault: "Locks", tier: 1,
    requestedBy: "Dana Okafor", phone: "07700 900123", daysAgo: 2,
  },
  {
    title: "Water ingress under the sink",
    description: "Slow leak from the staff WC feed. A bucket is catching it for now.",
    site: "Birmingham – Bullring", status: "Job In Progress", priority: "Urgent",
    engineer: "Plummer", fault: "Other", tier: 2,
    requestedBy: "Marcus Reid", phone: "07700 900456", daysAgo: 4,
  },
  {
    title: "Three ceiling spotlights out",
    description: "Front-of-house lighting, back left run. Display area is noticeably dim.",
    site: "Manchester – Arndale", status: "Job Scheduled", priority: "Medium",
    engineer: "Electrician", fault: "Lights", tier: 2,
    requestedBy: "Priya Nair", phone: "07700 900789", daysAgo: 6,
  },
  {
    title: "Signboard letters loose",
    description: "Two letters on the fascia have worked loose. Access equipment needed.",
    site: "Westfield – Stratford", status: "Quote Received (waiting for Approval)",
    priority: "Medium", engineer: "Other", fault: "Signboard", tier: 3,
    requestedBy: "Tom Whyte", phone: "07700 900222", daysAgo: 11, costPence: 84000,
  },
  {
    title: "Air conditioning not cooling",
    description: "Unit runs but the shop floor stays warm. Customers have commented.",
    site: "Cardiff – Grand Arcade", status: "Waiting for parts", priority: "Urgent",
    engineer: "Other", fault: "AC", tier: 2,
    requestedBy: "Elin Davies", phone: "07700 900333", daysAgo: 9,
  },
  {
    title: "Stockroom shelving bracket sheared",
    description: "One bay is unsafe to load. Stock moved to the adjacent bay meanwhile.",
    site: "Glasgow – Silverburn", status: "Pending Scheduling", priority: "Medium",
    engineer: "Handyman", fault: "Shelves", tier: 2,
    requestedBy: "Ross McKay", phone: "07700 900444", daysAgo: 3,
  },
  {
    title: "CCTV camera offline",
    description: "Camera 3, covering the rear fire exit, has been offline since Monday.",
    site: "Sheffield – Meadowhall", status: "Awaiting Access", priority: "Medium",
    engineer: "Electrician", fault: "CCTV", tier: 3,
    requestedBy: "Jade Ellis", phone: "07700 900555", daysAgo: 7,
  },
  {
    title: "Till drawer will not open",
    description: "Position 2 drawer sticks intermittently. Position 1 is unaffected.",
    site: "Reading – The Oracle", status: "Health And Safety Hold", priority: "Low",
    engineer: "Other", fault: "Drawers", tier: 4,
    requestedBy: "Sam Patel", phone: "07700 900666", daysAgo: 21,
  },
  {
    title: "Window vinyl peeling at the edge",
    description: "Seasonal vinyl lifting along the right-hand pane. Cosmetic only.",
    site: "Brighton – Churchill Square", status: "Waiting for decisions", priority: "Low",
    engineer: "Other", fault: "Vinyls", tier: 4,
    requestedBy: "Nadia Hassan", phone: "07700 900777", daysAgo: 30,
  },
  {
    title: "Fitting room door hinge dropped",
    description: "Door catches on the frame and no longer latches shut.",
    site: "Bristol – Cabot Circus", status: "Completion Invoice Received", priority: "Medium",
    engineer: "Handyman", fault: "Hinges", tier: 3,
    requestedBy: "Owen Clarke", phone: "07700 900888", daysAgo: 26, costPence: 19500,
  },
  {
    title: "Display screen showing no signal",
    description: "The window-facing display has been blank since the power cut.",
    site: "Nottingham – Victoria Centre", status: "Job Completed", priority: "Medium",
    engineer: "Electrician", fault: "TV/Display", tier: 3,
    requestedBy: "Beth Lawson", phone: "07700 900999", daysAgo: 40, costPence: 12000,
  },
  {
    title: "Repaint scuffed entrance wall",
    description: "Trolley damage either side of the entrance. Colour match required.",
    site: "Watford – Atria", status: "Job Completed", priority: "Low",
    engineer: "Handyman", fault: "Paint", tier: 4,
    requestedBy: "Iona Frost", phone: "07700 900101", daysAgo: 55, costPence: 26000,
  },
  {
    title: "Emergency light test failed",
    description: "Two fittings failed the monthly flick test at the rear corridor.",
    site: "Solihull – Touchwood", status: "Quote requested", priority: "Urgent",
    engineer: "Electrician", fault: "Lights", tier: 1,
    requestedBy: "Greg Hall", phone: "07700 900202", daysAgo: 5,
  },
  {
    title: "Diffuser panel cracked",
    description: "Cracked panel over the counter, dropping small fragments.",
    site: "Dudley – Merry Hill", status: "Blocked - Awaiting Response", priority: "Medium",
    engineer: "Handyman", fault: "Diffuser", tier: 3,
    requestedBy: "Aisha Bello", phone: "07700 900303", daysAgo: 14,
  },
  {
    // The only job at 'Pending Approval', which is the sole status in the New
    // stage. Without it that column renders empty on a seeded board, and an
    // empty column that should not be empty looks identical to one that is
    // correctly empty — which is how a broken queue tab survives review.
    title: "Replace worn entrance matting",
    description: "Matting is curling at the edge and has become a trip hazard.",
    site: "Milton Keynes – The Centre", status: "Pending Approval", priority: "Medium",
    engineer: "Handyman", fault: "Replacement parts", tier: 3,
    requestedBy: "Yusuf Ahmed", phone: "07700 900606", daysAgo: 1,
  },
  {
    title: "Acrylic display panel scratched",
    description: "Front acrylic badly scratched during a fixture move.",
    site: "Brent Cross", status: "Deposit Invoice Paid", priority: "Low",
    engineer: "Other", fault: "Acrylic", tier: 4,
    requestedBy: "Luca Moretti", phone: "07700 900404", daysAgo: 18, costPence: 47500,
  },
];

async function seed(db: Db) {
  const [org] = await db.query<{ id: string }>(
    "select id::text from organisations where slug = 'demo-retail-group'",
  );
  if (!org) {
    throw new Error(
      "The demo organisation is missing. Run the migrations first: npm run pg:migrate",
    );
  }

  const [already] = await db.query<{ n: number }>(
    "select count(*)::int as n from jobs where is_demo",
  );
  if (Number(already.n) > 0) {
    console.log(`${already.n} demo jobs already present — nothing to do.`);
    return;
  }

  const sites = new Map(
    (
      await db.query<{ id: string; name: string }>(
        "select id::text, name from sites where organisation_id = $1",
        [org.id],
      )
    ).map((row) => [row.name, row.id]),
  );

  let created = 0;
  const unmatched: string[] = [];

  for (const spec of JOBS) {
    const siteId = sites.get(spec.site);
    if (!siteId) {
      // Named rather than skipped silently: a demo job filed against no site is
      // exactly the "blank row" defect that made site totals meaningless before.
      unmatched.push(spec.site);
      continue;
    }

    const [job] = await db.query<{ id: string; reference: string }>(
      `insert into jobs
         (organisation_id, site_id, title, description, location, status, priority,
          engineer_required, fault_label, tier_level, job_requested_by, contact_number,
          cost_of_works_pence, date_requested, is_demo)
       values ($1,$2,$3,$4,$5,$6::job_status,$7::job_priority,$8::engineer_required,
               $9::job_fault_label,$10,$11,$12,$13, now() - make_interval(days => $14::int), true)
       returning id::text, reference`,
      [
        org.id, siteId, spec.title, spec.description, spec.site, spec.status,
        spec.priority, spec.engineer, spec.fault, spec.tier, spec.requestedBy,
        spec.phone, spec.costPence ?? null, spec.daysAgo,
      ],
    );

    await db.query(
      `insert into job_comments (job_id, body, author_name, visibility)
       values ($1,$2,'MAINTSUPP coordinator','public')`,
      [job.id, `Logged and triaged. Reference ${job.reference}.`],
    );

    /*
     * A quote wherever there is a cost, so the approve/reject path has
     * something real to act on rather than an empty panel.
     *
     * All of them are left `pending`. The `quotes_decision` CHECK requires a
     * decided quote to name who decided it and when — correctly, because an
     * approval with nobody's name against it is worthless in a dispute about
     * who agreed to what. A fresh demo database has no profiles yet, so there
     * is nobody to attribute a decision to, and inventing one would put a
     * fictitious person's name on a financial approval.
     */
    if (spec.costPence) {
      await db.query(
        `insert into quotes (job_id, amount_pence, description, status)
         values ($1,$2,$3,'pending')`,
        [job.id, spec.costPence, `Quoted works for: ${spec.title}`],
      );
    }
    created += 1;
  }

  // One untriaged intake request, so the Incoming Requests queue is not empty.
  await db.query(
    `insert into job_requests
       (site_name, contact_name, phone, email, address, postcode, fault_category,
        urgency, description, photos, is_demo)
     values ('Greenhithe – Bluewater','Rosa Lindqvist','07700 900505','rosa@example.com',
             'Bluewater Shopping Centre','DA9 9ST','Glass','P2',
             'Cracked pane in the left-hand window bay. Taped for now.',
             ARRAY['intake/demo-cracked-pane.jpg'], true)`,
  );

  console.log(`seeded ${created} demo jobs and 1 pending request`);
  if (unmatched.length) {
    console.log(`  unmatched sites (not seeded): ${[...new Set(unmatched)].join(", ")}`);
  }
}

const db = await getDb();

/*
 * One transaction for the whole seed.
 *
 * Without it, a constraint firing part way through leaves a half-populated
 * board AND trips the "already present" guard on the next run — so the fix
 * looks like it worked while the data stays wrong. That happened while writing
 * this: the quotes CHECK rejected an approved quote with no decider, after
 * eleven jobs had already been inserted.
 */
await db.transaction((tx) => seed(tx));

const summary = await db.query<{ stage: string; n: number }>(
  "select stage::text as stage, count(*)::int as n from jobs where is_demo group by stage order by 1",
);
console.log(summary.map((row) => `  ${row.stage}: ${row.n}`).join("\n"));
await db.close();
