/**
 * THE ADAPTER BOUNDARY — everything except the model call.
 *
 * ── WHAT IS AND IS NOT HERE ────────────────────────────────────────────────
 *
 * This file defines what a narrative provider IS, resolves one from server-side
 * configuration, builds the prompt, and runs the validator over whatever comes
 * back. What it does NOT contain is a provider: no vendor, no endpoint, no SDK,
 * no default. Choosing and paying for an external model is the owner's
 * decision, not a side effect of building the plumbing, so the registry ships
 * empty and `resolveNarrativeProvider()` on an unconfigured deployment returns
 * a typed "unavailable" carrying a sentence an operator can act on.
 *
 * The consequence is deliberate and worth stating plainly: with nothing
 * configured, Generate does not fail silently and does not pretend to have
 * generated. It says AI drafting is unavailable and why, and the block stays
 * exactly as it was.
 *
 * ── THE DETERMINISTIC PATH IS NOT OPTIONAL ─────────────────────────────────
 *
 * `narrative.ts` builds the executive summary from the counts with no model
 * involved, and the report has always been publishable that way. Nothing in
 * this file is on that path. A deployment with no provider produces the same
 * document it produced before narrative blocks existed, plus the ability to
 * write any block by hand — which is why "unavailable" is a state of one
 * feature and not a broken screen.
 *
 * ── NO SECRET REACHES THE CLIENT ───────────────────────────────────────────
 *
 * Only this module names the configuration variables, and the only thing it
 * hands outward is `narrativeProviderStatus()`: a boolean, a display label and
 * a sentence. The credential is read, held in the closure of one provider
 * instance and never returned, never logged, never put on a response. The
 * variables are read as LITERAL `process.env.X` member expressions rather than
 * through a constant, for the reason `public-origin.ts` records: a bundler that
 * substitutes environment values at build time matches the literal and nothing
 * else, and an indirection that reads better in source is the one that silently
 * evaluates to `undefined` in a build — indistinguishable from "not
 * configured", so the failure would be a quiet return to the old behaviour.
 *
 * `assertServerOnly()` throws if this module is ever evaluated in a browser. It
 * is defence in depth rather than the enforcement: `tests/pre-w14-narrative-
 * safety.test.mjs` asserts that no client-reachable module imports this file
 * and that no variable name from it appears in one.
 *
 * ── THE VALIDATOR RUNS HERE, NOT IN THE ROUTE ──────────────────────────────
 *
 * `draftNarrativeBlock()` is the only exported way to obtain model prose, and
 * it validates before it returns. A route cannot forget to call the validator
 * because there is no path that hands it unvalidated text — the provider
 * interface is not exported in a form a caller can drive on its own.
 */

import type { CombinedReportPayload } from "./contract";
import {
  ORPHAN_FIGURE_MESSAGE,
  validateProseFigures,
  type FigureValidation,
} from "./figure-validator";
import {
  lockedFiguresForBlock,
  NARRATIVE_BLOCKS,
  parseNarrativeBlockKey,
  type LockedFigures,
} from "./narrative-blocks";

/* ---------------------------------------------------------- server only -- */

/**
 * Refuse to run in a browser.
 *
 * A module that reads credentials must fail loudly rather than return
 * `undefined` and carry on, because "carry on" here means a client bundle that
 * looks like it is configured and is not.
 */
export function assertServerOnly(): void {
  if (typeof window !== "undefined") {
    throw new Error(
      "narrative-provider is server-only: it reads deployment configuration and must never be bundled for the browser.",
    );
  }
}

/**
 * One variable, from wherever this runtime keeps it.
 *
 * `process.env` first — that is what an operator sets on the deployment — then
 * the Workers binding, which is what a local `.dev.vars` entry becomes. The
 * same two places `resolveCronSecret()` looks, so configuration is found by one
 * convention rather than by two.
 *
 * The switch is a literal-per-branch rather than `process.env[name]`; see the
 * header on why the readable form is the broken one.
 */
