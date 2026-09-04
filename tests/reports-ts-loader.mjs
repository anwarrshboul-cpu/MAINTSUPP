/**
 * Load a repo `.ts` module under `node --test`.
 *
 * NOT a test file — the suite globs `tests/*.test.mjs`, so this is never run as
 * one. It exists because of a genuine collision between two conventions this
 * repository holds at the same time:
 *
 *  - Everything under `app/**` imports EXTENSIONLESS (`from "./document-model"`),
 *    because `tsconfig.json` uses bundler resolution and does not set
 *    `allowImportingTsExtensions`. A `.ts` specifier there is a TypeScript error.
 *  - `tests/` imports `.ts` files directly and Node strips the types, with no
 *    build step. Node's ESM resolver requires an extension and will not guess
 *    one.
 *
 * A leaf module such as `db/r2-over-s3.ts` is importable from a test as-is
 * because it has no relative imports to resolve. A module that imports its
 * neighbours is not. `registerHooks` closes exactly that gap and nothing else:
 * a RELATIVE specifier with no extension is tried as `.ts`, then `.tsx`, then
 * `/index.ts`, and if none of those exists on disk the default resolver runs
 * unchanged. Bare specifiers are untouched, so `node:test` and `drizzle-orm`
 * resolve normally.
 *
 * Import this module for its side effect BEFORE any dynamic import of app code:
 *
 *     import "./reports-ts-loader.mjs";
 *     const { renderDocx } = await import("../app/lib/exports/docx.ts");
 *
 * ONE OTHER THING THE TYPE STRIPPER WILL NOT DO, recorded here because it is
 * the same class of surprise: Node's stripping is strip-only, so a constructor
 * parameter property (`constructor(private readonly x: T) {}`) is a hard syntax
 * error under `node --test` even though `tsc` and Vite both accept it. App code
 * that these tests load has to assign in the body instead.
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const HAS_EXTENSION = /\.[cm]?[jt]sx?$/i;
const CANDIDATES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".") &&
      !HAS_EXTENSION.test(specifier) &&
      context.parentURL
    ) {
      for (const extension of CANDIDATES) {
        const candidate = new URL(specifier + extension, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
