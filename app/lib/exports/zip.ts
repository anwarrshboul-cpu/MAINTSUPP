/**
 * A ZIP writer, in about two hundred lines and no dependency.
 *
 * WHY THIS EXISTS RATHER THAN A LIBRARY
 *
 * `.docx` and `.xlsx` are both ZIP containers of XML. One writer therefore
 * unlocks two of the three export formats, which is the whole reason it is
 * worth writing at all — a single-format helper would not be.
 *
 * The alternative was `exceljs` or `docx`, and this repository has already
 * answered that question once in the other direction: `app/lib/xlsx-reader.ts`
 * READS this same container format by hand, and its header records why. The
 * reasons have not changed. The portal runs on the Cloudflare Workers runtime,
 * where the bundle is size-capped and Node's `zlib`, `fs` and `Buffer` are not
 * the ones those libraries expect; `exceljs` alone is larger than everything
 * else in `dependencies` put together, for two screens. Reading a ZIP without a
 * library and then taking a megabyte of dependency to write one would be an
 * odd place to land.
 *
 * STORE, NOT DEFLATE
 *
 * Every entry is written with method 0 — stored, uncompressed. `CompressionStream`
 * exists in Workers and deflate would be a dozen more lines, but store is a
 * fully valid ZIP that Word and Excel open without complaint, and it is
 * SYNCHRONOUS. That matters more than the file size: a synchronous writer can
 * be called from anywhere, is trivially testable, and cannot interleave. A
 * maintenance report of a few hundred jobs is a few hundred kilobytes of XML;
 * compressing it would save bandwidth on a file the owner downloads once.
 *
 * If that trade ever stops being right, `deflateRaw` is the only thing that has
 * to change and the header/central-directory arithmetic below stays put — the
 * method, the CRC and the two sizes are already separate fields.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No ZIP64, no encryption, no data descriptors, no directory entries. A ZIP64
 * archive begins above 4 GB or 65,535 entries; `addFile` refuses long before
 * either, with a message, rather than writing a truncated field that presents
 * as a corrupt download. Directory entries are unnecessary — every consumer of
 * OOXML resolves paths from the entry names.
 */

/* ── CRC-32 ──────────────────────────────────────────────────────────────── */

/**
 * The standard IEEE 802.3 table, built once.
 *
 * Lazily, because a module that runs on the request path should not spend
 * 256 × 8 iterations at import time on a request that exports nothing.
 */
let crcTable: Uint32Array | null = null;

function crc32Table(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  crcTable = table;
  return table;
}

