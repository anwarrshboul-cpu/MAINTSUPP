import type { Metadata } from "next";
import appHomeCss from "../../app/app-home.css?url";
import contractorCss from "../../contractor/contractor.css?url";
import AcceptInvite from "./accept-invite";

/**
 * A contractor's personal app link (/c/<token>), sent by the office from the
 * contractor's profile. Opening it signs them in to the MAINTSUPP app.
 */
export const metadata: Metadata = {
  title: "Your MAINTSUPP app link",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <>
      <link rel="stylesheet" href={appHomeCss} />
      <link rel="stylesheet" href={contractorCss} />
      <AcceptInvite token={token} />
    </>
  );
}
