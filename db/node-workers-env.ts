/**
 * What `cloudflare:workers` resolves to when the target is Node.
 *
 * `vite.config.ts` aliases the `cloudflare:workers` virtual module to this file
 * when `D1_NODE_SHIM=1` is set for the build, so the seven `await
 * import("cloudflare:workers")` call sites across `app/api/**` and `db/index.ts`
 * keep their exact shape. Nothing in the application changes: the import
 * resolves, `env.DB` is a D1-compatible object, and the fact that the rows are
 * coming from a local SQLite file instead of Cloudflare's edge is invisible
 * above this line. Without the flag the alias is absent and the Cloudflare
 * build is byte-for-byte what it was.
 *
 * `env` is deliberately not a copy of `process.env`. In Workers this object
 * carries bindings, not shell environment: code that wants a secret already
 * reads `process.env` directly (see `environmentValue()` in
 * `app/api/account/platform/route.ts`), and code that asks `env` for something
 * is asking whether a BINDING is attached. Filling it with environment
 * variables would make `hasBinding("BUCKET")` answer yes for a deployment that
 * has no object storage at all.
 *
 * Three bindings are present. `DB` is SQLite through `node-d1.ts`; `BUCKET` is a
 * directory on disk through `node-r2.ts`; `CMS_BUCKET` (decision K, the website's
 * media) is Supabase Storage's `cms-media` bucket, or a directory of its own. All
 * are the same trade: the storage
 * moves from Cloudflare's network to whatever filesystem this process can see,
 * and on Railway that must be a mounted volume — a container's own disk is
 * replaced on every deploy, which would silently discard every photograph and
 * certificate the portal holds.
 */
import path from "node:path";
import { nodeD1Database } from "./node-d1";
import { nodePgD1Database } from "./node-pg-d1";
import { createR2Bucket } from "./node-r2";
import { createS3BucketFromEnv } from "./r2-over-s3";

/**
 * Which database `env.DB` is.
 *
 * `PG_D1=1` swaps the SQLite file for the Supabase `portal` schema through
 * `db/node-pg-d1.ts`. Absent — which is every existing deployment — nothing
 * about the SQLite path changes, including this module's import graph:
 * `node-pg-d1.ts` pulls `postgres` in through `createRequire` at first query,
 * so a SQLite deployment never loads it.
 *
 * An explicit opt-in and NOT "DATABASE_URL is set", for the same reason
 * `D1_NODE_SHIM` is explicit in `vite.config.ts`: `DATABASE_URL` in this repo
 * belongs to the Phase 2 stack in `apps/` and `packages/`, which reads it from
 * the same `.dev.vars`. Auto-switching on its presence would mean that running
 * the legacy portal in a shell that had sourced those variables silently
 * repointed it at another database — a change of data source that nothing in
 * the UI would show.
 */
function usePostgres(): boolean {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env?.["PG_D1"] === "1"
  );
}

/** The four variables `createS3BucketFromEnv()` needs; all four or none. */
const S3_VARIABLES = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;

/** Whether this environment is TRYING to use object storage — any one of the four, or the CMS bucket's name. */
function s3IsIntended(): boolean {
  return [...S3_VARIABLES, "S3_CMS_BUCKET"].some((name) => (process.env[name] ?? "").trim() !== "");
}

/**
 * THE WEBSITE'S MEDIA BUCKET, or NO BINDING AT ALL — decision K, and the one
 * place where this file deliberately does not behave like `BUCKET`.
 *
 * Three states, and the middle one is why this is a function:
 *
 *   all four S3_* set   → Supabase Storage, bucket `S3_CMS_BUCKET` (`cms-media`);
 *   SOME S3_* set       → `undefined`. No binding, so `cmsBucket()` is null, the
 *                         media routes answer 503 `MEDIA_STORAGE_UNAVAILABLE` and
 *                         the library screen names the bucket. A half-configured
 *                         deployment CANNOT be given a directory here: on Vercel
 *                         `R2_LOCAL_DIR` is `/tmp/maintsupp-r2`, so the fallback
 *                         would be per-instance scratch that lists fine — the
 *                         status light would say "ready", uploads would appear to
 *                         work, and the bytes would go with the instance. That is
 *                         exactly the silent loss CLAUDE.md records for `BUCKET`,
 *                         and a brand-new binding does not have to inherit it;
 *   no S3_* at all       → a directory, for a genuinely local Node run (`node
 *                         dist/...`, a Railway box with a volume and no S3). Its
 *                         own directory, a SIBLING of the documents one and never
 *                         inside it, so clearing the documents root cannot take
 *                         the website's media with it.
 */
