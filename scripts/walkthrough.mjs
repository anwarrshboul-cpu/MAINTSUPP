/**
 * The whole product, exercised end to end against a running API.
 *
 * Not a test — a demonstration. It walks the path the real team walks: a manager
 * reports a fault from the website, a coordinator triages it into a job, a
 * contractor is sent a link and completes the work from a phone with no
 * account, the money is quoted and approved, and the job closes. Along the way
 * it tries the things that must NOT work.
 *
 * Every step prints what it did and what the server actually returned. Nothing
 * is asserted quietly; if a step fails, the run stops and says so.
 *
 * Usage:
 *   node scripts/walkthrough.mjs [http://localhost:8787]
 */
import { readFileSync } from "node:fs";

const API = (process.argv[2] ?? "http://localhost:8787").replace(/\/+$/, "");

/* The owner credential this run creates. Development only. */
const OWNER = { email: "anwarrshboul@gmail.com", password: "Maintsupp-Dev-Owner-2026!" };

/*
 * A per-run suffix for every OTHER address.
 *
 * The owner is pinned: `role_bootstrap` names one address, so re-running must
 * reuse that account rather than make a second. Everyone else gets a fresh
 * address, which is what makes this script runnable twice against the same
 * database instead of collapsing into "that email already has an account".
 */
const RUN = Math.random().toString(36).slice(2, 8);
const COORDINATOR = `coordinator-${RUN}@maintsupp.test`;
const STORE = `store-${RUN}@client.test`;

let step = 0;
let failures = 0;

const say = (text) => console.log(text);
const head = (title) => console.log(`\n\x1b[1m── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}\x1b[0m`);

function ok(label, detail = "") {
  step += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${String(step).padStart(2)}. ${label}${detail ? ` — ${detail}` : ""}`);
}
function bad(label, detail = "") {
  step += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${String(step).padStart(2)}. ${label}${detail ? ` — ${detail}` : ""}`);
}
function expect(condition, label, detail = "") {
  condition ? ok(label, detail) : bad(label, detail);
  return condition;
}

/* ---------------------------------------------------------------- client -- */

/** One cookie jar per actor, so several roles can be signed in at once. */
function jar() {
  const cookies = new Map();
  return {
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    absorb(response) {
      // Node exposes multiple Set-Cookie headers through getSetCookie().
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const at = pair.indexOf("=");
        if (at > 0) cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
      }
    },
  };
}

async function call(method, path, { body, actor, form } = {}) {
  const headers = {};
  if (actor?.header()) headers.cookie = actor.header();
  if (body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  actor?.absorb(response);

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: response.status, data };
}

/* ------------------------------------------------------------------ run -- */

const ready = await call("GET", "/ready");
if (ready.status !== 200) {
  console.error(`\nThe API is not answering on ${API}. Start it first:\n  npm run api:dev\n`);
  process.exit(1);
}
say(`\n\x1b[1mMAINTSUPP — full workflow\x1b[0m   api ${API}   backend ${ready.data.backend}`);

/* ============================================================ 1. accounts == */
head("1. Accounts — the owner founds the system");

const owner = jar();

/*
 * The owner may already exist from a previous run of this script — the
 * bootstrap row names a single address, so there is no second owner to make.
 * Signing in first keeps the run repeatable; registering is only attempted
 * when there is genuinely no account yet.
 */
const resumed = await call("POST", "/auth/sign-in", {
  body: { email: OWNER.email, password: OWNER.password },
  actor: owner,
});

