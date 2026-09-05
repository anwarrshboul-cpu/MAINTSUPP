import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  /*
   * `db/**` IS NOT REACT, AND THE HOOKS RULE MISREADS IT.
   *
   * `react-hooks/rules-of-hooks` decides what a hook is from the NAME: any
   * function beginning `use` is one. The database layer has two that are not —
   * `usePostgres` in `db/init.ts`, which asks which dialect a statement is
   * being written for, and `usePreparedStatements` in `db/node-pg-d1.ts`, which
   * is a connection option — and the rule reported all three call sites as
   * hooks called outside a component. There is no React in this directory, no
   * JSX, and nothing that renders.
   *
   * Scoped off here rather than suppressed at each call site: three
   * `eslint-disable` comments would have to be maintained, and the next
   * database helper somebody names `useSomething` would add a fourth. Every
   * other rule still applies to these files.
   */
  {
    files: ["db/**/*.ts"],
    rules: { "react-hooks/rules-of-hooks": "off" },
  },
]);

export default eslintConfig;
