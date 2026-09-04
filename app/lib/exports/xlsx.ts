/**
 * The combined document as a real SpreadsheetML workbook.
 *
 * THE POINT OF THIS FILE IS THAT IT IS NOT A PICTURE
 *
 * The owner's instruction was "REAL CELLS, never a screenshot", and it is the
 * requirement that decides every design choice below. A workbook whose money
 * column holds the string "£1,690.00" looks identical to one that holds the
 * number 1690 — until somebody selects the column and the status bar shows no
 * sum, or sorts by cost and gets £1,000 above £900 because the strings sorted
 * alphabetically, or filters "greater than 500" and is told the column is text.
 * That workbook is a screenshot with gridlines.
 *
 * So every cell here is typed. Money is a NUMBER of pounds under a currency
 * format, a date is an Excel SERIAL under `dd/mm/yyyy`, a percentage is a
 * FRACTION under `0.0%`. The strings the reader sees are produced by Excel from
 * the number, not shipped alongside it, which also means the workbook and the
 * PDF cannot disagree about a rounding: they are formatting the same value.
 *
 * `document-model.ts` is what makes that affordable — every cell already
 * carries both a display string and a machine value, so this writer only has to
 * pick the number format that matches `kind`.
 *
 * INLINE STRINGS RATHER THAN A SHARED STRING TABLE
 *
 * The shared string table is an optimisation for workbooks with heavy
 * repetition, and it costs a second pass and an index that must not drift from
 * the cells referencing it. `t="inlineStr"` is fully valid SpreadsheetML, Excel
 * and LibreOffice both read it, and it makes each sheet independently
 * generatable and independently readable in a test. For a job log of a few
 * hundred rows the size difference does not matter.
 *
 * ONE SHEET PER SECTION
 *
 * Thirteen sheets, named for the sections. Each carries its own frozen header
 * row, its own autofilter over exactly its own data, its own column widths and
 * its own totals line — so a reader who filters Site Charges has not disturbed
 * the Full Job Log, and a totals row is never inside the filtered range where
 * it would disappear the moment a filter is applied.
 */

import type { CombinedReportPayload } from "../reporting/contract";
import { buildReportDocument, keyValuesFor, sectionsFor } from "./document-model";
import type { DocCell, DocSection } from "./document-model";
import { currencyNumberFormat } from "./format";
import { ZipWriter } from "./zip";
import { XML_DECLARATION, xmlText } from "./xml";

/* ── Cell addresses ──────────────────────────────────────────────────────── */

/** 1 -> "A", 27 -> "AA". Written out because a report can exceed 26 columns. */
export function columnLetter(index: number): string {
  let value = index;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters || "A";
}

/* ── Styles ──────────────────────────────────────────────────────────────── */

/**
 * The style indices, named.
 *
 * `cellXfs` is addressed by position, so a style is an integer and an integer
 * in a cell attribute is unreadable. Naming them here is the difference between
 * `s="11"` and `TOTAL_MONEY`, and between a safe edit and an off-by-one that
 * silently formats every total as a date.
 */
const STYLE = {
  DEFAULT: 0,
  TITLE: 1,
  NOTE: 2,
  HEADER: 3,
  TEXT: 4,
  MONEY: 5,
  NUMBER: 6,
  PERCENT: 7,
  DATE: 8,
  KEY_LABEL: 9,
  EMPHASIS_TEXT: 10,
  EMPHASIS_MONEY: 11,
  EMPHASIS_NUMBER: 12,
  TOTAL_TEXT: 13,
  TOTAL_MONEY: 14,
  TOTAL_NUMBER: 15,
  TOTAL_PERCENT: 16,
  TOTAL_DATE: 17,
  GROUP: 18,
  BLOCKING: 19,
  WARNING: 20,
} as const;

