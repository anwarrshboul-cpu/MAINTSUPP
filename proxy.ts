/**
 * The request proxy (Next.js 16's name for middleware). It does ONE thing, for
 * website CMS pages only: it carries a `?preview=1` request into a request
 * header, so the page can see it at every stage of its render.
 *
 * WHY THIS EXISTS AT ALL — THE FRAMEWORK, NOT A CHOICE.
 *
 * vinext 0.0.50 renders a page twice. First a "probe", which calls the page
 * with `searchParams` built from `collectAppPageSearchParams(...)
 * .searchParamsObject` — a key that function does not return, so the probe
 * always sees `{}` (the same defect `app/(app)/dashboard/[[...section]]/page.tsx`
 * records). A `notFound()` thrown in the probe IS the response. So a draft
 * opened as `/p/<slug>?preview=1` answered 404 even for platform staff: the
 * probe never saw the `preview=1` that the real render would have.
 *
 * `headers()` is the same in the probe and the render, so the flag rides there.
 * It only ever REQUESTS a preview: `app/(marketing)/p/[slug]/page.tsx` still
 * grants one to signed-in platform staff alone, so a header sent by hand gets a
 * stranger nothing a stranger could not already see. An incoming copy is
 * dropped anyway, so the only way to ask is the query the console links to.
 *
 * Scoped by `matcher` to `/p/<slug>`: no other route runs through this.
 */
import { NextResponse, type NextRequest } from "next/server";

import { PREVIEW_REQUEST_HEADER } from "./app/lib/cms-seo";

export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete(PREVIEW_REQUEST_HEADER);
  if (request.nextUrl.searchParams.get("preview") === "1") headers.set(PREVIEW_REQUEST_HEADER, "1");
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: "/p/:slug" };
