#!/usr/bin/env node
/**
 * Moves the legacy portal's files out of Miniflare's R2 state and into a
 * Supabase Storage bucket over S3.
 *
 * The bytes the portal has today live in two places under `.wrangler/state/v3/r2`:
 * an index in `miniflare-R2BucketObject/<hash>.sqlite` (table `_mf_objects`)
 * and content-addressed blobs in `<binding>/blobs/`. Nothing about that layout
 * is a public interface, so this script reads it directly rather than through
 * wrangler — there is no `wrangler r2 object get` that works against local
 * state, and re-uploading 3.5 GB through a running dev server to read it back
 * out is not a migration, it is a rehearsal.
 *
 *   node scripts/migrate-r2-to-s3.mjs --dry-run
 *   node scripts/migrate-r2-to-s3.mjs
 *
 * See scripts/README-storage-migration.md for the credentials and the bucket
 * size limit. `--dry-run` needs neither.
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS AS A LIVE OBJECT — and the correction this script encodes
 *
 * `_mf_objects` holds every readable object. Some have a `blob_id` and their
 * bytes are one file; the rest have `blob_id IS NULL` and their bytes are the
 * rows of `_mf_multipart_parts` whose `object_key` is that key, in part order.
 *
 * That second group is NOT abandoned upload state, and treating it as such
 * would be the single most expensive mistake available here. Measured against
 * this repository's state on 2026-08-15: 1,100 of the 5,656 live objects are
 * multipart-assembled, and they hold 2,970,260,240 of the 3,524,217,324 bytes —
 * 84% of everything, including every video and every large PDF. Every one of
 * their uploads is `state = 1` (completed) in `_mf_multipart_uploads`, every one
 * has all of its part blobs present on disk, and every one's part sizes sum
 * exactly to the size recorded on the object. There are ZERO parts with a null
 * `object_key`, which is what an actually-orphaned in-flight session would look
 * like. Skipping them would leave a bucket holding thumbnails and small images
 * and nothing anyone filmed.
 *
 * So the rule is: a row in `_mf_objects` is a live object, whichever way its
 * bytes are stored. A part row is only reachable through the object that owns
 * it. Anything in `_mf_multipart_uploads` with no completed object behind it is
 * not migrated, and there are currently none.
 *
 * ---------------------------------------------------------------------------
 * THUMBNAILS ARE MIGRATED. WHY.
 *
 * `<key>.thumb` derivatives are 2,686 of the 5,656 objects and 4,379,602 bytes
 * — 0.12% of the corpus. The tempting call is to drop them and let the app make
 * them again.
 *
 * The app does not make them again. `GET /api/files/[id]?thumb=1` HEADs
 * `<key>.thumb` and, finding nothing, serves the ORIGINAL — that is a graceful
 * degradation, not a regeneration. The only thing that writes a derivative is
 * `db/monday-export/generate-thumbnails.mjs`, an offline script using sharp
 * that PUTs to `PUT /api/files/[id]`, and it is not on any request path. So
 * dropping them does not cost a rebuild; it costs every gallery tile serving a
 * full-size photograph forever, which the comment in that route measures at
 * 146 KB becoming 1.1 KB per tile.
 *
 * Four megabytes to avoid that is not a decision worth making twice, so they
 * migrate by default. `--skip-thumbs` is there for someone who has decided to
 * re-run the generator against the new bucket instead.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCE
 *
 * A run that dies at object 4,000 must be resumable without re-sending 3 GB,
 * and re-running a finished migration must be a no-op rather than a second
 * upload of everything.
 *
 * The check is HEAD-then-compare, and it compares the SOURCE etag, not the
 * destination's own. A destination etag is worthless for this: S3 computes it
 * from the part boundaries this script chose, which have nothing to do with the
 * part boundaries Miniflare recorded, so an object uploaded correctly would
 * compare unequal to itself. Instead the Miniflare etag is written into custom
 * metadata as `r2SourceEtag` on the way in, and the resume check is
 * `size matches AND r2SourceEtag matches`. An object with a matching size but
 * no `r2SourceEtag` — one somebody uploaded by another route — is left alone
 * and reported, because overwriting it is a decision for a person.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createS3Bucket } from "../db/r2-over-s3.ts";

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

const MIB = 1024 * 1024;

/**
 * S3 requires every part except the last to be at least 5 MiB. 8 MiB is chosen
 * over the minimum because the part size is also the peak memory of this
 * process: a part is buffered to hash it (SigV4 needs the payload digest before
 * the request is sent), so 8 MiB per worker times four workers is 32 MiB of
 * resident memory to move 3.5 GB. The alternative — one 36 MB object in the
 * heap — is what "streams rather than buffering" is asking to avoid.
 */
