/**
 * Reading and writing one organisation's colour overrides.
 *
 * WHY THERE IS A CACHE HERE AT ALL
 *
 * `app/(app)/layout.tsx` resolves the theme, and that layout wraps every screen
 * that loads `globals.css` — so without a cache this would be one extra query on
 * the boot path of every portal request, for ever. `db/init.ts` already runs
 * there and the cold-start work that took it from 47s to 3.0s is recent enough
 * that adding an unconditional round trip would be a poor trade for a value that
 * changes perhaps twice a year.
 *
 * So: the same 30-second isolate cache `options-repository.ts` uses, keyed by
 * organisation so one tenant's palette can never be served to another, and
 * invalidated on write so an administrator who saves a colour sees it on the
 * next navigation rather than up to thirty seconds later.
 *
 * WHY A MISS IS NOT AN ERROR
 *
 * `readThemeOverrides` answers `{}` for an organisation with no rows, which is
 * every organisation until somebody opens the editor. `{}` resolves to an empty
 * `<style>` and the page paints exactly what `globals.css` says. A failure to
 * read is treated the same way and logged: a database hiccup should cost the
 * shipped palette for thirty seconds, not a 500 on every screen in the product.
 */

import { and, eq, inArray } from "drizzle-orm";

import type { getDb } from "../../db";
import { themeTokens } from "../../db/schema";
import { THEME_TOKEN_KEYS, type ThemeOverrides } from "./theme-tokens.ts";

type Database = Awaited<ReturnType<typeof getDb>>;

/** Matches `options-repository.ts`. Long enough to be worth having, short
    enough that a save is visible on the next navigation even without the
    explicit invalidation below. */
const CACHE_TTL_MS = 30_000;

type CacheEntry = { expires: number; overrides: ThemeOverrides };

const cache = new Map<string, CacheEntry>();

export function invalidateThemeCache(organisationId: string) {
  cache.delete(organisationId);
}

/**
 * The colours this organisation has chosen. `{}` when it has chosen none.
 *
 * Unknown `token_key` values are dropped rather than returned. A key can stop
 * being in the catalogue — a token renamed, a token withdrawn — and its rows
 * outlive it, because nothing deletes them and nothing should: withdrawing a
 * token should not silently destroy the colour somebody picked, in case it comes
 * back. Filtering on read means a stale row is inert instead of reaching
 * `resolveThemeCss`, which would ignore it anyway but only after carrying it
 * through two more functions.
 */
export async function readThemeOverrides(
  db: Database,
  organisationId: string,
): Promise<ThemeOverrides> {
  const hit = cache.get(organisationId);
  if (hit && hit.expires > Date.now()) return hit.overrides;

  let overrides: ThemeOverrides = {};
  try {
    const rows = await db
      .select({ key: themeTokens.tokenKey, value: themeTokens.tokenValue })
      .from(themeTokens)
      .where(
        and(
          eq(themeTokens.organisationId, organisationId),
          inArray(themeTokens.tokenKey, [...THEME_TOKEN_KEYS]),
        ),
      );
    const out: Record<string, string> = {};
    for (const row of rows) {
      if (row.key && row.value) out[row.key] = row.value;
    }
    overrides = out;
  } catch (error) {
    // See the header: the shipped palette is the right answer to a failed read.
    console.error("[theme-repository] could not read overrides", error);
  }

  cache.set(organisationId, { expires: Date.now() + CACHE_TTL_MS, overrides });
  return overrides;
}

/**
 * Store one colour, or clear it.
 *
 * `value === null` deletes the row, which is how "reset to the MAINTSUPP
 * default" is expressed — the absence of a row IS the default, so resetting is a
 * delete rather than a write of the seed value. Storing the seed instead would
 * pin the organisation to today's teal for ever and silently opt it out of any
 * future change to the shipped palette.
 *
 * The upsert is update-first-then-insert rather than `onConflictDoUpdate`,
 * matching `app/api/overview/meter-settings/route.ts`: the same shape is already
 * proven against both the local SQLite and the deployed Postgres through
 * `db/sqlite-to-postgres.ts`.
 *
 * The caller is responsible for having validated `value` through
 * `validateThemeToken`. This function does not re-validate, and it is the only
 * writer, so that contract is stated here and enforced by its single call site.
 */
export async function writeThemeOverride(
  db: Database,
  organisationId: string,
  tokenKey: string,
  value: string | null,
  actorEmail: string,
): Promise<void> {
  const at = new Date().toISOString();

  if (value === null) {
    await db
      .delete(themeTokens)
      .where(
        and(
          eq(themeTokens.organisationId, organisationId),
          eq(themeTokens.tokenKey, tokenKey),
        ),
      );
    invalidateThemeCache(organisationId);
    return;
  }

  const updated = await db
    .update(themeTokens)
    .set({ tokenValue: value, updatedByEmail: actorEmail, updatedAt: at })
    .where(
      and(
        eq(themeTokens.organisationId, organisationId),
        eq(themeTokens.tokenKey, tokenKey),
      ),
    )
    .returning({ id: themeTokens.id });

  if (!updated.length) {
    await db
      .insert(themeTokens)
      .values({
        /* Deterministic, so a replay cannot produce a second row for one token
           even on a database whose unique index somehow went missing. */
        id: `tt_${organisationId}_${tokenKey}`,
        organisationId,
        tokenKey,
        tokenValue: value,
        updatedByEmail: actorEmail,
        updatedAt: at,
      })
      .onConflictDoNothing();
  }

  invalidateThemeCache(organisationId);
}
