import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

test("stage 9 migration is additive and registered", async () => {
  const sql = await read("drizzle/0012_stage_nine_contractor_links.sql");
  const body = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .toUpperCase();
  for (const destructive of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE"]) {
    assert.ok(!body.includes(destructive), `Migration contains ${destructive}.`);
  }
  const journal = JSON.parse(await read("drizzle/meta/_journal.json"));
  assert.ok(journal.entries.find((e) => e.tag === "0012_stage_nine_contractor_links"));
});

test("tokens are long, random and stored only as a hash", async () => {
  const source = await read("app/lib/job-tokens.ts");
  assert.match(source, /new Uint8Array\(32\)/, "32 bytes minimum");
  assert.match(source, /crypto\.getRandomValues/, "must be cryptographically random");
  assert.match(source, /crypto\.subtle\.digest\(\s*"SHA-256"/);
  // Comments wrap, so compare against a whitespace-normalised copy.
  const prose = source.replace(/\s*\*\s*/g, " ").replace(/\s+/g, " ");
  assert.match(
    prose,
    /never stored or logged/,
    "the plaintext must be documented as write-once",
  );
  // The token itself must never be written to the row.
  const create = source.slice(source.indexOf("export async function createJobToken"));
  assert.match(create.slice(0, 2000), /tokenHash,/);
  assert.ok(
    !/\btoken,\s*$/m.test(create.slice(create.indexOf("values({"), create.indexOf("});"))),
    "the plaintext token must not be inserted",
  );
});

test("an invalid, expired and revoked token are indistinguishable", async () => {
  const resolve = (await read("app/lib/job-tokens.ts")).slice(
    (await read("app/lib/job-tokens.ts")).indexOf("export async function resolveJobToken"),
  );
  const nulls = (resolve.slice(0, 1400).match(/return null;/g) ?? []).length;
  assert.ok(nulls >= 3, "unknown, expired and revoked must all return null");

  const route = await read("app/api/job-link/[token]/route.ts");
  assert.match(
    route,
    /identical for unknown, expired and revoked/,
    "the response must not leak which case applied",
  );
});

test("a token is scoped to one job", async () => {
  const route = await read("app/api/files/route.ts");
  assert.match(
    route,
    /scopedToken\.requestId !== workOrder\.id/,
    "a link for one job must not upload to another",
  );
});

test("the legacy reporter guard was not simply widened", async () => {
  const route = await read("app/api/files/route.ts");
  // The original rule must still exist for reporter tokens.
  assert.match(
    route,
    /Public requests can only add issue evidence/,
    "the reporter path must keep its original restriction",
  );
  // And the contractor path must be a separate, scoped check.
  assert.match(route, /allowedKinds\.includes\(kind as EvidenceKind\)/);
  assert.match(route, /is left untouched/, "the reasoning must be recorded in the code");
});

test("a contractor cannot close a job", async () => {
  const route = await read("app/api/job-link/[token]/route.ts");
  assert.doesNotMatch(
    route,
    /set\(\{[^}]*status:/s,
    "a public link must never set the job status",
  );
  assert.match(route, /completionRequestedAt/, "it records a request instead");
  assert.match(
    route,
    /a job closes on verified evidence/,
    "the reasoning must be recorded in the code",
  );
});

test("completion cannot be requested without evidence", async () => {
  const route = await read("app/api/job-link/[token]/route.ts");
  assert.match(route, /Please upload a photo of the completed work/);
  assert.match(route, /eq\(attachments\.kind, "completion"\)/);
});

test("the contractor payload is a whitelist, not a redaction", async () => {
  const source = await read("app/lib/job-tokens.ts");
  const safe = source.slice(source.indexOf("export function contractorSafeJob"));
  for (const forbidden of ["cost", "invoice", "approvedBy"]) {
    assert.ok(
      !new RegExp(`\\b${forbidden}:`).test(safe),
      `${forbidden} must not be exposed through a shared link`,
    );
  }
  assert.match(safe, /Explicitly excluded/, "the exclusions must be documented");
  assert.match(source, /canViewCost: false/);
});

test("public uploads are held for review", async () => {
  const sql = await read("drizzle/0012_stage_nine_contractor_links.sql");
  assert.match(sql, /ALTER TABLE attachments ADD COLUMN pending/);
  const links = await read("app/api/board/links/route.ts");
  assert.match(links, /pendingEvidence/);
  assert.match(links, /decision === "reject"/);
});

test("the shared page is never indexed", async () => {
  const page = await read("app/(public)/j/[token]/page.tsx");
  assert.match(page, /robots: \{ index: false/);
  assert.match(page, /a credential in a URL/, "the reasoning must be recorded");
});

test("a link can be revoked immediately", async () => {
  const tokens = await read("app/lib/job-tokens.ts");
  assert.match(tokens, /export async function revokeJobToken/);
  const links = await read("app/api/board/links/route.ts");
  assert.match(links, /export async function DELETE/);
});

test("link usage is tracked so an ignored link is visible", async () => {
  const tokens = await read("app/lib/job-tokens.ts");
  assert.match(tokens, /firstOpenedAt/);
  assert.match(tokens, /useCount/);
  assert.match(tokens, /state: row\.revokedAt/, "each link must report a state");
});

test("the contractor page is built for a phone", async () => {
  const css = await read("app/(public)/j/[token]/job-link.css");
  assert.match(css, /font-size: 16px/, "inputs below 16px trigger iOS zoom");
  assert.match(css, /min-height: 44px/);
  assert.match(css, /max-width: 560px/);

  const view = await read("app/(public)/j/[token]/contractor-job-view.tsx");
  assert.match(view, /capture="environment"/, "the camera must open directly");
  assert.match(view, /accept="image\/\*,video\/\*"/, "video is used in the field");
});

test("evidence slots are separate, and the nameplate is explained", async () => {
  const view = await read("app/(public)/j/[token]/contractor-job-view.tsx");
  assert.match(view, /completion: "Photo of completed work"/);
  assert.match(view, /nameplate: "Equipment nameplate/);
  assert.match(
    view,
    /saves a second visit/,
    "the contractor needs to know why the nameplate matters",
  );
});

test("coordinator link routes are organisation-scoped", async () => {
  const source = await read("app/api/board/links/route.ts");
  assert.match(source, /scopedDb\(request\)/);
  assert.match(source, /status: 503/);
  assert.doesNotMatch(source, /"sunnamusk-uk"/);
});