function stylesXml(currency: string): string {
  const money = xmlText(currencyNumberFormat(currency));
  return `${XML_DECLARATION}
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4">
<numFmt numFmtId="164" formatCode="${money}"/>
<numFmt numFmtId="165" formatCode="0.0%"/>
<numFmt numFmtId="166" formatCode="dd/mm/yyyy"/>
<numFmt numFmtId="167" formatCode="#,##0"/>
</numFmts>
<fonts count="7">
<font><sz val="11"/><name val="Calibri"/><color rgb="FF132537"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FF132537"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
<font><b/><sz val="16"/><name val="Calibri"/><color rgb="FF0B7A72"/></font>
<font><i/><sz val="10"/><name val="Calibri"/><color rgb="FF4E5F6F"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFC73535"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFB26A00"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF0B7A72"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEAF0F3"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top style="thin"><color rgb="FFC8D3DA"/></top><bottom style="thin"><color rgb="FFC8D3DA"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="21">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

/**
 * Which `cellXfs` entry a cell gets.
 *
 * A totals cell wins over an emphasis cell wins over a tone, because a totals
 * row is structural and a tone is decoration; and a blocking tone still reads
 * as blocking on an ordinary row, which is where it matters.
 */
function styleFor(cell: DocCell, variant: "body" | "total"): number {
  if (variant === "total") {
    switch (cell.kind) {
      case "money":
        return STYLE.TOTAL_MONEY;
      case "number":
        return STYLE.TOTAL_NUMBER;
      case "percent":
        return STYLE.TOTAL_PERCENT;
      case "date":
        return STYLE.TOTAL_DATE;
      default:
        return STYLE.TOTAL_TEXT;
    }
  }
  if (cell.tone === "blocking") return STYLE.BLOCKING;
  if (cell.tone === "warning") return STYLE.WARNING;
  if (cell.emphasis) {
    if (cell.kind === "money") return STYLE.EMPHASIS_MONEY;
    if (cell.kind === "number") return STYLE.EMPHASIS_NUMBER;
    return STYLE.EMPHASIS_TEXT;
  }
  switch (cell.kind) {
    case "money":
      return STYLE.MONEY;
    case "number":
      return STYLE.NUMBER;
    case "percent":
      return STYLE.PERCENT;
    case "date":
      return STYLE.DATE;
    default:
      return STYLE.TEXT;
  }
}

/* ── Cells ───────────────────────────────────────────────────────────────── */

function inlineCell(reference: string, text: string, style: number): string {
  if (!text) return `<c r="${reference}" s="${style}"/>`;
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
}

function numericCell(reference: string, value: number, style: number): string {
  return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
}

/**
 * One `DocCell` as a spreadsheet cell.
 *
 * A cell with a machine value becomes a number; one without becomes text. That
 * is what keeps an em dash — which is what a missing count looks like — out of
 * a numeric column where it would make Excel treat the whole column as text.
 */
function writeCell(reference: string, cell: DocCell, variant: "body" | "total"): string {
  const style = styleFor(cell, variant);
  if (cell.value !== null && cell.kind !== "text" && cell.kind !== "boolean") {
    return numericCell(reference, cell.value, style);
  }
  return inlineCell(reference, cell.text, style);
}

/* ── One sheet ───────────────────────────────────────────────────────────── */

interface SheetResult {
  xml: string;
  name: string;
}

function buildSheet(
  section: DocSection,
  document: { clientName: string; periodLabel: string; periodStart: string; periodEnd: string },
): SheetResult {
  const rows: string[] = [];
  let rowNumber = 0;

  const pushRow = (cells: string[]) => {
    rowNumber += 1;
    rows.push(`<row r="${rowNumber}">${cells.join("")}</row>`);
    return rowNumber;
  };
  const pushTextRow = (text: string, style: number) => {
    rowNumber += 1;
    rows.push(`<row r="${rowNumber}">${inlineCell(`A${rowNumber}`, text, style)}</row>`);
    return rowNumber;
  };
  const pushBlank = () => {
    rowNumber += 1;
  };

  pushTextRow(`${section.number}. ${section.title}`, STYLE.TITLE);
  pushTextRow(
    `${document.clientName} · ${document.periodLabel} · ${document.periodStart} to ${document.periodEnd}`,
    STYLE.NOTE,
  );
  if (section.note) pushTextRow(section.note, STYLE.NOTE);
  for (const line of section.paragraphs) pushTextRow(line, STYLE.TEXT);

  // The workbook is not client-facing — it is the owner's working copy, and the
  // contract names it alongside the preview as somewhere the internal note may
  // appear. So the internal audience is used here and nowhere else.
  const keyValues = keyValuesFor(section, "internal");
  if (keyValues.length) {
    pushBlank();
    for (const entry of keyValues) {
      const row = rowNumber + 1;
      pushRow([
        inlineCell(`A${row}`, entry.label, STYLE.KEY_LABEL),
        inlineCell(`B${row}`, entry.value, entry.emphasis ? STYLE.EMPHASIS_TEXT : STYLE.TEXT),
      ]);
    }
  }

  let headerRow = 0;
  let lastDataRow = 0;
  let columnCount = 1;

  if (section.table) {
    pushBlank();
    columnCount = Math.max(1, section.table.columns.length);
    headerRow = rowNumber + 1;
    pushRow(
      section.table.columns.map((col, index) =>
        inlineCell(`${columnLetter(index + 1)}${headerRow}`, col.header, STYLE.HEADER),
      ),
    );

    const groupStarts = new Map<number, string>();
    for (const group of section.table.groups ?? []) groupStarts.set(group.from, group.label);

    section.table.rows.forEach((cells, index) => {
      if (groupStarts.has(index)) {
        const groupRow = rowNumber + 1;
        pushRow([inlineCell(`A${groupRow}`, groupStarts.get(index)!, STYLE.GROUP)]);
      }
      const row = rowNumber + 1;
      pushRow(
        cells.map((cell, columnIndex) =>
          writeCell(`${columnLetter(columnIndex + 1)}${row}`, cell, "body"),
        ),
      );
    });
    lastDataRow = rowNumber;

    if (!section.table.rows.length && section.emptyMessage) {
      const row = rowNumber + 1;
      pushRow([inlineCell(`A${row}`, section.emptyMessage, STYLE.NOTE)]);
      lastDataRow = rowNumber;
    }

    if (section.table.totals) {
      // A blank line first, so the totals row sits OUTSIDE the autofilter range
      // computed above. Inside it, applying any filter hides the totals — which
      // is how a reader ends up with a filtered table and a total that silently
      // vanished rather than one that no longer matches.
      pushBlank();
      const row = rowNumber + 1;
      pushRow(
        section.table.totals.map((cell, columnIndex) =>
          writeCell(`${columnLetter(columnIndex + 1)}${row}`, cell, "total"),
        ),
      );
    }
  } else if (section.emptyMessage) {
    pushBlank();
    pushTextRow(section.emptyMessage, STYLE.NOTE);
  }

  const cols = section.table
    ? `<cols>${section.table.columns
        .map(
          (col, index) =>
            `<col min="${index + 1}" max="${index + 1}" width="${Math.min(60, Math.max(8, col.width + 2))}" customWidth="1"/>`,
        )
        .join("")}</cols>`
    : `<cols><col min="1" max="1" width="46" customWidth="1"/><col min="2" max="2" width="44" customWidth="1"/></cols>`;

  const freeze = headerRow
    ? `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${headerRow + 1}" sqref="A${headerRow + 1}"/>`
    : "";
  const filter =
    headerRow && lastDataRow > headerRow
      ? `<autoFilter ref="A${headerRow}:${columnLetter(columnCount)}${lastDataRow}"/>`
      : "";

  const lastRow = Math.max(rowNumber, 1);
  const xml = `${XML_DECLARATION}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${columnLetter(columnCount)}${lastRow}"/>
<sheetViews><sheetView workbookViewId="0" showGridLines="0">${freeze}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols}
<sheetData>${rows.join("")}</sheetData>
${filter}
</worksheet>`;

  return { xml, name: section.sheetName };
}

