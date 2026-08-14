import type { Metadata } from "next";
import Link from "next/link";
import { getViewerState, serverFetch } from "../../../../../lib/session";
import {
  canAnswerOffer,
  canAssign,
  canChangeStatus,
  canSeeMoney,
  canTriage,
  formatDate,
  formatDateTime,
  formatMoney,
  priorityChipClass,
  type JobAttachment,
  type JobDetailPayload,
  type Member,
  type Scopes,
} from "../../../../../lib/portal";
import CopyLinkButton from "./copy-link-button";
import JobActions from "./job-actions";
import JobAssignment, { type Assignee } from "./job-assignment";
import JobAttachments from "./job-attachments";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Job" };

export default async function JobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const state = await getViewerState();
  if (state.kind !== "ok") return null; // the shell layout has already redirected

  /*
   * Two reads, in parallel.
   *
   * `/jobs/:id` is the job itself and never returns a `pending` attachment —
   * for anybody. `/uploads/job/:id` is the only endpoint that does, and only
   * for staff, which makes it the only way a share-link upload can be reviewed
   * at all. It is scoped by the same predicate as the job, so a caller who can
   * read one can read the other.
   */
  const [result, files] = await Promise.all([
    serverFetch<JobDetailPayload>(`/jobs/${id}`),
    serverFetch<{ attachments: JobAttachment[] }>(`/uploads/job/${id}`),
  ]);

  if (!result.ok) {
    return (
      <div className="card card--empty">
        <h1>This job is not available</h1>
        {/*
          The API answers 404 for a job that exists but is outside your scope,
          on purpose — a 403 would confirm the row exists and let someone walk
          ids to count a competitor's work. So this page cannot tell the two
          apart either, and does not pretend to.
        */}
        <p className="muted">{result.error}</p>
        <p>
          <Link href="/portal/dashboard">Back to the board</Link>
        </p>
      </div>
    );
  }

  const { job, comments, quotes } = result.data;
  const actor = state.viewer.actor;
  const money = canSeeMoney(actor);

  /*
   * The assign control needs a contractor list and the people who could be
   * named as doing the work, and BOTH endpoints are staff-only. Fetched only
   * when the viewer is staff — asking as a client would answer 403 twice per
   * job page, and the control that consumes them is not drawn for them anyway.
   *
   * Not in the Promise.all above: these are conditional, and hanging a `false`
   * branch off that array would make its tuple positions depend on the role.
   */
  const staff = canAssign(actor);
  const [scopes, people] = staff
    ? await Promise.all([
        serverFetch<Scopes>("/members/scopes"),
        serverFetch<{ members: Member[] }>("/members"),
      ])
    : [null, null];

  const assignees: Assignee[] =
    people?.ok
      ? people.data.members
          // Only somebody who could actually be on site: our own coordinators,
          // or a person attached to a contractor. A client_user in this list is
          // a 400 from the API and a nonsense on the job card.
          .filter(
            (member) =>
              member.status === "active" &&
              (member.contractor_id !== null ||
                member.role === "owner" ||
                member.role === "super_admin" ||
                member.role === "admin"),
          )
          .map((member) => ({
            id: member.id,
            name: member.full_name ?? member.email,
            contractorId: member.contractor_id,
          }))
      : [];
  // Present, not merely non-null: for a contractor the API deletes these keys
  // rather than nulling them, so `formatMoney` gets `undefined` and returns null.
  const cost = money ? formatMoney(job.cost_of_works_pence) : null;

  /* The job payload's own list is the fallback: it is the same rows minus the
     pending ones, so a blip on the second read costs the review queue, not the
     photographs. */
  const attachments = files.ok ? files.data.attachments : result.data.attachments;

  return (
    <>
      <div className="p-jobhead">
        <div>
          <p className="p-small p-muted">
            <Link href="/portal/dashboard">← Board</Link>
          </p>
          <h1 className="p-h1">{job.title}</h1>
          <p className="p-lede">
            {job.site_name ?? job.location ?? "No site recorded"}
            {job.organisation_name ? ` · ${job.organisation_name}` : ""}
          </p>
        </div>
        {/*
          Not drawn for a contractor, and the API does not send them the token
          either. The shared link opens the full ticket including the cost of
          works, so handing it to the one role that is never shown money would
          undo the whole `canSeeMoney` gate one Copy Link away.
        */}
        {job.share_token ? (
          <CopyLinkButton
            shareToken={job.share_token}
            shareEnabled={job.share_enabled !== false}
          />
        ) : null}
      </div>

      <article className="p-panel">
        <div className="chips">
          {job.priority ? (
            <span className={priorityChipClass(job.priority)}>{job.priority}</span>
          ) : null}
          <span className="chip chip--status">{job.status}</span>
          <span className="chip chip--status">{job.stage}</span>
        </div>

        <dl className="p-facts">
          <div>
            <dt>Job ID</dt>
            <dd className="p-mono">{job.reference}</dd>
          </div>
          <div>
            <dt>Store</dt>
            <dd>{job.site_name ?? job.location ?? "—"}</dd>
          </div>
          <div>
            <dt>Engineer Type</dt>
            <dd>{job.engineer_required ?? "—"}</dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>{job.priority ?? "—"}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{job.status}</dd>
          </div>
          <div>
            <dt>Date Requested</dt>
            <dd>{formatDate(job.date_requested) ?? "—"}</dd>
          </div>
          <div>
            <dt>Requested By</dt>
            <dd>{job.job_requested_by ?? "—"}</dd>
          </div>
          {job.contact_number ? (
            <div>
              <dt>Contact</dt>
              {/* A tel: link — the next action after reading a job is usually
                  ringing the store, and this page is read on a phone. */}
              <dd>
                <a href={`tel:${job.contact_number.replace(/\s+/g, "")}`}>
                  {job.contact_number}
                </a>
              </dd>
            </div>
          ) : null}
          {job.fault_label ? (
            <div>
              <dt>Fault</dt>
              <dd>{job.fault_label}</dd>
            </div>
          ) : null}
          {job.contractor_name ? (
            <div>
              <dt>Contractor</dt>
              <dd>{job.contractor_name}</dd>
            </div>
          ) : null}
          {job.assigned_to_name ? (
            <div>
              <dt>Assigned to</dt>
              <dd>{job.assigned_to_name}</dd>
            </div>
          ) : null}
          {job.date_completed ? (
            <div>
              <dt>Date Completed</dt>
              <dd>{formatDate(job.date_completed)}</dd>
            </div>
          ) : null}
          {cost ? (
            <div>
              <dt>Cost of works</dt>
              <dd>{cost}</dd>
            </div>
          ) : null}
          {job.invoice_ref ? (
            <div>
              <dt>Invoice</dt>
              <dd>{job.invoice_ref}</dd>
            </div>
          ) : null}
          {job.approved_by ? (
            <div>
              <dt>Approved by</dt>
              <dd>{job.approved_by}</dd>
            </div>
          ) : null}
        </dl>
      </article>

      <section className="p-panel">
        <h2>Description</h2>
        <p className="body">{job.description}</p>
      </section>

      {/* Assignment sits above the photographs because it is the action, not
          the record: a contractor opening this from a text message is here to
          accept, decline or say when they are coming. */}
      <JobAssignment
        jobId={job.id}
        assignment={{
          status: job.assignment_status,
          contractorName: job.contractor_name,
          assignedToName: job.assigned_to_name,
          assignedAt: job.assigned_at,
          acceptedAt: job.accepted_at,
          declinedAt: job.declined_at,
          declineReason: job.decline_reason,
          etaAt: job.eta_at,
        }}
        canAssign={staff}
        canAnswer={canAnswerOffer(actor)}
        contractors={scopes?.ok ? scopes.data.contractors : []}
        assignees={assignees}
      />

      {/* Thumbnails, uploads and the release queue: all of it needs the
          browser, because a signed URL cannot survive being rendered here. */}
      <JobAttachments
        jobId={job.id}
        attachments={attachments}
        canReview={canTriage(actor)}
      />

      {/* `quotes` is always [] for a contractor — the API does not run the query. */}
      {money && quotes.length ? (
        <section className="p-panel">
          <h2>Quotes</h2>
          <ul className="p-files">
            {quotes.map((quote) => (
              <li key={quote.id}>
                <strong>{formatMoney(quote.amount_pence)}</strong>
                <span className="chip chip--status">{quote.status}</span>
                {quote.description ? (
                  <span className="p-muted p-small">{quote.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="p-panel">
        <h2>Comments</h2>
        {comments.length === 0 ? (
          <p className="muted">No comments yet.</p>
        ) : (
          <ul className="p-thread">
            {comments.map((comment) => (
              <li key={comment.id}>
                <p className="who">
                  {comment.author_full_name ?? comment.author_name ?? "MAINTSUPP"}
                  {" · "}
                  {formatDateTime(comment.created_at) ?? "—"}
                  {comment.via_share_link ? " · via share link" : ""}
                </p>
                <p className="body">{comment.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <JobActions
        jobId={job.id}
        status={job.status}
        canChangeStatus={canChangeStatus(actor)}
      />
    </>
  );
}
