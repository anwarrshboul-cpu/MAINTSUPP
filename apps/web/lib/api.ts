/**
 * The one way this app talks to the API.
 *
 * `credentials: "include"` on every call, because the session lives in an
 * HttpOnly cookie set by the API — without it the browser sends nothing and
 * every authenticated request 401s, which looks exactly like a broken login.
 *
 * There are two base URLs, because the browser and the server reach the API by
 * different routes.
 *
 * The browser goes through THIS origin, at /api/*, which next.config.ts
 * rewrites to the API. It cannot call the API's own hostname directly: the
 * session cookie is SameSite=Lax, and a browser withholds a Lax cookie from a
 * cross-site request. On stock platform hostnames — a vercel.app page calling
 * an up.railway.app API — sign-in succeeds, the cookie is stored, and every
 * request after it arrives anonymous. Going through the proxy makes the cookie
 * first-party, which is what Lax is asking for.
 *
 * The server has no cookie jar to protect and no origin to be relative to, so
 * it calls the API's absolute address.
 */
export const API_ORIGIN = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"
).replace(/\/+$/, "");

/** Must match the `source` prefix of the rewrite in next.config.ts. */
export const API_PROXY_PATH = "/api";

export const API_URL = typeof window === "undefined" ? API_ORIGIN : API_PROXY_PATH;

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; body?: Record<string, unknown> };

/**
 * A multipart body must set its OWN content type.
 *
 * `FormData` is serialised with a boundary string the browser invents per
 * request, and that boundary lives in the `Content-Type` header — so declaring
 * `application/json` here (or declaring anything at all) hands the API a body
 * it cannot parse. Hono's `c.req.formData()` then throws, `receiveFile` catches
 * it, and every photograph upload answers "Send the file as form data." That
 * failure looks like a broken endpoint and is really one wrong header.
 */
const isMultipart = (body: BodyInit | null | undefined): boolean =>
  typeof FormData !== "undefined" && body instanceof FormData;

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        ...(init.body && !isMultipart(init.body)
          ? { "content-type": "application/json" }
          : {}),
        ...init.headers,
      },
    });

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: typeof body.error === "string" ? body.error : "Something went wrong.",
        body,
      };
    }
    return { ok: true, data: body as T };
  } catch {
    // A network failure and a 500 are different problems with different fixes,
    // so they get different messages rather than one shrug.
    return {
      ok: false,
      status: 0,
      error: "Could not reach the server. Check your connection.",
    };
  }
}

/**
 * Server-side fetch that forwards the caller's cookies.
 *
 * A React Server Component has no ambient credentials — `credentials:
 * "include"` means nothing on the server, because there is no cookie jar. The
 * incoming request's Cookie header has to be passed through by hand, or every
 * server-rendered page renders as signed out.
 */
export async function apiFromServer<T = unknown>(
  path: string,
  cookieHeader: string,
): Promise<ApiResult<T>> {
  return api<T>(path, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: "no-store",
  });
}
