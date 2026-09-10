/**
 * THE OPERATIONS REBUILD — the rules the four pages are allowed to disagree on:
 * none.
 *
 * Overview, Compliance, Sites and Contractors were rebuilt against four briefs
 * whose common demand is that one definition serves all four screens. This file
 * is that demand, asserted.
 *
 * TWO KINDS OF TEST, and the distinction matters:
 *
 *   • The behavioural ones CALL the shipped modules — natively where the import
 *     chain allows it, transpiled with their specifiers rewritten where it does
 *     not. Either way these are real calls into real code rather than a
 *     re-implementation that could agree with itself while the product is wrong.
 *
 *   • The structural ones read SOURCE. A rule like "no card computes its own
 *     open count" is a statement about where code lives, and the only way to
 *     hold it is to look. When one of these breaks, re-point it at the
 *     contract's new home with the reason written in — never delete it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
/*
 * NORMALISED, BECAUSE THIS IS A WINDOWS CHECKOUT AND LINE ENDINGS ARE PER FILE.
 *
 * There is no `.gitattributes`, so `app/lib/site-metrics.ts` is CRLF while its
 * neighbours are LF — CLAUDE.md records the same trap for `app/api/files/
 * route.ts` against `portal-app.tsx`. `fnBody` below looks for the literal
 * "\n}\n" to find where a function ends, which a CRLF file does not contain,
 * so "isPlaceholderManager must end with a brace at column zero" failed on a
 * function that plainly does. The test was not wrong about the code; it was
 * reading bytes it had not normalised, and it therefore only ever tested on an
 * LF checkout.
 *
 * The other suites that slice source already do this — see the `read` in
 * `tests/audit-api-field-types.test.mjs`. Normalising can only make a match
 * that is written against LF succeed, never fail, so no existing assertion
 * changes meaning.
 */
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/** Comments quote the strings they explain; a rule against that is a rule
    against writing the explanation down. Every source check strips them. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * One exported function, sliced out by its braces and stripped of its types.
 *
 * For modules that cannot be imported because they reach drizzle. The slice is
 * real shipped code, which is the point — a re-implementation could agree with
 * itself while the product is wrong.
 */
function fnBody(source, name) {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start > 0, `${name} has moved; fix this test`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > 0, `${name} must end with a brace at column zero`);
  return source
    .slice(start, end + 3)
    .replace("export ", "")
    .replace(/\(([a-zA-Z]+): [^)]*\)/, "($1)")
    .replace(/\): boolean \{/, ") {");
}

const ts = (await import("typescript")).default;

/** Transpile one TypeScript module to a loadable `data:` URL. */
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const asModule = (js) =>
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;

/**
 * `job-metrics.ts` is imported NATIVELY — `node --test` strips its types — and
 * it can be because its one runtime import names an explicit `.ts` extension,
 * which `allowImportingTsExtensions` in tsconfig already permits. That is why
 * the rules below are asserted by CALLING them.
 */
const metrics = await import("../app/lib/job-metrics.ts");

/**
 * `compliance-status.ts` is transpiled instead, with its imports rewritten —
 * the pattern ten other suites use.
 *
 * It cannot take the `.ts` treatment: `expiry-status.ts` is loaded from a
 * `data:` URL by those suites, which rewrite `from "./format-date"` by exact
 * string, and a relative specifier cannot resolve from a `data:` URL at all.
 * Adding an extension there took eleven files red in one edit. The dependency
 * chain, not the preference, decides which of the two loaders a module gets.
 */
