/**
 * The full lifecycle, end to end, plus the security tests that must fail.
 *
 * This is the brief's Agent 6 run: a public form submission becomes a job,
 * walks the stages, is completed by a contractor through a share link with no
 * account, and comes back visible to the client — with every cross-tenant and
 * bad-token attempt refused along the way.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type Db } from "../../../packages/db/src/client.ts";
import { createApp } from "../src/server.ts";

let db: Db;
let app: ReturnType<typeof createApp>;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

/** Registers, verifies, approves to a role, and returns the session cookie. */
async function account(
  email: string,
  role: string,
  scope: { organisationId?: string; contractorId?: string; siteIds?: string[] } = {},
) {
  await call("POST", "/auth/register", { email, password: "test-password-1234", fullName: email });
  await db.query("update users set email_verified_at = now() where lower(email) = $1", [email]);
  await db.query(
    `update profiles set role = $2::user_role, status = 'active',
            organisation_id = $3, contractor_id = $4 where email = $1`,
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

function call(method: string, path: string, body?: unknown, cookie?: string) {
  return app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      "x-forwarded-for": `10.1.0.${Math.floor(Math.random() * 250) + 1}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

before(async () => {
  db = await createTestDb();
  app = createApp(db);

  ids.orgA = (
    await db.query<{ id: string }>(
      "insert into organisations (name, slug) values ('Client A','client-a') returning id::text",
    )
  )[0].id;
  ids.orgB = (
    await db.query<{ id: string }>(
      "insert into organisations (name, slug) values ('Client B','client-b') returning id::text",
    )
  )[0].id;
  ids.siteA = (
    await db.query<{ id: string }>(
      "insert into sites (organisation_id, name) values ($1,'Aldgate') returning id::text",
      [ids.orgA],
    )
  )[0].id;
  ids.contractor = (
    await db.query<{ id: string }>(
      "insert into contractors (name) values ('Acme') returning id::text",
    )
  )[0].id;

  cookies.admin = await account("admin@maintsupp.test", "admin");
  cookies.clientA = await account("a@client.test", "client_admin", { organisationId: ids.orgA });
  cookies.clientB = await account("b@client.test", "client_admin", { organisationId: ids.orgB });
  cookies.contractor = await account("c@acme.test", "contractor", { contractorId: ids.contractor });
  cookies.pending = (async () => {
    await call("POST", "/auth/register", {
      email: "pending@client.test", password: "test-password-1234", fullName: "Pending",
    });
    await db.query("update users set email_verified_at = now() where lower(email) = 'pending@client.test'");
    const res = await call("POST", "/auth/sign-in", {
      email: "pending@client.test", password: "test-password-1234",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0];
  }) as never;
  cookies.pending = await (cookies.pending as unknown as () => Promise<string>)();
});

after(async () => { await db.close(); });

describe("1 — the public form", () => {
  test("a request without photographs is refused", async () => {
    const res = await call("POST", "/public/report-a-job", {
      siteName: "Aldgate", contactName: "Dana", phone: "07700 900000",
      email: "dana@store.test", description: "The front shutter is jammed open.",
      faultCategory: "Locks", photos: [],
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /photograph/i);
  });

  test("a complete request is stored and given a reference", async () => {
    const res = await call("POST", "/public/report-a-job", {
      siteName: "Aldgate", contactName: "Dana", phone: "07700 900000",
      email: "dana@store.test", description: "The front shutter is jammed open.",
      faultCategory: "Locks", urgency: "P1", photos: ["intake/shutter.jpg"],
    });
    assert.equal(res.status, 200);
    const { reference } = await res.json();
    assert.match(reference, /^REQ-[0-9A-F]{8}$/);

    const [row] = await db.query<{ id: string; status: string }>(
      "select id::text, status from job_requests where email = 'dana@store.test'");
    assert.equal(row.status, "new");
    ids.request = row.id;
  });

  test("the portfolio review form stores a lead", async () => {
    const res = await call("POST", "/public/portfolio-review", {
      name: "Sam", company: "Retail Co", email: "sam@retail.test", siteRange: "10-25",
      regions: ["North"], challenge: "We have no single view of maintenance across our stores.",
    });
    assert.equal(res.status, 200);
    const [row] = await db.query<{ n: string }>("select count(*)::int as n from leads");
    assert.equal(Number(row.n), 1);
  });
});

describe("2 — triage", () => {
  test("a client cannot see the triage queue", async () => {
    assert.equal((await call("GET", "/jobs/intake/pending", undefined, cookies.clientA)).status, 403);
  });

  test("an admin converts the request into a job", async () => {
    const queue = await call("GET", "/jobs/intake/pending", undefined, cookies.admin);
    assert.equal((await queue.json()).requests.length, 1);

    const res = await call("POST", `/jobs/intake/${ids.request}/convert`,
      { organisationId: ids.orgA, siteId: ids.siteA, priority: "Urgent" }, cookies.admin);
    assert.equal(res.status, 200);
    const { job } = await res.json();
    assert.match(job.reference, /^MS-\d{5}$/);
    ids.job = job.id;

    const [request] = await db.query<{ status: string; converted: string | null }>(
      "select status, converted_job_id::text as converted from job_requests where id = $1",
      [ids.request]);
    assert.equal(request.status, "converted");
    assert.equal(request.converted, ids.job);
  });

  test("the same request cannot be converted twice", async () => {
    const res = await call("POST", `/jobs/intake/${ids.request}/convert`,
      { organisationId: ids.orgA }, cookies.admin);
    assert.equal(res.status, 404);
  });
});

describe("3 — the job walks the stages", () => {
  test("status changes carry the stage with them", async () => {
    for (const [status, stage] of [
      ["Job Scheduled", "Scheduling"],
      ["Job In Progress", "In Progress"],
      ["Quote requested", "Quotes"],
    ] as const) {
      const res = await call("POST", `/jobs/${ids.job}/status`, { status }, cookies.admin);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).job.stage, stage);
    }
  });

  test("an unknown status is refused", async () => {
    const res = await call("POST", `/jobs/${ids.job}/status`, { status: "Invented" }, cookies.admin);
    assert.equal(res.status, 400);
  });

  test("a client cannot move a job's status", async () => {
    assert.equal(
      (await call("POST", `/jobs/${ids.job}/status`, { status: "Job Completed" }, cookies.clientA)).status,
      403);
  });
});

describe("4 — the share link, with no account", () => {
  before(async () => {
    const [row] = await db.query<{ t: string }>(
      "select share_token as t from jobs where id = $1", [ids.job]);
    ids.token = row.t;
  });

  test("a wrong or guessed token returns nothing", async () => {
    for (const bad of [
      "0".repeat(64),                       // right shape, wrong value
      "not-a-token",                        // wrong shape
      ids.token.slice(0, 63),               // one character short
      `${ids.token.slice(0, 62)}ff`,        // near-miss
    ]) {
      const res = await call("GET", `/public/job/${bad}`);
      assert.equal(res.status, 404, `token ${bad.slice(0, 12)}… was accepted`);
    }
  });

  test("the real token opens the full ticket with no login", async () => {
    const res = await call("GET", `/public/job/${ids.token}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.job.reference.startsWith("MS-"), true);
    assert.equal(body.job.site_name, "Aldgate");
    // The owner's decision: the shared view is the full ticket, money included.
    assert.ok("cost_of_works_pence" in body.job, "money fields were hidden by default");
  });

  test("a contractor comments without an account, and must give a name", async () => {
    assert.equal((await call("POST", `/public/job/${ids.token}/comment`,
      { body: "On site now" })).status, 400);

    const res = await call("POST", `/public/job/${ids.token}/comment`,
      { body: "Replaced the lock barrel.", authorName: "Dave (Acme)" });
    assert.equal(res.status, 200);
  });

  test("marking the work complete moves the job and is attributed", async () => {
    const res = await call("POST", `/public/job/${ids.token}/complete`,
      { authorName: "Dave (Acme)" });
    assert.equal(res.status, 200);

    const [job] = await db.query<{ status: string; stage: string; done: string | null }>(
      "select status::text, stage::text, date_completed::text as done from jobs where id = $1",
      [ids.job]);
    assert.equal(job.status, "Job Completed");
    assert.equal(job.stage, "Done");
    assert.ok(job.done, "no completion date was recorded");

    const [flag] = await db.query<{ n: string }>(
      "select count(*)::int as n from activity_log where action = 'job.completed_via_share'");
    assert.equal(Number(flag.n), 1, "the completion was not attributed to the share link");
  });

  test("a revoked link stops working, and is indistinguishable from a wrong one", async () => {
    await call("POST", `/jobs/${ids.job}/share/disable`, {}, cookies.admin);
    const revoked = await call("GET", `/public/job/${ids.token}`);
    const wrong = await call("GET", `/public/job/${"0".repeat(64)}`);
    assert.equal(revoked.status, 404);
    assert.deepEqual(await revoked.json(), await wrong.json());
  });

  test("rotating the link issues a new token and retires the old one", async () => {
    const res = await call("POST", `/jobs/${ids.job}/share/rotate`, {}, cookies.admin);
    const { shareToken } = await res.json();
    assert.notEqual(shareToken, ids.token);
    assert.equal((await call("GET", `/public/job/${ids.token}`)).status, 404);
    assert.equal((await call("GET", `/public/job/${shareToken}`)).status, 200);
  });
});

