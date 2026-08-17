import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/**
 * Copies the Sites hosting manifest into the build artifact.
 *
 * `scripts/validate-artifact.sh` — which `npm run build` runs, and `npm test`
 * runs before every test — requires `dist/.openai/hosting.json` and exits 66
 * without it. `vinext build` writes `dist/server` and `dist/client` and knows
 * nothing about the manifest, and this plugin was a five-line no-op named
 * "sites-noop", so the check could never pass: `npm run build` and `npm test`
 * both failed on a clean checkout before anything was edited.
 *
 * The manifest is copied rather than generated. `.openai/hosting.json` is the
 * source of truth for the D1 and R2 binding names and the project id, and
 * `vite.config.ts` already imports that same file to build the local Wrangler
 * bindings — deriving a second copy from anywhere else is how the two drift.
 *
 * NOTE: if the upstream repository ships a fuller Sites plugin, prefer that one
 * and drop this. This restores only the one behaviour the artifact check needs.
 */
export function sites(): Plugin {
  let outDir = "dist";
  let root = process.cwd();

  return {
    name: "sites-hosting-manifest",
    apply: "build",

    configResolved(config) {
      root = config.root;
      // Every environment in the build reports its own outDir — `dist/client`,
      // `dist/server`. The manifest belongs beside them, at the shared parent
      // the validator looks in, so this deliberately ignores the per-env value.
      outDir = path.resolve(root, "dist");
    },

    async writeBundle() {
      const source = fileURLToPath(new URL("../.openai/hosting.json", import.meta.url));
      const target = path.join(outDir, ".openai", "hosting.json");
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    },
  };
}
