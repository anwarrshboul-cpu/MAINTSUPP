/**
 * The three internal tabs, and the rules they must not break.
 *
 * Source pins, in this suite's usual style — see CLAUDE.md on why ~3,100 of
 * them exist. Each one below is protecting a stated requirement, and the
 * requirement is written into the assertion message so that a later refactor
 * knows what it is being asked to preserve rather than deleting a pin it cannot
 * interpret.
 *
 * The four things being defended:
 *
 *  1. THE TABS ARE INTERNAL. No new route, no sidebar item, no second Reports
 *     nav entry, no replacement design system. Everything the brief said to
 *     preserve is still on the page because nothing here removed it.
 *  2. NO SECOND PERIOD VOCABULARY. `period-model.ts`'s header is explicit that
 *     two controls on two screens must not mean two different things by "this
 *     period", so the eight presets the owner named are that module's tokens
 *     with the owner's labels on them.
 *  3. NO RENDERER COMPUTES MONEY. The preview walks `buildReportDocument()`,
 *     the same call the exporters make, which is what makes reconciliation
 *     structural instead of something to test and hope for.
 *  4. THE EXPORT ROUTE NEVER TAKES A FIGURE FROM THE BROWSER. A payload posted
 *     by a client would be a MAINTSUPP-branded invoice for any amount.
 *
 * Reads normalise CRLF: this is a Windows checkout and line endings here are
 * per file.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "./reports-ts-loader.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/**
 * The same file with its comments removed.
 *
 * Needed for the pins that assert something is ABSENT. These files explain at
 * length why they do not email, do not accept a payload from the browser and do
 * not re-filter a list the server narrowed — and a naive `!source.includes(...)`
 * then fails on the sentence describing the rule it is checking. That is not a
 * hypothetical: two of the assertions below failed exactly that way first time,
 * against code that was correct.
 *
 * Deliberately not a parser. It strips `/* … *​/` and `// …` and nothing else,
 * which is enough for these files and cannot silently pass by mangling code —
 * a mangled string here makes an assertion fail, not succeed.
 */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const TABS = "app/(app)/portal/reports/reports-tabs.tsx";
const CSS = "app/(app)/portal/reports/reports.css";
const GENERATOR = "app/(app)/portal/reports/invoice-generator.tsx";
const SETUP = "app/(app)/portal/reports/generator-setup.tsx";
const PREVIEW = "app/(app)/portal/reports/report-preview.tsx";
const DOCUMENTS = "app/(app)/portal/reports/generated-documents.tsx";
const CLIENT = "app/(app)/portal/reports/reports-client.ts";
const EXPORT_ROUTE = "app/api/reports/exports/route.ts";

/* ── 1. The tabs are internal ────────────────────────────────────────────── */

test("there are exactly three tabs, with the owner's labels", async () => {
  const source = await read(TABS);
  assert.match(source, /REPORT_TABS = \["overview", "generator", "documents"\] as const/);
  for (const label of ["Spend Overview", "Invoice & Report Generator", "Generated Documents"]) {
    assert.ok(source.includes(`label: "${label}"`), `the "${label}" tab is missing`);
  }
});

test("the tabs add no route, no sidebar item and no second Reports nav entry", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const sections = /export type Section =([\s\S]*?)\n\n/.exec(portal);
  assert.ok(sections, "the Section union must still be findable");
  for (const invented of ["reports-generator", "reports-documents", "invoices", "billing"]) {
    assert.ok(
      !sections[1].includes(`"${invented}"`),
      `"${invented}" was added to Section — the three tabs stay inside /dashboard/reports`,
    );
  }
  // And the tab module itself must not try to navigate anywhere.
  const source = await read(TABS);
  assert.ok(!source.includes("onNavigate"), "a tab switch is not a navigation");
  assert.ok(!/from "next\/(router|navigation)"/.test(source), "no router is involved");
});

