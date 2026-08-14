/**
 * The compliance register and the invoice ledger.
 *
 * Most of this file is about two numbers that have already gone wrong in this
 * product's history and would go wrong again silently:
 *
 *   1. THE COMPLIANCE DENOMINATOR. A score is a fraction, and a fraction whose
 *      denominator nobody states is a number that can halve without anything
 *      being broken. `not_required` must leave the denominator entirely — not
 *      count as a failure, not count as a pass — and a certificate whose date
 *      has passed must read Expired even though the row that stored 'Valid' has
 *      not been touched since.
 *   2. WHO SEES MONEY. A contractor must not reach an invoice by any route, and
 *      one client must not reach another's — by list, by id, by total, or by
 *      asking for the PDF.
 *
 * Storage is pointed at a throwaway directory before the app is built, so the
 * certificate and PDF uploads run against the real local driver.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const storageDir = await mkdtemp(path.join(tmpdir(), "maintsupp-compliance-"));
process.env.STORAGE_DIR = storageDir;
process.env.UPLOAD_SIGNING_SECRET = "test-signing-secret-not-a-real-one";
// The S3 driver must not be picked up from a developer's shell.
for (const key of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
  delete process.env[key];
}

const { createTestDb } = await import("../../../packages/db/src/client.ts");
type Db = Awaited<ReturnType<typeof createTestDb>>;
const { createApp } = await import("../src/server.ts");

let db: Db;
let app: ReturnType<typeof createApp>;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

/** How many requirements every site is measured against. The denominator. */
let CATALOGUE = 0;

let ipCounter = 0;
const freshIp = () => `10.7.${Math.floor(ipCounter / 250) % 250}.${(ipCounter++ % 250) + 1}`;

function call(method: string, path: string, body?: unknown, cookie?: string) {
  return app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      "x-forwarded-for": freshIp(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function upload(
  path: string,
  file: { bytes: Uint8Array; type: string; name: string },
  fields: Record<string, string> = {},
  cookie?: string,
) {
  const form = new FormData();
  form.set(
    "file",
    new Blob([file.bytes as unknown as BlobPart], { type: file.type }),
    file.name,
  );
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return app.request(path, {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}), "x-forwarded-for": freshIp() },
    body: form,
  });
}

const pdf = (): Uint8Array =>
  new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n1 0 obj\n");

/** A date `days` from today, as YYYY-MM-DD, which is what the API takes. */
function dateIn(days: number): string {
  const when = new Date();
  when.setUTCDate(when.getUTCDate() + days);
  return when.toISOString().slice(0, 10);
}

