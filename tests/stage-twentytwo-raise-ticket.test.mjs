import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * The file with its comments removed.
 *
 * "This must not call X" has to be asked of the code, not of the prose. The
 * control's header deliberately names the two endpoints it does *not* use and
 * says why, and a `doesNotMatch` over the raw file reads that explanation as a
 * call — the test would fail for documenting the decision it exists to protect.
 */
const code = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CONTROL = "app/(app)/portal/raise-ticket.tsx";
const STYLES = "app/(app)/portal/raise-ticket.css";
const ROUTE = "app/api/maintenance/route.ts";

/**
 * "Raise a ticket from a different section".
 *
 * The owner's request was to be able to start a job from wherever they happen
 * to be — a site, an asset, a contractor, a compliance record — instead of
 * going to the board and retyping what is already on screen. The control that
 * does it is shared, so the failure mode this file guards against is not "the
 * button is missing"; it is the control drifting away from the one server path
 * that creates jobs, and quietly becoming a second way to make a work order
 * that disagrees with the first.
 */

/* ------------------------------------------------------------------ */
/* One creation path                                                   */
/* ------------------------------------------------------------------ */

test("the control raises jobs through the portal's own creation path, and no other", async () => {
  const source = code(await read(CONTROL));

  /*
   * /api/maintenance is what the portal's "New maintenance request" dialog and
   * the public /request form post to. It is the only path that produces a
   * complete job — MN-#### id, due date from the priority, activity log, alert
   * to the maintenance inbox — so a ticket raised from a site page and one
   * raised from the board dialog are the same kind of row.
   */
  assert.match(
    source,
    /fetch\("\/api\/maintenance", \{\s*method: "POST"/,
    "the dialog must POST to /api/maintenance",
  );

  const posts = [...source.matchAll(/fetch\("([^"]+)"[^)]*method: "POST"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    [...new Set(posts)],
    ["/api/maintenance"],
    "the control must not POST to a second creation endpoint",
  );
  assert.doesNotMatch(
    source,
    /action: "create_item"/,
    'the control must not use the board\'s inline "Add item" action, which creates a placeholder row on site-unassigned',
  );
  assert.doesNotMatch(
    source,
    /\/api\/board\/items/,
    "and must not use the subitem API, which sets no due date and sends no alert",
  );
});

test("the required fields are exactly the ones the route demands", async () => {
  const route = await read(ROUTE);

  /*
   * What the server actually refuses without, read out of the route rather than
   * restated. Grow the refusal and this test fails until the dialog grows a
   * field to match — which is the only thing that keeps "and no more" true.
   */
  const refusal = route.match(
    /if \(([^)]*?)\|\| description\.length < 10\) \{/s,
  );
  assert.ok(refusal, "the route's own validation must still be recognisable");
  const required = [...refusal[1].matchAll(/!(\w+)/g)].map((match) => match[1]).sort();
  assert.deepEqual(
    required,
    ["contact", "location", "requester"],
    "POST /api/maintenance is expected to require a location, a requester and a contact",
  );

  const source = code(await read(CONTROL));
  for (const gate of [
    /Boolean\(title\.trim\(\)\)/,
    /Boolean\(site\)/,
    /Boolean\(requesterValue\.trim\(\)\)/,
    /Boolean\(contactValue\.trim\(\)\)/,
    /bodyText\.length >= 10/,
  ]) {
    assert.match(source, gate, "the dialog must gate submission on the route's own conditions");
  }
});

test("the derived title is shown, not assumed", async () => {
  const route = await read(ROUTE);
  const source = await read(CONTROL);

  /*
   * /api/maintenance has no `title` field: `requestTitle()` takes the first
   * sentence of the description. The dialog restates that rule so it can show
   * the result before submission, which makes this pair the drift risk — if the
   * server's rule changes and the preview does not, the preview lies.
   */
  assert.match(route, /split\(\/\[\.\!\?\\n\]\/\)\[0\]/, "the server's rule must still be a first-sentence split");
  assert.match(route, /length > 72 \? `\$\{firstLine\.slice\(0, 69\)\}…`/);
  assert.match(source, /split\(\/\[\.\!\?\\n\]\/\)\[0\]/, "the preview must use the same split");
  assert.match(source, /length > 72 \? `\$\{firstLine\.slice\(0, 69\)\}…`/, "and the same truncation");
  assert.match(source, /The board will show this as/, "and it must be shown to the person typing");
});

/* ------------------------------------------------------------------ */
/* The site prefill, and the defect it must not repeat                 */
/* ------------------------------------------------------------------ */

test("the job's location is written from the chosen site's registered name", async () => {
  const source = code(await read(CONTROL));

  /*
   * 744 of 775 jobs carry site_id = 'store-aldgate' while naming a different
   * store in `location` — "Bullring", "Nottingham", "Merry Hill" — because the
   * two fields were filled from different sources. /api/maintenance resolves
   * `location` back to a `sites` row and sets `site_id` from what it finds, so
   * sending the register's own name for the chosen site is what makes the two
   * columns agree by construction.
   */
  assert.match(
    source,
    /location: site\.name,/,
    "the location must be the selected site's registered name",
  );
  assert.doesNotMatch(
    source,
    /location: context\./,
    "the caller's free-text location must never be copied onto the new job",
  );

  const route = await read(ROUTE);
  assert.match(
    route,
    /eq\(sites\.name, location\)/,
    "the route is expected to resolve the site from that name",
  );
});

test("a context whose site id and site name disagree is not prefilled", async () => {
  const source = code(await read(CONTROL));

  // A legacy job row hands over site_id 'store-aldgate' and the name "Bullring".
  // Trusting the id would raise the ticket against the wrong store; the resolver
  // has to notice the conflict instead of picking one silently.
  assert.match(
    source,
    /if \(byId && \(!named \|\| byName\?\.id === byId\.id\)\)/,
    "an id is only trusted when the name agrees with it, or there is no name",
  );
  assert.match(
    source,
    /is not a site in this workspace\. Neither can be trusted/,
    "an unresolvable conflict must be said out loud, not resolved by guesswork",
  );
  assert.match(
    source,
    /siteId: "",\s*reason:/,
    "an unresolvable conflict must leave the picker unset",
  );
});

/* ------------------------------------------------------------------ */
/* Capability                                                          */
/* ------------------------------------------------------------------ */

test("the control is not offered to an actor without board.edit", async () => {
  const source = await read(CONTROL);

  assert.match(
    source,
    /capabilities\?\.\["board\.edit"\]/,
    "the gate must read the effective capability when the server publishes one",
  );
  assert.match(
    source,
    /role !== "client"/,
    "and fall back to the built-in default for the role until it does",
  );
  assert.match(
    source,
    /const allowed = canRaise \?\? access\?\.canRaise \?\? false;\s*if \(!allowed\) return null;/,
    "an unresolved actor must be treated as not allowed — the gate fails closed",
  );
});

test("the route this control calls is still capability-guarded", async () => {
  const route = await read(ROUTE);
  // Hiding the button is a courtesy. The refusal has to be real, or the control
  // is security theatre over an open endpoint.
  assert.match(
    route,
    /scopedDbWithCapability\(request, "board\.edit"\)/,
    "POST /api/maintenance must require board.edit",
  );
  assert.match(route, /if \(guard\.denied\) return guard\.denied;/);

  /*
   * And the guard has to be *reachable*. This route called
   * `scopedDbWithCapability` without importing it for two commits — every POST
   * and PATCH answered 503 "scopedDbWithCapability is not defined", which took
   * the portal's New Request dialog and the public /request form down with it,
   * and read from the outside like a database outage. Two tsc errors said so
   * the whole time.
   */
  assert.match(
    route,
    /import \{[^}]*\bscopedDbWithCapability\b[^}]*\} from "\.\.\/\.\.\/lib\/tenant-db"/s,
    "the guard must actually be imported, or every write on this route throws",
  );
});

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

