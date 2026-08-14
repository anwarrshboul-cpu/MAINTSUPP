import { cache } from "react";
import { headers } from "next/headers";
import { apiFromServer } from "./api";
import type { Viewer } from "./portal";

/**
 * Server-only. `next/headers` throws in a client component, so nothing in a
 * `"use client"` file may import this module — shared types live in
 * `portal.ts`, which is safe in both environments.
 *
 * Who is asking, on the server.
 *
 * A React Server Component has no cookie jar — `credentials: "include"` is a
 * browser concept and means nothing here. The incoming request's Cookie header
 * has to be forwarded by hand or every server-rendered page renders signed out,
 * which looks exactly like a broken login. `apiFromServer` takes it as an
 * argument precisely so it cannot be forgotten silently.
 *
 * Wrapped in React's `cache` so the shell layout and the page inside it — which
 * both need the actor, one for the nav and one for its own role gate — share a
 * single `/auth/me` call per render rather than making two.
 */
const cookieHeader = cache(async (): Promise<string> => {
  return (await headers()).get("cookie") ?? "";
});

type MeResponse = {
  authenticated: boolean;
  actor: Viewer["actor"];
  fullName: string | null;
  phone: string | null;
};

export type ViewerState =
  | { kind: "signed-out" }
  | { kind: "blocked"; status: "pending_approval" | "suspended" }
  | { kind: "unreachable"; error: string }
  | { kind: "ok"; viewer: Viewer };

export const getViewerState = cache(async (): Promise<ViewerState> => {
  const result = await apiFromServer<MeResponse>("/auth/me", await cookieHeader());

  if (!result.ok) {
    if (result.status === 401) return { kind: "signed-out" };
    /*
     * 403 carries a machine-readable `status`. `/auth/me` itself answers 200 for
     * a pending or suspended account, but every other route refuses with this
     * shape — handling it here means one code path decides where a blocked
     * account is sent, wherever the refusal came from.
     */
    if (result.status === 403) {
      const status = result.body?.status;
      if (status === "pending_approval" || status === "suspended") {
        return { kind: "blocked", status: status as "pending_approval" | "suspended" };
      }
    }
    // A 500 or an unreachable API is not "signed out". Redirecting to the login
    // page would tell the user to do the one thing that cannot help.
    if (result.status === 0 || result.status >= 500) {
      return { kind: "unreachable", error: result.error };
    }
    return { kind: "signed-out" };
  }

  const { actor, fullName, phone } = result.data;
  if (!actor) return { kind: "signed-out" };
  if (actor.status !== "active") return { kind: "blocked", status: actor.status };
  return { kind: "ok", viewer: { actor, fullName, phone } };
});

/** The current request's cookies, for a page fetching its own data. */
export async function serverFetch<T>(path: string) {
  return apiFromServer<T>(path, await cookieHeader());
}