async function account(
  email: string,
  role: string,
  scope: { organisationId?: string; contractorId?: string; siteIds?: string[] } = {},
) {
  await call("POST", "/auth/register", {
    email, password: "test-password-1234", fullName: email,
  });
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

before(async () => {
  db = await createTestDb();
  app = createApp(db);

  const org = async (name: string, slug: string) =>
    (
      await db.query<{ id: string }>(
        "insert into organisations (name, slug) values ($1,$2) returning id::text",
        [name, slug],
      )
    )[0].id;
  const site = async (organisationId: string, name: string) =>
    (
      await db.query<{ id: string }>(
        "insert into sites (organisation_id, name) values ($1,$2) returning id::text",
        [organisationId, name],
      )
    )[0].id;

  ids.orgA = await org("Client A", "client-a");
  ids.orgB = await org("Client B", "client-b");
  ids.siteA1 = await site(ids.orgA, "Aldgate");
  ids.siteA2 = await site(ids.orgA, "Bullring");
  ids.siteB = await site(ids.orgB, "Silverburn");

  ids.contractor = (
    await db.query<{ id: string }>(
      "insert into contractors (name) values ('Acme') returning id::text",
    )
  )[0].id;

  ids.jobA = (
    await db.query<{ id: string }>(
      `insert into jobs (organisation_id, site_id, title, description, contractor_id)
       values ($1,$2,'Shutter jammed','Front shutter',$3) returning id::text`,
      [ids.orgA, ids.siteA1, ids.contractor],
    )
  )[0].id;
  ids.jobB = (
    await db.query<{ id: string }>(
      `insert into jobs (organisation_id, site_id, title, description)
       values ($1,$2,'Lights out','Back run') returning id::text`,
      [ids.orgB, ids.siteB],
    )
  )[0].id;

  cookies.admin = await account("admin@maintsupp.test", "admin");
  cookies.clientA = await account("a@client.test", "client_admin", { organisationId: ids.orgA });
  cookies.clientB = await account("b@client.test", "client_admin", { organisationId: ids.orgB });
  cookies.user = await account("u@client.test", "client_user", {
    organisationId: ids.orgA,
    siteIds: [ids.siteA1],
  });
  cookies.contractor = await account("c@acme.test", "contractor", {
    contractorId: ids.contractor,
  });

  const [row] = await db.query<{ n: number }>(
    "select count(*)::int as n from compliance_requirements where active",
  );
  CATALOGUE = Number(row.n);
});

after(async () => {
  await db.close();
  await rm(storageDir, { recursive: true, force: true });
});

/* ================================================================ 1 — the register == */

describe("1 — the register lists what is required, not what was filed", () => {
  test("the twelve requirements are the catalogue, and three of them never expire", async () => {
    assert.equal(CATALOGUE, 12, "the requirement catalogue is not twelve entries");
    const [row] = await db.query<{ n: number }>(
      "select count(*)::int as n from compliance_requirements where active and not expires",
    );
    assert.equal(Number(row.n), 3, "RAMS, the fire risk assessment and the drawing carry no expiry");
  });

  test("a site with nothing on file reports every requirement as Missing", async () => {
    const res = await call("GET", "/compliance", undefined, cookies.clientA);
    assert.equal(res.status, 200);
    const body = await res.json();

    const aldgate = body.sites.find((s: { name: string }) => s.name === "Aldgate");
    assert.ok(aldgate, "the client's own site is not in their register");
    assert.equal(aldgate.score.required, CATALOGUE);
    assert.equal(aldgate.score.missing, CATALOGUE);
    assert.equal(aldgate.score.inDate, 0);
    assert.equal(aldgate.score.percent, 0);
  });

  test("the score states its denominator, not just a percentage", async () => {
    const res = await call("GET", "/compliance", undefined, cookies.clientA);
    const { summary } = await res.json();
    for (const key of ["required", "inDate", "valid", "expiring", "expired", "missing", "notRequired"]) {
      assert.equal(typeof summary[key], "number", `the summary has no ${key} to print`);
    }
    // Two sites, twelve requirements each, nothing filed yet.
    assert.equal(summary.sites, 2);
    assert.equal(summary.required, CATALOGUE * 2);
  });
});

/* ============================================== 2 — the status is recomputed == */

describe("2 — status is computed from the date, never trusted from the row", () => {
  test("an in-date certificate is Valid", async () => {
    const res = await call("POST", `/compliance/site/${ids.siteA1}/pat/expiry`,
      { expiryDate: dateIn(300) }, cookies.admin);
    assert.equal(res.status, 200);

    const site = await (await call("GET", `/compliance/site/${ids.siteA1}`, undefined, cookies.admin)).json();
    const pat = site.requirements.find((r: { kind: string }) => r.kind === "pat");
    assert.equal(pat.status, "Valid");
  });

  test("one inside the 90-day window is Expiring, and still counts as in date", async () => {
    await call("POST", `/compliance/site/${ids.siteA1}/fire_alarm/expiry`,
      { expiryDate: dateIn(30) }, cookies.admin);

    const site = await (await call("GET", `/compliance/site/${ids.siteA1}`, undefined, cookies.admin)).json();
    const alarm = site.requirements.find((r: { kind: string }) => r.kind === "fire_alarm");
    assert.equal(alarm.status, "Expiring");
    assert.equal(site.score.expiring, 1);
    assert.equal(site.score.inDate, 2, "an expiring certificate is still in date");
  });

  test("AN EXPIRED CERTIFICATE READS Expired, NOT Valid, however the row was stored", async () => {
    await call("POST", `/compliance/site/${ids.siteA1}/pli/expiry`,
      { expiryDate: dateIn(-10) }, cookies.admin);

    /*
     * The stored column is forced back to 'Valid' behind the API's back, with
     * the trigger switched off — which is exactly what TIME does to it. A row
     * written 'Valid' in January is still 'Valid' in December because nothing
     * writes to a row on the morning its certificate expires, and no trigger
     * fires for an event that never happens. The read must ignore it.
     */
    await db.exec("alter table compliance_documents disable trigger compliance_stamp_status");
    await db.query(
      "update compliance_documents set status = 'Valid' where site_id = $1 and kind = 'pli'",
      [ids.siteA1],
    );
    await db.exec("alter table compliance_documents enable trigger compliance_stamp_status");
    const [stored] = await db.query<{ status: string }>(
      "select status::text from compliance_documents where site_id = $1 and kind = 'pli'",
      [ids.siteA1],
    );
    assert.equal(stored.status, "Valid", "the stale value was not set up");

    const site = await (await call("GET", `/compliance/site/${ids.siteA1}`, undefined, cookies.admin)).json();
    const pli = site.requirements.find((r: { kind: string }) => r.kind === "pli");
    assert.equal(pli.status, "Expired", "a stale stored status was served as the truth");
    assert.equal(site.score.expired, 1);
  });

  test("a requirement that never expires is Missing until a file arrives, and a date on it is refused", async () => {
    const site = await (await call("GET", `/compliance/site/${ids.siteA1}`, undefined, cookies.admin)).json();
    const rams = site.requirements.find((r: { kind: string }) => r.kind === "rams");
    assert.equal(rams.expires, false);
    assert.equal(rams.status, "Missing");

    const res = await call("POST", `/compliance/site/${ids.siteA1}/rams/expiry`,
      { expiryDate: dateIn(200) }, cookies.admin);
    assert.equal(res.status, 400, "a date was accepted on a requirement that cannot expire");
  });

  test("an unknown requirement is a 404, not a new row", async () => {
    const res = await call("POST", `/compliance/site/${ids.siteA1}/invented_certificate/expiry`,
      { expiryDate: dateIn(100) }, cookies.admin);
    assert.equal(res.status, 404);
  });
});

/* ================================================ 3 — the denominator == */

describe("3 — not_required leaves the denominator", () => {
  test("marking one not required needs a reason", async () => {
    const res = await call("POST", `/compliance/site/${ids.siteA2}/sprinkler/not-required`,
      {}, cookies.admin);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /why/i);
  });

  test("IT IS EXCLUDED FROM THE DENOMINATOR, NOT COUNTED AS A FAILURE", async () => {
    const before = await (
      await call("GET", `/compliance/site/${ids.siteA2}`, undefined, cookies.admin)
    ).json();
    assert.equal(before.score.required, CATALOGUE);
    assert.equal(before.score.missing, CATALOGUE);

    const res = await call("POST", `/compliance/site/${ids.siteA2}/sprinkler/not-required`,
      { reason: "No sprinkler system in this unit." }, cookies.admin);
    assert.equal(res.status, 200);

    const after = await (
      await call("GET", `/compliance/site/${ids.siteA2}`, undefined, cookies.admin)
    ).json();
    assert.equal(after.score.required, CATALOGUE - 1, "the denominator did not shrink");
    assert.equal(after.score.notRequired, 1);
    assert.equal(after.score.missing, CATALOGUE - 1, "it was counted as a failure");

    const sprinkler = after.requirements.find((r: { kind: string }) => r.kind === "sprinkler");
    assert.equal(sprinkler.status, "Not required");
    assert.equal(sprinkler.not_required_reason, "No sprinkler system in this unit.");
  });

  test("the portfolio denominator moves with it too", async () => {
    const { summary } = await (await call("GET", "/compliance", undefined, cookies.clientA)).json();
    assert.equal(summary.required, CATALOGUE * 2 - 1);
    assert.equal(summary.notRequired, 1);
  });

  test("putting it back restores the denominator and clears the reason", async () => {
    await call("POST", `/compliance/site/${ids.siteA2}/sprinkler/required`, {}, cookies.admin);
    const after = await (
      await call("GET", `/compliance/site/${ids.siteA2}`, undefined, cookies.admin)
    ).json();
    assert.equal(after.score.required, CATALOGUE);
    assert.equal(after.score.notRequired, 0);

    // Restored for the tests below, which read the same site.
    await call("POST", `/compliance/site/${ids.siteA2}/sprinkler/not-required`,
      { reason: "No sprinkler system in this unit." }, cookies.admin);
  });

  test("the database itself refuses a reasonless not_required", async () => {
    await assert.rejects(
      db.query(
        `insert into compliance_documents (organisation_id, site_id, kind, not_required)
         values ($1,$2,'water_hygiene',true)`,
        [ids.orgB, ids.siteB],
      ),
      "a not_required row with no reason was accepted",
    );
  });
});

