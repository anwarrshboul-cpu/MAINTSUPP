/**
 * The theme editor's data, read and write.
 *
 * GET is open to any member of the workspace, because the answer is what the
 * page they are already looking at is painted with — withholding it would hide
 * nothing. It reports `canEdit` so the UI can render the controls as read-only
 * rather than pretend they are absent.
 *
 * PUT requires `settings.edit`, the same capability
 * `app/api/overview/meter-settings/route.ts` uses for the Overview's meter
 * colours. That is the closest existing analogue — per-organisation presentation
 * configuration — and reusing it means an administrator who may already recolour
 * the dashboard does not need a second grant to recolour the brand, and one who
 * has had that capability withdrawn loses both.
 *
 * WHAT CANNOT REACH THE STYLESHEET
 *
 * Every value is put through `validateThemeToken`, and the principle is the same
 * for both kinds of token: **what the caller sent is discarded rather than
 * sanitised**, so there is no escaping to get wrong.
 *
 * For a COLOUR it parses the hex into three integers and RE-SERIALISES it, so the
 * only thing that can reach the `<style>` element in `app/(app)/layout.tsx` is `#`
 * followed by six hex digits this server produced.
 *
 * For a TYPEFACE it accepts only a key present in `FONT_STACKS` and stores the
 * KEY; the stack itself is looked up server-side at render. A font stack is a much
 * harder string to make safe than `#rrggbb` — commas, quotes and arbitrary family
 * names — so none of it is ever taken from a request.
 *
 * An unknown token key is refused for the same reason: the property name is
 * interpolated too.
 *
 * WHY A REFUSAL IS ALL-OR-NOTHING
 *
 * One bad value rejects the whole request rather than saving the good ones
 * beside it. A theme is looked at as a set, and a partial save would leave an
 * administrator staring at a palette that is neither what they had nor what they
 * asked for, with no way to tell which half landed.
 */

import { ensureDatabase } from "../../../db/init";
import { auditActor, recordAudit } from "../../lib/audit";
import { requireCapability, resolvePermissions } from "../../lib/permissions";
import { anonymousRefusal, scopedDb } from "../../lib/tenant-db";
import { readThemeOverrides, writeThemeOverride } from "../../lib/theme-repository.ts";
import {
  FONT_KEYS,
  FONT_STACKS,
  THEME_TOKEN_CATALOGUE,
  themeContrastWarnings,
  themeTokenDefinition,
  validateThemeToken,
} from "../../lib/theme-tokens.ts";
import { THEME_TOKEN_KEYS } from "../../lib/theme-tokens.ts";
import {
  restoreVersionFrom,
  summariseChange,
  themeRestoreTokens,
  themeSnapshot,
  type ThemeSnapshot,
} from "../../lib/config-versions-model.ts";
import {
  ensureConfigBaseline,
  latestSnapshot,
  loadRestoreSnapshot,
  recordConfigVersion,
  type VersionTarget,
} from "../../lib/config-versions.ts";

export const dynamic = "force-dynamic";

function unavailable(error?: unknown) {
  // A session that has ended is not an outage — the same reasoning as
  // `app/api/audit/route.ts`, and the same helper decides it.
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  return Response.json(
    { error: "The theme settings are temporarily unavailable." },
    { status: 503 },
  );
}

