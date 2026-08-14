import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

const sqlText = await readFile("drizzle/pg/0000_fair_layla_miller.sql", "utf8");
const db = new PGlite();

let applied = 0;
for (const stmt of sqlText.split("--> statement-breakpoint")) {
  const trimmed = stmt.trim();
  if (!trimmed) continue;
  try { await db.exec(trimmed); applied++; }
  catch (e) { console.log("FAILED:", trimmed.slice(0, 120).replace(/\s+/g," ")); console.log("  ->", e.message); }
}
console.log(`applied ${applied} statements`);

const t = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`);
console.log(`tables created: ${t.rows.length}`);

// The timestamp default must produce SQLite's exact string shape.
await db.exec(`INSERT INTO organisations (id, name, slug) VALUES ('o1','Test','test')`);
const r = await db.query(`SELECT created_at FROM organisations`);
const v = r.rows[0].created_at;
console.log(`created_at -> "${v}"`);
console.log(`matches SQLite format: ${/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)}`);

// Booleans must be real booleans, not 0/1.
await db.exec(`INSERT INTO users (id, organisation_id, email) VALUES ('u1','o1','a@b.c')`);
const u = await db.query(`SELECT active, pg_typeof(active) AS ty FROM users`);
console.log(`users.active -> ${u.rows[0].active} (${u.rows[0].ty})`);

// Foreign keys must actually bite.
try {
  await db.exec(`INSERT INTO users (id, organisation_id, email) VALUES ('u2','MISSING','x@y.z')`);
  console.log("FK NOT ENFORCED — bad");
} catch { console.log("FK enforced: yes"); }
