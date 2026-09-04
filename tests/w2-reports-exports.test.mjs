/**
 * The three export writers, round-tripped.
 *
 * THE ASSERTION THAT MATTERS IS THE LAST ONE
 *
 * "ALL FORMAT TOTALS MUST MATCH" is the owner's requirement, and the way it
 * normally fails is not a wrong sum — it is four renderers that each went back
 * to the database and asked a slightly different question. The architecture
 * closes that off: one `CombinedReportPayload`, one `buildReportDocument()`, no
 * database handle in any renderer. This file is what proves the architecture is
 * actually in force rather than merely intended, by opening the generated
 * `.docx`, `.xlsx` and `.pdf` and reading the total OUT OF EACH FILE.
 *
 * The fixture is chosen to be the hard case (see `sample-payload.ts`): five
 * site lines of which one is EXCLUDED. Any writer that re-sums the fee column
 * instead of printing `invoice.totals` produces £550.00 where the payload says
 * £485.00, and only that one file is wrong. That is the failure this test
 * exists to catch, and it cannot be caught by comparing a renderer to itself.
 *
 * NOTHING HERE RE-IMPLEMENTS A FORMAT. The ZIP is read back by the same
 * `readStoredZip` the writer's own header describes as narrow and test-facing,
 * and the PDF's cross-reference table is walked by hand — so a broken offset is
 * a failed assertion here rather than a file that opens in nothing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./reports-ts-loader.mjs";

const { crc32, readStoredZip, zipFiles } = await import("../app/lib/exports/zip.ts");
const { renderDocx, DOCX_CONTENT_TYPE } = await import("../app/lib/exports/docx.ts");
const { renderXlsx, XLSX_CONTENT_TYPE, columnLetter, safeSheetName } = await import(
  "../app/lib/exports/xlsx.ts"
);
const { renderPdf, PDF_CONTENT_TYPE } = await import("../app/lib/exports/pdf.ts");
const { samplePayload, emptyPayload } = await import("../app/lib/exports/sample-payload.ts");
const { buildReportDocument, sectionsFor, invoiceKpiRows } = await import(
  "../app/lib/exports/document-model.ts"
);
const { formatMoney, formatIsoDate, formatPercent, excelSerialFromIsoDate } = await import(
  "../app/lib/exports/format.ts"
);
const { exportFilename } = await import("../app/lib/reporting/contract.ts");
const { readXlsx } = await import("../app/lib/xlsx-reader.ts");

const utf8 = (bytes) => new TextDecoder().decode(bytes);
const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");

/* ── The container ───────────────────────────────────────────────────────── */

test("CRC-32 matches the published vectors", () => {
  const encode = (value) => new TextEncoder().encode(value);
  assert.equal(crc32(encode("")), 0);
  assert.equal(crc32(encode("123456789")).toString(16), "cbf43926");
  assert.equal(
    crc32(encode("The quick brown fox jumps over the lazy dog")).toString(16),
    "414fa339",
  );
});

test("the ZIP writer round-trips names, bytes and UTF-8 content", () => {
  const archive = zipFiles([
    { name: "a.txt", content: "hello" },
    { name: "nested/dir/b.xml", content: "<x>£1,690.00 — Ünit</x>" },
  ]);
  const entries = readStoredZip(archive);
  assert.deepEqual([...entries.keys()], ["a.txt", "nested/dir/b.xml"]);
  assert.equal(utf8(entries.get("a.txt")), "hello");
  assert.equal(utf8(entries.get("nested/dir/b.xml")), "<x>£1,690.00 — Ünit</x>");
});

test("the same payload produces byte-identical archives", () => {
  // The writer stamps a fixed modification time on purpose, so two exports of
  // one finalised snapshot cannot differ. A `new Date()` default would make
  // this fail and would make a stored document non-reproducible.
  assert.deepEqual(renderDocx(samplePayload()), renderDocx(samplePayload()));
  assert.deepEqual(renderXlsx(samplePayload()), renderXlsx(samplePayload()));
});

/* ── Word ────────────────────────────────────────────────────────────────── */

