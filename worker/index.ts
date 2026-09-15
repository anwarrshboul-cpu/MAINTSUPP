/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  BUCKET: R2Bucket;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

/**
 * THE ONE VERCEL HOSTNAME THAT IS A DUPLICATE OF THE SITE, and only that one.
 *
 * `maintsupp-portal.vercel.app` is an alias of the SAME production deployment
 * that serves maintsupp.com, so every page of the marketing site — and the
 * portal behind it — was reachable at two addresses, both answering 200, both
 * serving a robots.txt that names `https://maintsupp.com`. That is duplicate
 * content with no canonical between the two hosts.
 *
 * MATCHED EXACTLY, NEVER BY SUFFIX. The Preview deployments this project is
 * released through are `maintsupp-portal-<hash>-maintsupp.vercel.app` and
 * `maintsupp-portal-git-<branch>-maintsupp.vercel.app`; a `.endsWith(".vercel.app")`
 * here would bounce every one of them to production and make Preview QA
 * impossible — which is the whole mechanism this project verifies releases with.
 */
const DUPLICATE_HOST = "maintsupp-portal.vercel.app";
const CANONICAL_ORIGIN = "https://www.maintsupp.com";

/**
 * Whether this deployment is one search engines should stay out of.
 *
 * `VERCEL_ENV` is "production", "preview" or "development". Only a value that
 * is present AND not production earns the header: an unset variable means this
 * is not running on Vercel at all — the Railway box, or a local dev server —
 * and guessing "noindex" for an unknown host is how a live site disappears
 * from search.
 */
function isUnindexableDeployment() {
  const env = (globalThis as Record<string, unknown>).process as
    | { env?: Record<string, string | undefined> }
    | undefined;
  const target = env?.env?.VERCEL_ENV;
  return typeof target === "string" && target !== "" && target !== "production";
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    /*
     * 301, and the PATH IS KEPT. Sending every address on the duplicate host to
     * the bare homepage would break a bookmarked `/dashboard` and every deep
     * link anybody has ever shared; keeping the path means the redirect is a
     * change of hostname and nothing else. Permanent rather than temporary
     * because it is: the alias is not coming back as a second front door.
     */
    if (url.hostname === DUPLICATE_HOST) {
      return new Response(null, {
        status: 301,
        headers: {
          Location: `${CANONICAL_ORIGIN}${url.pathname}${url.search}`,
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return withSecurityHeaders(
      await handler.fetch(request, env, ctx),
      url.pathname,
    );
  },
};

/**
 * The routes whose ANSWER DEPENDS ON WHO IS ASKING.
 *
 * Not "the protected routes" — /login is on this list precisely because it is
 * public. It returns a form to an anonymous browser and a redirect to a
 * signed-in one, at one URL, and that is the shape that must never be shared
 * between two people.
 */
function authDependent(pathname: string) {
  return (
    pathname === "/login" ||
    pathname === "/portal" ||
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/")
  );
}

/**
 * The headers every response gets, because there were none.
 *
 * A security audit of this app found stored HTML being served from
 * `/api/files/[id]` and executing on this origin. That specific hole is closed
 * at both the upload and the download, but the app had no baseline: no
 * `nosniff`, no framing rule, no referrer policy, nowhere. These are the floor,
 * so a future route cannot be the one that forgets.
 *
 * Deliberately NOT a `Content-Security-Policy` on HTML documents. The app is a
 * React/vinext build whose inline bootstrap and styles would need either
 * `'unsafe-inline'` — which buys almost nothing — or a nonce threaded through
 * the renderer, which is a real change to make deliberately and verify, not to
 * slip into a headers helper. `/api/files/[id]` sets its own strict CSP on the
 * bytes it serves, which is where untrusted content actually lives.
 *
 * A route that has already set one of these keeps it: the file route's CSP and
 * disposition are more specific than anything here.
 */
function withSecurityHeaders(response: Response, pathname = ""): Response {
  const headers = new Headers(response.headers);

  /*
   * AN AUTH-DEPENDENT REDIRECT IS NOT A SHAREABLE ANSWER.
   *
   * The framework stamps `no-store` on the 200s these routes return, and
   * nothing at all on the 3xx. So `/dashboard` → `/login?next=…` for an
   * anonymous browser and `/login` → `/dashboard` for a signed-in one both
   * went out with no cache metadata and no `Vary: Cookie` — two different
   * answers at one URL, distinguished only by a cookie nothing was told to
   * vary on.
   *
   * RFC 9111 does not make 307 heuristically cacheable, so no compliant shared
   * cache stores it and this is latent rather than live. It is closed anyway,
   * because the failure it would produce is not a slow page: an anonymous
   * visitor served a cached `/login → /dashboard` loops, and a signed-in one
   * served a cached `/dashboard → /login` cannot get in at all. A one-line
   * default is cheaper than either.
   *
   * Scoped to the redirect and to these routes on purpose. A blanket
   * `no-store` here would also land on the marketing pages and on every static
   * asset the site serves, which is a performance regression dressed as a
   * security fix.
   */
  if (
    response.status >= 300 &&
    response.status < 400 &&
    authDependent(pathname) &&
    !headers.has("Cache-Control")
  ) {
    headers.set("Cache-Control", "private, no-store");
    const vary = headers.get("Vary");
    if (!vary) headers.set("Vary", "Cookie");
    else if (!/\bcookie\b/i.test(vary)) headers.set("Vary", `${vary}, Cookie`);
  }

  // Never let a browser second-guess a declared Content-Type.
  if (!headers.has("X-Content-Type-Options")) {
    headers.set("X-Content-Type-Options", "nosniff");
  }
  // No framing: this app has no embeddable surface, and clickjacking a board
  // that can delete rows is not a trade worth making.
  if (!headers.has("X-Frame-Options")) {
    headers.set("X-Frame-Options", "DENY");
  }
  // Send the origin to third parties, never the path — job and token URLs are
  // in the path, and a contractor link in a Referer header is a leaked grant.
  if (!headers.has("Referrer-Policy")) {
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }
  // Nothing here uses a camera, a microphone or a location.
  if (!headers.has("Permissions-Policy")) {
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  }

  /*
   * A PREVIEW DEPLOYMENT IS NOT A SECOND COPY OF THE SITE FOR GOOGLE TO FIND.
   *
   * Every push builds one at its own `*.vercel.app` hash URL, serving the whole
   * marketing site with the production `robots.txt` — which says `Allow: /` and
   * names maintsupp.com — so each release quietly published another indexable
   * duplicate under a different hostname.
   *
   * `X-Robots-Tag` rather than a `<meta>` tag, because it covers the non-HTML
   * responses too and needs no change to any page. `noindex, nofollow` so a
   * crawler that reaches a preview does not walk it either.
   */
  if (isUnindexableDeployment() && !headers.has("X-Robots-Tag")) {
    headers.set("X-Robots-Tag", "noindex, nofollow");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default worker;
