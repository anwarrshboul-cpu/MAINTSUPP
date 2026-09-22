/**
 * THE WEBSITE ENQUIRIES, AS A SPREADSHEET (§12's missing half).
 *
 * The inbox could be read and triaged on screen and there was no way to get the
 * list out of it. An enquiry is a sales record: it is followed up outside this
 * product, by people who have no account in it, and the answer to "send me this
 * week's enquiries" was a person retyping them.
 *
 * WHAT THIS FILE IS GUARDING, and it is one thing above all others:
 *
 * **The export must answer to the same gate as the inbox.** These rows carry a
 * customer workspace's id while belonging to the platform — `app/api/leads/route.ts`
 * explains at length how a capability check would have shown one client every
 * enquiry MAINTSUPP has ever received, competitors' names included. A second
 * reader of the same rows is therefore the one place that mistake could be made
 * again, so the gate and the read are ONE function each, imported, and the tests
 * below assert the export restates neither.
 *
 * The rest is fidelity: the download must be the list the reader is looking at
 * (the screen's filter travels in the query), and every field the screen shows
 * must appear as a column, or the spreadsheet quietly loses data the inbox has.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
/* Comments removed: a rule described in prose must not satisfy a pin. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the gate and the reader are written once and imported by both callers", async () => {
  const inbox = code(await read("app/api/leads/route.ts"));
  const csv = code(await read("app/api/leads/csv/route.ts"));

  assert.match(inbox, /export function platformLeadsRefusal\(/, "the gate is exported");
  assert.match(
    inbox,
    /if \(scope\.platformAdmin === true && scope\.authenticated\) return null;\s*return Response\.json\(\{ error: message \}, \{ status: 403 \}\);/,
    "the caller chooses the sentence, never the rule",
  );
  assert.match(inbox, /export async function readLeadEnquiries\(/, "the reader is exported");
  assert.match(
    inbox,
    /if \(scope\.platformAdmin === true && scope\.authenticated\) return null;/,
    "platform staff AND a proved session — not a capability",
  );
  assert.match(csv, /import \{ platformLeadsRefusal, readLeadEnquiries \} from "\.\.\/route";/);

  /* THE POINT OF THIS FILE: the export must not have its own opinion about who
     may read an enquiry, and must not reach the table itself. */
  assert.doesNotMatch(csv, /platformAdmin/, "the export restates no authority check");
  assert.doesNotMatch(csv, /requireCapability|resolvePermissions/, "and no capability check");
  assert.doesNotMatch(csv, /\bfrom\(leads\)|\.select\(/, "and does not read the table a second way");

  /* The gate is asked before the rows are read, in both handlers. */
  for (const [name, source] of [["the inbox", inbox], ["the export", csv]]) {
    const at = source.indexOf("export async function GET");
    const body = source.slice(at);
    assert.ok(
      body.indexOf("platformLeadsRefusal") < body.indexOf("readLeadEnquiries"),
      `${name} asks the gate before it reads`,
    );
  }
});

test("the download is the list on screen: the filter travels, and an invented one is refused", async () => {
  const csv = code(await read("app/api/leads/csv/route.ts"));
  assert.match(csv, /searchParams\.get\("status"\) \?\? "open"/, "the inbox opens on 'open', so the export defaults to it");
  assert.match(
    csv,
    /if \(requested !== "open" && requested !== "all" && !isLeadStatus\(requested\)\)/,
    "only open, all, or a real status",
  );
  assert.match(csv, /\{ status: 400 \}/, "an unknown filter is refused, never widened to everything");
  assert.match(
    csv,
    /requested === "all" \? true : requested === "open" \? !entry\.closed : entry\.status === requested/,
    "and the three readings match the screen's",
  );

  const view = code(await read("app/(app)/admin/leads-view.tsx"));
  assert.match(
    view,
    /href=\{`\/api\/leads\/csv\?status=\$\{encodeURIComponent\(filter\)\}`\}/,
    "the screen sends the filter it is showing",
  );
  assert.match(view, /download/, "a link and a download, so no JavaScript sits between the click and the file");
});