/* ================================================== 4 — certificates == */

describe("4 — the certificate goes through the one upload pipeline", () => {
  test("a PDF is stored, dated, and readable only through a signed URL", async () => {
    const res = await upload(
      `/compliance/site/${ids.siteA1}/electrical_wiring/certificate`,
      { bytes: pdf(), type: "application/pdf", name: "eicr.pdf" },
      { expiryDate: dateIn(500) },
      cookies.admin,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.document.status, "Valid");
    ids.certificate = body.attachmentId;

    const [file] = await db.query<{ object_key: string; site_id: string; kind: string }>(
      "select object_key, site_id::text, kind::text from attachments where id = $1",
      [ids.certificate],
    );
    assert.match(file.object_key, /^compliance\//);
    assert.equal(file.site_id, ids.siteA1, "the certificate is not owned by the site");
    assert.equal(file.kind, "file", "a certificate was filed as a picture");

    // Served by the SAME endpoint as every other attachment, under siteScopeFor.
    const url = await call("GET", `/uploads/${ids.certificate}/url`, undefined, cookies.clientA);
    assert.equal(url.status, 200);
    assert.match((await url.json()).url, /token=/);
  });

  test("a file that lies about its type is refused, as everywhere else", async () => {
    const res = await upload(
      `/compliance/site/${ids.siteA1}/fire_door/certificate`,
      { bytes: pdf(), type: "image/png", name: "certificate.png" },
      {},
      cookies.admin,
    );
    assert.equal(res.status, 415);
  });

  test("replacing one keeps the superseded copy findable", async () => {
    const res = await upload(
      `/compliance/site/${ids.siteA1}/electrical_wiring/certificate`,
      { bytes: pdf(), type: "application/pdf", name: "eicr-2027.pdf" },
      { expiryDate: dateIn(700) },
      cookies.admin,
    );
    assert.equal(res.status, 200);

    const site = await (
      await call("GET", `/compliance/site/${ids.siteA1}`, undefined, cookies.admin)
    ).json();
    const wiring = site.requirements.find((r: { kind: string }) => r.kind === "electrical_wiring");
    assert.equal(wiring.original_name, "eicr-2027.pdf");
    assert.equal(wiring.previous.length, 1, "the superseded certificate was lost");
    assert.equal(wiring.previous[0].original_name, "eicr.pdf");
  });

  test("a client_user may read their site but not change it", async () => {
    const read = await call("GET", `/compliance/site/${ids.siteA1}`, undefined, cookies.user);
    assert.equal(read.status, 200);
    assert.equal((await read.json()).canManage, false);

    const write = await call("POST", `/compliance/site/${ids.siteA1}/pat/expiry`,
      { expiryDate: dateIn(10) }, cookies.user);
    assert.equal(write.status, 403);
  });
});

/* ==================================================== 5 — the calendar == */

describe("5 — the calendar", () => {
  test("expired, the next three months, and the rest of the year are separated", async () => {
    const res = await call("GET", "/compliance/calendar", undefined, cookies.clientA);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.expiringWithinDays, 90);
    assert.ok(body.expired.some((row: { kind: string }) => row.kind === "pli"),
      "the expired PLI is not flagged");
    assert.ok(body.soon.some((row: { kind: string }) => row.kind === "fire_alarm"),
      "a certificate expiring in 30 days is not in the next three months");
    assert.ok(body.later.some((row: { kind: string }) => row.kind === "pat"),
      "a certificate expiring in 300 days is not in the twelve-month window");

    assert.ok(body.expired.every((row: { days_left: number }) => row.days_left < 0));
    assert.ok(body.soon.every((row: { days_left: number }) => row.days_left >= 0 && row.days_left <= 90));
  });

  test("a not_required requirement never appears in it", async () => {
    await call("POST", `/compliance/site/${ids.siteA2}/pat/expiry`,
      { expiryDate: dateIn(20) }, cookies.admin);
    await call("POST", `/compliance/site/${ids.siteA2}/pat/not-required`,
      { reason: "No portable appliances at this unit." }, cookies.admin);

    const body = await (await call("GET", "/compliance/calendar", undefined, cookies.clientA)).json();
    const hit = [...body.expired, ...body.soon, ...body.later].filter(
      (row: { site_id: string; kind: string }) => row.site_id === ids.siteA2 && row.kind === "pat",
    );
    assert.equal(hit.length, 0, "a requirement nobody asks for was put in the diary");
  });
});

