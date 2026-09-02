/**
 * WORKSTREAM 5/6 — `GET | POST | PATCH | DELETE /api/registers`.
 *
 * The configurable column structure behind BOTH the Sites register and the
 * Contractors register. `?register=sites|contractors` is the discriminator, and
 * that is the only difference between them: one route, one table, one set of
 * rules. The owner asked for the same five things on both screens — reorder,
 * rename, show and hide, resize, and add columns of your own — and a second
 * implementation would have been a second set of bugs.
 *
 * THE ONE RULE THAT SHAPES EVERY HANDLER BELOW. A column is NATIVE (a view onto
 * a real typed field on `sites` / `contractors`) or CUSTOM (somebody added it).
 * Both can be renamed, reordered, resized, hidden and shown, because all five
 * are facts about PRESENTATION and the register row is the presentation. Only a
 * custom column can be deleted, because deleting a native one would be an offer
 * to throw away the site's postcode along with the decision to stop looking at
 * it. "Remove" a native column means hide it, and that is what the refusal says.
 *
 * WHO MAY WRITE. `board.edit`, through `scopedDbWithCapability`. Not a new
 * capability: `board.edit` already means "create, update and move rows, columns
 * and groups" in this product, a register column is a column, and a capability
 * nobody has seeded into a role is a capability nobody holds — a new key would
 * have locked the owner out of their own register until Roles was edited.
 * Reading is open to any member, because the register has to be drawable by
 * everybody who can see it at all.
 *
 * WHY 404 AND NOT 403 FOR A FOREIGN ID. Every lookup filters on
 * `organisation_id` inside the WHERE, so another tenant's column id and an id
 * that never existed are the same answer. Telling them apart would tell a
 * caller which ids exist inside a workspace they may not read. Same reasoning,
 * and the same wording, as `contractorTarget` in `app/api/workspace/route.ts`.
 */

import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { registerColumns } from "../../../db/schema";
import {
  anonymousRefusal,
  scopedDb,
  scopedDbWithCapability,
  type ScopedDatabase,
} from "../../lib/tenant-db";
import { auditActor, recordAudit } from "../../lib/audit";
import { can, resolvePermissions } from "../../lib/permissions";
import { databaseSafeFailure } from "../../lib/database-failure";
import {
  REGISTER_COLUMN_TYPES,
  isRegisterColumnType,
  isRegisterKey,
  type RegisterKey,
} from "../../lib/register-catalogue";
import {
  MAX_REGISTER_COLUMN_WIDTH,
  MIN_REGISTER_COLUMN_WIDTH,
  clampRegisterWidth,
  columnKeyFrom,
  findRegisterColumn,
  loadRegisterColumns,
  loadRegisterValues,
  nextColumnPosition,
  reorderRegisterColumns,
  toRegisterColumn,
} from "../../lib/register-columns";

export const dynamic = "force-dynamic";

/**
 * How many columns one register may carry.
 *
 * Sites seeds 40 native columns, so the cap is a ceiling on what somebody adds
 * rather than on what ships. A register is a table a person reads across; past
 * a hundred or so columns it is a database export with a scrollbar, and the
 * horizontal scroll on a phone stops being usable long before that.
 */
const MAX_REGISTER_COLUMNS = 120;

/** Longest a column label may be. The board uses the same figure. */
const MAX_TITLE_LENGTH = 80;

/**
 * The register named by the request, or a refusal.
 *
 * Refused rather than defaulted. A missing `register` on a write is a client
 * bug, and answering it by picking Sites would silently add somebody's
 * contractor column to the site register — a wrong answer that looks like a
 * right one, which is the class of failure this codebase spends its comments on.
 */
function readRegister(value: unknown): { register: RegisterKey } | { refusal: Response } {
  if (isRegisterKey(value)) return { register: value };
  return {
    refusal: Response.json(
      {
        error: "Name the register: sites or contractors.",
        registers: ["sites", "contractors"],
      },
      { status: 400 },
    ),
  };
}

function trimTitle(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_TITLE_LENGTH) : "";
}

