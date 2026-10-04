/**
 * THE CONTRACTOR APP'S SIGN-IN — invite links, one-time codes, sessions.
 *
 * See `contractorSessions` in db/schema.ts for the model. Three rules hold
 * throughout:
 *
 *   · only HASHES of tokens and codes are stored;
 *   · a contractor is matched by the email or mobile ON THEIR RECORD in the
 *     Contractors register — nobody can sign up, only be recognised;
 *   · what a session covers is worked out again on every request, so an
 *     archived contractor, or one whose email changed, is out at once.
 */

import { and, eq, isNull, lt } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  contractorInvites,
  contractorLoginCodes,
  contractorSessions,
  contractors,
} from "../../db/schema";

type Database = Awaited<ReturnType<typeof getDb>>;

export const CONTRACTOR_COOKIE = "maintsupp_contractor";
const SESSION_LIFETIME_MS = 60 * 86_400_000;
const INVITE_LIFETIME_MS = 14 * 86_400_000;
const CODE_LIFETIME_MS = 10 * 60 * 1000;
const CODE_ATTEMPTS = 5;

/* ── Small helpers ───────────────────────────────────────────────────────── */

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * One way to write an email or a mobile, so "07852 224644", "+44 7852 224644"
 * and "447852224644" are the same person. A national number starting 0 is read
 * as a UK number — MAINTSUPP works in the UK, and a contractor's record is
 * typed by the office in that form.
 */
export function normaliseIdentity(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (value.includes("@")) {
    const email = value.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? `email:${email}` : null;
  }
  let digits = value.replace(/\(0\)/g, "").replace(/\D/g, "");
  if (value.startsWith("+")) {
    /* Country code stated. */
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0")) {
    digits = `44${digits.slice(1)}`;
  }
  if (digits.length < 10 || digits.length > 15) return null;
  return `tel:${digits}`;
}

export function identityKind(identity: string): "email" | "tel" {
  return identity.startsWith("email:") ? "email" : "tel";
}

export function identityValue(identity: string) {
  return identity.slice(identity.indexOf(":") + 1);
}

/* ── Who a contractor is ─────────────────────────────────────────────────── */

export type ContractorRow = typeof contractors.$inferSelect;

/** Every ACTIVE contractor record that names this email or mobile. */
export async function contractorsForIdentity(db: Database, identity: string): Promise<ContractorRow[]> {
  const rows = await db.select().from(contractors).where(eq(contractors.active, true));
  return rows.filter((row) =>
    [row.email, row.phone, row.whatsappNumber].some((value) => normaliseIdentity(value) === identity),
  );
}

/** The identity a contractor's own record gives them — email first, then mobile. */
export function identityForContractor(row: ContractorRow): string | null {
  return (
    normaliseIdentity(row.email) ??
    normaliseIdentity(row.whatsappNumber) ??
    normaliseIdentity(row.phone)
  );
}

/* ── Sessions ────────────────────────────────────────────────────────────── */

export async function createContractorSession(
  db: Database,
  input: { contractor: ContractorRow; identity: string | null; request: Request },
) {
  const token = randomToken();
  await db.insert(contractorSessions).values({
    id: `csess_${crypto.randomUUID().replace(/-/g, "")}`,
    tokenHash: await sha256Hex(token),
    contractorId: input.contractor.id,
    organisationId: input.contractor.organisationId,
    identity: input.identity,
    expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS).toISOString(),
    lastSeenAt: new Date().toISOString(),
    userAgent: (input.request.headers.get("user-agent") ?? "").slice(0, 300),
  });
  return token;
}

function secureRequest(request: Request) {
  return new URL(request.url).protocol === "https:";
}

export function contractorCookie(token: string, request: Request, remember = true) {
  const secure = secureRequest(request) ? "; Secure" : "";
  const age = remember ? `; Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}` : "";
  return `${CONTRACTOR_COOKIE}=${encodeURIComponent(token)}; Path=/${age}; HttpOnly; SameSite=Lax${secure}`;
}