/** The catalogue, with each token's current value folded in. */
function describe(overrides: Readonly<Record<string, string>>) {
  return THEME_TOKEN_CATALOGUE.map((token) => ({
    key: token.key,
    label: token.label,
    group: token.group,
    description: token.description,
    /*
     * Colour, typeface or bounded choice. The panel needs it to decide between a
     * swatch and a select, and it is sent rather than inferred from the key so a
     * later token cannot be mis-rendered by a client guessing from its name.
     */
    kind: token.kind,
    /* What the control shows: the chosen value, or the shipped one. For a colour
       that is a hex; for a typeface it is a key from `FONT_STACKS`. */
    value: overrides[token.key] ?? token.seedInput,
    /* Whether this workspace has an opinion. Drives the "Reset" affordance, and
       is the honest way to say "this is MAINTSUPP's colour, not yours". */
    isDefault: !overrides[token.key],
    seedInput: token.seedInput,
    /*
     * The typefaces a workspace may choose, sent only for a font token.
     *
     * The SERVER owns this list, because it is the same list `validateThemeToken`
     * refuses anything outside. A client-side copy would be a second source of
     * truth for a security boundary, and the first divergence would be a select
     * offering a face the API rejects.
     */
    choices:
      token.kind === "font"
        ? FONT_KEYS.map((key) => ({ key, label: FONT_STACKS[key].label }))
        : /*
           * A `choice` token carries its own list — corners, depth, the board's row
           * height. Sent from the server for the same reason the faces are: this is
           * the same list `validateThemeToken` refuses anything outside, so a copy in
           * the panel would be a second source of truth for a safety boundary, and
           * the first divergence would be a control offering something the API
           * rejects. The `note` travels with it so the panel can say what an option
           * does without this file's vocabulary being duplicated there.
           */
          token.kind === "choice"
          ? (token.options ?? []).map((option) => ({
              key: option.key,
              label: option.label,
              note: option.note,
            }))
          : null,
  }));
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    const subject = await resolvePermissions(scope.db, scope.orgId, scope.actor.role, scope.siteScope);
    const overrides = await readThemeOverrides(scope.db, scope.orgId);

    return Response.json({
      canEdit: !requireCapability(subject, "settings.edit"),
      tokens: describe(overrides),
      warnings: themeContrastWarnings(overrides),
      organisation: { id: scope.orgId, name: scope.organisation?.name ?? null },
    });
  } catch (error) {
    return unavailable(error);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    const subject = await resolvePermissions(scope.db, scope.orgId, scope.actor.role, scope.siteScope);
    const refusal = requireCapability(subject, "settings.edit");
    if (refusal) return refusal;

    /* A caller who has not proved who they are must not be able to repaint a
       workspace for everybody in it. `scopedDbWithCapability` makes this check
       for its callers; this route resolves permissions by hand because GET
       needs the subject too, so the check is restated rather than skipped. */
    if (!scope.authenticated) {
      return Response.json({ error: "Sign in to make this change." }, { status: 401 });
    }

    const payload = (await request.json().catch(() => null)) as {
      tokens?: Record<string, unknown>;
      restoreVersion?: unknown;
    } | null;

    /*
     * §38 — RESTORE: a version's colours, sent back through THIS route, so the
     * same validation below runs on them and the result is recorded as a new
     * version. The snapshot is loaded here, from this workspace's history only;
     * the request carries just the number. Every token today's catalogue knows
     * is sent — the snapshot's value, or a reset — so a restore is exact.
     */
    const versionTarget: VersionTarget = { organisationId: scope.orgId, subject: "theme", key: "tokens" };
    const restoring = restoreVersionFrom(payload);
    if (payload && restoring) {
      const loaded = await loadRestoreSnapshot(scope.db, versionTarget, restoring);
      if (!loaded.ok) return Response.json({ error: loaded.error }, { status: loaded.status });
      payload.tokens = themeRestoreTokens(loaded.snapshot as ThemeSnapshot, THEME_TOKEN_KEYS);
    }

    if (!payload || typeof payload.tokens !== "object" || payload.tokens === null) {
      return Response.json(
        { error: "Send { tokens: { \"brand.primary\": \"#12b4a8\" } }." },
        { status: 400 },
      );
    }

    /* Validate everything before writing anything — see the header. */
    const writes: Array<{ key: string; value: string | null }> = [];
    for (const [key, raw] of Object.entries(payload.tokens)) {
      if (raw === null) {
        if (!themeTokenDefinition(key)) {
          return Response.json(
            { error: `Unknown theme token: ${key}` },
            { status: 400 },
          );
        }
        writes.push({ key, value: null });
        continue;
      }
      /* One validator for all three kinds — a hex, a face key or an option key.
         See `validateThemeToken`: every branch stores something this server
         produced rather than something a caller sent. */
      const checked = validateThemeToken(key, raw);
      if (!checked.ok) {
        return Response.json({ error: checked.reason }, { status: 400 });
      }
      writes.push({ key: checked.key, value: checked.value });
    }

    if (writes.length === 0) {
      return Response.json({ error: "No colours were sent." }, { status: 400 });
    }

    const before = await readThemeOverrides(scope.db, scope.orgId);
    const actorEmail = scope.identityEmail.toLowerCase();
    const versionActor = { email: actorEmail, userId: scope.session?.user.id ?? null };
    const changes = writes.some((write) => (before[write.key] ?? null) !== write.value);
    /* §38 — the state as it was, as version 1, before history's first write. */
    if (changes) await ensureConfigBaseline(scope.db, versionTarget, themeSnapshot(before), versionActor);

    for (const write of writes) {
      /* Nothing to record and nothing to write when the value is unchanged.
         Skipping here keeps the audit log a history of decisions rather than of
         saves, so re-opening the editor and pressing Save does not manufacture
         an event that says a colour changed when it did not. */
      const current = before[write.key] ?? null;
      if (current === write.value) continue;

      await writeThemeOverride(
        scope.db,
        scope.orgId,
        write.key,
        write.value,
        actorEmail,
      );

      const definition = themeTokenDefinition(write.key);
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: write.value === null ? "theme.token_reset" : "theme.token_changed",
        entityType: "theme_token",
        entityId: write.key,
        summary:
          write.value === null
            ? `Reset ${definition?.label ?? write.key} to the MAINTSUPP default.`
            : `Changed ${definition?.label ?? write.key} to ${write.value}.`,
        detail: { token: write.key, from: current, to: write.value },
        request,
      });
    }

    const after = await readThemeOverrides(scope.db, scope.orgId);
    /* §38 — every change is a version; a restore is one even when it changed nothing. */
    if (changes || restoring) {
      const previous = await latestSnapshot(scope.db, versionTarget);
      const summary = summariseChange("theme", previous, themeSnapshot(after));
      const recorded = await recordConfigVersion(scope.db, versionTarget, {
        snapshot: themeSnapshot(after),
        summary: restoring ? `Restored from version ${restoring} — ${summary}` : summary,
        restoredFrom: restoring,
        actor: versionActor,
      });
      if (restoring) {
        await recordAudit({
          db: scope.db,
          organisationId: scope.orgId,
          actor: auditActor(scope),
          action: "config.version_restored",
          entityType: "config_version",
          entityId: "theme/tokens",
          summary: `Restored the brand colours and fonts from version ${restoring}.`,
          detail: { subject: "theme", key: "tokens", from: restoring, version: recorded },
          request,
        });
      }
    }
    return Response.json({
      canEdit: true,
      tokens: describe(after),
      warnings: themeContrastWarnings(after),
      organisation: { id: scope.orgId, name: scope.organisation?.name ?? null },
    });
  } catch (error) {
    return unavailable(error);
  }
}
