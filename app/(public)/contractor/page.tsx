import type { Metadata } from "next";
import appHomeCss from "../app/app-home.css?url";
import ContractorApp from "./contractor-app";
import contractorCss from "./contractor.css?url";

/**
 * maintsupp.com/contractor — the contractor's view of the MAINTSUPP app: sign
 * in with a code or an invite link, then their own Fix Tracker. Same installed
 * app as clients; /app sends a signed-in contractor here.
 */
export const metadata: Metadata = {
  title: "Contractor jobs",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function ContractorPage() {
  return (
    <>
      <link rel="stylesheet" href={appHomeCss} />
      <link rel="stylesheet" href={contractorCss} />
      <ContractorApp />
    </>
  );
}
