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

function escapeCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
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