if (resumed.status === 200) {
  ok("Owner account already exists — signing in", "re-run against the same database");
  ok("Email already confirmed", "skipped");
  ok("Verification link already spent", "skipped");
} else {
  const reg = await call("POST", "/auth/register", {
    body: { email: OWNER.email, password: OWNER.password, fullName: "Anwar Rshboul" },
  });
  expect(reg.status === 200, "Owner registers through the ordinary sign-up form");

  const verifyToken = linkFor(OWNER.email, "verify");
  if (verifyToken) {
    const verified = await call("POST", "/auth/verify", { body: { token: verifyToken } });
    expect(verified.status === 200, "Confirms the email address from the emailed link");
    const replay = await call("POST", "/auth/verify", { body: { token: verifyToken } });
    expect(replay.status === 400, "The same link cannot be used twice", "replay refused");
  } else {
    bad("Could not read the verification link", "set API_LOG=<api log path>");
  }
}

const signIn = await call("POST", "/auth/sign-in", {
  body: { email: OWNER.email, password: OWNER.password },
  actor: owner,
});
expect(signIn.status === 200 && signIn.data.profile?.role === "owner",
  "Signs in and lands as owner", `role=${signIn.data.profile?.role} status=${signIn.data.status}`);

const me = await call("GET", "/auth/me", { actor: owner });
expect(me.data.actor?.status === "active", "Session resolves to an active owner");

/* ========================================================== 2. the team ==== */
head("2. The team — invitations and approval");

const scopes = await call("GET", "/members/scopes", { actor: owner });
const org = scopes.data.organisations?.[0];
const sites = (scopes.data.sites ?? []).filter((s) => s.organisation_id === org?.id);
const contractor = scopes.data.contractors?.[0];
expect(!!org, "Reads the organisations, sites and contractors", `${org?.name}, ${sites.length} sites`);

const invite = await call("POST", "/members/invite", {
  body: { email: COORDINATOR, role: "admin" },
  actor: owner,
});
expect(invite.status === 200, "Invites a coordinator as admin");

const overreach = await call("POST", "/members/invite", {
  body: { email: "nope@maintsupp.test", role: "owner" },
  actor: owner,
});
expect(overreach.status === 403, "Nobody can grant `owner` — not even the owner", "403");

/**
 * Reads a one-time link out of the API's log, the way a person reads an inbox.
 *
 * With no RESEND_API_KEY the API prints each message instead of sending it, so
 * this is the same token a real deployment would email. Scoped to the block for
 * one address, because several accounts are created in this run and taking the
 * last token in the file would hand one person another's link.
 */
function linkFor(email, kind) {
  const log = process.env.API_LOG;
  if (!log) return null;
  const text = readFileSync(log, "utf8");
  const blocks = text.split("[mail:not-configured] would send to ").slice(1);
  const mine = blocks.filter((block) => block.startsWith(email));
  const pattern = new RegExp(`portal/${kind}\\?token=([A-Za-z0-9_-]+)`);
  for (const block of mine.reverse()) {
    const found = block.match(pattern);
    if (found) return found[1];
  }
  return null;
}

/** Registers, confirms the emailed link, and signs in — a whole real account. */
async function makeAccount(email, password, fullName) {
  const who = jar();
  const created = await call("POST", "/auth/register", { body: { email, password, fullName } });
  if (created.status !== 200) {
    /*
     * Almost always the sign-up rate limit (5/hour/IP), which this script trips
     * by being run repeatedly from one machine. Said plainly, because the
     * downstream symptom is `role=undefined` three steps later and that reads
     * like a broken product rather than a limiter doing its job.
     */
    bad(`Could not create ${email}`, `${created.status} ${created.data.error ?? ""}`.trim());
    say("\n     The API rate-limits sign-ups per IP and keeps the counter in");
    say("     memory. Restart it to clear: pkill -f apps/api/src/server.ts\n");
    process.exit(1);
  }
  const token = linkFor(email, "verify");
  if (token) await call("POST", "/auth/verify", { body: { token } });
  await call("POST", "/auth/sign-in", { body: { email, password }, actor: who });
  return who;
}

// An invited address takes the invited role automatically on sign-up.
const unverified = jar();
await call("POST", "/auth/register", {
  body: { email: COORDINATOR, password: "Coordinator-Dev-2026!", fullName: "Coordinator" },
});
const tooEarly = await call("POST", "/auth/sign-in", {
  body: { email: COORDINATOR, password: "Coordinator-Dev-2026!" },
  actor: unverified,
});
expect(tooEarly.status === 403 && tooEarly.data.needsVerification,
  "An unverified invitee cannot sign in yet", "403 needsVerification");

