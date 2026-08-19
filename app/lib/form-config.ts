import { and, eq, or } from "drizzle-orm";
import type { getDb } from "../../db";
import { formConfigurations } from "../../db/schema";
import { maintenanceFormConfiguration, type FormQuestion } from "../../db/monday-board-spec";
import { hashPassword, passwordProblem, verifyPassword } from "./password";
import { projectQuestions, type PublicQuestion } from "./form-projection";

type Database = Awaited<ReturnType<typeof getDb>>;

/**
 * The form builder's server side — the one place that reads, validates and
 * writes a form configuration.
 *
 * EVERY read path goes through here rather than querying `form_configurations`
 * directly, and that is the point. The table carries three things that must
 * never reach a browser — `password_hash`, the hidden questions, and the
 * response counter — and a route that builds its own SELECT is one `select *`
 * away from serving all three to an anonymous visitor. `publicForm()` below is
 * the only function that produces something safe to send to the public form,
 * and it is built by naming fields to INCLUDE rather than by deleting fields to
 * exclude, so a field added to the config later is private until somebody
 * deliberately publishes it.
 */

export type FormFeatures = typeof maintenanceFormConfiguration.features;
export type FormAppearance = typeof maintenanceFormConfiguration.appearance;

export type StoredFormConfig = {
  order: string[];
  questions: FormQuestion[];
  features: FormFeatures;
  appearance: FormAppearance;
  accessibility: { language: string | null; logoAltText: string | null };
  tags: string[];
};

export type FormRecord = {
  id: string;
  organisationId: string;
  boardId: string;
  viewKey: string;
  title: string;
  description: string | null;
  shareToken: string;
  shortToken: string | null;
  active: boolean;
  requireLogin: boolean;
  hasPassword: boolean;
  responseLimit: number | null;
  closeAt: string | null;
  responseCount: number;
  config: StoredFormConfig;
};

/**
 * The seed, used whenever a stored `config` blob is missing or unreadable.
 *
 * Deep-cloned on every call. Handing out a shared reference would let one
 * request's edits mutate the module-level default and leak into the next
 * request on the same worker — the kind of bug that only appears under load.
 */
function defaultConfig(): StoredFormConfig {
  return structuredClone({
    order: maintenanceFormConfiguration.order,
    questions: maintenanceFormConfiguration.questions,
    features: maintenanceFormConfiguration.features,
    appearance: maintenanceFormConfiguration.appearance,
    accessibility: maintenanceFormConfiguration.accessibility,
    tags: maintenanceFormConfiguration.tags,
  }) as StoredFormConfig;
}

/**
 * Parses the stored blob, falling back to the seed one KEY AT A TIME.
 *
 * A whole-blob fallback would be wrong: a config that has a good `questions`
 * array but a `features` object written by an older build would be thrown away
 * entirely, silently resetting an operator's edited questions back to monday's.
 * Merging per key means a partial or half-migrated row keeps everything it can.
 */
function parseConfig(raw: string | null): StoredFormConfig {
  const fallback = defaultConfig();
  if (!raw) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== "object") return fallback;

  const source = parsed as Partial<StoredFormConfig>;
  return {
    order: Array.isArray(source.order) ? source.order : fallback.order,
    questions: Array.isArray(source.questions) ? source.questions : fallback.questions,
    features: { ...fallback.features, ...(source.features ?? {}) },
    appearance: { ...fallback.appearance, ...(source.appearance ?? {}) },
    accessibility: { ...fallback.accessibility, ...(source.accessibility ?? {}) },
    tags: Array.isArray(source.tags) ? source.tags : fallback.tags,
  };
}

function toRecord(row: typeof formConfigurations.$inferSelect): FormRecord {
  return {
    id: row.id,
    organisationId: row.organisationId,
    boardId: row.boardId,
    viewKey: row.viewKey,
    title: row.title,
    description: row.description,
    shareToken: row.shareToken,
    shortToken: row.shortToken,
    active: row.active,
    requireLogin: row.requireLogin,
    /* The hash itself never leaves this module — only whether one is set. */
    hasPassword: Boolean(row.passwordHash),
    responseLimit: row.responseLimit,
    closeAt: row.closeAt,
    responseCount: row.responseCount,
    config: parseConfig(row.config),
  };
}

/** The form behind a board's Form view, for the authenticated builder. */
export async function loadForm(
  db: Database,
  organisationId: string,
  boardId = "maintenance",
  viewKey = "form",
): Promise<FormRecord | null> {
  const [row] = await db
    .select()
    .from(formConfigurations)
    .where(
      and(
        eq(formConfigurations.organisationId, organisationId),
        eq(formConfigurations.boardId, boardId),
        eq(formConfigurations.viewKey, viewKey),
      ),
    )
    .limit(1);
  return row ? toRecord(row) : null;
}

