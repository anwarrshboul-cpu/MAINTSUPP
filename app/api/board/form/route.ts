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
  type FormRecord,
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
function serialiseForm(request: Request, record: FormRecord) {
  return {
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
  };
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    const record = await loadForm(db, orgId);
    if (!record) return failure("This board has no form.", 404);
    return Response.json({ form: serialiseForm(request, record) });
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

    const saved = await loadForm(db, orgId);
    return Response.json({
      ok: true,
      form: saved && serialiseForm(request, saved),
    });
  } catch (error) {
    return unavailable(error);
  }
}
