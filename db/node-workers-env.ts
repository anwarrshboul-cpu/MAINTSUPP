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
 * Two bindings are present. `DB` is SQLite through `node-d1.ts`; `BUCKET` is a
 * directory on disk through `node-r2.ts`. Both are the same trade: the storage
 * moves from Cloudflare's network to whatever filesystem this process can see,
 * and on Railway that must be a mounted volume — a container's own disk is
 * replaced on every deploy, which would silently discard every photograph and
 * certificate the portal holds.
 */
import { nodeD1Database } from "./node-d1";
import { nodePgD1Database } from "./node-pg-d1";
import { createR2Bucket } from "./node-r2";

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
   * Not lazy, unlike `DB`: the factory opens nothing and touches no disk until
   * a request actually reads or writes an object, so there is no boot-time cost
   * to pay and nothing to defer.
   */
  BUCKET: createR2Bucket(),
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
