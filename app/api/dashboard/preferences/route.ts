/**
 * THE OVERVIEW'S TWO PER-USER PREFERENCES.
 *
 * §1.1 asks for the Measure-by toggle to "persist per user", and §5.3 for the
 * Split-by-priority toggle to do the same. Neither is a filter and neither is
 * workspace configuration: they are how one person prefers to read the page.
 *
 * ── WHY NOT `localStorage` ────────────────────────────────────────────────
 *
 * Because the ops pages are held to not using it. `tests/ops-rebuild-
 * foundations.test.mjs` asserts the absence of `localStorage` across all four
 * of them, and the reason is in that file: a preference kept in the browser is
 * per-person-per-BROWSER, so the same operator on a phone and a laptop reads
 * two differently-configured pages and neither is wrong. The URL carries the
 * state a link should carry; this carries the state a person should keep.
 *
 * ── WHY `section_view_preferences` AND NOT A NEW TABLE ────────────────────
 *
 * That table already means exactly this: "which view of a section this user
 * landed on last". It is keyed (organisation, section, user) and holds one
 * opaque `view_key`. Two rows under the reserved section keys `overview:measure`
 * and `overview:split` are the whole implementation, and a section key
 * namespaced with a colon cannot collide with a real `workspace_sections.key`,
 * which is generated as `sec-<hex>`.
 *
 * ── THE URL STILL WINS ────────────────────────────────────────────────────
 *
 * A stored preference SEEDS the page; a parameter in the address bar overrides
 * it. That order matters: a link somebody sends must mean what the sender saw,
 * and a preference that quietly rewrote a shared link would make every link
 * mean something different to each reader.
 */

import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { sectionViewPreferences } from "../../../../db/schema";
import {
  anonymousRefusal,
  busyRefusal,
  scopedDbWithCapability,
  type ScopedDatabase,
} from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

/** The reserved section keys. Namespaced so they cannot collide with `sec-…`. */
const KEYS = {
  measure: "overview:measure",
  split: "overview:split",
} as const;

/** What each preference is allowed to be. An unknown value is ignored, not stored. */
const ALLOWED: Record<keyof typeof KEYS, readonly string[]> = {
  measure: ["requested", "completed"],
  split: ["on", "off"],
};

type Preferences = { measure: string; split: string };

const DEFAULTS: Preferences = { measure: "requested", split: "off" };

async function read(scope: ScopedDatabase): Promise<Preferences> {
  const rows = await scope.db
    .select({
      sectionKey: sectionViewPreferences.sectionKey,
      viewKey: sectionViewPreferences.viewKey,
    })
    .from(sectionViewPreferences)
    .where(
      and(
        eq(sectionViewPreferences.organisationId, scope.orgId),
        eq(sectionViewPreferences.userId, scope.identityEmail),
      ),
    );
  const found = { ...DEFAULTS };
  for (const row of rows) {
    for (const name of Object.keys(KEYS) as Array<keyof typeof KEYS>) {
      if (row.sectionKey === KEYS[name] && ALLOWED[name].includes(row.viewKey)) {
        found[name] = row.viewKey;
      }
    }
  }
  return found;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    return Response.json(await read(guard.scope));
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabase();
    /*
     * `board.view`, not `board.edit`. A reader who may see the page may decide
     * how they read it; requiring an edit capability to remember a toggle would
     * make the page behave differently for the people it was built for.
     */
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return Response.json({ error: "Send a JSON body." }, { status: 400 });

    for (const name of Object.keys(KEYS) as Array<keyof typeof KEYS>) {
      const value = typeof body[name] === "string" ? (body[name] as string).trim() : null;
      if (!value || !ALLOWED[name].includes(value)) continue;

      /*
       * Upsert by hand rather than by `ON CONFLICT`: there is no unique index
       * on (organisation, section, user), and `INSERT OR IGNORE … RETURNING`
       * returns zero rows on a conflict, so neither shortcut can tell an insert
       * from a no-op. Two statements, and the read decides which.
       */
      const existing = await scope.db
        .select({ id: sectionViewPreferences.id })
        .from(sectionViewPreferences)
        .where(
          and(
            eq(sectionViewPreferences.organisationId, scope.orgId),
            eq(sectionViewPreferences.userId, scope.identityEmail),
            eq(sectionViewPreferences.sectionKey, KEYS[name]),
          ),
        )
        .limit(1);

      if (existing[0]) {
        await scope.db
          .update(sectionViewPreferences)
          .set({ viewKey: value, updatedBy: scope.identityEmail })
          .where(eq(sectionViewPreferences.id, existing[0].id));
      } else {
        await scope.db.insert(sectionViewPreferences).values({
          id: `svp_${scope.orgId}_${name}_${Buffer.from(scope.identityEmail)
            .toString("hex")
            .slice(0, 24)}`,
          organisationId: scope.orgId,
          sectionKey: KEYS[name],
          userId: scope.identityEmail,
          viewKey: value,
          updatedBy: scope.identityEmail,
        });
      }
    }

    return Response.json(await read(scope));
  } catch (error) {
    return failure(error);
  }
}

/**
 * The same three-arm refusal every dashboard route uses: a dead session is 401
 * so the browser can offer sign-in, a full connection pool is 503 with a retry
 * flag, and anything else is 503 with no detail outside development.
 */
function failure(error: unknown): Response {
  const anonymous = anonymousRefusal(error);
  if (anonymous) return anonymous;
  const busy = busyRefusal(error, "Preferences could not be read.");
  if (busy) return busy;
  console.error("[/api/dashboard/preferences]", error, (error as { cause?: unknown })?.cause);
  return Response.json(
    {
      error: "Preferences are temporarily unavailable.",
      ...(process.env.NODE_ENV === "development"
        ? { detail: error instanceof Error ? error.message : String(error) }
        : {}),
    },
    { status: 503 },
  );
}
