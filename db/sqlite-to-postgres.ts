/**
 * SQLite (D1) SQL rewritten as PostgreSQL SQL.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * `db/node-d1.ts` moved the legacy portal off Cloudflare's edge and onto a
 * SQLite file, and it needed no translator at all: D1 *is* SQLite, so the 238
 * raw `.prepare()` sites and everything drizzle's `sqlite-core` emits ran
 * verbatim. Moving the same application onto the Supabase `portal` schema does
 * not have that luxury. The rows are already there — 48 tables, 30,265 of them,
 * loaded by `migration/legacy-to-postgres/` — but the *statements* the
 * application sends are SQLite's, and about a dozen constructs in them are
 * either invalid Postgres or, worse, valid Postgres meaning something else.
 *
 * The constraint that shapes this file is that not one line of `app/**` may
 * change. So every dialect difference has to be absorbed here, on the way to
 * the wire, by a function that sees only a SQL string.
 *
 * ---------------------------------------------------------------------------
 * The scanning rule that makes this safe
 * ---------------------------------------------------------------------------
 * Every rule below is a rewrite of SQL text, and the way text rewrites of SQL
 * go wrong is by firing inside a string literal. `WHERE note LIKE '%is it 1?%'`
 * contains a `?` that is not a placeholder and a `1` that is not a boolean, and
 * a regex that does not know the difference will corrupt the user's data on the
 * way past.
 *
 * So nothing here matches against the raw SQL. Everything matches against a
 * MASK produced by `maskNonCode()`: a string of exactly the same length in
 * which every string literal, quoted identifier and comment has been replaced,
 * character for character, by NUL. Offsets in the mask are therefore offsets in
 * the original, matches can only land on real code, and the edit is applied to
 * the original text at the index the mask reported. `tests/` exercises that
 * property directly, because it is the one bug in a translator that is both
 * easy to write and impossible to see in a code review.
 */

/* ------------------------------------------------------------- the mask -- */

/**
 * The masking character, written as an escape so this file stays plain text.
 *
 * NUL and not a space, which matters: every rule below uses `\s` somewhere, and
 * a space would let `col\s*=\s*1` or the DDL default pattern step straight
 * through a masked string literal as though it were ordinary whitespace. `\s`
 * does not match NUL, so a masked region is a wall no pattern can cross.
 */
const NUL = "\u0000";

/**
 * A same-length copy of `sql` in which everything that is not executable code
 * is NUL. Handles the four quoting forms SQLite accepts and both comment forms.
 *
 * The quote characters themselves are masked too. That is deliberate: a rule
 * looking for `"` to find a quoted identifier would otherwise be unable to tell
 * a real identifier from the closing quote of a masked one.
 */
export function maskNonCode(sql: string): string {
  const out = new Array<string>(sql.length);
  let index = 0;

  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) out[i] = NUL;
  };

  while (index < sql.length) {
    const char = sql[index];

    // '…' — a string literal. '' is an escaped quote, not a terminator.
    if (char === "'") {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === "'") {
          if (sql[end + 1] === "'") {
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        end += 1;
      }
      blank(index, end);
      index = end;
      continue;
    }

    // "…" — a quoted identifier, `…` and […] — SQLite's other two forms.
    if (char === '"' || char === "`" || char === "[") {
      const closer = char === "[" ? "]" : char;
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === closer) {
          if (closer !== "]" && sql[end + 1] === closer) {
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        end += 1;
      }
      blank(index, end);
      index = end;
      continue;
    }

    // -- to end of line.
    if (char === "-" && sql[index + 1] === "-") {
      let end = index;
      while (end < sql.length && sql[end] !== "\n") end += 1;
      blank(index, end);
      index = end;
      continue;
    }

    // /* … */ — SQLite does not nest these, so neither does this.
    if (char === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      const end = close === -1 ? sql.length : close + 2;
      blank(index, end);
      index = end;
      continue;
    }

    out[index] = char;
    index += 1;
  }

  return out.join("");
}

/* --------------------------------------------------------- edit plumbing -- */

interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * Applies edits located on the mask to the original text.
 *
 * Right-to-left so that an earlier edit cannot move a later edit's offsets, and
 * overlapping edits are a programming error rather than a silent last-writer
 * wins — a rule that overlaps another is a rule whose output nobody can predict.
 */
