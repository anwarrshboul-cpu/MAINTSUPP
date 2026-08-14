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

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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

    return withSecurityHeaders(await handler.fetch(request, env, ctx));
  },
};

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
function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);

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

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default worker;