test("the .docx is a complete OOXML package", () => {
  const parts = readStoredZip(renderDocx(samplePayload()));
  for (const required of [
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
    "word/styles.xml",
    "word/_rels/document.xml.rels",
    "docProps/core.xml",
  ]) {
    assert.ok(parts.has(required), `${required} is missing from the package`);
  }
  assert.equal(
    DOCX_CONTENT_TYPE,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
});

test("the .docx XML escapes, and orders its element sequences the way Word demands", () => {
  const parts = readStoredZip(renderDocx(samplePayload()));
  const document = utf8(parts.get("word/document.xml"));

  // "Smith & Co." unescaped is a package Word offers to repair rather than open.
  assert.ok(document.includes("Smith &amp; Co."), "the ampersand must be escaped");
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(document), "no bare ampersands");

  /*
   * These three orderings are xsd:sequence in the schema, and Word rejects the
   * WHOLE DOCUMENT when one is wrong — it does not skip the misplaced child.
   * All three were written the intuitive way first and all three were wrong,
   * so they are pinned here rather than left to be rediscovered.
   */
  assert.ok(
    !/<w:tcPr><w:gridSpan/.test(document),
    "w:tcPr is a sequence: tcW comes before gridSpan",
  );
  assert.ok(
    document.includes('<w:tcPr><w:tcW'),
    "every cell's tcPr must open with tcW",
  );
  assert.ok(
    !/<w:trPr><w:tblHeader\/><w:cantSplit\/>/.test(document),
    "w:trPr is a sequence: cantSplit comes before tblHeader",
  );
  assert.ok(
    document.includes("<w:cantSplit/><w:tblHeader/>"),
    "the repeating header row needs cantSplit then tblHeader",
  );

  // Real tables, and a header row that repeats when one spills over a page.
  assert.ok((document.match(/<w:tbl>/g) ?? []).length >= 12, "one table per populated section");
  assert.ok(document.includes("<w:tblHeader/>"), "table headers must repeat across pages");

  // Two page sections: portrait invoice, landscape report.
  const sectPr = document.match(/<w:sectPr>/g) ?? [];
  assert.equal(sectPr.length, 2, "one sectPr ends part 1, one is the body default");
  assert.ok(document.includes('w:orient="landscape"'), "part 2 is landscape");
});

test("the .docx is client-facing and carries no internal content", () => {
  const payload = samplePayload();
  const document = utf8(readStoredZip(renderDocx(payload)).get("word/document.xml"));
  assert.ok(payload.invoice.internalNote.includes("not for the client"));
  assert.ok(
    !document.includes("not for the client"),
    "the internal note must never reach a client-facing export",
  );
  assert.ok(
    !document.includes(payload.invoice.internalReference),
    "the internal reference is internal too",
  );
});

/* ── Excel ───────────────────────────────────────────────────────────────── */

