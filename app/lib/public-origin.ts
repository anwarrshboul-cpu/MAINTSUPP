/**
 * The origin a link handed to somebody OUTSIDE the workspace must be built on.
 *
 * WHY THIS EXISTS.
 *
 * Both public links this app mints — the contractor's job link (`/j/<token>`)
 * and the request form's share link (`/f/<token>`) — were built from
 * `new URL(request.url).origin`, the host the operator happened to be looking
 * at when they pressed Copy. On one host that is exactly right, and it is why
 * the code was written that way: localhost in development, the real domain in
 * production, never a hard-coded guess that is wrong in one of the two.
 *
 * Vercel is not one host. Every deployment keeps its OWN permanent hostname
 * (`maintsupp-preview-<hash>-<scope>.vercel.app`) alongside the alias, and that
 * hostname keeps serving the build it was made from for ever. So a coordinator
 * who opened the dashboard from a deployment URL — a preview comment, a
 * "Visit" button in the Vercel dashboard, a link somebody pasted in chat — and
 * copied a job link out of it minted a link pinned to that build. It was
 * verified: the deployment before the repaint still answers 200 and still
 * renders the pre-repaint page. The contractor is then working a version of the
 * job page nobody is maintaining, against a token that is perfectly valid, and
 * nothing about the link looks wrong.
 *
 * A share link outlives the session that made it. It goes into an email, a
 * WhatsApp message, a printed work order; it is opened weeks later by someone
 * who cannot be told "try it from the other address". The origin it carries has
 * to be the one the workspace INTENDS to be reachable at, not the one a browser
 * tab happened to be on.
 *
 * THE FALLBACK IS THE OLD BEHAVIOUR, DELIBERATELY.
 *
 * `PUBLIC_APP_ORIGIN` is read from the environment. When it is unset — local
 * development, a test run, a self-hosted deployment nobody has configured, and
 * Production unless and until somebody sets it — this returns the request's own
 * origin and the links are byte-identical to what they were before. Nothing
 * breaks by omission; a deployment opts IN to a canonical origin.
 *
 * That is also the reason the value is configuration and never a constant in
 * source: the correct answer differs per environment, and a preview URL
 * compiled into the bundle would follow the code into Production and start
 * minting links that point customers at a staging database. Preview sets it to
 * the preview alias, Production sets it to the production domain, and neither
 * can be the other by accident.
 *
 * A MALFORMED VALUE IS IGNORED, NOT MINTED.
 *
 * A misconfigured variable ("maintsupp.com" with no scheme, a value with a path
 * or a trailing slash pasted from a browser bar, an `ftp://` typo) would
 * otherwise produce a link that is broken in a way the operator cannot see
 * until the contractor reports it. Every one of those falls back to the request
 * origin, which is at worst what we had yesterday.
 */

/**
 * The environment variable, read in exactly one place.
 *
 * Named for what it IS rather than borrowing a framework's convention:
 * `VERCEL_URL` is the deployment-specific hostname this module exists to avoid,
 * and `NEXT_PUBLIC_*` would ship the value into the browser bundle, which a
 * server-minted link has no reason to do.
 *
 * Written as a LITERAL `process.env.PUBLIC_APP_ORIGIN` below rather than
 * `process.env[SOME_CONSTANT]`. A bundler that substitutes environment values
 * at build time matches the literal member expression and nothing else, so the
 * indirection that reads better in source is the one that silently returns
 * `undefined` in a build — and `undefined` here is indistinguishable from "not
 * configured", which means the failure would be a quiet return to the old
 * behaviour rather than anything anybody notices.
 */
export const ORIGIN_ENV = "PUBLIC_APP_ORIGIN";

/**
 * Validates a configured origin and returns it normalised, or `null`.
 *
 * "Normalised" means exactly `URL.origin`: scheme, host and a port only when it
 * is not the default. Anything the operator appended — a path, a query, a
 * fragment, a trailing slash — is dropped rather than treated as an error,
 * because `https://maintsupp-preview.vercel.app/` is unambiguously what they
 * meant and refusing it would only send the link back to the request origin for
 * a cosmetic reason.
 *
 * A path with actual content is a different matter and IS refused: someone who
 * wrote `https://example.com/portal` believes links will be prefixed with
 * `/portal`, and silently discarding that would mint links that 404. Better the
 * old behaviour than a confident wrong answer.
 *
 * Only http and https. A `javascript:` or `data:` value reaching a link the app
 * renders and a coordinator copies is not a scenario worth leaving open, and no
 * other scheme has a meaning here.
 */
export function normalisePublicOrigin(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // No scheme ("maintsupp.com"), or unparseable. Guessing `https://` on the
    // operator's behalf would hide the misconfiguration rather than fix it.
    return null;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  // `new URL("https:///x")` parses with an empty host on some runtimes.
  if (!parsed.hostname) return null;
  // A real path prefix is a promise this module cannot keep — see above.
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  if (parsed.search || parsed.hash) return null;
  // Credentials in a shared link are a leak, not a configuration.
  if (parsed.username || parsed.password) return null;

  return parsed.origin;
}

/**
 * The origin every externally shared link is built on.
 *
 * `request` is still required and still used: it is the fallback, and it is the
 * ONLY thing that keeps `npm run dev`, the test suite and an unconfigured
 * deployment working. Callers pass the request they are already holding.
 */
export function publicOrigin(request: Request): string {
  const configured = normalisePublicOrigin(process.env.PUBLIC_APP_ORIGIN);
  if (configured) return configured;
  return new URL(request.url).origin;
}

/**
 * A public path resolved against the canonical origin.
 *
 * Both call sites want a whole URL rather than an origin, and building it here
 * means neither of them can reintroduce the `${origin}${path}` string-join that
 * produces `https://host//j/token` the first time somebody passes a leading
 * slash twice.
 */
export function publicUrl(request: Request, path: string): string {
  return new URL(path, publicOrigin(request)).toString();
}