/**
 * One audit line about a register column.
 *
 * A column is structure the whole workspace shares: adding, renaming, hiding or
 * removing one changes what every colleague sees when they open the register,
 * which is exactly the class of change W13-05 asks to be attributable. WIDTH IS
 * NOT AUDITED — a drag fires many times a minute, it is a per-column preference
 * rather than structure, and logging it would bury the events somebody is
 * actually looking for. `app/api/board/route.ts` draws the same line, in
 * `structuralColumnChange`.
 */
async function recordColumnChange(
  scope: ScopedDatabase,
  request: Request,
  action: string,
  entityId: string,
  summary: string,
  detail: unknown,
) {
  await recordAudit({
    db: scope.db,
    organisationId: scope.orgId,
    actor: auditActor(scope),
    action,
    entityType: "register_column",
    entityId,
    summary,
    detail,
    request,
  });
}

/**
 * GET — every live column of one register, hidden ones included.
 *
 * HIDDEN COLUMNS ARE RETURNED, carrying `hidden: true`, rather than filtered
 * out. A "show hidden" control cannot offer to restore a column it was never
 * told about, and the alternative — a second endpoint for the hidden ones — is
 * a second place to forget the organisation filter. The grid draws the ones
 * where `hidden` is false; the settings panel draws them all.
 *
 * The custom VALUES come back in the same response. A register is columns and
 * cells together, and a second round trip for the other half would double the
 * cost of opening a screen for no gain. Native values are not here and never
 * will be — they are on the site or contractor row, which the caller is already
 * fetching.
 */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const named = readRegister(new URL(request.url).searchParams.get("register"));
    if ("refusal" in named) return named.refusal;

    const scope = await scopedDb(request);
    const columns = await loadRegisterColumns(scope.db, scope.orgId, named.register);
    const values = await loadRegisterValues(scope.db, scope.orgId, named.register);

    /* Resolved once and asked twice, rather than two `scopedDbWithCapability`
       probes: each of those re-resolves tenant access from scratch, and this is
       the read path every open of the register goes through. */
    const subject = await resolvePermissions(scope.db, scope.orgId, scope.actor.role);
    return Response.json({
      register: named.register,
      columns,
      values,
      /* Stated rather than inferred from the role, because a role whose
         `board.edit` was revoked in Roles is still called "Admin". */
      canConfigure: can(subject, "board.edit"),
      canEditValues: can(subject, "sites.edit"),
      /* What a new column may be, so the editor needs no copy of the list and
         cannot offer a type the server would refuse. */
      types: REGISTER_COLUMN_TYPES,
      widthRange: { min: MIN_REGISTER_COLUMN_WIDTH, max: MAX_REGISTER_COLUMN_WIDTH },
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    /*
     * A driver fault answers 503 with a fixed sentence instead of the failing
     * statement; every other error keeps the status and message chosen above.
     * See app/lib/database-failure.ts — this leak only appears on Postgres.
     */
    const failure = databaseSafeFailure(error, "The register columns could not be loaded.", 503);
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}

/**
 * POST — add a CUSTOM column. Body: `{ register, title, type? }`.
 *
 * The server generates the key. A client-supplied key would be a second thing
 * to validate, a second thing to collide, and an invitation to write
 * `managerEmail` by hand and quietly shadow a native column.
 */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const named = readRegister(body.register);
    if ("refusal" in named) return named.refusal;
    const register = named.register;

    const title = trimTitle(body.title);
    if (!title) {
      return Response.json({ error: "Give the column a name." }, { status: 400 });
    }
    const key = columnKeyFrom(title);
    if (!key) {
      return Response.json(
        { error: "That name has no letters or digits in it, so it cannot be addressed." },
        { status: 400 },
      );
    }
    /* An absent type takes text; a NAMED one this register cannot honour is
       refused rather than substituted. Silently handing somebody who asked for
       a rating a text box is worse than saying no — see `REGISTER_COLUMN_TYPES`
       for why the list is a subset of the board's. */
    if (body.type !== undefined && !isRegisterColumnType(body.type)) {
      return Response.json(
        { error: "That is not a column type this register can hold.", types: REGISTER_COLUMN_TYPES },
        { status: 400 },
      );
    }
    const type = isRegisterColumnType(body.type) ? body.type : "text";

    /* Seeds the native catalogue if this is the organisation's first touch of
       the register, so a collision check on a fresh workspace compares against
       the real list rather than an empty one. */
    const live = await loadRegisterColumns(scope.db, scope.orgId, register);
    if (live.length >= MAX_REGISTER_COLUMNS) {
      return Response.json(
        { error: `A register can carry ${MAX_REGISTER_COLUMNS} columns.` },
        { status: 409 },
      );
    }

    /* The unique index covers deleted rows too, so a removed column's key is
       still taken and the insert below would fail on a constraint rather than a
       sentence. Looked up including deleted rows for exactly that reason, and
       answered with `removed: true` so the client can offer Restore — which is
       `PATCH { id, restore: true }` — instead of a dead end. */
    const [clash] = await scope.db
      .select()
      .from(registerColumns)
      .where(
        and(
          eq(registerColumns.organisationId, scope.orgId),
          eq(registerColumns.registerKey, register),
          eq(registerColumns.columnKey, key),
        ),
      )
      .limit(1);
    if (clash) {
      return Response.json(
        clash.deletedAt
          ? {
              error: `"${clash.title}" was removed and can be restored. Restore it instead of adding it again.`,
              removed: true,
              key,
              id: clash.id,
            }
          : {
              error: `A column called "${clash.title}" already exists on this register.`,
              key,
              id: clash.id,
            },
        { status: 409 },
      );
    }

    const now = new Date().toISOString();
    const id = `rcol_${crypto.randomUUID().replace(/-/g, "")}`;
    await scope.db.insert(registerColumns).values({
      id,
      organisationId: scope.orgId,
      registerKey: register,
      columnKey: key,
      title,
      type,
      position: await nextColumnPosition(scope.db, scope.orgId, register),
      width: 180,
      // NULL is what makes this column custom. Everything downstream reads that
      // one field to decide where the values live.
      nativeField: null,
      settings: "{}",
      createdAt: now,
      updatedAt: now,
    });

    /*
     * DENSE AFTER AN ADD, TOO — the half `nextColumnPosition` cannot give.
     *
     * That function takes `MAX(position) + 1` over EVERY row including the
     * soft-deleted ones, and it has to: a position it handed out twice would be
     * a duplicate the moment a removed column was restored. But it means that
     * on a register which has ever had a column removed, the new column lands
     * past the end of the live run — 42 live columns and a removed one at 43
     * puts the next addition at 44 — and nothing else closed that gap. The
     * register still DREW correctly, because every reader sorts by position and
     * a gap reorders nothing; what broke was the invariant this module states
     * twice and a test asserts: "positions are 0..n-1 with no duplicates".
     *
     * Renumbering here is the same call `DELETE` already makes for the same
     * reason, and it is why `created` is read AFTER it rather than before —
     * otherwise the 201 would report the pre-renumber position and the client
     * would insert the row at the wrong index.
     */
    await reorderRegisterColumns(scope.db, scope.orgId, register, []);

    const created = await findRegisterColumn(scope.db, scope.orgId, id);
    await recordColumnChange(
      scope,
      request,
      "register.column_created",
      id,
      `Added the "${title}" column to the ${register} register.`,
      { register, key, title, type },
    );
    return Response.json(
      { column: created ? toRegisterColumn(created) : null },
      { status: 201 },
    );
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    /*
     * A driver fault answers 503 with a fixed sentence instead of the failing
     * statement; every other error keeps the status and message chosen above.
     * See app/lib/database-failure.ts — this leak only appears on Postgres.
     */
    const failure = databaseSafeFailure(error, "The column could not be added.", 400);
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}

