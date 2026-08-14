/**
 * Schema evidence. Proves the behaviours the product depends on, against a
 * real database rather than by reading the SQL.
 *
 * Run: `node packages/db/src/verify.ts` (in-memory, disposable)
 */
import { createTestDb } from "./client.ts";

const db = await createTestDb();
let failures = 0;

async function check(label: string, fn: () => Promise<string>) {
  try {
    console.log(`  ok    ${label} — ${await fn()}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${label} — ${(error as Error).message}`);
  }
}

const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
  (await db.query<Record<string, T>>(sql, params)).map(
    (r) => Object.values(r)[0],
  )[0];

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

console.log("\nschema evidence\n");

await check("the 23 monday statuses are all present", async () => {
  const n = await one<string>(
    "select count(*)::int from unnest(enum_range(null::job_status))",
  );
  assert(Number(n) === 23, `expected 23, got ${n}`);
  return `${n} labels`;
});

await check("every status maps to a stage, none unmapped", async () => {
  const unmapped = await one<string>(
    `select count(*)::int from unnest(enum_range(null::job_status)) s
     where job_stage_for(s) is null`,
  );
  assert(Number(unmapped) === 0, `${unmapped} statuses have no stage`);
  const groups = await db.query<{ stage: string; n: string }>(
    `select job_stage_for(s)::text as stage, count(*)::int as n
     from unnest(enum_range(null::job_status)) s group by 1
     order by min(s::text)`,
  );
  return groups.map((g) => `${g.stage} ${g.n}`).join(" · ");
});

await check("the 21 demo stores are seeded", async () => {
  const n = await one<string>(
    `select count(*)::int from sites s join organisations o on o.id = s.organisation_id
     where o.slug = 'demo-retail-group'`,
  );
  assert(Number(n) === 21, `expected 21 stores, got ${n}`);
  const dash = await one<string>(
    "select count(*)::int from sites where name like '%–%'",
  );
  return `${n} stores, ${dash} using the EN DASH separator`;
});

await check("the owner is declared but not created", async () => {
  const role = await one<string>(
    "select role::text from role_bootstrap where email = 'anwarrshboul@gmail.com'",
  );
  assert(role === "owner", `expected owner, got ${role}`);
  const users = await one<string>("select count(*)::int from users");
  assert(Number(users) === 0, `expected no seeded users, found ${users}`);
  return "role_bootstrap → owner, zero seeded credentials";
});

/* --------------------------------------------------------- job behaviour -- */

const orgId = await one<string>(
  "select id::text from organisations where slug = 'demo-retail-group'",
);

await check("stage is generated from status and cannot be written", async () => {
  const [job] = await db.query<{ id: string; stage: string; ref: string }>(
    `insert into jobs (organisation_id, title, description, status)
     values ($1, 'Broken lock', 'Front door lock seized', 'Quote requested')
     returning id::text, stage::text as stage, reference as ref`,
    [orgId],
  );
  assert(job.stage === "Quotes", `expected Quotes, got ${job.stage}`);
  assert(/^MS-\d{5}$/.test(job.ref), `bad reference ${job.ref}`);

  let refused = false;
  try {
    await db.query("update jobs set stage = 'Done' where id = $1", [job.id]);
  } catch {
    refused = true;
  }
  assert(refused, "a direct write to stage was allowed");
  return `${job.ref} → Quotes, direct write refused`;
});

await check("stage timestamps record FIRST entry only", async () => {
  const [job] = await db.query<{ id: string }>(
    `insert into jobs (organisation_id, title, description, status)
     values ($1, 'Leaking tap', 'Staff WC', 'Job In Progress') returning id::text`,
    [orgId],
  );
  const first = await one<string>(
    "select stage_in_progress_at::text from jobs where id = $1",
    [job.id],
  );
  // Out to On Hold and back again — the original entry time must survive.
  await db.query("update jobs set status = 'Escalated' where id = $1", [job.id]);
  await db.query("update jobs set status = 'Job In Progress' where id = $1", [
    job.id,
  ]);
  const after = await one<string>(
    "select stage_in_progress_at::text from jobs where id = $1",
    [job.id],
  );
  assert(first === after, `timestamp was rewritten: ${first} → ${after}`);
  const onHold = await one<string>(
    "select stage_on_hold_at is not null from jobs where id = $1",
    [job.id],
  );
  assert(String(onHold) === "true", "On Hold entry was not stamped");
  return "survived a round trip through On Hold";
});