test("the tab is remembered per section and linkable, and Back is not polluted", async () => {
  const source = await read(TABS);
  assert.match(source, /const TAB_NAMESPACE = "maintsupp:reports-tab:"/);
  assert.match(
    source,
    /window\.history\.replaceState/,
    "assigning location.hash pushes a history entry, so Back would walk the reader through every tab",
  );
  assert.ok(
    source.includes("window.location.hash"),
    "a pasted link to a tab must win over what the reader last looked at",
  );
});

test("Spend Overview keeps the storage key ReportsView already used", async () => {
  const source = await read(TABS);
  assert.match(
    source,
    /return tab === "overview" \? sectionKey : `\$\{sectionKey\}:\$\{tab\}`/,
    "renaming the overview's period key would lose every existing reader's remembered range",
  );
});

test("each tab opens on the window its question needs", async () => {
  const source = await read(TABS);
  assert.match(source, /REPORT_TAB_DEFAULT_PERIOD[\s\S]{0,160}overview: "12m"/);
  assert.match(source, /REPORT_TAB_DEFAULT_PERIOD[\s\S]{0,160}generator: "mtd"/);
});

test("the tablist is a real tablist", async () => {
  const source = await read(TABS);
  assert.match(source, /role="tablist"/);
  assert.match(source, /role="tab"/);
  assert.match(source, /role="tabpanel"/);
  assert.match(source, /aria-controls=\{`reports-panel-\$\{definition\.id\}`\}/);
  assert.match(source, /aria-selected=\{selected\}/);
  assert.match(source, /tabIndex=\{selected \? 0 : -1\}/, "roving tabindex");
  assert.match(source, /event\.key === "ArrowRight"/);
  assert.match(source, /event\.key === "ArrowLeft"/);
});

/* ── 2. One period vocabulary ────────────────────────────────────────────── */

