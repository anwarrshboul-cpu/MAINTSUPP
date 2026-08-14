/**
 * Assignment, the contractor's answer, and the two client-side screens.
 *
 * The thing under test is not "does the column get written" — it is that
 * ASSIGNMENT IS THE GRANT. `scopeFor()` scopes a contractor to
 * `jobs.contractor_id`, so `POST /jobs/:id/assign` is the authorisation
 * decision and every one of these tests is really about who can see what
 * afterwards. The four the brief names are here by name:
 *
 *   · a contractor cannot accept a job assigned to somebody else
 *   · a contractor still sees no money after being assigned
 *   · a client_admin can decide their own organisation's quote, not another's
 *   · a client_user's portal report lands in `job_requests` awaiting triage,
 *     not on the board
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type Db } from "../../../packages/db/src/client.ts";
import { createApp } from "../src/server.ts";

let db: Db;
let app: ReturnType<typeof createApp>;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

function call(method: string, path: string, body?: unknown, cookie?: string) {
  return app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      // A fresh address per call: sign-up and the public form are both rate
      // limited per IP, and a suite that trips its own limiter fails in a way
      // that looks like a broken endpoint.
      "x-forwarded-for": `10.4.0.${Math.floor(Math.random() * 250) + 1}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Registers, verifies, approves to a role, and returns the session cookie. */
async function account(
  email: string,
  role: string,
  scope: { organisationId?: string; contractorId?: string; siteIds?: string[] } = {},
) {
  await call("POST", "/auth/register", {
    email,
    password: "test-password-1234",
    fullName: email,
  });
  await db.query("update users set email_verified_at = now() where lower(email) = $1", [email]);
  await db.query(
    `update profiles set role = $2::user_role, status = 'active',
            organisation_id = $3, contractor_id = $4, phone = '07700 900000'
      where email = $1`,
    [email, role, scope.organisationId ?? null, scope.contractorId ?? null],
  );
  for (const siteId of scope.siteIds ?? []) {
    await db.query(
      "insert into profile_sites (profile_id, site_id) select id, $2 from profiles where email = $1",
      [email, siteId],
    );
  }
  const res = await call("POST", "/auth/sign-in", { email, password: "test-password-1234" });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  assert.ok(cookie.startsWith("ms_session="), `${email} could not sign in`);
  return cookie;
}

/** A job on client A's Aldgate site, with nobody assigned to it. */
async function newJob(title: string, costPence: number | null = null) {
  const [row] = await db.query<{ id: string }>(
    `insert into jobs (organisation_id, site_id, title, description, cost_of_works_pence, status)
     values ($1,$2,$3,'Written by the assignment test',$4,'Pending Scheduling')
     returning id::text`,
    [ids.orgA, ids.siteA, title, costPence],
  );
  return row.id;
}

const jobRow = (id: string) =>
  db
    .query<{
      assignment_status: string | null;
      contractor_id: string | null;
      accepted_at: string | null;
      declined_at: string | null;
      decline_reason: string | null;
      eta_at: string | null;
    }>(
      `select assignment_status::text, contractor_id::text, accepted_at::text,
              declined_at::text, decline_reason, eta_at::text
         from jobs where id = $1`,
      [id],
    )
    .then((rows) => rows[0]);

before(async () => {
  db = await createTestDb();
  app = createApp(db);

  ids.orgA = (
    await db.query<{ id: string }>(
      "insert into organisations (name, slug) values ('Assign A','assign-a') returning id::text",
    )
  )[0].id;
  ids.orgB = (
    await db.query<{ id: string }>(
      "insert into organisations (name, slug) values ('Assign B','assign-b') returning id::text",
    )
  )[0].id;
  ids.siteA = (
    await db.query<{ id: string }>(
      `insert into sites (organisation_id, name, address, postcode)
       values ($1,'Aldgate','1 Whitechapel Road','E1 1DU') returning id::text`,
      [ids.orgA],
    )
  )[0].id;
  ids.acme = (
    await db.query<{ id: string }>(
      "insert into contractors (name, email) values ('Acme Test','acme@test.local') returning id::text",
    )
  )[0].id;
  ids.rival = (
    await db.query<{ id: string }>(
      "insert into contractors (name) values ('Rival Test') returning id::text",
    )
  )[0].id;

  cookies.admin = await account("assign-admin@maintsupp.test", "admin");
  cookies.clientA = await account("assign-a@client.test", "client_admin", {
    organisationId: ids.orgA,
  });
  cookies.clientB = await account("assign-b@client.test", "client_admin", {
    organisationId: ids.orgB,
  });
  cookies.storeA = await account("assign-store@client.test", "client_user", {
    organisationId: ids.orgA,
    siteIds: [ids.siteA],
  });
  cookies.acme = await account("assign-acme@contractor.test", "contractor", {
    contractorId: ids.acme,
  });
  cookies.rival = await account("assign-rival@contractor.test", "contractor", {
    contractorId: ids.rival,
  });

  ids.acmeProfile = (
    await db.query<{ id: string }>(
      "select id::text from profiles where email = 'assign-acme@contractor.test'",
    )
  )[0].id;
  ids.storeProfile = (
    await db.query<{ id: string }>(
      "select id::text from profiles where email = 'assign-store@client.test'",
    )
  )[0].id;
});

