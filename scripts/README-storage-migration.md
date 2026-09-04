# Legacy portal file storage: Miniflare R2 → Supabase Storage

The legacy portal reaches file storage as `env.BUCKET`, the Cloudflare R2
interface. Today that is either a real R2 bucket (under `workerd`) or a
directory on disk (`db/node-r2.ts`, under plain Node). This adds a third
driver — `db/r2-over-s3.ts` — that speaks the same R2 surface to Supabase
Storage's S3 endpoint, and a script that moves the 3.3 GB the portal already has
into it.

> **Nothing here has been run against a real Supabase bucket.** S3 access keys
> had not been issued when this was written. Every claim below about request
> shape is tested; every claim about how Supabase answers is not. Read
> "What is still unverified" before you trust the schedule.

---

## 1. Issue S3 access keys in the Supabase dashboard

The keys are *not* the `anon` / `service_role` API keys and are not derivable
from them. They are issued separately and shown exactly once.

1. Open the project at <https://supabase.com/dashboard/project/wghfhtdzxttfhofuljyy>.
2. **Storage** in the left sidebar → **S3 Access Keys** (under Configuration; on
   some plans it is *Settings → Storage → S3 access keys*).
3. **New access key**. Give it a description that names the thing using it —
   `maintsupp-portal`, the only Vercel project in the account since the
   2026-09-04 consolidation — because the only way to work out later which
   deployment a key belongs to is what you typed here. Keys issued before that
   date were labelled `maintsupp-legacy-portal`, after the project that has
   since been deleted; that is the same portal, under its old project name.
4. Copy **both** halves immediately:
   - `Access key ID` → `S3_ACCESS_KEY_ID`
   - `Secret access key` → `S3_SECRET_ACCESS_KEY`

   The secret is displayed once and cannot be retrieved afterwards. If it is
   lost, revoke the key and issue another; there is no recovery.
5. Confirm the endpoint and region on the same page. They should be:
   - endpoint `https://wghfhtdzxttfhofuljyy.supabase.co/storage/v1/s3`
   - region `eu-west-2`

   The region is **not** cosmetic and is **not** routing. Supabase serves every
   region from the same hostname, so a wrong region does not fail to connect —
   it produces `SignatureDoesNotMatch` on every single request, because the
   region is baked into the derived signing key. `us-east-1` is the AWS default
   and is the wrong answer here.

---

## 2. Environment variables

| Variable | Value | Used by |
| --- | --- | --- |
| `S3_ENDPOINT` | `https://wghfhtdzxttfhofuljyy.supabase.co/storage/v1/s3` | driver + script |
| `S3_BUCKET` | `job-media` | driver + script |
| `S3_REGION` | `eu-west-2` | driver + script |
| `S3_ACCESS_KEY_ID` | from step 1 | driver + script |
| `S3_SECRET_ACCESS_KEY` | from step 1 | driver + script |

All five, or none. `createS3BucketFromEnv()` returns `null` unless the four
required ones are present, so a half-configured deployment falls back to the
local volume rather than booting with a bucket that 403s every request. Same
rule as `s3ConfigFromEnv()` in `apps/api/src/lib/storage.ts`.

For local use put them in `.dev.vars` (already gitignored) and load them the way
the other scripts do:

```bash
set -a; . ./.dev.vars; set +a
```

**These are bucket-wide credentials with full read/write.** They are not
scoped to a prefix and there is no per-tenant restriction available on them, so
they belong in the deployment's secret store and nowhere else — not in
`wrangler.toml`, not in a build argument, not in a screenshot.

---

## 3. Wiring the driver in

Two lines in `db/node-workers-env.ts`, and nothing anywhere else:

```ts
import { createS3BucketFromEnv } from "./r2-over-s3";
export const env = { get DB() {…}, BUCKET: createS3BucketFromEnv() ?? createR2Bucket() };
```

`db/r2-over-s3.ts` exports:

