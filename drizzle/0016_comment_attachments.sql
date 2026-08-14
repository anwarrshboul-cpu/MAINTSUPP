-- A file attached to a comment, rather than loosely to the job.
--
-- monday's updates carry their own assets — a quote PDF, a photo of the part —
-- and they belong to the comment. Without this the file has nowhere to hang,
-- and several imported comments read as orphans: the body names a document
-- ("Pro forma-0005585.pdf") that appears nowhere on screen.
--
-- NULL is the ordinary case: a file attached to the job itself.
ALTER TABLE attachments ADD COLUMN update_id TEXT;

CREATE INDEX IF NOT EXISTS attachments_update_idx ON attachments(update_id);
