/**
 * The combined document as real WordprocessingML.
 *
 * Not HTML with a `.docx` extension, not RTF, not a rich-text blob: a genuine
 * OOXML package with a styles part, real `w:tbl` tables and two page sections.
 * The reason is prosaic — the owner sends this to a client, and the client
 * opens it in Word and edits the covering note. A file that Word offers to
 * "repair" before opening is not a deliverable, and one that opens as a wall of
 * fixed-width text is not either.
 *
 * TWO PAGE SECTIONS, PORTRAIT THEN LANDSCAPE
 *
 * Part 1 is an invoice — a page of key/value lines and a short totals table,
 * which reads correctly in portrait and looks wrong in landscape. Part 2 is a
 * performance report whose Full Job Log is sixteen columns wide, and sixteen
 * columns on A4 portrait is unreadable at any font size. WordprocessingML lets
 * one document hold both: a `w:sectPr` inside the last paragraph of part 1 ends
 * that section portrait, and the body-level `w:sectPr` makes the remainder
 * landscape. This is the feature working as intended rather than a trick.
 *
 * WIDTHS ARE COMPUTED, NOT GUESSED
 *
 * Every column carries a width in characters in `document-model.ts`, and this
 * writer scales those proportionally to the printable width of whichever page
 * section the table is on. A table with `tblW` set to 100% and no grid lets
 * Word distribute columns by content, which puts a 40-character issue
 * description in a sliver next to a wide empty date column.
 *
 * NO INTERNAL CONTENT. `sectionsFor(document, "all")` is what is walked, so the
 * internal note and the internal reference never reach a client-facing file.
 * That rule lives on the content in `document-model.ts`; this file only obeys
 * it, which is why the PDF writer obeys the same one without a second copy.
 */

import type { CombinedReportPayload } from "../reporting/contract";
import { buildReportDocument, keyValuesFor, sectionsFor } from "./document-model";
import type { DocCell, DocSection, DocTable, ReportDocument } from "./document-model";
import { ZipWriter } from "./zip";
import { XML_DECLARATION, xmlText } from "./xml";

/* ── Page geometry, in twentieths of a point ─────────────────────────────── */

const A4_SHORT = 11906;
const A4_LONG = 16838;
const MARGIN = 1134; // 2cm
const PORTRAIT_WIDTH = A4_SHORT - MARGIN * 2;
const LANDSCAPE_WIDTH = A4_LONG - MARGIN * 2;

/* ── Runs and paragraphs ─────────────────────────────────────────────────── */

interface RunOptions {
  bold?: boolean;
  size?: number; // half-points
  color?: string;
  italic?: boolean;
}

function run(text: string, options: RunOptions = {}): string {
  const properties: string[] = [];
  if (options.bold) properties.push("<w:b/>");
  if (options.italic) properties.push("<w:i/>");
  if (options.color) properties.push(`<w:color w:val="${options.color}"/>`);
  if (options.size) properties.push(`<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>`);
  const rPr = properties.length ? `<w:rPr>${properties.join("")}</w:rPr>` : "";
  // xml:space="preserve" or Word eats a leading or trailing space, which turns
  // "Total  " into "Total" and quietly changes an aligned column.
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`;
}

function paragraph(
  content: string,
  options: { style?: string; align?: string; spacingAfter?: number; keepNext?: boolean } = {},
): string {
  const properties: string[] = [];
  if (options.style) properties.push(`<w:pStyle w:val="${options.style}"/>`);
  if (options.keepNext) properties.push("<w:keepNext/>");
  if (options.spacingAfter !== undefined) {
    properties.push(`<w:spacing w:after="${options.spacingAfter}"/>`);
  }
  if (options.align) properties.push(`<w:jc w:val="${options.align}"/>`);
  const pPr = properties.length ? `<w:pPr>${properties.join("")}</w:pPr>` : "";
  return `<w:p>${pPr}${content}</w:p>`;
}

const emptyParagraph = () => "<w:p/>";

/* ── Tables ──────────────────────────────────────────────────────────────── */

const HEADER_FILL = "0B7A72"; // --brand-solid, so the file looks like the product
const TOTAL_FILL = "EAF0F3";
const GROUP_FILL = "F0F5F6";

function cellAlignment(align: string): string {
  return align === "right" ? "right" : align === "center" ? "center" : "left";
}

/**
 * One cell.
 *
 * THE ORDER OF THE `w:tcPr` CHILDREN IS NOT COSMETIC. `CT_TcPr` is an
 * xsd:sequence — tcW, then gridSpan, then shd, then vAlign — and Word does not
 * ignore a child in the wrong position, it declares the whole document corrupt
 * and offers to repair it. The same is true of `w:trPr` (cantSplit before
 * tblHeader) and `w:pPr` (pBdr before spacing) further down. Every one of those
 * three was written the intuitive way first and every one of them is a file
 * that will not open, so the sequence is spelled out here rather than left to
 * whoever edits this next.
 */
function tableCell(
  text: string,
  widthTwips: number,
  options: {
    bold?: boolean;
    align?: string;
    fill?: string;
    color?: string;
    size?: number;
    gridSpan?: number;
  } = {},
): string {
  const shading = options.fill
    ? `<w:shd w:val="clear" w:color="auto" w:fill="${options.fill}"/>`
    : "";
  const span = options.gridSpan ? `<w:gridSpan w:val="${options.gridSpan}"/>` : "";
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${widthTwips}" w:type="dxa"/>${span}${shading}` +
    `<w:vAlign w:val="center"/></w:tcPr>` +
    paragraph(run(text, { bold: options.bold, color: options.color, size: options.size ?? 16 }), {
      style: "TableText",
      align: cellAlignment(options.align ?? "left"),
    }) +
    "</w:tc>"
  );
}

