import type { Sql } from "postgres";

/**
 * A D1-shaped handle over postgres.js — a porting shim, not a destination.
 *
 * `db/init.ts` and the seeders were written against D1's
 * `prepare(sql).bind(...).all()` API. Their SQL is now Postgres; only the call
 * shape differs. Reproducing that shape here converts roughly forty call sites
 * without touching the seeding logic, which is the part that would be genuinely
 * risky to rewrite by hand — losing a seed is silent, and you find out when the
 * board comes up empty.
 *
 * WHAT THIS DOES NOT DO: it does not translate SQL. `INSERT OR IGNORE`,
 * `PRAGMA` and integer booleans were all converted in the source files, because
 * a shim that silently rewrote SQL strings would hide dialect bugs rather than
 * surface them.
 *
 * TO REMOVE IT: port the seeders to Drizzle's query builder one function at a
 * time. Nothing new should be written against this interface.
 */

export type CompatResult<T> = { results: T[] };

export type CompatStatement = {
  bind: (...values: unknown[]) => CompatStatement;
  all: <T = Record<string, unknown>>() => Promise<CompatResult<T>>;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  run: () => Promise<void>;
};

export type CompatDatabase = {
  prepare: (text: string) => CompatStatement;
  batch: (statements: CompatStatement[]) => Promise<void>;
};

/**
 * D1 uses positional `?`; Postgres uses `$1`, `$2`.
 *
 * Question marks inside string literals must be left alone, or a legitimate
 * `'Why?'` in seed copy becomes a stray parameter and the statement fails to
 * bind. The scan below tracks single-quote state for exactly that reason.
 */
export function toPositional(text: string) {
  let out = "";
  let index = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "'") {
      // '' is an escaped quote inside a string, not the end of one.
      if (inString && text[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inString = !inString;
      out += char;
      continue;
    }
    if (char === "?" && !inString) {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += char;
  }
  return out;
}

export function pgCompat(sql: Sql): CompatDatabase {
  function prepare(text: string): CompatStatement {
    const query = toPositional(text);
    let params: unknown[] = [];

    const statement: CompatStatement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      async all<T = Record<string, unknown>>() {
        const rows = await sql.unsafe(query, params as never[]);
        // D1 returns `{ results }`; callers destructure it.
        return { results: rows as unknown as T[] };
      },
      async first<T = Record<string, unknown>>() {
        const rows = await sql.unsafe(query, params as never[]);
        return ((rows as unknown as T[])[0] ?? null) as T | null;
      },
      async run() {
        await sql.unsafe(query, params as never[]);
      },
    };
    return statement;
  }

  return {
    prepare,
    async batch(statements: CompatStatement[]) {
      // D1's batch is one round trip; postgres.js has no equivalent for
      // pre-built statements, so they run in order. Sequential is correct here
      // — these are DDL and seeds where later statements assume earlier ones.
      for (const statement of statements) await statement.run();
    },
  };
}
