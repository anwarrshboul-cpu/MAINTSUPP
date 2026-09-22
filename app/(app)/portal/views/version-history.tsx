"use client";

/**
 * §38 — A SETTING'S VERSION HISTORY, and the Restore button.
 *
 * One small component for every versioned setting (brand colours, portal
 * modules, the default sidebar, the default dashboards). Collapsed until
 * opened, so a Settings page does not read four histories on every visit.
 *
 * Restoring follows the owner's rule: nothing is removed from the history. The
 * button sends the version NUMBER to the setting's own save route (built by
 * `restoreRequest`), which loads that version server-side, applies today's
 * rules to it, and records the result as a new version "restored from vN".
 */

import { useEffect, useState } from "react";
import { restoreRequest, type VersionSubject } from "../../../lib/config-versions-model";
import { formatShortDateTime } from "../../../lib/format-date";
import "./version-history.css";

type VersionRow = {
  version: number;
  kind: "baseline" | "saved" | "restored" | "deleted" | "renamed";
  summary: string;
  restoredFromVersion: number | null;
  actorEmail: string | null;
  createdAt: string;
  current: boolean;
};

export function VersionHistory({
  subject,
  subjectKey,
  title = "Version history",
  onRestored,
}: {
  subject: VersionSubject;
  subjectKey: string;
  title?: string;
  /** Called after a successful restore — reload the panel, or the page. */
  onRestored?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<VersionRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/versions?subject=${subject}&key=${encodeURIComponent(subjectKey)}&limit=20`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        const payload = (await response.json()) as { versions?: VersionRow[]; hasMore?: boolean; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "The history could not be loaded.");
        if (!cancelled) {
          setRows(payload.versions ?? []);
          setHasMore(Boolean(payload.hasMore));
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "The history could not be loaded.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, subject, subjectKey, revision]);

  const older = async () => {
    const oldest = rows[rows.length - 1]?.version;
    if (!oldest) return;
    try {
      const response = await fetch(`/api/versions?subject=${subject}&key=${encodeURIComponent(subjectKey)}&limit=20&before=${oldest}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const payload = (await response.json()) as { versions?: VersionRow[]; hasMore?: boolean; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Older versions could not be loaded.");
      setRows((current) => [...current, ...(payload.versions ?? [])]);
      setHasMore(Boolean(payload.hasMore));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Older versions could not be loaded.");
    }
  };

  const restore = async (row: VersionRow) => {
    if (!window.confirm(`Restore version ${row.version}? Nothing is removed from the history — version ${row.version}'s state is saved as a new version.`)) return;
    setBusy(row.version);
    setError(null);
    try {
      const { url, body } = restoreRequest(subject, subjectKey, row.version);
      const response = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "That version could not be restored.");
      setRevision((current) => current + 1);
      onRestored?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That version could not be restored.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="version-history">
      <button type="button" className="version-history__toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        {open ? "Hide" : "Show"} {title.toLowerCase()}
      </button>
      {open && (
        <div className="version-history__body">
          {error && (
            <p className="version-history__error" role="alert">
              {error}
            </p>
          )}
          {!error && rows.length === 0 && (
            <p className="version-history__empty">No versions yet. The first save from now on records how it was, then what changed.</p>
          )}
          {rows.length > 0 && (
            <ol className="version-history__list">
              {rows.map((row) => (
                <li key={row.version} className="version-history__row">
                  <div>
                    <strong>Version {row.version}</strong>
                    {row.kind === "baseline" && <span className="version-history__badge">Baseline</span>}
                    {row.kind === "renamed" && <span className="version-history__badge">Moved</span>}
                    {row.restoredFromVersion && <span className="version-history__badge">Restored from v{row.restoredFromVersion}</span>}
                    {row.current && <span className="version-history__badge version-history__badge--current">Current</span>}
                    <small>
                      {formatShortDateTime(row.createdAt)}
                      {row.actorEmail ? ` · ${row.actorEmail}` : ""}
                    </small>
                    <span className="version-history__summary">{row.summary}</span>
                  </div>
                  {!row.current && row.kind !== "deleted" && row.kind !== "renamed" && (
                    <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void restore(row)}>
                      {busy === row.version ? "Restoring…" : "Restore"}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
          {hasMore && (
            <button type="button" className="version-history__more" onClick={() => void older()}>
              Show older versions
            </button>
          )}
        </div>
      )}
    </div>
  );
}