/**
 * PATCH — reorder, rename, resize, hide, show, restore.
 *
 * Dispatches on the body's SHAPE, which is the pattern the board already uses
 * and the reason the four single-column verbs do not need four endpoints:
 *
 *   `{ register, order: [...] }`  bulk reorder, positions rewritten densely
 *   `{ id, title }`               rename — the LABEL only, never the field
 *   `{ id, width }`               resize, clamped rather than refused
 *   `{ id, hidden: boolean }`     hide or show
 *   `{ id, restore: true }`       bring back a removed custom column
 *
 * A rename is allowed on a native column and changes `title` and nothing else.
 * That is the whole point of the split: "Store" can become "Branch" on the
 * register without `sites.name` being touched, so every join, every import and
 * every other screen keeps working while the label reads the way the business
 * talks.
 */
export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    if (Array.isArray(body.order)) {
      const named = readRegister(body.register);
      if ("refusal" in named) return named.refusal;
      const columns = await reorderRegisterColumns(
        scope.db,
        scope.orgId,
        named.register,
        body.order.filter((entry): entry is string => typeof entry === "string"),
      );
      await recordColumnChange(
        scope,
        request,
        "register.columns_reordered",
        columns[0]?.id ?? named.register,
        `Reordered the columns on the ${named.register} register.`,
        { register: named.register, order: columns.map((column) => column.key) },
      );
      return Response.json({ register: named.register, columns });
    }

    const id = typeof body.id === "string" ? body.id.trim() : "";

    /* Restore is looked up SEPARATELY because every other lookup here excludes
       deleted rows, and a restore that could not see the row it is restoring
       would be a 404 on the only id that could possibly work. */
    if (body.restore === true) {
      const [removed] = await scope.db
        .select()
        .from(registerColumns)
        .where(
          and(eq(registerColumns.id, id), eq(registerColumns.organisationId, scope.orgId)),
        )
        .limit(1);
      if (!removed) {
        return Response.json({ error: "That column does not exist." }, { status: 404 });
      }
      await scope.db
        .update(registerColumns)
        .set({ deletedAt: null, deletedBy: null, updatedAt: new Date().toISOString() })
        .where(
          and(eq(registerColumns.id, id), eq(registerColumns.organisationId, scope.orgId)),
        );
      /*
       * And after a RESTORE, for the same reason and with one more of its own:
       * a restored column carries the position it held before it was removed,
       * which is both past the live run AND capable of colliding with a live
       * column that has since been renumbered onto it. `byPosition` breaks that
       * tie deterministically so nothing renders wrongly, but "no two columns
       * share a position" should not depend on a tiebreaker.
       */
      await reorderRegisterColumns(
        scope.db,
        scope.orgId,
        removed.registerKey as RegisterKey,
        [],
      );

      const restored = await findRegisterColumn(scope.db, scope.orgId, id);
      await recordColumnChange(
        scope,
        request,
        "register.column_restored",
        id,
        `Restored the "${removed.title}" column on the ${removed.registerKey} register.`,
        { register: removed.registerKey, key: removed.columnKey },
      );
      return Response.json({ column: restored ? toRegisterColumn(restored) : null });
    }

    const existing = await findRegisterColumn(scope.db, scope.orgId, id);
    if (!existing) {
      return Response.json({ error: "That column does not exist." }, { status: 404 });
    }

    const patch: Partial<typeof registerColumns.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };
    /* What the audit line will say, and whether there is one at all. A width
       drag leaves this empty and files nothing. */
    const changes: string[] = [];

    if (body.title !== undefined) {
      const title = trimTitle(body.title);
      if (!title) {
        return Response.json({ error: "Give the column a name." }, { status: 400 });
      }
      /* THE LABEL, NOT THE FIELD. `columnKey` and `nativeField` are untouched
         here and nowhere in this file writes them after creation — which is
         what makes renaming a native column safe. */
      if (title !== existing.title) {
        patch.title = title;
        changes.push(`renamed "${existing.title}" to "${title}"`);
      }
    }

    if (body.width !== undefined) {
      const width = clampRegisterWidth(body.width);
      if (width === null) {
        return Response.json({ error: "A column width must be a number." }, { status: 400 });
      }
      patch.width = width;
    }

    if (body.hidden !== undefined) {
      if (typeof body.hidden !== "boolean") {
        return Response.json(
          { error: "A column is hidden or it is not; say true or false." },
          { status: 400 },
        );
      }
      /* A TIMESTAMP, NOT A FLAG. See the header of `register-columns.ts`: a
         column named `visible` on this table would be rewritten to a Postgres
         boolean comparison by the bare-name rule in `sqlite-to-postgres.ts` and
         would be silently wrong deployed while passing locally. */
      const hiddenAt = body.hidden ? new Date().toISOString() : null;
      if ((existing.hiddenAt !== null) !== body.hidden) {
        patch.hiddenAt = hiddenAt;
        changes.push(body.hidden ? `hid "${existing.title}"` : `showed "${existing.title}"`);
      }
    }

    await scope.db
      .update(registerColumns)
      .set(patch)
      .where(and(eq(registerColumns.id, id), eq(registerColumns.organisationId, scope.orgId)));

    const updated = await findRegisterColumn(scope.db, scope.orgId, id);
    if (changes.length > 0) {
      await recordColumnChange(
        scope,
        request,
        "register.column_updated",
        id,
        `On the ${existing.registerKey} register, ${changes.join(" and ")}.`,
        {
          register: existing.registerKey,
          key: existing.columnKey,
          native: existing.nativeField !== null,
          changes,
        },
      );
    }
    return Response.json({ column: updated ? toRegisterColumn(updated) : null });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    /*
     * A driver fault answers 503 with a fixed sentence instead of the failing
     * statement; every other error keeps the status and message chosen above.
     * See app/lib/database-failure.ts — this leak only appears on Postgres.
     */
    const failure = databaseSafeFailure(error, "The column could not be changed.", 400);
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}

