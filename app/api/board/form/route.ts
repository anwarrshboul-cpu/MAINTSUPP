import { eq, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { formConfigurations } from "../../../../db/schema";
import {
  formPasswordProblem,
  generateShareToken,
  generateShortToken,
  hashFormPassword,
  loadForm,
  presentedShareUrl,
  shareUrl,
  type StoredFormConfig,
} from "../../../lib/form-config";
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
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  return Response.json({ error: "The form is temporarily unavailable." }, { status: 503 });
}

/**
 * The builder's view of the form.
 *
 * Unlike `publicForm()` this DOES include the hidden questions and the access
 * settings — an admin has to be able to see and change them. It still never
 * includes `password_hash`: `hasPassword` is the only thing the panel needs in
 * order to draw the toggle in the right position, and sending the hash would
 * put a PBKDF2 digest into the browser for no reason at all.
 */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    const record = await loadForm(db, orgId);
    if (!record) return failure("This board has no form.", 404);

    return Response.json({
      form: {
        id: record.id,
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
      },
    });
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

    const record = await loadForm(db, orgId);
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
        const when = new Date(String(body.closeAt));
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

    const saved = await loadForm(db, orgId);
    return Response.json({
      ok: true,
      form: saved && {
        id: saved.id,
        title: saved.title,
        description: saved.description,
        active: saved.active,
        requireLogin: saved.requireLogin,
        hasPassword: saved.hasPassword,
        responseLimit: saved.responseLimit,
        closeAt: saved.closeAt,
        responseCount: saved.responseCount,
        shareToken: saved.shareToken,
        shortToken: saved.shortToken,
        shareUrl: shareUrl(request, saved.shareToken),
        config: saved.config,
      },
    });
  } catch (error) {
    return unavailable(error);
  }
}
