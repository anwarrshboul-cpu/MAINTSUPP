/**
 * THE SHARED CRON GATE — one constant-time comparison, two schedulers.
 *
 * This moved out of `app/api/cron/retention/route.ts` when a second scheduled
 * endpoint arrived (the reminder dispatcher). It was moved rather than copied,
 * and the distinction matters more here than it usually would: a second
 * hand-written constant-time compare is a second chance to write one that is
 * not constant-time, and the copy that drifts is the one nobody re-reads
 * because it "already worked".
 *
 * `tests/owner-fixes-retention-scheduler.test.mjs` pinned `function
 * secretMatches` inside the retention route. That pin was protecting a real
 * contract — that the comparison does not short-circuit — so it was re-pointed
 * here rather than deleted, which is what the repository's test convention asks
 * for when a refactor moves a contract's home.
 */

/**
 * Constant-time string comparison.
 *
 * `a === b` returns as soon as two bytes differ, so the time it takes reveals
 * how much of the secret was right. This always walks the whole of the longer
 * string. The length is compared into the accumulator rather than short-
 * circuiting on it for the same reason.
 */
export function secretMatches(provided: string, expected: string): boolean {
  // Folded in rather than returned on, so a wrong LENGTH costs the same as a
  // wrong byte. Out-of-range indices read as 0 instead of NaN — `NaN ^ x` is
  // `x` in JS, which would have made the accumulator lie for short inputs.
  let difference = provided.length ^ expected.length;
  const length = Math.max(provided.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    const left = index < provided.length ? provided.charCodeAt(index) : 0;
    const right = index < expected.length ? expected.charCodeAt(index) : 0;
    difference |= left ^ right;
  }
  return difference === 0;
}

/**
 * The bearer token Vercel Cron sends, or an explicit refusal.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET`. A plain `x-cron-secret`
 * header is accepted too so the endpoint can be driven by an external scheduler
 * or by an operator's curl without pretending to be an OAuth client.
 *
 * `label` names the job in the unconfigured message, so an operator who hits a
 * 503 is told which endpoint is missing its variable rather than being handed a
 * sentence that could have come from either of them.
 */
export function authoriseCron(
  request: Request,
  label: string,
  /*
   * The secret, already resolved. Optional so the retention route and every
   * existing caller keep working unchanged.
   *
   * It exists because `process.env` is not the whole story in every runtime the
   * portal runs in. Vercel populates it, so the deployed cron reads its secret
   * there; Miniflare does not, and a `.dev.vars` entry arrives as a WORKER
   * BINDING instead — which is why the dispatcher reported "CRON_SECRET is
   * unset" on a dev server that plainly had one. `resolveCronSecret` below
   * reads both, the same way `platformVars` does for the seed guards, so
   * configuration is found in one place rather than in two conventions.
   */
  resolved?: string | null,
): Response | null {
  const expected = resolved ?? process.env.CRON_SECRET ?? "";
  if (!expected) {
    /*
     * 503, not 401. There is nothing the caller can do — the deployment is
     * missing a variable — and answering 401 would invite a credential hunt
     * for a credential that does not exist.
     */
    return Response.json(
      {
        error: `Scheduled ${label} is not configured on this deployment: CRON_SECRET is unset.`,
      },
      { status: 503 },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  const provided = bearer || (request.headers.get("x-cron-secret") ?? "");

  if (!provided || !secretMatches(provided, expected)) {
    // Deliberately says nothing about which half was wrong.
    return Response.json({ error: "Not authorised." }, { status: 401 });
  }
  return null;
}

/**
 * The cron secret, from wherever this runtime keeps it.
 *
 * `process.env` first — a real process environment is what an operator set on
 * the deployment — then the Workers binding, which is what a local `.dev.vars`
 * becomes. Only `CRON_SECRET` is read: `env.DB` and `env.BUCKET` are getters
 * that would open the database as a side effect of asking what the secret is.
 *
 * Returns "" rather than throwing when nothing is configured, so the caller's
 * existing fail-closed branch still produces the 503 it always did.
 */
export async function resolveCronSecret(): Promise<string> {
  const fromProcess =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.CRON_SECRET;
  if (fromProcess) return fromProcess;
  try {
    // @ts-expect-error — Workers runtime module, resolved at run time only.
    const { env } = await import("cloudflare:workers");
    const value = (env as unknown as Record<string, unknown>).CRON_SECRET;
    return typeof value === "string" ? value : "";
  } catch {
    /* A plain Node process with nothing set. The caller refuses with 503. */
    return "";
  }
}