async function readConfig(name: NarrativeConfigKey): Promise<string> {
  const fromProcess =
    name === "provider"
      ? process.env.REPORT_NARRATIVE_PROVIDER
      : name === "model"
        ? process.env.REPORT_NARRATIVE_MODEL
        : name === "endpoint"
          ? process.env.REPORT_NARRATIVE_ENDPOINT
          : process.env.REPORT_NARRATIVE_API_KEY;
  if (typeof fromProcess === "string" && fromProcess.trim()) return fromProcess.trim();

  try {
    // @ts-expect-error — Workers runtime module, resolved at run time only.
    const { env } = await import("cloudflare:workers");
    const bag = env as unknown as Record<string, unknown>;
    const value =
      name === "provider"
        ? bag.REPORT_NARRATIVE_PROVIDER
        : name === "model"
          ? bag.REPORT_NARRATIVE_MODEL
          : name === "endpoint"
            ? bag.REPORT_NARRATIVE_ENDPOINT
            : bag.REPORT_NARRATIVE_API_KEY;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    /* A plain Node process with nothing set. The caller reports unavailable. */
    return "";
  }
}

type NarrativeConfigKey = "provider" | "credential" | "model" | "endpoint";

/* ------------------------------------------------------------ the shape -- */

export interface NarrativeGenerationRequest {
  /** The block being drafted, for the model's brief. */
  blockKey: string;
  /** The instruction from `NARRATIVE_BLOCKS`. Contains no figure. */
  instruction: string;
  /** The system prompt: tone, UK spelling, and the absolute rule about figures. */
  system: string;
  /** The user prompt, with the locked JSON block embedded. */
  user: string;
  /** The locked figures, in case an adapter wants to constrain decoding. */
  locked: LockedFigures;
}

/**
 * What an adapter must implement. Deliberately one method: an adapter turns a
 * prompt into text and does nothing else. It does not choose the block, does
 * not see the payload, does not decide what is valid, and cannot store
 * anything — every one of those decisions is made by code in this repository
 * before and after it runs.
 */
export interface NarrativeProvider {
  /** Stable identifier stored on the block for the audit trail. */
  readonly id: string;
  /** What an operator sees on screen. Never a credential or an endpoint. */
  readonly label: string;
  generate(request: NarrativeGenerationRequest): Promise<string>;
}

export interface NarrativeProviderContext {
  credential: string;
  model: string;
  endpoint: string;
}

export type NarrativeProviderFactory = (
  context: NarrativeProviderContext,
) => NarrativeProvider;

/**
 * The registry. EMPTY ON PURPOSE — see the header.
 *
 * Registration is a one-line change in whichever module the owner decides to
 * add, and needs no edit to the route, the panel or the validator. That is the
 * whole return on the boundary: the day a provider is chosen, the safety
 * architecture around it is already built and already tested.
 */
const REGISTRY = new Map<string, NarrativeProviderFactory>();

export function registerNarrativeProvider(
  id: string,
  factory: NarrativeProviderFactory,
): void {
  REGISTRY.set(id.trim().toLowerCase(), factory);
}

/** For the operator-facing message, and for a test to assert it is empty. */
export function registeredNarrativeProviders(): string[] {
  return [...REGISTRY.keys()].sort();
}

/* ----------------------------------------------------------- resolution -- */

export type NarrativeUnavailableReason =
  /** Nothing configured at all. The state of every deployment today. */
  | "unconfigured"
  /** A provider was named that no adapter has been registered for. */
  | "unknown-provider"
  /** A provider was named and its credential is missing. */
  | "incomplete";

export type NarrativeProviderResolution =
  | { available: true; provider: NarrativeProvider }
  | {
      available: false;
      reason: NarrativeUnavailableReason;
      /** A whole sentence an operator can act on. Shown verbatim in the UI. */
      message: string;
    };

export const NARRATIVE_UNAVAILABLE_MESSAGE =
  "AI drafting is not configured on this deployment, so no draft can be generated. Every narrative block can still be written or edited by hand, and the computed summary is unaffected.";

/**
 * The provider, or a typed refusal.
 *
 * Never throws for want of configuration, and never falls back to a provider
 * the operator did not name. "Unavailable" is a result, and the caller renders
 * it — a Generate button that silently does nothing is the failure this shape
 * exists to make impossible.
 */