/** CRC-32 of a byte range, as an unsigned 32-bit number. */
export function crc32(bytes: Uint8Array): number {
  const table = crc32Table();
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = table[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ── DOS date and time ───────────────────────────────────────────────────── */

/**
 * MS-DOS date/time, which is what a ZIP entry records.
 *
 * Two-second resolution, a 1980 epoch, and NO TIME ZONE — the format has no
 * field for one. The instant is therefore converted in UTC and not in the
 * server's local zone, so the same payload exported from a Worker in Dublin and
 * a laptop in Amman produces byte-identical archives. That is what makes the
 * round-trip tests deterministic; it is not a claim that the owner's clock says
 * that.
 */
function dosDateTime(when: Date): { date: number; time: number } {
  const year = Math.max(1980, when.getUTCFullYear());
  return {
    date:
      (((year - 1980) & 0x7f) << 9) |
      (((when.getUTCMonth() + 1) & 0x0f) << 5) |
      (when.getUTCDate() & 0x1f),
    time:
      ((when.getUTCHours() & 0x1f) << 11) |
      ((when.getUTCMinutes() & 0x3f) << 5) |
      ((when.getUTCSeconds() >> 1) & 0x1f),
  };
}

/* ── The writer ──────────────────────────────────────────────────────────── */

const UTF8 = new TextEncoder();

/** 4 GB, the field width of every size in a non-ZIP64 archive. */
const MAX_ENTRY_BYTES = 0xffffffff;
/** The entry-count field is 16 bits. */
const MAX_ENTRIES = 0xffff;

interface ZipEntry {
  name: Uint8Array;
  body: Uint8Array;
  crc: number;
  offset: number;
}

export class ZipWriter {
  private readonly parts: Uint8Array[] = [];
  private readonly entries: ZipEntry[] = [];
  private offset = 0;
  private readonly stamp: { date: number; time: number };

  /**
   * @param modified The timestamp every entry carries. Defaults to the epoch of
   *   the format itself rather than `new Date()`, so an archive is a pure
   *   function of its content unless a caller deliberately asks otherwise. Two
   *   exports of one finalised snapshot should not differ.
   */
  constructor(modified: Date = new Date(Date.UTC(1980, 0, 1))) {
    this.stamp = dosDateTime(modified);
  }

  /** Add one stored entry. `name` is a forward-slash path inside the archive. */
  addFile(name: string, content: string | Uint8Array): void {
    if (this.entries.length >= MAX_ENTRIES) {
      throw new Error(
        `A ZIP without ZIP64 holds at most ${MAX_ENTRIES} entries; this archive is full.`,
      );
    }
    const body = typeof content === "string" ? UTF8.encode(content) : content;
    if (body.length > MAX_ENTRY_BYTES) {
      throw new Error(
        `"${name}" is ${body.length} bytes, past the 4 GB ceiling of a ZIP without ZIP64.`,
      );
    }
    const encodedName = UTF8.encode(name);
    const crc = crc32(body);
    const header = new Uint8Array(30 + encodedName.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); // local file header signature
    view.setUint16(4, 20, true); // version needed: 2.0
    view.setUint16(6, 0x0800, true); // general purpose: names are UTF-8
    view.setUint16(8, 0, true); // method 0 — stored
    view.setUint16(10, this.stamp.time, true);
    view.setUint16(12, this.stamp.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, body.length, true); // compressed size
    view.setUint32(22, body.length, true); // uncompressed size
    view.setUint16(26, encodedName.length, true);
    view.setUint16(28, 0, true); // no extra field
    header.set(encodedName, 30);

    this.entries.push({ name: encodedName, body, crc, offset: this.offset });
    this.parts.push(header, body);
    this.offset += header.length + body.length;
  }

  /** The finished archive. Calling this does not close the writer. */
  toUint8Array(): Uint8Array {
    const directory: Uint8Array[] = [];
    let directoryBytes = 0;
    for (const entry of this.entries) {
      const record = new Uint8Array(46 + entry.name.length);
      const view = new DataView(record.buffer);
      view.setUint32(0, 0x02014b50, true); // central directory signature
      view.setUint16(4, 20, true); // version made by
      view.setUint16(6, 20, true); // version needed
      view.setUint16(8, 0x0800, true); // UTF-8 names
      view.setUint16(10, 0, true); // stored
      view.setUint16(12, this.stamp.time, true);
      view.setUint16(14, this.stamp.date, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.body.length, true);
      view.setUint32(24, entry.body.length, true);
      view.setUint16(28, entry.name.length, true);
      view.setUint16(30, 0, true); // extra
      view.setUint16(32, 0, true); // comment
      view.setUint16(34, 0, true); // disk number start
      view.setUint16(36, 0, true); // internal attributes
      view.setUint32(38, 0, true); // external attributes
      view.setUint32(42, entry.offset, true);
      record.set(entry.name, 46);
      directory.push(record);
      directoryBytes += record.length;
    }

    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true); // end of central directory
    endView.setUint16(4, 0, true); // this disk
    endView.setUint16(6, 0, true); // disk with the directory
    endView.setUint16(8, this.entries.length, true);
    endView.setUint16(10, this.entries.length, true);
    endView.setUint32(12, directoryBytes, true);
    endView.setUint32(16, this.offset, true);
    endView.setUint16(20, 0, true); // no archive comment

    const chunks = [...this.parts, ...directory, end];
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

/** The common case: a map of path to content, in insertion order. */
export function zipFiles(
  files: Array<{ name: string; content: string | Uint8Array }>,
  modified?: Date,
): Uint8Array {
  const writer = new ZipWriter(modified);
  for (const file of files) writer.addFile(file.name, file.content);
  return writer.toUint8Array();
}

/* ── Reading one back ────────────────────────────────────────────────────── */

/**
 * The stored entries of an archive this module wrote.
 *
 * Deliberately narrow: it reads the central directory, refuses anything
 * deflated, and exists so a test can open its own `.docx` and assert on the XML
 * inside rather than on the bytes of the container. `app/lib/xlsx-reader.ts` is
 * the general reader — it handles deflate, ZIP64 refusal and monday's quirks —
 * and this is NOT a second copy of it, because it answers a different question:
 * "is what I just wrote readable", not "can I read what somebody sent me".
 */
export function readStoredZip(archive: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = -1;
  for (let at = archive.length - 22; at >= 0; at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("No end-of-central-directory record: not a ZIP.");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) {
      throw new Error("The central directory is malformed.");
    }
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      archive.subarray(at + 46, at + 46 + nameLength),
    );
    if (method !== 0) {
      throw new Error(`"${name}" is compressed; this reader only handles stored entries.`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    files.set(name, archive.subarray(start, start + size));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
