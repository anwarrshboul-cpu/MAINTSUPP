/**
 * Assemble a Vercel Build Output API v3 directory for the legacy portal.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BUILD OUTPUT API AND NOT A FRAMEWORK PRESET
 * ---------------------------------------------------------------------------
 * `vinext build` produces `dist/client/`, `dist/server/index.js` (a Cloudflare
 * Worker object) and `dist/server/wrangler.json`. There is no `.next`, so the
 * Next.js preset has nothing to read; `grep -ril vercel node_modules/vinext`
 * finds only `@vercel/og`, so there is no vinext Vercel adapter to invoke. The
 * Build Output API is the one interface that does not require Vercel to
 * recognise the framework: it is a directory contract, and this script writes
 * the directory.
 *
 * The alternative considered was a top-level `server.js` picked up by
 * zero-config detection. It was rejected because that detection is not a
 * documented, controllable contract — and even where it fires, it decides on
 * its own which files are traced into the function. This function needs three
 * things the tracer would not find: `dist/server/**` (reached by a dynamic
 * `import("./ssr/index.js")`), `dist/client/**` (read from disk, never
 * imported) and `node_modules/postgres` (loaded through a `createRequire` with
 * a specifier assembled at runtime, deliberately opaque to static analysis —
 * see `db/node-pg-d1.ts`). Naming the file set explicitly is the whole point.
 *
 * ---------------------------------------------------------------------------
 * OUTPUT
 * ---------------------------------------------------------------------------
 *   <out>/config.json                       routing
 *   <out>/static/**                         dist/client, served by the CDN
 *   <out>/functions/__portal.func/          one Node function, the whole app
 *
 * Usage:  node vercel/build-output.mjs [--out <dir>]
 * Default <dir> is `vercel/.deploy/.vercel/output`, i.e. a staging root that
 * is NOT the repository root — so `vercel deploy --prebuilt` run from
 * `vercel/.deploy` cannot pick up the root `.vercel/project.json`, which is
 * linked to the existing production project for `apps/web`.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const FUNCTION_NAME = "__portal";

function parseArgs(argv) {
  let out = path.join(HERE, ".deploy", ".vercel", "output");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = path.resolve(argv[++i]);
  }
  return { out };
}

async function copyDir(from, to) {
  await fsp.cp(from, to, { recursive: true, dereference: true });
}

async function dirSize(dir) {
  let total = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    total += (await fsp.stat(path.join(entry.parentPath ?? entry.path, entry.name))).size;
  }
  return total;
}

const { out } = parseArgs(process.argv.slice(2));

/* --------------------------------------------------------------- preflight -- */

const distServer = path.join(REPO, "dist", "server");
const distClient = path.join(REPO, "dist", "client");

if (!fs.existsSync(path.join(distServer, "index.js")) || !fs.existsSync(distClient)) {
  console.error(
    "No build found. Run:  D1_NODE_SHIM=1 npx vinext build\n" +
      "(the flag is what makes `cloudflare:workers` resolve to db/node-workers-env.ts;\n" +
      " without it every database call fails at runtime on any non-workerd host).",
  );
  process.exit(1);
}

/*
 * The D1_NODE_SHIM check, because getting it wrong is silent. A workerd build
 * still contains a live `import("cloudflare:workers")` statement; the shimmed
 * build contains that string only inside the doc comments that were bundled
 * with db/node-workers-env.ts and db/node-r2.ts.
 */
const serverSource = await fsp.readFile(path.join(distServer, "index.js"), "utf8");
/*
 * ASSERT THE ABSENCE, NOT THE PRESENCE.
 *
 * This used to look for the string `db/node-workers-env.ts` and conclude the
 * build was shimmed if it found it — but that string survives an UNSHIMMED
 * build too, because the doc comment naming the module is bundled either way.
 * So the guard passed on a build carrying eight live
 * `import("cloudflare:workers")` calls, and the deployment 5xx'd on login, on
 * the board, and on the public form while every step before it reported
 * success.
 *
 * The invariant that actually matters is that no live import survives, so that
 * is what is now counted. Comments are stripped first, because four of the doc
 * comments explaining the shim quote the very call they replaced — a naive scan
 * reports a correctly shimmed build as broken.
 */