export async function resolveNarrativeProvider(): Promise<NarrativeProviderResolution> {
  assertServerOnly();

  const id = (await readConfig("provider")).toLowerCase();
  if (!id) {
    return { available: false, reason: "unconfigured", message: NARRATIVE_UNAVAILABLE_MESSAGE };
  }

  const factory = REGISTRY.get(id);
  if (!factory) {
    const known = registeredNarrativeProviders();
    return {
      available: false,
      reason: "unknown-provider",
      message: known.length
        ? `No narrative provider named "${id}" is built into this deployment. The ones that are: ${known.join(", ")}.`
        : `A narrative provider named "${id}" is configured, but no provider adapter is built into this deployment, so nothing can be generated.`,
    };
  }

  const credential = await readConfig("credential");
  if (!credential) {
    return {
      available: false,
      reason: "incomplete",
      /* Names the variable, not its value. An operator fixing this needs to
         know which one is missing; nobody needs to be shown a key. */
      message: `The narrative provider "${id}" is selected but its API credential is not set on this deployment, so nothing can be generated.`,
    };
  }

  return {
    available: true,
    provider: factory({
      credential,
      model: await readConfig("model"),
      endpoint: await readConfig("endpoint"),
    }),
  };
}

/**
 * What the browser is allowed to know.
 *
 * A boolean, a label and a sentence. No credential, no endpoint, no variable
 * name — the route returns THIS and never the resolution itself, which is what
 * keeps the secret on the server even if a later change makes the resolution
 * carry more.
 */
export interface NarrativeProviderStatus {
  available: boolean;
  providerLabel: string | null;
  message: string;
}

export async function narrativeProviderStatus(): Promise<NarrativeProviderStatus> {
  const resolution = await resolveNarrativeProvider();
  if (resolution.available) {
    return {
      available: true,
      providerLabel: resolution.provider.label,
      message: `Drafts are generated by ${resolution.provider.label} and every figure is checked against the report's data before the draft is stored.`,
    };
  }
  return { available: false, providerLabel: null, message: resolution.message };
}

/* -------------------------------------------------------------- prompting -- */

/**
 * The tone §4.3 specifies, and the four absolutes above it.
 *
 * "Leave any gap as [TBC]" is the important one and the least obvious. Without
 * it, a model asked for a sentence about a figure it was not given will produce
 * a plausible number rather than an incomplete sentence — and a plausible
 * number is the failure mode this entire subsystem exists to prevent. `[TBC]`
 * carries no digits, so it passes the validator and lands visibly in the draft
 * for a person to fill in.
 */
export const NARRATIVE_SYSTEM_PROMPT = [
  "You are drafting prose for a UK commercial property maintenance report.",
  "",
  "ABSOLUTE RULES:",
  "1. Use ONLY the figures supplied in the LOCKED FIGURES block. Never calculate, never infer, never round, never convert between units.",
  "2. If a sentence needs a figure that was not supplied, write [TBC] in its place. Do not omit the sentence and do not estimate.",
  "3. Do not state a total, a difference or a percentage that is not supplied, even when the supplied figures would allow you to work one out.",
  "4. Write figures exactly as the block prints them, including the currency symbol and the separators.",
  "",
  "TONE: plain professional English, UK spelling. No marketing language, no adjectives of praise, no apology.",
  "State figures flatly. Do not explain WHY anything happened — the data records what happened, not why.",
  "Two to four sentences unless the brief says otherwise.",
].join("\n");

/**
 * The locked block, as the model sees it.
 *
 * Path, printed form and raw value together. The printed form is there so the
 * model copies "£1,758.00" rather than formatting 175800 itself — formatting is
 * arithmetic, and rule 1 forbids arithmetic.
 */
export function lockedFiguresPrompt(locked: LockedFigures): string {
  const lines = locked.figures.map(
    (figure) => `  ${figure.path} = ${figure.display}  (${figure.kind}, raw ${figure.value})`,
  );
  return lines.length ? lines.join("\n") : "  (no figures supplied)";
}

