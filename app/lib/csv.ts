/**
 * Minimal RFC 4180 CSV reader and writer.
 *
 * Written by hand rather than pulled from npm because the Workers runtime has
 * no Node built-ins and every dependency added here ships to the edge.
 * Handles quoted fields, escaped quotes, embedded commas and newlines, and both
 * CRLF and LF line endings, which is the full set that Excel produces.
 */

export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;

  // Excel writes a UTF-8 byte-order mark; left in place it corrupts the first
  // header name and every column lookup fails silently.
  const text = input.replace(/^\uFEFF/, "");

  while (index < text.length) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\r") {
      index += 1;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((cell) => cell.trim().length));
}

export function parseCsvObjects(input: string): Array<Record<string, string>> {
  const rows = parseCsv(input);
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, position) => {
      record[header] = (cells[position] ?? "").trim();
    });
    return record;
  });
}

/** Exactly a number: optional sign, digits, optional single decimal part. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** The characters a spreadsheet treats as the start of a formula. */
const FORMULA_STARTERS = ["=", "+", "-", "@", "\t", "\r"];

/**
 * A CELL THAT LOOKS LIKE A FORMULA IS MADE TO LOOK LIKE TEXT.
 *
 * Every export this writer produces is meant to be opened in Excel, and Excel
 * executes a cell beginning `=`, `+`, `-`, `@`, tab or carriage return. The
 * content of those cells is not ours: `POST /api/report-job` takes a title from
 * an ANONYMOUS visitor — `scopedDb(request, { allowAnonymous: true })`, filed
 * onto the primary organisation's Jobs board — and `submissionTitle` trims it
 * and cuts it to 200 characters without touching a single character. So a
 * stranger could put `=cmd|'/c calc'!A0` on the board and wait for somebody to
 * export it; the payload runs on the reader's machine, not the server, which is
 * why nothing on the way in ever noticed.
 *
 * A leading apostrophe is the neutralisation every spreadsheet understands.
 * `PLAIN_NUMBER` is checked first so that a negative cost stays a number a
 * spreadsheet can add up — `-` is both a formula starter and a minus sign, and
 * quoting every negative figure as text would break the arithmetic these
 * exports exist for.
 *
 * The same rule, character for character, is in `finance/exports.ts`, and the
 * two are deliberately not shared: the finance analytics suite transpiles that
 * module on its own and rewrites only its `./model` and `./rules` specifiers,
 * so an import of this file would not resolve there. If one changes, change
 * both.
 */
export function neutraliseCsvCell(raw: string): string {
  if (!raw) return raw;
  if (PLAIN_NUMBER.test(raw)) return raw;
  return FORMULA_STARTERS.includes(raw[0]) ? `'${raw}` : raw;
}

function escapeCell(value: unknown) {
  const text = neutraliseCsvCell(value === null || value === undefined ? "" : String(value));
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The same writer, taking positional rows rather than keyed records.
 *
 * `toCsv` keys each row by its header text, which is right for a fixed export
 * template like the site register and wrong for a board: two columns on a board
 * may legitimately share a title, and the second would overwrite the first.
 * This takes the values already in column order, so the header row and the data
 * rows cannot drift apart.
 */
export function rowsToCsv(headers: string[], rows: unknown[][]) {
  const lines = [headers.map(escapeCell).join(",")];
  for (const row of rows) lines.push(row.map(escapeCell).join(","));
  // A BOM keeps Excel from mangling accented site names on open.
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function toCsv(headers: string[], rows: Array<Record<string, unknown>>) {
  const lines = [headers.map(escapeCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCell(row[header])).join(","));
  }
  // A BOM keeps Excel from mangling accented site names on open.
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function csvResponse(filename: string, body: string) {
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
