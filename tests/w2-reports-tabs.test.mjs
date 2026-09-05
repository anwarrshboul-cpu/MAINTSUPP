/**
 * The four internal tabs, and the rules they must not break.
 *
 * Four, not three: the combined "Invoice & Report Generator" was split into a
 * Report tab and an Invoice tab, so that the maintenance report a client reads
 * and the bill they pay are different documents with different filenames and
 * neither can be sent by mistake for the other. Several pins below moved with
 * that split; each says where it moved and why, per CLAUDE.md.
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
/*
 * RE-POINTED, NOT WEAKENED — the generator became three files.
 *
 * `invoice-generator.tsx` was one 1,042-line component drawing both parts of
 * the combined document. It is now the SHARED CORE — the document state, save,
 * the lifecycle actions, the inclusion changes, the export call and the
 * data-issues panel — with the action bar in `generator-actions.tsx` and the
 * two screens over it in `report-tab.tsx` (part 2) and `invoice-tab.tsx`
 * (part 1). Each pin below that used to read GENERATOR now reads whichever of
 * the four actually owns the contract it was protecting, and says so where it
 * moved. Nothing was dropped, and the separation itself is pinned further down.
 */
const GENERATOR = "app/(app)/portal/reports/invoice-generator.tsx";
const ACTIONS = "app/(app)/portal/reports/generator-actions.tsx";
const REPORT_TAB = "app/(app)/portal/reports/report-tab.tsx";
const INVOICE_TAB = "app/(app)/portal/reports/invoice-tab.tsx";
const SETUP = "app/(app)/portal/reports/generator-setup.tsx";
const PREVIEW = "app/(app)/portal/reports/report-preview.tsx";
const DOCUMENTS = "app/(app)/portal/reports/generated-documents.tsx";
const CLIENT = "app/(app)/portal/reports/reports-client.ts";
const EXPORT_ROUTE = "app/api/reports/exports/route.ts";

/* ── 1. The tabs are internal ────────────────────────────────────────────── */

/*
 * RE-POINTED, NOT WEAKENED. This pinned three tabs including a combined
 * "Invoice & Report Generator". The owner split that tab in two — Report is the
 * maintenance half, Invoice is the billing half — so the pin follows the
 * decision rather than blocking it, and gets STRICTER on the thing that
 * actually matters now: the two new ids exist, in the owner's order, and the
 * retired id is genuinely gone from the list rather than hidden in it.
 */