// Now confirm the address, and the invitation's role applies automatically.
const coordToken = linkFor(COORDINATOR, "verify");
if (coordToken) await call("POST", "/auth/verify", { body: { token: coordToken } });
const coordinator = jar();
const coordIn = await call("POST", "/auth/sign-in", {
  body: { email: COORDINATOR, password: "Coordinator-Dev-2026!" },
  actor: coordinator,
});
expect(coordIn.status === 200 && coordIn.data.profile?.role === "admin",
  "Confirmed, the invitee is an admin without anyone approving them",
  `role=${coordIn.data.profile?.role}`);

// Self-registration lands pending, holding no role that grants anything.
const clientUser = await makeAccount(STORE, "Store-Dev-2026!", "Store Manager");
const members = await call("GET", "/members", { actor: owner });
const pendingRow = members.data.members?.find((m) => m.email === STORE);
expect(pendingRow?.status === "pending_approval",
  "A self-registered account waits for approval", `role=${pendingRow?.role}`);

const approve = await call("POST", `/members/${pendingRow.id}/approve`, {
  body: { role: "client_user", organisationId: org.id, siteIds: [sites[0].id] },
  actor: owner,
});
expect(approve.status === 200, "Owner approves it and assigns role, organisation and site",
  `client_user @ ${sites[0].name}`);

const halfApproval = await call("POST", `/members/${pendingRow.id}/approve`, {
  body: { role: "client_admin" },
  actor: owner,
});
expect(halfApproval.status === 400,
  "An active client role with no organisation is refused", "the database CHECK holds");

/* ======================================================== 3. the request === */
head("3. A manager reports a fault from the website");

const noPhoto = await call("POST", "/public/report-a-job", {
  body: {
    siteName: sites[0].name, contactName: "Dana Okafor", phone: "07700 900123",
    email: "dana@store.test", description: "The front shutter will not close.",
    faultCategory: "Locks", photos: [],
  },
});
expect(noPhoto.status === 400, "A request with no photograph is declined", "as the form promises");

// A real JPEG through the real upload endpoint, as the browser sends it.
const picture = readFileSync(new URL("../apps/web/public/assets/photos/evidence-closeout.jpg", import.meta.url));
const upload = new FormData();
upload.append("file", new Blob([picture], { type: "image/jpeg" }), "shutter.jpg");
const staged = await call("POST", "/public/intake/upload", { form: upload });
expect(staged.status === 200 && staged.data.photo, "Photograph uploads and returns a claim ticket",
  `${(picture.length / 1024).toFixed(0)}KB → ${String(staged.data.photo).slice(0, 8)}…`);

const request = await call("POST", "/public/report-a-job", {
  body: {
    siteName: sites[0].name, contactName: "Dana Okafor", phone: "07700 900123",
    email: "dana@store.test", address: "1 Whitechapel Road", postcode: "E1 1DU",
    description: "The front shutter will not close. The store cannot be secured overnight.",
    faultCategory: "Locks", urgency: "P1", photos: [staged.data.photo],
  },
});
expect(request.status === 200 && /^REQ-/.test(request.data.reference ?? ""),
  "The request is filed with a quotable reference", request.data.reference);

/* ========================================================== 4. triage ====== */
head("4. Triage — a coordinator turns it into a job");

const queue = await call("GET", "/jobs/intake/pending", { actor: owner });
const incoming = queue.data.requests?.find((r) => r.contact_name === "Dana Okafor");
expect(!!incoming, "It appears in the Incoming Requests queue",
  `${queue.data.requests?.length} waiting`);

const clientBlocked = await call("GET", "/jobs/intake/pending", { actor: clientUser });
expect(clientBlocked.status === 403, "A client cannot see the triage queue", "403");