/**
 * DELETE `?id=` — remove a CUSTOM column.
 *
 * A NATIVE COLUMN IS REFUSED, with the instruction rather than just the
 * refusal. "Remove this column" and "stop showing me this column" are the same
 * sentence in a person's head, and a register that answered the second with a
 * bare 409 would leave somebody hunting for a Hide they had already found.
 *
 * SOFT, AND THE VALUES STAY. `deleted_at` is set and `register_values` is left
 * alone, so restoring the column brings its data back with it. Deleting the
 * values here would have made the column recoverable and its contents not,
 * which is the worst of the three available answers — the same reasoning the
 * board applies to a deleted column's attachments in `app/api/board/route.ts`.
 *
 * The survivors are renumbered afterwards so positions stay dense. A gap does
 * no harm to the ordering, but "positions are 0..n-1 with no duplicates" is an
 * invariant worth being able to state without qualification.
 */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;

    const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
    const existing = await findRegisterColumn(scope.db, scope.orgId, id);
    if (!existing) {
      return Response.json({ error: "That column does not exist." }, { status: 404 });
    }
    if (existing.nativeField !== null) {
      return Response.json(
        { error: "Native columns cannot be deleted. Hide it instead." },
        { status: 409 },
      );
    }

    await scope.db
      .update(registerColumns)
      .set({
        deletedAt: new Date().toISOString(),
        deletedBy: scope.identityEmail,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(registerColumns.id, id), eq(registerColumns.organisationId, scope.orgId)));

    const register = existing.registerKey as RegisterKey;
    const columns = await reorderRegisterColumns(scope.db, scope.orgId, register, []);
    await recordColumnChange(
      scope,
      request,
      "register.column_deleted",
      id,
      `Removed the "${existing.title}" column from the ${register} register, keeping its values.`,
      { register, key: existing.columnKey, title: existing.title },
    );
    return Response.json({ ok: true, register, columns });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    /*
     * A driver fault answers 503 with a fixed sentence instead of the failing
     * statement; every other error keeps the status and message chosen above.
     * See app/lib/database-failure.ts — this leak only appears on Postgres.
     */
    const failure = databaseSafeFailure(error, "The column could not be removed.", 400);
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}