export function buildNarrativeRequest(
  payload: CombinedReportPayload,
  blockKey: string,
  guidance?: string | null,
): NarrativeGenerationRequest | null {
  const parsed = parseNarrativeBlockKey(blockKey);
  if (!parsed) return null;
  const definition = NARRATIVE_BLOCKS[parsed.kind];
  const locked = lockedFiguresForBlock(payload, blockKey);

  const user = [
    `BRIEF: ${definition.instruction}`,
    guidance ? `OPERATOR GUIDANCE: ${guidance}` : null,
    "",
    `PERIOD: ${payload.period.label} (${payload.period.start} to ${payload.period.end})`,
    "",
    "LOCKED FIGURES — the only figures you may use:",
    lockedFiguresPrompt(locked),
    "",
    "Write the paragraph. Output the prose only, with no heading and no preamble.",
  ]
    .filter((line) => line !== null)
    .join("\n");

  return {
    blockKey,
    instruction: definition.instruction,
    system: NARRATIVE_SYSTEM_PROMPT,
    user,
    locked,
  };
}

/* ------------------------------------------------------------ generation -- */

export type NarrativeDraftOutcome =
  | {
      status: "generated";
      prose: string;
      providerId: string;
      validation: FigureValidation;
    }
  | { status: "unavailable"; reason: NarrativeUnavailableReason; message: string }
  /** The model produced a figure the data does not contain. §4.3's hard stop. */
  | { status: "refused"; message: string; validation: FigureValidation }
  /** The block key is not one this document has. */
  | { status: "unknown-block"; message: string }
  /** The provider itself errored or returned nothing usable. */
  | { status: "failed"; message: string };

/** Longer than any paragraph this report contains, short enough to store. */
export const MAX_NARRATIVE_PROSE = 4000;

/**
 * Draft one block: resolve, prompt, generate, VALIDATE, return.
 *
 * The validation is not a step the caller may skip, because there is no
 * exported path to a provider's output that does not run it. `refused` returns
 * the offending tokens so the panel can name them — an operator told only "that
 * failed" learns nothing, and an operator shown "the draft said 88% and the
 * data says 62%" learns exactly what the safeguard is for.
 */
export async function draftNarrativeBlock(input: {
  payload: CombinedReportPayload;
  blockKey: string;
  guidance?: string | null;
  /** Injectable so a test can drive the whole path without a vendor. */
  resolve?: () => Promise<NarrativeProviderResolution>;
}): Promise<NarrativeDraftOutcome> {
  const request = buildNarrativeRequest(input.payload, input.blockKey, input.guidance);
  if (!request) {
    return {
      status: "unknown-block",
      message: "That narrative block is not part of this document.",
    };
  }

  const resolution = await (input.resolve ?? resolveNarrativeProvider)();
  if (!resolution.available) {
    return { status: "unavailable", reason: resolution.reason, message: resolution.message };
  }

  let raw: string;
  try {
    raw = await resolution.provider.generate(request);
  } catch (error) {
    /* The message, never the request — the prompt carries the client's figures
       and the adapter's error may echo its own configuration back at us. */
    return {
      status: "failed",
      message: `The narrative provider could not produce a draft: ${
        error instanceof Error ? error.message : "no reason was given"
      }.`,
    };
  }

  const prose = typeof raw === "string" ? raw.trim().slice(0, MAX_NARRATIVE_PROSE) : "";
  if (!prose) {
    return { status: "failed", message: "The narrative provider returned nothing." };
  }

  const validation = validateProseFigures(prose, request.locked);
  if (!validation.ok) {
    return {
      status: "refused",
      message: validation.message ?? ORPHAN_FIGURE_MESSAGE,
      validation,
    };
  }

  return { status: "generated", prose, providerId: resolution.provider.id, validation };
}

/**
 * The same check, run over prose a PERSON typed.
 *
 * Advisory, and returned rather than enforced. A human editing the report is
 * the source of truth for it — refusing their sentence because the payload does
 * not contain a figure they know to be right would make the safeguard an
 * obstacle to the very people it is supposed to serve. The panel shows what the
 * validator saw and lets them save anyway.
 */
export function reviewProseFigures(
  payload: CombinedReportPayload,
  blockKey: string,
  prose: string,
): FigureValidation {
  return validateProseFigures(prose, lockedFiguresForBlock(payload, blockKey));
}
