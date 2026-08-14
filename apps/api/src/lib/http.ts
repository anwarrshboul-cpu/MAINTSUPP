import type { Context } from "hono";
import { SESSION_COOKIE } from "./sessions.ts";

/*
 * Cookie attributes, in one place so no endpoint can forget one.
 *
 * `SameSite=Lax` is the right default, but it only reaches the API if the web
 * app and the API are the same *site* — that is, one registrable domain. On
 * stock platform hostnames (`x.vercel.app` calling `y.up.railway.app`) they are
 * not, so the browser withholds the cookie and every authenticated request
 * 401s, which presents as a login that silently does nothing.
 *
 * The fix is a shared parent domain — `maintsupp.com` and `api.maintsupp.com` —
 * with `COOKIE_DOMAIN=.maintsupp.com`. `SameSite=None` would also work and is
 * deliberately not offered: it sends the cookie on requests started by any
 * site on the internet, which is a real CSRF surface to buy something a
 * subdomain gives away.
 */
export function sessionCookieHeader(
  token: string,
  expiresAt: Date,
  persistent: boolean,
): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly", // no script can read it, so XSS cannot steal the session
    "SameSite=Lax", // survives a normal link click, blocks cross-site POSTs
  ];
  const domain = process.env.COOKIE_DOMAIN?.trim();
  if (domain) parts.push(`Domain=${domain}`);
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  // A session cookie (no Max-Age) when "Keep me signed in" was unticked: it
  // dies with the browser, which is the whole point of unticking it.
  if (persistent) parts.push(`Expires=${expiresAt.toUTCString()}`);
  return parts.join("; ");
}

export function clearSessionCookieHeader(): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  const domain = process.env.COOKIE_DOMAIN?.trim();
  // Must match the Domain the cookie was SET with, or the browser keeps the
  // original and sign-out appears to do nothing.
  if (domain) parts.push(`Domain=${domain}`);
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function readSessionCookie(c: Context): string | undefined {
  const header = c.req.header("cookie");
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    if (pair.slice(0, index).trim() === SESSION_COOKIE) {
      return decodeURIComponent(pair.slice(index + 1).trim()) || undefined;
    }
  }
  return undefined;
}

/** The client's address, honouring one proxy hop (Railway sits in front). */
export function clientIp(c: Context): string | undefined {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim();
  return c.req.header("x-real-ip") ?? undefined;
}

export const str = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

export const email = (value: unknown): string =>
  str(value, 254).toLowerCase();

export const isEmail = (value: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);

/**
 * A fixed-window rate limiter held in memory.
 *
 * Deliberately per-instance. It is a brake on scripted abuse of the public
 * endpoints, not a distributed quota — Railway may run more than one instance,
 * so the real ceiling is this limit times the instance count. That is an
 * acceptable and *stated* approximation; treating it as exact is the mistake.
 * A shared counter needs Redis, which is not worth a dependency until the
 * traffic justifies it.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

/* Unbounded growth would be a slow memory leak on a long-lived process. */
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref();

/**
 * Evens out how long a failing request takes.
 *
 * Sign-in verifies a password (~100ms of scrypt) when the account exists and
 * returns immediately when it does not — a difference an attacker can measure
 * to enumerate addresses. Padding every failure to a floor removes the signal.
 */
export async function padTo(startedAt: number, floorMs = 120): Promise<void> {
  const elapsed = Date.now() - startedAt;
  if (elapsed < floorMs) {
    await new Promise((resolve) => setTimeout(resolve, floorMs - elapsed));
  }
}
