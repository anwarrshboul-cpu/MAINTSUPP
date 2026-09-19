/**
 * Reading and writing one organisation's portal module switches.
 *
 * NO CACHE HERE, AND THAT IS A DECISION THIS PROGRAM ALREADY PAID FOR.
 *
 * `theme-repository.ts` shipped with a thirty-second per-isolate cache and it
 * was wrong for exactly this shape of data. Authenticated QA against the
 * deployed Preview proved it: a value was changed, the database showed the new
 * state, and the API still answered with the old one — the write had
 * invalidated the cache on the ONE serverless instance that served it while the
 * read landed on another. There is no cross-instance channel in this product, so
 * the only honest options were a mechanism it does not have, or no cache.
 *
 * It matters more here than it did for a colour. A stale answer does not just
 * paint the wrong accent: it decides whether a module is reachable. An
 * administrator switching a module off and finding it still open on the next
 * page load would reasonably conclude the switch does nothing — and for up to
 * the cache's lifetime they would be right.
 *
 * The cost is one indexed lookup on `(organisation_id, module_key)` per read,
 * and the reads are rare: the page entries (document requests only — the portal
 * is a shell that then talks to APIs) and `/api/context`.
 *
 * A FAILED READ MEANS "EVERYTHING IS ON", NOT "EVERYTHING IS OFF".
 *
 * The absence of a row already means enabled, so `{}` is the shipped product.
 * A database hiccup therefore costs the shipped product for one request rather
 * than locking every member out of every module — which is the failure a
 * fail-closed default would produce, at the worst possible moment.
 */

import { and, eq } from "drizzle-orm";

import type { getDb } from "../../db";
import { portalModuleSettings, workspaceSections } from "../../db/schema";
import {
  PORTAL_MODULE_KEYS,
  isDisableableModule,
  type ModuleOverrides,
} from "./portal-modules.ts";

type Database = Awaited<ReturnType<typeof getDb>>;

/**
 * The modules this organisation has switched off. `{}` when it has switched off
 * none, which is every organisation until somebody uses the control.
 *
 * Only rows naming a module that still exists are returned. A key can leave the
 * catalogue — a module renamed, a module withdrawn — and its row outlives it,
 * because nothing deletes it and nothing should: withdrawing a module should not
 * destroy the record that a workspace had switched it off, in case it returns.
 * Filtering on read makes a stale row inert rather than a surprise.
 */
export async function readModuleOverrides(
  db: Database,
  organisationId: string,
): Promise<ModuleOverrides> {
  try {
    const rows = await db
      .select({
        key: portalModuleSettings.moduleKey,
        enabled: portalModuleSettings.enabled,
      })
      .from(portalModuleSettings)
      .where(eq(portalModuleSettings.organisationId, organisationId));

    const out: Record<string, boolean> = {};
    for (const row of rows) {
      if (!row.key || !PORTAL_MODULE_KEYS.includes(row.key)) continue;
      /* An integer on both dialects — see the note in `db/schema.ts`. Compared
         against 0 rather than truthiness so a NULL, which the column forbids but
         a hand-written row could still carry, reads as enabled. */
      out[row.key] = row.enabled !== 0;
    }
    return out;
  } catch (error) {
    // See the header: the shipped product is the right answer to a failed read.
    console.error("[portal-modules] could not read the registry", error);
    return {};
  }
}

/**
 * Which built-in surface a workspace-added section draws, or null.
 *
 * WHY THE GUARD NEEDS THIS AT ALL.
 *
 * `SECTION_SURFACES` in `app/api/workspace-sections/catalogue.ts` offers eight
 * surfaces and every one of them is a BUILT-IN MODULE KEY — `maintenance`,
 * `store-documentation`, `documents`, `stores`, `compliance`, `calendar`,
 * `contractors`, `reports`. So a workspace section is a third door onto a module,
 * and without this lookup a section on the `reports` surface went on serving the
 * whole Reports screen to every member after Reports had been switched off. The
 * section key itself is namespaced `section:<slug>` and governed by nothing, so
 * the registry had no opinion and said so.
 *
 * Only creating such a section needs `navigation.edit`, which limits how the
 * situation arises. It does not limit who it exposes the screen to, which is what
 * makes it worth a query.
 *
 * One indexed read on `(organisation_id, key)`, on document requests only, and
 * only for a `section:` key — so the eighteen built-in sections never pay it.
 */
export async function readSectionSurface(
  db: Database,
  organisationId: string,
  sectionKey: string,
): Promise<string | null> {
  try {
    const rows = await db
      .select({ surface: workspaceSections.surface })
      .from(workspaceSections)
      .where(
        and(
          eq(workspaceSections.organisationId, organisationId),
          eq(workspaceSections.key, sectionKey),
        ),
      )
      .limit(1);
    return rows[0]?.surface ?? null;
  } catch (error) {
    /* Unreadable means "no opinion", which leaves the section rendering — the
       same choice, for the same reason, as the failed override read above. */
    console.error("[portal-modules] could not read the section's surface", error);
    return null;
  }
}

/**
 * Switch one module on or off for this organisation.
 *
 * Refuses a module that may not be switched off at all. That rule lives in
 * `portal-modules.ts` beside the module list rather than here, so the catalogue
 * and the writer cannot disagree about which two are permanent, and the API
 * route checks it as well — this is the last line, not the only one.
 *
 * Enabling deletes the row rather than writing `1`. The absence of a row IS
 * enabled, so a workspace that switches a module back on returns to the shipped
 * state instead of pinning itself to a value that happened to match it today.
 * It is the same reason `theme_tokens` deletes on reset.
 *
 * The upsert is update-first-then-insert rather than `onConflictDoUpdate`,
 * matching `app/api/overview/meter-settings/route.ts`: that shape is already
 * proven against both the local SQLite and the deployed Postgres.
 */
export async function writeModuleEnabled(
  db: Database,
  organisationId: string,
  moduleKey: string,
  enabled: boolean,
  actorEmail: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!PORTAL_MODULE_KEYS.includes(moduleKey)) {
    return { ok: false, reason: `Unknown portal module: ${moduleKey}` };
  }
  if (!enabled && !isDisableableModule(moduleKey)) {
    return { ok: false, reason: `${moduleKey} cannot be switched off.` };
  }

  if (enabled) {
    await db
      .delete(portalModuleSettings)
      .where(
        and(
          eq(portalModuleSettings.organisationId, organisationId),
          eq(portalModuleSettings.moduleKey, moduleKey),
        ),
      );
    return { ok: true };
  }

  const at = new Date().toISOString();
  const updated = await db
    .update(portalModuleSettings)
    .set({ enabled: 0, updatedByEmail: actorEmail, updatedAt: at })
    .where(
      and(
        eq(portalModuleSettings.organisationId, organisationId),
        eq(portalModuleSettings.moduleKey, moduleKey),
      ),
    )
    .returning({ id: portalModuleSettings.id });

  if (!updated.length) {
    await db
      .insert(portalModuleSettings)
      .values({
        /* Deterministic, so a replay cannot produce a second row for one module
           even on a database whose unique index somehow went missing. */
        id: `pms_${organisationId}_${moduleKey}`,
        organisationId,
        moduleKey,
        enabled: 0,
        updatedByEmail: actorEmail,
        updatedAt: at,
      })
      .onConflictDoNothing();
  }

  return { ok: true };
}