after(async () => {
  await db.close();
});

describe("1 — assignment is what grants access", () => {
  before(async () => {
    ids.job = await newJob("Shutter jammed", 45000);
  });

  test("before it is assigned, the contractor cannot see the job at all", async () => {
    assert.equal(
      (await call("GET", `/jobs/${ids.job}`, undefined, cookies.acme)).status,
      404,
    );
    const board = await call("GET", "/jobs", undefined, cookies.acme);
    assert.equal((await board.json()).total, 0);
  });

  test("a client cannot assign, and neither can a contractor", async () => {
    for (const who of ["clientA", "storeA", "acme"] as const) {
      const res = await call(
        "POST",
        `/jobs/${ids.job}/assign`,
        { contractorId: ids.acme },
        cookies[who],
      );
      assert.equal(res.status, 403, `${who} was allowed to assign a contractor`);
    }
  });

  test("an unknown or malformed contractor is refused before anything is written", async () => {
    const junk = await call("POST", `/jobs/${ids.job}/assign`,
      { contractorId: "not-a-uuid" }, cookies.admin);
    assert.equal(junk.status, 400);

    const missing = await call("POST", `/jobs/${ids.job}/assign`,
      { contractorId: "11111111-1111-1111-1111-111111111111" }, cookies.admin);
    assert.equal(missing.status, 400);

    assert.equal((await jobRow(ids.job)).contractor_id, null);
  });

  test("a client_user cannot be named as the person doing the work", async () => {
    const res = await call("POST", `/jobs/${ids.job}/assign`,
      { contractorId: ids.acme, assignedTo: ids.storeProfile }, cookies.admin);
    assert.equal(res.status, 400, "a store manager was recorded as the engineer");
    assert.equal((await jobRow(ids.job)).contractor_id, null);
  });

  test("staff assign it, and that is the moment the contractor can read it", async () => {
    const res = await call("POST", `/jobs/${ids.job}/assign`,
      { contractorId: ids.acme, assignedTo: ids.acmeProfile }, cookies.admin);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).job.assignment_status, "offered");

    const seen = await call("GET", `/jobs/${ids.job}`, undefined, cookies.acme);
    assert.equal(seen.status, 200, "assignment did not grant access");

    const board = await call("GET", "/jobs", undefined, cookies.acme);
    const page = await board.json();
    assert.equal(page.total, 1);
    assert.equal(page.jobs[0].assignment_status, "offered");
  });

  test("the assignment is on the job's own thread, not only in the audit log", async () => {
    const { comments } = await (
      await call("GET", `/jobs/${ids.job}`, undefined, cookies.clientA)
    ).json();
    assert.ok(
      comments.some((comment: { body: string }) => /Assigned to Acme Test/.test(comment.body)),
      "nothing on the job says it was assigned",
    );
  });

  test("another contractor still sees nothing", async () => {
    assert.equal(
      (await call("GET", `/jobs/${ids.job}`, undefined, cookies.rival)).status,
      404,
    );
    assert.equal((await (await call("GET", "/jobs", undefined, cookies.rival)).json()).total, 0);
  });
});

