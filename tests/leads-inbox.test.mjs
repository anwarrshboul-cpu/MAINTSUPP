/**
 * The website enquiries inbox — Master Specification §12.
 *
 * What these assertions are for. §12's intake half was finished and good; its
 * reading half did not exist at all — `GET /api/leads` was a hard 501 and `status`
 * had never been written by anything. So this file pins:
 *
 *   1. that the 501 is gone and what replaced it answers only to platform staff,
 *      for the measured reason rather than a stylistic one;
 *   2. that the public POST — the half that already worked — is untouched;
 *   3. that the status vocabulary is closed and agrees with the column's default;
 *   4. that this phase adds NO migration, so the schema fingerprint cannot move;
 *   5. that the console reads the vocabulary from the server rather than copying it.
 *
 * Comments are stripped before any ABSENCE assertion. Several times in this program
 * a test has passed or failed on its own explanatory prose rather than on code.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LEAD_STATUS,
  isLeadStatus,
  LEAD_OMISSIONS,
  LEAD_STATUS_KEYS,
  LEAD_STATUSES,
  leadStatus,
} from "../app/lib/lead-status.ts";
import { PLATFORM_SECTIONS, platformSection } from "../app/lib/platform-sections.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const decommented = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/* ------------------------------------------------------------------ */
/* The 501 is gone, and what replaced it                               */
/* ------------------------------------------------------------------ */

test("GET /api/leads is no longer a 501", async () => {
  const route = decommented(await read("app/api/leads/route.ts"));

  /*
   * The endpoint answered *"Lead export is disabled while public testing is
   * active."* with a 501 to every caller, so a lead arrived, an email went out, and
   * the row was then unreachable by any surface in the product. Comments stripped,
   * because the replacement quotes the old message to explain what it replaced.
   */
  assert.doesNotMatch(route, /Lead export is disabled/);
  assert.doesNotMatch(route, /status: 501/);
  assert.match(route, /export async function GET\(request: Request\)/);
});

test("both new methods answer to platform staff, and neither to a capability", async () => {
  const route = await read("app/api/leads/route.ts");

  for (const method of ["GET", "PATCH"]) {
    const slice = route.slice(route.indexOf(`export async function ${method}(`));
    assert.match(
      slice.slice(0, 700),
      /scope\.platformAdmin !== true \|\| !scope\.authenticated/,
      `${method} must be gated on platform staff before it reads anything`,
    );
    assert.match(slice.slice(0, 900), /status: 403/, `${method} must refuse with 403`);
  }

  /*
   * NOT a capability, and this is the strongest version of that argument in the
   * codebase. A public enquiry has no account, so the intake route files it under
   * the PRIMARY active organisation — measured on Staging, a client company's
   * workspace. The rows are MAINTSUPP's own sales pipeline wearing a customer's
   * `organisation_id`, so a workspace capability would have shown that customer
   * every enquiry MAINTSUPP has received from its own website, and `scopedDb` would
   * have delivered it correctly.
   */
  assert.doesNotMatch(
    decommented(route),
    /scopedDbWithCapability/,
    "a per-workspace capability would leak MAINTSUPP's own pipeline to a client",
  );
});

test("the route records the mis-filing it was designed around", async () => {
  const route = await read("app/api/leads/route.ts");
  /* Kept as a source pin rather than only a comment, because the reason the gate is
     what it is must survive somebody later deciding a capability would be tidier. */
  assert.match(route, /PRIMARY active organisation/);
  assert.match(route, /NOT fixed here/);
});

test("the read crosses workspaces the way /api/audit does", async () => {
  const route = await read("app/api/leads/route.ts");
  const audit = await read("app/api/audit/route.ts");

  /*
   * `scope.organisationIds` is already widened for a platform admin
   * (`crossOrganisation: platformAdmin`), so `inArray` over it is the existing
   * instrument rather than a new one. Reading only the current workspace would
   * strand every stored lead the day the primary organisation changes.
   */
  assert.match(route, /inArray\(leads\.organisationId, scope\.organisationIds\)/);
  assert.match(audit, /inArray\(auditEvents\.organisationId, organisationIds\)/);

  /* And the write is confined the same way, so an id alone cannot reach a row. */
  const patch = route.slice(route.indexOf("export async function PATCH"));
  assert.match(patch, /eq\(leads\.id, id\), inArray\(leads\.organisationId, scope\.organisationIds\)/);
});

