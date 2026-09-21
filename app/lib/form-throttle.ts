/**
 * THE PUBLIC FORM LINK'S THROTTLES — Phase 9 #4.
 *
 * A share link is anonymous by design, so the only thing that can tell one
 * caller from another is the connecting address — which is why these only
 * became worth having once `requestIp` stopped believing a header the caller
 * writes. Keyed per address, never per form alone: a per-form cap would let one
 * person with a script close a client's fault-reporting form to everybody.
 * What a distributed sender can still do is recorded in the handoff rather than
 * pretended away here.
 *
 *   LOOKUP MISSES   a token that resolves to nothing. Counted per address,
 *                   across every form, because guessing tokens is the one
 *                   attack a share link has, and a real visitor misses at most
 *                   a handful of times (a mistyped or retired link).
 *   SUBMISSIONS     every submission that reached a real form, per form and
 *                   address. Thirty in ten minutes is well past a person
 *                   reporting faults from one store; past it, the address waits.
 *   PASSWORD        a wrong answer to a password-protected form, per form and
 *                   address. PBKDF2 slows one guess; it does not stop a
 *                   thousand parallel ones, which is what a serverless platform
 *                   happily runs. Same numbers as sign-in.
 */
import type { PublicThrottle } from "./auth-session";

export const FORM_LOOKUP_MISSES: PublicThrottle = {
  name: "form-miss",
  windowMs: 10 * 60_000,
  max: 30,
  lockoutMs: 10 * 60_000,
};

export const FORM_SUBMISSIONS: PublicThrottle = {
  name: "form-submit",
  windowMs: 10 * 60_000,
  max: 30,
  lockoutMs: 10 * 60_000,
};

export const FORM_PASSWORD_FAILURES: PublicThrottle = {
  name: "form-password",
  windowMs: 15 * 60_000,
  max: 5,
  lockoutMs: 15 * 60_000,
};