describe("2 — accepting and declining", () => {
  test("a contractor cannot accept a job assigned to somebody else", async () => {
    const res = await call("POST", `/jobs/${ids.job}/assignment/accept`, {}, cookies.rival);
    // 404 and not 403: a refusal that named the job would confirm it exists.
    assert.equal(res.status, 404, "a contractor accepted another firm's job");
    assert.equal((await jobRow(ids.job)).assignment_status, "offered");
  });

  test("a client cannot accept on the contractor's behalf", async () => {
    assert.equal(
      (await call("POST", `/jobs/${ids.job}/assignment/accept`, {}, cookies.clientA)).status,
      403,
    );
  });

  test("the assigned contractor cannot start work before accepting", async () => {
    const res = await call("POST", `/jobs/${ids.job}/status`,
      { status: "Job In Progress" }, cookies.acme);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /Accept this job/i);
  });

  test("they accept, and the acceptance is timed", async () => {
    const res = await call("POST", `/jobs/${ids.job}/assignment/accept`, {}, cookies.acme);
    assert.equal(res.status, 200);

    const row = await jobRow(ids.job);
    assert.equal(row.assignment_status, "accepted");
    assert.ok(row.accepted_at, "nothing recorded when it was accepted");
    ids.acceptedAt = row.accepted_at;
  });

  test("accepting twice does not move the timestamp", async () => {
    const again = await call("POST", `/jobs/${ids.job}/assignment/accept`, {}, cookies.acme);
    assert.equal(again.status, 200, "a double tap was treated as an error");
    assert.equal((await jobRow(ids.job)).accepted_at, ids.acceptedAt);
  });

  test("now they can move the job, but only through statuses that are theirs to set", async () => {
    const started = await call("POST", `/jobs/${ids.job}/status`,
      { status: "Job In Progress" }, cookies.acme);
    assert.equal(started.status, 200);

    // A role that is never shown money cannot assert that money moved.
    const paid = await call("POST", `/jobs/${ids.job}/status`,
      { status: "Completion Invoice Paid" }, cookies.acme);
    assert.equal(paid.status, 403, "a contractor marked an invoice paid");
  });

  test("marking it complete is the same endpoint, and it lands", async () => {
    const res = await call("POST", `/jobs/${ids.job}/status`,
      { status: "Job Completed" }, cookies.acme);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).job.stage, "Done");
  });

  test("declining without a reason is refused", async () => {
    ids.job2 = await newJob("Loose fascia letters");
    await call("POST", `/jobs/${ids.job2}/assign`, { contractorId: ids.acme }, cookies.admin);

    const res = await call("POST", `/jobs/${ids.job2}/assignment/decline`, {}, cookies.acme);
    assert.equal(res.status, 400);
    assert.equal((await jobRow(ids.job2)).assignment_status, "offered");
  });

  test("a decline is recorded with its reason, and the job does not vanish", async () => {
    const res = await call("POST", `/jobs/${ids.job2}/assignment/decline`,
      { reason: "No cherry picker available until Thursday." }, cookies.acme);
    assert.equal(res.status, 200);

    const row = await jobRow(ids.job2);
    assert.equal(row.assignment_status, "declined");
    assert.match(row.decline_reason ?? "", /cherry picker/);
    // The decision recorded in migration 0008: the contractor stays on the row.
    assert.equal(row.contractor_id, ids.acme);

    // Visible to staff, to the client, and to the contractor who refused it —
    // a declined job that disappeared is a job nobody chases.
    for (const who of ["admin", "clientA", "storeA", "acme"] as const) {
      const seen = await call("GET", `/jobs/${ids.job2}`, undefined, cookies[who]);
      assert.equal(seen.status, 200, `${who} lost sight of a declined job`);
    }
    assert.equal(
      (await call("GET", `/jobs/${ids.job2}`, undefined, cookies.rival)).status,
      404,
      "declining leaked the job to an unrelated contractor",
    );
  });

  test("a declined job cannot be worked on or un-declined by the contractor", async () => {
    const moved = await call("POST", `/jobs/${ids.job2}/status`,
      { status: "Job In Progress" }, cookies.acme);
    assert.equal(moved.status, 403);

    const retaken = await call("POST", `/jobs/${ids.job2}/assignment/accept`, {}, cookies.acme);
    assert.equal(retaken.status, 400, "a contractor took back their own refusal");
    assert.equal((await jobRow(ids.job2)).assignment_status, "declined");
  });

  test("reassigning clears the refusal and moves access to the new firm", async () => {
    const res = await call("POST", `/jobs/${ids.job2}/assign`,
      { contractorId: ids.rival }, cookies.admin);
    assert.equal(res.status, 200);

    const row = await jobRow(ids.job2);
    assert.equal(row.assignment_status, "offered");
    assert.equal(row.contractor_id, ids.rival);
    assert.equal(row.decline_reason, null, "the new firm inherited the old refusal");

    assert.equal(
      (await call("GET", `/jobs/${ids.job2}`, undefined, cookies.rival)).status,
      200,
    );
    assert.equal(
      (await call("GET", `/jobs/${ids.job2}`, undefined, cookies.acme)).status,
      404,
      "reassignment did not revoke the previous contractor",
    );
  });
});

