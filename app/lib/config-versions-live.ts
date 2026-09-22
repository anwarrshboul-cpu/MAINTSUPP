/**
 * §38 — the LIVE state of a versioned setting, as the same snapshot shape its
 * versions are recorded in, so the history list can mark which versions equal
 * what is in force now (by digest — never by assuming the newest is current:
 * a write that bypasses versioning, or two saves numbered out of order, would
 * make that assumption lie).
 *
 * Read with the same parsers the settings' own routes use.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { getDb } from "../../db";
import { dashboardLayouts, navigationLayouts } from "../../db/schema";
import { sanitiseArrangement, sanitiseLocked } from "../api/navigation/layout";
import { listPages } from "./cms-repository";
import { readStoredNavigation } from "./site-navigation-repository";
import {
  dashboardSnapshot,
  modulesSnapshot,
  navigationSnapshot,
  pageSnapshot,
  siteNavigationSnapshot,
  themeSnapshot,
  type VersionSubject,
} from "./config-versions-model";
import { readModuleOverrides } from "./portal-module-repository";
import { readThemeOverrides } from "./theme-repository";

type Database = Awaited<ReturnType<typeof getDb>>;

function parsed(text: string | null | undefined): unknown {
  try {
    return JSON.parse(text ?? "[]");
  } catch {
    return [];
  }
}

export async function liveSnapshot(db: Database, organisationId: string | null, subject: VersionSubject, key: string): Promise<unknown> {
  /* §38b — installation-wide: the page as it is now, or "absent" (no version equals that). */
  if (subject === "site_page") {
    const page = (await listPages(db)).find((entry) => entry.slug === key);
    return page ? pageSnapshot(page) : { absent: true };
  }
  /* Decision J — installation-wide: the stored navigation, or "no row" (built-in). */
  if (subject === "site_navigation") {
    const stored = await readStoredNavigation(db);
    return siteNavigationSnapshot(stored.stored ? stored.navigation : null);
  }
  if (organisationId === null) return { absent: true };
  if (subject === "theme") return themeSnapshot(await readThemeOverrides(db, organisationId));
  if (subject === "portal_modules") return modulesSnapshot(await readModuleOverrides(db, organisationId));
  if (subject === "navigation") {
    const [row] = await db
      .select({ items: navigationLayouts.items, locked: navigationLayouts.locked })
      .from(navigationLayouts)
      .where(and(eq(navigationLayouts.organisationId, organisationId), isNull(navigationLayouts.userId)))
      .limit(1);
    return navigationSnapshot(row ? { items: sanitiseArrangement(parsed(row.items)), locked: sanitiseLocked(parsed(row.locked)) } : null);
  }
  const [row] = await db
    .select({ items: dashboardLayouts.items })
    .from(dashboardLayouts)
    .where(and(eq(dashboardLayouts.organisationId, organisationId), eq(dashboardLayouts.surface, key), isNull(dashboardLayouts.userId)))
    .limit(1);
  return dashboardSnapshot(key, row ? (parsed(row.items) as unknown[]) : null);
}
