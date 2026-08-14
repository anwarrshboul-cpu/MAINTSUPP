/**
 * The share link's one definition of "live".
 *
 * A share token is a bearer credential: whoever holds it acts on the job, with
 * no account and no cookie. Three things decide whether one works — the shape,
 * the revocation flag and the expiry — and every route reachable by that token
 * must apply all three identically.
 *
 * They live here rather than in each route file because a second copy of this
 * rule is a second chance to forget the expiry, and the route that forgets it
 * is the one that keeps accepting photographs through a link the client
 * revoked six months ago. `routes/public.ts` and `routes/uploads.ts` both
 * compose their queries from these.
 */
import type { Db } from "../../../../packages/db/src/client.ts";

/** 64 lowercase hex characters — 256 bits of `gen_random_bytes(32)`. */
export const SHARE_TOKEN_SHAPE = /^[0-9a-f]{64}$/;

/**
 * The WHERE fragment that makes a token live, with `$n` holding the token.
 *
 * Revoked, expired and never-existed all fail the same predicate, so they all
 * produce the same 404 — an error that distinguished them would confirm that a
 * guessed token had once been real.
 */
export function liveShareToken(alias = "j", n = 1): string {
  return (
    `${alias}.share_token = $${n} and ${alias}.share_enabled ` +
    `and (${alias}.share_expires_at is null or ${alias}.share_expires_at > now())`
  );
}

export type SharedJob = {
  id: string;
  reference: string;
  title: string;
  organisation_id: string | null;
};

/** The job a token opens, or null. Shape is checked before the query runs. */
export async function jobForShareToken(
  db: Db,
  token: string,
): Promise<SharedJob | null> {
  if (!SHARE_TOKEN_SHAPE.test(token)) return null;
  const [job] = await db.query<SharedJob>(
    `select j.id::text, j.reference, j.title, j.organisation_id::text
       from jobs j where ${liveShareToken("j", 1)}`,
    [token],
  );
  return job ?? null;
}
