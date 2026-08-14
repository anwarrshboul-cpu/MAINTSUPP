import type { NextConfig } from "next";

/**
 * The Vercel app.
 *
 * It holds no database credentials and makes no database connection: every
 * read and write goes to the Railway API over HTTP. That is what keeps the
 * secret in one place — a frontend that can reach Postgres directly is a
 * frontend whose environment variables can leak the whole dataset.
 */
/**
 * Where the API actually lives. The browser never uses this directly — see the
 * rewrite below and the comment in lib/api.ts.
 */
const API_ORIGIN = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"
).replace(/\/+$/, "");

const config: NextConfig = {
  reactStrictMode: true,

  /**
   * The API, served from this origin.
   *
   * The session cookie is SameSite=Lax, so the browser refuses to send it to a
   * different site. A page on vercel.app calling an API on up.railway.app is
   * cross-site: the user signs in, the cookie is set, and every request after
   * it is anonymous. Proxying through /api makes those calls first-party.
   *
   * A rewrite rather than a vercel.json route so that `next dev` behaves the
   * same way as production — a proxy that exists only when deployed is a proxy
   * whose bugs are only ever found by users.
   */
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/:path*` }];
  },
  // The API sets its own; nothing here should be framed or sniffed either.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "x-content-type-options", value: "nosniff" },
          { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default config;