/**
 * The form behind a share link. Deliberately NOT tenant-scoped — an anonymous
 * visitor has no tenant — so the token is the entire authorisation, which is
 * why it is 32 random bytes and why the column is uniquely indexed.
 *
 * EITHER token resolves. The long one and the "Shorten URL" alias are two
 * locators for one form, so a link sent before the toggle was flipped keeps
 * working after it — turning a switch in the Share dialog must not silently
 * break every link already in somebody's inbox.
 */
export async function loadFormByToken(
  db: Database,
  shareToken: string,
): Promise<FormRecord | null> {
  /* Bounded and hex-only, so a hostile path segment never reaches the query. */
  if (!shareToken || !/^[a-f0-9]{10,64}$/i.test(shareToken)) return null;
  const [row] = await db
    .select()
    .from(formConfigurations)
    .where(
      or(
        eq(formConfigurations.shareToken, shareToken),
        eq(formConfigurations.shortToken, shareToken),
      ),
    )
    .limit(1);
  return row ? toRecord(row) : null;
}

/* ── Whether the form is taking answers ──────────────────────────────────── */

export type FormAvailability =
  | { open: true }
  | { open: false; reason: "deactivated" | "closed" | "full" };

/**
 * The four gates monday puts in front of a submission, checked in the order a
 * submitter would understand them.
 *
 * This is called on the PUBLIC READ as well as on submit. Checking only on
 * submit would draw somebody the whole form, let them attach photographs, and
 * refuse at the end — which is exactly the experience the close-date feature
 * exists to avoid.
 */
export function formAvailability(record: FormRecord, now = new Date()): FormAvailability {
  if (!record.active) return { open: false, reason: "deactivated" };

  if (record.closeAt) {
    const closes = new Date(record.closeAt);
    /*
     * An unparseable close date is treated as no close date. The alternative —
     * failing closed — would take a live form off the air over a typo in a
     * field that is optional in the first place.
     */
    if (!Number.isNaN(closes.getTime()) && now >= closes) {
      return { open: false, reason: "closed" };
    }
  }

  /*
   * `>= limit`, not `> limit`. A limit of 25 means the 25th response is the
   * last one accepted, so the form closes once the count has reached it.
   */
  if (record.responseLimit !== null && record.responseCount >= record.responseLimit) {
    return { open: false, reason: "full" };
  }

  return { open: true };
}

export function unavailableMessage(reason: "deactivated" | "closed" | "full") {
  switch (reason) {
    case "deactivated":
      return "This form is no longer accepting responses.";
    case "closed":
      return "This form has closed and is no longer accepting responses.";
    case "full":
      return "This form has reached its response limit and is no longer accepting responses.";
  }
}

/* ── What the browser is allowed to see ──────────────────────────────────── */

export type PublicForm = {
  token: string;
  title: string;
  description: string | null;
  questions: PublicQuestion[];
  appearance: FormAppearance;
  welcome: FormFeatures["preSubmissionView"];
  afterSubmission: {
    title: string | null;
    description: string | null;
    allowResubmit: boolean;
    showSuccessImage: boolean;
    redirectUrl: string | null;
  };
  progressBar: boolean;
  submitButtonText: string | null;
  language: string | null;
};


/**
 * The public projection — an allowlist, never a redaction.
 *
 * WHAT IS DROPPED AND WHY IT MATTERS
 *
 *  · Hidden questions. All ten of them, including "Cost of Works" and
 *    "Approved by". `visible: false` on monday means the submitter never sees
 *    the question; sending it and hiding it in CSS would publish the board's
 *    internal financial columns to anyone who opened dev tools.
 *  · Deactivated and hidden OPTIONS, per question. A retired store must not be
 *    selectable, and monday tracks that per label rather than by deleting it.
 *  · `responseCount`, `responseLimit`, `requireLogin`, `hasPassword` and every
 *    board setting. A submitter has no use for any of them and the counts are
 *    business information.
 *
 * The order is monday's `sortedQuestionsList`, with anything the order forgot
 * appended rather than dropped — a question added to `questions` but not to
 * `order` should still be asked, not silently lost.
 */
/**
 * The Location question, by monday's column id.
 *
 * Named here because it is the one question whose options are NOT the captured
 * ones. See `publicForm`'s `optionOverrides` note.
 */
export const LOCATION_QUESTION_ID = "single_selecty9rcyhe";