test("a refusal is reported in the server's own words", async () => {
  const source = code(await read(CONTROL));

  /*
   * The capability refusal reads 'Your role (Client) does not have the
   * "board.edit" permission in this workspace.' That names the role, the
   * capability and the workspace, and it is what the person needs to read.
   * Replacing it with "Something went wrong" throws all three away.
   */
  assert.match(
    source,
    /throw new Error\(\s*payload\.error \|\|/,
    "the body's own error must be preferred over any local wording",
  );
  assert.match(
    source,
    /HTTP \$\{response\.status\}/,
    "and an empty body must still name the status rather than a generic apology",
  );
  assert.match(
    source,
    /className="raise-ticket__error" role="alert"/,
    "the error must be announced, not merely printed",
  );
});

/* ------------------------------------------------------------------ */
/* What it says it is attaching to                                     */
/* ------------------------------------------------------------------ */

test("the dialog names the record it is attaching to", async () => {
  const source = await read(CONTROL);

  assert.match(source, /Attaching to/, "the dialog must say what the ticket attaches to");
  for (const field of [
    "siteName",
    "unitName",
    "contractorName",
    "complianceKind",
    "documentName",
  ]) {
    assert.match(
      source,
      new RegExp(`context\\.${field}`),
      `attachmentChips must account for ${field}`,
    );
  }

  /*
   * `maintenance_requests` has a site column and nothing for an asset, a
   * contractor or a certificate, so those survive only in the description. That
   * is a compromise, and the dialog has to admit it on screen rather than imply
   * a link that does not exist in the schema.
   */
  assert.match(
    source,
    /Only the site is a field on a job/,
    "the dialog must be honest that the rest is recorded as text",
  );
  assert.match(
    source,
    /export function provenanceBlock/,
    "the provenance written onto the ticket must be one testable function",
  );
});

test("the dialog says where the job will land before it is raised", async () => {
  const source = await read(CONTROL);
  assert.match(
    source,
    /raise-ticket__destination/,
    "the destination line must exist",
  );
  assert.match(
    source,
    /entry\.stageKey === "Incoming"/,
    "the landing group must be resolved from the board's own stage mapping, not hardcoded to a seeded id",
  );
});

/* ------------------------------------------------------------------ */
/* Reach                                                               */
/* ------------------------------------------------------------------ */

test("the control is usable one-handed at 390px", async () => {
  const styles = await read(STYLES);

  const floors = [...styles.matchAll(/min-height: 44px/g)];
  assert.ok(
    floors.length >= 3,
    "the 44px floor must cover the trigger, the fields and the actions, not only the buttons",
  );
  assert.match(
    styles,
    /\.raise-ticket \.form-field :is\(input, select\)[\s\S]{0,120}min-height: 44px/,
    "selects and inputs need the touch minimum as much as buttons do",
  );
  assert.match(
    styles,
    /@media \(max-width: 430px\)/,
    "there must be a small-screen layout, and 430px covers the 390px device",
  );
  assert.match(
    styles,
    /@media \(max-width: 430px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/,
    "the two-column row must collapse rather than overflow",
  );
});

test("the control carries no server-only imports into the client bundle", async () => {
  const source = await read(CONTROL);
  assert.match(source, /^"use client";/, "it is a client component");
  for (const forbidden of ["lib/permissions", "db/schema", "drizzle-orm", "tenant-db"]) {
    assert.doesNotMatch(
      source,
      new RegExp(`from "[^"]*${forbidden.replace("/", "\\/")}`),
      `${forbidden} is server-side and must not be pulled into the browser bundle`,
    );
  }
});