describe("3 — the ETA", () => {
  before(async () => {
    ids.job3 = await newJob("Emergency light failed");
    await call("POST", `/jobs/${ids.job3}/assign`, { contractorId: ids.acme }, cookies.admin);
  });

  const soon = () => new Date(Date.now() + 36 * 3600_000).toISOString();

  test("an ETA cannot be promised before the job is accepted", async () => {
    const res = await call("POST", `/jobs/${ids.job3}/assignment/eta`,
      { etaAt: soon() }, cookies.acme);
    assert.equal(res.status, 400);
    assert.equal((await jobRow(ids.job3)).eta_at, null);
  });

  test("once accepted it is set, and it shows on the job", async () => {
    await call("POST", `/jobs/${ids.job3}/assignment/accept`, {}, cookies.acme);
    const res = await call("POST", `/jobs/${ids.job3}/assignment/eta`,
      { etaAt: soon() }, cookies.acme);
    assert.equal(res.status, 200);
    assert.ok((await jobRow(ids.job3)).eta_at);

    const { comments } = await (
      await call("GET", `/jobs/${ids.job3}`, undefined, cookies.storeA)
    ).json();
    assert.ok(
      comments.some((comment: { body: string }) => /On site by/.test(comment.body)),
      "the client cannot see when anybody is turning up",
    );
  });

  test("a mistyped year and a date in the past are both refused", async () => {
    const far = new Date(Date.now() + 400 * 24 * 3600_000).toISOString();
    const past = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
    for (const etaAt of [far, past, "next tuesday"]) {
      const res = await call("POST", `/jobs/${ids.job3}/assignment/eta`,
        { etaAt }, cookies.acme);
      assert.equal(res.status, 400, `${etaAt} was accepted as an ETA`);
    }
  });

  test("a client cannot set one", async () => {
    assert.equal(
      (await call("POST", `/jobs/${ids.job3}/assignment/eta`,
        { etaAt: soon() }, cookies.clientA)).status,
      403,
    );
  });

  test("a job assigned before offers existed can still be accepted and timed", async () => {
    /*
     * `0010_import.sql` brings monday history in with `contractor_id` already
     * set and no offer ever recorded, so `assignment_status` is null. Those
     * jobs are live work: refusing them would leave a contractor looking at
     * their own imported list with every control answering "not yours".
     */
    const legacy = await newJob("Imported: shutter service");
    await db.query("update jobs set contractor_id = $2 where id = $1", [legacy, ids.acme]);

    const eta = await call("POST", `/jobs/${legacy}/assignment/eta`,
      { etaAt: soon() }, cookies.acme);
    assert.equal(eta.status, 200, "an imported assignment could not be given an ETA");

    const accepted = await call("POST", `/jobs/${legacy}/assignment/accept`, {}, cookies.acme);
    assert.equal(accepted.status, 200);
    assert.equal((await jobRow(legacy)).assignment_status, "accepted");

    // And it is still nobody else's.
    assert.equal(
      (await call("POST", `/jobs/${legacy}/assignment/accept`, {}, cookies.rival)).status,
      404,
    );
  });
});