function toneColour(tone: DocCell["tone"]): string | undefined {
  if (tone === "blocking") return "C73535";
  if (tone === "warning") return "B26A00";
  if (tone === "good") return "0B7A72";
  return undefined;
}

function renderTable(table: DocTable, printableWidth: number): string {
  const totalChars = table.columns.reduce((sum, col) => sum + col.width, 0) || 1;
  const widths = table.columns.map((col) =>
    Math.max(500, Math.round((col.width / totalChars) * printableWidth)),
  );

  const grid = `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>`;
  const borders =
    "<w:tblBorders>" +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="C8D3DA"/>`)
      .join("") +
    "</w:tblBorders>";
  const properties =
    "<w:tblPr><w:tblStyle w:val=\"ReportTable\"/>" +
    `<w:tblW w:w="${widths.reduce((sum, width) => sum + width, 0)}" w:type="dxa"/>` +
    borders +
    '<w:tblLayout w:type="fixed"/>' +
    '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/>' +
    '<w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar>' +
    "</w:tblPr>";

  // `tblHeader` repeats the header row on every page the table spills onto. A
  // 700-row job log without it is six pages of unlabelled columns.
  const header =
    '<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>' +
    table.columns
      .map((col, index) =>
        tableCell(col.header, widths[index]!, {
          bold: true,
          align: col.align,
          fill: HEADER_FILL,
          color: "FFFFFF",
        }),
      )
      .join("") +
    "</w:tr>";

  const groupStarts = new Map<number, string>();
  for (const group of table.groups ?? []) groupStarts.set(group.from, group.label);

  const body = table.rows
    .map((cells, rowIndex) => {
      const groupRow = groupStarts.has(rowIndex)
        ? `<w:tr><w:trPr><w:cantSplit/></w:trPr>` +
          tableCell(groupStarts.get(rowIndex)!, widths.reduce((sum, w) => sum + w, 0), {
            bold: true,
            fill: GROUP_FILL,
            gridSpan: table.columns.length,
          }) +
          "</w:tr>"
        : "";
      const row =
        "<w:tr>" +
        cells
          .map((cell, index) =>
            tableCell(cell.text, widths[index] ?? 800, {
              bold: cell.emphasis,
              align: table.columns[index]?.align,
              color: toneColour(cell.tone),
            }),
          )
          .join("") +
        "</w:tr>";
      return groupRow + row;
    })
    .join("");

  const totals = table.totals
    ? "<w:tr>" +
      table.totals
        .map((cell, index) =>
          tableCell(cell.text, widths[index] ?? 800, {
            bold: true,
            align: table.columns[index]?.align,
            fill: TOTAL_FILL,
          }),
        )
        .join("") +
      "</w:tr>"
    : "";

  return `<w:tbl>${properties}${grid}${header}${body}${totals}</w:tbl>`;
}

/* ── Sections ────────────────────────────────────────────────────────────── */

function renderSection(section: DocSection, printableWidth: number): string {
  const blocks: string[] = [
    paragraph(run(`${section.number}. ${section.title}`), {
      style: "Heading2",
      keepNext: true,
    }),
  ];
  if (section.note) {
    blocks.push(paragraph(run(section.note, { italic: true, size: 16, color: "4E5F6F" })));
  }
  for (const line of section.paragraphs) blocks.push(paragraph(run(line)));

  const keyValues = keyValuesFor(section, "all");
  if (keyValues.length) {
    blocks.push(
      renderTable(
        {
          columns: [
            { key: "label", header: "Field", kind: "text", align: "left", width: 26 },
            { key: "value", header: "Value", kind: "text", align: "left", width: 44 },
          ],
          rows: keyValues.map((entry) => [
            { kind: "text" as const, text: entry.label, value: null },
            { kind: "text" as const, text: entry.value, value: null, emphasis: entry.emphasis },
          ]),
          totals: null,
        },
        printableWidth,
      ),
      emptyParagraph(),
    );
  }

  if (section.table && section.table.rows.length) {
    blocks.push(renderTable(section.table, printableWidth));
  } else if (section.table && section.emptyMessage) {
    blocks.push(paragraph(run(section.emptyMessage, { italic: true, color: "4E5F6F" })));
  }
  blocks.push(emptyParagraph());
  return blocks.join("");
}

function sectionProperties(landscape: boolean): string {
  const width = landscape ? A4_LONG : A4_SHORT;
  const height = landscape ? A4_SHORT : A4_LONG;
  return (
    "<w:sectPr>" +
    `<w:pgSz w:w="${width}" w:h="${height}"${landscape ? ' w:orient="landscape"' : ""}/>` +
    `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" ` +
    'w:header="708" w:footer="708" w:gutter="0"/>' +
    "</w:sectPr>"
  );
}

