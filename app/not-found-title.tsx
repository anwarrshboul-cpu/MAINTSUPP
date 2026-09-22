"use client";

import { useEffect } from "react";

/**
 * The 404's tab title, set once the page is live.
 *
 * vinext builds a not-found page's head from the root layout's metadata only,
 * so the server can only send the site's default title; a second `<title>`
 * element would be invalid HTML and lose to the first anyway. Setting
 * `document.title` rewrites that one element instead.
 */
export function NotFoundTitle({ title }: { title: string }) {
  useEffect(() => {
    document.title = title;
  }, [title]);
  return null;
}
