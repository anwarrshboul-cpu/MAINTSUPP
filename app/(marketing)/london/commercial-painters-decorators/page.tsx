import type { Metadata } from "next";
import { landingPage } from "../../_landing/index.ts";
import { LandingPage } from "../../_landing/landing-page";
import { pageSocial } from "../../../lib/page-social";

/*
 * One of the London pages. Its words are in `_landing/services.ts` and its
 * markup in `_landing/landing-page.tsx`; this file is the address.
 *
 * The canonical is a LITERAL here, not built from the object, because
 * `tests/marketing-canonicals.test.mjs` reads it out of this file and refuses a
 * page that does not name its own address.
 */
const page = landingPage("/london/commercial-painters-decorators");

export const metadata: Metadata = {
  title: page.title,
  description: page.description,
  alternates: { canonical: "https://maintsupp.com/london/commercial-painters-decorators" },
  ...pageSocial("/london/commercial-painters-decorators", page.title, page.description),
};

export default function Page() {
  return <LandingPage page={page} />;
}