/* ── The package ─────────────────────────────────────────────────────────── */

const STYLES = `${XML_DECLARATION}
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
<w:sz w:val="20"/><w:szCs w:val="20"/><w:color w:val="132537"/>
</w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="252" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="120"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/><w:color w:val="0B7A72"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/>
<w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="4E5F6F"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/>
<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="4" w:color="0B7A72"/></w:pBdr>
<w:spacing w:before="320" w:after="160"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/><w:color w:val="0B7A72"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:spacing w:before="260" w:after="120"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/><w:color w:val="132537"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>
<w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="ReportTable"><w:name w:val="Report Table"/>
<w:tblPr><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/>
<w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

const CONTENT_TYPES = `${XML_DECLARATION}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const ROOT_RELS = `${XML_DECLARATION}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `${XML_DECLARATION}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

function coreProperties(document: ReportDocument, generatedAtIso: string): string {
  return `${XML_DECLARATION}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlText(`${document.title} — ${document.clientName}`)}</dc:title>
<dc:subject>${xmlText(`${document.periodStart} to ${document.periodEnd}`)}</dc:subject>
<dc:creator>MAINTSUPP</dc:creator>
<cp:lastModifiedBy>MAINTSUPP</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${xmlText(generatedAtIso)}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${xmlText(generatedAtIso)}</dcterms:modified>
</cp:coreProperties>`;
}

const APP_PROPERTIES = `${XML_DECLARATION}
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>MAINTSUPP Operations Platform</Application>
<Company>MAINTSUPP</Company>
</Properties>`;

/* ── The entry point ─────────────────────────────────────────────────────── */

export function renderDocx(payload: CombinedReportPayload): Uint8Array {
  const document = buildReportDocument(payload);
  const sections = sectionsFor(document, "all");

  const cover: string[] = [
    paragraph(run(document.title), { style: "Title" }),
    paragraph(
      run(
        `${document.clientName} · ${document.periodLabel} · ${document.periodStart} to ${document.periodEnd}`,
      ),
      { style: "Subtitle" },
    ),
    paragraph(
      run(
        `Invoice ${document.invoiceNumber} · Status ${document.status} · Prepared by ${document.organisationName} · Generated ${document.generatedAt}`,
        { size: 18, color: "4E5F6F" },
      ),
    ),
    emptyParagraph(),
  ];

  const partOne = sections.filter((section) => section.part === 1);
  const partTwo = sections.filter((section) => section.part === 2);

  const body: string[] = [...cover];
  body.push(paragraph(run(document.parts[0]!.title), { style: "Heading1" }));
  body.push(paragraph(run(document.parts[0]!.subtitle, { italic: true, color: "4E5F6F" })));
  for (const section of partOne) body.push(renderSection(section, PORTRAIT_WIDTH));

  // The paragraph that ENDS the portrait section. Everything above it is A4
  // portrait; everything after it takes the body-level landscape properties.
  body.push(`<w:p><w:pPr>${sectionProperties(false)}</w:pPr></w:p>`);

  body.push(paragraph(run(document.parts[1]!.title), { style: "Heading1" }));
  body.push(paragraph(run(document.parts[1]!.subtitle, { italic: true, color: "4E5F6F" })));
  for (const section of partTwo) body.push(renderSection(section, LANDSCAPE_WIDTH));

  const documentXml = `${XML_DECLARATION}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}${sectionProperties(true)}</w:body></w:document>`;

  const zip = new ZipWriter();
  zip.addFile("[Content_Types].xml", CONTENT_TYPES);
  zip.addFile("_rels/.rels", ROOT_RELS);
  zip.addFile("docProps/core.xml", coreProperties(document, payload.generatedAt));
  zip.addFile("docProps/app.xml", APP_PROPERTIES);
  zip.addFile("word/_rels/document.xml.rels", DOCUMENT_RELS);
  zip.addFile("word/styles.xml", STYLES);
  zip.addFile("word/document.xml", documentXml);
  return zip.toUint8Array();
}

export const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