test("every field the inbox shows becomes a column, and nothing is exported that the screen does not read", async () => {
  const inbox = await read("app/api/leads/route.ts");
  const csv = await read("app/api/leads/csv/route.ts");

  /* The enquiry shape the screen is given, from the exported type. */
  const shape = inbox.slice(inbox.indexOf("export type LeadEnquiry = {"), inbox.indexOf("/**", inbox.indexOf("export type LeadEnquiry")));
  const fields = [...shape.matchAll(/^\s{2}(\w+)[?]?:/gm)].map((match) => match[1]);
  assert.ok(fields.length >= 15, `the type was read (${fields.length} fields)`);

  const mapping = csv.slice(csv.indexOf("const rows = filtered.map"), csv.indexOf("const day ="));
  for (const field of fields) {
    if (field === "closed") continue; // `status` carries it; a second "closed" column would repeat one word.
    assert.match(
      mapping,
      new RegExp(String.raw`entry\.${field}\b`),
      `${field} must reach the spreadsheet — a download that quietly drops a field is worse than none`,
    );
  }

  /* Every declared column is filled, and every filled key is declared: the two
     lists are written apart, and `toCsv` silently writes an empty cell for a key
     it cannot find, so a typo would lose a column without any failure. */
  const columns = [...csv.slice(csv.indexOf("const COLUMNS = ["), csv.indexOf("];", csv.indexOf("const COLUMNS = ["))).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.equal(columns.length, 15);
  for (const column of columns) {
    const key = /^[A-Za-z]+$/.test(column) ? column : `"${column}"`;
    assert.ok(
      mapping.includes(`${key}:`),
      `the column "${column}" is declared and never filled`,
    );
  }
  for (const key of [...mapping.matchAll(/^\s{6}"?([A-Za-z][A-Za-z ]*?)"?:/gm)].map((match) => match[1])) {
    assert.ok(columns.includes(key), `"${key}" is filled and never declared, so it is not in the file`);
  }
});

test("a download changes nothing, and the file opens correctly in Excel", async () => {
  const csv = code(await read("app/api/leads/csv/route.ts"));
  /* No status is moved, nothing is marked exported, and no audit row is written —
     a download is a read, which is the rule every other export in this product
     follows. `PATCH /api/leads` remains the only writer. */
  assert.doesNotMatch(csv, /recordAudit|\.update\(|\.insert\(|\.delete\(/);
  /* The BOM, the CRLF rows and the quoting belong to the shared helper, which the
     Sites, Assets and board exports already use; this route adds none of its own. */
  assert.match(csv, /import \{ csvResponse, toCsv \} from "\.\.\/\.\.\/\.\.\/lib\/csv";/);
  assert.match(csv, /csvResponse\(`maintsupp-enquiries-\$\{requested\}-\$\{day\}\.csv`, toCsv\(COLUMNS, rows\)\)/);
  const helper = await read("app/lib/csv.ts");
  assert.match(helper, /\\uFEFF/, "the BOM is the helper's, so Excel does not mangle an accented company name");
});

/* ── Live: the wire, when a dev server is answering ───────────────────────── */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER = {
  email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
  password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
};

const serverUp = await (async () => {
  try {
    return (await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) })).status < 500;
  } catch {
    return false;
  }
})();

test("live: signed out, the export is refused exactly as the inbox is", { skip: !serverUp }, async () => {
  for (const path of ["/api/leads", "/api/leads/csv"]) {
    const response = await fetch(`${BASE_URL}${path}`, { headers: { Accept: "application/json" } });
    assert.ok(response.status === 401 || response.status === 403, `${path}: ${response.status}`);
  }
});

test("live: platform staff download the enquiries, and an invented filter is refused", { skip: !serverUp }, async () => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(OWNER),
  });
  if (login.status !== 200) return; // Not this installation's owner: nothing to prove here.
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(";")[0])
    .filter((value) => value.startsWith("maintsupp_session"))
    .join("; ");

  const response = await fetch(`${BASE_URL}/api/leads/csv?status=all`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(response.headers.get("content-disposition") ?? "", /attachment; filename="maintsupp-enquiries-all-\d{4}-\d{2}-\d{2}\.csv"/);
  const body = await response.text();
  assert.ok(body.startsWith("﻿"), "the BOM is there");
  assert.match(body.split("\r\n")[0], /^﻿Received,Status,Name,Company,Email,Phone,Sites,Services,Regions,Challenge,Notified,Notify attempts,Filed under,Workspace id,Enquiry id$/);

  const inbox = await (await fetch(`${BASE_URL}/api/leads`, { headers: { cookie } })).json();
  const rows = body.trimEnd().split("\r\n").length - 1;
  assert.equal(rows, (inbox.enquiries ?? []).length, "every enquiry the inbox lists is a row in the file");

  const refused = await fetch(`${BASE_URL}/api/leads/csv?status=not-a-filter`, { headers: { cookie } });
  assert.equal(refused.status, 400);
  await fetch(`${BASE_URL}/api/auth/logout`, { method: "POST", headers: { cookie } });
});