/**
 * The options in the order the form should offer them.
 *
 * "Custom" is monday's word for "the order they are stored in" and is the
 * default, so this is a no-op unless somebody chose alphabetical. Sorted with
 * `en-GB` collation rather than by code point, so accented store names land
 * where a reader expects rather than after Z.
 */
function orderOptions(
  options: Array<{ label: string; value: string }> | null,
  order: "Custom" | "Alphabetical",
) {
  if (!options || order !== "Alphabetical") return options;
  return [...options].sort((left, right) => left.label.localeCompare(right.label, "en-GB"));
}

/**
 * What the field opens with.
 *
 * "Today as default" is computed HERE, on the server, and this is the whole
 * reason it is not left to the browser: a date rendered from the visitor's
 * clock and a date validated against the server's can disagree by a day either
 * side of midnight, which is exactly the timezone day-shift bug the setting is
 * supposed to avoid. One clock decides.
 *
 * `defaultCurrentDate` wins over `defaultAnswer` for a date question, because a
 * form configured with both is asking for today and the fixed date is stale
 * configuration.
 */
function resolvePrefill(question: FormQuestion, now: Date) {
  const settings = question.settings;
  if (!settings) return "";

  if ((question.type === "Date" || question.type === "DateRange") && settings.defaultCurrentDate) {
    /*
     * Rendered as the value an `<input type="date">` expects. `toISOString`
     * would be UTC and would show yesterday to anyone west of Greenwich in the
     * evening, so the parts are read in the server's own zone instead.
     */
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    if (settings.includeTime) {
      const hour = String(now.getHours()).padStart(2, "0");
      const minute = String(now.getMinutes()).padStart(2, "0");
      return `${year}-${month}-${day}T${hour}:${minute}`;
    }
    return `${year}-${month}-${day}`;
  }

  return typeof settings.defaultAnswer === "string" ? settings.defaultAnswer : "";
}

export function publicForm(
  record: FormRecord,
  /**
   * Options to substitute, per question id.
   *
   * WHY THIS EXISTS, AND WHY LOCATION NEEDS IT
   *
   * The captured configuration carries monday's 21 store labels — "Aldgate –
   * Whitechapel Road", "Birmingham – Bullring". This workspace's `sites` table
   * names the same estate differently ("Aldgate", "Brent Cross"), and the
   * submit route resolves an answer against `sites.name` scoped to the form's
   * organisation, because a job has to land on a real site.
   *
   * Serving the captured labels would therefore offer a submitter 21 choices of
   * which none could be submitted — every attempt refused with "Choose a
   * location from the list", naming a list it had just been shown. So the live
   * site list wins for this question.
   */
  optionOverrides: Record<string, Array<{ label: string; value: string }>> = {},
  /* Injected so "today as default" is one clock's answer — see resolvePrefill. */
  now: Date = new Date(),
): PublicForm {
  const { config } = record;

  /*
   * The questions come from the SHARED projection, which the builder's Preview
   * also calls. That is what makes Preview and the public form the same form
   * rather than two renderings that drift.
   */
  const questions = projectQuestions(config, optionOverrides, now);

  return {
    token: record.shareToken,
    title: record.title,
    description: record.description,
    questions,
    appearance: config.appearance,
    welcome: config.features.preSubmissionView,
    afterSubmission: {
      title: config.features.afterSubmissionView.title,
      description: config.features.afterSubmissionView.description,
      allowResubmit: config.features.afterSubmissionView.allowResubmit,
      showSuccessImage: config.features.afterSubmissionView.showSuccessImage,
      redirectUrl: config.features.afterSubmissionView.redirectAfterSubmission.enabled
        ? config.features.afterSubmissionView.redirectAfterSubmission.redirectUrl
        : null,
    },
    progressBar: config.appearance.showProgressBar,
    submitButtonText: config.appearance.submitButton.text,
    language: config.accessibility.language,
  };
}

/* ── Passwords ───────────────────────────────────────────────────────────── */

/**
 * Reuses the account password hasher — PBKDF2-SHA512 at 210,000 iterations —
 * rather than inventing a second, weaker scheme for "just a form password".
 *
 * That also means the account minimum of 12 characters applies. monday allows
 * shorter, and this is a deliberate divergence: a form password is shared over
 * email and protects the request history of 21 stores, so the house standard
 * is the right one. `passwordProblem` returns the message to show.
 */
export function formPasswordProblem(password: unknown) {
  return passwordProblem(password);
}

export async function hashFormPassword(password: string) {
  return hashPassword(password);
}

