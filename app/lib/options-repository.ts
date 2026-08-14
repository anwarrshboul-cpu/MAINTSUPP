import { and, asc, eq } from "drizzle-orm";
import type { getDb } from "../../db";
import { optionSets, optionValues } from "../../db/schema";

type Database = Awaited<ReturnType<typeof getDb>>;

export type OptionValueRow = {
  id: string;
  value: string;
  label: string;
  colourHex: string;
  textColour: string;
  position: number;
  isDone: boolean;
  isDefault: boolean;
  active: boolean;
  system: boolean;
};

/**
 * M3 — option lookup cache.
 *
 * Option lists are read on nearly every request (the board renders 24 statuses;
 * the public form renders sites, priorities and engineers) but change only when
 * an admin edits them. Caching inside the Worker isolate removes those repeated
 * D1 round trips. The TTL is deliberately short: isolates recycle often, so a
 * stale entry cannot survive long, and every write through the options API
 * invalidates the key immediately.
 *
 * The key includes the organisation ID, so one tenant's cache can never serve
 * another tenant's labels.
 */
const CACHE_TTL_MS = 30_000;

type CacheEntry = { expires: number; rows: OptionValueRow[] };

const cache = new Map<string, CacheEntry>();

function cacheKey(organisationId: string, key: string) {
  return `${organisationId}::${key}`;
}

export function invalidateOptionCache(organisationId: string, key?: string) {
  if (key) {
    cache.delete(cacheKey(organisationId, key));
    return;
  }
  for (const existing of [...cache.keys()]) {
    if (existing.startsWith(`${organisationId}::`)) cache.delete(existing);
  }
}

async function fetchOptionValues(
  db: Database,
  organisationId: string,
  key: string,
): Promise<OptionValueRow[]> {
  return db
    .select({
      id: optionValues.id,
      value: optionValues.value,
      label: optionValues.label,
      colourHex: optionValues.colourHex,
      textColour: optionValues.textColour,
      position: optionValues.position,
      isDone: optionValues.isDone,
      isDefault: optionValues.isDefault,
      active: optionValues.active,
      system: optionValues.system,
    })
    .from(optionValues)
    .innerJoin(optionSets, eq(optionValues.optionSetId, optionSets.id))
    .where(
      and(
        eq(optionSets.organisationId, organisationId),
        eq(optionSets.key, key),
        eq(optionValues.organisationId, organisationId),
      ),
    )
    .orderBy(asc(optionValues.position));
}

export async function listOptionValues(
  db: Database,
  organisationId: string,
  key: string,
): Promise<OptionValueRow[]> {
  const id = cacheKey(organisationId, key);
  const hit = cache.get(id);
  if (hit && hit.expires > Date.now()) return hit.rows;

  const rows = await fetchOptionValues(db, organisationId, key);
  cache.set(id, { expires: Date.now() + CACHE_TTL_MS, rows });
  return rows;
}

export async function listActiveOptionValues(
  db: Database,
  organisationId: string,
  key: string,
) {
  const rows = await listOptionValues(db, organisationId, key);
  return rows.filter((row) => row.active);
}

export async function listOptionSets(db: Database, organisationId: string) {
  const sets = await db
    .select()
    .from(optionSets)
    .where(eq(optionSets.organisationId, organisationId))
    .orderBy(asc(optionSets.name));
  return Promise.all(
    sets.map(async (set) => ({
      ...set,
      values: await listOptionValues(db, organisationId, set.key),
    })),
  );
}

/**
 * Resolves a submitted value against the configured list. Returns the workspace
 * default when the candidate is empty, and an empty string when the set has no
 * active values at all — the caller decides whether that is an error.
 *
 * The return type is `string`, never a union: the permitted set lives in the
 * database, so the compiler cannot and must not enumerate it.
 */
export async function configuredValue(
  db: Database,
  organisationId: string,
  key: string,
  candidate: unknown,
): Promise<string> {
  const values = await listOptionValues(db, organisationId, key);
  const text = typeof candidate === "string" ? candidate.trim() : "";
  const match = values.find((item) => item.active && item.value === text);
  const fallback =
    values.find((item) => item.active && item.isDefault) ??
    values.find((item) => item.active);
  return match?.value ?? fallback?.value ?? "";
}

/** True when the value exists and is active — used to reject unknown input. */
export async function isConfiguredValue(
  db: Database,
  organisationId: string,
  key: string,
  candidate: string,
) {
  const values = await listOptionValues(db, organisationId, key);
  return values.some((item) => item.active && item.value === candidate);
}