const executableSource = serverSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const liveWorkerImports = executableSource.match(/import\(\s*["']cloudflare:[a-z]+["']\s*\)/g) ?? [];
if (liveWorkerImports.length) {
  console.error(
    `dist/server/index.js still contains ${liveWorkerImports.length} live ` +
      "`import(\"cloudflare:…\")` call(s). Node cannot load that scheme, so every\n" +
      "database call will fail at runtime. Rebuild with:  D1_NODE_SHIM=1 npx vinext build",
  );
  process.exit(1);
}
if (!serverSource.includes("db/node-workers-env.ts")) {
  console.error(
    "dist/server/index.js was NOT built with D1_NODE_SHIM=1 — it will try to\n" +
      "import the workerd-only module `cloudflare:workers` at runtime and every\n" +
      "database call will fail. Rebuild with:  D1_NODE_SHIM=1 npx vinext build",
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ layout -- */

await fsp.rm(out, { recursive: true, force: true });
const staticDir = path.join(out, "static");
const funcDir = path.join(out, "functions", `${FUNCTION_NAME}.func`);
await fsp.mkdir(staticDir, { recursive: true });
await fsp.mkdir(funcDir, { recursive: true });

/* --- static ---------------------------------------------------------------- */

await copyDir(distClient, staticDir);
// Cloudflare Pages' header file. Vercel does not read it; config.json below
// carries the same rule. Shipping it would publish a stray text file.
await fsp.rm(path.join(staticDir, "_headers"), { force: true });

/* --- function -------------------------------------------------------------- */

await copyDir(path.join(HERE, "function", "index.mjs"), path.join(funcDir, "index.mjs"));
await copyDir(distServer, path.join(funcDir, "dist", "server"));
await copyDir(distClient, path.join(funcDir, "dist", "client"));
await fsp.rm(path.join(funcDir, "dist", "client", "_headers"), { force: true });
await copyDir(
  path.join(REPO, "node_modules", "postgres"),
  path.join(funcDir, "node_modules", "postgres"),
);

/*
 * `"type": "module"` is load-bearing: dist/server/index.js is ESM under a .js
 * extension, and without this Node parses it as CommonJS and the function
 * fails at import. No dependencies are declared — nothing is installed at
 * deploy time for a prebuilt function; the file set above IS the install.
 */
await fsp.writeFile(
  path.join(funcDir, "package.json"),
  /* The name is arbitrary and unread — `type: "module"` is the load-bearing
     field. It dates from the `maintsupp-legacy-portal` Vercel project, deleted
     2026-09-04; left alone so the emitted artifact does not change during a
     documentation pass. */
  JSON.stringify({ name: "maintsupp-legacy-portal", private: true, type: "module" }, null, 2) + "\n",
);

await fsp.writeFile(
  path.join(funcDir, ".vc-config.json"),
  JSON.stringify(
    {
      /*
       * package.json pins `engines.node >= 24` and `.nvmrc` says 24.19.0;
       * `db/node-pg-d1.ts` needs `process.getBuiltinModule` (22.3+) and
       * `db/node-d1.ts` needs `node:sqlite`. 24.x is also what the team's
       * existing Vercel projects report, so this matches the platform default.
       */
      runtime: "nodejs24.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      /*
       * The Node launcher's "helpers" buffer the request body onto `req.body`
       * before calling the handler. This handler hands the body to `Request` as
       * a stream, so the helpers would both consume it first and defeat
       * streaming uploads. Off.
       */
      shouldAddHelpers: false,
      shouldAddSourcemapSupport: false,
      /* RSC responses are streamed; without this the platform buffers them. */
      supportsResponseStreaming: true,
      /*
       * `db/init.ts` runs several hundred idempotent DDL statements on the
       * first request of every new instance — see `ensureDatabase()`. Against
       * the Supabase session pooler that is seconds, not milliseconds, and the
       * platform default would turn a cold start into a timeout.
       */
      maxDuration: 60,
      memory: 1769,
      /*
       * London, because the database is: the Supabase pooler is
       * `aws-0-eu-west-2`. Measured on the first preview, which defaulted to
       * `iad1`: the bootstrap's several hundred sequential round trips took
       * 57 SECONDS of cold start, against ~5s from a machine on the same side
       * of the Atlantic. Nothing about the application is slow — it is one
       * transatlantic RTT per statement, several hundred times over.
       */
      regions: ["lhr1"],
    },
    null,
    2,
  ) + "\n",
);

/* --- routing --------------------------------------------------------------- */

await fsp.writeFile(
  path.join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        /*
         * dist/client/_headers, restated. `continue: true` attaches the header
         * and carries on to the filesystem handler rather than terminating.
         */
        {
          src: "^/assets/(.*)$",
          headers: {
            "cache-control": "public, max-age=31536000, immutable",
            /*
             * The worker's withSecurityHeaders never sees CDN-served files,
             * so the one header that matters for static JS/CSS is restated
             * here: without it a browser may sniff past the served type.
             */
            "x-content-type-options": "nosniff",
          },
          continue: true,
        },
        /*
         * Everything in `static/` is served by the CDN and never wakes the
         * function: /assets/*, /favicon.svg and the rest of public/.
         */
        { handle: "filesystem" },
        /*
         * Everything else is the app. The original request path reaches the
         * function in `req.url`; `dest` selects which function, it does not
         * rewrite what the handler sees.
         */
        { src: "^/(.*)$", dest: `/${FUNCTION_NAME}` },
      ],
    },
    null,
    2,
  ) + "\n",
);

/* ------------------------------------------------------------------ report -- */

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`Build output written to ${out}`);
console.log(`  static/                    ${mb(await dirSize(staticDir))}`);
console.log(`  functions/${FUNCTION_NAME}.func/   ${mb(await dirSize(funcDir))}`);
console.log(`  routes: /assets → immutable cache, filesystem, catch-all → /${FUNCTION_NAME}`);