function applyEdits(sql: string, edits: Edit[]): string {
  if (edits.length === 0) return sql;
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].start < ordered[i - 1].end) {
      throw new Error(
        `sqlite-to-postgres: overlapping rewrites at ${ordered[i].start}. ` +
          "This is a bug in the translator, not in the query.",
      );
    }
  }
  let out = sql;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const edit = ordered[i];
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/** The index just past the `(` at `open`'s matching `)`, scanning the mask. */
function matchParen(mask: string, open: number): number {
  let depth = 0;
  for (let i = open; i < mask.length; i += 1) {
    if (mask[i] === "(") depth += 1;
    else if (mask[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("sqlite-to-postgres: unbalanced parentheses in SQL.");
}

/** Top-level comma-separated ranges of `mask` between `from` and `to`. */
function splitTopLevel(
  mask: string,
  from: number,
  to: number,
): Array<{ start: number; end: number }> {
  const parts: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i += 1) {
    const char = mask[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push({ start, end: i });
      start = i + 1;
    }
  }
  parts.push({ start, end: to });
  return parts;
}

/** Trims whitespace off a range, returning the tightened range. */
function tighten(
  sql: string,
  range: { start: number; end: number },
): { start: number; end: number } {
  let { start, end } = range;
  while (start < end && /\s/.test(sql[start])) start += 1;
  while (end > start && /\s/.test(sql[end - 1])) end -= 1;
  return { start, end };
}

/* ------------------------------------------------------- boolean columns -- */

/**
 * The 27 columns the migration turned from SQLite's 0/1 integers into real
 * Postgres `boolean`, by table.
 *
 * Read out of the live `portal` schema rather than transcribed from the DDL:
 *
 *   select table_name, column_name from information_schema.columns
 *   where table_schema = 'portal' and data_type = 'boolean';
 *
 * The list is by TABLE because that is what an `INSERT` needs — the rewrite
 * below maps a column list onto a values list positionally, and getting the
 * table wrong there would write `true` into someone's severity level.
 *
 * `migration/legacy-to-postgres/README.md` (decision 7) is the record of which
 * 0/1 columns did NOT become boolean and why: `maintenance_requests.tier` holds
 * 0 and 2, `boards.position` orders, `job_access_tokens.use_count` counts. None
 * of them appear here, and a mechanical "column only holds 0 and 1" rule would
 * have caught all three.
 */
export const BOOLEAN_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  attachments: ["pending"],
  board_views: ["is_default", "system"],
  boards: ["archived"],
  compliance_documents: ["not_required"],
  contractors: ["active"],
  import_anomalies: ["resolved"],
  job_access_tokens: ["can_comment", "can_request_completion"],
  maintenance_board_columns: ["pinned", "required", "system", "visible"],
  maintenance_board_options: ["active", "system"],
  maintenance_groups: ["archived", "collapsed"],
  maintenance_requests: ["archived"],
  option_values: ["active", "is_default", "is_done", "system"],
  role_capabilities: ["allowed"],
  site_groups: ["active"],
  sites: ["active"],
  teams: ["archived"],
  users: ["active"],
};

/**
 * The same columns as a set of bare names, for `WHERE system = 1`.
 *
 * A comparison names a column but rarely names its table, so this rule has to
 * work on the name alone — which is only safe because no name in this set
 * belongs to a non-boolean column anywhere in `portal`. That was checked, not
 * assumed:
 *
 *   select table_name, column_name, data_type from information_schema.columns
 *   where table_schema = 'portal' and column_name = any(<these names>)
 *     and data_type <> 'boolean';   -- returns zero rows
 *
 * If a future migration adds an integer column called `active`, this rule turns
 * from correct into subtly wrong, so that query belongs in the test suite —
 * `tests/node-pg-d1.test.mjs` runs it.
 */
export const BOOLEAN_COLUMN_NAMES: ReadonlySet<string> = new Set(
  Object.values(BOOLEAN_COLUMNS).flat(),
);

/* ----------------------------------------------------- timestamp columns -- */

/**
 * Every column name in `portal` that the migration typed as a timestamp.
 *
 * Read out of the live schema, the same way `BOOLEAN_COLUMNS` was:
 *
 *   select distinct column_name from information_schema.columns
 *   where table_schema = 'portal'
 *     and data_type in ('timestamp with time zone', 'timestamp without time zone');
 *
 * By NAME rather than by table, which `BOOLEAN_COLUMNS` deliberately is not,
 * and the difference is justified by a property that was checked rather than
 * assumed: not one of these 32 names is used for a non-timestamp column
 * anywhere in the 48 tables. The same query intersected against every other
 * data type returns nothing. A name-keyed set is therefore exact here, while
 * for booleans it would not have been — which is why that one is per table.
 *
 * The one consumer is `replace()` in `rewriteFunctions`. See it for what goes
 * wrong without this.
 */
export const TIMESTAMP_COLUMN_NAMES: ReadonlySet<string> = new Set([
  "accepted_at",
  "approved_at",
  "archived_at",
  "completion_requested_at",
  "completion_signed_at",
  "created_at",
  "deactivated_at",
  "deleted_at",
  "delivered_at",
  "edited_at",
  "expires_at",
  "first_opened_at",
  "issued_at",
  "last_alert_at",
  "last_completed_at",
  "last_login_at",
  "last_seen_at",
  "last_used_at",
  "next_due_at",
  "notified_at",
  "paid_at",
  "password_updated_at",
  "performed_at",
  "public_upload_token_expires_at",
  "read_at",
  "requested_at",
  "resolved_at",
  "reviewed_at",
  "revoked_at",
  "submitted_at",
  "updated_at",
  "used_at",
]);

/**
 * Whether an expression is a bare reference to a timestamp column.
 *
 * Bare meaning an identifier, optionally qualified and optionally quoted:
 * `created_at`, `"created_at"`, `"audit_events"."created_at"`. Anything with a
 * function call, an operator or a literal in it is not claimed — the point is
 * to be certain, and a wrong answer here produces a cast that fails at runtime.
 */
function isTimestampColumn(expression: string): boolean {
  const match = /^(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+")\s*\.\s*(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+")$|^(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+")$/.exec(
    expression.trim(),
  );
  if (!match) return false;
  const last = expression.trim().split(".").pop() ?? "";
  return TIMESTAMP_COLUMN_NAMES.has(last.trim().replace(/^"|"$/g, ""));
}

/* ---------------------------------------------------------- the rewrites -- */

export interface TranslateOptions {
  /**
   * Primary key columns per table, needed only by `INSERT OR REPLACE`, which
   * has no Postgres equivalent that does not name a conflict target. The
   * adapter loads it from `pg_catalog` on demand; the legacy app contains zero
   * `INSERT OR REPLACE` statements, so on this codebase it is never consulted.
   */
  primaryKeys?: ReadonlyMap<string, readonly string[]>;
}

/**
 * The one entry point. Sync, and deliberately so: `prepare()` is synchronous on
 * D1 and on drizzle's d1 driver, so anything that needed to await here would
 * have to move the translation to execution time — which is exactly where the
 * adapter puts it, but as a caching decision rather than a forced one.
 */
export function translateSql(sql: string, options: TranslateOptions = {}): string {
  let text = rewriteIdentifierQuoting(sql);

  const pragma = rewritePragma(text);
  if (pragma !== null) return pragma;

  text = rejectUntranslatable(text);
  text = rewriteFunctions(text);
  text = rewriteDatetime(text);
  text = rewriteAutoincrement(text);
  text = rewriteTextTimestampDefaults(text);
  text = rewriteInsertConflictClause(text, options);
  text = rewriteBooleanInserts(text);
  text = rewriteBooleanComparisons(text);
  text = rewritePlaceholders(text);

  return text;
}

/**
 * 1. Identifier quoting. `` `x` `` and `[x]` become `"x"`.
 *
 * Postgres knows only the double-quoted form. Nothing in this repo emits the
 * other two — drizzle's sqlite dialect double-quotes and the raw sites do not
 * quote at all — but they are legal D1 input, and a backtick reaching Postgres
 * produces "unterminated quoted string", an error that names neither the column
 * nor the reason.
 *
 * Note what is NOT done: lower-casing. `"Name"` and `name` are different
 * columns in Postgres and the same column in SQLite. Every identifier in
 * `portal` is lower case, so quoting is a no-op here; folding case would be a
 * guess about a schema that does not need it.
 */
function rewriteIdentifierQuoting(sql: string): string {
  if (!/[`[]/.test(sql)) return sql;

  let out = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];

    if (char === "'") {
      const end = endOfStringLiteral(sql, index);
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === '"') {
      const end = endOfQuoted(sql, index, '"');
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      let end = index;
      while (end < sql.length && sql[end] !== "\n") end += 1;
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      const end = close === -1 ? sql.length : close + 2;
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === "`" || char === "[") {
      const closer = char === "`" ? "`" : "]";
      const end = endOfQuoted(sql, index, closer);
      const inner = sql.slice(index + 1, end - 1).replace(/""/g, '"');
      out += `"${inner.replace(/"/g, '""')}"`;
      index = end;
      continue;
    }

    out += char;
    index += 1;
  }
  return out;
}

function endOfStringLiteral(sql: string, start: number): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === "'") {
      if (sql[index + 1] === "'") {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

function endOfQuoted(sql: string, start: number, closer: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === closer) {
      if (closer !== "]" && sql[index + 1] === closer) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

/**
 * 2. `PRAGMA table_info(t)` becomes a catalogue query with the same shape.
 *
 * This is the rule without which the application does not boot. `db/init.ts`
 * runs on the boot path of every isolate and guards every one of its
 * `ALTER TABLE … ADD COLUMN`s with `PRAGMA table_info`, because SQLite has no
 * `ADD COLUMN IF NOT EXISTS`. Left untranslated, the first thing the portal
 * would do against Postgres is fail on `PRAGMA`, and the second — if the guard
 * were merely skipped — would be to ALTER 20-odd columns that already exist.
 *
 * The result columns are PRAGMA's own: `cid, name, type, notnull, dflt_value,
 * pk`. Only `name` is read (`addColumn` and the sub-item guard at init.ts:1573),
 * but the rest are cheap and a half-shaped result is a trap for the next caller.
 *
 * A table that does not exist yields zero rows rather than an error, because
 * that is what SQLite does and `addColumn` depends on it: "no columns" means
 * "a later stage creates this table", not "fail the boot".
 */
function rewritePragma(sql: string): string | null {
  const mask = maskNonCode(sql);
  if (!/^\s*PRAGMA\b/i.test(mask)) {
    if (/\bPRAGMA\b/i.test(mask)) {
      throw new Error(
        `sqlite-to-postgres: PRAGMA is only translated as a whole statement: ` +
          `${sql.trim()}`,
      );
    }
    return null;
  }

  const match = /^\s*PRAGMA\s+([a-z_]+)/i.exec(mask)!;
  const pragma = match[1].toLowerCase();
  if (pragma !== "table_info") {
    throw new Error(
      `sqlite-to-postgres: PRAGMA ${pragma} has no Postgres equivalent: ` +
        `${sql.trim()}`,
    );
  }

  /*
   * Read the argument out of the ORIGINAL text, not the mask: `table_info("x")`
   * quotes its identifier, and a quoted identifier is masked precisely so that
   * no rule reads it by accident. This one has to.
   */
  const open = mask.indexOf("(", match.index + match[0].length);
  const close = open === -1 ? -1 : matchParen(mask, open);
  const table =
    open === -1 ? "" : sql.slice(open + 1, close).replace(/"/g, "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(
      `sqlite-to-postgres: PRAGMA table_info needs a plain table name, got ` +
        `${JSON.stringify(table)}.`,
    );
  }

  /*
   * `to_regclass` resolves through the connection's search_path — which the
   * adapter pins to `portal` — and returns NULL rather than raising when the
   * table is absent, which is what turns "missing table" into "zero rows".
   */
  return `
    SELECT (a.attnum - 1)::int                       AS cid,
           a.attname::text                           AS name,
           format_type(a.atttypid, a.atttypmod)      AS type,
           CASE WHEN a.attnotnull THEN 1 ELSE 0 END  AS notnull,
           pg_get_expr(d.adbin, d.adrelid)           AS dflt_value,
           CASE WHEN i.indisprimary THEN 1 ELSE 0 END AS pk
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d
        ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      LEFT JOIN pg_index i
        ON i.indrelid = a.attrelid AND i.indisprimary
       AND a.attnum = ANY (i.indkey)
     WHERE a.attrelid = to_regclass('${table}')
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY a.attnum`;
}

/**
 * 3. Constructs with no Postgres equivalent are refused here, by name.
 *
 * The survey of this codebase found none of them (zero `strftime`, zero
 * `julianday`, zero `json_extract`, zero `group_concat`), so this rule should
 * never fire. It exists for the query that gets written next year: Postgres
 * would answer `strftime` with "function strftime(unknown, unknown) does not
 * exist", from inside a bundled server, attached to whichever route happened to
 * call it. Failing here instead names the dialect, the function and the
 * statement, which is the difference between a five-minute fix and an
 * afternoon.
 *
 * `rowid` is in the list because it is the one SQLite feature that would be
 * silently *accepted* by a careless port: Postgres has no rowid, no
 * `last_insert_rowid()`, and `db/node-d1.ts`'s `meta.last_row_id` is therefore
 * always 0 here. Nothing in this repo reads either — checked — and a query that
 * starts to would otherwise get zeros that look like data.
 */
const UNTRANSLATABLE: ReadonlyArray<[RegExp, string]> = [
  [/\bstrftime\s*\(/i, "strftime() — use to_char(…) instead"],
  [/\bjulianday\s*\(/i, "julianday() — subtract timestamps instead"],
  [/\bunixepoch\s*\(/i, "unixepoch() — use extract(epoch from …) instead"],
  [/\bjson_extract\s*\(/i, "json_extract() — use ->> or jsonb_path_query()"],
  [/\bjson_each\s*\(/i, "json_each() — use jsonb_each()"],
  [/\blast_insert_rowid\s*\(/i, "last_insert_rowid() — Postgres has no rowid"],
  [/\bsqlite_version\s*\(/i, "sqlite_version()"],
  [/\bprintf\s*\(/i, "printf() — use format()"],
  [/\bglob\b/i, "GLOB — use LIKE or ~"],
  [/\b_?rowid_?\b/i, "rowid — Postgres has no implicit row identifier"],
];

function rejectUntranslatable(sql: string): string {
  const mask = maskNonCode(sql);
  for (const [pattern, explanation] of UNTRANSLATABLE) {
    if (pattern.test(mask)) {
      throw new Error(
        `sqlite-to-postgres: ${explanation}. Statement: ${sql.trim()}`,
      );
    }
  }
  return sql;
}

/**
 * 4. The three SQLite functions that DO have a mechanical equivalent.
 *
 * `instr(haystack, needle)` and `strpos(string, substring)` take their
 * arguments in the same order, which is worth stating because the neighbouring
 * `position(needle in haystack)` does not.
 *
 * `group_concat(x)` becomes `string_agg(x::text, ',')`: the cast is not
 * decoration, since SQLite concatenates anything and `string_agg` refuses
 * non-text, and the explicit `,` is SQLite's default separator, which
 * `string_agg` has no default for at all.
 */
function rewriteFunctions(sql: string): string {
  const mask = maskNonCode(sql);
  const edits: Edit[] = [];

  for (const match of mask.matchAll(/\bifnull\s*\(/gi)) {
    edits.push({
      start: match.index,
      end: match.index + match[0].length,
      text: "coalesce(",
    });
  }
  for (const match of mask.matchAll(/\binstr\s*\(/gi)) {
    edits.push({
      start: match.index,
      end: match.index + match[0].length,
      text: "strpos(",
    });
  }
  /*
   * `replace(X, Y, Z)` gets its arguments cast to text.
   *
   * SQLite has no static types, so `replace()` coerces whatever it is handed;
   * Postgres publishes exactly one overload, `replace(text, text, text)`, and
   * will not implicitly cast to text from anything. The two disagree the moment
   * the migration gives a column a real type, and the failure is not subtle:
   *
   *   app/api/audit/route.ts:60
   *     sql`replace(${auditEvents.createdAt}, 'T', ' ')`
   *   → ERROR: function replace(timestamp with time zone, unknown, unknown)
   *     does not exist
   *
   * which took /api/audit down with a 503 on every request, GET and filtered
   * alike. The route is doing something reasonable: `created_at` used to hold
   * BOTH "2026-08-07T14:35:37.123Z" and "2026-08-07 14:35:37" depending on
   * which writer stamped it, and normalising the separator is what made the two
   * comparable as text — the same problem `rewriteDatetime` above exists for.
   *
   * As with `datetime()`, the translation is a no-op on the data it now meets:
   * `portal.audit_events.created_at` is `timestamptz`, so it contains no 'T' to
   * replace, and its `::text` form under `DateStyle=ISO` and `TimeZone=UTC` —
   * both pinned by the adapter's startup packet — is
   * "2026-08-07 14:35:37.123+00". That is fixed width, zero padded and on a
   * constant offset, so ordering it as text agrees with ordering it as an
   * instant, which is the property the route wanted. It also compares correctly
   * against the "YYYY-MM-DD HH:MM:SS" day bounds the same route builds, because
   * those are a prefix of it.
   *
   * All three arguments, not just the first. The first is the one that breaks
   * today, but an untyped parameter in the second or third position resolves to
   * `text` only by luck of Postgres' overload resolution having a single
   * candidate; making it explicit costs nothing and this file's job is to
   * remove that class of surprise.
   *
   * NOTE what is deliberately NOT rewritten. `lower()` and `substr()` have the
   * same shape of problem in principle, and the codebase was checked: every
   * call site passes a text column (`users.email`, `maintenance_requests.id`,
   * `coalesce(blocked_reason, '')`). Casting them anyway would be speculative
   * churn in a file where every rule is supposed to name the statement that
   * forced it.
   */
  for (const match of mask.matchAll(/\breplace\s*\(/gi)) {
    const open = match.index + match[0].length - 1;
    const close = matchParen(mask, open);
    const args = splitTopLevel(mask, open + 1, close);
    if (args.length !== 3) continue;
    /*
     * Each argument is wrapped by two ZERO-LENGTH insertions rather than by one
     * edit replacing the whole `replace(…)` call, and that is not a style
     * choice — `db/init.ts` contains
     *
     *   UPDATE sites SET slug =
     *     lower(replace(replace(replace(name, ' ', '-'), '/', '-'), '.', ''))
     *
     * and three whole-call edits nest inside one another, which `applyEdits`
     * correctly refuses as overlapping. Insertions at the argument boundaries
     * cannot overlap however deep the nesting goes: an inner call's own
     * boundaries lie strictly inside its parent's argument, never on it. The
     * emitted text is identical either way.
     */
    for (const arg of args) {
      const range = tighten(sql, arg);
      /*
       * A timestamp column goes through `::timestamp` on the way to text, and
       * that middle step is the difference between an audit log in time order
       * and one that is nearly in time order.
       *
       * `timestamptz::text` renders the zone: "2026-08-14 11:28:12+00". The
       * offset is always "+00" here because the session is pinned to UTC, so it
       * carries no information — but it is not harmless, because it lands
       * exactly where the fractional seconds would be, and '+' (0x2B) sorts
       * BELOW '.' (0x2E). So a row stamped on a whole second sorts under one
       * stamped 578 ms later in the same second, and /api/audit — which orders
       * by this expression descending — showed the older row first. The legacy
       * SQLite text got this right by accident: "…11:28:12" is a prefix of
       * "…11:28:12.578Z", and a prefix sorts first.
       *
       * Dropping to `timestamp` drops the offset and restores the prefix
       * relationship: "2026-08-14 11:28:12" against "2026-08-14 11:28:12.578".
       * Same instants, same order as SQLite gave, and still comparable against
       * the "YYYY-MM-DD HH:MM:SS" day bounds the route builds.
       *
       * Only for a BARE column reference of a known timestamp name. An
       * expression this cannot identify keeps the plain `::text`, which is
       * always valid; guessing wrong in the other direction would be a cast
       * that throws at runtime.
       */
      const expression = sql.slice(range.start, range.end);
      const cast = isTimestampColumn(expression) ? ")::timestamp::text" : ")::text";
      edits.push({ start: range.start, end: range.start, text: "(" });
      edits.push({ start: range.end, end: range.end, text: cast });
    }
  }

  for (const match of mask.matchAll(/\bgroup_concat\s*\(/gi)) {
    const open = match.index + match[0].length - 1;
    const close = matchParen(mask, open);
    const args = splitTopLevel(mask, open + 1, close);
    const first = tighten(sql, args[0]);
    const inner = sql.slice(first.start, first.end);
    const separator =
      args.length > 1
        ? sql.slice(tighten(sql, args[1]).start, tighten(sql, args[1]).end)
        : "','";
    edits.push({
      start: match.index,
      end: close + 1,
      text: `string_agg((${inner})::text, ${separator})`,
    });
  }

  return applyEdits(sql, edits);
}

/**
 * 5. `datetime(x)` becomes a timestamp cast; `datetime('now')` becomes `now()`.
 *
 * Three call sites in the app, all of them the same idiom and all in an
 * ORDER BY: `app/api/updates/route.ts` sorts by `datetime(created_at)` rather
 * than by `created_at` because the legacy column mixed
 * `2026-08-07 09:33:46` with `2026-08-07T14:41:02.645Z`, and sorting those as
 * text interleaves them wrongly. In `portal` that column is `timestamptz` and
 * the problem no longer exists, so `(created_at)::timestamptz` is both a valid
 * translation and a no-op — which is the ideal outcome for a compatibility
 * shim.
 *
 * Modifiers (`datetime('now', '-30 days')`) are refused rather than guessed at:
 * SQLite's modifier grammar is a small language of its own, this codebase uses
 * none of it, and a half-implemented `+1 month` is a date bug waiting to be
 * shipped.
 */
function rewriteDatetime(sql: string): string {
  const mask = maskNonCode(sql);
  const edits: Edit[] = [];

  for (const match of mask.matchAll(/\bdatetime\s*\(/gi)) {
    const open = match.index + match[0].length - 1;
    const close = matchParen(mask, open);
    const args = splitTopLevel(mask, open + 1, close);
    if (args.length > 1) {
      throw new Error(
        "sqlite-to-postgres: datetime() modifiers are not translated. " +
          `Statement: ${sql.trim()}`,
      );
    }
    const arg = tighten(sql, args[0]);
    const inner = sql.slice(arg.start, arg.end);
    edits.push({
      start: match.index,
      end: close + 1,
      text: /^'now'$/i.test(inner.trim()) ? "now()" : `(${inner})::timestamptz`,
    });
  }

  return applyEdits(sql, edits);
}

/**
 * 6. `INTEGER PRIMARY KEY AUTOINCREMENT` becomes `bigserial PRIMARY KEY`.
 *
 * Not one legacy table uses it — every primary key in the 48 is an
 * application-generated text id (`req_4ff2c25d…`, `store-aldgate`), which is
 * why `migration/legacy-to-postgres/` had no sequences to create and no
 * `setval` to run. The rule is here anyway because AUTOINCREMENT is the single
 * most common thing to meet in SQLite DDL, and because a bare `AUTOINCREMENT`
 * that is not attached to `INTEGER PRIMARY KEY` is a shape this cannot fix — so
 * it says so rather than dropping the keyword and handing back a table whose
 * ids never populate.
 */
function rewriteAutoincrement(sql: string): string {
  const mask = maskNonCode(sql);
  if (!/\bAUTOINCREMENT\b/i.test(mask)) return sql;

  const edits: Edit[] = [];
  const pattern = /\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi;
  let covered = 0;
  for (const match of mask.matchAll(pattern)) {
    covered += 1;
    edits.push({
      start: match.index,
      end: match.index + match[0].length,
      text: "BIGSERIAL PRIMARY KEY",
    });
  }
  const total = (mask.match(/\bAUTOINCREMENT\b/gi) ?? []).length;
  if (covered !== total) {
    throw new Error(
      "sqlite-to-postgres: AUTOINCREMENT outside INTEGER PRIMARY KEY has no " +
        `translation. Statement: ${sql.trim()}`,
    );
  }
  return applyEdits(sql, edits);
}

/**
 * 7. `TEXT … DEFAULT CURRENT_TIMESTAMP` in DDL keeps producing SQLite's text.
 *
 * `CURRENT_TIMESTAMP` on its own is valid Postgres and needs nothing — which is
 * why the 207 uses of it across the app are untouched. But `db/init.ts` declares
 * timestamp columns as `TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`, and Postgres
 * refuses a `timestamptz` default on a `text` column outright ("default
 * expression is of type timestamp with time zone").
 *
 * `to_char(now() at time zone 'utc', …)` reproduces SQLite's
 * `2026-08-07 09:33:46` byte for byte — same UTC basis, same second
 * granularity — so a column created this way stores what the application has
 * always read back.
 *
 * In practice every table `init.ts` declares already exists in `portal`, so
 * `CREATE TABLE IF NOT EXISTS` skips before the default is ever examined
 * (verified against the live schema: it raises a notice and stops). This rule
 * covers the one case that is not skipped — a table a future stage adds.
 */
function rewriteTextTimestampDefaults(sql: string): string {
  const mask = maskNonCode(sql);
  if (!/^\s*(CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(mask)) return sql;

  const edits: Edit[] = [];
  const pattern = /\bTEXT\b((?:\s+NOT\s+NULL)?\s+DEFAULT\s+)CURRENT_TIMESTAMP\b/gi;
  for (const match of mask.matchAll(pattern)) {
    const start = match.index + match[0].length - "CURRENT_TIMESTAMP".length;
    edits.push({
      start,
      end: match.index + match[0].length,
      text: "(to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))",
    });
  }
  return applyEdits(sql, edits);
}

/**
 * 8. `INSERT OR IGNORE` becomes `ON CONFLICT DO NOTHING`.
 *
 * 29 statements across `db/init.ts` (20), `db/seed-store-documentation.ts` (7)
 * and `app/lib/auth-session.ts` (2), and every one of them runs on the boot
 * path against a database that already holds the row — that is the whole point
 * of the idiom. Without this rule the bootstrap fails on its first seed.
 *
 * `DO NOTHING` with no conflict target is the faithful translation: SQLite's
 * OR IGNORE swallows a violation of ANY constraint, not of one named index, and
 * naming a target here would let a unique-index violation through as a 500.
 *
 * The clause is appended at the end of the statement but BEFORE any `RETURNING`,
 * which is where Postgres' grammar puts it, and works equally for the
 * `… VALUES (…)` and `… SELECT … FROM …` forms this codebase uses (both appear
 * in init.ts).
 *
 * `INSERT OR ABORT/FAIL/ROLLBACK` collapse to a plain `INSERT`, since aborting
 * on conflict is already what Postgres does. `INSERT OR REPLACE` is the one
 * that needs help: `ON CONFLICT DO UPDATE` must name a target, so the primary
 * key is looked up from the catalogue and every listed column is overwritten
 * from `EXCLUDED`. There are zero occurrences in this codebase, so that path is
 * covered by tests and by nothing else.
 */
function rewriteInsertConflictClause(
  sql: string,
  options: TranslateOptions,
): string {
  const mask = maskNonCode(sql);
  const head = /\bINSERT\s+OR\s+(IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\s+INTO\b/i.exec(
    mask,
  );
  if (!head) return sql;

  const verb = head[1].toUpperCase();
  const edits: Edit[] = [
    { start: head.index, end: head.index + head[0].length, text: "INSERT INTO" },
  ];

  const tail = endOfStatement(mask);
  if (verb === "IGNORE") {
    edits.push({ start: tail, end: tail, text: "\n ON CONFLICT DO NOTHING\n " });
  } else if (verb === "REPLACE") {
    const target = insertTarget(sql, mask, head.index + head[0].length);
    const keys = options.primaryKeys?.get(target.table);
    if (!keys || keys.length === 0) {
      throw new Error(
        `sqlite-to-postgres: INSERT OR REPLACE INTO ${target.table} needs that ` +
          "table's primary key, which was not supplied. Pass `primaryKeys`.",
      );
    }
    const assignments = target.columns
      .filter((column) => !keys.includes(column))
      .map((column) => `"${column}" = EXCLUDED."${column}"`);
    edits.push({
      start: tail,
      end: tail,
      text:
        `\n ON CONFLICT (${keys.map((key) => `"${key}"`).join(", ")}) ` +
        (assignments.length > 0
          ? `DO UPDATE SET ${assignments.join(", ")}`
          : "DO NOTHING") +
        "\n ",
    });
  }

  return applyEdits(sql, edits);
}

/** Where a statement's clauses end: before `RETURNING`, before a trailing `;`. */
function endOfStatement(mask: string): number {
  const returning = /\bRETURNING\b/i.exec(mask);
  if (returning) return returning.index;
  let end = mask.length;
  while (end > 0 && /[\s;]/.test(mask[end - 1])) end -= 1;
  return end;
}

/** The table and declared column list of an `INSERT INTO t (a, b, c)`. */
function insertTarget(
  sql: string,
  mask: string,
  from: number,
): { table: string; columns: string[]; columnRanges: Array<{ start: number; end: number }> } {
  /*
   * The table name is read from the ORIGINAL text because drizzle quotes it —
   * `insert into "users" …` — and quoted identifiers are masked. The offsets
   * still line up, since masking preserves length.
   */
  const name = /^\s*(?:"?[A-Za-z_][A-Za-z0-9_]*"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/.exec(
    sql.slice(from),
  );
  const table = name ? name[1].toLowerCase() : "";
  const open = mask.indexOf("(", from);
  if (open === -1) return { table, columns: [], columnRanges: [] };

  // A `(` that starts VALUES rather than a column list means no list was given.
  const between = mask.slice(from + (name?.[0].length ?? 0), open);
  if (/\b(VALUES|SELECT|DEFAULT)\b/i.test(between)) {
    return { table, columns: [], columnRanges: [] };
  }

  const close = matchParen(mask, open);
  const ranges = splitTopLevel(mask, open + 1, close).map((range) =>
    tighten(sql, range),
  );
  return {
    table,
    columns: ranges.map((range) =>
      sql.slice(range.start, range.end).replace(/"/g, "").toLowerCase(),
    ),
    columnRanges: ranges,
  };
}

/**
 * 9. `1` and `0` written into a boolean column become `true` and `false`.
 *
 * This is the rule the migration's own README predicted would be needed and did
 * not do ("the application currently receives 1/0"), and it is not optional:
 *
 *   INSERT INTO users (id, …, active) VALUES (?, …, 1)   -- auth-session.ts:801
 *
 * answers `column "active" is of type boolean but expression is of type
 * integer` — verified against the live schema — and that statement is on the
 * super-admin sign-in path.
 *
 * Bound parameters need no rule at all, and that is worth understanding rather
 * than assuming: the adapter declares every parameter with an UNSPECIFIED type
 * OID, so Postgres resolves `$1` from the column it is compared or assigned to
 * and a bound `1` arrives as `true`. (Making that actually work needs one
 * serialiser override on the driver — see `PG_TYPES` in `db/node-pg-d1.ts`.)
 * Only literals baked into the SQL text, which the protocol never gets to
 * re-type, need rewriting here.
 *
 * The mapping is positional, column list against values list, per table. A
 * statement with no column list is left alone: without a list the positions
 * refer to the table's physical column order, which this file does not know and
 * must not guess.
 */
function rewriteBooleanInserts(sql: string): string {
  const mask = maskNonCode(sql);
  const head = /\bINSERT\s+INTO\b/i.exec(mask);
  if (!head) return sql;

  const target = insertTarget(sql, mask, head.index + head[0].length);
  const booleans = BOOLEAN_COLUMNS[target.table];
  if (!booleans || target.columns.length === 0) return sql;

  const positions = target.columns
    .map((column, index) => (booleans.includes(column) ? index : -1))
    .filter((index) => index >= 0);
  if (positions.length === 0) return sql;

  const listEnd = target.columnRanges[target.columnRanges.length - 1].end;
  const edits: Edit[] = [];

  // … VALUES (…), (…) — every tuple, since a multi-row insert is still one list.
  const values = /\bVALUES\s*(?=\()/i.exec(mask.slice(listEnd));
  if (values) {
    let cursor = listEnd + values.index + values[0].length;
    while (cursor < mask.length && mask[cursor] === "(") {
      const close = matchParen(mask, cursor);
      const tuple = splitTopLevel(mask, cursor + 1, close).map((range) =>
        tighten(sql, range),
      );
      for (const position of positions) {
        const range = tuple[position];
        if (range) collectBooleanLiteral(sql, range, edits);
      }
      cursor = close + 1;
      while (cursor < mask.length && /[\s,]/.test(mask[cursor])) cursor += 1;
    }
    return applyEdits(sql, edits);
  }

  // … SELECT a, b, 1 FROM … — the select list runs to the top-level FROM.
  const select = /\bSELECT\b/i.exec(mask.slice(listEnd));
  if (select) {
    const start = listEnd + select.index + select[0].length;
    const end = topLevelFrom(mask, start);
    const items = splitTopLevel(mask, start, end).map((range) =>
      tighten(sql, range),
    );
    for (const position of positions) {
      const range = items[position];
      if (range) collectBooleanLiteral(sql, range, edits);
    }
    return applyEdits(sql, edits);
  }

  return sql;
}

/** Adds an edit if the range is exactly the literal 0 or 1. */
function collectBooleanLiteral(
  sql: string,
  range: { start: number; end: number },
  edits: Edit[],
): void {
  const text = sql.slice(range.start, range.end).trim();
  if (text !== "0" && text !== "1") return;
  edits.push({
    start: range.start,
    end: range.end,
    text: text === "1" ? "true" : "false",
  });
}

/** The offset of the `FROM` that ends a select list, or the end of the mask. */
function topLevelFrom(mask: string, start: number): number {
  let depth = 0;
  for (let i = start; i < mask.length; i += 1) {
    const char = mask[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (depth === 0 && /\bFROM\b/i.test(mask.slice(i, i + 4))) {
      const before = mask[i - 1];
      const after = mask[i + 4];
      if ((!before || /[\s),]/.test(before)) && (!after || /[\s(]/.test(after))) {
        return i;
      }
    }
  }
  return mask.length;
}

/**
 * 10. `active = 1` becomes `active = true`.
 *
 * Three sites in the app (`app/api/admin/users/route.ts` sets `active = 0` and
 * `active = 1`; `db/init.ts` and `db/seed-store-documentation.ts` filter on
 * `system = 1`), each of which Postgres rejects with `operator does not exist:
 * boolean = integer`.
 *
 * Matched on the column name alone, with or without a table qualifier, which is
 * safe here only because of the check recorded on `BOOLEAN_COLUMN_NAMES`: no
 * name in that set names a non-boolean column anywhere in `portal`.
 *
 * `1 = active` — the literal on the left — is deliberately not handled. It
 * appears nowhere in this codebase, and a rule that rewrote a bare `1` on the
 * strength of what follows it would be reaching much further into the grammar
 * than the three statements above justify.
 */
function rewriteBooleanComparisons(sql: string): string {
  const mask = maskNonCode(sql);
  const edits: Edit[] = [];

  /*
   * A column reference is a bare identifier OR a run of NULs.
   *
   * The `"?…"?` this pattern used to carry could never match, and the reason is
   * worth stating because it is the sort of bug that reads as working code:
   * `maskNonCode` BLANKS quoted identifiers, quotes included, so by the time
   * the pattern runs `"active" = 1` is `\0\0\0\0\0\0\0\0 = 1` and there is no
   * `"` left for the regex to find, nor any name. Every quoted boolean
   * comparison was therefore passed through untranslated and reached Postgres
   * as `"active" = 1`, which fails with "operator does not exist: boolean =
   * integer".
   *
   * Nothing in this repo emits that shape today — drizzle builds its boolean
   * comparisons through its own parameter binding, and the raw sites do not
   * quote — and it fails loudly rather than silently, which is why it stayed
   * unnoticed. It is fixed here because the mask's defining property makes it
   * nearly free: the mask is the same LENGTH as the source, so a match against
   * the mask carries offsets that index the original, and the name can simply
   * be read back out of `sql` at those offsets.
   */
  const IDENTIFIER = `(?:[A-Za-z_][A-Za-z0-9_]*|${NUL}+)`;
  const pattern = new RegExp(
    `(?:${IDENTIFIER}\\s*\\.\\s*)?(${IDENTIFIER})\\s*(=|<>|!=|IS\\s+NOT|IS)\\s*([01])(?![0-9.])`,
    "gid",
  );

  for (const match of mask.matchAll(pattern)) {
    const columnRange = match.indices?.[1];
    if (!columnRange) continue;
    // Read the name from the ORIGINAL text, because the mask may have blanked
    // it. `"active"` comes back with its quotes, which are stripped here.
    const name = sql.slice(columnRange[0], columnRange[1]).replace(/^"|"$/g, "");
    if (!BOOLEAN_COLUMN_NAMES.has(name.toLowerCase())) continue;
    const literalStart = match.index + match[0].length - match[3].length;
    edits.push({
      start: literalStart,
      end: literalStart + match[3].length,
      text: match[3] === "1" ? "true" : "false",
    });
  }

  return applyEdits(sql, edits);
}

/**
 * 11. `?` becomes `$1 … $n`.
 *
 * Last, so that it also numbers any placeholder an earlier rule moved, and so
 * that no earlier rule has to know about numbering. The count is positional and
 * one-based, matching both D1's `bind(...)` order and Postgres' parameter
 * numbering, so the adapter passes the bound array straight through.
 *
 * `?NNN` — SQLite's numbered form, which D1 also documents — becomes `$NNN`.
 * The two dialects agree exactly here: both index the parameter list from 1,
 * both allow an index to repeat, and both allow indexes out of order. So the
 * translation is `?N` → `$N` rather than "the next ordinal", and a repeated
 * `?1` stays one parameter rather than becoming two.
 *
 * That branch used to be a `throw`, and the throw was a security defect rather
 * than a limitation — see the comment on it for what it disabled and for how
 * long nobody could tell.
 *
 * The named forms (`:name`, `@name`, `$name`) are still refused: nothing emits
 * them, and they would need a name→position map this signature does not carry.
 * So is a statement that MIXES `?` with `?N`, which SQLite defines but defines
 * surprisingly.
 */
function rewritePlaceholders(sql: string): string {
  const mask = maskNonCode(sql);
  const edits: Edit[] = [];
  let ordinal = 0;
  let sawPositional = false;
  let sawNumbered = false;

  for (let i = 0; i < mask.length; i += 1) {
    const char = mask[i];
    if (char === "?") {
      /*
       * `?NNN` — SQLite's NUMBERED parameter, and the reason this branch is no
       * longer a `throw`.
       *
       * Refusing it took the portal's brute-force protection off the air, in
       * production, silently. `recordSignInFailure()` in
       * `app/lib/auth-session.ts` writes its counter with a single
       * `INSERT … ON CONFLICT DO UPDATE` whose CASE arms refer to `?2`, `?3`
       * and `?4` several times each — that repetition is precisely why it is
       * written with numbered parameters and not bare `?`. This translator
       * threw on the first `?1`; the caller ends in `.catch(() => {})`, on the
       * deliberate principle that a throttling write must not take sign-in
       * down with it; so every failed sign-in went uncounted,
       * `sign_in_failures` stayed empty, `signInRetryAfter()` kept returning 0,
       * and the 429 branch in `app/api/auth/login/route.ts` became unreachable.
       * No error surfaced anywhere. 143 accounts carry passwords.
       *
       * The translation is direct and needs nothing from the binding layer:
       * SQLite's `?N` and Postgres' `$N` are both 1-BASED INDEXES INTO THE
       * PARAMETER LIST, both may repeat, and both may appear out of order. So
       * `?N` becomes `$N` — not the next ordinal — and a repeated `?1` becomes
       * a repeated `$1`, which refers to the same parameter and consumes one
       * slot rather than two. `bind()` in the adapter already lays its values
       * out positionally, so `.bind(key, now, WINDOW, MAX, LOCKOUT)` lines up
       * with `?1..?5` with no change.
       */
      const digits = /^[0-9]+/.exec(mask.slice(i + 1))?.[0];
      if (digits) {
        const index = Number(digits);
        if (index === 0) {
          /*
           * `?0` is not a parameter in SQLite either — numbering starts at 1 —
           * and `$0` is not one in Postgres. Silently renumbering it would
           * shift every binding by one.
           */
          throw new Error(
            "sqlite-to-postgres: ?0 is not a valid parameter index; SQLite " +
              `numbers from 1. Statement: ${sql.trim()}`,
          );
        }
        sawNumbered = true;
        edits.push({ start: i, end: i + 1 + digits.length, text: `$${index}` });
        i += digits.length;
        continue;
      }
      sawPositional = true;
      ordinal += 1;
      edits.push({ start: i, end: i + 1, text: `$${ordinal}` });
      continue;
    }
    if ((char === ":" || char === "@") && /[A-Za-z_]/.test(mask[i + 1] ?? "")) {
      /*
       * `::` is a Postgres cast, not a named parameter — and this translator
       * emits casts itself, so it has to be able to read its own output.
       */
      if (char === ":" && (mask[i - 1] === ":" || mask[i + 1] === ":")) continue;
      throw new Error(
        "sqlite-to-postgres: named parameters are not translated. " +
          `Statement: ${sql.trim()}`,
      );
    }
  }

  /*
   * Mixing the two forms stays an error, and loudly.
   *
   * SQLite does accept `SELECT ?, ?2` — the bare `?` takes "one more than the
   * largest index assigned so far", which means the meaning of a bare `?`
   * depends on every numbered parameter to its LEFT. Nothing in this repo
   * writes that, no reader would predict it, and the ordinal counter above
   * does not implement it. Translating it as though the two numbering schemes
   * were independent would produce a statement that binds the wrong values —
   * which is the failure this whole file exists to prevent, and far worse than
   * a refusal that names the statement.
   */
  if (sawPositional && sawNumbered) {
    throw new Error(
      "sqlite-to-postgres: a statement mixes bare ? with numbered ?N " +
        "parameters. SQLite numbers the bare ones from the highest index used " +
        `so far, which this does not translate. Statement: ${sql.trim()}`,
    );
  }

  return applyEdits(sql, edits);
}
