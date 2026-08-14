/**
 * A minimal .xlsx reader — enough to read a monday.com board export.
 *
 * WHY NOT A LIBRARY
 *
 * This runs on Cloudflare Workers, where the bundle is size-capped and Node's
 * `zlib` does not exist. SheetJS is around a megabyte and is the single largest
 * thing that would be in the bundle, for one screen that runs once per
 * migration. An .xlsx is a ZIP of XML, `DecompressionStream("deflate-raw")` is
 * in the Workers runtime, and monday's export uses a small, predictable subset
 * of SpreadsheetML — so reading it directly costs about 200 lines and no
 * dependency.
 *
 * WHAT IT SUPPORTS
 *
 *  - ZIP entries stored (method 0) or deflated (method 8), read through the
 *    central directory rather than by scanning for local headers, because a
 *    streamed ZIP puts the sizes in a trailing descriptor the local header
 *    does not have.
 *  - Shared strings, inline strings and plain cell values.
 *  - Sparse rows: monday leaves a cell out entirely when it is empty, so
 *    column letters are decoded rather than positions counted.
 *
 * WHAT IT DOES NOT
 *
 *  - Formulas are read as their cached value, which is what an export carries.
 *  - Dates arrive as the serial number Excel stores; `excelSerialToISO` converts
 *    them. Number formats are not inspected, so the caller decides which
 *    columns are dates — it knows, from the board spec.
 *  - Encrypted or ZIP64 files are rejected with a clear message rather than
 *    read incorrectly.
 */

const TEXT = new TextDecoder();

function u16(view: DataView, offset: number) {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number) {
  return view.getUint32(offset, true);
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/** Reads every entry of a ZIP archive into a name → bytes map. */
async function readZip(data: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // The end-of-central-directory record is last, after a comment of up to
  // 65,535 bytes. Scan backwards for its signature.
  let eocd = -1;
  const limit = Math.max(0, data.length - 66_000);
  for (let index = data.length - 22; index >= limit; index -= 1) {
    if (u32(view, index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("That file is not a valid .xlsx workbook.");
  }

  const entryCount = u16(view, eocd + 10);
  let cursor = u32(view, eocd + 16);
  if (cursor === 0xffffffff) {
    throw new Error("ZIP64 workbooks are not supported. Re-save the file and try again.");
  }

  const files = new Map<string, Uint8Array>();
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (u32(view, cursor) !== 0x02014b50) break;

    const method = u16(view, cursor + 10);
    const flags = u16(view, cursor + 8);
    const compressedSize = u32(view, cursor + 20);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const localOffset = u32(view, cursor + 42);
    const name = TEXT.decode(data.subarray(cursor + 46, cursor + 46 + nameLength));

    if (flags & 0x0001) {
      throw new Error("That workbook is password protected. Remove the password and try again.");
    }

    // The local header repeats the name and extra fields, and its lengths can
    // differ from the central directory's — read them from the local header.
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = data.subarray(start, start + compressedSize);

    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, await inflateRaw(raw));
    // Any other method (bzip2, lzma) is not something Excel writes; skipping
    // keeps one odd entry from failing the whole read.

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function decodeEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    // Ampersand last, or "&amp;lt;" would decode twice.
    .replace(/&amp;/g, "&");
}

/** Shared strings, in index order. A run-formatted cell has several <t> runs. */
function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  for (const [, item] of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    let text = "";
    for (const [, run] of item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
      text += decodeEntities(run);
    }
    strings.push(text);
  }
  return strings;
}

/** "BC" → 54. Column letters are base-26 with no zero. */
function columnIndex(reference: string) {
  const letters = reference.replace(/\d+/g, "");
  let index = 0;
  for (const character of letters) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }
  return index - 1;
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];

  // Matches both `<row …>…</row>` and the self-closing `<row …/>` Excel writes
  // for a blank line. Monday separates groups with blank lines, so dropping the
  // self-closing form would run every group's items together.
  for (const match of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowXml = match[1] ?? "";
    const cells: string[] = [];
    for (const [, attributes, body] of rowXml.matchAll(
      /<c\b([^>]*)>([\s\S]*?)<\/c>/g,
    )) {
      const reference = /r="([A-Z]+)\d+"/.exec(attributes)?.[1] ?? "";
      const type = /t="([^"]+)"/.exec(attributes)?.[1] ?? "n";

      let value = "";
      if (type === "s") {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
        value = shared[Number(raw)] ?? "";
      } else if (type === "inlineStr") {
        for (const [, run] of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
          value += decodeEntities(run);
        }
      } else {
        value = decodeEntities(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
      }

      const at = reference ? columnIndex(reference) : cells.length;
      while (cells.length < at) cells.push("");
      cells[at] = value;
    }

    rows.push(cells);
  }

  return rows;
}

export type Sheet = { name: string; rows: string[][] };

/** Reads the first worksheet of an .xlsx workbook. */
export async function readXlsx(data: Uint8Array): Promise<Sheet> {
  const files = await readZip(data);

  const sharedEntry = files.get("xl/sharedStrings.xml");
  const shared = sharedEntry ? parseSharedStrings(TEXT.decode(sharedEntry)) : [];

  // Prefer sheet1; fall back to whichever worksheet exists.
  const sheetName =
    [...files.keys()]
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      .sort()[0] ?? "";
  const sheetEntry = sheetName ? files.get(sheetName) : undefined;
  if (!sheetEntry) {
    throw new Error("That workbook has no worksheets.");
  }

  const workbookEntry = files.get("xl/workbook.xml");
  const title = workbookEntry
    ? /<sheet[^>]*name="([^"]*)"/.exec(TEXT.decode(workbookEntry))?.[1]
    : undefined;

  return {
    name: title ? decodeEntities(title) : "Sheet1",
    rows: parseSheet(TEXT.decode(sheetEntry), shared),
  };
}

/**
 * Excel stores a date as days since 1899-12-30 — not 1900-01-01, because Excel
 * reproduces a Lotus 1-2-3 bug that treats 1900 as a leap year.
 */
export function excelSerialToISO(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const milliseconds = Math.round((serial - 25_569) * 86_400_000);
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/**
 * Parses a delimited file. Monday's CSV export quotes any field containing a
 * comma, quote or newline, and doubles an embedded quote.
 */
export function parseDelimited(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') quoted = true;
    else if (character === delimiter) {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
