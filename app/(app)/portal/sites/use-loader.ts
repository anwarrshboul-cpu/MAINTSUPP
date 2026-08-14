"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Fetch-on-mount with a reload handle.
 *
 * The work is declared inside the effect and state is only touched after the
 * await resolves, which is the pattern the rest of this dashboard uses. Setting
 * state synchronously in an effect body causes cascading renders, and the lint
 * rules here reject it.
 *
 * `active` guards against a response arriving after the screen has moved on,
 * which would otherwise write into an unmounted component.
 */
export function useLoader<T>(
  fetcher: () => Promise<T>,
  fallbackMessage: string,
): {
  data: T | null;
  error: string;
  setError: (message: string) => void;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);

  // The caller rebuilds its fetcher on every render. Keeping the latest one in
  // a ref, written from an effect rather than during render, means a redefined
  // closure never restarts the request — only `reload()` does that.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  useEffect(() => {
    let active = true;

    async function run() {
      try {
        const payload = await fetcherRef.current();
        if (!active) return;
        setData(payload);
        setError("");
      } catch (caught) {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : fallbackMessage);
      }
    }

    run();

    return () => {
      active = false;
    };
  }, [nonce, fallbackMessage]);

  const reload = useCallback(() => setNonce((current) => current + 1), []);

  return { data, error, setError, reload };
}