describe("4 — a contractor still sees no money after being assigned", () => {
  test("not on the job, not on the board, not in the quotes list", async () => {
    await db.query(
      "insert into quotes (job_id, amount_pence, description) values ($1, 84000, 'Access equipment')",
      [ids.job3],
    );

    const detail = await call("GET", `/jobs/${ids.job3}`, undefined, cookies.acme);
    assert.equal(detail.status, 200, "the assigned contractor lost access");
    const { job, quotes } = await detail.json();
    assert.equal("cost_of_works_pence" in job, false, "a contractor was shown pricing");
    assert.equal("invoice_ref" in job, false);
    assert.equal("approved_by" in job, false);
    assert.equal(quotes.length, 0, "a contractor was shown a quote");

    const board = await call("GET", "/jobs", undefined, cookies.acme);
    for (const row of (await board.json()).jobs) {
      assert.equal("cost_of_works_pence" in row, false, "the board leaked money to a contractor");
    }
  });

  test("nor the share token, which is a link to the money", async () => {
    /*
     * `GET /public/job/:token` shows the full ticket, cost of works included.
     * So sending a contractor the token would hand the one role this endpoint
     * strips three money columns from a URL that displays all three.
     */
    const { job } = await (
      await call("GET", `/jobs/${ids.job3}`, undefined, cookies.acme)
    ).json();
    assert.equal("share_token" in job, false, "a contractor was given the share link");

    const board = await (await call("GET", "/jobs", undefined, cookies.acme)).json();
    for (const row of board.jobs) {
      assert.equal("share_token" in row, false, "the board leaked a share token");
    }

    // The client, who is shown the money anyway, still gets it — they may
    // forward their own job to a landlord or an insurer.
    const theirs = await (
      await call("GET", `/jobs/${ids.job3}`, undefined, cookies.clientA)
    ).json();
    assert.match(theirs.job.share_token, /^[0-9a-f]{64}$/);
  });

  test("the money-facing screens refuse them outright", async () => {
    for (const path of ["/jobs/quotes/pending", "/jobs/summary/monthly"]) {
      assert.equal(
        (await call("GET", path, undefined, cookies.acme)).status,
        403,
        `${path} was open to a contractor`,
      );
    }
  });
});

describe("5 — the client admin's quotes", () => {
  before(async () => {
    ids.quote = (
      await db.query<{ id: string }>(
        "insert into quotes (job_id, amount_pence, description) values ($1, 48500, 'Replace motor') returning id::text",
        [ids.job],
      )
    )[0].id;
  });

  test("each organisation's queue holds only its own", async () => {
    const mine = await call("GET", "/jobs/quotes/pending", undefined, cookies.clientA);
    assert.equal(mine.status, 200);
    const body = await mine.json();
    assert.ok(
      body.quotes.some((quote: { id: string }) => quote.id === ids.quote),
      "a client_admin could not see their own pending quote",
    );
    assert.equal(body.canDecide, true);

    const theirs = await call("GET", "/jobs/quotes/pending", undefined, cookies.clientB);
    assert.equal((await theirs.json()).quotes.length, 0, "client B saw client A's quotes");
  });

  test("a client_user may look but not decide", async () => {
    const res = await call("GET", "/jobs/quotes/pending", undefined, cookies.storeA);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).canDecide, false);

    const attempt = await call("POST", `/jobs/quotes/${ids.quote}/decide`,
      { decision: "approved" }, cookies.storeA);
    assert.equal(attempt.status, 403);
  });

  test("a client_admin decides their own organisation's quote, and not another's", async () => {
    const theirs = await call("POST", `/jobs/quotes/${ids.quote}/decide`,
      { decision: "approved" }, cookies.clientB);
    assert.equal(theirs.status, 404, "client B decided client A's quote");

    const mine = await call("POST", `/jobs/quotes/${ids.quote}/decide`,
      { decision: "approved" }, cookies.clientA);
    assert.equal(mine.status, 200);
    assert.equal((await mine.json()).quote.status, "approved");

    // Decided, so it leaves the queue — an approvals list that keeps showing
    // what has been approved is one nobody can work down to empty.
    const after = await call("GET", "/jobs/quotes/pending", undefined, cookies.clientA);
    assert.equal(
      (await after.json()).quotes.some((quote: { id: string }) => quote.id === ids.quote),
      false,
    );
  });
});

