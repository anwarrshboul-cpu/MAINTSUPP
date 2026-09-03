import { and, eq, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import {
  formConfigurations,
  maintenanceBoardColumns,
  maintenanceGroups,
} from "../../../../db/schema";
import {
  createFormForBoard,
  formPasswordProblem,
  generateShareToken,
  generateShortToken,
  hashFormPassword,
  loadForm,
  presentedShareUrl,
  shareUrl,
  type FormRecord,
  type StoredFormConfig,
} from "../../../lib/form-config";
import type { FormSourceColumn } from "../../../lib/form-derive";
import { formOptionOverrides } from "../../../lib/form-options";
/*
 * The board key list, from the shared copy in the automation store rather than
 * the private `const BOARD_IDS` inside `/api/board`. A third transcription of
 * the same two strings is a third place to forget a board.
 */
import { BOARD_IDS, type BoardId } from "../../../lib/automations/store";
import { DEFAULT_BOARD_KEY, isBoardNotFound, resolveBoard } from "../../../lib/board-registry";
import {
  anonymousRefusal,
  scopedDb,
  scopedDbWithCapability,
} from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

/**
 * The form builder's own endpoint — read the whole configuration, write parts
 * of it back.
 *
 * WHY THIS IS SEPARATE FROM `/api/board/views`
 *
 * A Form view's TAB — its name, position, icon, whether it is the default — is
 * a view concern and belongs there. What the form ASKS, how it looks and who
 * may answer it is a different object with a different lifetime and a different
 * audience: the view row is read on every board load by everyone, this is read
 * by an admin who has opened the builder. Folding them together would put the
 * password hash and the response counter on the hot path of the tab strip.
 *
 * WRITES ARE A PATCH OF NAMED SECTIONS, NEVER A WHOLE-DOCUMENT PUT
 *
 * The Design panel and the Settings panel are open at different times and each
 * knows only its own half. A PUT would make whichever panel saved last clobber
 * the other's work with the stale copy it loaded when it opened. So each
 * section is applied only when the caller actually sends it, and anything
 * absent from the body is left exactly as stored.
 */

function failure(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function unavailable(error: unknown) {
  /* A board this organisation does not have is a bad REQUEST. Without this
     the handler answered 503 "temporarily unavailable" for a key that will
     never exist, telling the browser to retry something no retry can fix —
     the same mapping `/api/board` and `/api/board/views` already make. */
  if (isBoardNotFound(error)) return failure(error.message, 404);
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  return Response.json({ error: "The form is temporarily unavailable." }, { status: 503 });
}

/**
 * The builder's view of the form — the ONE serialiser both GET and PATCH use.
 *
 * It is a shared function rather than an object literal in each handler because
 * the handlers having their own copies is not hypothetical drift, it already
 * happened: GET returned `presentedUrl` and PATCH did not. The builder replaces
 * its whole state object with the PATCH response, so the first time an operator
 * touched any switch the Share dialog's URL box went empty and Copy link put
 * the literal string "undefined" on the clipboard — on the one control whose
 * entire job is to produce a working link.
 *
 * Unlike `publicForm()` this DOES include the hidden questions and the access
 * settings — an admin has to be able to see and change them. It still never
 * includes `password_hash`: `hasPassword` is the only thing the panel needs in
 * order to draw the toggle in the right position, and sending the hash would
 * put a PBKDF2 digest into the browser for no reason at all.
 */
function serialiseForm(
  request: Request,
  record: FormRecord,
  /**
   * The same substitution `/api/forms/[token]` serves, so the builder's
   * Preview projects EXACTLY the options a submitter will be offered — live
   * sites for Location, the canonical registry for Engineer and Priority —
   * rather than the captured monday snapshot.
   */
  optionOverrides: Record<string, Array<{ label: string; value: string }>>,
) {
  return {
    id: record.id,
    /*
     * WHICH BOARD THIS FORM IS. Sent because the builder has to be able to tell
     * the reader whose form they are editing, and because `filesIntoThisBoard`
     * below is only checkable against it.
     */
    boardKey: record.boardId,
    /*
     * Whether the builder's "view" mode may mount `FormView`.
     *
     * `FormView` posts to `/api/maintenance`, which files onto the DEFAULT
     * board and takes no board argument. Mounting it on a section's register
     * therefore drew the JOB BOARD's questions with a working Submit that filed
     * the job somewhere else entirely — the same leak `?board=` was, in the one
     * place the builder still had a hard-coded form. The comparison is made
     * HERE, where `DEFAULT_BOARD_KEY` is defined, rather than by the browser
     * comparing board keys it should not have to know.
     */
    filesIntoThisBoard: record.boardId === DEFAULT_BOARD_KEY,
    title: record.title,
    description: record.description,
    active: record.active,
    requireLogin: record.requireLogin,
    hasPassword: record.hasPassword,
    responseLimit: record.responseLimit,
    closeAt: record.closeAt,
    responseCount: record.responseCount,
    shareToken: record.shareToken,
    shortToken: record.shortToken,
    /* The long link, always — the dialog needs it for the "full link" case. */
    shareUrl: shareUrl(request, record.shareToken),
    /* What the dialog displays and the Copy button copies. */
    presentedUrl: presentedShareUrl(request, record),
    config: record.config,
    optionOverrides,
  };
}

/**
 * Which board's form this request is about.
 *
 * `?board=` WAS IGNORED. `loadForm(db, orgId)` defaults its `boardId` argument to
 * the literal "maintenance" (`app/lib/form-config.ts:130`), and neither handler
 * here ever passed one — so opening the form builder on Store Documentation
 * loaded, displayed and SAVED the maintenance board's form. The share link the
 * dialog offered was the maintenance form's link, and a PATCH from that screen
 * silently rewrote a different board's public form: the operator's own board
 * appeared to have no form of its own however many times they configured it, and
 * the form real submitters were filling in changed under them.
 *
 * AND THE ALLOW-LIST OF TWO WAS ITSELF A LEAK.
 *
 * `BOARD_IDS.includes(raw) ? raw : DEFAULT_BOARD_KEY` meant every key outside the
 * two built-ins — including every register generated for a workspace section —
 * resolved to the MAINTENANCE form. So `GET /api/board/form?board=<a section>`
 * served the job board's public form: its title, its questions, and its group
 * list, which on this estate is 39 groups NAMED AFTER REAL STORES. That form is
 * client-facing and shared by link, so the fallback published the estate to
 * anyone holding a section's form URL. A PATCH from that screen then rewrote the
 * maintenance form, which is the same "saved somebody else's board" failure the
 * note above describes, one layer out.
 *
 * The comment above said this rule "must agree" with `/api/board`'s own
 * `boardIdFrom`. It does again: that one now resolves the key against the boards
 * this organisation actually has and 404s an unknown one, and so does this. A
 * board with no form of its own answers the 404 the handlers already return
 * rather than borrowing one.
 */
async function boardIdFrom(
  request: Request,
  db: Parameters<typeof loadForm>[0],
  orgId: string,
): Promise<string> {
  const raw = new URL(request.url).searchParams.get("board")?.trim() ?? "";
  if (!raw || BOARD_IDS.includes(raw as BoardId)) {
    return BOARD_IDS.includes(raw as BoardId) ? raw : DEFAULT_BOARD_KEY;
  }
  const board = await resolveBoard(db, orgId, raw);
  return board.key;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    const boardId = await boardIdFrom(request, db, orgId);
    const record = await loadForm(db, orgId, boardId);
    /*
     * NO FORM YET IS NOT "NO FORM EVER", and the difference is the whole of
     * requirement B.
     *
     * `ensureFormBuilder` in db/init.ts seeds exactly one row per organisation,
     * for `board_id = 'maintenance'`, so every other register answered 404 here
     * and the product's answer to "give this section a form" was to hide the
     * tab. The 404 stays — there genuinely is no form to send — but it now
     * carries `canCreate`, so the builder can offer to make the board ONE OF
     * ITS OWN rather than falling back to somebody else's.
     *
     * `canCreate` is not a permission claim. It says a form could exist for
     * this board; POST below is what checks whether this caller may create it,
     * because a capability decided in a GET body is a capability decided twice.
     */
    if (!record) {
      return Response.json(
        { error: "This board has no form.", canCreate: true },
        { status: 404 },
      );
    }

    /*
     * The board's real groups, so "Group for answers" can offer what exists
     * rather than a fixed label. Sent with the form because the panel is
     * useless without them and a second request would mean a paint where the
     * selector is empty.
     */
    const groups = await db
      .select({ id: maintenanceGroups.id, name: maintenanceGroups.name })
      .from(maintenanceGroups)
      .where(
        and(
          eq(maintenanceGroups.organisationId, orgId),
          eq(maintenanceGroups.boardId, record.boardId),
        ),
      )
      .orderBy(maintenanceGroups.position);

    return Response.json({
      form: serialiseForm(
        request,
        record,
        await formOptionOverrides(db, orgId, record.config),
      ),
      groups,
    });
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * THIS BOARD'S OWN FORM, CREATED — W2 requirement B.
 *
 * The owner's words were "its own form ID, fields derived from the instance's
 * own columns, its own persisted settings, its own public/shared URL, and
 * submissions scoped to that instance", and explicitly not solved "by 404, by
 * hiding the action, or by pointing at canonical Jobs". This is the verb that
 * makes the first four true; `/api/forms/[token]/submit` makes the fifth.
 *
 * `board.edit`, the same capability that edits the form afterwards. Creating
 * one MINTS AN UNAUTHENTICATED WRITE PATH into this organisation's database, so
 * it cannot be a read: a `client`, whose capabilities are `board.view` and
 * `data.export`, must not be able to publish an intake by opening a tab.
 *
 * Idempotent, and deliberately so rather than 409: two people opening the Form
 * tab on the same register at the same moment should both see the same form,
 * not one error. `createFormForBoard` relies on the unique index for that, so
 * the outcome does not depend on the two requests being ordered.
 */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;

    const boardId = await boardIdFrom(request, db, orgId);
    const existing = await loadForm(db, orgId, boardId);
    if (existing) {
      return Response.json({
        ok: true,
        created: false,
        form: serialiseForm(
          request,
          existing,
          await formOptionOverrides(db, orgId, existing.config),
        ),
      });
    }

    /*
     * Resolved rather than assumed, for two reasons that are not the same: the
     * form is titled after the register, and an ARCHIVED board must not gain a
     * public intake. `resolveBoard` throws `BoardNotFoundError` for a key this
     * organisation does not have, which `unavailable` turns into a 404 — so a
     * key from another tenant cannot create anything here.
     */
    const board = await resolveBoard(db, orgId, boardId);
    if (board.archived) {
      return failure("This register is archived, so it cannot take a new form.", 409);
    }

    /*
     * THE INSTANCE'S OWN COLUMNS, and only its own. Scoped to (organisation,
     * board) and to the live ones — a column in the recoverable-columns bin is
     * not a field this register has. This query is the entire input to the
     * derivation: nothing downstream reads a board key, a kind or a template.
     */
    const columns = await db
      .select({
        id: maintenanceBoardColumns.id,
        key: maintenanceBoardColumns.key,
        title: maintenanceBoardColumns.title,
        type: maintenanceBoardColumns.type,
        required: maintenanceBoardColumns.required,
        system: maintenanceBoardColumns.system,
      })
      .from(maintenanceBoardColumns)
      .where(
        and(
          eq(maintenanceBoardColumns.organisationId, orgId),
          eq(maintenanceBoardColumns.boardId, board.key),
          isNull(maintenanceBoardColumns.deletedAt),
        ),
      )
      .orderBy(maintenanceBoardColumns.position);

    const created = await createFormForBoard(
      db,
      orgId,
      { key: board.key, name: board.name },
      columns as FormSourceColumn[],
    );
    if (!created) return failure("The form could not be created.", 503);

    const groups = await db
      .select({ id: maintenanceGroups.id, name: maintenanceGroups.name })
      .from(maintenanceGroups)
      .where(
        and(
          eq(maintenanceGroups.organisationId, orgId),
          eq(maintenanceGroups.boardId, created.boardId),
        ),
      )
      .orderBy(maintenanceGroups.position);

    return Response.json(
      {
        ok: true,
        created: true,
        form: serialiseForm(
          request,
          created,
          await formOptionOverrides(db, orgId, created.config),
        ),
        groups,
      },
      { status: 201 },
    );
  } catch (error) {
    return unavailable(error);
  }
}

/** Sections a PATCH may carry. Anything else in the body is ignored. */
type PatchBody = {
  title?: unknown;
  description?: unknown;
  active?: unknown;
  requireLogin?: unknown;
  /** null clears the password; a string sets one; absent leaves it alone. */
  password?: unknown;
  responseLimit?: unknown;
  closeAt?: unknown;
  questions?: unknown;
  order?: unknown;
  features?: unknown;
  appearance?: unknown;
  accessibility?: unknown;
  tags?: unknown;
  /** Mint a new share link, invalidating the old one. */
  regenerateToken?: unknown;
};

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;

    // The SAME board the GET above read. Without this a save from the Store
    // Documentation builder rewrote the maintenance board's public form.
    const boardId = await boardIdFrom(request, db, orgId);
    const record = await loadForm(db, orgId, boardId);
    if (!record) return failure("This board has no form.", 404);

    const body = (await request.json()) as PatchBody;
    const updates: Record<string, unknown> = {};
    const config: StoredFormConfig = record.config;

    /* ---- Identity ------------------------------------------------------- */
    if ("title" in body) {
      const title = text(body.title, 200);
      /*
       * A form with no title renders a blank card and, worse, gives the browser
       * tab of the public page nothing to say. Rejected rather than defaulted,
       * because silently substituting a title would hide the mistake.
       */
      if (!title) return failure("The form needs a title.");
      updates.title = title;
    }
    if ("description" in body) {
      updates.description = text(body.description, 600) || null;
    }

    /* ---- Access --------------------------------------------------------- */
    if ("active" in body) updates.active = Boolean(body.active);
    if ("requireLogin" in body) updates.requireLogin = Boolean(body.requireLogin);

    if ("password" in body) {
      if (body.password === null || body.password === "") {
        updates.passwordHash = null;
      } else {
        const problem = formPasswordProblem(body.password);
        if (problem) return failure(problem);
        updates.passwordHash = await hashFormPassword(String(body.password));
      }
    }

    if ("responseLimit" in body) {
      if (body.responseLimit === null) {
        updates.responseLimit = null;
      } else {
        const limit = Number(body.responseLimit);
        /*
         * Zero is refused even though it is a coherent limit, because the UI
         * has a switch for "not accepting responses" — Deactivate form — and a
         * limit of nought is a confusing second way to say it.
         */
        if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) {
          return failure("A response limit must be a whole number of at least 1.");
        }
        updates.responseLimit = limit;
      }
    }

    if ("closeAt" in body) {
      if (body.closeAt === null || body.closeAt === "") {
        updates.closeAt = null;
      } else {
        const raw = String(body.closeAt);
        /*
         * A DATE-ONLY value closes at the END of that day, not the start of it.
         *
         * The panel's control is `<input type="date">`, which submits
         * "2026-09-01". `new Date("2026-09-01")` is parsed by spec as UTC
         * MIDNIGHT, so storing it directly made "closes on 1 September" mean
         * "closed for the whole of 1 September" — the operator loses the day
         * they picked, and anyone west of UTC loses part of the day before it
         * too. Extending a bare date to 23:59:59.999 makes the chosen day the
         * last day the form accepts answers, which is what the words say.
         *
         * A full timestamp (from an API caller, or a future date-time control)
         * is honoured exactly as given.
         */
        const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
        const when = new Date(dateOnly ? `${raw}T23:59:59.999Z` : raw);
        if (Number.isNaN(when.getTime())) return failure("That close date is not a date.");
        updates.closeAt = when.toISOString();
      }
    }

    /* ---- The JSON sections ---------------------------------------------- */
    let configChanged = false;
    if (Array.isArray(body.questions)) {
      config.questions = body.questions as StoredFormConfig["questions"];
      configChanged = true;
    }
    if (Array.isArray(body.order)) {
      config.order = (body.order as unknown[]).map((entry) => String(entry));
      configChanged = true;
    }
    if (body.features && typeof body.features === "object") {
      config.features = { ...config.features, ...(body.features as object) };

      /*
       * The post-submission redirect is the one setting here that becomes a
       * NAVIGATION on somebody else's browser, so it is the one that has to be
       * checked rather than merged verbatim.
       *
       * The public form assigns it to `window.location`. Without this, an
       * operator — or anyone who reached this endpoint with `board.edit` —
       * could store `javascript:…` and have it execute in the context of every
       * submitter's session, or `data:`/`vbscript:` for the same effect. Only
       * http and https can be a redirect target; anything else is refused at
       * SAVE time so the bad value never reaches storage, and the person who
       * typed it finds out immediately rather than a submitter finding out.
       *
       * Protocol-relative ("//evil.example") is rejected too: `new URL` needs a
       * base to resolve it, and a stored value that means different things
       * depending on the page it is read from is not a URL we should keep.
       */
      const redirect = config.features.afterSubmissionView?.redirectAfterSubmission;
      if (redirect?.enabled && redirect.redirectUrl) {
        let parsed: URL | null = null;
        try {
          parsed = new URL(String(redirect.redirectUrl));
        } catch {
          parsed = null;
        }
        if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
          return failure(
            "A redirect must be a full http:// or https:// address.",
          );
        }
        redirect.redirectUrl = parsed.toString();
      }

      configChanged = true;
    }
    if (body.appearance && typeof body.appearance === "object") {
      config.appearance = { ...config.appearance, ...(body.appearance as object) };
      configChanged = true;
    }
    if (body.accessibility && typeof body.accessibility === "object") {
      config.accessibility = { ...config.accessibility, ...(body.accessibility as object) };
      configChanged = true;
    }
    if (Array.isArray(body.tags)) {
      config.tags = (body.tags as unknown[]).map((tag) => String(tag).slice(0, 60)).slice(0, 20);
      configChanged = true;
    }
    if (configChanged) updates.config = JSON.stringify(config);

    /* ---- Revoking the link ---------------------------------------------- */
    if (body.regenerateToken) {
      /* Both locators are replaced, or the old short link would still work. */
      updates.shareToken = generateShareToken();
      updates.shortToken = generateShortToken();
    }

    /*
     * Switching "Shorten URL" on for a form that predates the alias mints one.
     * Done here rather than in the seed so a form created before this feature
     * gains a short link the first time somebody asks for one.
     */
    if (
      config.features.shortenedLink?.enabled &&
      !record.shortToken &&
      !updates.shortToken
    ) {
      updates.shortToken = generateShortToken();
    }

    if (!Object.keys(updates).length) return Response.json({ ok: true, unchanged: true });

    updates.updatedAt = sql`CURRENT_TIMESTAMP`;
    await db.update(formConfigurations).set(updates).where(eq(formConfigurations.id, record.id));

    const saved = await loadForm(db, orgId, boardId);
    return Response.json({
      ok: true,
      form:
        saved &&
        serialiseForm(request, saved, await formOptionOverrides(db, orgId, saved.config)),
    });
  } catch (error) {
    return unavailable(error);
  }
}
