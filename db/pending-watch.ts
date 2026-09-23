/**
 * A WAIT THAT NEVER ENDS SHOULD SAY WHAT IT WAS WAITING FOR.
 *
 * Measured on Production, 2026-09-23: one signed-in `/dashboard/contractors`
 * request hit Vercel's 60-second function limit. Supavisor's logs showed the
 * instance's boot statements reaching Postgres in 126 ms and then nothing for
 * 59 seconds; the function logged nothing at all, because nothing in it was
 * waiting to be asked. Every await that could have been the stall — a query,
 * a connection reservation, a boot stage — was silent, so the question "which
 * layer?" had no answer and still has none.
 *
 * This is the smallest thing that answers it next time: any watched operation
 * still pending after `DB_WATCH_MS` (10 seconds) logs one line naming its
 * STAGE, and one more if it finishes after all. Nothing is logged for the
 * ordinary case, so the cost of a healthy request is one timer set and cleared.
 *
 * WHAT A LINE MAY CONTAIN. A stage label and a duration — never a parameter,
 * a row, a connection string or a statement's text. A statement is described
 * by `describeStatement()`, which keeps only its leading keyword and the first
 * table identifier after it (`SELECT organisations`, `UPDATE schema_state`):
 * enough to name the wait, and nothing a customer typed.
 */

const DEFAULT_WATCH_MS = 10_000;

type TimerHandle = { unref?: () => void };

function watchThreshold(): number {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const raw = Number(env?.["DB_WATCH_MS"]);
  /* `DB_WATCH_MS=0` turns the watch off for an operator who wants silence. */
  return Number.isFinite(raw) && raw >= 0 && env?.["DB_WATCH_MS"] !== undefined ? raw : DEFAULT_WATCH_MS;
}

/**
 * The statement's shape, never its content: the leading keyword and the first
 * table after FROM / INTO / UPDATE / TABLE / INDEX … ON. Quoted literals are
 * blanked BEFORE matching, so a word inside `'on hold'` or `'from the store'`
 * can never be mistaken for a table; parameters are never looked at at all.
 */
export function describeStatement(sql: string): string {
  const bare = sql.replace(/'(?:[^']|'')*'/g, "''");
  const verb = /^\s*([A-Za-z]+)/.exec(bare)?.[1]?.toUpperCase() ?? "statement";
  const target =
    /\b(?:FROM|INTO|UPDATE|TABLE(?:\s+IF\s+NOT\s+EXISTS)?|INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?[A-Za-z_][A-Za-z0-9_]*"?\s+ON)\s+"?([A-Za-z_][A-Za-z0-9_]*)/i.exec(
      bare,
    )?.[1];
  return target ? `${verb} ${target}` : verb;
}

/**
 * Runs `work`, and logs if it is still pending after the threshold — and again
 * when it settles, so a slow-but-finished stage is told apart from a hang.
 *
 * The timer is `unref`'d where the runtime allows it: a diagnostic must never
 * be the thing that keeps a process or a function invocation alive.
 */
export function watchPending<T>(stage: string, work: () => Promise<T>): Promise<T> {
  const threshold = watchThreshold();
  if (threshold === 0) return work();
  const started = Date.now();
  let warned = false;
  const timer = setTimeout(() => {
    warned = true;
    console.warn(`[db-watch] still waiting after ${(threshold / 1000).toFixed(1)}s: ${stage}`);
  }, threshold) as unknown as TimerHandle;
  timer.unref?.();
  const settle = (outcome: "finished" | "failed") => {
    clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
    if (warned) {
      console.warn(
        `[db-watch] ${outcome} after ${((Date.now() - started) / 1000).toFixed(1)}s: ${stage}`,
      );
    }
  };
  let pending: Promise<T>;
  try {
    pending = work();
  } catch (error) {
    settle("failed");
    throw error;
  }
  return pending.then(
    (value) => {
      settle("finished");
      return value;
    },
    (error: unknown) => {
      settle("failed");
      throw error;
    },
  );
}