describe("5 — everything flows back to the one record", () => {
  test("the contractor's comment appears inside the portal on the same job", async () => {
    const res = await call("GET", `/jobs/${ids.job}`, undefined, cookies.admin);
    const { job, comments } = await res.json();
    assert.equal(job.id, ids.job);

    const viaLink = comments.filter((x: { via_share_link: boolean }) => x.via_share_link);
    assert.equal(viaLink.length, 2, "the share-link activity is not on the job record");
    assert.equal(viaLink[0].author_name, "Dave (Acme)");
  });

  test("the client sees their own closed job", async () => {
    const res = await call("GET", "/jobs", undefined, cookies.clientA);
    const { jobs: list, total } = await res.json();
    assert.equal(total, 1);
    assert.equal(list[0].id, ids.job);
    assert.equal(list[0].status, "Job Completed");
  });
});

describe("6 — the security tests that must fail", () => {
  test("client B cannot read client A's job, by list or by id", async () => {
    const list = await call("GET", "/jobs", undefined, cookies.clientB);
    assert.equal((await list.json()).total, 0, "client B saw client A's jobs");

    // 404 and not 403: "forbidden" would confirm the row exists.
    const direct = await call("GET", `/jobs/${ids.job}`, undefined, cookies.clientB);
    assert.equal(direct.status, 404);
  });

  test("a contractor cannot open a job that is not assigned to them", async () => {
    const res = await call("GET", `/jobs/${ids.job}`, undefined, cookies.contractor);
    assert.equal(res.status, 404);
  });

  test("an assigned contractor can, and still sees no money", async () => {
    await db.query("update jobs set contractor_id = $2, cost_of_works_pence = 45000 where id = $1",
      [ids.job, ids.contractor]);
    const res = await call("GET", `/jobs/${ids.job}`, undefined, cookies.contractor);
    assert.equal(res.status, 200);
    const { job } = await res.json();
    assert.equal("cost_of_works_pence" in job, false, "a contractor was shown pricing");
    assert.equal("invoice_ref" in job, false);
  });

  test("an unauthenticated caller reaches nothing behind the login", async () => {
    for (const path of ["/jobs", "/jobs/summary", "/members", "/jobs/intake/pending"]) {
      assert.equal((await call("GET", path)).status, 401, `${path} was reachable signed out`);
    }
  });

  test("a pending-approval account cannot reach a dashboard", async () => {
    const res = await call("GET", "/jobs", undefined, cookies.pending);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).status, "pending_approval");
  });

  test("a client cannot reach the Members page", async () => {
    assert.equal((await call("GET", "/members", undefined, cookies.clientA)).status, 403);
  });

  test("an admin cannot invite someone more powerful than themselves", async () => {
    const up = await call("POST", "/members/invite",
      { email: "x@y.test", role: "super_admin" }, cookies.admin);
    assert.equal(up.status, 403);

    const owner = await call("POST", "/members/invite",
      { email: "x@y.test", role: "owner" }, cookies.admin);
    assert.equal(owner.status, 403);
  });

  test("the owner account cannot be modified through the API", async () => {
    await call("POST", "/auth/register", {
      email: "anwarrshboul@gmail.com", password: "owner-password-here", fullName: "Anwar",
    });
    const [owner] = await db.query<{ id: string }>(
      "select id::text from profiles where email = 'anwarrshboul@gmail.com'");

    for (const action of ["role", "deactivate"]) {
      const res = await call("POST", `/members/${owner.id}/${action}`,
        { role: "client_user" }, cookies.admin);
      assert.equal(res.status, 403, `an admin could ${action} the owner`);
    }

    const [after] = await db.query<{ role: string; status: string }>(
      "select role, status from profiles where email = 'anwarrshboul@gmail.com'");
    assert.equal(after.role, "owner");
    assert.equal(after.status, "active");
  });

  test("a client_admin cannot decide a quote on another client's job", async () => {
    const [quote] = await db.query<{ id: string }>(
      "insert into quotes (job_id, amount_pence) values ($1, 12345) returning id::text",
      [ids.job]);
    const res = await call("POST", `/jobs/quotes/${quote.id}/decide`,
      { decision: "approved" }, cookies.clientB);
    assert.equal(res.status, 404, "client B decided a quote on client A's job");

    const ok = await call("POST", `/jobs/quotes/${quote.id}/decide`,
      { decision: "approved" }, cookies.clientA);
    assert.equal(ok.status, 200);
  });
});

