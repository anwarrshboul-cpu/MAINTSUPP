/**
 * WORKSTREAM 5/6 — `PATCH /api/registers/values`.
 *
 * One cell of a CUSTOM register column, for one site or one contractor.
 *
 * THIS ROUTE EXISTS TO REFUSE HALF OF ITS TRAFFIC. A register draws native
 * columns and custom columns side by side and they look identical in the grid,
 * so a client that edits a cell will reach for one writer for both. If that
 * writer accepted a native key, `register_values` would start accumulating a
 * SECOND copy of every postcode, day rate and lease end — and the copies would
 * diverge the first time anybody edited a site through the ordinary form. Two
 * stores for one fact is two answers to one question with nothing marking
 * either as wrong.
 *
 * So a native key is refused here, with the instruction: write it through the
 * entity's own API — `PATCH /api/sites` or `PATCH /api/workspace { entity:
 * "contractor" }` — which is where every validator, every uniqueness rule and
 * every audit line for that field already lives. The refusal is a 400 rather
 * than a 404 because the column DOES exist; what does not exist is a place to
 * put its value here.
 *
 * WHO MAY WRITE. `sites.edit` — "change the site register, units and compliance
 * records" — because this is entity data, not structure. Structure is
 * `board.edit`, on `/api/registers`. The two are deliberately different: a
 * coordinator who may correct a site's details should not need the capability
 * that lets them rearrange the register for everybody, and neither should imply
 * the other.
 */

import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { registerValues } from "../../../../db/schema";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";
import { isRegisterKey } from "../../../lib/register-catalogue";
import { databaseSafeFailure } from "../../../lib/database-failure";
import {
  findRegisterColumnByKey,
  registerEntityExists,
} from "../../../lib/register-columns";

export const dynamic = "force-dynamic";

/**
 * Longest a custom cell may be.
 *
 * Generous enough for a long-text note and for the JSON a multi-select holds,
 * and REFUSED rather than truncated past it. Truncation is silent data loss:
 * somebody pastes a paragraph, the save succeeds, and the last third is gone
 * with nothing on screen to say so.
 */
const MAX_VALUE_LENGTH = 4000;

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (!isRegisterKey(body.register)) {
      return Response.json(
        { error: "Name the register: sites or contractors.", registers: ["sites", "contractors"] },
        { status: 400 },
      );
    }
    const register = body.register;
    const entityId = typeof body.entityId === "string" ? body.entityId.trim() : "";
    const columnKey = typeof body.columnKey === "string" ? body.columnKey.trim() : "";
    if (!entityId || !columnKey) {
      return Response.json(
        { error: "Name the row and the column to change." },
        { status: 400 },
      );
    }
    /* An ABSENT `value` is not the same as a cleared one. `{ value: null }`
       empties the cell; a body with no `value` at all is a client that forgot
       to send one, and answering it by clearing the cell would delete data on
       the strength of a bug. */
    if (!("value" in body)) {
      return Response.json({ error: "No value was sent." }, { status: 400 });
    }

    const column = await findRegisterColumnByKey(scope.db, scope.orgId, register, columnKey);
    if (!column) {
      return Response.json({ error: "That column does not exist." }, { status: 404 });
    }
    if (column.nativeField !== null) {
      return Response.json(
        {
          error: `"${column.title}" is a built-in field. Change it on the ${
            register === "sites" ? "site" : "contractor"
          } itself, not here.`,
          nativeField: column.nativeField,
        },
        { status: 400 },
      );
    }

    /* BEFORE ANY WRITE, and answered from the entity's own table. `entity_id`
       carries no foreign key — it points at two tables depending on the
       register, which is not a relationship SQL can express — so this is the
       only thing between a foreign id and a cell written against another
       tenant's site. 404, not 403: see the header of `/api/registers`. */
    if (!(await registerEntityExists(scope.db, scope.orgId, register, entityId))) {
      return Response.json(
        { error: register === "sites" ? "Site not found." : "Contractor not found." },
        { status: 404 },
      );
    }

    const raw = body.value;
    if (raw !== null && typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      return Response.json(
        { error: "A cell holds text. Send a string, or null to clear it." },
        { status: 400 },
      );
    }
    const value = raw === null ? null : String(raw);
    if (value !== null && value.length > MAX_VALUE_LENGTH) {
      return Response.json(
        { error: `That is longer than ${MAX_VALUE_LENGTH} characters.` },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();

    /* AN EMPTY CELL IS AN ABSENT ROW, not a row holding "".
     *
     * Both read back the same through `loadRegisterValues`, so storing the
     * empty string would only mean carrying a row that says nothing — and it
     * would make "never filled in" and "cleared" indistinguishable in the table
     * while looking distinguishable in a COUNT. Clearing deletes. */
    if (value === null || value === "") {
      await scope.db
        .delete(registerValues)
        .where(
          and(
            eq(registerValues.organisationId, scope.orgId),
            eq(registerValues.registerKey, register),
            eq(registerValues.entityId, entityId),
            eq(registerValues.columnKey, columnKey),
          ),
        );
      return Response.json({ value: { entityId, columnKey, value: null } });
    }

    /* Upsert on the unique cell index rather than select-then-insert: two
       browsers editing the same cell would both see no row and both insert, and
       the loser would get a constraint violation dressed up as a 400. */
    await scope.db
      .insert(registerValues)
      .values({
        id: `rval_${crypto.randomUUID().replace(/-/g, "")}`,
        organisationId: scope.orgId,
        registerKey: register,
        entityId,
        columnKey,
        value,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          registerValues.organisationId,
          registerValues.registerKey,
          registerValues.entityId,
          registerValues.columnKey,
        ],
        set: { value, updatedAt: now },
      });

    return Response.json({ value: { entityId, columnKey, value } });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    /*
     * A driver fault answers 503 with a fixed sentence instead of the failing
     * statement; every other error keeps the status and message chosen above.
     * See app/lib/database-failure.ts — this leak only appears on Postgres.
     */
    const failure = databaseSafeFailure(error, "The cell could not be saved.", 400);
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}

