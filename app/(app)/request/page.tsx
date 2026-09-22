import type { Metadata } from "next";

import { requirePageSession } from "../../lib/page-guard";
import { RequestForm } from "./request-form";

export const dynamic = "force-dynamic";

/**
 * Raise a request — for a signed-in member.
 *
 * This page used to be on the public list as "the public job-request form" for
 * a store manager with no account. It never was one: the form reads its sites,
 * priorities and categories from `/api/context` and submits to
 * `/api/maintenance` (`board.edit`), and both refuse a visitor without a
 * session — so a signed-out visitor was shown the whole form with empty lists
 * and a session-expired notice, and could not send it. Requests from people
 * with no account have their own doors: the website's Report a job form
 * (`/api/report-job`) and a shared form link (`/f/<token>`). This one is linked
 * only from inside the portal, so it now asks for a session first and comes
 * back here after sign-in.
 */
export const metadata: Metadata = {
  title: "Raise a request",
};

export default async function RequestPage() {
  await requirePageSession("/request");
  return <RequestForm />;
}
