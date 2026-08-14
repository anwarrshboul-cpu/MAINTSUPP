import type { Context, Next } from "hono";
import type { Db } from "../../../../packages/db/src/client.ts";
import { resolveSession } from "./sessions.ts";
import { readSessionCookie } from "./http.ts";
import type { Actor } from "./access.ts";

export type Env = { Variables: { db: Db; actor: Actor } };

/**
 * Requires an *active* session.
 *
 * Pending and suspended accounts are refused here rather than deeper in, so no
 * handler has to remember to check `status`. They get 403 with a machine-
 * readable `status`, which is how the web app knows to show the holding page
 * rather than the sign-in form.
 */
export async function requireActor(c: Context<Env>, next: Next) {
  const resolved = await resolveSession(c.get("db"), readSessionCookie(c));
  if (!resolved) return c.json({ error: "Sign in to continue." }, 401);

  if (resolved.actor.status !== "active") {
    return c.json(
      { error: "This account is not active.", status: resolved.actor.status },
      403,
    );
  }
  c.set("actor", resolved.actor);
  await next();
}

/** Requires a capability. Composed after `requireActor`. */
export function requireCapability(
  can: (actor: Actor) => boolean,
  message = "You do not have access to this.",
) {
  return async (c: Context<Env>, next: Next) => {
    if (!can(c.get("actor"))) return c.json({ error: message }, 403);
    await next();
  };
}
