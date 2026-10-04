/**
 * Storage for "Sign in with Face ID": one-time challenges and the passkeys
 * themselves. The cryptography is in ./webauthn.ts; this is only the rows.
 */

import { and, eq, lt } from "drizzle-orm";
import type { getDb } from "../../db";
import { passkeys, webauthnChallenges } from "../../db/schema";
import { publicOrigin } from "./public-origin";
import { newChallenge } from "./webauthn";

type Database = Awaited<ReturnType<typeof getDb>>;

const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;

export type ChallengePurpose = "register" | "login";

/** The origins a passkey ceremony may come from: this host, and the canonical one. */
export function allowedOrigins(request: Request): string[] {
  return [...new Set([new URL(request.url).origin, publicOrigin(request)])];
}

/** The relying party id for a ceremony started on this request: our host name. */
export function rpIdFor(request: Request): string {
  return new URL(request.url).hostname;
}

export async function issueChallenge(
  db: Database,
  purpose: ChallengePurpose,
  userId: string | null,
): Promise<string> {
  const now = Date.now();
  /* Tidy as we go: an abandoned ceremony leaves one row behind. */
  await db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, now)).catch(() => {});
  const id = newChallenge();
  await db.insert(webauthnChallenges).values({
    id,
    purpose,
    userId,
    expiresAt: now + CHALLENGE_LIFETIME_MS,
  });
  return id;
}

/**
 * Takes a challenge out of the store. Returns its row only when it was ours,
 * for this purpose, unexpired, and (for a registration) issued to this person.
 * Deleted either way, so it can never be presented twice.
 */
export async function consumeChallenge(
  db: Database,
  challenge: string,
  purpose: ChallengePurpose,
  userId: string | null,
) {
  const [row] = await db
    .select()
    .from(webauthnChallenges)
    .where(eq(webauthnChallenges.id, challenge))
    .limit(1);
  if (!row) return null;
  await db.delete(webauthnChallenges).where(eq(webauthnChallenges.id, challenge));
  if (row.purpose !== purpose) return null;
  if (row.expiresAt < Date.now()) return null;
  if (purpose === "register" && row.userId !== userId) return null;
  return row;
}

export async function passkeysFor(db: Database, userId: string) {
  return db.select().from(passkeys).where(eq(passkeys.userId, userId));
}

export async function findPasskey(db: Database, id: string) {
  const [row] = await db.select().from(passkeys).where(eq(passkeys.id, id)).limit(1);
  return row ?? null;
}

export async function removePasskey(db: Database, userId: string, id: string) {
  await db.delete(passkeys).where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)));
}
