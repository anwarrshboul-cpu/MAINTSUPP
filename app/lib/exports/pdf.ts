/**
 * The combined document as a real, print-ready PDF.
 *
 * WHY THIS IS WRITTEN BY HAND
 *
 * Same reason as the ZIP: this runs on the Cloudflare Workers runtime, and the
 * PDF libraries all want Node. `pdfkit` is built on Node streams and `zlib`;
 * `puppeteer` is a browser. The other option was a print stylesheet the reader
 * prints from the browser — which produces a good-looking page but is not an
 * export, because the file the owner attaches to an email has to exist on the
 * server, be recorded in the export history, and be identical for everyone who
 * downloads it. A browser print is none of those things.
 *
 * A PDF is a plain-text object graph with a byte-offset index at the end, and
 * text is placed with an absolute matrix in a content stream. With the base-14
 * fonts — no font file to embed, no font descriptor, no CMap — that is a few
 * hundred lines, and every one of them is a line whose failure mode is visible
 * rather than a dependency whose failure mode is a 500 on the deployment.
 *
 * WHAT IT ACTUALLY DOES
 *
 *  - A4, portrait for the invoice and landscape for the report, one MediaBox
 *    per page, exactly as the Word file switches orientation.
 *  - Real pagination: a table that does not fit breaks across pages and REPEATS
 *    its header row, with the section title marked "(continued)".
 *  - Real table layout: proportional columns, right-aligned money, wrapped and
 *    then truncated text — measured against the font metrics in `pdf-font.ts`,
 *    so nothing silently prints over the column next to it.
 *  - Header and footer on every page, and the footer says "Page 3 of 11",
 *    which needs the page count, which is why pages are laid out completely
 *    before any of them is serialised.
 *
 * NO COMPRESSION. `/Filter /FlateDecode` would roughly halve the file, and
 * would make the content streams unreadable to the test that checks them. An
 * uncompressed content stream is valid PDF; see the note in `zip.ts` about the
 * same trade.
 */

import type { CombinedReportPayload, DocumentKind } from "../reporting/contract";
import { buildReportDocument, keyValuesFor, sectionsFor } from "./document-model";
import type { DocCell, DocSection, DocTable, ReportDocument } from "./document-model";
import { encodeWinAnsi, measure, truncateToWidth, wrapToWidth } from "./pdf-font";
import type { PdfFont } from "./pdf-font";

/* ── Geometry, in points ─────────────────────────────────────────────────── */

const A4_SHORT = 595.28;
const A4_LONG = 841.89;
const MARGIN = 36;
const HEADER_HEIGHT = 46;
const FOOTER_HEIGHT = 28;

const TITLE_SIZE = 20;
const HEADING_SIZE = 13;
const BODY_SIZE = 9;
const TABLE_SIZE = 7;
const SMALL_SIZE = 7.5;

const ROW_LEADING = 2.6;
const MAX_CELL_LINES = 3;

/* ── Colours, as PDF fill operands ───────────────────────────────────────── */

const INK = "0.075 0.145 0.216";
const MUTED = "0.306 0.373 0.435";
const BRAND = "0.043 0.478 0.447";
const DANGER = "0.780 0.208 0.208";
const WARN = "0.698 0.416 0.000";
const HEADER_BG = "0.043 0.478 0.447";
const TOTAL_BG = "0.918 0.941 0.953";
const GROUP_BG = "0.941 0.961 0.965";
const RULE = "0.784 0.827 0.855";
const WHITE = "1 1 1";

/* ── The content-stream builder ──────────────────────────────────────────── */

/**
 * One page's operators.
 *
 * The stream is assembled as a string of characters in the 0-255 range and
 * encoded to bytes at the very end, because PDF literal strings are BYTES, not
 * text: `£` is the single byte 0xA3, and running the finished stream through
 * `TextEncoder` would emit it as the two bytes of UTF-8 and print "Â£".
 */
class Content {
  private readonly ops: string[] = [];

  fill(colour: string) {
    this.ops.push(`${colour} rg`);
    return this;
  }

  stroke(colour: string) {
    this.ops.push(`${colour} RG`);
    return this;
  }

  rect(x: number, y: number, width: number, height: number, colour: string) {
    this.ops.push(`q ${colour} rg ${n(x)} ${n(y)} ${n(width)} ${n(height)} re f Q`);
    return this;
  }