const converted = await call("POST", `/jobs/intake/${incoming.id}/convert`, {
  body: { organisationId: org.id, siteId: sites[0].id, priority: "Urgent" },
  actor: owner,
});
const job = converted.data.job;
expect(converted.status === 200 && /^MS-\d{5}$/.test(job?.reference ?? ""),
  "Converted into a job with a human-readable number", job?.reference);

const detail = await call("GET", `/jobs/${job.id}`, { actor: owner });
expect((detail.data.attachments ?? []).length === 1,
  "The photograph moved with it onto the job record",
  detail.data.attachments?.[0]?.original_name);

/* ====================================================== 5. the stages ====== */
head("5. The job walks the board");

for (const [status, stage] of [
  ["Job Scheduled", "Scheduling"],
  ["Job In Progress", "In Progress"],
  ["Quote requested", "Quotes"],
]) {
  const moved = await call("POST", `/jobs/${job.id}/status`, { body: { status }, actor: owner });
  expect(moved.status === 200 && moved.data.job?.stage === stage,
    `${status}`, `stage → ${moved.data.job?.stage}`);
}

const nonsense = await call("POST", `/jobs/${job.id}/status`, {
  body: { status: "Invented Status" }, actor: owner,
});
expect(nonsense.status === 400, "A status outside the board's 23 labels is refused");

/* ========================================================== 6. money ======= */
head("6. Quotes and approval");

const quote = await call("POST", `/jobs/${job.id}/quotes`, {
  body: { amountPence: 48500, description: "Replace shutter motor and service the runners." },
  actor: owner,
});
expect(quote.status === 200, "A quote is raised", "£485.00");

const decided = await call("POST", `/jobs/quotes/${quote.data.quote.id}/decide`, {
  body: { decision: "approved" }, actor: owner,
});
expect(decided.status === 200 && decided.data.quote.status === "approved",
  "The client approves it", "recorded against who decided and when");

/* ==================================================== 7. the share link ==== */
head("7. The share link — a contractor, on a phone, with no account");

const full = await call("GET", `/jobs/${job.id}`, { actor: owner });
const token = full.data.job.share_token;
expect(/^[0-9a-f]{64}$/.test(token), "Copy Link produces a 256-bit token", `${token.slice(0, 12)}…`);

for (const wrong of ["0".repeat(64), token.slice(0, 63) + "f", "not-a-token"]) {
  const refused = await call("GET", `/public/job/${wrong}`);
  if (refused.status !== 404) { bad("A wrong token was accepted", wrong.slice(0, 16)); break; }
}
ok("Wrong, near-miss and malformed tokens all return the same 404");

const shared = await call("GET", `/public/job/${token}`);
expect(shared.status === 200, "The real link opens with no login", shared.data.job?.reference);
expect("cost_of_works_pence" in (shared.data.job ?? {}),
  "It shows the full ticket, money included", "per the owner's decision");

const done = new FormData();
done.append("file", new Blob([picture], { type: "image/jpeg" }), "completed.jpg");
done.append("uploaderName", "Dave (Acme Repairs)");
done.append("kind", "completed_picture");
const contractorUpload = await call("POST", `/public/job/${token}/upload`, { form: done });
expect(contractorUpload.status === 200, "The contractor uploads a picture of the completed works");

const comment = await call("POST", `/public/job/${token}/comment`, {
  body: { body: "Motor replaced and runners serviced. Tested three full cycles.", authorName: "Dave (Acme Repairs)" },
});
expect(comment.status === 200, "…and writes an update under their own name");

const unsigned = await call("POST", `/public/job/${token}/comment`, { body: { body: "anonymous" } });
expect(unsigned.status === 400, "An unsigned update is refused", "every note is attributable");

const complete = await call("POST", `/public/job/${token}/complete`, {
  body: { authorName: "Dave (Acme Repairs)" },
});
expect(complete.status === 200 && complete.data.status === "Job Completed",
  "…and presses Work completed", "status → Job Completed");

