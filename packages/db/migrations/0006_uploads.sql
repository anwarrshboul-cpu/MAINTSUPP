-- 0006 — uploads: staged bytes, integrity, and the intake photograph link.

/*
 * Bytes that exist before the row that owns them does.
 *
 * `attachments` enforces exactly one owner among job / job_request / site /
 * comment, and that constraint is right — an attachment with no defined owner
 * has no defined access rule. But the public intake form uploads its
 * photographs BEFORE the `job_requests` row exists: the form cannot be
 * submitted without pictures, and the pictures cannot be attached to a request
 * that has not been created yet.
 *
 * Rather than relax the constraint to allow an ownerless attachment — which
 * would make "which rows may this caller read" answerable only by inspecting
 * four nullable columns — the bytes land here first and are claimed into
 * `attachments` in the same transaction that inserts the request.
 *
 * The row is also what makes abandoned uploads findable. Somebody who uploads
 * three photographs and closes the tab leaves three objects in the bucket; with
 * a staging row a sweeper can delete them, and without one they are invisible
 * cost forever.
 */
create table if not exists pending_uploads (
  /*
   * The id IS the claim ticket handed back to the browser. It is
   * `gen_random_uuid()` — 122 bits of CSPRNG — so guessing another submitter's
   * ticket is the same hopeless proposition as guessing a share token. It is
   * checked against `claimed_at is null`, so a ticket works exactly once.
   */
  id uuid primary key default gen_random_uuid(),

  bucket_id text not null default 'job-media',
  object_key text not null unique,
  original_name text not null,
  content_type text not null,
  byte_size bigint not null check (byte_size > 0),
  -- Recorded from the bytes, not from the client's Content-Type header.
  sha256 text,
  kind attachment_kind not null default 'issue_picture',

  -- Hashed, like everywhere else: enough to spot one address flooding the
  -- endpoint, not a log of who photographed what from where.
  source_ip_hash text,

  claimed_at timestamptz,
  claimed_attachment_id uuid references attachments(id) on delete set null,
  created_at timestamptz not null default now()
);

/* The sweeper's index: unclaimed rows, oldest first. */
create index if not exists pending_uploads_unclaimed_idx
  on pending_uploads (created_at) where claimed_at is null;

/*
 * The bytes' fingerprint.
 *
 * An attachment is evidence — "pictures of completed works" is what a
 * contractor gets paid against and what a client disputes. A checksum recorded
 * at the moment of upload is what turns "this photograph was swapped" from an
 * argument into a comparison. It costs one sha-256 over data already in memory
 * (the S3 driver computes it anyway to sign the request).
 */
alter table attachments add column if not exists sha256 text;

/*
 * Intake photographs are read by the triage queue and by the conversion that
 * moves them onto the new job, both of which look them up by request.
 */
create index if not exists attachments_request_idx
  on attachments (job_request_id) where job_request_id is not null;

/*
 * `job_requests.photos` is deliberately NOT dropped.
 *
 * It stays as a denormalised mirror of the object keys attached to the request,
 * written in the same transaction as the attachment rows. Two reasons:
 *
 *   1. Rows already in it were written before attachments existed on this path.
 *      Dropping the column would erase the only record that those requests had
 *      photographs at all — and a request whose evidence vanished looks exactly
 *      like the abusive submission the 0003 comment says to keep.
 *   2. `jobs.ts` serves the triage queue straight out of it. Keeping the column
 *      correct means the intake work lands without a coordinated change to a
 *      route another agent may be editing.
 *
 * The attachments are the record; `photos` is the index into it.
 */
comment on column job_requests.photos is
  'Denormalised mirror of the object keys in attachments for this request. Written by the same transaction; attachments is the record of truth.';