describe("6 — the monthly summary", () => {
  test("it covers twelve months, empty ones included", async () => {
    const res = await call("GET", "/jobs/summary/monthly", undefined, cookies.clientA);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.months.length, 12, "a month with no work was dropped from the series");
    assert.match(body.months[0].month, /^\d{4}-\d{2}$/);
    assert.ok(body.totals.raised >= 3, `expected client A's jobs, got ${body.totals.raised}`);
    assert.equal(typeof body.totals.spendPence, "number");
  });

  test("it is scoped: another organisation's figures are not in it", async () => {
    const theirs = await call("GET", "/jobs/summary/monthly", undefined, cookies.clientB);
    const body = await theirs.json();
    assert.equal(body.totals.raised, 0, "client B was shown client A's activity");
    assert.equal(body.totals.spendPence, 0);
  });

  test("spend follows completion, not the raising of a job", async () => {
    const res = await call("GET", "/jobs/summary/monthly", undefined, cookies.clientA);
    const body = await res.json();
    // Only `ids.job` is complete, and it carries £450.
    assert.equal(body.totals.spendPence, 45000);
    assert.equal(body.totals.completed, 1);
  });

  test("an approved quote stands in where no cost of works was recorded", async () => {
    /*
     * Nothing in this product writes `cost_of_works_pence` — it arrives with
     * imported monday history — so a summary built on that column alone reads
     * £0.00 for a client whose quotes were approved and whose work is done.
     */
    const jobId = await newJob("Cracked pane", null);
    await db.query(
      `insert into quotes (job_id, amount_pence, status, decided_by, decided_at)
       select $1, 22500, 'approved', id, now() from profiles where email = 'assign-admin@maintsupp.test'`,
      [jobId],
    );
    await call("POST", `/jobs/${jobId}/status`, { status: "Job Completed" }, cookies.admin);

    const body = await (
      await call("GET", "/jobs/summary/monthly", undefined, cookies.clientA)
    ).json();
    assert.equal(body.totals.spendPence, 45000 + 22500);
    assert.equal(body.totals.completed, 2);

    // COALESCE, not a sum of both: a job carrying a recorded cost AND an
    // approved quote must not be counted twice.
    await db.query(
      `insert into quotes (job_id, amount_pence, status, decided_by, decided_at)
       select $1, 99900, 'approved', id, now() from profiles where email = 'assign-admin@maintsupp.test'`,
      [ids.job],
    );
    const after = await (
      await call("GET", "/jobs/summary/monthly", undefined, cookies.clientA)
    ).json();
    assert.equal(after.totals.spendPence, 45000 + 22500, "the same work was counted twice");
  });
});

describe("7 — a client_user reports a job from inside the portal", () => {
  test("it lands in job_requests awaiting triage, not on the board", async () => {
    const before = await (await call("GET", "/jobs", undefined, cookies.storeA)).json();

    /*
     * The portal form posts to the SAME endpoint the public form does. There
     * is deliberately no second intake route: a separate authenticated one
     * would be a second copy of the "photographs are mandatory, one issue per
     * ticket" validation, and the copy that drifts is the one that lets a
     * request through without pictures.
     */
    const res = await call("POST", "/public/report-a-job", {
      siteName: "Aldgate",
      contactName: "Assign Store",
      phone: "07700 900321",
      email: "assign-store@client.test",
      address: "1 Whitechapel Road",
      postcode: "E1 1DU",
      faultCategory: "Doors, locks & shutters",
      urgency: "P2",
      description: "The rear fire door does not latch shut.",
      photos: ["intake/portal-report.jpg"],
    }, cookies.storeA);
    assert.equal(res.status, 200);
    assert.match((await res.json()).reference, /^REQ-[0-9A-F]{8}$/);

    const [request] = await db.query<{ id: string; status: string }>(
      "select id::text, status from job_requests where phone = '07700 900321'",
    );
    assert.equal(request.status, "new", "a portal report skipped triage");
    ids.request = request.id;

    const after = await (await call("GET", "/jobs", undefined, cookies.storeA)).json();
    assert.equal(after.total, before.total, "a portal report went straight onto the board");
  });

  test("the client cannot triage their own report", async () => {
    for (const who of ["storeA", "clientA"] as const) {
      assert.equal(
        (await call("GET", "/jobs/intake/pending", undefined, cookies[who])).status,
        403,
      );
      assert.equal(
        (await call("POST", `/jobs/intake/${ids.request}/convert`,
          { organisationId: ids.orgA }, cookies[who])).status,
        403,
      );
    }
  });

  test("a coordinator triages it, and only then is it a job", async () => {
    const res = await call("POST", `/jobs/intake/${ids.request}/convert`,
      { organisationId: ids.orgA, siteId: ids.siteA, priority: "Urgent" }, cookies.admin);
    assert.equal(res.status, 200);

    const board = await (await call("GET", "/jobs", undefined, cookies.storeA)).json();
    assert.ok(
      board.jobs.some((job: { title: string }) => /Doors, locks & shutters/.test(job.title)),
      "the triaged request is not on the reporter's board",
    );
  });

  test("the sites the form pre-fills from are the reporter's own", async () => {
    const mine = await (
      await call("GET", "/jobs/meta/sites", undefined, cookies.storeA)
    ).json();
    assert.equal(mine.sites.length, 1);
    assert.equal(mine.sites[0].postcode, "E1 1DU", "the form has no address to pre-fill");

    const theirs = await (
      await call("GET", "/jobs/meta/sites", undefined, cookies.clientB)
    ).json();
    assert.equal(theirs.sites.length, 0, "a client was offered another client's sites");
  });
});