const PART_BYTES = 8 * MIB;

/**
 * Below this an object goes in one PUT. Above it, multipart. Set above the part
 * size so a 9 MB object does not become a two-part upload for no reason.
 */
const MULTIPART_THRESHOLD = 16 * MIB;

/** Supabase's per-bucket file size limit for `job-media`. See the README. */
const DEFAULT_MAX_OBJECT_BYTES = 25 * MIB;

function parseArgs(argv) {
  const options = {
    dryRun: false,
    skipThumbs: false,
    prefix: "",
    limit: Infinity,
    concurrency: 4,
    verify: false,
    maxObjectBytes: DEFAULT_MAX_OBJECT_BYTES,
    partBytes: PART_BYTES,
    multipartThreshold: MULTIPART_THRESHOLD,
    stateDir: ".wrangler/state/v3/r2",
    endpoint: process.env.S3_ENDPOINT ?? "",
    bucket: process.env.S3_BUCKET ?? "",
    region: process.env.S3_REGION ?? "eu-west-2",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-thumbs") options.skipThumbs = true;
    else if (arg === "--verify") options.verify = true;
    else if (arg === "--prefix") options.prefix = value();
    else if (arg === "--limit") options.limit = Number(value());
    else if (arg === "--concurrency") options.concurrency = Number(value());
    else if (arg === "--state-dir") options.stateDir = value();
    else if (arg === "--endpoint") options.endpoint = value();
    else if (arg === "--bucket") options.bucket = value();
    else if (arg === "--region") options.region = value();
    else if (arg === "--max-object-bytes") options.maxObjectBytes = Number(value());
    else if (arg === "--part-bytes") options.partBytes = Number(value());
    else if (arg === "--multipart-threshold") options.multipartThreshold = Number(value());
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

const USAGE = `
Usage: node scripts/migrate-r2-to-s3.mjs [options]

  --dry-run             Report what would be transferred. No network, no credentials.
  --skip-thumbs         Leave <key>.thumb derivatives behind. Read the header first.
  --prefix <p>          Only keys starting with <p>.
  --limit <n>           Stop after n objects (after prefix and thumb filtering).
  --concurrency <n>     Objects in flight at once. Default 4.
  --verify              HEAD every object after uploading it.
  --state-dir <dir>     Miniflare R2 state. Default .wrangler/state/v3/r2
  --endpoint <url>      Default $S3_ENDPOINT
  --bucket <name>       Default $S3_BUCKET
  --region <name>       Default $S3_REGION or eu-west-2
  --max-object-bytes    Warn above this. Default 25 MiB, the job-media limit.
  --part-bytes <n>      Multipart part size. Default 8 MiB; S3's floor is 5 MiB.
  --multipart-threshold <n>
                        Use multipart above this size. Default 16 MiB.
                        Both exist so the end-to-end test can drive the
                        multipart path with kilobytes instead of gigabytes.

Credentials come from $S3_ACCESS_KEY_ID and $S3_SECRET_ACCESS_KEY.
`;

/* -------------------------------------------------------------------------- */
/* Reading the Miniflare state                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Finds the index and the blob directory without being told where they are.
 *
 * The sqlite file is named after a hash of the binding and the blob directory
 * after the binding itself, so both names change if wrangler.toml changes. A
 * hardcoded path would work here and fail on the next person's checkout,
 * silently reporting an empty migration.
 */
async function locateState(stateDir) {
  const root = path.resolve(stateDir);
  const indexDir = path.join(root, "miniflare-R2BucketObject");
  let indexFile = null;
  for (const entry of await readdir(indexDir)) {
    if (!/^[0-9a-f]{40,}\.sqlite$/.test(entry)) continue;
    indexFile = path.join(indexDir, entry);
  }
  if (!indexFile) {
    throw new Error(`No R2 index sqlite file under ${indexDir}`);
  }

  let blobsDir = null;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "miniflare-R2BucketObject") continue;
    const candidate = path.join(root, entry.name, "blobs");
    try {
      if ((await stat(candidate)).isDirectory()) blobsDir = candidate;
    } catch {
      /* Not this one. */
    }
  }
  if (!blobsDir) throw new Error(`No blobs directory under ${root}`);
  return { indexFile, blobsDir };
}