test("the public intake half is untouched", async () => {
  const route = await read("app/api/leads/route.ts");
  const post = route.slice(route.indexOf("export async function POST"));

  /* The half of §12 that already worked, and worked well. Anything this phase broke
     here would be a regression in the only part that was finished. */
  assert.match(post, /scopedDb\(request, \{ allowAnonymous: true \}\)/);
  assert.match(post, /status: "New"/);
  assert.match(post, /leadAlertTemplate/);
  assert.match(post, /leadConfirmationTemplate/);
  assert.match(post, /status: 201/);
  /* The server-side honeypot: a filled `website` field gets a fake 201 with a random
     id, writes nothing and sends nothing. */
  assert.match(route, /honeypot|website/i);
});

/* ------------------------------------------------------------------ */
/* The status vocabulary                                               */
/* ------------------------------------------------------------------ */

test("the vocabulary begins with the value every stored row already has", async () => {
  /*
   * `leads.status` is `NOT NULL DEFAULT 'New'` and nothing had ever written it, so
   * every row in the database carries `"New"`. A vocabulary that did not begin with
   * it would have rendered the entire existing inbox as an unrecognised state.
   */
  const schema = await read("db/schema.ts");
  assert.match(schema, /status: text\("status"\)\.notNull\(\)\.default\("New"\)/);
  assert.equal(DEFAULT_LEAD_STATUS, "New");
  assert.equal(LEAD_STATUSES[0].key, "New");
  assert.equal(LEAD_STATUSES[0].closed, false);
});

test("a request cannot invent a status", () => {
  /* The column is TEXT, so the database would accept anything — and a free-text
     status makes both the filter and the totals on the screen untrue. */
  for (const key of LEAD_STATUS_KEYS) assert.ok(isLeadStatus(key));
  for (const invented of ["new", "NEW", "Closed", "", "Won ", 1, null, undefined, {}]) {
    assert.equal(isLeadStatus(invented), false, `${String(invented)} must not pass`);
  }
});

test("spam is its own state, not a kind of lost", () => {
  /*
   * Folding the two together would quietly corrupt the only ratio this screen could
   * ever be asked for: a lost enquiry was real and counts against the ones that were
   * won, and a spam submission was never a lead at all.
   */
  const spam = LEAD_STATUSES.find((status) => status.key === "Spam");
  const lost = LEAD_STATUSES.find((status) => status.key === "Lost");
  assert.ok(spam && lost);
  assert.notEqual(spam.description, lost.description);
  assert.ok(spam.closed && lost.closed);
});

test("an unrecognised stored status reads as open, not as closed", () => {
  /*
   * A row written by hand, or before a status was retired, must not break the
   * screen — and burying it in the closed total would hide work nobody has done.
   */
  const unknown = leadStatus("Something else entirely");
  assert.equal(unknown.closed, false);
  assert.equal(unknown.key, "Something else entirely");
  assert.equal(leadStatus(null).key, "New");
  assert.equal(leadStatus("Won").closed, true);
});

test("exactly one status is the entry point and at least two close an enquiry", () => {
  assert.equal(LEAD_STATUSES.filter((status) => !status.closed).length >= 2, true);
  assert.equal(LEAD_STATUSES.filter((status) => status.closed).length >= 2, true);
  assert.equal(new Set(LEAD_STATUS_KEYS).size, LEAD_STATUSES.length, "a duplicate key would double-count");
  for (const status of LEAD_STATUSES) {
    assert.ok(status.description.length > 10, `${status.key} needs a line a person can read`);
  }
});

/* ------------------------------------------------------------------ */
/* No migration                                                        */
/* ------------------------------------------------------------------ */

test("this phase adds no migration, so the fingerprint cannot move", async () => {
  /*
   * THE POINT: `leads.status` already existed with the right type and the right
   * default. What was missing was a vocabulary, a write path and a screen — none of
   * which is a schema change.
   *
   * Asserted rather than assumed for two reasons. A column added here would move
   * `SCHEMA_FINGERPRINT`, which costs a full migration replay on the next cold
   * start; and the website-CMS branch is waiting on a merge and already moves it, so
   * a second mover would have turned a one-line textual conflict into a
   * recomputation nobody expected.
   */
  const init = await read("db/init.ts");
  assert.doesNotMatch(
    decommented(init),
    /site_pages|lead_notes|lead_status|leads_status/,
    "nothing about leads or their status belongs in a migration in this phase",
  );
  const leadColumns = init.slice(init.indexOf("CREATE TABLE IF NOT EXISTS leads"));
  assert.match(leadColumns.slice(0, 600), /status TEXT NOT NULL DEFAULT 'New'/);
});

