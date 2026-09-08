/**
 * `cloudflare:workers`, for a test that has to run the real boot path.
 *
 * The deployed build already replaces this specifier — the Vite config aliases
 * `db/node-workers-env.ts` onto it — so standing in for it here is the move the
 * product itself makes, not a fiction invented for a test.
 *
 * WHY THIS RE-IMPLEMENTS THE BINDING RATHER THAN IMPORTING `db/node-d1.ts`.
 * That adapter uses TypeScript parameter properties, which Node's strip-only
 * type removal refuses (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), so it cannot be
 * loaded by `node --test` at all. What follows is the whole of the D1 surface
 * `db/init.ts` touches — `prepare`, `bind`, `all`, `run`, `first`, `batch` —
 * over `node:sqlite`, which is the same engine the real local binding uses.
 * The code under test is the boot path, not the driver.
 */
import { DatabaseSync } from "node:sqlite";

let db = null;

function database() {
  if (db) return db;
  const file = process.env["D1_SQLITE_PATH"];
  if (!file) throw new Error("D1_SQLITE_PATH is not set; the stub has no database to open.");
  db = new DatabaseSync(file);
  return db;
}

/*
 * D1 returns `{ results, success, meta }` and throws on a bad statement. The
 * shapes matter: `db/init.ts` reads `.results` off `PRAGMA table_info` and off
 * its `SELECT`s, and treats a throw as a real failure.
 */
class Statement {
  constructor(sql, params = []) {
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new Statement(this.sql, params);
  }

  #run() {
    const statement = database().prepare(this.sql);
    /* `all()` on a non-SELECT throws in node:sqlite, and `run()` on a SELECT
       returns no rows — so which one is right is decided by the statement. */
    const reads = /^\s*(select|pragma|with)\b/i.test(this.sql);
    return reads ? statement.all(...this.params) : (statement.run(...this.params), []);
  }

  async all() {
    const results = this.#run();
    return { results, success: true, meta: {} };
  }

  async run() {
    this.#run();
    return { results: [], success: true, meta: {} };
  }

  async first(column) {
    const [row] = this.#run();
    if (!row) return null;
    return column === undefined ? row : (row[column] ?? null);
  }

  async raw() {
    return this.#run().map((row) => Object.values(row));
  }
}

const DB = {
  prepare(sql) {
    return new Statement(sql);
  },
  async batch(statements) {
    /* Real D1 runs a batch in one transaction. Kept, because `db/init.ts`
       relies on a failed batch leaving nothing behind. */
    const handle = database();
    handle.exec("BEGIN");
    try {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      handle.exec("COMMIT");
      return out;
    } catch (error) {
      handle.exec("ROLLBACK");
      throw error;
    }
  },
  async exec(sql) {
    database().exec(sql);
    return { count: 0, duration: 0 };
  },
};

/** Lets a test release the file handle before deleting its temp directory —
    Windows refuses to unlink a database SQLite still has open. */
export function closeForTests() {
  db?.close();
  db = null;
}

export const env = { DB };
export default { env };