/**
 * Checks a submitted password against the stored hash.
 *
 * Reads the hash with its own query rather than taking it from `FormRecord`,
 * because `FormRecord` deliberately does not carry it. The cost is one extra
 * SELECT on a path that is already doing 210,000 PBKDF2 rounds.
 */
export async function verifyFormPassword(
  db: Database,
  formId: string,
  password: string,
): Promise<boolean> {
  const [row] = await db
    .select({ passwordHash: formConfigurations.passwordHash })
    .from(formConfigurations)
    .where(eq(formConfigurations.id, formId))
    .limit(1);
  if (!row?.passwordHash) return false;
  return verifyPassword(password, row.passwordHash);
}

/* ── Staying unlocked between page loads ─────────────────────────────────── */

/**
 * A password-protected form has to stay unlocked across the submit that follows
 * the unlock, and across a refresh. That needs a cookie, and a cookie needs a
 * value that cannot simply be typed by somebody who has not passed the gate.
 *
 * THE VALUE IS DERIVED FROM THE STORED HASH, NOT SIGNED WITH A SECRET
 *
 * There is no general-purpose signing secret in this codebase — sessions are
 * random opaque tokens checked against a table, which does not generalise to an
 * anonymous visitor with no row anywhere. Rather than invent a secret (and a
 * place to configure it, and a failure mode when it is unset in production),
 * the cookie carries SHA-256 of the form id and the PBKDF2 hash together.
 *
 * That has the three properties the gate needs:
 *
 *  · Unguessable without the stored hash, which never leaves the server.
 *  · Self-invalidating. Change or clear the form password and every outstanding
 *    unlock cookie stops verifying on the next request, with no revocation
 *    list to maintain — which is precisely what changing a password should do.
 *  · Per form. Unlocking one form grants nothing on another.
 *
 * What it is NOT is per-visitor: two people who both know the password compute
 * the same value. That is the same trust boundary as the password itself, which
 * is shared by design, so it costs nothing real.
 */
export function unlockCookieName(formId: string) {
  /* Cookie names are restricted; the id is already `form_<hex>_<board>`. */
  return `form_unlock_${formId.replace(/[^A-Za-z0-9_]/g, "")}`;
}

async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The value an unlocked visitor should be carrying, or null if no password. */
export async function expectedUnlockValue(db: Database, formId: string) {
  const [row] = await db
    .select({ passwordHash: formConfigurations.passwordHash })
    .from(formConfigurations)
    .where(eq(formConfigurations.id, formId))
    .limit(1);
  if (!row?.passwordHash) return null;
  return digest(`${formId}:${row.passwordHash}`);
}

function readCookie(request: Request, name: string) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/**
 * Whether this request may see a password-protected form.
 *
 * A form with no password is always "unlocked" — the gate does not exist, so
 * there is nothing to pass.
 */
export async function isUnlocked(db: Database, record: FormRecord, request: Request) {
  if (!record.hasPassword) return true;
  const expected = await expectedUnlockValue(db, record.id);
  if (!expected) return true;
  const presented = readCookie(request, unlockCookieName(record.id));
  return presented === expected;
}

export function unlockCookie(request: Request, formId: string, value: string) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  /*
   * A session cookie — no Max-Age — so it dies with the browser. A shared form
   * password is often typed on a device somebody else will use next.
   */
  return `${unlockCookieName(formId)}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

/* ── Share tokens ────────────────────────────────────────────────────────── */

/**
 * A fresh 32-byte share token.
 *
 * Regenerating one is how a leaked link is revoked, so this is deliberately the
 * same strength as the contractor job tokens rather than something shorter and
 * prettier. The link is long; that is the trade.
 */
export function generateShareToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The public URL for a token.
 *
 * Built from the REQUEST's own origin rather than a configured base URL, so the
 * link copied out of the Share dialog is the host the operator is actually on —
 * localhost in development, the real domain in production — instead of a
 * hard-coded guess that is wrong in one of those two places.
 */
export function shareUrl(request: Request, token: string) {
  return new URL(`/f/${token}`, new URL(request.url).origin).toString();
}

/** The twelve-character alias behind the "Shorten URL" switch. */
export function generateShortToken() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The link the Share dialog shows and the Copy button copies.
 *
 * The switch chooses which of the two locators is PRESENTED; both keep
 * resolving either way, so this is a display preference and never a revocation.
 * If shortening is on but no alias has been minted yet, the long link is shown
 * rather than a broken one.
 */
export function presentedShareUrl(request: Request, record: FormRecord) {
  const shorten = record.config.features.shortenedLink.enabled;
  const token = shorten && record.shortToken ? record.shortToken : record.shareToken;
  return shareUrl(request, token);
}
