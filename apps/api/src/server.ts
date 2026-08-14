import { Hono } from "hono";
import { getDb, type Db } from "../../../packages/db/src/client.ts";
import { auth } from "./routes/auth.ts";
import { members } from "./routes/members.ts";
import { jobs } from "./routes/jobs.ts";
import { publicRoutes } from "./routes/public.ts";
import { analytics } from "./routes/analytics.ts";
import { compliance } from "./routes/compliance.ts";
import { invoices } from "./routes/invoices.ts";
import { settings } from "./routes/settings.ts";
import { publicUploads, uploadFiles, uploads } from "./routes/uploads.ts";

type Env = { Variables: { db: Db } };

export function createApp(db: Db) {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });

  /*
   * CORS.
   *
   * The web app is on Vercel and the API is on Railway, so every browser call
   * is cross-origin and carries the session cookie — which means an explicit
   * allow-list, not a wildcard. `credentials: true` with `origin: *` is refused
   * by browsers anyway, and an echoed origin would let any site on the internet
   * make authenticated requests on a signed-in user's behalf.
   */
  const allowed = new Set(
    (process.env.CORS_ORIGINS ?? "http://localhost:3000,http://localhost:5176")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && allowed.has(origin)) {
      c.header("access-control-allow-origin", origin);
      c.header("access-control-allow-credentials", "true");
      c.header("vary", "origin");
    }
    if (c.req.method === "OPTIONS") {
      c.header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
      c.header("access-control-allow-headers", "content-type");
      c.header("access-control-max-age", "86400");
      return c.body(null, 204);
    }
    await next();
  });

  app.use("*", async (c, next) => {
    // The API serves JSON to a separate origin; none of it should ever be
    // framed, sniffed, or indexed.
    c.header("x-content-type-options", "nosniff");
    c.header("x-frame-options", "DENY");
    c.header("referrer-policy", "no-referrer");
    await next();
  });

  /** Liveness. Railway polls this; it must not touch the database. */
  app.get("/health", (c) => c.json({ ok: true }));

  /** Readiness. This one does, because "up but cannot reach Postgres" is down. */
  app.get("/ready", async (c) => {
    try {
      await db.query("select 1");
      return c.json({ ok: true, backend: db.backend });
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 503);
    }
  });

  app.route("/auth", auth);
  app.route("/members", members);
  app.route("/jobs", jobs);
  app.route("/public", publicRoutes);
  app.route("/analytics", analytics);
  app.route("/compliance", compliance);
  app.route("/invoices", invoices);
  app.route("/settings", settings);
  app.route("/public", publicUploads);

  /*
   * ORDER MATTERS. `uploadFiles` holds GET /uploads/file, whose credential is
   * the HMAC in its own query string — a browser loading an `<img>` from
   * another origin sends no cookie, so `requireActor` must not run for it. It
   * is registered first and returns without calling `next()`, which is what
   * keeps the authenticated router's `use("*")` off that one path.
   * `tests/uploads.test.ts` fetches it with no cookie to prove this holds.
   */
  app.route("/uploads", uploadFiles);
  app.route("/uploads", uploads);

  app.notFound((c) => c.json({ error: "Not found." }, 404));

  app.onError((error, c) => {
    // Logged in full, returned as nothing. A stack trace in a response body
    // tells an attacker the file layout, the ORM and often the query.
    console.error("[api]", error);
    return c.json({ error: "Something went wrong." }, 500);
  });

  return app;
}

/* Started directly: `node apps/api/src/server.ts` */
if (process.argv[1]?.endsWith("server.ts")) {
  const { serve } = await import("@hono/node-server");
  const db = await getDb();

  if (process.env.MIGRATE_ON_BOOT !== "false") {
    const { migrate } = await import("../../../packages/db/src/migrate.ts");
    const { applied } = await migrate(db, { silent: true });
    if (applied.length) console.log(`migrated: ${applied.join(", ")}`);
  }

  const port = Number(process.env.PORT ?? 8787);
  const server = serve({ fetch: createApp(db).fetch, port });
  console.log(`api listening on :${port} (${db.backend})`);

  /*
   * Close the database before the process goes away.
   *
   * PGlite keeps a write-ahead log and does not survive being killed mid-write:
   * the data directory then aborts on every subsequent open with
   * `PANIC: could not locate a valid checkpoint record`, and PGlite ships no
   * `pg_resetwal` to repair it. The only recovery is deleting the directory and
   * rebuilding, which has now cost two people their local database — both times
   * from an ordinary `pkill` that looked completely harmless.
   *
   * Node's default SIGTERM/SIGINT handling is to exit immediately, so this is
   * the difference between `pkill -f server.ts` being safe and being
   * destructive. `once` per signal, and the exit is forced after a moment in
   * case a request is hung, because a shutdown that never completes is its own
   * way of getting the process killed harder.
   */
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      if (closing) return;
      closing = true;
      console.log(`\n${signal} — closing the database…`);

      const done = (code: number) => {
        console.log("database closed cleanly");
        process.exit(code);
      };
      const bail = setTimeout(() => {
        console.error("shutdown timed out — exiting anyway");
        process.exit(1);
      }, 5_000);
      bail.unref();

      server.close(() => {
        db.close().then(() => done(0), (error) => {
          console.error("failed to close the database:", error);
          process.exit(1);
        });
      });
    });
  }
}