test("the .xlsx carries one sheet per section, all thirteen", () => {
  const parts = readStoredZip(renderXlsx(samplePayload()));
  const workbook = utf8(parts.get("xl/workbook.xml"));
  const names = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(names, [
    "Invoice Summary",
    "Site Charges",
    "Executive Summary",
    "Site Performance",
    "Spend Analysis",
    "SLA Performance",
    "Delays and Holds",
    "Open Items Past Target",
    "Critical Open Items",
    "Special Projects",
    "Full Job Log",
    "Data Quality",
    "SLA Rules",
  ]);
  for (const name of names) {
    assert.ok(name.length <= 31, `"${name}" is past Excel's 31-character sheet-name limit`);
  }
  assert.equal(
    XLSX_CONTENT_TYPE,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
});

test("the .xlsx holds REAL CELLS, not a screenshot in cells", () => {
  const parts = readStoredZip(renderXlsx(samplePayload()));
  const sheet = utf8(parts.get("xl/worksheets/sheet2.xml")); // Site Charges

  // Money is a NUMBER of pounds under a currency format, never the string.
  assert.ok(sheet.includes("<v>125</v>"), "a £125.00 fee is the number 125");
  assert.ok(!sheet.includes("£125.00"), "the money string must not be a cell value");

  // A date is an Excel serial under dd/mm/yyyy, so it sorts and filters.
  const serial = excelSerialFromIsoDate("2024-06-01");
  assert.equal(serial, 45444);
  assert.ok(sheet.includes(`<v>${serial}</v>`), "dates are serials");

  // A percentage is a fraction under 0.0%.
  assert.ok(sheet.includes("<v>0.2</v>"), "20% VAT is stored as 0.2");

  const styles = utf8(parts.get("xl/styles.xml"));
  assert.match(styles, /numFmtId="164" formatCode="&quot;£&quot;#,##0.00"/);
  assert.match(styles, /numFmtId="165" formatCode="0.0%"/);
  assert.match(styles, /numFmtId="166" formatCode="dd\/mm\/yyyy"/);

  // Frozen header, autofilter over exactly the data, and column widths.
  assert.match(sheet, /<pane ySplit="\d+" topLeftCell="A\d+" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(sheet, /<autoFilter ref="A\d+:[A-Z]+\d+"\/>/);
  assert.match(sheet, /<col min="1" max="1" width="\d+" customWidth="1"\/>/);
});

test("the totals row sits OUTSIDE the autofilter range", () => {
  // Inside it, applying any filter hides the totals — a reader then has a
  // filtered table and a total that silently vanished rather than one that no
  // longer matches.
  const parts = readStoredZip(renderXlsx(samplePayload()));
  const sheet = utf8(parts.get("xl/worksheets/sheet2.xml"));
  const filter = /<autoFilter ref="A\d+:[A-Z]+(\d+)"\/>/.exec(sheet);
  assert.ok(filter, "the site charges sheet must carry an autofilter");
  const lastFiltered = Number(filter[1]);
  const rowNumbers = [...sheet.matchAll(/<row r="(\d+)"/g)].map((match) => Number(match[1]));
  const lastRow = Math.max(...rowNumbers);
  assert.ok(lastRow > lastFiltered, "the totals row must be below the filtered range");
});

test("the workbook reads back through this repo's own xlsx reader", async () => {
  // A genuinely independent check: `app/lib/xlsx-reader.ts` was written to read
  // monday.com's exports and knows nothing about this writer.
  const sheet = await readXlsx(renderXlsx(samplePayload()));
  assert.equal(sheet.name, "Invoice Summary");
  const flat = sheet.rows.map((row) => row.join("|"));
  assert.ok(flat.some((row) => row.startsWith("1. Invoice Summary")));
  assert.ok(
    flat.some((row) => row === "Billable active sites|4"),
    "the reader must see 4 as a value, not as text",
  );
  assert.ok(
    flat.some((row) => row === "Invoice subtotal|425"),
    "money reads back as the number 425, which is what makes it summable",
  );
});

test("the workbook keeps internal content — it is the owner's copy", () => {
  const payload = samplePayload();
  const parts = readStoredZip(renderXlsx(payload));
  const sheet = utf8(parts.get("xl/worksheets/sheet1.xml"));
  assert.ok(
    sheet.includes("Internal note"),
    "the contract names Preview and Excel as where the internal note may appear",
  );
});

test("a sheet name is made legal and unique rather than breaking the workbook", () => {
  const taken = new Set();
  assert.equal(safeSheetName("Site: Charges/2026", taken), "Site- Charges-2026");
  assert.equal(safeSheetName("Site: Charges/2026", taken), "Site- Charges-2026 (2)");
  assert.equal(safeSheetName("x".repeat(60), taken).length, 31);
});

test("column letters carry past Z", () => {
  assert.equal(columnLetter(1), "A");
  assert.equal(columnLetter(26), "Z");
  assert.equal(columnLetter(27), "AA");
  assert.equal(columnLetter(52), "AZ");
  assert.equal(columnLetter(53), "BA");
});

/* ── PDF ─────────────────────────────────────────────────────────────────── */

test("the .pdf is a structurally valid PDF, not a file with a .pdf name", () => {
  const bytes = renderPdf(samplePayload());
  const text = latin1(bytes);

  assert.ok(text.startsWith("%PDF-1."), "no PDF header");
  assert.ok(text.trimEnd().endsWith("%%EOF"), "no %%EOF");
  assert.equal(PDF_CONTENT_TYPE, "application/pdf");

  const startxref = /startxref\s+(\d+)\s+%%EOF/.exec(text);
  assert.ok(startxref, "no startxref");
  const xrefAt = Number(startxref[1]);
  assert.equal(text.slice(xrefAt, xrefAt + 4), "xref", "startxref does not point at the table");

  // Every cross-reference offset must land exactly on its object header. This
  // is the one thing a hand-written PDF gets wrong, and the symptom is a file
  // that opens in nothing with no useful message.
  const declared = Number(/xref\s+0 (\d+)\s/.exec(text.slice(xrefAt))[1]);
  const entries = [...text.slice(xrefAt).matchAll(/^(\d{10}) (\d{5}) ([nf]) $/gm)];
  assert.equal(entries.length, declared, "the xref length disagrees with its own header");
  entries.forEach((entry, index) => {
    if (index === 0) {
      assert.equal(entry[3], "f", "object 0 must be the free entry");
      return;
    }
    const offset = Number(entry[1]);
    assert.equal(
      text.slice(offset, offset + `${index} 0 obj`.length),
      `${index} 0 obj`,
      `xref entry ${index} does not point at object ${index}`,
    );
  });

  // Every stream's declared /Length must be its actual byte count.
  for (const match of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = match.index + match[0].length;
    const end = text.indexOf("\nendstream", start);
    assert.equal(end - start, Number(match[1]), "a content stream's /Length is wrong");
  }

  // The page tree must agree with itself.
  const kids = /\/Kids \[([^\]]*)\]/.exec(text)[1].trim().split(/\s+0 R\s*/).filter(Boolean);
  assert.equal(Number(/\/Count (\d+)/.exec(text)[1]), kids.length);
  assert.ok(kids.length >= 2, "an invoice and a report do not fit on one page");
});

test("the .pdf writes WinAnsi bytes and escapes what would end a literal", () => {
  const text = latin1(renderPdf(samplePayload()));
  // £ is the single byte 0xA3 under /WinAnsiEncoding. UTF-8 would print "Â£".
  assert.ok(text.includes("£485.00"), "the pound sign must be one WinAnsi byte");
  assert.ok(text.includes("/Encoding /WinAnsiEncoding"));
  // "(UK)/EU" contains a ')' — unescaped, it ends the literal early and the
  // rest of the page is read as operators.
  assert.ok(text.includes("\\(UK\\)/EU"), "parentheses in a client name must be escaped");
});

test("the .pdf is client-facing and carries no internal content", () => {
  const text = latin1(renderPdf(samplePayload()));
  assert.ok(!text.includes("not for the client"), "the internal note must not reach the PDF");
});

/* ── The reconciliation ──────────────────────────────────────────────────── */

test("ALL FORMAT TOTALS MATCH — read out of the three generated files", () => {
  const payload = samplePayload();
  const currency = payload.invoice.currency;
  const totals = payload.invoice.totals;

  // The fixture excludes one £125.00 line on purpose. A renderer that re-sums
  // the fee column produces £550.00 here; the payload says £485.00.
  const feeColumnSum = payload.invoice.lines.reduce((sum, line) => sum + line.feePence, 0);
  assert.equal(feeColumnSum, 55_000);
  assert.equal(totals.subtotalPence, 42_500);
  assert.notEqual(feeColumnSum, totals.subtotalPence);

  const expected = {
    total: formatMoney(totals.totalPence, currency), // £485.00
    subtotal: formatMoney(totals.subtotalPence, currency), // £425.00
    vat: formatMoney(totals.vatPence, currency), // £85.00
    maintenance: formatMoney(payload.maintenance.spend.completedMaintenancePence, currency),
  };

  const docx = utf8(readStoredZip(renderDocx(payload)).get("word/document.xml"));
  const pdf = latin1(renderPdf(payload));
  const xlsxParts = readStoredZip(renderXlsx(payload));
  const invoiceSheet = utf8(xlsxParts.get("xl/worksheets/sheet1.xml"));
  const spendSheet = utf8(xlsxParts.get("xl/worksheets/sheet5.xml"));

  for (const [name, value] of Object.entries(expected)) {
    assert.ok(docx.includes(value), `the Word file is missing the ${name} ${value}`);
    assert.ok(pdf.includes(value), `the PDF is missing the ${name} ${value}`);
  }

  // The spreadsheet stores NUMBERS, so it is checked as a number — which is the
  // point of it, and which is why this assertion is shaped differently.
  assert.ok(
    invoiceSheet.includes(`<v>${totals.totalPence / 100}</v>`),
    "the workbook must carry the total as the number 485",
  );
  assert.ok(
    invoiceSheet.includes(`<v>${totals.subtotalPence / 100}</v>`),
    "the workbook must carry the subtotal as the number 425",
  );
  assert.ok(
    spendSheet.includes(`<v>${payload.maintenance.spend.completedMaintenancePence / 100}</v>`),
    "the workbook must carry completed maintenance spend as a number",
  );

  // And the on-screen KPI, from the same derivation the preview renders.
  const totalCard = invoiceKpiRows(payload).find((card) => card.key === "total");
  assert.equal(totalCard.value, expected.total);

  // Nothing anywhere prints the naive re-sum.
  const wrong = formatMoney(feeColumnSum, currency);
  assert.ok(!docx.includes(wrong), "the Word file re-summed the fee column");
  assert.ok(!pdf.includes(wrong), "the PDF re-summed the fee column");
});

test("the fee card renames itself when the fees differ", () => {
  const payload = samplePayload();
  assert.equal(payload.invoice.totals.singleFeePence, null);
  const card = invoiceKpiRows(payload).find((entry) => entry.key === "siteFee");
  assert.equal(card.label, "Average Site Fee");
  assert.equal(card.value, formatMoney(payload.invoice.totals.averageFeePence, "GBP"));

  const single = samplePayload();
  single.invoice.totals.singleFeePence = 12_500;
  const renamed = invoiceKpiRows(single).find((entry) => entry.key === "siteFee");
  assert.equal(renamed.label, "Fixed Fee per Site");
  assert.equal(renamed.value, "£125.00");
});

/* ── Empty periods, which are where confident falsehoods appear ──────────── */

test("an empty period is reported as empty, never as a result", () => {
  const payload = emptyPayload();
  assert.equal(payload.maintenance.kpis.slaPerformancePercent, null);
  // A dash, not 0% — 0% is a finding, and it says every job missed its target.
  assert.equal(formatPercent(null), "—");

  const document = buildReportDocument(payload);
  const sla = document.sections.find((section) => section.id === "sla-performance");
  assert.equal(sla.table.rows.length, 0);
  assert.match(sla.emptyMessage, /no job/i);

  const docx = utf8(readStoredZip(renderDocx(payload)).get("word/document.xml"));
  assert.ok(docx.includes(sla.emptyMessage), "an empty section prints its sentence");
  assert.ok(!docx.includes("0.0%"), "a null SLA percentage must not become 0%");

  // And all three formats still produce a valid file for an empty period.
  assert.ok(renderPdf(payload).length > 1000);
  assert.ok(renderXlsx(payload).length > 1000);
});

test("Special Projects is omitted client-side when empty and kept in the workbook", () => {
  const document = buildReportDocument(samplePayload());
  const clientFacing = sectionsFor(document, "all").map((section) => section.id);
  const internal = sectionsFor(document, "internal").map((section) => section.id);
  assert.ok(
    !clientFacing.includes("special-projects"),
    "the contract says an empty array omits the section entirely",
  );
  assert.ok(
    internal.includes("special-projects"),
    "a missing TAB reads as an incomplete workbook, not as 'no projects'",
  );
});

/* ── Naming ──────────────────────────────────────────────────────────────── */

test("the filename comes from the contract's own sanitiser", () => {
  const payload = samplePayload();
  const name = exportFilename({
    clientName: payload.invoice.clientName,
    periodStart: payload.period.start,
    periodEnd: payload.period.end,
    invoiceNumber: payload.invoice.invoiceNumber,
    format: "docx",
  });
  /*
   * `U-nit`, not `Unit`, and that is the contract behaving as written rather
   * than a defect. `exportFilename` normalises NFKD first, which decomposes `Ü`
   * into `U` + a combining diaeresis; the combining mark is then outside
   * `[A-Za-z0-9]` and becomes a hyphen like anything else. Pinned with the
   * reason so nobody "fixes" it into a mojibake filename later — the contract
   * is frozen and this is its stated aggression.
   */
  assert.equal(name, "MAINTSUPP_Smith-Co-UK-EU-U-nit-3_2026-03-01_2026-03-31_MS-000241.docx");
  // No path separator, no leading dot, nothing a Windows filename refuses.
  assert.ok(!/[\\/:*?"<>|]/.test(name));
  assert.ok(!name.startsWith("."));
  assert.match(
    exportFilename({
      clientName: "Quiet Estates Ltd",
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      invoiceNumber: null,
      format: "pdf",
    }),
    /_DRAFT\.pdf$/,
    "an unissued invoice is named DRAFT rather than null",
  );
});

/* ── Formatting, which every format shares ───────────────────────────────── */

test("money and dates are formatted in exactly one place", () => {
  assert.equal(formatMoney(48_500), "£485.00");
  assert.equal(formatMoney(0), "£0.00");
  assert.equal(formatMoney(-2_500), "-£25.00");
  assert.equal(formatMoney(123_456_789), "£1,234,567.89");
  assert.equal(formatMoney(1_000, "EUR"), "€10.00");
  assert.equal(formatMoney(1_000, "AUD"), "AUD 10.00");

  // A bare calendar date must not shift a day for a reader west of Greenwich.
  assert.equal(formatIsoDate("2026-01-01"), "01/01/2026");
  assert.equal(formatIsoDate("2026-03-31"), "31/03/2026");
  assert.equal(formatIsoDate(null), "");
  assert.equal(formatIsoDate("not a date", "—"), "—");
});