await check("share tokens are 256-bit, unique and unguessable", async () => {
  await db.query(
    `insert into jobs (organisation_id, title, description)
     select $1, 'Bulk ' || g, 'seed' from generate_series(1, 300) g`,
    [orgId],
  );
  const stats = await db.query<{ n: string; distinct: string; len: string }>(
    `select count(*)::int as n, count(distinct share_token)::int as distinct,
            min(length(share_token))::int as len from jobs`,
  );
  const { n, distinct, len } = stats[0];
  assert(n === distinct, `${n} jobs but only ${distinct} distinct tokens`);
  assert(Number(len) === 64, `expected 64 hex chars, got ${len}`);
  const hex = await one<string>(
    "select bool_and(share_token ~ '^[0-9a-f]{64}$') from jobs",
  );
  assert(String(hex) === "true", "a token was not 64 lowercase hex characters");
  return `${n} jobs, ${distinct} distinct, all 64 hex chars (256 bits)`;
});

/* -------------------------------------------------------------- guardrails -- */

await check("an attachment cannot belong to two owners", async () => {
  const jobId = await one<string>("select id::text from jobs limit 1");
  const siteId = await one<string>("select id::text from sites limit 1");
  let refused = false;
  try {
    await db.query(
      `insert into attachments (object_key, original_name, content_type, byte_size, job_id, site_id)
       values ('k/1', 'a.jpg', 'image/jpeg', 10, $1, $2)`,
      [jobId, siteId],
    );
  } catch {
    refused = true;
  }
  assert(refused, "an attachment with two owners was accepted");
  return "CHECK refused job_id + site_id together";
});

await check("an active client profile must have an organisation", async () => {
  const userId = await one<string>(
    "insert into users (email) values ('scope@test.local') returning id::text",
  );
  let refused = false;
  try {
    await db.query(
      `insert into profiles (id, email, role, status) values ($1, 'scope@test.local', 'client_admin', 'active')`,
      [userId],
    );
  } catch {
    refused = true;
  }
  assert(refused, "an active client_admin with no organisation was accepted");
  // The same row is fine while it is still pending — that is what approving sets.
  await db.query(
    `insert into profiles (id, email, role, status) values ($1, 'scope@test.local', 'client_admin', 'pending_approval')`,
    [userId],
  );
  return "refused when active, allowed while pending_approval";
});

await check("an unsigned comment is refused", async () => {
  const jobId = await one<string>("select id::text from jobs limit 1");
  let refused = false;
  try {
    await db.query(
      "insert into job_comments (job_id, body) values ($1, 'anonymous')",
      [jobId],
    );
  } catch {
    refused = true;
  }
  assert(refused, "a comment with no author was accepted");
  await db.query(
    "insert into job_comments (job_id, body, author_name, via_share_link) values ($1, 'Done today', 'Dave (contractor)', true)",
    [jobId],
  );
  return "refused unsigned, accepted a named share-link comment";
});

await check("emails are unique regardless of case", async () => {
  let refused = false;
  try {
    await db.query("insert into users (email) values ('Scope@Test.Local')");
  } catch {
    refused = true;
  }
  assert(refused, "a case-variant duplicate email was accepted");
  return "Scope@Test.Local rejected against scope@test.local";
});

await check("migrations are idempotent", async () => {
  const { migrate } = await import("./migrate.ts");
  const again = await migrate(db, { silent: true });
  assert(again.applied.length === 0, `re-ran ${again.applied.length}`);
  const sites = await one<string>("select count(*)::int from sites");
  assert(Number(sites) === 21, `re-seed duplicated stores: ${sites}`);
  return `${again.skipped} already current, still ${sites} stores`;
});

console.log(
  failures ? `\n${failures} FAILED\n` : "\nall checks passed\n",
);
await db.close();
process.exit(failures ? 1 : 0);