  line(x1: number, y1: number, x2: number, y2: number, colour = RULE, width = 0.5) {
    this.ops.push(
      `q ${colour} RG ${n(width)} w ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S Q`,
    );
    return this;
  }

  text(
    value: string,
    x: number,
    y: number,
    options: { font?: PdfFont; size?: number; colour?: string } = {},
  ) {
    if (!value) return this;
    const font = options.font === "bold" ? "/F2" : "/F1";
    const size = options.size ?? BODY_SIZE;
    this.ops.push(
      `q ${options.colour ?? INK} rg BT ${font} ${n(size)} Tf 1 0 0 1 ${n(x)} ${n(y)} Tm (${literal(value)}) Tj ET Q`,
    );
    return this;
  }

  toBytes(): Uint8Array {
    const joined = `${this.ops.join("\n")}\n`;
    const bytes = new Uint8Array(joined.length);
    for (let index = 0; index < joined.length; index += 1) {
      bytes[index] = joined.charCodeAt(index) & 0xff;
    }
    return bytes;
  }
}

/** Numbers, short. PDF has no need for seventeen significant figures. */
function n(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * A PDF literal string.
 *
 * `(`, `)` and `\` are the three characters that terminate or escape a literal,
 * and an unescaped `)` in a site name ends the string early — after which the
 * rest of the page is read as operators and the file is unopenable. The text is
 * WinAnsi-encoded first, so what is escaped is what is actually written.
 */
function literal(text: string): string {
  let out = "";
  for (const byte of encodeWinAnsi(text)) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else out += String.fromCharCode(byte);
  }
  return out;
}

/* ── Pages ───────────────────────────────────────────────────────────────── */

interface Page {
  width: number;
  height: number;
  content: Content;
}

class Layout {
  readonly pages: Page[] = [];
  private page!: Page;
  private cursor = 0;
  private landscape = false;
  /**
   * Assigned in the body rather than declared as a constructor parameter
   * property. Node's type stripping is strip-only — it removes annotations and
   * emits nothing — so `constructor(private readonly document: …)` is a syntax
   * error there, and `tests/` load this module through Node, not through Vite.
   */
  private readonly document: ReportDocument;

  constructor(document: ReportDocument) {
    this.document = document;
  }

  get width() {
    return this.page.width;
  }

  get printable() {
    return this.page.width - MARGIN * 2;
  }

  get y() {
    return this.cursor;
  }

  get current() {
    return this.page.content;
  }

  get bottom() {
    return MARGIN + FOOTER_HEIGHT;
  }

  newPage(landscape = this.landscape) {
    this.landscape = landscape;
    const page: Page = {
      width: landscape ? A4_LONG : A4_SHORT,
      height: landscape ? A4_SHORT : A4_LONG,
      content: new Content(),
    };
    this.pages.push(page);
    this.page = page;
    this.cursor = page.height - MARGIN - HEADER_HEIGHT;
    this.drawRunningHeader();
    return page;
  }

  /** Room for `height` points, or a new page first. Returns true if it broke. */
  ensure(height: number): boolean {
    if (this.cursor - height >= this.bottom) return false;
    this.newPage();
    return true;
  }

  advance(height: number) {
    this.cursor -= height;
  }

  private drawRunningHeader() {
    const page = this.page;
    const top = page.height - MARGIN;
    page.content
      .text(this.document.title, MARGIN, top - 11, {
        font: "bold",
        size: 10,
        colour: BRAND,
      })
      .text(
        `${this.document.clientName} · ${this.document.periodStart} to ${this.document.periodEnd} · Invoice ${this.document.invoiceNumber}`,
        MARGIN,
        top - 23,
        { size: SMALL_SIZE, colour: MUTED },
      )
      .line(MARGIN, top - 30, page.width - MARGIN, top - 30, RULE, 0.7);
  }
}

/* ── Table drawing ───────────────────────────────────────────────────────── */

function toneColour(tone: DocCell["tone"]): string {
  if (tone === "blocking") return DANGER;
  if (tone === "warning") return WARN;
  if (tone === "good") return BRAND;
  return INK;
}

function columnWidths(table: DocTable, printable: number): number[] {
  const total = table.columns.reduce((sum, col) => sum + col.width, 0) || 1;
  return table.columns.map((col) => (col.width / total) * printable);
}

function cellLines(cell: DocCell, width: number, font: PdfFont): string[] {
  const usable = width - 6;
  if (cell.kind === "text") return wrapToWidth(cell.text, font, TABLE_SIZE, usable, MAX_CELL_LINES);
  return [truncateToWidth(cell.text, font, TABLE_SIZE, usable)];
}

function rowHeight(lines: number): number {
  return lines * (TABLE_SIZE + ROW_LEADING) + 4;
}

/**
 * How tall a row will be, without drawing it.
 *
 * Separate from `drawRow` because a table has to know whether the NEXT row
 * fits before it commits to the current page — if it finds out during the draw
 * it has already written the row and cannot put a header above it. A content
 * stream is append-only.
 */
function measureRow(cells: DocCell[], widths: number[], bold: boolean): number {
  const font: PdfFont = bold ? "bold" : "regular";
  const lines = Math.max(
    1,
    ...cells.map((cell, index) => cellLines(cell, widths[index] ?? 60, font).length),
  );
  return rowHeight(lines);
}

function drawRow(
  layout: Layout,
  cells: DocCell[],
  widths: number[],
  aligns: Array<"left" | "right" | "center">,
  options: { bold?: boolean; fill?: string; colour?: string } = {},
): void {
  const font: PdfFont = options.bold ? "bold" : "regular";
  const wrapped = cells.map((cell, index) => cellLines(cell, widths[index] ?? 60, font));
  const lines = Math.max(1, ...wrapped.map((entry) => entry.length));
  const height = rowHeight(lines);
  layout.ensure(height);
  const top = layout.y;
  const content = layout.current;
  if (options.fill) {
    content.rect(MARGIN, top - height, widths.reduce((sum, w) => sum + w, 0), height, options.fill);
  }
  let x = MARGIN;
  wrapped.forEach((entry, index) => {
    const width = widths[index] ?? 60;
    const align = aligns[index] ?? "left";
    entry.forEach((line, lineIndex) => {
      const textWidth = measure(line, font, TABLE_SIZE);
      const offset =
        align === "right"
          ? width - 3 - textWidth
          : align === "center"
            ? (width - textWidth) / 2
            : 3;
      content.text(line, x + offset, top - 3 - TABLE_SIZE - lineIndex * (TABLE_SIZE + ROW_LEADING), {
        font,
        size: TABLE_SIZE,
        colour: options.colour ?? toneColour(cells[index]?.tone),
      });
    });
    x += width;
  });
  content.line(MARGIN, top - height, x, top - height, RULE, 0.4);
  layout.advance(height);
}

function drawHeaderRow(layout: Layout, table: DocTable, widths: number[]): void {
  const cells: DocCell[] = table.columns.map((col) => ({
    kind: "text",
    text: col.header,
    value: null,
  }));
  drawRow(
    layout,
    cells,
    widths,
    table.columns.map((col) => col.align),
    { bold: true, fill: HEADER_BG, colour: WHITE },
  );
}

/**
 * A table, paginated, with its header repeated on every page it reaches.
 *
 * The break is decided BEFORE each row is drawn, not discovered during it. A
 * content stream can only be appended to, so a header that turns out to be
 * needed after the first row of a page is already on it cannot be put above
 * that row — the page would have to be rebuilt. Measuring first is a few lines
 * and it is the difference between "Full Job Log continued" over labelled
 * columns and four pages of anonymous ones.
 */
function drawTable(layout: Layout, table: DocTable, sectionTitle: string): void {
  const widths = columnWidths(table, layout.printable);
  const aligns = table.columns.map((col) => col.align);
  const fullWidth = widths.reduce((sum, width) => sum + width, 0);

  const startPage = () => {
    layout.current.text(`${sectionTitle} (continued)`, MARGIN, layout.y - HEADING_SIZE + 2, {
      font: "bold",
      size: HEADING_SIZE - 2,
      colour: MUTED,
    });
    layout.advance(HEADING_SIZE + 4);
    drawHeaderRow(layout, table, widths);
  };

  drawHeaderRow(layout, table, widths);

  const groupStarts = new Map<number, string>();
  for (const group of table.groups ?? []) groupStarts.set(group.from, group.label);

  table.rows.forEach((cells, index) => {
    const groupLabel = groupStarts.get(index);
    const groupCells: DocCell[] | null = groupLabel
      ? [{ kind: "text", text: groupLabel, value: null }]
      : null;
    const needed =
      measureRow(cells, widths, false) +
      (groupCells ? measureRow(groupCells, [fullWidth], true) : 0);

    if (layout.y - needed < layout.bottom) {
      layout.newPage();
      startPage();
    }
    if (groupCells) {
      drawRow(layout, groupCells, [fullWidth], ["left"], { bold: true, fill: GROUP_BG });
    }
    drawRow(layout, cells, widths, aligns);
  });

  if (table.totals) {
    const needed = measureRow(table.totals, widths, true);
    if (layout.y - needed < layout.bottom) {
      layout.newPage();
      startPage();
    }
    drawRow(layout, table.totals, widths, aligns, { bold: true, fill: TOTAL_BG });
  }
}

/* ── Sections ────────────────────────────────────────────────────────────── */

function drawParagraph(
  layout: Layout,
  text: string,
  options: { font?: PdfFont; size?: number; colour?: string; gap?: number } = {},
): void {
  const size = options.size ?? BODY_SIZE;
  const lines = wrapToWidth(text, options.font ?? "regular", size, layout.printable, 40);
  for (const line of lines) {
    layout.ensure(size + 4);
    layout.current.text(line, MARGIN, layout.y - size, {
      font: options.font,
      size,
      colour: options.colour,
    });
    layout.advance(size + 3);
  }
  layout.advance(options.gap ?? 4);
}

function drawSection(layout: Layout, section: DocSection): void {
  layout.ensure(48);
  layout.current.text(`${section.number}. ${section.title}`, MARGIN, layout.y - HEADING_SIZE, {
    font: "bold",
    size: HEADING_SIZE,
    colour: INK,
  });
  layout.advance(HEADING_SIZE + 6);
  layout.current.line(MARGIN, layout.y + 2, MARGIN + layout.printable, layout.y + 2, RULE, 0.7);
  layout.advance(6);

  if (section.note) {
    drawParagraph(layout, section.note, { size: SMALL_SIZE, colour: MUTED });
  }
  for (const line of section.paragraphs) drawParagraph(layout, line);

  const keyValues = keyValuesFor(section, "all");
  if (keyValues.length) {
    const labelWidth = Math.min(170, layout.printable * 0.32);
    for (const entry of keyValues) {
      const valueLines = wrapToWidth(
        entry.value,
        entry.emphasis ? "bold" : "regular",
        BODY_SIZE,
        layout.printable - labelWidth - 8,
        3,
      );
      const height = valueLines.length * (BODY_SIZE + 3) + 2;
      layout.ensure(height);
      const top = layout.y;
      layout.current.text(entry.label, MARGIN, top - BODY_SIZE, {
        size: BODY_SIZE,
        colour: MUTED,
      });
      valueLines.forEach((line, index) => {
        layout.current.text(line, MARGIN + labelWidth, top - BODY_SIZE - index * (BODY_SIZE + 3), {
          font: entry.emphasis ? "bold" : "regular",
          size: BODY_SIZE,
        });
      });
      layout.advance(height);
    }
    layout.advance(6);
  }

  if (section.table && section.table.rows.length) {
    drawTable(layout, section.table, section.title);
  } else if (section.emptyMessage) {
    drawParagraph(layout, section.emptyMessage, { size: SMALL_SIZE, colour: MUTED });
  }
  layout.advance(12);
}

/* ── Footers ─────────────────────────────────────────────────────────────── */

function drawFooters(layout: Layout, document: ReportDocument): void {
  const total = layout.pages.length;
  layout.pages.forEach((page, index) => {
    const y = MARGIN + 10;
    page.content
      .line(MARGIN, y + 12, page.width - MARGIN, y + 12, RULE, 0.5)
      .text(
        `${document.organisationName} · ${document.status} · Generated ${document.generatedAt}`,
        MARGIN,
        y,
        { size: SMALL_SIZE, colour: MUTED },
      );
    const label = `Page ${index + 1} of ${total}`;
    page.content.text(label, page.width - MARGIN - measure(label, "regular", SMALL_SIZE), y, {
      size: SMALL_SIZE,
      colour: MUTED,
    });
  });
}

/* ── Serialisation ───────────────────────────────────────────────────────── */

const LATIN1 = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
};

function serialise(pages: Page[], title: string, generatedAt: string): Uint8Array {
  const objects: Uint8Array[] = [];
  const add = (body: Uint8Array | string) => {
    objects.push(typeof body === "string" ? LATIN1(body) : body);
    return objects.length; // 1-based object number
  };

  // Fixed objects first, so their numbers are known while pages are written.
  const catalogue = add("");
  const pagesNode = add("");
  const fontRegular = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const fontBold = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  );
  const info = add(
    `<< /Title (${literal(title)}) /Producer (MAINTSUPP Operations Platform) /Creator (MAINTSUPP) /CreationDate (D:${pdfDate(generatedAt)}) >>`,
  );

  const pageNumbers: number[] = [];
  for (const page of pages) {
    const stream = page.content.toBytes();
    const head = LATIN1(`<< /Length ${stream.length} >>\nstream\n`);
    const tail = LATIN1("\nendstream");
    const streamObject = new Uint8Array(head.length + stream.length + tail.length);
    streamObject.set(head, 0);
    streamObject.set(stream, head.length);
    streamObject.set(tail, head.length + stream.length);
    const contentNumber = add(streamObject);
    const pageNumber = add(
      `<< /Type /Page /Parent ${pagesNode} 0 R /MediaBox [0 0 ${n(page.width)} ${n(page.height)}] ` +
        `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> ` +
        `/Contents ${contentNumber} 0 R >>`,
    );
    pageNumbers.push(pageNumber);
  }

  objects[catalogue - 1] = LATIN1(`<< /Type /Catalog /Pages ${pagesNode} 0 R >>`);
  objects[pagesNode - 1] = LATIN1(
    `<< /Type /Pages /Count ${pageNumbers.length} /Kids [${pageNumbers.map((number) => `${number} 0 R`).join(" ")}] >>`,
  );

  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    offset += bytes.length;
  };

  push(LATIN1("%PDF-1.4\n"));
  // A comment of high bytes, which is how a PDF declares itself binary. Without
  // it a naive transfer can treat the file as text and translate line endings.
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    push(LATIN1(`${index + 1} 0 obj\n`));
    push(body);
    push(LATIN1("\nendobj\n"));
  });

  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const entry of offsets) {
    xref += `${String(entry).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogue} 0 R /Info ${info} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  push(LATIN1(xref));

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** `D:YYYYMMDDHHmmSSZ` — the date form a PDF dictionary wants. */
function pdfDate(iso: string): string {
  const stamp = new Date(iso);
  if (Number.isNaN(stamp.getTime())) return "19800101000000Z";
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${stamp.getUTCFullYear()}${pad(stamp.getUTCMonth() + 1)}${pad(stamp.getUTCDate())}` +
    `${pad(stamp.getUTCHours())}${pad(stamp.getUTCMinutes())}${pad(stamp.getUTCSeconds())}Z`
  );
}

/* ── The entry point ─────────────────────────────────────────────────────── */

export function renderPdf(
  payload: CombinedReportPayload,
  kind: DocumentKind = "combined",
): Uint8Array {
  const document = buildReportDocument(payload, kind);
  const sections = sectionsFor(document, "all");
  const layout = new Layout(document);

  layout.newPage(false);
  layout.advance(24);
  drawParagraph(layout, document.title, { font: "bold", size: TITLE_SIZE, colour: BRAND, gap: 2 });
  drawParagraph(layout, document.clientName, { font: "bold", size: 13, gap: 0 });
  drawParagraph(
    layout,
    `${document.periodLabel} · ${document.periodStart} to ${document.periodEnd}`,
    { size: 10, colour: MUTED, gap: 0 },
  );
  drawParagraph(
    layout,
    `Invoice ${document.invoiceNumber} · Status ${document.status} · Prepared by ${document.organisationName} · Generated ${document.generatedAt}`,
    { size: SMALL_SIZE, colour: MUTED, gap: 14 },
  );

  for (const part of document.parts) {
    const inPart = sections.filter((section) => section.part === part.number);
    if (!inPart.length) continue;
    // Part 2 starts a landscape page: its tables are up to sixteen columns and
    // portrait cannot hold them legibly. The invoice stays portrait.
    layout.newPage(part.number === 2);
    layout.current.text(part.title, MARGIN, layout.y - 16, {
      font: "bold",
      size: 16,
      colour: BRAND,
    });
    layout.advance(22);
    drawParagraph(layout, part.subtitle, { size: SMALL_SIZE, colour: MUTED, gap: 10 });
    for (const section of inPart) drawSection(layout, section);
  }

  drawFooters(layout, document);
  return serialise(layout.pages, `${document.title} — ${document.clientName}`, payload.generatedAt);
}

export const PDF_CONTENT_TYPE = "application/pdf";
