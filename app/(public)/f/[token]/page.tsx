import type { Metadata } from "next";
import PublicForm from "./public-form";
import publicFormCss from "./public-form.css?url";

/**
 * A shared form link.
 *
 * Not indexed. A form link is handed to a named group of store managers, and
 * although it is not a credential the way a contractor job link is, having
 * Google list "Maintenance Request" for a client's estate is nobody's intent.
 */
export const metadata: Metadata = {
  title: "Maintenance Request",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * Deliberately a thin server shell over a client component, matching
 * `/j/[token]`. The token is handed down and every decision — is the form
 * open, locked, closed, or asking for a sign-in — is made by the API against
 * the database, never here, so none of the form's configuration is present in
 * the server-rendered HTML before the visitor has passed whatever gate applies.
 */
export default async function PublicFormPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <>
      <link rel="stylesheet" href={publicFormCss} />
      <PublicForm token={token} />
    </>
  );
}