| Export | What it is |
| --- | --- |
| `createS3Bucket({ endpoint, bucket, region, accessKeyId, secretAccessKey })` | **The factory.** Returns the R2-shaped bucket. Also accepts `fetch`, `now` and `deleteConcurrency`, all injected for testing. |
| `createS3BucketFromEnv(env?)` | The same thing built from `process.env`, or `null` if any of the four required variables is missing. |
| `awsUriEncode`, `canonicalQueryString`, `sigv4SigningKey`, `signS3Request` | The signer, exported so AWS's published vectors can be run against the code the requests actually use. |
| `encodeCustomMetadata`, `decodeCustomMetadata`, `encodeHttpMetadata`, `META_NAMES_HEADER` | The metadata mapping. See §6. |
| `xmlTag` | Minimal XML field extraction, used for `UploadId` and list results. |
| Types: `S3R2Bucket`, `S3R2Object`, `S3R2ObjectBody`, `S3R2MultipartUpload`, `R2PutOptions`, `R2GetOptions`, `R2HttpMetadata`, `R2Range`, `R2UploadedPart`, `R2ListOptions`, `R2Objects`, `R2PutValue`, `S3BucketOptions` | |

The bucket object implements `put`, `get`, `head`, `delete`, `list`,
`createMultipartUpload`, `resumeMultipartUpload` (synchronous, as the route
calls it) and a `describe` string for diagnostics.

---

## 4. The 25 MB problem — read this before migrating

The `job-media` bucket has a **file size limit of 25 MB**. The portal's own
limits are **25 MB for files and 90 MB for videos** (`MAX_VIDEO_FILE_SIZE` in
`app/api/files/multipart/route.ts`). Those do not agree, and the existing data
does not fit:

```
  36,139,705 bytes  …/req_005f9cdc…/general/7f283776-…-IMG_0559.mov   (34.5 MB)
  35,193,985 bytes  …/req_5a8ef451…/general/bf231a1b-…-IMG_0526.mov   (33.6 MB)
```

Two objects, 71,333,690 bytes, both over the limit.

**Multipart does not help.** The limit is enforced against the finished object,
not against each part, so a 36 MB video uploaded as five 8 MB parts is rejected
at `CompleteMultipartUpload` — after all 36 MB have been transferred. The
migration would report two failures at the very end of a three-hour run.

It is also not only a migration problem: with the bucket at 25 MB, **the portal
cannot accept the videos it advertises**. Every future upload between 25 MB and
90 MB would fail at complete, and `completeMetadata()` would then delete the
object and tell the user the file was invalid.

### Recommendation

**Raise the `job-media` file size limit to 100 MB before running the
migration**, in Dashboard → Storage → `job-media` → Configuration → *File size
limit* (it must also be within the project's global upload limit, on the same
Storage settings page). 100 MB rather than exactly 90 MB so the bucket ceiling
is not simultaneously the app's ceiling — when the two are equal, the app's own
"Videos must be 90 MB or smaller" message never gets to be the one the user
sees, and a rounding difference in how each side counts becomes a support
ticket.

The alternatives, and why they are worse:

- *Lower the app's video limit to 25 MB.* Rejects two files that already exist
  and that clients uploaded as evidence, and quietly reduces what the product
  does to fit a default nobody chose deliberately.
- *Put videos in a second bucket with a higher limit.* Two buckets means two
  `env.BUCKET`s, and the R2 interface has no room for that — the key would have
  to select the bucket, which puts routing logic in a driver whose whole point
  is that the app cannot tell which one it got.
- *Transcode the two videos down.* Alters evidence attached to a maintenance
  job. Not a migration's decision to make.

`--max-object-bytes` defaults to 25 MB purely so the dry run keeps naming the
problem until someone fixes it. After raising the bucket limit, pass
`--max-object-bytes 104857600` to match.

---

## 5. Running the migration

**Dry run first. It needs no credentials and touches no network.**

```bash
node scripts/migrate-r2-to-s3.mjs --dry-run
```

Real output, against `.wrangler/state/v3/r2` in this repository on 2026-08-15:

```
scanned in index          5656
outside --prefix          0
.thumb derivatives        2686 (4.18 MB)  included
unreadable, skipped       1

WOULD TRANSFER            5655 objects
WOULD TRANSFER            3524178240 bytes (3.28 GB)
  of which multipart      4 objects, 111.18 MB
  over --max-object-bytes 2 (limit 25.00 MB)
  UNREADABLE  _probe/test.pdf  — blob bde211a3…8220 is not on disk
```

The one unreadable object is `_probe/test.pdf`, a 39,084-byte leftover from a
storage smoke test whose blob is no longer on disk. It is not referenced by any
attachment row. Nothing to do about it.

Then, with the environment set:

```bash
set -a; . ./.dev.vars; set +a
node scripts/migrate-r2-to-s3.mjs --verify
```

| Flag | Effect |
| --- | --- |
| `--dry-run` | Plan only. No network, no credentials. |
| `--verify` | HEAD every object after uploading it. Costs one request per object; worth it on the first run. |
| `--skip-thumbs` | Leave `.thumb` derivatives behind. Read §7 first. |
| `--prefix <p>` | Only keys starting with `<p>`. Useful for a single-tenant rehearsal. |
| `--limit <n>` | Stop after `n` objects. |
| `--concurrency <n>` | Objects in flight. Default 4. |
| `--max-object-bytes <n>` | Warning threshold. Default 25 MiB. |
| `--part-bytes <n>` | Multipart part size. Default 8 MiB, S3's floor is 5 MiB. |
| `--multipart-threshold <n>` | Above this, use multipart. Default 16 MiB. |
| `--state-dir <dir>` | Miniflare state. Default `.wrangler/state/v3/r2`. |

**It is safe to re-run.** Each object is HEADed first and skipped when its size
matches *and* the `r2SourceEtag` custom metadata the migration writes matches
the Miniflare etag. An object of the right size with no `r2SourceEtag` — one
something else put there — is reported as a `CONFLICT` and left alone, because
overwriting it is a person's decision. A failed object does not stop the run;
finish it and run again.

Peak memory is one part per worker, so ~32 MB regardless of the 3.3 GB total.

### After the migration

1. Wire the driver in (§3) and deploy with the environment set.
2. Spot-check a photograph, a PDF and one of the two large videos through the
   portal — the video specifically, because it is the only path that exercises
   ranged reads.
3. Keep `.wrangler/state/v3/r2` until you have. It is the only copy.

---

## 6. Custom metadata is encoded, deliberately

Objects written by this driver carry an extra header,
`x-amz-meta-r2-names`, listing the original metadata names in their original
case. This is not decoration:

- S3 returns user metadata **lower-cased**. The portal reads
  `customMetadata.originalName`, `.boardColumnId`, `.requestId`, `.fileId`.
  Without the name table every one of those lookups returns `undefined`.
- Metadata **values** are percent-encoded, always. `originalName` is a user
  filename and may contain accents, emoji, commas, or leading spaces; header
  values are effectively ASCII, SigV4 trims them, and undici throws outright on
  a non-ASCII one.

`completeMetadata()` in `app/api/files/multipart/route.ts` deletes a
just-completed upload unless five named fields survive. If you ever look at
`job-media` in the dashboard and see `x-amz-meta-originalname` reading
`Fa%C3%A7ade%20survey.pdf`, that is correct and intended. `r2-names` is a
reserved name; passing it as app metadata throws.

---

## 7. Thumbnails migrate. Why.

`<key>.thumb` derivatives are 2,686 of the 5,656 objects but only 4,379,602
bytes — 0.12% of the corpus. Excluding them would drop the transfer to 2,969
objects and 3,519,798,638 bytes, saving about four megabytes.

They migrate anyway, because **the app does not regenerate them**.
`GET /api/files/[id]?thumb=1` HEADs the derivative and, finding nothing, serves
the *original* — a graceful degradation, not a rebuild. The only thing that
creates a derivative is `db/monday-export/generate-thumbnails.mjs`, an offline
sharp script that PUTs to `PUT /api/files/[id]`. Nothing on a request path calls
it.