const publicView = await call("GET", `/public/job/${token}`);
expect(!(publicView.data.attachments ?? []).some((a) => a.original_name === "completed.jpg"),
  "Their upload is held for staff release, not published straight away");

/* ================================================ 8. back inside the portal = */
head("8. Everything lands on the one record");

const after = await call("GET", `/jobs/${job.id}`, { actor: owner });
const viaLink = (after.data.comments ?? []).filter((c) => c.via_share_link);
expect(after.data.job.status === "Job Completed", "The job shows as completed inside the portal");
expect(viaLink.length === 2, "Both share-link updates are on the job",
  viaLink.map((c) => c.author_name).join(", "));

const staffFiles = await call("GET", `/uploads/job/${job.id}`, { actor: owner });
const held = (staffFiles.data.attachments ?? []).find((a) => a.pending);
expect(!!held, "The held photograph is visible to staff", `by ${held?.uploaded_by_name}`);

const release = await call("POST", `/uploads/${held.id}/release`, { actor: owner });
expect(release.status === 200, "Staff release it onto the record");

const published = await call("GET", `/public/job/${token}`);
expect((published.data.attachments ?? []).some((a) => a.kind === "completed_picture"),
  "It now appears on the shared link too");

/* ===================================================== 9. what must fail === */
head("9. The things that must not work");

const otherOrg = await call("POST", "/members/invite", {
  body: { email: "rival@other.test", role: "client_admin", organisationId: org.id },
  actor: owner,
});

const clientJobs = await call("GET", "/jobs", { actor: clientUser });
expect(clientJobs.status === 200, "The store manager sees their own site's work",
  `${clientJobs.data.total} job(s)`);

const anon = await call("GET", "/jobs");
expect(anon.status === 401, "Signed out, the board is unreachable", "401");

const anonMembers = await call("GET", "/members");
expect(anonMembers.status === 401, "…so is the Members page", "401");

const clientMembers = await call("GET", "/members", { actor: clientUser });
expect(clientMembers.status === 403, "A client cannot open Members", "403");

const clientStatus = await call("POST", `/jobs/${job.id}/status`, {
  body: { status: "Pending Approval" }, actor: clientUser,
});
expect(clientStatus.status === 403, "A client cannot move a job's status", "403");

const ownerRow = (await call("GET", "/members", { actor: owner })).data.members
  ?.find((m) => m.email === OWNER.email);
const demote = await call("POST", `/members/${ownerRow.id}/role`, {
  body: { role: "client_user" }, actor: owner,
});
expect(demote.status === 403, "The owner account cannot be downgraded", "not even by itself");

const suspend = await call("POST", `/members/${ownerRow.id}/deactivate`, { actor: owner });
expect(suspend.status === 403, "…nor deactivated", "403");

/* ==================================================== 10. deactivation ===== */
head("10. Removing someone takes effect immediately");

const storeRow = (await call("GET", "/members", { actor: owner })).data.members
  ?.find((m) => m.email === STORE);
const before = await call("GET", "/jobs", { actor: clientUser });
expect(before.status === 200, "The store manager is working normally");

await call("POST", `/members/${storeRow.id}/deactivate`, { actor: owner });
const afterKick = await call("GET", "/jobs", { actor: clientUser });
expect(afterKick.status === 401, "Deactivated — their live session dies at once",
  "not when the cookie expires");

/* ========================================================== summary ======== */
head("Summary");
say(`  ${step - failures}/${step} steps passed`);
if (failures) {
  say(`  \x1b[31m${failures} failed\x1b[0m`);
} else {
  say(`  \x1b[32mThe whole workflow works end to end.\x1b[0m`);
}
say(`\n  Owner credential created by this run:`);
say(`    ${OWNER.email}`);
say(`    ${OWNER.password}`);
say(`  Job: ${job.reference}   share link: /job/${token}\n`);

process.exit(failures ? 1 : 0);
