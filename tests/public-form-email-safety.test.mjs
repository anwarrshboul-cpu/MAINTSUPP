/**
 * Four things that must be true of the three public forms before real email
 * delivery is switched on.
 *
 * None of them mattered while `RESEND_API_KEY` was unset and every send landed
 * as a `skipped` row. All four matter the moment it is set, and three of them
 * are only reachable by a stranger — which is the combination that makes them
 * worth pinning rather than remembering.
 *
 *   1. Visitor input is ESCAPED before it reaches an HTML email. Not XSS —
 *      nothing renders in a browser the visitor controls — but content
 *      injection into the owner's inbox, which a mail client will render.
 *   2. A reply reaches the PERSON, not the send-only address the alert came
 *      from.
 *   3. The provider call has a DEADLINE, so a hung Resend cannot turn a saved
 *      submission into a gateway error the visitor will retry.
 *   4. The honeypot is read on the SERVER, where a bot posting directly to the
 *      route cannot skip it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/** Source with comments stripped: a claim must not pass on its own rationale. */
const code = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOTIFICATIONS = "app/lib/notifications.ts";

test("every visitor-supplied field is escaped before it reaches an email", async () => {
  const source = await read(NOTIFICATIONS);

  /* One place, not eighteen. `row()` is what the lead alert's six fields, the
     job alert's seven and the job-link event's five all pass through, so the
     escape belongs there rather than at each call site — where the next field
     added would arrive raw. */
  assert.match(
    code(source),
    /function row\(label: string, value: string \| null \| undefined\) \{[\s\S]*?\$\{escapeHtml\(value\)\}/,
    "row() must escape its value",
  );
  assert.doesNotMatch(
    code(source),
    /<td style="padding:4px 0;font-size:13px">\$\{value\}</,
    "the raw interpolation is gone, not merely joined by an escaped one",
  );

  /* And the four characters that matter are all handled: `>` and `"` are what
     let an attribute be closed and a new one opened. */
  const escape = code(source).slice(code(source).indexOf("function escapeHtml"));
  for (const [char, entity] of [["&", "&amp;"], ["<", "&lt;"], [">", "&gt;"], ['"', "&quot;"]]) {
    assert.ok(
      escape.slice(0, 400).includes(entity),
      `escapeHtml must replace ${char} with ${entity}`,
    );
  }
});

test("and it is EXERCISED, not only pinned: the escape actually runs", async () => {
  /*
   * The two functions are lifted out of the file and run, the way
   * `preview-alias-guard` runs the script's own verdict function. A pin can
   * only say the call is written; this says the output is safe — and it reads
   * the real source, so a copy of the logic cannot drift away from it.
   *
   * The payload is one a public form can actually carry. It was POSTed to a
   * local /api/leads during this work and stored verbatim in
   * `leads.challenge`, which is correct: the database records what somebody
   * typed. The EMAIL is where it must not be markup.
   */
  const source = await read(NOTIFICATIONS);
  const escapeSrc = /function escapeHtml\(value: string\) \{[\s\S]*?\n\}/.exec(source);
  const rowSrc =
    /function row\(label: string, value: string \| null \| undefined\) \{[\s\S]*?\n\}/.exec(source);
  assert.ok(escapeSrc && rowSrc, "both functions must still be findable in the source");

  /* The only transformation is dropping the two type annotations, so what runs
     below is the shipped body rather than a paraphrase of it. */
  const strip = (js) =>
    js.replace(/: string \| null \| undefined/g, "").replace(/: string/g, "");
  const { row } = new Function(
    `${strip(escapeSrc[0])}\n${strip(rowSrc[0])}\nreturn { row, escapeHtml };`,
  )();

  const attack = '<img src=x onerror="alert(1)"> & "quoted" <a href="http://evil">click</a>';
  const rendered = row("What they said", attack);

  assert.ok(!rendered.includes("<img"), "no tag survives");
  assert.ok(!rendered.includes("<a href"), "no link survives");
  assert.ok(!rendered.includes('onerror="'), "no event handler survives");
  assert.ok(rendered.includes("&lt;img"), "it is shown as text instead");
  assert.ok(rendered.includes("&amp;"), "and the ampersand is entity-encoded");
  assert.ok(rendered.includes("&quot;"), "and the quote, so an attribute cannot be closed");
  /* The label is a literal in that file and is deliberately not escaped, so the
     row's own markup must still be intact around the escaped value. */
  assert.ok(rendered.startsWith("<tr>") && rendered.trimEnd().endsWith("</tr>"));

  assert.equal(row("Phone", ""), "", "an empty value still renders no row at all");
  assert.equal(row("Phone", null), "");
});

test("the contractor route escapes all four too, not two of them", async () => {
  /* Its template is built inline rather than in notifications.ts, so it does
     not get `row()`. It escaped `&` and `<` only. */
  const route = await read("app/api/contractor-applications/route.ts");
  for (const entity of ["&amp;", "&lt;", "&gt;", "&quot;"]) {
    assert.ok(code(route).includes(entity), `the inline template must produce ${entity}`);
  }
});

test("a reply to a public alert reaches the person who sent it", async () => {
  const source = await read(NOTIFICATIONS);
  assert.match(source, /replyTo\?: string;/, "the request carries an optional reply address");
  assert.match(
    code(source),
    /\.\.\.\(request\.replyTo \? \{ reply_to: \[request\.replyTo\] \} : \{\}\)/,
    "it is sent as reply_to, and OMITTED rather than sent empty when absent",
  );

  /* The two public forms that collect an address set it. Report a Job does not
     appear here on purpose: it asks for a phone number, not an email, so there
     is no address to reply to and inventing one would be worse than the header
     being absent. */
  const leads = await read("app/api/leads/route.ts");
  assert.match(
    code(leads),
    /to: salesInbox,[\s\S]{0,200}?replyTo: email,/,
    "the portfolio enquiry alert replies to the enquirer",
  );
  const contractors = await read("app/api/contractor-applications/route.ts");
  assert.match(
    code(contractors),
    /to: contractorInbox,[\s\S]{0,200}?replyTo: email,/,
    "the contractor application alert replies to the applicant",
  );
});

test("the provider call has a deadline, and a timeout is recorded rather than thrown", async () => {
  const source = await read(NOTIFICATIONS);
  assert.match(source, /const EMAIL_TIMEOUT_MS = 10_000;/, "stated once, as a named constant");
  assert.match(
    code(source),
    /signal: AbortSignal\.timeout\(EMAIL_TIMEOUT_MS\)/,
    "the fetch carries it",
  );

  /* A rejected fetch must come back as a recorded failure, not an exception:
     `sendNotification` promises it never throws, and the row is already saved
     by the time this runs. */
  assert.match(
    code(source),
    /\} catch \(cause\) \{[\s\S]*?return \{[\s\S]*?ok: false,[\s\S]*?error:/,
    "the fetch is wrapped and the failure is returned",
  );
  assert.match(code(source), /timed out after \$\{EMAIL_TIMEOUT_MS\}ms/, "and says so");
});

test("the lead honeypot is checked on the server, not only in the browser", async () => {
  const route = await read("app/api/leads/route.ts");

  assert.match(
    code(route),
    /if \(clean\(payload\.website, \d+\)\) \{/,
    "the route reads the field the form hides",
  );
  /* Silent, and shaped like success. A 400 that names the reason teaches the
     next attempt to leave the field empty. */
  assert.match(
    code(route).slice(code(route).indexOf("payload.website")),
    /\{ status: 201 \}/,
    "it answers 201, not an error the sender can learn from",
  );
  const afterHoneypot = code(route).slice(code(route).indexOf("payload.website"));
  const insertAt = afterHoneypot.indexOf("db.insert(leads)");
  const returnAt = afterHoneypot.indexOf("{ status: 201 }");
  assert.ok(
    returnAt > -1 && (insertAt === -1 || returnAt < insertAt),
    "and it returns BEFORE anything is written",
  );

  /* The browser-side check stays: it saves the round trip for the bots it does
     catch, and removing it would look like the honeypot had been dropped. */
  const form = await read("app/(marketing)/_sections/final-cta.tsx");
  assert.match(code(form), /if \(website\) return;/, "the client check is still there too");
});