/* ------------------------------------------------------------------ */
/* Authority and the trail                                             */
/* ------------------------------------------------------------------ */

test("a status change is audited against the workspace the lead is filed under", async () => {
  const route = await read("app/api/leads/route.ts");

  for (const action of ["lead.status_changed", "lead.status_reaffirmed"]) {
    assert.ok(route.includes(`"${action}"`), `${action} must reach the audit trail`);
  }
  assert.match(route, /entityType: "lead"/);
  /* Against the lead's own organisation, not the actor's — that is where the row
     lives and where a later reader would look for it. */
  assert.match(route, /organisationId: existing\.organisationId/);
  /* The optional reason has nowhere else to go: a lead has no notes column and this
     phase adds none, so it is recorded with the change rather than overwriting a
     field on the row. */
  assert.match(route, /reason: reason \|\| null/);
});

test("the route still satisfies both tenancy surveys", async () => {
  /*
   * `tests/tenant-scope.test.mjs` and `tests/stage-nineteen-client-isolation.test.mjs`
   * both list this file and both require the organisation to come from `scopedDb`
   * and never from the request. The new methods use `scopedDb(request)` and then
   * additionally refuse a caller who is not platform staff, which satisfies that
   * subject strictly more than the bare call does.
   */
  const route = await read("app/api/leads/route.ts");
  assert.match(route, /scopedDb\(\s*request/);
  assert.doesNotMatch(route, /\bCLIENT_ID\b/);
  assert.doesNotMatch(route, /maintsupp_demo_organisation/);
  assert.doesNotMatch(route, /workspaceRoleFromRequest/);

  for (const survey of [
    "tests/tenant-scope.test.mjs",
    "tests/stage-nineteen-client-isolation.test.mjs",
  ]) {
    assert.match(
      await read(survey),
      /"app\/api\/leads\/route\.ts"/,
      `${survey} must still cover the leads route`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* The console                                                         */
/* ------------------------------------------------------------------ */

test("the console lists the inbox because the inbox now has a server side", async () => {
  const section = platformSection("leads");
  assert.ok(section, "leads must be in the catalogue");
  assert.equal(section.label, "Website enquiries");
  assert.equal(PLATFORM_SECTIONS.length, 6);

  /* `capability: null`, for the reason the catalogue records: there is no
     per-workspace capability that could be right about a row that belongs to the
     platform. */
  assert.equal(section.capability, null);

  /* The rule this entry keeps rather than bends. */
  const sections = await read("app/lib/platform-sections.ts");
  assert.match(sections, /a rail entry leading to an empty\n \* screen is the/);
  for (const absent of ["branding", "theme", "integrations", "billing", "settings"]) {
    assert.equal(platformSection(absent), null, `${absent} still has no platform API`);
  }
});

test("the screen renders the vocabulary the server sent, not a copy of it", async () => {
  const view = await read("app/(app)/admin/leads-view.tsx");
  const route = await read("app/api/leads/route.ts");

  assert.match(route, /statuses: LEAD_STATUSES/);
  assert.match(view, /data\?\.statuses \?\? \[\]/);

  /*
   * The lesson Phase 6 paid for: a picker whose options are typed into the panel is
   * a list that stops agreeing with what the server will accept, and the
   * disagreement shows up as a save that fails for no visible reason. So the view
   * must not name a status at all.
   */
  const body = decommented(view);
  for (const key of LEAD_STATUS_KEYS) {
    assert.doesNotMatch(
      body,
      new RegExp(`"${key}"`),
      `the view must not name the ${key} status — it renders whatever the server sends`,
    );
  }
});

test("the screen shows which workspace each enquiry is filed under", async () => {
  const view = await read("app/(app)/admin/leads-view.tsx");
  const route = await read("app/api/leads/route.ts");

  /*
   * The finding, surfaced to the person reading the screen rather than left in a
   * comment. It is read off the data, so the notice cannot claim something that has
   * stopped being true — and it is the prompt to fix the filing.
   */
  assert.match(route, /workspaceName: workspaceNames\.get\(row\.organisationId\)/);
  assert.match(view, /filedUnder/);
  assert.match(view, /filed under a client workspace/i);
});

test("the screen shows whether the alert email actually went out", async () => {
  const view = await read("app/(app)/admin/leads-view.tsx");
  /*
   * `notified_at` and `notify_attempts` have been written by the intake route since
   * they were added and displayed nowhere, so a notification that silently failed
   * was invisible — which for a sales enquiry is the failure that costs something.
   */
  assert.match(view, /notifiedAt/);
  assert.match(view, /notifyAttempts/);
  assert.match(view, /alert NOT sent/);
});

test("the inbox states its own gaps, and the screen prints them", async () => {
  const view = await read("app/(app)/admin/leads-view.tsx");
  const route = await read("app/api/leads/route.ts");

  assert.match(route, /omissions: LEAD_OMISSIONS/);
  assert.match(view, /data\.omissions\.map/);
  assert.ok(LEAD_OMISSIONS.length >= 5, "every known gap is named");
  /* Printed, never restated — a second copy is how one of them becomes stale and
     starts claiming something untrue. */
  for (const omission of LEAD_OMISSIONS) {
    assert.doesNotMatch(view, new RegExp(omission.slice(0, 28).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  /* The two that are decisions rather than backlog, named explicitly so a later
     change to either is deliberate. */
  assert.ok(LEAD_OMISSIONS.some((entry) => /export/i.test(entry)));
  assert.ok(LEAD_OMISSIONS.some((entry) => /delet/i.test(entry)));
});

test("there is no export path, and no delete path", async () => {
  const route = decommented(await read("app/api/leads/route.ts"));
  const view = decommented(await read("app/(app)/admin/leads-view.tsx"));

  /*
   * These rows carry other companies' contact details. Where they are allowed to go
   * is a separate decision from whether they can be read, and a delete would let
   * something that arrived vanish — spam is a status instead, so the count of real
   * enquiries stays honest.
   */
  assert.doesNotMatch(route, /export async function DELETE/);
  assert.doesNotMatch(route, /text\/csv|Content-Disposition/);
  assert.doesNotMatch(view, /csv|download/i);
});

test("the screen reuses the admin kit rather than restating it", async () => {
  const view = await read("app/(app)/admin/leads-view.tsx");
  const css = decommented(await read("app/(app)/admin/leads.css"));

  for (const shared of ["admin-console", "admin-toolbar", "admin-field", "admin-notice", "admin-table"]) {
    assert.ok(view.includes(shared), `the view must use the kit's ${shared}`);
    assert.doesNotMatch(
      css,
      new RegExp(`^\\.${shared}\\s*\\{`, "m"),
      `views/admin-console.css owns .${shared}; a second definition is drift`,
    );
  }
  assert.match(view, /useAdminResource|adminWrite/);
});

test("the stylesheet spends no literal and opens no breakpoint", async () => {
  const globals = await read("app/globals.css");
  const css = await read("app/(app)/admin/leads.css");
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");

  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(body), "no hex literal — use the tokens");
  assert.ok(!/\b(?:rgba?|hsla?)\(/.test(body), "no colour function either");
  for (const token of new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))) {
    assert.ok(globals.includes(`${token}:`), `${token} is not defined in globals.css`);
  }
  assert.equal(
    [...body.matchAll(/@media[^{]*?(\d+)px/g)].length,
    0,
    "both grids collapse through auto-fit, so no width is spent",
  );
});

test("the submitter's own words are rendered as text and never as markup", async () => {
  const view = await read("app/(app)/admin/leads-view.tsx");
  const css = await read("app/(app)/admin/leads.css");

  /* The form allows 900 characters of free prose from a stranger, and this screen is
     the only place it has ever been readable. */
  assert.doesNotMatch(decommented(view), /dangerouslySetInnerHTML/);
  assert.match(view, /\{entry\.challenge\}/);
  /* `pre-wrap`, because a paragraph they separated is one they meant to separate. */
  assert.match(css, /white-space: pre-wrap/);
});
