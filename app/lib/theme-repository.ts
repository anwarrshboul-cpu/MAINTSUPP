/**
 * Reading and writing one organisation's colour overrides.
 *
 * WHY THERE IS NO CACHE HERE, HAVING SHIPPED ONE AND TAKEN IT OUT
 *
 * This module first carried the 30-second per-isolate cache that
 * `options-repository.ts` uses, invalidated on write. It was wrong here, and
 * authenticated QA against the deployed Preview is what proved it: a colour was
 * reset, the database showed zero rows, and `GET /api/theme` still answered with
 * the old override. Nothing was corrupt — the write had invalidated the cache on
 * the ONE serverless instance that served it, and the read landed on another
 * whose copy had not yet expired.
 *
 * A stale palette for up to thirty seconds sounds harmless. It is not, because
 * of what the editor does next: it reloads the page and says "Reloading so the
 * new colours take effect". If that reload lands on an instance with a warm
 * cache, the administrator watches the product repaint itself in the OLD colour
 * and concludes the save silently failed. That is the "visual toggle that does
 * not save" impression the master specification forbids — produced, ironically,
 * by a correct save.
 *
 * Invalidation cannot fix it. There is no shared channel between instances, so
 * the only honest options were a cross-instance invalidation mechanism this
 * product does not have, or no cache. The cache also turned out to be guarding
 * very little: `readThemeOverrides` has exactly two callers, the layout (which
 * renders on document requests, not on `/api/*` — the portal is a shell that
 * then talks to APIs) and `/api/theme` (which runs when somebody opens the
 * settings panel). Both are rare. It was trading correctness for a query that
 * happens a handful of times per session.
 *
 * So the read is one indexed lookup on `(organisation_id, token_key)`, taken
 * every time, and the answer is always what the database says.
 *
 * WHY A FAILED READ IS NOT AN ERROR
 *
 * `readThemeOverrides` answers `{}` for an organisation with no rows, which is
 * every organisation until somebody opens the editor. `{}` resolves to an empty
 * `<style>` and the page paints exactly what `globals.css` says. A failure to
 * read is treated the same way and logged: a database hiccup should cost the
 * shipped palette, not a 500 on every screen in the product.
 */

import { and, eq, inArray } from "drizzle-orm";

import type { getDb } from "../../db";
import { themeTokens } from "../../db/schema";
import { THEME_TOKEN_KEYS, type ThemeOverrides } from "./theme-tokens.ts";

type Database = Awaited<ReturnType<typeof getDb>>;

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
    return out;
  } catch (error) {
    // See the header: the shipped palette is the right answer to a failed read.
    console.error("[theme-repository] could not read overrides", error);
    return {};
  }
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
}
