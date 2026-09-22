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

/*
 * `/api/report-job` — the home page's anonymous "report a fault" door. Every
 * report mints a thirty-minute upload token, and since uploads over 900 KB go
 * straight into the bucket that token is worth up to 50 MB of storage. Ten
 * reports per address per ten minutes is far above a shop's real need.
 */
export const REPORT_JOB_SUBMISSIONS: PublicThrottle = {
  name: "report-job",
  windowMs: 10 * 60_000,
  max: 10,
  lockoutMs: 10 * 60_000,
};

/*
 * `/api/leads` and `/api/contractor-applications` — the marketing site's other two
 * anonymous doors. The lead form had only a honeypot, which stops a bot driving
 * the page and nothing about a script posting to the route; the application
 * form had nothing at all. Every accepted submission writes a row and queues an
 * email to a real inbox, so both are counted per address, before anything is
 * read or written. Ten per ten minutes is far above what one company filling
 * in a form needs.
 */
export const LEAD_SUBMISSIONS: PublicThrottle = {
  name: "lead-submit",
  windowMs: 10 * 60_000,
  max: 10,
  lockoutMs: 10 * 60_000,
};

export const CONTRACTOR_APPLICATIONS: PublicThrottle = {
  name: "contractor-application",
  windowMs: 10 * 60_000,
  max: 10,
  lockoutMs: 10 * 60_000,
};

export const FORM_PASSWORD_FAILURES: PublicThrottle = {
  name: "form-password",
  windowMs: 15 * 60_000,
  max: 5,
  lockoutMs: 15 * 60_000,
};