test("there are exactly four tabs, with the owner's labels", async () => {
  const source = await read(TABS);
  assert.match(source, /REPORT_TABS = \["overview", "report", "invoice", "documents"\] as const/);
  for (const label of ["Spend Overview", "Report", "Invoice", "Documents"]) {
    assert.ok(source.includes(`label: "${label}"`), `the "${label}" tab is missing`);
  }
  assert.ok(
    !/id: "generator"/.test(source),
    "the combined generator tab is gone, not hidden — see report-tab.tsx and invoice-tab.tsx",
  );
  // Every tab carries a hint, because the tablist is the only place the
  // difference between "Spend Overview" and "Report" is explained.
  const hints = source.match(/hint: "/g) ?? [];
  assert.equal(hints.length, 4, "each of the four tabs needs a hint of its own");
});

/*
 * The migration of a REMEMBERED tab.
 *
 * "generator" is in the localStorage of every reader who used it and in the
 * hash of every link they pasted. Without a re-point, `isReportTab` rejects it,
 * the read falls through to the default and somebody who left the product on
 * the generator comes back to Spend Overview — or follows their own bookmarked
 * `#generator` to it.
 */
test("a stored or linked 'generator' tab still lands somewhere sensible", async () => {
  const source = await read(TABS);
  assert.match(
    source,
    /const RETIRED_TABS: Record<string, ReportTab> = \{\s*\n\s*generator: "report",/,
    "a retired tab id must be re-pointed, not dropped on the floor",
  );
  assert.match(
    source,
    /function resolveTab\(value: unknown\): ReportTab \| null/,
    "one resolver, used for both the hash and the stored value",
  );
  const code = codeOnly(source);
  assert.ok(
    !/if \(isReportTab\(fromHash\)\) return fromHash/.test(code),
    "the hash must go through resolveTab, or a bookmarked #generator lands on Spend Overview",
  );
  assert.equal(
    (code.match(/resolveTab\(/g) ?? []).length,
    3,
    "the declaration plus both reads — the hash and localStorage",
  );
});

/* A document opens on the tab that matches what it is. */
test("opening a document from the register lands on a tab, and says why that one", async () => {
  const source = await read(TABS);
  assert.match(
    source,
    /export function tabForDocumentKind\(kind: DocumentKind \| null \| undefined\): ReportTab \{\s*\n\s*return kind === "invoice" \? "invoice" : "report";/,
    "the landing tab is a property of the document, not of the caller",
  );
  assert.match(
    source,
    /undefined for every row in the register today/,
    "the fallback to Report must state that no stored row carries a kind yet",
  );
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(
    portal,
    /setReportTab\(tabForDocumentKind\(kind\)\)/,
    "portal-app must not re-decide where a document opens",
  );
  const documents = await read(DOCUMENTS);
  assert.match(
    documents,
    /onOpenDocument\(row\.invoiceId, row\.kind\)/,
    "the row's kind travels with the id, so the caller can route on it",
  );
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

/*
 * RE-POINTED, NOT WEAKENED. The generator's "mtd" default is now claimed by
 * BOTH halves of it: a report is a month and an invoice is a month, and the
 * split changed neither. Overview's "12m" is untouched, which is the half of
 * this pin that was always the load-bearing one.
 */
test("each tab opens on the window its question needs", async () => {
  const source = await read(TABS);
  assert.match(source, /REPORT_TAB_DEFAULT_PERIOD[\s\S]{0,200}overview: "12m"/);
  assert.match(source, /REPORT_TAB_DEFAULT_PERIOD[\s\S]{0,200}report: "mtd"/);
  assert.match(source, /REPORT_TAB_DEFAULT_PERIOD[\s\S]{0,200}invoice: "mtd"/);
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

/*
 * RE-POINTED, NOT WEAKENED — and this one got stricter as a result.
 *
 * The pin used to require both KPI builders to be imported by the one combined
 * generator. They now live on opposite tabs, so requiring them together would
 * be requiring the separation NOT to have happened. What the pin was really
 * defending is "no screen derives a figure", and that now has to hold on three
 * files instead of one — so it is asserted on three, plus the new assertion
 * that neither tab imports the other half's builder.
 */
test("the generator screens print the payload's figures and derive none of them", async () => {
  const report = await read(REPORT_TAB);
  const invoice = await read(INVOICE_TAB);
  const shared = await read(GENERATOR);

  assert.match(report, /import \{ maintenanceKpiRows, SPEND_LABELS \}/);
  assert.match(invoice, /import \{ invoiceKpiRows \}/);
  assert.ok(
    !/invoiceKpiRows/.test(report),
    "an invoice figure on the maintenance report is the thing the split removed",
  );
  assert.ok(
    !/maintenanceKpiRows/.test(invoice),
    "a job count on the invoice is the thing the split removed",
  );

  for (const [file, source] of [
    [REPORT_TAB, report],
    [INVOICE_TAB, invoice],
    [GENERATOR, shared],
  ]) {
    assert.ok(
      !/\.reduce\(\(sum/.test(source),
      `${file}: a re-summed column is how a screen ends up disagreeing with its own export`,
    );
  }

  assert.match(
    invoice,
    /const totals = payload\.invoice\.totals/,
    "the totals row is the payload's totals, not a sum of the rows above it",
  );
});

/*
 * THE SEPARATION ITSELF, which is the whole point of the two tabs.
 *
 * Not a style pin. The owner's rule is that the MAINTSUPP service fee must
 * never read as maintenance expenditure, and the combined screen printed the
 * invoice total on the same page as the maintenance spend. Two tabs only fix
 * that if each really carries one part — so this asserts on the CONTENT, in
 * both directions, and on the `kind` each tab hands to the preview and the
 * exporter.
 */
test("the Report tab carries no invoice content and the Invoice tab no report content", async () => {
  const report = await read(REPORT_TAB);
  const invoice = await read(INVOICE_TAB);

  // The billable-sites table and its totals are part 1 only.
  assert.match(report, /<table/, "the Report tab still draws its own drill-down table");
  assert.ok(
    !/BillableSitesTable|invoice\.totals|vatRateBasisPoints/.test(report),
    "the Report tab must not draw a charge line, a VAT rate or an invoice total",
  );
  // The job log, SLA and holds are part 2 only.
  assert.ok(
    !/jobLog|maintenance\.sla|openPastTarget|criticalOpen/.test(invoice),
    "the Invoice tab must not draw a job log, an SLA table or a hold",
  );

  assert.match(report, /kind="report"/, "the Report tab previews and exports part 2");
  assert.match(invoice, /kind="invoice"/, "the Invoice tab previews and exports part 1");
  assert.equal(
    (report.match(/kind="invoice"/g) ?? []).length,
    0,
    "nothing on the Report tab may ask for an invoice document",
  );
  assert.equal(
    (invoice.match(/kind="report"/g) ?? []).length,
    0,
    "nothing on the Invoice tab may ask for a report document",
  );
});

/*
 * NO HIDDEN LEGACY GENERATOR. The brief forbids one explicitly: a combined
 * component nobody opens is a third rendering of the same figures, and it goes
 * stale without anybody noticing.
 */
test("the combined generator is gone rather than left behind", async () => {
  const shared = await read(GENERATOR);
  assert.ok(
    !/export function InvoiceReportGenerator/.test(shared),
    "the combined component must not survive the split",
  );
  assert.match(
    shared,
    /export function useGeneratorDocument/,
    "what survives is the shared state, mounted once above both tabs",
  );
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.ok(
    !/InvoiceReportGenerator/.test(portal),
    "nothing may still render the combined generator",
  );
  assert.match(
    portal,
    /const generator = useGeneratorDocument\(\{/,
    "one hook above both tabs, or a saved draft is lost on every tab switch",
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
  /*
   * RE-POINTED, NOT WEAKENED. "not additive" was in the combined generator; the
   * five figures are part 2 content and now live on the Report tab, which is
   * where the sentence has to be. The rule is unchanged and the pin follows it
   * — and it gains the other half of the same rule, that the Invoice tab does
   * not restate the service fee beside the invoice total.
   */
  const reportTab = await read(REPORT_TAB);
  assert.match(
    reportTab,
    /not additive/,
    "the invoice total must never be presented as maintenance expenditure",
  );
  const invoiceTab = await read(INVOICE_TAB);
  assert.ok(
    !/SPEND_LABELS/.test(invoiceTab),
    "the five expenditure figures belong to the report; restating them beside the invoice total is the confusion this rule exists to prevent",
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

/*
 * RE-POINTED, NOT WEAKENED — the signature gained one argument and the pin
 * gained an assertion.
 *
 * The rule this defends is "a renderer physically cannot ask a different
 * question than the other two", expressed as all three having the SAME
 * signature and being handed nothing but the payload. `DocumentKind` joined
 * that signature when the screen split into a Report tab and an Invoice tab. It
 * is not a second question: it selects sections from the one payload through
 * `sectionsFor`, the same gate all three walk. So the pin now requires the kind
 * to be on all three — a renderer that took it while the others did not would
 * be exactly the drift this test exists to catch — and requires the ONE render
 * call in the route to pass the same kind the filename was built from.
 */
test("all three formats go through one renderer table and get nothing but the payload", async () => {
  const source = await read(EXPORT_ROUTE);
  assert.match(
    source,
    /const RENDERERS: Record<\s*ExportFormat,\s*\{\s*render: \(payload: CombinedReportPayload, kind: DocumentKind\) => Uint8Array;\s*contentType: string;\s*\}\s*> = \{/,
    "the signature is the contract's central rule: a renderer cannot ask a different question",
  );
  assert.match(source, /docx: \{ render: renderDocx/);
  assert.match(source, /pdf: \{ render: renderPdf/);
  assert.match(source, /xlsx: \{ render: renderXlsx/);
  assert.match(source, /filename = exportFilename\(\{/, "naming is the contract's, not the route's");
  const code = codeOnly(source);
  assert.equal(
    (code.match(/renderer\.render\(/g) ?? []).length,
    1,
    "one render call, so the kind on the file and the kind in the name cannot differ",
  );
  assert.match(code, /renderer\.render\(payload, kind\)/);
});

/*
 * The kind reaches the route, and an old caller that omits it is not refused.
 *
 * The Generated Documents table's download links, any bookmark, and anything
 * built against this route before the split all send no `kind`. They must keep
 * working and must keep producing the combined document they always produced.
 */
test("the export route takes a document kind and tolerates a caller that omits one", async () => {
  const source = await read(EXPORT_ROUTE);
  assert.match(
    source,
    /function documentKind\(value: unknown\): DocumentKind \{\s*\n\s*return isDocumentKind\(value\) \? value : "combined";/,
    "an absent or unknown kind is the combined document, not a 400",
  );
  assert.match(source, /documentKind\(url\.searchParams\.get\("kind"\)\)/, "GET reads it from the query");
  assert.match(source, /documentKind\(body\["kind"\]\)/, "POST reads it from the body");
  assert.match(
    source,
    /"x-maintsupp-export-kind": kind/,
    "the response says which document it is, as it already says which format",
  );
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
  /*
   * RE-POINTED, NOT WEAKENED. These three reads were in the combined
   * generator's button list; they are now the wording of the three permission
   * refusals on the shared action bar, which is where every control that could
   * be denied now lives. Same capabilities, same three-valued read, one file
   * further along — and the pin gains the check that the refusals are WORDED
   * rather than being bare booleans, which is the owner's "never a silently
   * greyed button" expressed on the permission half of the rule.
   */
  const actions = await read(ACTIONS);
  assert.match(actions, /canSettle === false/, "approve, finalise and void need settings.edit");
  assert.match(actions, /canExport === false/, "the export controls need data.export");
  assert.match(actions, /canEdit === false/, "editing needs board.edit");
  assert.match(
    actions,
    /const settlementDenied =\s*\n\s*canSettle === false\s*\n\s*\? "Approving, finalising and voiding need the Manage settings permission/,
    "a denied permission has to produce a sentence, not a disabled attribute",
  );
  // The shared core still reads capabilities — the form it disables is its own.
  const generator = await read(GENERATOR);
  assert.match(generator, /const canSettle = useCapability\("settings\.edit"\)/);
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

/* ── The action bar ──────────────────────────────────────────────────────── */

/*
 * THE BAR IS AT THE TOP, AND THE HEADER SAYS WHY.
 *
 * It used to be the last card on the page, and the file's header argued for
 * that position at length. The Report tab is now a full maintenance report, so
 * Save and Recalculate sat thousands of pixels below the fold. A stale comment
 * arguing the opposite of the code is worse than no comment, so the pin is on
 * BOTH: the bar is rendered first, and the header no longer makes the old case.
 */
test("the action bar is the first thing on both tabs, and is sticky", async () => {
  for (const file of [REPORT_TAB, INVOICE_TAB]) {
    const source = await read(file);
    const bar = source.indexOf("<GeneratorActionBar");
    const setup = source.indexOf("<GeneratorSetupCards");
    assert.ok(bar > 0, `${file} must draw the shared action bar`);
    assert.ok(bar < setup, `${file}: the bar comes before the form it acts on`);
  }
  const css = await read(CSS);
  assert.match(
    css,
    /\.reports-actions--sticky \{[\s\S]*?position: sticky;[\s\S]*?top: var\(--mobile-topbar-height, 71px\);/,
    "sticky under the product's own topbar, or it pins behind it and disappears",
  );
  assert.match(
    css,
    /\.reports-actions--sticky \{[\s\S]*?z-index: var\(--z-sticky\);/,
    "the product's sticky layer, far below --z-topbar which it must never cover",
  );
  /*
   * The old header argued at length FOR the bottom position, and a comment
   * arguing the opposite of the code is worse than no comment. Both files quote
   * that argument, and BOTH must quote it in the past tense — as the decision
   * that was overturned and why — rather than still making it. This pin is on
   * the tense, because that is the whole difference between a recorded decision
   * and a stale claim.
   */
  const shared = await read(GENERATOR);
  const unwrapped = (text) => text.replace(/\n \* /g, " ");
  assert.ok(
    unwrapped(shared).includes("This header used to argue for the bottom position"),
    "invoice-generator.tsx must mark the old argument as overturned, not repeat it",
  );
  assert.ok(
    unwrapped(shared).includes("The bar is now a sticky one at the TOP of both tabs"),
    "and must say where the bar actually is now",
  );
  assert.match(
    shared,
    /THE ACTION BLOCK IS NO LONGER HERE, AND IS NO LONGER AT THE BOTTOM/,
    "the file that used to hold the bar must say where it went and why",
  );
  assert.match(shared, /\.\/generator-actions\.tsx/);

  const actions = await read(ACTIONS);
  assert.match(actions, /── WHY IT IS AT THE TOP ─/);
  assert.ok(
    unwrapped(actions).includes(
      "it stopped holding the moment the Report tab became a full maintenance report",
    ),
    "the new reasoning has to name what actually changed, not merely assert the new position",
  );
});

/*
 * NO SILENTLY GREYED BUTTON.
 *
 * The owner's rule is that every unavailable action explains itself on hover
 * AND on tap. A `disabled` button cannot do that — it receives no pointer or
 * touch events at all, so its `title` is unreachable on a phone. The bar
 * therefore uses `aria-disabled` and answers the tap with the reason.
 *
 * And the reason is DERIVED. `DOCUMENT_TRANSITIONS` says what a document in
 * this state can become; the sentence names the state and what it can move to.
 * A hardcoded string per button is what this pin exists to prevent, because it
 * is what goes stale when the state machine changes — Finalise was enabled on a
 * Draft under the old hardcoded rule, and the server refused it.
 */
test("every unavailable action on the bar explains itself, from the lifecycle", async () => {
  const source = await read(ACTIONS);
  assert.match(
    source,
    /import \{ canTransition, DOCUMENT_TRANSITIONS \} from "\.\.\/\.\.\/\.\.\/lib\/reporting\/access"/,
    "the availability of a lifecycle action is the state machine's to decide",
  );
  assert.match(
    source,
    /if \(!canTransition\(status, target\)\) \{[\s\S]{0,400}From \$\{status\} it can only move to \$\{listStatuses\(reachable\)\}/,
    "the reason must name the state it is in and the states it can reach",
  );
  assert.match(
    source,
    /const ACTION_TARGET: Record<"submit" \| "approve" \| "finalise" \| "void", InvoiceStatus>/,
    "the only hand-written part is which status each button asks for",
  );
  const code = codeOnly(source);
  assert.match(code, /aria-disabled=\{unavailable\}/);
  /*
   * Scoped to the bar. `GeneratorSetupCards` above it legitimately passes
   * `disabled` to the FORM — a finalised document's fields are not editable and
   * a greyed input needs no explanation, because the bar beside it is already
   * saying the document is Finalised. It is the ACTIONS that must never be
   * silently unavailable.
   */
  const bar = code.slice(code.indexOf("function ActionButton"));
  assert.ok(bar.length > 500, "the action bar must still be in this file");
  // The lookbehind matters: `\bdisabled=` also matches `aria-disabled=`, which
  // is the very attribute this rule requires instead.
  assert.ok(
    !/(?<!aria-)disabled=\{/.test(bar),
    "a `disabled` button receives no touch events, so it cannot answer 'why not' on a phone",
  );
  assert.match(code, /title=\{action\.reason \?\? action\.label\}/, "the reason on hover");
  assert.match(
    code,
    /onClick=\{\(\) => \(unavailable \? onRefused\(action\.reason!\) : action\.run\(\)\)\}/,
    "the same reason on tap",
  );
  assert.match(code, /aria-describedby=\{unavailable \? reasonId : undefined\}/, "and to a screen reader");
  // Every action in the table must produce a reason rather than a bare boolean.
  const actions = code.match(/\n      id: /g) ?? [];
  const reasons = code.match(/\n      reason:/g) ?? [];
  assert.ok(actions.length >= 9, `expected the full action set, found ${actions.length}`);
  assert.equal(reasons.length, actions.length, "every action states a reason or null, none is a bare flag");
});

/* The phone bar: a compact row and an overflow, and no third scrolling axis. */
test("the bar is usable on a phone without a horizontal scroller", async () => {
  const source = await read(ACTIONS);
  assert.match(source, /className="reports-actions__compact"/);
  assert.match(source, /<MoreMenu actions=\{overflow\}/);
  const css = await read(CSS);
  assert.match(
    css,
    /@media \(max-width: 640px\) \{[\s\S]*?\.reports-actions__full \{\s*\n\s*display: none;/,
    "the full set is replaced, not squeezed",
  );
  assert.match(
    css,
    /@media \(max-width: 640px\) \{[\s\S]*?\.reports-actions__compact \{\s*\n\s*display: flex;/,
  );
  assert.ok(
    !/\.reports-actions__compact \{[^}]*overflow-x/.test(css),
    "the compact row must not become a second horizontally scrolling surface",
  );
  // The menu prints each reason under its item, which is the tap explanation.
  assert.match(source, /\{action\.reason && <small>\{action\.reason\}<\/small>\}/);
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

/*
 * RE-POINTED, NOT WEAKENED. `invoice-generator.tsx` is the shared core and no
 * longer draws a table of its own — the drill-down went to the Report tab and
 * the billable-sites table to the Invoice tab — so the list follows the tables.
 * Asserting on a file with no `<table>` in it would have passed vacuously on
 * the count and then failed on the `role="region"` line, which is why this is a
 * move rather than a deletion.
 */
test("every wide table is inside the scroll container and labelled for a keyboard", async () => {
  for (const file of [REPORT_TAB, INVOICE_TAB, DOCUMENTS, PREVIEW]) {
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
  /*
   * RE-POINTED, NOT WEAKENED. The maintenance KPI tiles moved to the Report
   * tab with the rest of part 2, so that is where the product's tile has to be
   * imported. The contract — "this screen does not fork the analytics
   * surface" — is unchanged.
   */
  const reportTab = await read(REPORT_TAB);
  assert.match(
    reportTab,
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
