/**
 * §35 — SCOPED API TOKENS: the rules, with no database and no request.
 *
 * A token is `mst_<12 hex>_<64 hex>`. The first part is its PREFIX — stored and
 * shown again so a person can tell their tokens apart; the whole string is shown
 * exactly once, when it is issued, and only its SHA-256 is stored (the same
 * hashing, and the same reasoning, as a session token). Losing the table leaks
 * no credential.
 *
 * READ-ONLY SCOPES, AND NEVER MORE THAN THE CREATOR HAS NOW. Each scope names
 * the workspace capability it stands for. On every request the token's scopes
 * are intersected with what its creator CURRENTLY holds in that workspace — so
 * demoting the creator, closing a capability for their role, or deactivating
 * them shrinks or kills the token at once, with nothing to remember to revoke.
 * And a creator who has lost `integrations.manage` itself loses every token
 * they issued: a credential outlives nobody's authority to hold it.
 */

import { can, type Capability, type PermissionSubject } from "../permissions";

export const API_SCOPES = {
  "jobs:read": { capability: "board.view", label: "Read jobs" },
  "sites:read": { capability: "board.view", label: "Read sites" },
} as const satisfies Record<string, { capability: Capability; label: string }>;

export type ApiScope = keyof typeof API_SCOPES;

export const API_SCOPE_KEYS = Object.keys(API_SCOPES) as ApiScope[];

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(API_SCOPES, value);
}

/** Days a token may live. 90 unless the person chooses otherwise. */
export const TOKEN_LIFETIMES = [30, 90, 365] as const;
export const DEFAULT_TOKEN_DAYS = 90;
/** Live tokens per workspace. Enough for real integrations; not a key farm. */
export const MAX_LIVE_TOKENS = 20;

const TOKEN_PATTERN = /^mst_([0-9a-f]{12})_([0-9a-f]{64})$/;

function randomHex(bytes: number) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A fresh token and the prefix that identifies it. */
export function mintToken() {
  const prefix = `mst_${randomHex(6)}`;
  return { token: `${prefix}_${randomHex(32)}`, prefix };
}

/** The prefix of a well-formed token, or null — a malformed one is never looked up. */
export function parseToken(value: string | null | undefined) {
  const match = TOKEN_PATTERN.exec((value ?? "").trim());
  return match ? { prefix: `mst_${match[1]}` } : null;
}

/** The token from an `Authorization: Bearer …` header, or null. Nothing else is read. */
export function bearerToken(header: string | null | undefined) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match ? match[1] : null;
}

/** Stored scopes, read defensively: unknown words are dropped, never trusted. */
export function readScopes(stored: string | null | undefined): ApiScope[] {
  try {
    const parsed = JSON.parse(stored ?? "[]") as unknown;
    return Array.isArray(parsed) ? [...new Set(parsed.filter(isApiScope))] : [];
  } catch {
    return [];
  }
}

/**
 * The scopes a token may use RIGHT NOW: the ones it was issued with, each still
 * backed by its creator's current permissions — and none at all once the creator
 * can no longer manage integrations.
 */
export function effectiveTokenScopes(scopes: readonly ApiScope[], creator: PermissionSubject): ApiScope[] {
  if (!can(creator, "integrations.manage")) return [];
  return scopes.filter((scope) => can(creator, API_SCOPES[scope].capability));
}

/**
 * Validates a request to issue a token. The creator must hold every capability
 * the scopes stand for — a token cannot be a way to acquire access its creator
 * lacks.
 */
export function validateTokenRequest(
  input: { name?: unknown; scopes?: unknown; days?: unknown },
  creator: PermissionSubject,
): { ok: true; name: string; scopes: ApiScope[]; days: number } | { ok: false; error: string } {
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) : "";
  if (name.length < 2) return { ok: false, error: "Give the token a name you will recognise, such as the system that uses it." };
  const requested = Array.isArray(input.scopes) ? input.scopes : [];
  if (!requested.length) return { ok: false, error: "Choose at least one thing the token may read." };
  if (!requested.every(isApiScope)) return { ok: false, error: "One of the chosen permissions is not one a token can have." };
  const scopes = [...new Set(requested as ApiScope[])];
  const missing = scopes.filter((scope) => !can(creator, API_SCOPES[scope].capability));
  if (missing.length) {
    return { ok: false, error: `You cannot issue a token that reads what you cannot: ${missing.join(", ")}.` };
  }
  const days = input.days === undefined || input.days === null ? DEFAULT_TOKEN_DAYS : Number(input.days);
  if (!(TOKEN_LIFETIMES as readonly number[]).includes(days)) {
    return { ok: false, error: `A token lasts ${TOKEN_LIFETIMES.join(", ")} days.` };
  }
  return { ok: true, name, scopes, days };
}
