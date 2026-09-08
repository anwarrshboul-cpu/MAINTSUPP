"use client";

/**
 * FILTER STATE LIVES IN THE ADDRESS BAR. NOTHING LIVES IN localStorage.
 *
 * A filtered dashboard is a thing people send each other — "look at Aldgate's
 * overdue work" is a link, not a set of instructions for reproducing a set of
 * dropdowns. Every brief says the same thing and says it the same way: all
 * filter, sort, search and view state in the URL query string, bookmarkable and
 * shareable, nothing in localStorage.
 *
 * ── WHY THIS IS A QUERY STRING AND NOT A PATH SEGMENT ─────────────────────
 *
 * The portal is one client-routed page and the PATH is how it chooses its
 * section: `portal-app.tsx` reads `location.pathname` on `popstate` and would
 * treat `/dashboard/overview/site/aldgate` as a section it does not have. A
 * query parameter rides alongside that handler and is invisible to it, which is
 * why this needs no change there — the same reasoning `sites-manager.tsx`
 * already records for its `?site=` parameter.
 *
 * ── replaceState FOR A FILTER, pushState FOR A PLACE ──────────────────────
 *
 * Changing a filter REPLACES the entry. Twenty back presses to escape a page
 * where somebody tried four periods and six sites is not history, it is a trap.
 * Opening a record — a site, a contractor — PUSHES, because that is a place the
 * back button should return from. The two are separate calls for exactly that
 * reason.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

/**
 * The URL is an external store, so it is read as one.
 *
 * `useSyncExternalStore` rather than an effect that calls `setState` on mount:
 * an effect would paint once with the server's empty search string and then
 * correct itself, which is the flash a link opened WITH filters on it would
 * show every time. It also keeps the browser's own history events and React's
 * render in step without a cascading render, which is what the
 * `react-hooks/set-state-in-effect` rule is about.
 *
 * The subscription is to `popstate` plus a private event this module dispatches
 * on every write: `history.pushState` and `history.replaceState` fire NOTHING,
 * so a component that only listened to `popstate` would update the address bar
 * and not the page.
 */
const URL_CHANGED = "maintsupp:urlstate";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(URL_CHANGED, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(URL_CHANGED, onChange);
  };
}

function readSearch(): string {
  return window.location.search;
}

/** The server has no address bar; an empty string is the only honest answer. */
function readServerSearch(): string {
  return "";
}

/**
 * Read-and-write access to the page's query string.
 *
 * Re-renders on `popstate` so the back button actually moves the page rather
 * than only the address bar — a filter that survives a reload but not a Back is
 * half a feature and reads as a bug.
 */
export function useQueryState(): {
  params: URLSearchParams;
  setParams: (next: URLSearchParams, options?: { push?: boolean }) => void;
  search: string;
} {
  const search = useSyncExternalStore(subscribe, readSearch, readServerSearch);
  const params = useMemo(() => new URLSearchParams(search), [search]);

  const setParams = useCallback(
    (next: URLSearchParams, options: { push?: boolean } = {}) => {
      const query = next.toString();
      const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
      if (options.push) window.history.pushState({}, "", url);
      else window.history.replaceState({}, "", url);
      window.dispatchEvent(new Event(URL_CHANGED));
    },
    [],
  );

  return { params, setParams, search };
}

/**
 * One named parameter, with a default that is never written to the URL.
 *
 * Omitting the default keeps an unfiltered page's address clean, which matters
 * because a URL full of `?sort=default&view=list&status=all` teaches people
 * that the address bar is noise and then they stop copying it.
 */
export function useQueryValue(
  key: string,
  fallback: string,
): [string, (value: string, options?: { push?: boolean }) => void] {
  const { params, setParams } = useQueryState();
  const value = params.get(key) ?? fallback;
  const set = useCallback(
    (next: string, options?: { push?: boolean }) => {
      const updated = new URLSearchParams(window.location.search);
      if (!next || next === fallback) updated.delete(key);
      else updated.set(key, next);
      setParams(updated, options);
    },
    [fallback, key, setParams],
  );
  return [value, set];
}

/**
 * One repeated parameter as a set — `?site=a&site=b`.
 *
 * Repeated rather than comma-joined because a site name, an engineer type and a
 * label are all free text an operator types, and one containing a comma would
 * split into two filters that match nothing.
 */
export function useQueryList(
  key: string,
): [string[], (values: string[]) => void, (value: string) => void] {
  const { params, setParams } = useQueryState();
  const values = useMemo(() => params.getAll(key), [key, params]);

  const set = useCallback(
    (next: string[]) => {
      const updated = new URLSearchParams(window.location.search);
      updated.delete(key);
      for (const value of [...new Set(next)].sort()) updated.append(key, value);
      setParams(updated);
    },
    [key, setParams],
  );

  const toggle = useCallback(
    (value: string) => {
      const updated = new URLSearchParams(window.location.search);
      const existing = updated.getAll(key);
      const next = existing.includes(value)
        ? existing.filter((entry) => entry !== value)
        : [...existing, value];
      updated.delete(key);
      for (const entry of [...new Set(next)].sort()) updated.append(key, entry);
      setParams(updated);
    },
    [key, setParams],
  );

  return [values, set, toggle];
}

/** Drop every parameter this page owns, leaving anything else alone. */
export function useClearQuery(keys: readonly string[]): () => void {
  const { setParams } = useQueryState();
  return useCallback(() => {
    const updated = new URLSearchParams(window.location.search);
    for (const key of keys) updated.delete(key);
    setParams(updated);
  }, [keys, setParams]);
}

/**
 * A fetch that follows the query string, with the three states a card needs.
 *
 * `loading` starts true and STAYS true across a refetch rather than flipping
 * back to an empty payload — a card that blanked between filter changes made
 * the page flicker on every tap. `error` carries the server's own sentence, so
 * the retry button appears beside a reason rather than beside an apology.
 */
export function useOpsQuery<T>(
  path: string,
  search: string,
  options: { enabled?: boolean } = {},
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const enabled = options.enabled !== false;
  const [nonce, setNonce] = useState(0);
  const key = `${path}|${search}|${nonce}`;
  /*
   * ONE piece of state, carrying the key it was fetched for.
   *
   * `loading` is DERIVED — `result.key !== key` — rather than being a second
   * flag set at the top of the effect. Setting a flag there is a cascading
   * render, and keeping the previous payload while the next one is in flight is
   * also what stops each card blanking between filter changes: on a phone that
   * flicker made every tap look like a page reload.
   */
  const [result, setResult] = useState<{
    key: string;
    data: T | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const url = `${path}${search ? (path.includes("?") ? "&" : "?") + search.replace(/^\?/, "") : ""}`;
    fetch(url, { headers: { Accept: "application/json" } })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | (T & { error?: string })
          | null;
        if (!live) return;
        if (!response.ok || !payload) {
          setResult({
            key,
            data: null,
            error: payload?.error || `This did not load (${response.status}).`,
          });
          return;
        }
        setResult({ key, data: payload, error: null });
      })
      .catch(() => {
        if (!live) return;
        setResult({
          key,
          data: null,
          error: "This did not load. Check your connection and try again.",
        });
      });
    return () => {
      live = false;
    };
  }, [enabled, key, path, search]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return {
    data: result?.data ?? null,
    loading: enabled && result?.key !== key,
    error: result?.key === key ? result.error : null,
    reload,
  };
}