function openIndex(indexFile) {
  // Read-only: the dev server may well have this file open, and a migration
  // that can write to the thing it is reading is one typo from being a delete.
  const db = new DatabaseSync(indexFile, { readOnly: true });
  const objects = db.prepare(`
    select key, blob_id, size, etag, uploaded, http_metadata, custom_metadata
    from _mf_objects
    order by key
  `);
  const parts = db.prepare(`
    select p.part_number, p.blob_id, p.size
    from _mf_multipart_parts p
    join _mf_multipart_uploads u on u.upload_id = p.upload_id
    where p.object_key = ? and u.state = 1
    order by p.part_number
  `);
  return { db, objects, parts };
}

const parseJson = (value, fallback) => {
  try {
    const parsed = JSON.parse(value ?? "");
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
};

/* -------------------------------------------------------------------------- */
/* Streaming a source object                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The blob files behind one object, in order.
 *
 * One file for a single-shot put; the completed multipart's parts otherwise.
 * The parts are Miniflare's part boundaries, which this script does NOT reuse
 * as its own — they can be smaller than S3's 5 MiB minimum (1,052 of the 1,100
 * multipart objects here are a single part, but 38 are two and some are seven,
 * and a trailing 1 MB part would be rejected in the middle of an upload). They
 * are re-chunked below.
 */
function sourceBlobs(row, parts) {
  if (row.blob_id) return [row.blob_id];
  const rows = parts.all(row.key);
  if (!rows.length) {
    throw new Error(`Object has no blob and no completed parts: ${row.key}`);
  }
  const total = rows.reduce((sum, part) => sum + part.size, 0);
  // The index is the only record of what the object is; if it disagrees with
  // itself, uploading the bytes anyway would put a truncated file in the bucket
  // under a name the database already points at.
  if (total !== row.size) {
    throw new Error(
      `Part sizes total ${total} but the object records ${row.size}: ${row.key}`,
    );
  }
  return rows.map((part) => part.blob_id);
}

/** Every byte of the object, as a stream of whatever chunks the disk gives. */
async function* readSource(blobsDir, blobIds) {
  for (const id of blobIds) {
    yield* createReadStream(path.join(blobsDir, id));
  }
}

/**
 * Re-chunks a byte stream into buffers of exactly `size`, last one short.
 *
 * This is the whole of "streams rather than buffering": at no point is more
 * than one part resident, so a 36 MB video costs 8 MiB of memory instead of 36.
 */
export async function* chunked(source, size) {
  let held = [];
  let heldBytes = 0;
  for await (const chunk of source) {
    held.push(chunk);
    heldBytes += chunk.length;
    while (heldBytes >= size) {
      const joined = Buffer.concat(held, heldBytes);
      yield joined.subarray(0, size);
      const rest = joined.subarray(size);
      held = rest.length ? [rest] : [];
      heldBytes = rest.length;
    }
  }
  if (heldBytes) yield Buffer.concat(held, heldBytes);
}

/* -------------------------------------------------------------------------- */
/* Transferring one object                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The Miniflare etag, carried into the destination so a resumed run can tell
 * "already migrated" from "coincidentally the same size".
 *
 * It is an extra custom metadata name the portal never wrote. That is safe:
 * `completeMetadata()` reads five names by name and ignores everything else,
 * and `db/r2-over-s3.ts` preserves unknown names verbatim rather than pruning
 * to a schema. It is also the only durable record of where these bytes came
 * from once `.wrangler/` is deleted.
 */
const SOURCE_ETAG_NAME = "r2SourceEtag";

async function transfer(bucket, blobsDir, row, blobIds, options) {
  const httpMetadata = parseJson(row.http_metadata, {});
  const customMetadata = {
    ...parseJson(row.custom_metadata, {}),
    [SOURCE_ETAG_NAME]: row.etag,
  };

  if (row.size < options.multipartThreshold) {
    const chunks = [];
    for await (const chunk of readSource(blobsDir, blobIds)) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (body.length !== row.size) {
      throw new Error(`Read ${body.length} bytes, index says ${row.size}`);
    }
    await bucket.put(row.key, body, { httpMetadata, customMetadata });
    return { parts: 1, bytes: body.length };
  }

  const upload = await bucket.createMultipartUpload(row.key, {
    httpMetadata,
    customMetadata,
  });
  try {
    const uploaded = [];
    let bytes = 0;
    let partNumber = 1;
    for await (const part of chunked(readSource(blobsDir, blobIds), options.partBytes)) {
      uploaded.push(await upload.uploadPart(partNumber, part));
      bytes += part.length;
      partNumber += 1;
    }
    if (bytes !== row.size) {
      throw new Error(`Read ${bytes} bytes, index says ${row.size}`);
    }
    await upload.complete(uploaded);
    return { parts: uploaded.length, bytes };
  } catch (error) {
    // An abandoned multipart upload on Supabase is billed storage nobody can
    // see. Aborting on the way out costs one request; not aborting costs it
    // every time this script is interrupted.
    await upload.abort().catch(() => undefined);
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

const bytesHuman = (n) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const { indexFile, blobsDir } = await locateState(options.stateDir);
  const { objects, parts } = openIndex(indexFile);
  process.stdout.write(`index  ${indexFile}\nblobs  ${blobsDir}\n`);

  /* ---- Plan. Built entirely from the index, so --dry-run needs nothing. --- */

  const plan = [];
  const totals = {
    scanned: 0,
    thumbs: 0,
    thumbBytes: 0,
    skippedPrefix: 0,
    unreadable: [],
    oversize: [],
    bytes: 0,
    multipart: 0,
    multipartBytes: 0,
  };

  for (const row of objects.all()) {
    totals.scanned += 1;
    if (options.prefix && !row.key.startsWith(options.prefix)) {
      totals.skippedPrefix += 1;
      continue;
    }
    const isThumb = row.key.endsWith(".thumb");
    if (isThumb) {
      totals.thumbs += 1;
      totals.thumbBytes += row.size;
      if (options.skipThumbs) continue;
    }
    if (plan.length >= options.limit) break;

    let blobIds;
    try {
      blobIds = sourceBlobs(row, parts);
    } catch (error) {
      totals.unreadable.push({ key: row.key, reason: error.message });
      continue;
    }
    // A blob named in the index but absent from disk is a hole, not a failure
    // to be discovered 3 GB into the run.
    let missing = null;
    for (const id of blobIds) {
      try {
        await stat(path.join(blobsDir, id));
      } catch {
        missing = id;
        break;
      }
    }
    if (missing) {
      totals.unreadable.push({ key: row.key, reason: `blob ${missing} is not on disk` });
      continue;
    }

    if (row.size > options.maxObjectBytes) {
      totals.oversize.push({ key: row.key, size: row.size });
    }
    totals.bytes += row.size;
    if (row.size >= options.multipartThreshold) {
      totals.multipart += 1;
      totals.multipartBytes += row.size;
    }
    plan.push({ row, blobIds });
  }

  const report = () => {
    process.stdout.write(
      [
        "",
        `scanned in index          ${totals.scanned}`,
        `outside --prefix          ${totals.skippedPrefix}`,
        `.thumb derivatives        ${totals.thumbs} (${bytesHuman(totals.thumbBytes)})` +
          (options.skipThumbs ? "  SKIPPED (--skip-thumbs)" : "  included"),
        `unreadable, skipped       ${totals.unreadable.length}`,
        "",
        `WOULD TRANSFER            ${plan.length} objects`,
        `WOULD TRANSFER            ${totals.bytes} bytes (${bytesHuman(totals.bytes)})`,
        `  of which multipart      ${totals.multipart} objects, ${bytesHuman(totals.multipartBytes)}`,
        `  over --max-object-bytes ${totals.oversize.length} (limit ${bytesHuman(options.maxObjectBytes)})`,
        "",
      ].join("\n"),
    );
    for (const entry of totals.unreadable) {
      process.stdout.write(`  UNREADABLE  ${entry.key}  — ${entry.reason}\n`);
    }
    for (const entry of totals.oversize) {
      process.stdout.write(
        `  OVERSIZE    ${entry.key}  ${bytesHuman(entry.size)} (${entry.size} bytes)\n`,
      );
    }
    if (totals.oversize.length) {
      process.stdout.write(
        "\n  Objects above the bucket's file size limit will be REJECTED by\n" +
          "  Supabase, multipart or not — the limit is enforced on the finished\n" +
          "  object. Raise the bucket limit before running. See\n" +
          "  scripts/README-storage-migration.md.\n",
      );
    }
  };

  if (options.dryRun) {
    process.stdout.write("\nDRY RUN — nothing was uploaded and no credentials were used.\n");
    report();
    return;
  }

  report();

  /* ---- Transfer. ------------------------------------------------------- */

  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  if (!options.endpoint || !options.bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY " +
        "(or pass --endpoint/--bucket). Use --dry-run to plan without them.",
    );
  }
  const bucket = createS3Bucket({
    endpoint: options.endpoint,
    bucket: options.bucket,
    region: options.region,
    accessKeyId,
    secretAccessKey,
  });
  process.stdout.write(`target ${bucket.describe}\n\n`);

  const result = { done: 0, skipped: 0, failed: 0, sent: 0, conflicts: [] };
  const startedAt = Date.now();
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= plan.length) return;
      const { row, blobIds } = plan[index];
      const label = `[${index + 1}/${plan.length}]`;
      try {
        const existing = await bucket.head(row.key);
        if (existing && existing.size === row.size) {
          const sourceEtag = existing.customMetadata?.[SOURCE_ETAG_NAME];
          if (sourceEtag === row.etag) {
            result.skipped += 1;
            process.stdout.write(`${label} skip     ${row.key}\n`);
            continue;
          }
          if (!sourceEtag) {
            // Same size, no provenance. Something else wrote this key. Deciding
            // to overwrite it is a person's call, not a script's.
            result.conflicts.push(row.key);
            process.stdout.write(`${label} CONFLICT ${row.key} — same size, no ${SOURCE_ETAG_NAME}\n`);
            continue;
          }
        }
        const { parts: partCount } = await transfer(
          bucket,
          blobsDir,
          row,
          blobIds,
          options,
        );
        if (options.verify) {
          const check = await bucket.head(row.key);
          if (!check || check.size !== row.size) {
            throw new Error(`verify failed: head reports ${check?.size ?? "nothing"}`);
          }
        }
        result.done += 1;
        result.sent += row.size;
        const rate = result.sent / Math.max((Date.now() - startedAt) / 1000, 0.001);
        process.stdout.write(
          `${label} sent     ${row.key} ` +
            `(${bytesHuman(row.size)}${partCount > 1 ? `, ${partCount} parts` : ""}) ` +
            `— ${bytesHuman(result.sent)} at ${bytesHuman(rate)}/s\n`,
        );
      } catch (error) {
        result.failed += 1;
        // One object failing is not a reason to stop: the run is idempotent, so
        // finishing and re-running is strictly better than stopping at the first
        // corrupt blob and leaving the other 5,000 untried.
        process.stdout.write(`${label} FAILED   ${row.key} — ${error.message}\n`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(options.concurrency, plan.length)) }, worker),
  );

  process.stdout.write(
    `\nsent ${result.done}, skipped ${result.skipped}, ` +
      `conflicts ${result.conflicts.length}, failed ${result.failed}, ` +
      `${bytesHuman(result.sent)} in ${Math.round((Date.now() - startedAt) / 1000)}s\n`,
  );
  if (result.failed || result.conflicts.length) process.exitCode = 1;
}

/*
 * Only when run, never when imported.
 *
 * `tests/migrate-r2-to-s3.test.mjs` imports `chunked` to exercise the part
 * boundaries directly — that is the one piece of arithmetic here that would
 * corrupt a file rather than fail loudly if it were wrong. Without this guard
 * the import would start a migration.
 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
