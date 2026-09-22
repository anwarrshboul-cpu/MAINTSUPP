/**
 * §35 — WHAT THIS DEPLOYMENT IS ACTUALLY PLUGGED INTO, for the Integrations
 * screen. Pure: it reads the environment it is handed and the runtime it is in.
 *
 * The screen this replaces described a Cloudflare Worker: "Cloudflare D1 —
 * the workspace database. Bound as DB" and "Cloudflare R2 file storage", with
 * the R2 row reading "not attached, so uploads cannot be stored" on every
 * deployment — because the deployed product runs on Node, keeps its data in
 * Supabase Postgres (`PG_D1=1`, `db/node-pg-d1.ts`) and its files in Supabase
 * Storage over the S3 API (`db/r2-over-s3.ts`, all four `S3_*` variables).
 * Both rows were wrong in Production, in opposite directions.
 *
 * So these answer from the same signals the runtime itself acts on:
 *   · Workers runtime (local development under Miniflare): D1 and the R2
 *     binding.
 *   · Node: `PG_D1=1` → Postgres; otherwise the SQLite file. Storage is the S3
 *     bucket when ALL FOUR variables are set — `createS3BucketFromEnv` uses it
 *     on no other condition — and the local directory otherwise, which a
 *     serverless host does not keep.
 */

type EnvSource = Record<string, string | undefined>;

export type Runtime = "workers" | "node";

export const S3_VARIABLES = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;

/** Which runtime this code is executing in. */
export function currentRuntime(): Runtime {
  const agent = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "";
  return agent === "Cloudflare-Workers" ? "workers" : "node";
}

export type PostureRow = {
  key: string;
  name: string;
  category: string;
  configured: boolean;
  detail: string;
};

export function storagePosture(env: EnvSource, runtime: Runtime, fileCount: number, bucketBound: boolean): PostureRow {
  if (runtime === "workers") {
    return {
      key: "storage",
      name: "File storage — Cloudflare R2 (local development)",
      category: "Storage",
      configured: bucketBound,
      detail: bucketBound
        ? `The local R2 binding is attached. ${fileCount} files stored for this workspace.`
        : "The local R2 binding is not attached, so uploads cannot be stored.",
    };
  }
  const set = S3_VARIABLES.filter((name) => Boolean(env[name]?.trim()));
  if (set.length === S3_VARIABLES.length) {
    return {
      key: "storage",
      name: "File storage — Supabase Storage (S3 API)",
      category: "Storage",
      configured: true,
      detail: `A private bucket; every file is served through the portal's own access checks. ${fileCount} files stored for this workspace.`,
    };
  }
  if (set.length > 0) {
    const missing = S3_VARIABLES.filter((name) => !set.includes(name));
    return {
      key: "storage",
      name: "File storage — misconfigured",
      category: "Storage",
      configured: false,
      detail: `Only some of the S3 settings are present (${missing.join(", ")} missing), so the bucket is not used and uploads go to this server's local disk instead.`,
    };
  }
  return {
    key: "storage",
    name: "File storage — this server's local disk",
    category: "Storage",
    configured: false,
    detail: "No S3 storage is configured. Uploads are written to this server's own disk, which a serverless host does not keep between requests.",
  };
}

export function databasePosture(env: EnvSource, runtime: Runtime): PostureRow {
  if (runtime === "workers") {
    return {
      key: "database",
      name: "Database — Cloudflare D1 (local development)",
      category: "Storage",
      configured: true,
      detail: "Miniflare's local SQLite, bound as DB.",
    };
  }
  if (env.PG_D1 === "1") {
    return {
      key: "database",
      name: "Database — Supabase Postgres",
      category: "Storage",
      configured: true,
      detail: "The `portal` schema, reached over the session pooler.",
    };
  }
  return {
    key: "database",
    name: "Database — SQLite file",
    category: "Storage",
    configured: true,
    detail: "A SQLite file on this server's disk.",
  };
}