/* ============================================ 6 — compliance tenancy == */

describe("6 — one client cannot see another's compliance", () => {
  test("client B's register holds only client B's sites", async () => {
    const body = await (await call("GET", "/compliance", undefined, cookies.clientB)).json();
    assert.equal(body.sites.length, 1);
    assert.equal(body.sites[0].name, "Silverburn");
  });

  test("client B cannot open client A's site, by id", async () => {
    const res = await call("GET", `/compliance/site/${ids.siteA1}`, undefined, cookies.clientB);
    // 404 and not 403: "forbidden" would confirm the site exists.
    assert.equal(res.status, 404);
  });

  test("client B cannot write to client A's site either", async () => {
    const res = await call("POST", `/compliance/site/${ids.siteA1}/pat/expiry`,
      { expiryDate: dateIn(30) }, cookies.clientB);
    assert.equal(res.status, 404);
  });

  test("client B's calendar is empty of client A's expiries", async () => {
    const body = await (await call("GET", "/compliance/calendar", undefined, cookies.clientB)).json();
    const all = [...body.expired, ...body.soon, ...body.later];
    assert.equal(all.filter((row: { site_id: string }) => row.site_id !== ids.siteB).length, 0);
  });

  test("a client_user sees only the sites they were given", async () => {
    const body = await (await call("GET", "/compliance", undefined, cookies.user)).json();
    assert.equal(body.sites.length, 1);
    assert.equal(body.sites[0].id, ids.siteA1);
    assert.equal(
      (await call("GET", `/compliance/site/${ids.siteA2}`, undefined, cookies.user)).status,
      404,
    );
  });

  test("a contractor has no site register at all", async () => {
    const body = await (await call("GET", "/compliance", undefined, cookies.contractor)).json();
    assert.equal(body.sites.length, 0);
    assert.equal(
      (await call("GET", `/compliance/site/${ids.siteA1}`, undefined, cookies.contractor)).status,
      404,
    );
  });

  test("signed out reaches nothing", async () => {
    for (const path of ["/compliance", "/compliance/calendar", `/compliance/site/${ids.siteA1}`]) {
      assert.equal((await call("GET", path)).status, 401, `${path} was reachable signed out`);
    }
  });
});