export function expiredContractorCookie(request: Request) {
  const secure = secureRequest(request) ? "; Secure" : "";
  return `${CONTRACTOR_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

function cookieToken(request: Request) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === CONTRACTOR_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export type ContractorScope = {
  sessionId: string;
  /** Every contractor record this person may act as — at least one. */
  contractors: ContractorRow[];
  name: string;
};

/**
 * The signed-in contractor for this request, or null. Re-checks the session
 * (not revoked, not expired) AND the contractor (still active) every time.
 */
export async function contractorScope(db: Database, request: Request): Promise<ContractorScope | null> {
  const token = cookieToken(request);
  if (!token || token.length < 32) return null;
  const [session] = await db
    .select()
    .from(contractorSessions)
    .where(and(eq(contractorSessions.tokenHash, await sha256Hex(token)), isNull(contractorSessions.revokedAt)))
    .limit(1);
  if (!session || new Date(session.expiresAt).getTime() < Date.now()) return null;

  const [anchor] = await db
    .select()
    .from(contractors)
    .where(and(eq(contractors.id, session.contractorId), eq(contractors.active, true)))
    .limit(1);
  if (!anchor) return null;

  const covered = new Map<string, ContractorRow>([[anchor.id, anchor]]);
  /* The same person in another workspace — only while the anchor record still
     carries the identity the session was opened with. */
  if (session.identity && identityForContractor(anchor) !== null) {
    const anchorIdentities = [anchor.email, anchor.phone, anchor.whatsappNumber].map(normaliseIdentity);
    if (anchorIdentities.includes(session.identity)) {
      for (const row of await contractorsForIdentity(db, session.identity)) covered.set(row.id, row);
    }
  }

  const lastSeen = session.lastSeenAt ? new Date(session.lastSeenAt).getTime() : 0;
  if (Date.now() - lastSeen > 15 * 60 * 1000) {
    await db
      .update(contractorSessions)
      .set({ lastSeenAt: new Date().toISOString() })
      .where(eq(contractorSessions.id, session.id))
      .catch(() => {});
  }
  return { sessionId: session.id, contractors: [...covered.values()], name: anchor.contactName || anchor.name };
}

export async function endContractorSession(db: Database, sessionId: string) {
  await db
    .update(contractorSessions)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(contractorSessions.id, sessionId));
}

/* ── Invite links ────────────────────────────────────────────────────────── */

export async function createContractorInvite(
  db: Database,
  input: { contractorId: string; organisationId: string; createdBy: string | null },
) {
  const token = randomToken();
  await db.insert(contractorInvites).values({
    id: `cinv_${crypto.randomUUID().replace(/-/g, "")}`,
    tokenHash: await sha256Hex(token),
    contractorId: input.contractorId,
    organisationId: input.organisationId,
    createdBy: input.createdBy,
    expiresAt: Date.now() + INVITE_LIFETIME_MS,
  });
  return token;
}

/** The contractor an invite names, while it is unexpired and they are active. */
export async function contractorForInvite(db: Database, token: string): Promise<ContractorRow | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const [invite] = await db
    .select()
    .from(contractorInvites)
    .where(eq(contractorInvites.tokenHash, await sha256Hex(token)))
    .limit(1);
  if (!invite || Number(invite.expiresAt) < Date.now()) return null;
  const [contractor] = await db
    .select()
    .from(contractors)
    .where(
      and(
        eq(contractors.id, invite.contractorId),
        eq(contractors.organisationId, invite.organisationId),
        eq(contractors.active, true),
      ),
    )
    .limit(1);
  if (!contractor) return null;
  if (!invite.usedAt) {
    await db
      .update(contractorInvites)
      .set({ usedAt: new Date().toISOString() })
      .where(eq(contractorInvites.id, invite.id))
      .catch(() => {});
  }
  return contractor;
}

/* ── One-time codes (email) ──────────────────────────────────────────────── */

export async function issueLoginCode(db: Database, identity: string) {
  await db.delete(contractorLoginCodes).where(lt(contractorLoginCodes.expiresAt, Date.now())).catch(() => {});
  await db.delete(contractorLoginCodes).where(eq(contractorLoginCodes.identity, identity));
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  await db.insert(contractorLoginCodes).values({
    id: `ccode_${crypto.randomUUID().replace(/-/g, "")}`,
    identity,
    codeHash: await sha256Hex(`${identity}:${code}`),
    expiresAt: Date.now() + CODE_LIFETIME_MS,
  });
  return code;
}

/** True once, for the right code, within ten minutes and five tries. */
export async function checkLoginCode(db: Database, identity: string, code: string) {
  const [row] = await db
    .select()
    .from(contractorLoginCodes)
    .where(eq(contractorLoginCodes.identity, identity))
    .limit(1);
  if (!row) return false;
  if (Number(row.expiresAt) < Date.now() || row.attempts >= CODE_ATTEMPTS) {
    await db.delete(contractorLoginCodes).where(eq(contractorLoginCodes.id, row.id));
    return false;
  }
  if ((await sha256Hex(`${identity}:${code.trim()}`)) !== row.codeHash) {
    await db
      .update(contractorLoginCodes)
      .set({ attempts: row.attempts + 1 })
      .where(eq(contractorLoginCodes.id, row.id));
    return false;
  }
  await db.delete(contractorLoginCodes).where(eq(contractorLoginCodes.id, row.id));
  return true;
}

