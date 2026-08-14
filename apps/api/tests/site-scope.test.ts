/**
 * The cross-tenant leak found by adversarial review, and both of its fixes.
 *
 * `scopeFor()` scopes a `client_user` by organisation AND site. `siteScopeFor()`
 * scoped by site alone — safe only while every `profile_sites` row was
 * guaranteed to belong to the profile's own organisation, and nothing
 * guaranteed it: `POST /members/:id/approve` accepted any site id at all.
 *
 * So approving a store manager with a site from another client gave them that
 * client's site register, compliance register and expiry calendar. `scopeFor`
 * caught the same mis-scoping and returned no jobs, which is precisely what
 * made it hard to see: one predicate held, the other did not, and the endpoints
 * built on the weaker one leaked while the board looked correctly empty.
 *
 * Both halves are tested because either alone leaves the other assumption
 * unchecked — a future endpoint could scope by site, or a future path could
 * write `profile_sites` directly.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type Db } from "../../../packages/db/src/client.ts";
import { createApp } from "../src/server.ts";
import { siteScopeFor, withScope, type Actor } from "../src/lib/access.ts";

let db: Db;
let app: ReturnType<typeof createApp>;
let ownerCookie = "";
const ids: Record<string, string> = {};

const call = (path: string, init: RequestInit = {}, cookie = "") =>
  app.request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      "x-forwarded-for": `10.9.0.${Math.floor(Math.random() * 250) + 1}`,
      ...init.headers,
    },
  });

before(async () => {
  db = await createTestDb();
  app = createApp(db);

  const org = async (name: string, slug: string) =>
    (await db.query<{ id: string }>(
      "insert into organisations (name, slug) values ($1,$2) returning id::text",
      [name, slug],
    ))[0].id;
  const site = async (orgId: string, name: string) =>
    (await db.query<{ id: string }>(
      "insert into sites (organisation_id, name) values ($1,$2) returning id::text",
      [orgId, name],
    ))[0].id;

  ids.orgA = await org("Client A", "scope-a");
  ids.orgB = await org("Client B", "scope-b");
  ids.siteA = await site(ids.orgA, "A — Aldgate");
  ids.siteB = await site(ids.orgB, "B — SECRET STORE");

  // The owner, founded through role_bootstrap exactly as production does.
  await call("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email: "anwarrshboul@gmail.com",
      password: "scope-test-owner-pw",
      fullName: "Owner",
    }),
  });
  await db.query(
    "update users set email_verified_at = now() where lower(email) = 'anwarrshboul@gmail.com'",
  );
  const signIn = await call("/auth/sign-in", {
    method: "POST",
    body: JSON.stringify({
      email: "anwarrshboul@gmail.com",
      password: "scope-test-owner-pw",
    }),
  });
  ownerCookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0];
  assert.ok(ownerCookie.startsWith("ms_session="), "the owner could not sign in");

  await call("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email: "manager@scope-a.test",
      password: "scope-test-manager-pw",
      fullName: "Store Manager",
    }),
  });
  // Confirmed here because sign-in refuses an unverified address — the
  // manager has to be able to sign in for the leak test below to mean anything.
  await db.query(
    "update users set email_verified_at = now() where lower(email) = 'manager@scope-a.test'",
  );
  ids.manager = (await db.query<{ id: string }>(
    "select id::text from profiles where email = 'manager@scope-a.test'",
  ))[0].id;
});

after(async () => {
  await db.close();
});

const actor = (over: Partial<Actor>): Actor => ({
  profileId: ids.manager,
  email: "manager@scope-a.test",
  role: "client_user",
  status: "active",
  organisationId: null,
  contractorId: null,
  siteIds: [],
  ...over,
});

describe("siteScopeFor pairs organisation with site", () => {
  const visible = async (a: Actor) => {
    const { sql, params } = withScope(
      "select s.name from sites s",
      [],
      siteScopeFor(a, "s"),
    );
    const rows = await db.query<{ name: string }>(`${sql} order by s.name`, params);
    return rows.map((r) => r.name);
  };

  test("a client_user sees their own organisation's site", async () => {
    assert.deepEqual(
      await visible(actor({ organisationId: ids.orgA, siteIds: [ids.siteA] })),
      ["A — Aldgate"],
    );
  });

  test("a site id from another organisation yields nothing", async () => {
    // The leak, expressed as one assertion: holding the id is not enough.
    assert.deepEqual(
      await visible(actor({ organisationId: ids.orgA, siteIds: [ids.siteB] })),
      [],
      "a client_user reached a site outside their organisation",
    );
  });

  test("a mixed list returns only the sites that pair correctly", async () => {
    assert.deepEqual(
      await visible(actor({ organisationId: ids.orgA, siteIds: [ids.siteA, ids.siteB] })),
      ["A — Aldgate"],
    );
  });

  test("no organisation denies, rather than falling back to site-only", async () => {
    assert.deepEqual(await visible(actor({ siteIds: [ids.siteA] })), []);
  });
});

describe("approve refuses a site outside the organisation", () => {
  test("the mis-scoped approval is rejected, and nothing is written", async () => {
    const res = await call(
      `/members/${ids.manager}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          role: "client_user",
          organisationId: ids.orgA,
          siteIds: [ids.siteB], // another client's store
        }),
      },
      ownerCookie,
    );
    assert.equal(res.status, 400, "a site from another organisation was accepted");
    assert.match((await res.json()).error, /different organisation/i);

    // The whole approval rolls back — the profile must not be left active with
    // a half-applied scope.
    const [profile] = await db.query<{ status: string }>(
      "select status from profiles where id = $1",
      [ids.manager],
    );
    assert.equal(profile.status, "pending_approval", "the profile was activated anyway");

    const granted = await db.query(
      "select site_id from profile_sites where profile_id = $1",
      [ids.manager],
    );
    assert.equal(granted.length, 0, "a profile_sites row survived the rejection");
  });

  test("a correctly scoped approval still works", async () => {
    const res = await call(
      `/members/${ids.manager}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          role: "client_user",
          organisationId: ids.orgA,
          siteIds: [ids.siteA],
        }),
      },
      ownerCookie,
    );
    assert.equal(res.status, 200);

    const granted = await db.query<{ site_id: string }>(
      "select site_id::text from profile_sites where profile_id = $1",
      [ids.manager],
    );
    assert.deepEqual(granted.map((r) => r.site_id), [ids.siteA]);
  });

  test("the approved manager cannot see the other client's site register", async () => {
    const signIn = await call("/auth/sign-in", {
      method: "POST",
      body: JSON.stringify({
        email: "manager@scope-a.test",
        password: "scope-test-manager-pw",
      }),
    });
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0];
    assert.ok(cookie.startsWith("ms_session="), "the approved manager could not sign in");

    const sites = await call("/jobs/meta/sites", {}, cookie);
    const names = ((await sites.json()).sites ?? []).map((s: { name: string }) => s.name);
    assert.deepEqual(names, ["A — Aldgate"]);
    assert.ok(
      !names.some((n: string) => n.includes("SECRET")),
      "another client's store name was returned",
    );
  });
});
