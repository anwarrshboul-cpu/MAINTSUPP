/**
 * THE COMPLIANCE TEMPLATE — 2C. What every site in this workspace is asked for,
 * and every other name those certificates go by.
 *
 * ── WHY THIS ENDPOINT IS NOT JUST A LIST OF NAMES ─────────────────────────
 *
 * Because the data says an editable list would not have helped. Staging's Demo
 * Client holds twelve stores and 204 compliance requirements, where about 66 is
 * the honest number, and the 138 surplus rows were created by a repair that
 * matched on the exact string `kind`. Six of the eight names that estate
 * actually uses are ordinary trade synonyms for a board slot — "Legionella risk
 * assessment" for Water Hygiene, "EICR" for Electrical Wiring — and one differs
 * from the board's name only by a capital letter. Nobody could have configured
 * their way out of that.
 *
 * So the template carries ALIASES beside each requirement, and the resolver in
 * `app/lib/compliance-vocabulary.ts` is what `ensureComplianceProfile` matches
 * through. The list an operator edits is layer three of three; the two beneath
 * it ship.
 *
 * ── GET IS READABLE BY ANYONE WHO CAN SEE THE BOARD ───────────────────────
 *
 * `board.view`, the same capability the register itself is gated on: the
 * template is a description of the register, and a screen that can show the
 * register but not the vocabulary behind it would print requirement names it
 * cannot explain. PUT is `settings.edit`, because it changes what every future
 * site is asked for.
 *
 * ── PUT NEVER TOUCHES A COMPLIANCE ROW ────────────────────────────────────
 *
 * Saving a template changes what NEW sites are given and how existing names are
 * resolved. It does not create, rename or delete a single `compliance_documents`
 * row. That is `POST /api/compliance/backfill`, which previews before it acts
 * and is reversible — and the separation is deliberate: a settings save that
 * silently rewrote sixty rows of somebody's real register would be a migration
 * disguised as a preference.
 */

import { ensureDatabase } from "../../../../db/init";
import { scopedDbWithCapability } from "../../../lib/tenant-db";
import {
  readComplianceTemplate,
  writeComplianceTemplate,
} from "../../../lib/compliance-template-store";
import {
  BUILT_IN_KIND_ALIASES,
  buildKindResolver,
  normaliseKind,
  parseComplianceTemplate,
} from "../../../lib/compliance-vocabulary";

export const dynamic = "force-dynamic";

/**
 * How many requirements a template may hold.
 *
 * A blast radius rather than a storage limit. The board tracks twelve; an
 * estate with genuine extras runs to twenty or so. Sixty is far beyond any real
 * template and far below "somebody pasted a spreadsheet into the settings blob",
 * which would then be re-read on the create path of every site.
 */
const MAX_KINDS = 60;

/** And per requirement, for the same reason. */
const MAX_ALIASES = 24;

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;

    const template = await readComplianceTemplate(db, orgId);
    return Response.json({
      template,
      /*
       * The shipped aliases travel with the template, separately from the
       * organisation's own.
       *
       * A UI that showed them merged would invite an operator to "tidy up" a
       * list they never wrote and cannot delete — `buildKindResolver` applies
       * the built-in map whether or not the template repeats it. Showing them
       * apart is the honest rendering: these are known to the product, those
       * are yours.
       */
      builtInAliases: BUILT_IN_KIND_ALIASES,
    });
  } catch (cause) {
    console.error("[/api/compliance/template] GET failed", cause);
    return Response.json({ error: "The compliance template could not be read." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "settings.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor } = guard.scope;

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "The request body was not valid JSON." }, { status: 400 });
    }

    const raw = (payload as { template?: unknown } | null)?.template;
    if (!raw || typeof raw !== "object") {
      return Response.json({ error: "A template is required." }, { status: 400 });
    }
    const kinds = (raw as { kinds?: unknown }).kinds;
    if (!Array.isArray(kinds) || kinds.length === 0) {
      return Response.json(
        { error: "A template must list at least one requirement." },
        { status: 400 },
      );
    }
    if (kinds.length > MAX_KINDS) {
      return Response.json(
        { error: `A template may hold at most ${MAX_KINDS} requirements.` },
        { status: 400 },
      );
    }
    for (const entry of kinds) {
      const aliases = (entry as { aliases?: unknown })?.aliases;
      if (Array.isArray(aliases) && aliases.length > MAX_ALIASES) {
        return Response.json(
          { error: `A requirement may hold at most ${MAX_ALIASES} other names.` },
          { status: 400 },
        );
      }
    }

    /*
     * PARSED, NOT TRUSTED. `parseComplianceTemplate` is the same function the
     * reader uses, so what is stored is by construction what will be read back:
     * it drops nameless rows, folds two spellings of one requirement into one,
     * decides `board` from the spec rather than from the payload, and restores
     * any of the twelve board slots a save dropped — disabled, so the operator's
     * intent survives without leaving a board column the register cannot name.
     */
    const template = parseComplianceTemplate(raw);

    /*
     * A NAME THAT MEANS TWO THINGS IS REFUSED, WITH THE COLLISION NAMED.
     *
     * The resolver breaks a tie by specificity so it can never be ambiguous at
     * read time, which means a template where one alias is claimed by two
     * requirements would resolve silently and wrongly forever. Better to refuse
     * the save and say which word is the problem — that is a sentence an
     * operator can act on, and a silent 200 is not.
     */
    const claimant = new Map<string, string>();
    for (const entry of template.kinds) {
      for (const alias of entry.aliases) {
        const key = normaliseKind(alias);
        if (!key) continue;
        const held = claimant.get(key);
        if (held && held !== entry.kind) {
          return Response.json(
            {
              error: `"${alias}" is listed under both "${held}" and "${entry.kind}". A name can only mean one requirement.`,
            },
            { status: 400 },
          );
        }
        claimant.set(key, entry.kind);
      }
    }

    await writeComplianceTemplate(db, orgId, template, actor.email ?? null);

    /*
     * The saved template is returned RESOLVED, so the screen can show the
     * consequence of the save rather than an echo of the request. `resolves` is
     * every name this workspace now recognises and what each one means — which
     * is the only view in which a missing alias is visible.
     */
    const resolve = buildKindResolver(template);
    const recognised: Array<{ name: string; kind: string }> = [];
    for (const entry of template.kinds) {
      for (const name of [entry.kind, ...(BUILT_IN_KIND_ALIASES[entry.kind] ?? []), ...entry.aliases]) {
        const kind = resolve(name);
        if (kind && !recognised.some((row) => row.name === name)) recognised.push({ name, kind });
      }
    }
    return Response.json({ template, resolves: recognised });
  } catch (cause) {
    console.error("[/api/compliance/template] PUT failed", cause);
    return Response.json(
      { error: "The compliance template could not be saved." },
      { status: 500 },
    );
  }
}

export function POST() {
  /* PUT, not POST: a template is one document replaced whole. Answered rather
     than left to the framework so a mistaken client gets a sentence. */
  return Response.json(
    { error: "Use PUT to replace the compliance template." },
    { status: 405 },
  );
}
