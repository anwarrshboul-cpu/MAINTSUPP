import type { Metadata } from "next";
import ContractorJobView from "./contractor-job-view";
import jobLinkCss from "./job-link.css?url";

// A shared link must never be indexed — it is a credential in a URL.
export const metadata: Metadata = {
  title: "Job details | MAINTSUPP",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

export default async function ContractorJobPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <>
      <link rel="stylesheet" href={jobLinkCss} />
      <ContractorJobView token={token} />
    </>
  );
}
