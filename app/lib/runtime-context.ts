"use client";

/**
 * `/api/context`, read once per page load and shared by everything that wants it.
 *
 * TWO READERS, TWO REQUESTS, ONE ANSWER. `portal-app.tsx` read the whole
 * context for the workspace shell, and `client-capabilities.ts` read
 * `context.capabilities` for the controls. Each memoised its own read
 * correctly, and neither knew the other existed — so every dashboard load
 * fetched `/api/context` twice and threw half of each answer away. Measured
 * cold on 18 Sept 2026: 433ms and 298ms, for the same bytes.
 *
 * The memo lives here now, above both of them, and they share it.
 *
 * A REJECTED PROMISE IS DROPPED, NOT CACHED — the same rule the capability
 * cache already had. One transient failure must not leave the page permanently
 * convinced it has no context; the next caller retries.
 *
 * `force` EXISTS FOR ONE REASON: the context describes a workspace, and
 * switching workspace makes the cached answer wrong rather than stale. Callers
 * that change which workspace is current pass it. Nothing else should.
 */

/**
 * Deliberately loose. The shape belongs to `portal-app.tsx`, which owns
 * `RuntimeWorkspaceContext` and casts to it; typing that here would make a
 * lib module depend on a component, which is the wrong direction.
 */
export type RawRuntimeContext = Record<string, unknown> & {
  capabilities?: Record<string, boolean>;
};

let pending: Promise<RawRuntimeContext> | null = null;

async function read(): Promise<RawRuntimeContext> {
  const response = await fetch("/api/context", {
    headers: { accept: "application/json" },
  });
  const payload = (await response.json()) as {
    context?: RawRuntimeContext;
    error?: string;
  };
  if (!response.ok || !payload.context) {
    throw new Error(payload.error || "The client workspace could not be loaded.");
  }
  return payload.context;
}

/** The memoised read. Every caller on a page shares one round trip. */
export function fetchRuntimeContext(options?: { force?: boolean }): Promise<RawRuntimeContext> {
  if (options?.force) pending = null;
  if (!pending) {
    pending = read().catch((error: unknown) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

/** Forget the cached answer — see `force` in the header. */
export function forgetRuntimeContext() {
  pending = null;
}