/* ================================================== 7 — the ledger == */

describe("7 — recording an invoice", () => {
  test("a number and an amount are required, and pounds are not pence", async () => {
    const noNumber = await call("POST", "/invoices",
      { organisationId: ids.orgA, amountPence: 1000 }, cookies.admin);
    assert.equal(noNumber.status, 400);

    const float = await call("POST", "/invoices",
      { organisationId: ids.orgA, invoiceNumber: "INV-BAD", amountPence: 125.5 }, cookies.admin);
    assert.equal(float.status, 400, "a fractional amount was accepted");
    assert.match((await float.json()).error, /whole pence/i);
  });

  test("an invoice against a job takes its client from the job", async () => {
    const res = await call("POST", "/invoices", {
      jobId: ids.jobA, invoiceNumber: "INV-1001", amountPence: 45000,
      issuedAt: dateIn(-30), dueAt: dateIn(-2),
    }, cookies.admin);
    assert.equal(res.status, 200);
    const { invoice } = await res.json();
    assert.equal(invoice.organisation_id, ids.orgA);
    assert.equal(invoice.amount_pence, 45000);
    ids.invoiceA = invoice.id;
  });

  test("it can be found by the job reference somebody reads off the paperwork", async () => {
    const [job] = await db.query<{ reference: string }>(
      "select reference from jobs where id = $1", [ids.jobA]);
    const res = await call("POST", "/invoices", {
      jobReference: job.reference.toLowerCase(), invoiceNumber: "INV-1002",
      amountPence: 12000, issuedAt: dateIn(-5), dueAt: dateIn(25),
    }, cookies.admin);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).invoice.organisation_id, ids.orgA);
  });

  test("the same number cannot be recorded twice for one client", async () => {
    const res = await call("POST", "/invoices", {
      organisationId: ids.orgA, invoiceNumber: " inv-1001 ", amountPence: 45000,
    }, cookies.admin);
    assert.equal(res.status, 409, "a duplicate invoice number doubled the client's balance");
  });

  test("but two clients may each have an INV-1001 of their own", async () => {
    const res = await call("POST", "/invoices", {
      organisationId: ids.orgB, invoiceNumber: "INV-1001", amountPence: 9900,
      issuedAt: dateIn(-3), dueAt: dateIn(27),
    }, cookies.admin);
    assert.equal(res.status, 200);
    ids.invoiceB = (await res.json()).invoice.id;
  });

  test("a due date before the issue date is refused", async () => {
    const res = await call("POST", "/invoices", {
      organisationId: ids.orgA, invoiceNumber: "INV-1003", amountPence: 100,
      issuedAt: dateIn(10), dueAt: dateIn(1),
    }, cookies.admin);
    assert.equal(res.status, 400);
  });

  test("a client cannot record one against themselves", async () => {
    const res = await call("POST", "/invoices",
      { organisationId: ids.orgA, invoiceNumber: "INV-SELF", amountPence: 100 }, cookies.clientA);
    assert.equal(res.status, 403);
  });
});

