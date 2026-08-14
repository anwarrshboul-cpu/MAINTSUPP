import type { NextConfig } from "next";

/**
 * The Vercel app.
 *
 * It holds no database credentials and makes no database connection: every
 * read and write goes to the Railway API over HTTP. That is what keeps the
 * secret in one place — a frontend that can reach Postgres directly is a
 * frontend whose environment variables can leak the whole dataset.
 */
const config: NextConfig = {
  reactStrictMode: true,
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