function cmsMediaBucket(): unknown {
  const s3 = createS3BucketFromEnv({
    ...process.env,
    S3_BUCKET: process.env.S3_CMS_BUCKET?.trim() || "cms-media",
  });
  if (s3) return s3;
  if (s3IsIntended()) return undefined;
  const documents = process.env.R2_LOCAL_DIR ?? path.join(process.cwd(), ".r2-local");
  return createR2Bucket({ dir: `${documents}-cms-media` });
}

export const env: Record<string, unknown> = {
  /**
   * Lazy, because the database is resolved and opened on first touch. A
   * module-level open would run during the server bundle's import, before any
   * request, and a missing volume — or a missing `DATABASE_URL` — would present
   * as an unexplained boot crash instead of an error naming `D1_SQLITE_PATH` or
   * `PG_D1_URL`.
   */
  get DB() {
    return usePostgres() ? nodePgD1Database() : nodeD1Database();
  },

  /**
   * Supabase Storage when it is configured, a directory when it is not.
   *
   * `createS3BucketFromEnv()` returns null unless all four of S3_ENDPOINT,
   * S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are set — all four or
   * none, because a half-configured bucket that quietly falls back to the
   * filesystem writes a deployment's photographs onto a disk that is about to
   * be replaced, and nobody finds out until the container is.
   *
   * The order matters on a host with no persistent disk. Vercel's filesystem is
   * read-only apart from a scratch directory that is not shared between
   * invocations, so the directory driver there can only fail — cleanly, with
   * "File bytes are unavailable", rather than by pretending to have stored
   * something. Setting the four variables is what makes uploads work at all.
   *
   * Neither factory opens anything or touches disk until a request actually
   * reads or writes an object, so there is nothing to defer and no boot cost.
   */
  BUCKET: createS3BucketFromEnv() ?? createR2Bucket(),

  /**
   * The WEBSITE's media (decision K) — a different bucket from `BUCKET`, on
   * purpose. `BUCKET` holds customers' operational files and stays private and
   * unreadable from the public site; this one holds MAINTSUPP's own website
   * images, video and PDFs, served to the public through `/media/...`.
   *
   * Same credentials, different name: the S3 keys are project-wide, so the
   * bucket is `S3_CMS_BUCKET` (default `cms-media`) with the other three S3_*
   * variables unchanged. Where S3 is configured AT ALL this binding is S3 or
   * nothing — see `cmsMediaBucket()`, which is where the three states and the
   * reason for them are written down. A deployment whose `cms-media` bucket was
   * never created gets S3's own "no such bucket" on the first upload, which the
   * media routes report as exactly that; nothing falls back to `BUCKET`, to the
   * documents directory, or to a container's scratch disk.
   */
  CMS_BUCKET: cmsMediaBucket(),
};

/**
 * The three base classes below are not for this application — nothing in
 * `app/` or `db/` imports them. They are here because the Cloudflare plugin
 * generates a module of its own that does:
 *
 *   import { WorkerEntrypoint, DurableObject, WorkflowEntrypoint }
 *     from "cloudflare:workers";
 *
 * It uses them only to classify the worker's exports at build time — "is this
 * export a Durable Object?" — by testing prototype chains. Since the alias
 * catches that import too, the build fails with three MISSING_EXPORT errors
 * without them.
 *
 * Empty classes are the honest shape: no export in `worker/index.ts` extends
 * any of them, so every test the plugin runs answers "no", which is the same
 * answer the real classes would give. They are not usable base classes on Node,
 * and a file that tried would be extending an empty object — but that file
 * would be a Workers-only feature reaching into a Node build, which is a thing
 * to notice rather than to smooth over.
 *
 * The rest of the surface — `RpcTarget`, `waitUntil` — stays absent: unused
 * here, and a missing export is a build error naming the problem.
 */
export class WorkerEntrypoint {}
export class DurableObject {}
export class WorkflowEntrypoint {}