/* ── Sheet names ─────────────────────────────────────────────────────────── */

/**
 * Excel refuses `: \ / ? * [ ]`, an empty name, a name over 31 characters and
 * two sheets with the same name — and it refuses the whole workbook, not the
 * sheet. The section names in `document-model.ts` are all legal today; this is
 * here so that they still are when somebody adds a fourteenth.
 */
export function safeSheetName(name: string, taken: Set<string>): string {
  const base = name.replace(/[:\\/?*[\]]/g, "-").trim().slice(0, 31) || "Sheet";
  let candidate = base;
  let counter = 2;
  while (taken.has(candidate.toLowerCase())) {
    const suffix = ` (${counter})`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    counter += 1;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/* ── The package ─────────────────────────────────────────────────────────── */

export function renderXlsx(payload: CombinedReportPayload): Uint8Array {
  const document = buildReportDocument(payload);
  // "internal" — the workbook is the owner's copy. See `buildSheet`.
  const sections = sectionsFor(document, "internal");

  const taken = new Set<string>();
  const sheets = sections.map((section) => {
    const built = buildSheet(section, document);
    return { ...built, name: safeSheetName(built.name, taken) };
  });

  const sheetEntries = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${xmlText(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("");

  const workbook = `${XML_DECLARATION}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr/>
<sheets>${sheetEntries}</sheets>
</workbook>`;

  const stylesRelId = `rId${sheets.length + 1}`;
  const workbookRels = `${XML_DECLARATION}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets
  .map(
    (_sheet, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  )
  .join("\n")}
<Relationship Id="${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const contentTypes = `${XML_DECLARATION}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets
  .map(
    (_sheet, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  )
  .join("\n")}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const rootRels = `${XML_DECLARATION}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const core = `${XML_DECLARATION}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlText(`${document.title} — ${document.clientName}`)}</dc:title>
<dc:creator>MAINTSUPP</dc:creator>
<cp:lastModifiedBy>MAINTSUPP</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${xmlText(payload.generatedAt)}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${xmlText(payload.generatedAt)}</dcterms:modified>
</cp:coreProperties>`;

  const zip = new ZipWriter();
  zip.addFile("[Content_Types].xml", contentTypes);
  zip.addFile("_rels/.rels", rootRels);
  zip.addFile("docProps/core.xml", core);
  zip.addFile("xl/workbook.xml", workbook);
  zip.addFile("xl/_rels/workbook.xml.rels", workbookRels);
  zip.addFile("xl/styles.xml", stylesXml(payload.invoice.currency));
  sheets.forEach((sheet, index) => {
    zip.addFile(`xl/worksheets/sheet${index + 1}.xml`, sheet.xml);
  });
  return zip.toUint8Array();
}

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
