/**
 * CASE-INSENSITIVE "CONTAINS", THE SAME ON BOTH DATABASES — §36.
 *
 * `like()` is case-insensitive on SQLite and case-SENSITIVE on Postgres, and
 * this codebase runs on both: a search that finds "Invoice.pdf" for "invoice"
 * on a laptop finds nothing in Production. There is no `ilike` in the SQLite
 * dialect and the translator has no LIKE rule, so the portable form is the one
 * `lib/finance/repository.ts` already uses — lower the column, lower the
 * needle, compare with LIKE.
 *
 * `%` and `_` are stripped from what the person typed rather than escaped:
 * nobody searches for a literal percent sign, and an unescaped one would turn
 * "50%" into "anything starting with 50".
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 80;

/** The LIKE pattern for a typed query, or `null` when it is too short to search. */
export function searchNeedle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toLowerCase().replace(/[%_]/g, "").slice(0, SEARCH_MAX_LENGTH);
  if (cleaned.length < SEARCH_MIN_LENGTH) return null;
  return `%${cleaned}%`;
}

/** `lower(coalesce(column, '')) like needle` — a NULL column simply does not match. */
export function containsText(column: AnySQLiteColumn, needle: string): SQL {
  return sql`lower(coalesce(${column}, '')) like ${needle}`;
}