const compliance = await (async () => {
  const formatDate = asModule(transpile(await read("app/lib/format-date.ts")));
  const spec = asModule(transpile(await read("db/monday-board-spec.ts")));
  /*
   * `compliance-duty-holder.ts` joined the chain when the compliance
   * percentage learned to exclude a requirement nobody has claimed. It imports
   * NOTHING, which is the whole reason it is a file of its own and not a few
   * exports added to `compliance-status.ts`: a leaf can be transpiled and
   * handed to `import()` with no rewriting at all, and the rule it holds is
   * asked by both the register and this module.
   *
   * It is rewritten below by exact string, like every other specifier here. A
   * VALUE import that is not rewritten does not fail loudly — it takes the
   * whole suite out on load, which is how eleven files went red in one edit.
   */
  const dutyHolder = asModule(transpile(await read("app/lib/compliance-duty-holder.ts")));
  const expiry = asModule(
    transpile(await read("app/lib/expiry-status.ts")).replace(
      /from ["']\.\/format-date["']/g,
      `from "${formatDate}"`,
    ),
  );
  const register = asModule(
    transpile(await read("app/lib/store-documentation-register.ts"))
      .replace(/from ["']\.\.\/\.\.\/db\/monday-board-spec["']/g, `from "${spec}"`)
      .replace(/from ["']\.\/expiry-status["']/g, `from "${expiry}"`),
  );
  return import(
    asModule(
      transpile(await read("app/lib/compliance-status.ts"))
        .replace(/from ["']\.\/expiry-status["']/g, `from "${expiry}"`)
        .replace(/from ["']\.\/store-documentation-register["']/g, `from "${register}"`)
        .replace(/from ["']\.\/compliance-duty-holder["']/g, `from "${dutyHolder}"`),
    )
  );
})();

const meters = await import(
  asModule(transpile(await read("app/(app)/portal/dashboard-meters.ts")))
);

/* ── 1. One definition of open ────────────────────────────────────────────── */

test("the family map is built FROM the closure vocabulary, not beside it", () => {
  for (const label of meters.completedStatuses) {
    assert.equal(
      metrics.STATUS_FAMILY[metrics.statusKey(label)],
      "completed",
      `${label} closes a job in dashboard-meters.ts and must close one here`,
    );
  }
  assert.equal(metrics.COMPLETED_STAGE, meters.COMPLETED_STAGE);
});

test("isClosedJob and isClosedRequest are the same partition", () => {
  const rows = [
    { stage: "Completed", status: "Pending Approval" },
    { stage: "Incoming", status: "Job Completed" },
    { stage: "Incoming", status: "Completed" },
    { stage: "Incoming", status: "Cancelled" },
    { stage: "Incoming", status: "Pending Approval" },
    { stage: "Attention", status: "Waiting for payment" },
    { stage: "Booked", status: "Job Scheduled" },
    { stage: "Incoming", status: "A status nobody has ever typed" },
  ];
  for (const row of rows) {
    assert.equal(
      metrics.isClosedJob(row),
      meters.isClosedRequest(row),
      `the two languages disagree about ${row.stage}/${row.status}`,
    );
  }
  // And they are a partition: every row is exactly one of the two.
  for (const row of rows) {
    assert.notEqual(metrics.isOpenJob(row), metrics.isClosedJob(row));
  }
});

test("an unmapped status is counted as in progress, and is never dropped", () => {
  assert.equal(metrics.statusFamily("Awaiting client PO", { warn: false }), "in_progress");
  // Not completed — a live job that counted as closed would vanish from every
  // open figure without trace. Not attention — a red flag on work nobody has
  // said is stuck.
  assert.notEqual(metrics.statusFamily("Awaiting client PO", { warn: false }), "completed");
  assert.notEqual(metrics.statusFamily("Awaiting client PO", { warn: false }), "attention");
});

test("the fake taxonomy is gone from the codebase, not merely unused", async () => {
  /*
   * `jobStatusSegments` drew the Overview's "Jobs by status" donut from
   * Open / In progress / Awaiting parts / On hold / Scheduled — five buckets no
   * job on this board uses, three of them permanently zero, with four fifths of
   * the work landing in one labelled "On hold". The brief asks for it deleted
   * rather than remapped, so this asserts absence.
   */
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.doesNotMatch(portal, /function jobStatusSegments\(/);
  assert.doesNotMatch(
    codeOnly(portal),
    /Open: "#12b4a8"[\s\S]{0,200}"Awaiting parts"/,
    "the five-bucket palette must not come back",
  );
});

test("the sidebar badge and the Overview read one definition of open", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(
    portal,
    /import \{ openJobCount \} from "\.\.\/\.\.\/lib\/job-metrics"/,
    "the badge takes its count from the shared module",
  );
  assert.match(
    codeOnly(portal),
    /const openCount = openJobCount\(requests\.filter\(countsAsWorkOrder\)\)/,
    "and applies the same lifecycle scope the aggregates apply in SQL",
  );
  assert.match(codeOnly(portal), /badges=\{\{ maintenance: openCount \}\}/);
  assert.match(
    codeOnly(portal),
    /badgeDescriptions=\{\{ maintenance: "open jobs" \}\}/,
    "and says what it is counting",
  );
});

/* ── 2. Ageing ────────────────────────────────────────────────────────────── */

test("the ageing bands are 0-14 / 15-30 / 31-60 / 60+, once", () => {
  assert.deepEqual(
    metrics.AGEING_BANDS.map((band) => [band.key, band.from, band.to]),
    [
      ["fresh", 0, 14],
      ["ageing", 15, 30],
      ["overdue", 31, 60],
      ["critical", 61, null],
    ],
  );
  assert.equal(metrics.ageingBand(0).key, "fresh");
  assert.equal(metrics.ageingBand(14).key, "fresh");
  assert.equal(metrics.ageingBand(15).key, "ageing");
  assert.equal(metrics.ageingBand(30).key, "ageing");
  assert.equal(metrics.ageingBand(31).key, "overdue");
  assert.equal(metrics.ageingBand(60).key, "overdue");
  assert.equal(metrics.ageingBand(61).key, "critical");
  assert.equal(metrics.ageingBand(9999).key, "critical");
  // Every band states its range in words, because colour is never the only
  // carrier of meaning.
  for (const band of metrics.AGEING_BANDS) assert.match(band.range, /days/);
});

/* ── 3. Overdue — moved out of portal-app, semantics unchanged ────────────── */

/*
 * These four were `loadDuePassed` in tests/audit-dashboard-overview.test.mjs,
 * which sliced the function out of `portal-app.tsx` by its braces and
 * re-evaluated it. The rule moved to `app/lib/job-metrics.ts` when the Overview
 * stopped computing overdue in the browser; the assertions are the same ones
 * and they now import the function instead of reconstructing it.
 */
const at = (year, month, day, hour, minute) => Date.UTC(year, month - 1, day, hour, minute);

test("a bare due date is not overdue until its day is over", () => {
  const due = "2026-08-25";
  assert.equal(metrics.duePassed(due, at(2026, 8, 25, 0, 30)), false);
  assert.equal(metrics.duePassed(due, at(2026, 8, 25, 12, 0)), false);
  assert.equal(metrics.duePassed(due, at(2026, 8, 25, 23, 59)), false);
  assert.equal(metrics.duePassed(due, at(2026, 8, 26, 0, 1)), true);
});

test("a due date with a time is an instant, late the moment it passes", () => {
  const due = "2026-08-25T09:00:00.000Z";
  const instant = Date.parse(due);
  assert.equal(metrics.duePassed(due, instant - 60_000), false);
  assert.equal(metrics.duePassed(due, instant + 60_000), true);
});

test("an unreadable due date is never overdue", () => {
  assert.equal(metrics.duePassed("not a date", Date.now()), false);
  assert.equal(metrics.duePassed(null, Date.now()), false);
  assert.equal(metrics.duePassed("", Date.now()), false);
});

test("finished work is never overdue", () => {
  const late = { stage: "Completed", status: "Job Completed", dueAt: "2020-01-01" };
  assert.equal(metrics.isOverdue(late, Date.now()), false);
});

test("the SQL twin of duePassed carries both branches", async () => {
  const aggregates = codeOnly(await read("app/lib/dashboard-aggregates.ts"));
  const fn = aggregates.slice(aggregates.indexOf("export function overdueOpenSql"));
  /* `trim(${due})` became `${due}`: `due` is `dateText(raw)` now, because
     trimming the raw column threw `btrim(date) does not exist` on Production.
     The two branches are the contract and the cast is now part of it. */
  assert.match(fn.slice(0, 1200), /const due = dateText\(raw\)/, "over the cast, not the raw column");
  assert.match(fn.slice(0, 1200), /length\(\$\{due\}\) <= 10/, "the bare-date branch");
  assert.match(fn.slice(0, 1200), /length\(\$\{due\}\) > 10/, "and the instant branch");
  assert.match(fn.slice(0, 900), /openJobSql/, "and only open work can be late");
});

/* ── 4. Priority ──────────────────────────────────────────────────────────── */

test("a stringified object is not a priority", () => {
  // The legacy importer stringified monday's blank cells, so rows carry the
  // literal sixteen characters "[object Object]" where a priority should be.
  assert.equal(metrics.normalisePriority("[object Object]"), "not_recorded");
  assert.equal(metrics.normalisePriority(""), "not_recorded");
  assert.equal(metrics.normalisePriority(null), "not_recorded");
  assert.equal(metrics.normalisePriority(" Medium "), "medium");
  assert.equal(metrics.normalisePriority("URGENT"), "urgent");
});

test("Not recorded is one colour across every dimension", () => {
  const grey = metrics.NOT_RECORDED_COLOUR;
  const band = metrics.PRIORITY_BANDS.find((entry) => entry.key === "not_recorded");
  assert.equal(band.colour, grey, "priority's grey is the shared grey");
});

/* ── 5. Compliance ────────────────────────────────────────────────────────── */

test("Not required is outside the compliance fraction on BOTH sides", () => {
  const records = [
    ...Array.from({ length: 3 }, () => ({ state: "Compliant" })),
    ...Array.from({ length: 4 }, () => ({ state: "Not required" })),
    ...Array.from({ length: 5 }, () => ({ state: "Missing" })),
  ];
  const result = compliance.complianceCompletion(records);
  assert.equal(result.total, 12, "every record is in the denominator of the METER");
  assert.equal(result.applicable, 8, "but only the applicable ones score");
  assert.equal(result.satisfied, 3);
  assert.equal(result.percent, 38);
  assert.equal(result.notRequired, 4, "and the count is reported beside the score");
  /*
   * The brief asks for the other arrangement — Not applicable counted as
   * SATISFIED over a denominator of everything, which would score this set at
   * 58%. It inflates: a store holding eleven inapplicable requirements and one
   * missing certificate would read 92% compliant. See the note on
   * `complianceCompletion`.
   */
  assert.notEqual(result.percent, 58);
});

test("nothing applicable is not zero per cent", () => {
  const result = compliance.complianceCompletion([
    { state: "Not required" },
    { state: "Not required" },
  ]);
  assert.equal(result.scored, false, "a caller must be able to print a dash, not 0%");
  const empty = compliance.complianceCompletion([]);
  assert.equal(empty.scored, false);
});

test("complianceScore delegates rather than keeping a second rule", async () => {
  const links = codeOnly(await read("app/(app)/portal/compliance-links.ts"));
  assert.match(
    links,
    /import \{ complianceCompletion \} from "\.\.\/\.\.\/lib\/compliance-status"/,
  );
  assert.match(
    links,
    /export function complianceScore\([\s\S]{0,900}?return complianceCompletion\(records\)\.percent;/,
    "one rule, in app/lib/compliance-status.ts",
  );
});

test("the amber window is printed from the constant, never typed", async () => {
  const status = await read("app/lib/compliance-status.ts");
  assert.match(status, /EXPIRY_DUE_SOON_DAYS/);
  assert.match(
    compliance.COMPLIANCE_MEANING["Expiring soon"],
    new RegExp(`${compliance.EXPIRY_DUE_SOON_DAYS} days`),
    "the sentence and the classifier cannot disagree about the window",
  );
  const page = codeOnly(await read("app/(app)/portal/ops/compliance-page.tsx"));
  assert.doesNotMatch(
    page,
    /expiring within 30 days/i,
    "a hard-coded 30 is the defect that made a tile say 30 while it was filled from 60",
  );
  assert.match(page, /expiring within \$\{expiryWindowDays\} days/);
});

test("an absent due date reads as words, never as a dash", async () => {
  assert.equal(compliance.NO_DUE_DATE, "No due date");
  const page = codeOnly(await read("app/(app)/portal/ops/compliance-page.tsx"));
  assert.doesNotMatch(
    page,
    /record\.expiry \? [^:]+ : "—"/,
    "an em dash in a value column reads as a rendering fault",
  );
  assert.match(page, /record\.expiry \? formatDate\(record\.expiry\) : NO_DUE_DATE/);
});

test("records sort Missing then Expired then Expiring then Compliant", () => {
  const order = ["Missing", "Expired", "Expiring soon", "Compliant", "Not required"];
  assert.deepEqual([...compliance.COMPLIANCE_STATES], order);
  const shuffled = ["Compliant", "Not required", "Expired", "Missing", "Expiring soon"];
  assert.deepEqual(
    [...shuffled].sort(
      (left, right) => compliance.complianceUrgency(left) - compliance.complianceUrgency(right),
    ),
    order,
  );
});

/* ── 6. Nothing is filtered in the browser ────────────────────────────────── */

test("the Overview computes no figure of its own", async () => {
  const page = codeOnly(await read("app/(app)/portal/ops/overview-page.tsx"));
  for (const endpoint of [
    "/api/dashboard/summary",
    "/api/dashboard/sites-attention",
    "/api/dashboard/job-breakdown",
    "/api/dashboard/performance",
    "/api/dashboard/cost",
  ]) {
    assert.ok(page.includes(endpoint), `${endpoint} is what the page reads`);
  }
  /*
   * The page holds no job list, so it cannot filter one. This is the property
   * the whole rebuild rests on: the previous Overview filtered every job plus a
   * 432 KB workspace snapshot on every render, which is why its period control
   * could only ever narrow what had already been downloaded.
   */
  assert.doesNotMatch(page, /requests\.filter\(/);
  assert.doesNotMatch(page, /\/api\/maintenance/);
  assert.doesNotMatch(page, /\/api\/workspace/);
});

test("no operations page keeps filter state in localStorage", async () => {
  for (const file of [
    "app/(app)/portal/ops/overview-page.tsx",
    "app/(app)/portal/ops/compliance-page.tsx",
    "app/(app)/portal/ops/sites-list.tsx",
    "app/(app)/portal/ops/contractors-list.tsx",
    "app/(app)/portal/ops/ops-url-state.ts",
    "app/(app)/portal/ops/ops-filter-bar.tsx",
  ]) {
    const source = codeOnly(await read(file));
    assert.doesNotMatch(
      source,
      /localStorage|sessionStorage/,
      `${file} must keep its state in the URL — a filtered page is a link`,
    );
    assert.match(source, /useQueryState|useOpsQuery/, `${file} reads the URL`);
  }
});

/* ── 7. The aggregates ────────────────────────────────────────────────────── */

test("the dashboard aggregates never SELECT * and never call julianday", async () => {
  const source = await read("app/lib/dashboard-aggregates.ts");
  assert.doesNotMatch(
    codeOnly(source),
    /\.select\(\)\s*\n?\s*\.from\(maintenanceRequests\)/,
    "a dashboard card must not read whole job rows",
  );
  /*
   * `db/sqlite-to-postgres.ts` refuses julianday() by name, so day arithmetic
   * happens on the server in this module and reaches SQL as a comparison
   * against a date the SERVER computed — never as a browser clock.
   */
  assert.doesNotMatch(codeOnly(source), /julianday|strftime/);
});

test("every window boundary is a bare YYYY-MM-DD", async () => {
  const filters = codeOnly(await read("app/lib/dashboard-filters.ts"));
  /*
   * `requested_at` carries TWO formats on the live estate —
   * `2026-09-04 15:27:14` from CURRENT_TIMESTAMP and `2026-06-25T09:00:00.000Z`
   * from the importer — and a space sorts before a `T`, so a full-ISO cutoff
   * gets rows raised ON the boundary day backwards. A date-only cutoff compares
   * correctly against both and casts to midnight in Postgres.
   */
  assert.match(filters, /export function dayString/);
  assert.doesNotMatch(
    filters,
    /toISOString\(\)/,
    "an ISO instant as a cutoff is the comparison this module exists to avoid",
  );
});

test("a dangling site_id counts as unassigned, not as a site", async () => {
  const filters = codeOnly(await read("app/lib/dashboard-filters.ts"));
  const fn = filters.slice(filters.indexOf("export function unassignedSiteCondition"));
  /*
   * 80 of the development board's 111 live jobs point at `site-unassigned`,
   * which is not null, not empty, and has NO row in `sites`. Every screen that
   * resolved a name by lookup printed a blank, so the largest cluster of open
   * work rendered as an unlabelled row nobody could click.
   */
  assert.match(fn.slice(0, 600), /not exists/, "a correlated existence test");
  assert.doesNotMatch(
    fn.slice(0, 600),
    /not in \(select/i,
    "NOT IN over a nullable subquery returns NULL for every row in both dialects",
  );
  assert.match(fn.slice(0, 600), /organisationId, orgId/, "scoped to the caller's tenant");
});

test("every breakdown dimension can report what it does not know", async () => {
  const source = codeOnly(await read("app/lib/dashboard-aggregates.ts"));
  assert.match(source, /function appendNotRecorded/);
  assert.match(
    source,
    /if \(missing <= 0\) return;/,
    "a dimension with full coverage shows no grey bucket rather than a zero one",
  );
  assert.match(source, /notRecorded: true/);
});

/* ── 8. Breakpoints ───────────────────────────────────────────────────────── */

test("the operations stylesheet uses only the agreed widths", async () => {
  const css = await read("app/(app)/portal/ops/ops.css");
  const widths = [...css.matchAll(/\(min-width:\s*(\d+)px\)|\(max-width:\s*(\d+)px\)/g)].map(
    (match) => Number(match[1] ?? match[2]),
  );
  assert.ok(widths.length > 0, "the stylesheet is responsive");
  for (const width of widths) {
    assert.ok(
      [640, 767, 768, 1024, 1280].includes(width),
      `${width}px is not one of the agreed breakpoints — several stage tests fail on any other`,
    );
  }
});

test("the operations pages use the theme tokens, not the brief's literals", async () => {
  const css = await read("app/(app)/portal/ops/ops.css");
  /*
   * The briefs specify the dark palette by hex. This product already has that
   * palette under its own names, per theme, and writing the literals would pin
   * four pages to dark and leave them unreadable on the light theme — which is
   * a real setting with a real toggle.
   */
  for (const literal of ["#0B1620", "#16232E", "#1E2E3B", "#2A3B49", "#E8EEF2", "#8FA3B0"]) {
    assert.ok(
      !css.toLowerCase().includes(literal.toLowerCase()),
      `${literal} is a theme token's value, not a colour to type`,
    );
  }
  assert.match(css, /var\(--surface-card\)/);
  assert.match(css, /var\(--canvas\)/);
});

/* ── 9. Accessibility ─────────────────────────────────────────────────────── */

test("every meter carries its numbers in words", async () => {
  const primitives = await read("app/(app)/portal/ops/ops-primitives.tsx");
  assert.match(primitives, /role="img"/);
  assert.match(primitives, /aria-label=\{`\$\{label\}: \$\{readout\}`\}/);
  assert.match(primitives, /export function HiddenDataTable/);
  /*
   * The clip is on a WRAPPER, not on the table. `.visually-hidden` pins width
   * to 1px with overflow hidden, and a `display: table` box ignores it — the
   * hidden data table for eight contractors made the whole page 494px wide at a
   * 390px viewport. Measured, not theorised.
   */
  assert.match(
    primitives,
    /<div className="visually-hidden">\s*\n?\s*<table id=\{id\}>/,
    "the hidden table is wrapped in a block box that can actually clip it",
  );
});

test("each rebuilt page ships hidden data tables beside its charts", async () => {
  for (const file of [
    "app/(app)/portal/ops/overview-page.tsx",
    "app/(app)/portal/ops/compliance-page.tsx",
  ]) {
    const source = await read(file);
    assert.match(source, /<HiddenDataTable/, `${file} makes its charts readable`);
  }
});

/* ── 10. The contractor link flow ─────────────────────────────────────────── */

test("a zero is only printed where the record is linked", async () => {
  const list = codeOnly(await read("app/(app)/portal/ops/contractors-list.tsx"));
  assert.match(list, /row\.linked === false/, "the row asks whether the figures mean anything");
  assert.match(list, /Not linked/);
  const workspace = codeOnly(await read("app/api/workspace/route.ts"));
  assert.match(
    workspace,
    /linked: linkedContractors\.has\(contractor\.id\)/,
    "and the server is what decides it",
  );
});

test("one job-side name maps to at most one contractor", async () => {
  const init = await read("db/init.ts");
  assert.match(
    init,
    /CREATE UNIQUE INDEX IF NOT EXISTS contractor_name_aliases_unique_idx ON contractor_name_aliases \(organisation_id, normalised\)/,
    "a name two records claimed would double-count money",
  );
  const route = await read("app/api/contractors/[id]/aliases/route.ts");
  assert.match(route, /already linked to/, "a duplicate is answered in words, not by the driver");
  assert.match(
    route,
    /scopedDbWithCapability\(request, "sites.edit"\)/,
    "the same capability every other register write demands",
  );
  assert.match(
    route,
    /eq\(contractors\.organisationId, orgId\)/,
    "an id is an address, not a credential",
  );
});

test("reserved-TLD contacts are reported rather than rendered as reachable", async () => {
  /*
   * RE-POINTED. The predicate used to live in `site-metrics.ts` and was sliced
   * out of it by braces, because that module reaches drizzle and cannot be
   * imported. It has moved to `contact-links.ts` — the module that owns the
   * question "may this value become something a user can act on?", beside
   * `telHref` and `whatsappHref` — because the drawer needed the same answer in
   * the browser and could not reach a module that imports the schema.
   *
   * The slice is still a slice rather than an import: `contact-links.ts` is
   * loaded by suites that transpile it to a `data:` URL, and a `.ts` specifier
   * on it would break their rewrite. What the test asserts is unchanged, and
   * one assertion is added — that `site-metrics` DELEGATES, because two copies
   * of the pattern could accept an address the browser refuses to link.
   */
  const contact = await read("app/lib/contact-links.ts");
  const mailtoHref = new Function(
    `${contact.match(/export const RESERVED_EMAIL_TLD = [^;]+;/)[0].replace("export ", "")}
     ${
       /* `fnBody` strips a parameter type and a `: boolean` return type, which
          is all it has ever needed to. This one returns `string | null`, so the
          return annotation comes off here rather than by widening a helper
          eleven other tests depend on. */
       fnBody(contact, "mailtoHref").replace("): string | null {", ") {")
     }
     return mailtoHref;`,
  )();
  assert.equal(mailtoHref("ops@climate-response.example"), null);
  assert.equal(mailtoHref("ops@climate-response.test"), null);
  assert.equal(mailtoHref("ops@climate-response.INVALID"), null, "case must not smuggle one past");
  assert.equal(mailtoHref("ops@climate-response.co.uk"), "mailto:ops@climate-response.co.uk");
  assert.equal(mailtoHref(""), null);

  const source = await read("app/lib/site-metrics.ts");
  assert.match(
    source,
    /return mailtoHref\(email\) === null;/,
    "the server asks the same function the browser asks, not a second copy of the pattern",
  );
  const isPlaceholderManager = new Function(
    `${fnBody(source, "isPlaceholderManager")}; return isPlaceholderManager;`,
  )();
  assert.equal(isPlaceholderManager("Sample Manager F"), true);
  assert.equal(isPlaceholderManager("Samantha Manning"), false);
  assert.equal(isPlaceholderManager(null), false);

  // Both surfaces say the same words: the dense row, and the drawer somebody
  // opens to fix it.
  const list = codeOnly(await read("app/(app)/portal/ops/contractors-list.tsx"));
  assert.match(list, /No contact set/);
  const drawer = codeOnly(await read("app/(app)/portal/contractor-contact.tsx"));
  assert.match(drawer, /No contact set/);
  assert.doesNotMatch(
    drawer,
    /href=\{`mailto:\$\{email\}`\}/,
    "a placeholder address must never be offered as a mailto that bounces",
  );
});

test("a reserved-TLD contact is refused on create, and only on create", async () => {
  const route = codeOnly(await read("app/api/workspace/route.ts"));
  /*
   * RE-POINTED. The route declared its own `RESERVED_EMAIL_TLD` and this line
   * pinned that literal. It now imports the one in `contact-links.ts`, so the
   * address a create is refused for is exactly the address no screen will
   * render as a link. What is pinned is the same contract, at its new home.
   */
  assert.match(
    route,
    /import \{ RESERVED_EMAIL_TLD \} from "\.\.\/\.\.\/lib\/contact-links";/,
    "RFC 2606 and RFC 6761 reserve these, and one module says so",
  );
  assert.doesNotMatch(
    route,
    /const RESERVED_EMAIL_TLD = /,
    "a second declaration here could drift from the one the browser applies",
  );
  assert.match(
    route,
    /if \(intent === "create" && RESERVED_EMAIL_TLD\.test\(value\.toLowerCase\(\)\)\)/,
    "a new record may not be given an address that cannot receive mail, in any case",
  );
  assert.match(
    route,
    /contractorEmailRefusal\(data, "create"\)/,
    "and the create path is what asks for the stricter rule",
  );
  /*
   * NOT on edit, deliberately. Seven records on this estate already carry one,
   * and refusing it there would make them unsavable — somebody correcting a day
   * rate would be stopped by an address they had not touched. The screens show
   * those rows as "No contact set" with the edit beside them instead.
   */
  const editCalls = route.match(/contractorEmailRefusal\(data\)/g) ?? [];
  assert.equal(editCalls.length, 1, "the edit path keeps the rule it already had");
});

test("every chart element both cross-filters and drills through", async () => {
  /*
   * The brief asks for two actions on every segment, bar, tile and row, and for
   * the second to be reachable rather than hover-only — this page is mostly
   * read on a phone, where a hover does not exist.
   *
   * Tapping a bar CROSS-FILTERS: the bucket becomes a chip in the filter bar
   * and every card recomputes. The arrow beside it DRILLS THROUGH to the job
   * list with the same parameters, so the link is shareable and survives a
   * refresh.
   */
  const page = codeOnly(await read("app/(app)/portal/ops/overview-page.tsx"));
  assert.match(page, /className="ops-bar__drill"/, "the drill affordance is a real control");
  const drills = page.match(/className="ops-bar__drill"/g) ?? [];
  assert.ok(drills.length >= 3, "every bar and legend shape carries one");
  assert.match(
    page,
    /aria-label=\{`View the \$\{bucket\.value\} \$\{bucket\.label\} jobs`\}/,
    "and it names what it will show, not just an arrow",
  );
  assert.match(
    page,
    /onDrill=\{\(key, value\) => drill\(\{ \[key\]: value \}\)\}/,
    "drilling carries the page's own filter state across to the job list",
  );
  // And tapping the same bucket twice clears it, which is what makes exploring
  // reversible rather than a one-way door.
  assert.match(
    page,
    /existing\.includes\(value\)\s*\n?\s*\? existing\.filter\(\(entry\) => entry !== value\)/,
    "a second tap on a segment removes the filter it added",
  );
});


/* ── Nothing on a chart is decorative ─────────────────────────────────────── */

/*
 * THE ACCEPTANCE ITEM THIS FILE EXISTS TO HOLD.
 *
 * The brief's rule is "every segment, bar, tile and row is interactive", and
 * the shape a violation took every previous time was the same one: a `<div
 * className="ops-bar">` carrying `cursor: "default"`, drawn like a control and
 * doing nothing. Four of them shipped in the first cut — SLA by priority,
 * contractor spend, spend against budget, and the reactive/planned stack, which
 * was a `role="img"`. Pinning the ABSENCE of that shape is the only assertion
 * that catches the fifth.
 */
test("no chart element is drawn like a control and left inert", async () => {
  for (const name of ["overview-page.tsx", "compliance-page.tsx", "sites-list.tsx", "contractors-list.tsx"]) {
    const page = await read(`app/(app)/portal/ops/${name}`);
    assert.doesNotMatch(
      page,
      /cursor: "default"/,
      `${name}: a bar styled as inert is a bar the brief says must filter or drill`,
    );
  }

  const page = await read("app/(app)/portal/ops/overview-page.tsx");
  // The stacked trend was the last `role="img"`; its segments are buttons now.
  assert.doesNotMatch(
    page,
    /className="ops-series__stack"\s*\n\s*role="img"/,
    "the trend stack is made of buttons, not one labelled image",
  );
  for (const [what, pattern] of [
    ["SLA by priority", /onToggle\("priority", row\.key\)/],
    ["contractor spend", /onToggle\("contractor", row\.key\)/],
    ["spend against budget", /onToggle\("site", site\.siteId\)/],
    ["reactive vs planned", /onToggle\("nature", nature\)/],
  ]) {
    assert.match(page, pattern, `${what} cross-filters when it is tapped`);
  }
  for (const [what, pattern] of [
    ["SLA by priority", /onDrill\(\{ priority: row\.key, family: "completed" \}\)/],
    ["contractor spend", /onDrill\(\{ contractor: row\.key \}\)/],
    ["spend against budget", /onDrill\(\{ site: site\.siteId \}\)/],
    ["reactive vs planned", /period: "custom", from: bucket\.start, to: bucket\.endInclusive/],
  ]) {
    assert.match(page, pattern, `${what} also drills through to the jobs list`);
  }
});

test("a zero segment renders nothing, and a segment of one is still tappable", async () => {
  const page = await read("app/(app)/portal/ops/overview-page.tsx");
  /*
   * Height is the datum, so a bucket of 1 beside a bucket of 300 computes to
   * under a pixel. Two rules make that safe: no element at all for a zero, and
   * a floor for everything else. An invisible button that returns nothing is
   * worse than a gap, which is why the first rule is not simply the floor.
   */
  assert.match(
    page,
    /value === 0 \? null : \(/,
    "a bucket with none of that kind of work draws no segment to tap",
  );
  const css = await read("app/(app)/portal/ops/ops.css");
  assert.match(
    css,
    /\.ops-series__part \{[^}]*min-height: 6px;/,
    "and a non-zero segment keeps a floor height so it can be hit",
  );
});

/* ── Planned versus reactive is one rule, in one place ────────────────────── */

test("the chart and the filter cannot disagree about what planned means", async () => {
  const filters = codeOnly(await read("app/lib/dashboard-filters.ts"));
  const aggregates = codeOnly(await read("app/lib/dashboard-aggregates.ts"));

  assert.match(
    filters,
    /export const plannedCondition = sql`\(lower\(coalesce\(\$\{maintenanceRequests\.category\}/,
    "the inference lives beside the filter that has to honour it",
  );
  // The aggregate that DRAWS the bars must use that same expression, because
  // tapping a bar of 30 has to return 30 jobs.
  assert.match(aggregates, /const plannedSql = plannedCondition;/);
  assert.doesNotMatch(
    aggregates,
    /const plannedSql = sql`/,
    "a second copy of the rule would let the bar and the filtered page drift",
  );
  // Both selected is the same question as neither, and must not become
  // `planned AND reactive`, which returns nothing and reads as a broken filter.
  assert.match(filters, /if \(filters\.natures\.length === 1\) \{/);
});

test("the words are browser-safe and the SQL is not", async () => {
  /*
   * `job-metrics.ts` reaches nothing at runtime but `dashboard-meters`, so a
   * client component can import from it. `dashboard-filters.ts` reaches drizzle
   * and `db/schema`. Putting two label strings in the second would have pulled
   * the whole query builder into the browser bundle to render the word
   * "Planned".
   */
  // Ordered the way the stack is drawn bottom-up and the way the card's own
  // heading names them, so the legend cannot read backwards from the chart.
  assert.equal(metrics.NATURE_KEYS.join(","), "reactive,planned");
  assert.equal(metrics.NATURE_LABEL.planned, "Planned");
  assert.equal(metrics.NATURE_COLOUR.reactive, "#E8A33D");

  const page = await read("app/(app)/portal/ops/overview-page.tsx");
  assert.match(page, /NATURE_KEYS,\n\s*NATURE_LABEL,\n\s*NATURE_COLOUR,\n\s*type NatureKey,\n\} from "\.\.\/\.\.\/\.\.\/lib\/job-metrics";/);
  assert.doesNotMatch(
    page,
    /from "\.\.\/\.\.\/\.\.\/lib\/dashboard-filters"/,
    "a client component must never import the query builder",
  );
});

/* ── The contractor dimension carries both shapes ─────────────────────────── */

test("an unlinked contractor filters by name without colliding with an id", async () => {
  const filters = codeOnly(await read("app/lib/dashboard-filters.ts"));
  const aggregates = codeOnly(await read("app/lib/dashboard-aggregates.ts"));

  // 87% of this estate's costed work names a contractor with no record, so a
  // dimension that only accepted ids would leave most of the chart inert.
  assert.match(filters, /const ids = filters\.contractors\.filter\(\(value\) => !value\.startsWith\("name:"\)\)/);
  assert.match(
    filters,
    /\$\{maintenanceRequests\.contractorId\} is null and lower\(trim\(coalesce\(\$\{maintenanceRequests\.contractor\}/,
    "a name bucket also requires a null id, or a job carrying both is counted twice",
  );
  // The same key the aggregate grouped by, or the bar and the chip disagree.
  assert.match(aggregates, /const key = id \?\? `name:\$\{name\.toLowerCase\(\)\}`;/);
  assert.match(aggregates, /const value = id \?\? `name:\$\{name\.toLowerCase\(\)\}`;/);
});

test("the browser is not asked to do date arithmetic", async () => {
  /*
   * `to` is inclusive in this application's filters and `endExclusive` is not.
   * Computing the difference in the browser would put the one piece of date
   * maths this codebase centralises back on the client, in the client's
   * timezone. The server sends the day it already computed for the label.
   */
  const aggregates = codeOnly(await read("app/lib/dashboard-aggregates.ts"));
  assert.match(aggregates, /const endInclusive = shiftDay\(bucket\.endExclusive, -1\);/);
  assert.match(aggregates, /^\s*endInclusive,$/m);

  const page = await read("app/(app)/portal/ops/overview-page.tsx");
  assert.match(page, /onSelectWindow\(bucket\.start, bucket\.endInclusive\)/);
  assert.doesNotMatch(page, /setDate\(|864e5|86400000/, "no day arithmetic in the page");
});

test("the two new dimensions round-trip through the URL like every other one", async () => {
  const filters = codeOnly(await read("app/lib/dashboard-filters.ts"));
  for (const line of [
    /natures: readList\(params, "nature"\)/,
    /contractors: readList\(params, "contractor"\)/,
    /append\("nature", filters\.natures\);/,
    /append\("contractor", filters\.contractors\);/,
    /filters\.natures\.length \+/,
    /filters\.contractors\.length/,
  ]) {
    assert.match(filters, line);
  }

  // And the page owns the parameters, so `Clear all` clears them and a chip
  // appears for each — a filter with no chip is a filter a reader cannot undo.
  const page = await read("app/(app)/portal/ops/overview-page.tsx");
  assert.match(page, /"tier",\n\s*"nature",\n\s*"contractor",\n\] as const;/);
  assert.match(page, /key: "nature",\n\s*label: "Nature",/);
  assert.match(page, /\{ key: "contractor", label: "Contractor", options: data\.contractors, searchable: true \}/);
});
