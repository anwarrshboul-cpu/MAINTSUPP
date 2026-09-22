/**
 * THE PUBLIC NAVIGATION'S CACHE — pure, so its behaviour is tested rather than
 * hoped for. `site-navigation-public.ts` wires it to the database.
 *
 * WHY A CACHE HERE, WHEN THE CMS PAGES DELIBERATELY HAVE NONE.
 *
 * `cms-repository.ts` refuses a cache, and for a page that is right: a page is
 * one address, read when somebody asks for it. The navigation is on EVERY
 * public page — the homepage, the legal pages, every CMS page — so an uncached
 * read would put a database round trip in front of every visit to the site,
 * and tie every marketing page's availability to the database's. The owner's
 * rule for decision J is exactly that: no expensive uncached database work on
 * every public request.
 *
 * WHAT IT PROMISES, AND WHAT IT CANNOT.
 *
 *   - FRESH WITHIN `ttlMs`. Each server instance re-reads the navigation at
 *     most once per window, so a save reaches every visitor within one window
 *     of being made. There is no cross-instance channel in this product (the
 *     theme cache found that out the hard way), so an instance that did not
 *     take the save cannot hear about it — the window is the honest bound, and
 *     the editor states it.
 *   - IMMEDIATE ON THE INSTANCE THAT SAVED. `invalidate()` drops this
 *     instance's copy, and a load that was already in flight when it did is not
 *     allowed to put the old navigation back (`generation`).
 *   - NEVER THE REASON A PAGE FAILS OR HANGS. A read that errors, or takes
 *     longer than `timeoutMs`, answers with the last navigation this instance
 *     had — or, if it never had one, the built-in navigation (`fallback`). A
 *     failure is not retried for `backoffMs`, so a database that is down costs
 *     visitors nothing after the first miss, and a slow load already running is
 *     never waited on a second time.
 */

export type CacheSource = "cache" | "database" | "stale" | "fallback";

export type NavigationCacheOptions<T> = {
  load: () => Promise<T>;
  fallback: () => T;
  ttlMs: number;
  timeoutMs: number;
  backoffMs: number;
  now?: () => number;
  onError?: (error: unknown) => void;
};

const TIMED_OUT = Symbol("timed-out");

export function createNavigationCache<T>(options: NavigationCacheOptions<T>) {
  const now = options.now ?? Date.now;
  let entry: { value: T; at: number } | null = null;
  let generation = 0;
  let inflight: { promise: Promise<T | null>; startedAt: number; generation: number } | null = null;
  let retryAt = 0;

  const start = () => {
    const mine = generation;
    const startedAt = now();
    const promise: Promise<T | null> = options.load().then(
      (value) => {
        /* A load that began before an invalidation is not allowed to put the
           pre-save navigation back into the cache. */
        if (mine === generation) entry = { value, at: now() };
        retryAt = 0;
        return value;
      },
      (error: unknown) => {
        retryAt = now() + options.backoffMs;
        options.onError?.(error);
        return null;
      },
    );
    const record = { promise, startedAt, generation: mine };
    inflight = record;
    void promise.finally(() => {
      if (inflight === record) inflight = null;
    });
    return record;
  };

  const notFresh = (): { value: T; source: CacheSource } =>
    entry ? { value: entry.value, source: "stale" } : { value: options.fallback(), source: "fallback" };

  return {
    async read(): Promise<{ value: T; source: CacheSource }> {
      const at = now();
      if (entry && at - entry.at < options.ttlMs) return { value: entry.value, source: "cache" };
      if (at < retryAt) return notFresh();
      let record = inflight && inflight.generation === generation ? inflight : null;
      /* A load that has already used up its time is not waited on again. */
      if (record && at - record.startedAt >= options.timeoutMs) return notFresh();
      record ??= start();
      const remaining = Math.max(0, options.timeoutMs - (at - record.startedAt));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        record.promise,
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), remaining);
          /* Never the thing that keeps a process alive. */
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (outcome === TIMED_OUT || outcome === null) return notFresh();
      return { value: outcome, source: "database" };
    },
    /** Drop this instance's copy — called by the save that changed it. */
    invalidate() {
      generation += 1;
      entry = null;
      retryAt = 0;
    },
  };
}