test("the eight presets are period-model's tokens with the owner's labels", async () => {
  const source = await read(SETUP);
  const expected = [
    ["today", "Today"],
    ["week", "This Week"],
    ["mtd", "This Month"],
    ["month-1", "Last Month"],
    ["quarter", "This Quarter"],
    ["ytd", "This Year"],
    ["12m", "Last 12 Months"],
    ["range", "Custom Range"],
  ];
  for (const [value, label] of expected) {
    assert.ok(
      source.includes(`{ value: "${value}", label: "${label}" }`),
      `the "${label}" preset must resolve through period-model's "${value}" token`,
    );
  }
  // The vocabulary is imported, never restated.
  assert.match(source, /import \{ rangeToken, resolvePeriod \} from "\.\.\/period-model"/);
  assert.match(source, /import \{ isoDay \} from "\.\.\/period-picker"/);
  assert.ok(
    !/function resolvePeriod|const PERIODS =|startOfMonth\(/.test(source),
    "a second period implementation is exactly what period-model.ts exists to prevent",
  );
});

test("a rolling window is clamped so an invoice cannot claim to cover tomorrow", async () => {
  const source = await read(SETUP);
  assert.match(
    source,
    /periodEnd: isoDay\(Math\.min\(next\.end, now\)\)/,
    "analyticsWindow leaves a rolling end a day out by design; an invoice must not inherit that",
  );
});

test("VAT crosses the boundary as basis points, never as a float", async () => {
  const source = await read(SETUP);
  assert.match(source, /export function percentToBasisPoints/);
  assert.match(source, /Math\.round\(parsed \* 100\)/);
  const generator = await read(GENERATOR);
  assert.match(generator, /vatRateBasisPoints: percentToBasisPoints\(draft\.vatRatePercent\)/);
});

/* ── 3. No renderer computes money ───────────────────────────────────────── */

test("the preview renders the same derivation the exporters do", async () => {
  const source = await read(PREVIEW);
  assert.match(
    source,
    /import \{\s*buildReportDocument,\s*keyValuesFor,\s*sectionsFor,\s*\} from "\.\.\/\.\.\/\.\.\/lib\/exports\/document-model"/,
    "the preview must walk the SAME sections the .docx, .pdf and .xlsx walk",
  );
  assert.ok(
    !/reduce\(|\.toFixed\(|\* 100|\/ 100/.test(source),
    "the preview must not compute a figure — if it can, it can disagree with the files",
  );
  assert.ok(!/fetch\(/.test(source), "a renderer never has a data source of its own");
});

test("the generator prints the payload's figures and derives none of them", async () => {
  const source = await read(GENERATOR);
  assert.match(source, /invoiceKpiRows,\s*\n\s*maintenanceKpiRows,/);
  assert.ok(
    !/\.reduce\(\(sum/.test(source),
    "a re-summed column is how a screen ends up disagreeing with its own export",
  );
  assert.match(
    source,
    /const totals = payload\.invoice\.totals/,
    "the totals row is the payload's totals, not a sum of the rows above it",
  );
});

test("the five expenditure figures stay apart and are labelled as the owner wrote them", async () => {
  const model = await read("app/lib/exports/document-model.ts");
  for (const label of [
    "MAINTSUPP Service Fee",
    "Completed Maintenance Expenditure",
    "Open or Committed Maintenance Cost",
    "Project Expenditure",
    "Routine Maintenance Expenditure",
  ]) {
    assert.ok(model.includes(`"${label}"`), `the label "${label}" is required verbatim`);
  }
  const generator = await read(GENERATOR);
  assert.match(
    generator,
    /not additive/,
    "the invoice total must never be presented as maintenance expenditure",
  );
  // Spend Analysis deliberately has no totals row.
  assert.match(
    model,
    /No totals row, on purpose[\s\S]{0,220}table: \{ columns, rows, totals: null \}/,
    "a total across the five would read as combined expenditure and mean nothing",
  );
});

test("a null SLA percentage is a dash and never a nought", async () => {
  const { formatPercent } = await import("../app/lib/exports/format.ts");
  assert.equal(formatPercent(null), "—");
  assert.equal(formatPercent(undefined), "—");
  assert.equal(formatPercent(0), "0%");
  assert.equal(formatPercent(80), "80%");
  assert.equal(formatPercent(94.25), "94.3%");
});

/* ── 4. The export route ─────────────────────────────────────────────────── */

test("the export route never takes a payload from the browser", async () => {
  const source = await read(EXPORT_ROUTE);
  const code = codeOnly(source);
  /*
   * `body` in this route is the REQUEST body — the only object a caller
   * controls. The two responses it reads back from the workspace's own
   * endpoints are called `answer`, so that this pin can distinguish them; a
   * `body.payload` here would be the route rendering something the browser
   * sent.
   */
  assert.ok(
    !/\bbody\["payload"\]|\bbody\.payload\b/.test(code),
    "a client-supplied payload is a MAINTSUPP-branded invoice for any amount",
  );
  assert.equal(
    (code.match(/const answer = \(await response\.json\(\)\)/g) ?? []).length,
    2,
    "both workspace responses must be named `answer`, or the pin above cannot tell them apart",
  );
  assert.match(
    source,
    /readDocumentPayload|readPreviewPayload/,
    "the only two payload sources are the workspace's own endpoints",
  );
  assert.match(
    source,
    /\/api\/reports\/documents\/\$\{encodeURIComponent\(documentId\)\}/,
    "a finalised export must come from the stored snapshot, which that endpoint owns",
  );
});

test("the export route holds data.export and records who took a copy", async () => {
  const source = await read(EXPORT_ROUTE);
  const checks = source.match(/scopedDbWithCapability\(request, "data\.export"\)/g) ?? [];
  assert.equal(checks.length, 2, "both GET and POST must hold the capability");
  assert.match(source, /action: "report\.exported"/);
  assert.match(source, /await recordAudit\(/);
  assert.match(
    source,
    /recordExportHistory\(scope, \{/,
    "the Formats column of the Generated Documents screen comes from this",
  );
  // No delivery of any kind.
  assert.ok(
    !/sendMail|nodemailer|smtp|webhook|slack/i.test(codeOnly(source)),
    "store and download only — there is no automatic emailing, sharing or delivery",
  );
});

test("all three formats go through one renderer table and get nothing but the payload", async () => {
  const source = await read(EXPORT_ROUTE);
  assert.match(
    source,
    /const RENDERERS: Record<\s*ExportFormat,\s*\{ render: \(payload: CombinedReportPayload\) => Uint8Array; contentType: string \}\s*> = \{/,
    "the signature is the contract's central rule: a renderer cannot ask a different question",
  );
  assert.match(source, /docx: \{ render: renderDocx/);
  assert.match(source, /pdf: \{ render: renderPdf/);
  assert.match(source, /xlsx: \{ render: renderXlsx/);
  assert.match(source, /filename = exportFilename\(\{/, "naming is the contract's, not the route's");
});

test("a refusal from the document endpoint is passed through, not turned into a 503", async () => {
  const source = await read(EXPORT_ROUTE);
  assert.match(
    source,
    /a 403 for a\s*\n\s*\/\/ draft a Viewer may not see must stay a 403/,
    "swallowing the status would tell a Viewer the workspace is broken",
  );
});

/* ── Permissions on screen ───────────────────────────────────────────────── */

test("controls are gated on the same three-valued capability read the product uses", async () => {
  for (const file of [GENERATOR, DOCUMENTS]) {
    const source = await read(file);
    assert.match(
      source,
      /import \{ useCapability \} from "\.\.\/\.\.\/\.\.\/lib\/client-capabilities"/,
      `${file} must read capabilities from the shared cache, not invent its own`,
    );
  }
  const generator = await read(GENERATOR);
  assert.match(generator, /canSettle === false/, "approve, finalise and void need settings.edit");
  assert.match(generator, /canExport === false/, "the export controls need data.export");
  assert.match(generator, /canEdit === false/, "editing needs board.edit");
});

test("the documents table does not re-filter what the server already narrowed", async () => {
  const source = await read(DOCUMENTS);
  assert.match(
    source,
    /narrows a caller without[\s\S]{0,40}board\.edit[\s\S]{0,80}Finalised[\s\S]{0,40}in the QUERY/,
    "a second, weaker copy of the rule is the copy somebody would see round",
  );
  /*
   * The word "Finalised" does appear in this file — as an `<option>` in the
   * status filter a reader chooses, and in the chip's colour lookup. Neither is
   * a narrowing. What must not appear is a FILTER of the rows on it, because
   * that would be the server's rule re-implemented in a place a person can see
   * round.
   */
  const code = codeOnly(source);
  assert.ok(
    !/\.filter\([^)]*status/.test(code.replace(/statusFilter === "all"[\s\S]{0,120}?\)\)/, "")),
    "the finals-only rule is the server's, in its query, and not this component's",
  );
  assert.match(
    code,
    /statusFilter === "all"/,
    "the only filtering here is the status control the reader operates",
  );
});

test("an exclusion needs a reason before it is even attempted", async () => {
  const generator = await read(GENERATOR);
  assert.match(
    generator,
    /if \(!typed\.trim\(\)\)[\s\S]{0,120}An exclusion needs a reason\./,
    "an exclusion with no reason must not even be sent",
  );
  assert.match(
    generator,
    /an exclusion is an audited change and needs a document to attach to/,
    "an unsaved draft has nothing for the audit row to reference",
  );
  const client = await read(CLIENT);
  // The comment wraps mid-phrase, so the newline and the ` * ` prefix are part
  // of what is being matched. A pin against prose has to allow for that.
  assert.match(client, /the check that matters is the[\s\S]{0,8}server/);
});

/* ── CSS ─────────────────────────────────────────────────────────────────── */

test("the stylesheet uses only the agreed breakpoints", async () => {
  const source = await read(CSS);
  const widths = [...source.matchAll(/@media \(max-width: (\d+)px\)/g)].map((match) => match[1]);
  assert.ok(widths.length > 0, "there must be responsive rules");
  const allowed = new Set(["640", "767", "768", "1024", "1280"]);
  for (const width of widths) {
    assert.ok(allowed.has(width), `${width}px is not one of 640/767/768/1024/1280 — see CLAUDE.md`);
  }
  assert.ok(!/@media \(min-width/.test(source), "this sheet is written max-width down");
});

test("nothing but the table containers may scroll sideways", async () => {
  const source = await read(CSS);
  const rules = [...source.matchAll(/([^}]*)\{([^}]*overflow-x: auto[^}]*)\}/g)].map((match) =>
    match[1].trim().split("\n").pop().trim(),
  );
  for (const selector of rules) {
    assert.ok(
      selector === ".reports-table-scroll" || selector === ".reports-tabs",
      `${selector} must not scroll horizontally — only the table container and the tablist may`,
    );
  }
  assert.match(source, /\.reports-table-scroll \{[\s\S]*?overflow-x: auto/);
  assert.match(source, /min-width: 0/, "a grid track without it pushes the page out");
});

test("every wide table is inside the scroll container and labelled for a keyboard", async () => {
  for (const file of [GENERATOR, DOCUMENTS, PREVIEW]) {
    const source = await read(file);
    const tables = (source.match(/<table/g) ?? []).length;
    const scrollers = (source.match(/className="reports-table-scroll"/g) ?? []).length;
    assert.equal(
      tables,
      scrollers,
      `${file}: every <table> needs its own overflow-x container`,
    );
    assert.ok(
      source.includes('tabIndex={0} role="region"'),
      `${file}: a region that scrolls must be reachable without a pointer`,
    );
  }
});

test("the styling reuses the analytics surfaces rather than forking them", async () => {
  const source = await read(CSS);
  /*
   * RE-POINTED, NOT WEAKENED. This test used to pin the two LITERALS the
   * analytics panels use — `#263d48` and
   * `linear-gradient(145deg, #14242d, #101b23)` — on the premise that those
   * panels are dark in both themes. They are not: `body[data-theme="light"]
   * :is(.metric-card, .analytics-panel, …)` in brand-overrides.css repaints
   * them, and `.reports-card` was never added to that list. Pinning the
   * literals therefore pinned this screen to a fork it could not follow the
   * theme out of — a dark bar and a dark card on a light page, with the
   * section heading at 1.4:1 on top of it.
   *
   * The contract was always "this screen does not fork the analytics surface".
   * Its new home is the TOKENS that surface is built from, so the assertion
   * moves there and gets stricter, not looser: the same gradient, expressed as
   * `--surface-card-hi` -> `--surface-card-lo` (which IS #14242d -> #101b23 in
   * dark, so dark is unchanged), the product's hairline token, and — the part
   * that actually stops a fork — no colour literal anywhere in a DECLARATION.
   */
  assert.match(
    source,
    /background: linear-gradient\(145deg, var\(--surface-card-hi\), var\(--surface-card-lo\)\);/,
    "the analytics card gradient, from the tokens the analytics card is built from",
  );
  assert.match(source, /border: 1px solid var\(--line\);/, "the product's hairline");
  // Comments carry measurements and named colours on purpose; declarations may
  // not. Strip the comments, then look for a literal on the left of a `:`.
  const declarations = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const literals = declarations.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(
    literals,
    [],
    `a colour literal in a declaration cannot follow the theme: ${literals.join(", ")}`,
  );
  /*
   * `rgba()` is allowed exactly twice, and only on the local token declared at
   * the head of the sheet. See the comment there: a low-alpha wash of the
   * OPPOSITE ink is a relationship rather than a colour, so it has no token in
   * globals.css and is declared once per theme instead of eight times inline.
   */
  const alphas = declarations.match(/rgba\(/g) ?? [];
  assert.equal(alphas.length, 2, "only --reports-inset may declare an rgba(), once per theme");
  assert.match(
    declarations,
    /:root:not\(\[data-theme="light"\]\),\s*\nbody\[data-theme="dark"\] \{\s*\n\s*--reports-inset:/,
    "the local token names BOTH selectors globals.css names — data-theme is stamped on html AND body",
  );
  const generator = await read(GENERATOR);
  assert.match(
    generator,
    /import \{ AnalyticsMetricCard \} from "\.\.\/dashboard-analytics"/,
    "the KPI tile is the product's tile",
  );
});

/*
 * A form field's COLOUR belongs to the product; its EDGE belongs to this sheet.
 *
 * Tailwind's preflight sets `border-width: 0` on every element, and both rules
 * that paint fields in this product (`.portal-shell input:not()…:not()` and the
 * light skin's equivalent) set only `border-color`. So a `.reports-field` block
 * that drops the width leaves every field at 0px — invisible in light, where a
 * white field sits on a white card with nothing drawing its edge. Measured
 * that way once already, on "Internal reference".
 */
test("a form field keeps its edge even though it does not keep its colour", async () => {
  const source = await read(CSS);
  const block = source.match(
    /\.reports-field :is\(input, select, textarea\) \{[\s\S]*?\}/,
  );
  assert.ok(block, "the field geometry block must exist");
  assert.match(block[0], /border-width: 1px;/, "preflight zeroes this; it has to be restated");
  assert.match(block[0], /border-style: solid;/);
  assert.ok(
    !/\n\s*(background|color):/.test(block[0]),
    "the ground and the ink are the product's, not this screen's — a second copy only drifts",
  );
});

/*
 * The defect the owner reported, pinned so it cannot come back.
 *
 * `body[data-theme="dark"] { .portal-main button { color: var(--control-own-fg,
 * var(--ink)) } }` in globals.css outranks every selector in reports.css, so a
 * button here that paints its own foreground and does NOT declare
 * `--control-own-fg` is repainted `--ink` in dark. Measured before the fix: the
 * selected tab and the two unselected tabs all came out rgb(231, 238, 243) —
 * the active tab was not distinguishable by colour at all.
 */
test("every control that paints its own foreground declares the opt-out", async () => {
  const source = await read(CSS);
  const rules = source.split("}");
  const offenders = [];
  for (const rule of rules) {
    const selector = rule.split("{")[0]?.trim().split("\n").pop()?.trim() ?? "";
    /*
     * Selectors that land ON a <button>. `.reports-alert--ok` and friends are
     * deliberately NOT in this list: they are <p> elements that set the tone
     * the dismiss control then inherits, and `.reports-alert button` carries
     * `--control-own-fg: inherit` so that inheritance survives the dark skin.
     */
    const isButton =
      /\.reports-(tabs__tab|button|linkish)\b/.test(selector) ||
      /\bbutton\b/.test(selector);
    if (!isButton) continue;
    // Only rules that set a foreground have anything to opt out of.
    if (!/\n\s*color:/.test(rule)) continue;
    if (!rule.includes("--control-own-fg:")) offenders.push(selector);
  }
  assert.deepEqual(
    offenders,
    [],
    `these paint a button label the dark skin will overwrite: ${offenders.join(" | ")}`,
  );
});

test("no new CSS was put into globals.css", async () => {
  const globals = await read("app/globals.css");
  assert.ok(
    !globals.includes("reports-tabs") && !globals.includes("reports-generator"),
    "new CSS belongs in the view's own file, never in globals.css",
  );
});

/* ── The live route, when a dev server is answering ──────────────────────── */

const ORIGIN = process.env.PORTAL_ORIGIN ?? "http://localhost:5173";

async function serverAnswers() {
  try {
    const response = await fetch(`${ORIGIN}/api/context`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

test("the export route is mounted and refuses an unknown format", async (t) => {
  if (!(await serverAnswers())) {
    t.skip(`no dev server on ${ORIGIN}`);
    return;
  }
  const response = await fetch(`${ORIGIN}/api/reports/exports?format=exe&documentId=x`, {
    headers: { accept: "application/json" },
  });
  assert.notEqual(response.status, 404, "the route must exist");
  assert.ok(
    [400, 401, 403, 503].includes(response.status),
    `an unknown format must be refused, not served (got ${response.status})`,
  );
  const body = await response.json().catch(() => ({}));
  assert.ok(typeof body.error === "string", "every refusal here carries { error }");
});

/**
 * The one that matters.
 *
 * The route is ALLOWED to answer 200 with a real document here — a caller with
 * `data.export` asking for a period is entitled to one, and that is what the
 * generator's export buttons do before a draft is saved. What it must never do
 * is put a figure the CALLER supplied into it. So the assertion is not on the
 * status, it is on the bytes: a fabricated £999,999.99 must be nowhere in the
 * file, and the figures that ARE in it must have come from the engine.
 *
 * Asserting `status !== 200` here would have been the easy version and the
 * wrong one; it failed against a route that was behaving correctly.
 */
test("a payload posted by the caller cannot put a figure in a document", async (t) => {
  if (!(await serverAnswers())) {
    t.skip(`no dev server on ${ORIGIN}`);
    return;
  }
  const fabricated = 999_999_99;
  const response = await fetch(`${ORIGIN}/api/reports/exports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      format: "pdf",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      preset: "month-1",
      // Must be ignored, not rendered.
      payload: {
        invoice: {
          clientName: "ATTACKER PLC",
          invoiceNumber: "FAKE-0001",
          totals: { totalPence: fabricated, subtotalPence: fabricated },
        },
      },
      invoice: { totals: { totalPence: fabricated } },
      totals: { totalPence: fabricated },
    }),
  });

  if (response.status !== 200) {
    // A refusal is also a correct outcome (no session, no capability, no data).
    assert.ok(
      [400, 401, 403, 503].includes(response.status),
      `an unexpected status ${response.status}`,
    );
    return;
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("latin1");
  assert.ok(text.startsWith("%PDF-1."), "a 200 from here must be a real PDF");
  assert.ok(
    !text.includes("9,999,999.99"),
    "the caller's invented total reached the document",
  );
  assert.ok(!text.includes("ATTACKER PLC"), "the caller's invented client name reached the document");
  assert.ok(!text.includes("FAKE-0001"), "the caller's invented invoice number reached the document");
  assert.ok(
    !(response.headers.get("content-disposition") ?? "").includes("ATTACKER"),
    "the filename is built from the payload the SERVER computed",
  );
});

test("all three formats come back as the file they claim to be", async (t) => {
  if (!(await serverAnswers())) {
    t.skip(`no dev server on ${ORIGIN}`);
    return;
  }
  const { readStoredZip } = await import("../app/lib/exports/zip.ts");
  const expected = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pdf: "application/pdf",
  };
  const totals = new Map();

  for (const [format, contentType] of Object.entries(expected)) {
    const response = await fetch(`${ORIGIN}/api/reports/exports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format,
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        preset: "month-1",
      }),
    });
    if (response.status !== 200) {
      t.diagnostic(`${format}: ${response.status} — the engine refused, nothing to check`);
      continue;
    }
    assert.equal(response.headers.get("content-type"), contentType);
    assert.match(
      response.headers.get("content-disposition") ?? "",
      new RegExp(`attachment; filename="MAINTSUPP_[A-Za-z0-9_.-]+\\.${format}"`),
      "the filename must come from exportFilename and be ASCII-safe",
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length > 1000, `${format} came back suspiciously small`);

    if (format === "pdf") {
      const text = Buffer.from(bytes).toString("latin1");
      assert.ok(text.startsWith("%PDF-1."));
      assert.ok(text.trimEnd().endsWith("%%EOF"));
      totals.set("pdf", /Total payable\) Tj[\s\S]{0,400}?\((£[\d,]+\.\d\d)\) Tj/.exec(text)?.[1]);
    } else {
      // Both OOXML formats must be openable ZIPs with the parts that matter.
      const parts = readStoredZip(bytes);
      assert.ok(parts.has("[Content_Types].xml"), `${format} is not an OOXML package`);
      assert.ok(
        parts.has(format === "docx" ? "word/document.xml" : "xl/workbook.xml"),
        `${format} is missing its main part`,
      );
      if (format === "docx") {
        const document = new TextDecoder().decode(parts.get("word/document.xml"));
        totals.set("docx", /Total payable[\s\S]{0,600}?>(£[\d,]+\.\d\d)</.exec(document)?.[1]);
      }
    }
  }

  // Whatever the live estate happens to bill, the two formats must agree on it.
  if (totals.get("pdf") && totals.get("docx")) {
    assert.equal(
      totals.get("docx"),
      totals.get("pdf"),
      "the Word file and the PDF disagree about the total payable",
    );
  }
});