describe("8 — outstanding, overdue and paid", () => {
  test("an unpaid invoice past its due date reads Overdue without anything writing it", async () => {
    const body = await (await call("GET", "/invoices?status=overdue", undefined, cookies.admin)).json();
    const overdue = body.invoices.find((row: { id: string }) => row.id === ids.invoiceA);
    assert.ok(overdue, "an invoice two days past due is not on the overdue list");
    assert.equal(overdue.status, "overdue");

    const [stored] = await db.query<{ status: string }>(
      "select status::text from invoices where id = $1", [ids.invoiceA]);
    assert.equal(stored.status, "awaiting_payment", "'overdue' was written to the row");
  });

  test("outstanding is everything unpaid, late or not", async () => {
    const body = await (await call("GET", "/invoices?status=outstanding", undefined, cookies.clientA)).json();
    assert.equal(body.total, 2);
    assert.equal(body.totals.outstandingPence, 57000);
    assert.equal(body.totals.overduePence, 45000);
  });

  test("marking one paid records when, and takes it out of the chase list", async () => {
    const res = await call("POST", `/invoices/${ids.invoiceA}/paid`,
      { paidAt: dateIn(0) }, cookies.admin);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).invoice.status, "paid");

    const body = await (await call("GET", "/invoices?status=outstanding", undefined, cookies.clientA)).json();
    assert.equal(body.total, 1);
    assert.equal(body.totals.outstandingPence, 12000);
  });

  test("a client cannot mark their own invoice paid", async () => {
    const res = await call("POST", `/invoices/${ids.invoiceB}/paid`, {}, cookies.clientB);
    assert.equal(res.status, 403);
  });

  test("the organisation view totals each client separately", async () => {
    const body = await (await call("GET", "/invoices/summary", undefined, cookies.admin)).json();
    const a = body.organisations.find((row: { organisationName: string }) => row.organisationName === "Client A");
    const b = body.organisations.find((row: { organisationName: string }) => row.organisationName === "Client B");

    assert.equal(a.totalPence, 57000);
    assert.equal(a.paidPence, 45000);
    assert.equal(a.outstandingPence, 12000);
    assert.equal(b.totalPence, 9900);
    assert.equal(body.totals.totalPence, 66900);
  });

  test("cancelling takes an invoice out of every total, and keeps the row", async () => {
    const res = await call("POST", `/invoices/${ids.invoiceB}/cancel`,
      { reason: "Raised against the wrong client." }, cookies.admin);
    assert.equal(res.status, 200);

    const body = await (await call("GET", "/invoices/summary", undefined, cookies.admin)).json();
    const b = body.organisations.find((row: { organisationName: string }) => row.organisationName === "Client B");
    assert.equal(b.outstandingPence, 0);
    assert.equal(b.invoiceCount, 1, "the record was deleted rather than cancelled");
  });
});

