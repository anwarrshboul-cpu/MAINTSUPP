import type { Metadata } from "next";
import { apiFromServer } from "../../../lib/api";
import { SignedImage } from "../../../components/signed-media";
import ShareActions from "./share-actions";

export const dynamic = "force-dynamic";

/*
 * Never indexed, never previewed.
 *
 * The URL is the credential. A search engine that crawls it publishes a
 * client's job, and a link-preview fetcher — WhatsApp, Slack, iMessage — pulls
 * the page automatically on send. `noindex` handles the first; the second is
 * why the page reveals nothing above the fold that a preview could scrape into
 * a chat thread, and why the API does not treat a GET as proof of anything.
 */
export const metadata: Metadata = {
  title: "Job — MAINTSUPP",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false } },
};

type Job = {
  id: string;
  reference: string;
  title: string;
  description: string;
  status: string;
  stage: string;
  priority: string | null;
  engineer_required: string | null;
  fault_label: string | null;
  location: string | null;
  site_name: string | null;
  organisation_name: string | null;
  date_requested: string;
  date_completed: string | null;
  job_requested_by: string | null;
  contact_number: string | null;
  cost_of_works_pence?: number | null;
  invoice_ref?: string | null;
  approved_by?: string | null;
};

type Attachment = {
  id: string;
  kind: string;
  original_name: string;
  content_type: string;
};

type Payload = {
  job: Job;
  comments: { body: string; author: string; created_at: string }[];
  /** Released rows only — the API never sends a `pending` one down a share link. */
  attachments: Attachment[];
  quotes: { amount_pence: number; description: string | null; status: string }[];
};

const money = (pence: number | null | undefined) =>
  pence === null || pence === undefined
    ? null
    : new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(
        pence / 100,
      );

const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

export default async function SharedJobPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await apiFromServer<Payload>(`/public/job/${token}`, "");

  if (!result.ok) {
    return (
      <main className="wrap">
        <div className="card card--empty">
          <h1>This link is not valid</h1>
          {/* Expired, revoked and never-existed are one message on purpose:
              telling them apart confirms to a stranger that a job exists. */}
          <p>
            The link may have expired or been withdrawn. Ask your MAINTSUPP
            contact for a new one.
          </p>
        </div>
      </main>
    );
  }

  const { job, comments, attachments, quotes } = result.data;
  const cost = money(job.cost_of_works_pence);
  /*
   * Kind says where a file belongs on the page; content type says how it can be
   * drawn. A PDF filed as an issue picture is a real thing — a survey, a
   * schematic — and an <img> pointed at one renders nothing at all, so the two
   * questions are asked separately.
   */
  const isImage = (file: Attachment) => file.content_type.startsWith("image/");
  const issuePictures = attachments.filter((a) => a.kind === "issue_picture" && isImage(a));
  const donePictures = attachments.filter((a) => a.kind === "completed_picture" && isImage(a));
  const documents = attachments.filter((a) => !isImage(a));

  /** Each tile mints its own short-lived URL in the browser — see the component. */
  const pictureFrom = (file: Attachment) => (
    <SignedImage
      key={file.id}
      path={`/public/job/${token}/attachment/${file.id}`}
      name={file.original_name}
    />
  );

  return (
    <main className="wrap">
      <header className="head">
        <span className="mark" aria-hidden="true">
          <svg viewBox="0 0 40 40" fill="none" width="26" height="26">
            <path d="M6 33V9l14 15" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M20 24 34 9v24" stroke="#12B4A8" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="brand">MAINT<strong>SUPP</strong></span>
        <span className="ref">{job.reference}</span>
      </header>

      <article className="card">
        <div className="chips">
          {job.priority ? (
            <span className={`chip chip--${job.priority.toLowerCase()}`}>{job.priority}</span>
          ) : null}
          <span className="chip chip--status">{job.status}</span>
        </div>

        <h1>{job.title}</h1>
        <p className="site">
          {job.site_name ?? job.location ?? "—"}
          {job.organisation_name ? ` · ${job.organisation_name}` : ""}
        </p>

        <dl className="facts">
          <div><dt>Engineer</dt><dd>{job.engineer_required ?? "—"}</dd></div>
          <div><dt>Fault</dt><dd>{job.fault_label ?? "—"}</dd></div>
          <div><dt>Requested</dt><dd>{date(job.date_requested) ?? "—"}</dd></div>
          <div><dt>Requested by</dt><dd>{job.job_requested_by ?? "—"}</dd></div>
          {job.contact_number ? (
            <div>
              <dt>Contact</dt>
              {/* A tel: link, because this page is opened on a phone in a
                  corridor and the next action is usually to ring the store. */}
              <dd><a href={`tel:${job.contact_number.replace(/\s+/g, "")}`}>{job.contact_number}</a></dd>
            </div>
          ) : null}
          {job.date_completed ? (
            <div><dt>Completed</dt><dd>{date(job.date_completed)}</dd></div>
          ) : null}
          {cost ? <div><dt>Cost of works</dt><dd>{cost}</dd></div> : null}
          {job.invoice_ref ? <div><dt>Invoice</dt><dd>{job.invoice_ref}</dd></div> : null}
          {job.approved_by ? <div><dt>Approved by</dt><dd>{job.approved_by}</dd></div> : null}
        </dl>

        <section>
          <h2>Description of works</h2>
          <p className="body">{job.description}</p>
        </section>

        {quotes.length ? (
          <section>
            <h2>Quotes</h2>
            <ul className="list">
              {quotes.map((quote, index) => (
                <li key={index}>
                  <strong>{money(quote.amount_pence)}</strong>
                  <span className="chip chip--status">{quote.status}</span>
                  {quote.description ? <p className="body">{quote.description}</p> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {issuePictures.length ? (
          <section>
            <h2>Pictures of the issue</h2>
            <ul className="shots">{issuePictures.map(pictureFrom)}</ul>
          </section>
        ) : null}

        {donePictures.length ? (
          <section>
            <h2>Pictures of completed works</h2>
            <ul className="shots">{donePictures.map(pictureFrom)}</ul>
          </section>
        ) : null}

        {documents.length ? (
          <section>
            <h2>Documents</h2>
            {/* Named, not linked. A signed URL lives about five minutes, so one
                minted while this page was rendered is dead before most readers
                reach it — and a dead link reads as a lost document. */}
            <ul className="files">
              {documents.map((file) => <li key={file.id}>{file.original_name}</li>)}
            </ul>
          </section>
        ) : null}

        <section>
          <h2>Updates</h2>
          {comments.length === 0 ? (
            <p className="muted">No updates yet.</p>
          ) : (
            <ul className="thread">
              {comments.map((comment, index) => (
                <li key={index}>
                  <p className="who">
                    {comment.author} · {date(comment.created_at)}
                  </p>
                  <p className="body">{comment.body}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </article>

      <ShareActions token={token} completed={job.status === "Job Completed"} />

      <p className="foot">
        You are viewing a job shared by MAINTSUPP. Anyone with this link can see
        and update it — do not forward it further.
      </p>
    </main>
  );
}
