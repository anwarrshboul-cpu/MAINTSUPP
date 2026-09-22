/**
 * The Workers runtime names the portal refers to, declared to the extent it uses
 * them.
 *
 * `cloudflare:workers` is a virtual module: the Workers runtime provides it in
 * local development (Miniflare), and on Vercel/Railway `vite.config.ts` aliases
 * it to `db/node-workers-env.ts`. Neither ships type declarations here, so for a
 * long time every `await import("cloudflare:workers")` and every `R2Bucket`
 * annotation was its own unresolved-type error — the project's whole "22 tsc
 * errors" baseline — or was hidden behind `@ts-expect-error`. `@cloudflare/
 * workers-types` is not the answer: it redeclares `Request`, `Response` and
 * `fetch` over the DOM library the rest of the app is checked against.
 *
 * So these are the three objects that actually stand behind the names:
 *
 * - `D1Database`: the D1 statement API that Miniflare's real D1,
 *   `db/node-d1.ts` (SQLite) and `db/node-pg-d1.ts` (Postgres) all implement.
 *   It is also what `drizzle-orm/d1` expects.
 * - `R2Bucket`: the R2 subset that `db/node-r2.ts` and `db/r2-over-s3.ts`
 *   implement, taken from the local bucket's own interface minus its diagnostic
 *   `localDir`.
 * - `env`: bindings, not shell environment — `DB` and `BUCKET` when attached,
 *   anything else unknown until the caller checks it.
 *
 * A declaration here is a claim about those objects. Widen it when code starts
 * using more of their API; do not loosen it to `any`.
 */

interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<unknown>;
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

type R2Bucket = Omit<import("./db/node-r2").LocalR2Bucket, "localDir">;

declare module "cloudflare:workers" {
  export const env: { DB?: D1Database; BUCKET?: R2Bucket; [binding: string]: unknown };
}
