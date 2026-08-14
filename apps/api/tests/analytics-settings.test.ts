/**
 * Analytics and settings, with the refusals that matter.
 *
 * Three properties are load-bearing and each is asserted against real rows in
 * a real database rather than reviewed by eye:
 *
 *   1. A client_admin's analytics are aggregates of THEIR organisation. An
 *      aggregate is the easiest place in a product to leak a tenant, because
 *      nothing on the screen names the row that leaked — a total is simply
 *      wrong, and wrong in a direction nobody notices.
 *   2. A contractor receives no money figures anywhere in analytics. Not
 *      nulled, not zeroed: absent.
 *   3. The "hide money on shared links" setting actually changes what the
 *      public share endpoint returns, and the database beats the environment
 *      variable it took over from.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type Db } from "../../../packages/db/src/client.ts";
import { createApp } from "../src/server.ts";

let db: Db;
let app: ReturnType<typeof createApp>;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

const OWNER_EMAIL = "anwarrshboul@gmail.com";
/** Restored in `after` so this file cannot colour another test run. */
const originalEnv = process.env.HIDE_MONEY_ON_SHARE;

function call(method: string, path: string, body?: unknown, cookie?: string) {
  return app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      "x-forwarded-for": `10.2.0.${Math.floor(Math.random() * 250) + 1}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Registers, verifies, approves to a role, and returns the session cookie. */
async function account(
  email: string,
  role: string | null,
  scope: { organisationId?: string; contractorId?: string } = {},
) {
  await call("POST", "/auth/register", {
    email,
    password: "test-password-1234",
    fullName: email,
  });
  await db.query(
    "update users set email_verified_at = now() where lower(email) = $1",
    [email],
  );
  // The owner arrives through `role_bootstrap` already active — overwriting it
  // here would be testing a role this product cannot actually produce.
  if (role) {
    await db.query(
      `update profiles set role = $2::user_role, status = 'active',
              organisation_id = $3, contractor_id = $4 where email = $1`,
      [email, role, scope.organisationId ?? null, scope.contractorId ?? null],
    );
  }
  const res = await call("POST", "/auth/sign-in", {
    email,
    password: "test-password-1234",
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  assert.ok(cookie.startsWith("ms_session="), `${email} could not sign in`);
  return cookie;
}

const one = async (sql: string, params: unknown[] = []) =>
  (await db.query<{ id: string }>(sql, params))[0].id;

/** A job with a cost, dated `daysAgo`, so ageing and spend have real inputs. */
async function job(spec: {
  org: string;
  site: string | null;
  contractor?: string;
  title: string;
  status: string;
  priority: string;
  daysAgo: number;
  costPence?: number;
}) {
  return one(
    `insert into jobs (organisation_id, site_id, contractor_id, title, description,
                       status, priority, cost_of_works_pence, date_requested)
     values ($1,$2,$3,$4,'seeded by the analytics test',$5::job_status,$6::job_priority,$7,
             now() - make_interval(days => $8::int))
     returning id::text`,
    [
      spec.org, spec.site, spec.contractor ?? null, spec.title, spec.status,
      spec.priority, spec.costPence ?? null, spec.daysAgo,
    ],
  );
}

before(async () => {
  db = await createTestDb();
  app = createApp(db);
  delete process.env.HIDE_MONEY_ON_SHARE;

  ids.orgA = await one(
    "insert into organisations (name, slug) values ('Client A','analytics-a') returning id::text",
  );
  ids.orgB = await one(
    "insert into organisations (name, slug) values ('Client B','analytics-b') returning id::text",
  );
  ids.siteA1 = await one(
    "insert into sites (organisation_id, name) values ($1,'Aldgate') returning id::text",
    [ids.orgA],
  );
  ids.siteA2 = await one(
    "insert into sites (organisation_id, name) values ($1,'Shoreditch') returning id::text",
    [ids.orgA],
  );
  ids.siteB1 = await one(
    "insert into sites (organisation_id, name) values ($1,'Leeds') returning id::text",
    [ids.orgB],
  );
  ids.acme = await one(
    "insert into contractors (name) values ('Acme Shopfitting') returning id::text",
  );
  ids.northern = await one(
    "insert into contractors (name) values ('Northern Facilities') returning id::text",
  );

  // Client A: five jobs across four stages, two contractors' worth of work,
  // £1,500.00 of cost in total.
  ids.jobOld = await job({
    org: ids.orgA, site: ids.siteA1, contractor: ids.acme,
    title: "Shutter jammed open", status: "Escalated", priority: "Urgent",
    daysAgo: 75, costPence: 50000,
  });
  await job({
    org: ids.orgA, site: ids.siteA1, contractor: ids.acme,
    title: "Lights out", status: "Job Completed", priority: "Medium",
    daysAgo: 20, costPence: 25000,
  });
  await job({
    org: ids.orgA, site: ids.siteA2, contractor: ids.acme,
    title: "Door hinge dropped", status: "Job In Progress", priority: "Medium",
    daysAgo: 9, costPence: 75000,
  });
  await job({
    org: ids.orgA, site: ids.siteA2,
    title: "Repaint entrance", status: "Pending Approval", priority: "Low",
    daysAgo: 2,
  });
  ids.jobShared = await job({
    org: ids.orgA, site: ids.siteA1, contractor: ids.acme,
    title: "AC not cooling", status: "Quote requested", priority: "Urgent",
    daysAgo: 4, costPence: 0,
  });
  await db.query(
    "update jobs set cost_of_works_pence = 123456, invoice_ref = 'INV-9', approved_by = 'Anwar' where id = $1",
    [ids.jobShared],
  );
  await db.query(
    "insert into quotes (job_id, amount_pence, description) values ($1, 123456, 'Recharge and test')",
    [ids.jobShared],
  );

  // Client B: one very expensive job. If it ever appears in Client A's totals
  // the numbers move enough to be unmistakable.
  await job({
    org: ids.orgB, site: ids.siteB1, contractor: ids.northern,
    title: "Roof survey", status: "Job Completed", priority: "Medium",
    daysAgo: 30, costPence: 9_900_000,
  });

  /*
   * Compliance. `kind` names a row in `compliance_requirements` (migration
   * 0009) and `status` is written by that migration's trigger, so nothing here
   * states a status: the dates decide, which is the point of asserting on them.
   * "Expiring" is anything inside 90 days.
   */
  const doc = (site: string, org: string, kind: string, days: number) =>
    db.query(
      `insert into compliance_documents (organisation_id, site_id, kind, expiry_date)
       values ($1,$2,$3, current_date + $4::int)`,
      [org, site, kind, days],
    );
  await doc(ids.siteA1, ids.orgA, "fire_alarm", 20);
  await doc(ids.siteA1, ids.orgA, "pat", 200);
  await doc(ids.siteA2, ids.orgA, "electrical_wiring", 75);
  await doc(ids.siteA2, ids.orgA, "sprinkler", -5);
  await doc(ids.siteB1, ids.orgB, "fire_alarm", 10);

  cookies.owner = await account(OWNER_EMAIL, null);
  cookies.admin = await account("admin@analytics.test", "admin");
  cookies.clientA = await account("a@analytics.test", "client_admin", {
    organisationId: ids.orgA,
  });
  cookies.clientB = await account("b@analytics.test", "client_admin", {
    organisationId: ids.orgB,
  });
  cookies.contractor = await account("c@analytics.test", "contractor", {
    contractorId: ids.acme,
  });

  const [row] = await db.query<{ token: string }>(
    "select share_token as token from jobs where id = $1",
    [ids.jobShared],
  );
  ids.shareToken = row.token;
});

after(async () => {
  if (originalEnv === undefined) delete process.env.HIDE_MONEY_ON_SHARE;
  else process.env.HIDE_MONEY_ON_SHARE = originalEnv;
  await db.close();
});

const overview = async (cookie: string) => {
  const res = await call("GET", "/analytics/overview", undefined, cookie);
  assert.equal(res.status, 200);
  return res.json();
};

describe("1 — analytics answer the caller's own question", () => {
  test("staff see every organisation", async () => {
    const data = await overview(cookies.admin);
    assert.equal(data.jobs.total, 6);
    assert.equal(data.money, true);
    assert.equal(data.spend.totalPence, 50000 + 25000 + 75000 + 123456 + 9_900_000);
  });

  test("the stage and priority mixes are complete, zeros included", async () => {
    const data = await overview(cookies.admin);
    assert.deepEqual(
      data.jobs.byStage.map((slice: { label: string }) => slice.label),
      ["New", "Scheduling", "In Progress", "Quotes", "On Hold", "Payment", "Done"],
    );
    // Scheduling and Payment hold nothing. They must still be there: a missing
    // bar and an empty one look identical once the bar is gone.
    const byStage = Object.fromEntries(
      data.jobs.byStage.map((s: { label: string; jobs: number }) => [s.label, s.jobs]),
    );
    assert.equal(byStage.Scheduling, 0);
    assert.equal(byStage.Payment, 0);
    assert.equal(byStage["On Hold"], 1);
    assert.equal(byStage.Done, 2);

    const byPriority = Object.fromEntries(
      data.jobs.byPriority.map((s: { label: string; jobs: number }) => [s.label, s.jobs]),
    );
    assert.deepEqual(byPriority, { Urgent: 2, Medium: 3, Low: 1 });
  });
});

describe("2 — a client_admin's analytics exclude another organisation", () => {
  test("the job mix counts only their own", async () => {
    const data = await overview(cookies.clientA);
    assert.equal(data.jobs.total, 5, "client A saw another organisation's jobs");
    assert.equal(data.jobs.completed, 1);

    const other = await overview(cookies.clientB);
    assert.equal(other.jobs.total, 1);
  });

  test("spend stops at the organisation boundary, site by site", async () => {
    const data = await overview(cookies.clientA);
    assert.equal(
      data.spend.totalPence,
      50000 + 25000 + 75000 + 123456,
      "client B's £99,000 job reached client A's spend",
    );
    const named = data.spend.sites.map((site: { siteName: string }) => site.siteName);
    assert.deepEqual(named.sort(), ["Aldgate", "Shoreditch"]);
    assert.equal(named.includes("Leeds"), false, "client A was shown client B's store");

    // Six buckets, and the rows add up to the stated total — a table whose
    // rows do not sum to its own total is the "250 of 744" bug in a new hat.
    assert.equal(data.spend.months.length, 6);
    const fromRows = data.spend.sites.reduce(
      (sum: number, site: { totalPence: number }) => sum + site.totalPence,
      0,
    );
    assert.equal(fromRows, data.spend.totalPence);
  });

  test("the contractor scorecard names only contractors who worked for them", async () => {
    const data = await overview(cookies.clientA);
    const names = data.contractors.rows.map((row: { name: string }) => row.name);
    assert.deepEqual(names, ["Acme Shopfitting"]);
    assert.equal(names.includes("Northern Facilities"), false);

    const acme = data.contractors.rows[0];
    assert.equal(acme.jobs, 4);
    assert.equal(acme.completed, 1);
    assert.equal(acme.spendPence, 50000 + 25000 + 75000 + 123456);
  });

  test("the compliance register stops at the organisation boundary", async () => {
    const data = await overview(cookies.clientA);
    const byStatus = Object.fromEntries(
      data.compliance.byStatus.map((s: { label: string; documents: number }) => [
        s.label,
        s.documents,
      ]),
    );
    // Two inside 90 days, one well beyond, one already lapsed — and client B's
    // certificate in none of them.
    assert.equal(byStatus.Expiring, 2, "client B's certificate was counted");
    assert.equal(byStatus.Valid, 1);
    assert.equal(byStatus.Expired, 1);

    // Cumulative windows: 60 includes 30, 90 includes 60. Stated in the API and
    // asserted here so a later "tidy-up" into disjoint bands cannot pass.
    assert.equal(data.compliance.dueWithin.days30, 1);
    assert.equal(data.compliance.dueWithin.days60, 1);
    assert.equal(data.compliance.dueWithin.days90, 2);
    assert.equal(data.compliance.expired, 1);

    const sites = data.compliance.soonest.map(
      (row: { site_name: string }) => row.site_name,
    );
    assert.equal(sites.includes("Leeds"), false);
  });

  test("open-job ageing counts what is still waiting, oldest first", async () => {
    const data = await overview(cookies.clientA);
    const buckets = Object.fromEntries(
      data.ageing.buckets.map((b: { label: string; jobs: number }) => [b.label, b.jobs]),
    );
    // Four open jobs: 2, 4, 9 and 75 days old. The completed one is not ageing.
    assert.deepEqual(buckets, {
      "0–7 days": 2,
      "8–14 days": 1,
      "15–30 days": 0,
      "31–60 days": 0,
      "Over 60 days": 1,
    });
    assert.equal(data.ageing.waitingLongest[0].id, ids.jobOld);
    assert.ok(data.ageing.waitingLongest[0].age_days >= 74);
    assert.equal(
      data.ageing.waitingLongest.some(
        (row: { title: string }) => row.title === "Roof survey",
      ),
      false,
      "client A was shown client B's job in the waiting list",
    );
  });
});

describe("3 — a contractor receives no money figures", () => {
  test("nothing in the whole payload carries a price", async () => {
    const res = await call("GET", "/analytics/overview", undefined, cookies.contractor);
    assert.equal(res.status, 200);
    const text = await res.text();

    // The blunt assertion on purpose: not "spendPence is undefined" but "no
    // money left this endpoint at all", which survives a field being renamed.
    assert.equal(/pence/i.test(text), false, `money reached a contractor: ${text}`);

    const data = JSON.parse(text);
    assert.equal(data.money, false);
    assert.equal("spend" in data, false, "the spend section was sent to a contractor");
    for (const row of data.contractors.rows) {
      assert.equal("spendPence" in row, false);
    }
  });

  test("the spend endpoint refuses rather than answering emptily", async () => {
    const res = await call("GET", "/analytics/spend", undefined, cookies.contractor);
    assert.equal(res.status, 403);
    assert.equal(/pence/i.test(await res.text()), false);
  });

  test("they still see their own work, and only their own", async () => {
    const data = await overview(cookies.contractor);
    // The four Acme jobs, none of Northern's, none of client B's.
    assert.equal(data.jobs.total, 4);
    assert.deepEqual(
      data.contractors.rows.map((row: { name: string }) => row.name),
      ["Acme Shopfitting"],
    );
    // A contractor has no business reading a client's compliance register.
    assert.equal(
      data.compliance.byStatus.every((s: { documents: number }) => s.documents === 0),
      true,
      "a contractor was shown compliance documents",
    );
  });

  test("signed out reaches nothing", async () => {
    for (const path of ["/analytics/overview", "/analytics/spend", "/settings"]) {
      assert.equal((await call("GET", path)).status, 401, `${path} was open`);
    }
  });
});

describe("4 — settings belong to the owner", () => {
  test("staff and clients are refused, reading as well as writing", async () => {
    for (const [who, cookie] of [
      ["an admin", cookies.admin],
      ["a client_admin", cookies.clientA],
      ["a contractor", cookies.contractor],
    ] as const) {
      assert.equal(
        (await call("GET", "/settings", undefined, cookie)).status,
        403,
        `${who} read the account settings`,
      );
      assert.equal(
        (await call("POST", "/settings/hide_money_on_share", { value: true }, cookie))
          .status,
        403,
        `${who} changed an account setting`,
      );
    }
    const [row] = await db.query<{ n: number }>(
      "select count(*)::int as n from settings",
    );
    assert.equal(Number(row.n), 0, "a refused write still wrote a row");
  });

  test("with no row and no environment variable, the default is off", async () => {
    const res = await call("GET", "/settings", undefined, cookies.owner);
    assert.equal(res.status, 200);
    const { settings } = await res.json();
    const toggle = settings.find(
      (s: { key: string }) => s.key === "hide_money_on_share",
    );
    assert.equal(toggle.value, false);
    assert.equal(toggle.source, "default");
    assert.equal(toggle.type, "boolean");
  });

  test("an unknown key is not invented, and a wrong type is refused", async () => {
    assert.equal(
      (await call("GET", "/settings/nonsense", undefined, cookies.owner)).status,
      404,
    );
    assert.equal(
      (await call("POST", "/settings/nonsense", { value: true }, cookies.owner)).status,
      404,
    );

    // "false" is a non-empty string and therefore truthy. Coercing it would
    // turn this switch ON at the moment somebody turned it off.
    const res = await call(
      "POST",
      "/settings/hide_money_on_share",
      { value: "false" },
      cookies.owner,
    );
    assert.equal(res.status, 400);
    const [row] = await db.query<{ n: number }>(
      "select count(*)::int as n from settings",
    );
    assert.equal(Number(row.n), 0, "a refused value was stored anyway");
  });
});

describe("5 — the money toggle changes what a share link returns", () => {
  const shared = () => call("GET", `/public/job/${ids.shareToken}`);

  test("by default the shared link is the full ticket", async () => {
    const body = await (await shared()).json();
    assert.equal(body.job.cost_of_works_pence, 123456);
    assert.equal(body.job.invoice_ref, "INV-9");
    assert.equal(body.quotes.length, 1);
  });

  test("the environment variable is the fallback while no row exists", async () => {
    process.env.HIDE_MONEY_ON_SHARE = "true";

    const { settings } = await (
      await call("GET", "/settings", undefined, cookies.owner)
    ).json();
    const toggle = settings.find((s: { key: string }) => s.key === "hide_money_on_share");
    assert.equal(toggle.value, true);
    assert.equal(toggle.source, "environment");

    const body = await (await shared()).json();
    assert.equal("cost_of_works_pence" in body.job, false);
    assert.equal(body.quotes.length, 0);
  });

  test("a row beats the environment, in both directions", async () => {
    // The environment still says "hide". The owner says show, in the product.
    const off = await call(
      "POST",
      "/settings/hide_money_on_share",
      { value: false },
      cookies.owner,
    );
    assert.equal(off.status, 200);
    assert.equal((await off.json()).setting.source, "database");

    const shown = await (await shared()).json();
    assert.equal(
      shown.job.cost_of_works_pence,
      123456,
      "the environment variable overrode the owner's own decision",
    );
    assert.equal(shown.quotes.length, 1);

    // And with the variable cleared, the row is still what decides.
    delete process.env.HIDE_MONEY_ON_SHARE;
    const on = await call(
      "POST",
      "/settings/hide_money_on_share",
      { value: true },
      cookies.owner,
    );
    assert.equal(on.status, 200);

    const hidden = await (await shared()).json();
    assert.equal("cost_of_works_pence" in hidden.job, false);
    assert.equal("invoice_ref" in hidden.job, false);
    assert.equal("approved_by" in hidden.job, false);
    assert.equal(hidden.quotes.length, 0);
    // Everything that is not money is untouched — this hides a figure, it does
    // not retract the ticket.
    assert.equal(hidden.job.reference.startsWith("MS-"), true);
    assert.equal(hidden.job.site_name, "Aldgate");
  });

  test("nothing changes for somebody signed in", async () => {
    const res = await call("GET", `/jobs/${ids.jobShared}`, undefined, cookies.clientA);
    const { job } = await res.json();
    assert.equal(
      Number(job.cost_of_works_pence),
      123456,
      "the share-link toggle took money away from the portal too",
    );
  });

  test("every change is attributed, in order, with what it was before", async () => {
    const res = await call("GET", "/settings/audit", undefined, cookies.owner);
    assert.equal(res.status, 200);
    const { entries } = await res.json();

    assert.equal(entries.length, 2, "the trail lost a change");
    // Newest first.
    assert.equal(entries[0].new_value, true);
    assert.equal(entries[0].old_value, false);
    assert.equal(entries[0].changed_by_email, OWNER_EMAIL);
    // The first write had no row before it: null is "it came from the
    // environment", which is not the same history as "it was already false".
    assert.equal(entries[1].old_value, null);
    assert.equal(entries[1].new_value, false);

    const [feed] = await db.query<{ n: number }>(
      "select count(*)::int as n from activity_log where action = 'setting.changed'",
    );
    assert.equal(Number(feed.n), 2);
  });
});
