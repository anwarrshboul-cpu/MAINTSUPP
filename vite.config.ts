import { fileURLToPath } from "node:url";
import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

/**
 * Build the server bundle for Node instead of for workerd.
 *
 * `cloudflare:workers` is a virtual module the Workers runtime provides and
 * nothing else does, so a build deployed to Railway resolves it to nothing and
 * every database call answers 503. With this flag set, the module resolves to
 * `db/node-workers-env.ts`, whose `env.DB` is a D1-compatible object reading a
 * SQLite file — see the header of `db/node-d1.ts` for why that is a shim and
 * not a rewrite.
 *
 * An explicit opt-in rather than a platform sniff, because getting it wrong in
 * either direction is silent: a Cloudflare deploy built with the shim would
 * ignore its real D1 binding and read a file that is not there, and a Railway
 * deploy built without it looks healthy right up until the first query.
 * Railway's build command carries the flag (see `railway.json`); Wrangler's
 * does not.
 */
const isNodeDatabaseTarget = process.env.D1_NODE_SHIM === "1";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  if (isNodeDatabaseTarget) {
    console.log(
      "  D1_NODE_SHIM=1 — cloudflare:workers resolves to db/node-workers-env.ts (Node/SQLite)",
    );
  }

  return {
    // The alias, not a plugin hook. Vite runs `vite:alias` ahead of every other
    // resolver, including the Cloudflare plugin's `resolve.builtins` list that
    // otherwise marks `cloudflare:workers` external and leaves it for a runtime
    // that will not be there. Aliasing is therefore the only entry that wins
    // without removing the Cloudflare plugin — which stays, because the rest of
    // the build it configures is exactly the build that `vinext start` has
    // already been serving on Node.
    ...(isNodeDatabaseTarget
      ? {
          resolve: {
            alias: {
              "cloudflare:workers": fileURLToPath(
                new URL("./db/node-workers-env.ts", import.meta.url),
              ),
            },
          },
        }
      : {}),
    build: {
      // Vite was emitting one merged stylesheet, so the marketing homepage
      // downloaded the dashboard's 230KB of CSS it never uses. Splitting per
      // entry lets each layout pull only its own.
      cssCodeSplit: true,
    },
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: localBindingConfig,
      }),
    ],
  };
});