So dropping them does not cost a rebuild, it costs every gallery tile serving a
full-size photograph indefinitely — 146 KB where 1.1 KB would do, per tile, by
the measurement in that route's own comment. Four megabytes is not worth that.

`--skip-thumbs` exists for whoever decides to re-run the generator against the
new bucket instead. If you use it, re-run the generator; do not just skip.

---

## 8. What the migration treats as live — and one correction

`_mf_objects` is the index of readable objects. Rows with a `blob_id` have their
bytes in one blob file. Rows with `blob_id IS NULL` are **completed multipart
objects** whose bytes are the `_mf_multipart_parts` rows pointing back at them.

The handover brief described those 1,100 rows as "orphaned in-flight multipart
sessions … should NOT be migrated". **They are not orphans, and skipping them
would lose 84% of the data.** Measured directly against this repository's state:

| | objects | bytes |
| --- | ---: | ---: |
| single-blob | 4,556 | 553,957,084 |
| completed multipart (`blob_id IS NULL`) | 1,100 | 2,970,260,240 |
| **total live** | **5,656** | **3,524,217,324** |

- All 1,100 have `state = 1` (completed) in `_mf_multipart_uploads`.
- All 1,170 part rows have a non-null `object_key`. **Zero** parts are orphaned,
  which is what an actual in-flight session would look like.
- Every object's part sizes sum exactly to its recorded size, and every part
  blob is present on disk.
- They include every video and every large PDF — the two 36 MB `.mov` files in
  §4 are both in this group.

The script therefore migrates any row in `_mf_objects`, whichever way its bytes
are stored, and reaches part rows only through the object that owns them. An
upload session with no completed object behind it is not migrated; there are
currently none.

---

## 9. Tests

```bash
node --test tests/r2-over-s3.test.mjs tests/migrate-r2-to-s3.test.mjs
```

- `tests/r2-over-s3.test.mjs` — AWS's published SigV4 vectors (canonical
  request, string-to-sign and final signature, checked separately so a failure
  says *which* stage is wrong), the metadata round trip, and the exact method,
  path, query and headers of every operation, driven through an injected
  `fetch`.
- `tests/migrate-r2-to-s3.test.mjs` — the planner against a purpose-built
  Miniflare state including a completed multipart object and a genuinely
  abandoned session, the part-boundary arithmetic, and an end-to-end run of the
  script and driver together against an in-process S3 that stores what it is
  given.

## 10. What is still unverified

None of this has touched Supabase. The following are **assumptions**, in
descending order of how much it would cost to be wrong:

1. **That Supabase's S3 endpoint stores and returns `x-amz-meta-*` on multipart
   uploads.** The metadata is attached at `CreateMultipartUpload` and must be on
   the object after `CompleteMultipartUpload`. If it is not, every multipart
   upload completes and is then deleted by `completeMetadata()` with "The
   completed file metadata is invalid" — bytes paid for, file gone, no error in
   the logs that names the cause. **Test this first**, with one file over the
   multipart threshold, before migrating anything.
2. **That it implements multipart at all**, and accepts `?uploads`,
   `?partNumber=&uploadId=`, `CompleteMultipartUpload` and
   `AbortMultipartUpload` at the documented paths.
3. **That it honours `Range`** and answers 206 with a `Content-Range`. Video
   seeking in `GET /api/files/[id]` depends on it; without it every seek pulls
   the whole file.
4. **That a missing key is 404**, not 403 or 400. `head()` treats 404 and 403 as
   "absent" and anything else as an error; a 400 for a missing key would turn
   every thumbnail miss into a 503.
5. **That `ListObjectsV2` is supported.** Only `list()` uses it, which the app
   never calls — but a post-migration audit would.
6. **The signature is accepted.** The vectors prove it matches AWS's published
   answers; they cannot prove Supabase's implementation agrees.

There is no retry or backoff anywhere in the driver. That is deliberate: a retry
policy written against an endpoint nobody has reached is a guess about which
failures are transient. Add it after the first real run, informed by what
actually fails.