/* ============================================== 9 — money tenancy == */

describe("9 — the money tests that must fail", () => {
  test("A CONTRACTOR GETS NO INVOICES AT ALL", async () => {
    for (const path of ["/invoices", "/invoices/summary", `/invoices/${ids.invoiceA}`,
      `/invoices/${ids.invoiceA}/pdf`]) {
      const res = await call("GET", path, undefined, cookies.contractor);
      assert.equal(res.status, 403, `${path} answered a contractor`);
    }
    const write = await call("POST", "/invoices",
      { organisationId: ids.orgA, invoiceNumber: "INV-C", amountPence: 1 }, cookies.contractor);
    assert.equal(write.status, 403);
  });

  test("CLIENT B CANNOT SEE CLIENT A'S INVOICES, by list, by total or by id", async () => {
    const list = await (await call("GET", "/invoices", undefined, cookies.clientB)).json();
    assert.equal(
      list.invoices.filter((row: { organisation_id: string }) => row.organisation_id === ids.orgA).length,
      0,
      "client B was shown client A's invoices",
    );

    const summary = await (await call("GET", "/invoices/summary", undefined, cookies.clientB)).json();
    assert.equal(summary.organisations.length, 1);
    assert.equal(summary.organisations[0].organisationId, ids.orgB);

    const direct = await call("GET", `/invoices/${ids.invoiceA}`, undefined, cookies.clientB);
    assert.equal(direct.status, 404);
  });

  test("a site-scoped client_user sees job invoices for their site and no account-level ones", async () => {
    const orgLevel = await call("POST", "/invoices", {
      organisationId: ids.orgA, invoiceNumber: "INV-FEE-01", amountPence: 30000,
      issuedAt: dateIn(-1), dueAt: dateIn(29),
    }, cookies.admin);
    assert.equal(orgLevel.status, 200);
    const feeId = (await orgLevel.json()).invoice.id;

    const body = await (await call("GET", "/invoices", undefined, cookies.user)).json();
    const seen = body.invoices.map((row: { id: string }) => row.id);
    assert.ok(seen.includes(ids.invoiceA), "the invoice for their own site's job was hidden");
    assert.equal(seen.includes(feeId), false,
      "a store-scoped user was shown an account-level invoice");
  });

  test("the invoice PDF is not reachable through the ordinary uploads route", async () => {
    const attach = await upload(`/invoices/${ids.invoiceA}/pdf`,
      { bytes: pdf(), type: "application/pdf", name: "INV-1001.pdf" }, {}, cookies.admin);
    assert.equal(attach.status, 200);
    const attachmentId = (await attach.json()).attachment.id;

    // Owned by the invoice, so /uploads/:id/url matches none of its four owner
    // branches — which is what keeps it away from the assigned contractor.
    const viaUploads = await call("GET", `/uploads/${attachmentId}/url`, undefined, cookies.contractor);
    assert.equal(viaUploads.status, 404);
    const viaUploadsAdmin = await call("GET", `/uploads/${attachmentId}/url`, undefined, cookies.admin);
    assert.equal(viaUploadsAdmin.status, 404);

    // The money-gated route serves it.
    const proper = await call("GET", `/invoices/${ids.invoiceA}/pdf`, undefined, cookies.clientA);
    assert.equal(proper.status, 200);
    assert.match((await proper.json()).url, /token=/);

    const denied = await call("GET", `/invoices/${ids.invoiceA}/pdf`, undefined, cookies.clientB);
    assert.equal(denied.status, 404);
  });

  test("signed out reaches no part of the ledger", async () => {
    for (const path of ["/invoices", "/invoices/summary", `/invoices/${ids.invoiceA}`]) {
      assert.equal((await call("GET", path)).status, 401, `${path} was reachable signed out`);
    }
  });
});