describe("7 — members", () => {
  test("an admin approves a pending account and it gains access", async () => {
    const [pending] = await db.query<{ id: string }>(
      "select id::text from profiles where email = 'pending@client.test'");

    const res = await call("POST", `/members/${pending.id}/approve`,
      { role: "client_user", organisationId: ids.orgA, siteIds: [ids.siteA] }, cookies.admin);
    assert.equal(res.status, 200);

    const after = await call("GET", "/jobs", undefined, cookies.pending);
    assert.equal(after.status, 200, "an approved account still could not reach the dashboard");
    assert.equal((await after.json()).total, 1);
  });

  test("approving a client role with no organisation is refused", async () => {
    await call("POST", "/auth/register", {
      email: "noscope@client.test", password: "test-password-1234", fullName: "No Scope",
    });
    const [row] = await db.query<{ id: string }>(
      "select id::text from profiles where email = 'noscope@client.test'");
    const res = await call("POST", `/members/${row.id}/approve`,
      { role: "client_admin" }, cookies.admin);
    assert.equal(res.status, 400, "an active client_admin was created with no organisation");
  });

  test("deactivating a member kills their live sessions immediately", async () => {
    const cookie = await account("temp@client.test", "client_admin", { organisationId: ids.orgA });
    assert.equal((await call("GET", "/jobs", undefined, cookie)).status, 200);

    const [row] = await db.query<{ id: string }>(
      "select id::text from profiles where email = 'temp@client.test'");
    const res = await call("POST", `/members/${row.id}/deactivate`, {}, cookies.admin);
    assert.equal(res.status, 200);
    assert.ok((await res.json()).sessionsRevoked >= 1);

    assert.equal((await call("GET", "/jobs", undefined, cookie)).status, 401,
      "a deactivated member kept browsing on their existing cookie");
  });
});
