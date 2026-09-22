import Link from "next/link";
import marketingCss from "./(marketing)/marketing.css?url";
import { NotFoundTitle } from "./not-found-title";

/*
 * THE 404, FOR EVERY ADDRESS THAT MATCHES NOTHING.
 *
 * Without this file the framework answered an unknown URL with its own bare
 * "Not Found" — no `lang`, an empty title, no way back. This is the ROOT
 * not-found, so it renders inside `app/layout.tsx` (which supplies `<html
 * lang="en">` and the tab icons) and nothing else: no group layout wraps it, so
 * it brings the marketing stylesheet itself, the way `(marketing)/layout.tsx`
 * does, and borrows only the shared `.m-*` classes the CMS blocks use. The
 * response is still a 404.
 *
 * NO `metadata` EXPORT. vinext builds a boundary page's head from the LAYOUTS'
 * metadata only, so one here would be silently ignored; it already adds
 * `<meta name="robots" content="noindex">` itself. The tab title is set by
 * `NotFoundTitle` once the page is live.
 */
export default function NotFound() {
  return (
    <div className="m-root">
      <NotFoundTitle title="Page not found | MAINTSUPP" />
      <link rel="stylesheet" href={marketingCss} />
      <main className="m-section">
        <div className="m-shell m-shell--narrow">
          <p className="m-eyebrow">Error 404</p>
          <h1>This page does not exist</h1>
          <p className="m-lead">
            The address may be mistyped, or the page may have moved. Nothing has
            been lost by landing here.
          </p>
          <p>
            <Link className="btn btn--primary" href="/">
              Go to the home page
            </Link>{" "}
            <Link href="/dashboard">Open the portal</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
