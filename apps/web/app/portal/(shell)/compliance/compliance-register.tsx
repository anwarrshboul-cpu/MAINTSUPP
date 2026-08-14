"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../../../lib/api";
import { acceptAttribute, uploadFile, useUploadLimits } from "../../../../lib/uploads";
import { SignedFileButton } from "../../../../components/signed-media";
import {
  complianceChipClass,
  formatDate,
  type ComplianceRow,
  type ComplianceSiteDetail,
  type ComplianceSiteRow,
} from "../../../../lib/portal";

/**
 * The store register: one store at a time, every requirement it is measured on.
 *
 * WHY A CLIENT COMPONENT. Three of the four things this screen does are writes —
 * record an expiry, mark a requirement not required, upload the certificate —
 * and each of them moves the score. Nothing here patches a number locally: every
 * write re-reads `/compliance/site/:id` for the panel and calls
 * `router.refresh()` for the server-rendered score and calendar above, because
 * whether a certificate counts as in date is the API's answer to give and not a
 * calculation worth having in two places.
 *
 * WHY THE DETAIL IS FETCHED ON DEMAND. Twenty-one stores times twelve
 * requirements is 252 rows, most of which nobody is looking at. The overview
 * carries the counts, which is what the table needs; the rows arrive when a
 * store is opened.
 */

/** Every store's score, stated as its fraction rather than as a bare percent. */
function scoreLine(site: ComplianceSiteRow): string {
  const { score } = site;
  if (score.percent === null) return "nothing required";
  return `${score.inDate}/${score.required}`;
}

export default function ComplianceRegister({
  sites,
  requirementCount,
  expiringWithinDays,
  canManage,
}: {
  sites: ComplianceSiteRow[];
  requirementCount: number;
  expiringWithinDays: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const [openSite, setOpenSite] = useState<string | null>(null);
  const [detail, setDetail] = useState<ComplianceSiteDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (siteId: string) => {
    setLoading(true);
    setError(null);
    const result = await api<ComplianceSiteDetail>(`/compliance/site/${siteId}`);
    setLoading(false);
    if (!result.ok) {
      setDetail(null);
      setError(result.error);
      return;
    }
    setDetail(result.data);
  }, []);

  /**
   * Opening a store loads its rows; closing one drops them.
   *
   * Done in the handler rather than in an effect keyed on the selection: the
   * fetch is a response to a click, not a synchronisation with an external
   * system, and an effect would re-run it on every unrelated re-render of this
   * component.
   */
  async function toggle(siteId: string) {
    setNotice(null);
    setError(null);
    if (openSite === siteId) {
      setOpenSite(null);
      setDetail(null);
      return;
    }
    setOpenSite(siteId);
    setDetail(null);
    await load(siteId);
  }

  /** Any write: run it, say what happened, then re-read rather than guess. */
  async function after(
    action: Promise<{ ok: boolean; error?: string }>,
    success: string,
  ) {
    setError(null);
    setNotice(null);
    const result = await action;
    if (!result.ok) {
      setError(result.error ?? "Something went wrong.");
      return false;
    }
    setNotice(success);
    if (openSite) await load(openSite);
    // The score and the calendar are server-rendered a component above this one.
    router.refresh();
    return true;
  }

  return (
    <>
      <div className="p-tablewrap">
        <table className="p-table">
          <thead>
            <tr>
              <th className="p-sticky">Store</th>
              <th className="p-num">In date</th>
              <th className="p-num">Expired</th>
              <th className="p-num">Missing</th>
              <th className="p-num">Not required</th>
              <th>Next expiry</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => (
              <tr key={site.id}>
                <th scope="row" className="p-sticky">
                  {site.name}
                </th>
                {/* The fraction, not the percentage: "9/11" cannot be misread
                    when the denominator changes, and "82%" can. */}
                <td className="p-num p-mono">{scoreLine(site)}</td>
                <td className="p-num p-mono">
                  {site.score.expired > 0 ? (
                    <span className="p-bad">{site.score.expired}</span>
                  ) : (
                    "0"
                  )}
                </td>
                <td className="p-num p-mono">{site.score.missing}</td>
                <td className="p-num p-mono">{site.score.notRequired}</td>
                <td className="p-mono">{formatDate(site.nextExpiry) ?? "—"}</td>
                <td>
                  <button
                    type="button"
                    /* Full height, not `p-btn--sm`: this is the row's primary
                       control on a phone, not a confirming button tucked under
                       a thumbnail. */
                    className="p-btn p-btn--ghost"
                    aria-expanded={openSite === site.id}
                    onClick={() => toggle(site.id)}
                  >
                    {openSite === site.id ? "Close" : "Open"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="p-note">
        Every store is measured against the same {requirementCount} documents.
        &ldquo;In date&rdquo; counts Valid and Expiring; the denominator is that
        list minus anything marked not required.
      </p>

      <div aria-live="polite" aria-atomic="true">
        {error ? (
          <p className="alert alert--bad" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className="alert alert--good">{notice}</p> : null}
      </div>

      {openSite && loading && !detail ? (
        <p className="p-note">Loading…</p>
      ) : null}

      {detail ? (
        <section className="p-panel" style={{ marginTop: 12 }}>
          <div className="p-section-head">
            <h2>{detail.site.name}</h2>
            <span className="p-muted p-small">
              {detail.score.percent === null
                ? "nothing required"
                : `${detail.score.percent}% · ${detail.score.inDate} of ${detail.score.required} in date`}
              {detail.score.notRequired > 0
                ? ` · ${detail.score.notRequired} not required, excluded`
                : ""}
            </span>
          </div>

          <ul className="p-list">
            {detail.requirements.map((row) => (
              <Requirement
                /*
                 * The key carries the server's values, so a row whose date or
                 * reason changed comes back as a NEW component with fresh
                 * inputs. That is React's own answer to "reset state when a
                 * prop changes", and it replaces a pair of effects that copied
                 * props into state on every render.
                 */
                key={`${row.kind}:${row.expiry_date ?? ""}:${row.not_required_reason ?? ""}:${row.attachment_id ?? ""}`}
                row={row}
                siteId={detail.site.id}
                canManage={detail.canManage && canManage}
                expiringWithinDays={expiringWithinDays}
                onWrite={after}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------- one row -- */

function Requirement({
  row,
  siteId,
  canManage,
  expiringWithinDays,
  onWrite,
}: {
  row: ComplianceRow;
  siteId: string;
  canManage: boolean;
  expiringWithinDays: number;
  onWrite: (
    action: Promise<{ ok: boolean; error?: string }>,
    success: string,
  ) => Promise<boolean>;
}) {
  const limits = useUploadLimits();
  const [expiry, setExpiry] = useState(row.expiry_date ?? "");
  const [reason, setReason] = useState(row.not_required_reason ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const base = `/compliance/site/${siteId}/${row.kind}`;

  const run = async (
    key: string,
    action: () => Promise<{ ok: boolean; error?: string }>,
    success: string,
  ) => {
    if (busy) return;
    setBusy(key);
    await onWrite(action(), success);
    setBusy(null);
  };

  return (
    <li className="p-row">
      <div className="p-row-head">
        <h3>{row.label}</h3>
        <span className={complianceChipClass(row.status)}>{row.status}</span>
        <span className="p-row-when">
          {/* A not-required row is not waiting for a date, so it does not get
              told off for missing one — the reason line below says what it is
              instead. */}
          {row.not_required
            ? "excluded"
            : row.expiry_date
              ? `${formatDate(row.expiry_date)}${
                  row.days_left !== null
                    ? row.days_left < 0
                      ? ` · ${Math.abs(row.days_left)} days ago`
                      : ` · ${row.days_left} days`
                    : ""
                }`
              : row.expires
                ? "no date recorded"
                : "no expiry"}
        </span>
      </div>

      {row.not_required && row.not_required_reason ? (
        <p className="p-small p-muted">
          Not required — {row.not_required_reason}. Excluded from this
          store&rsquo;s count.
        </p>
      ) : null}

      {row.attachment_id ? (
        <ul className="p-files">
          <li>
            <span>{row.original_name}</span>
            <span className="p-muted p-small">
              added {formatDate(row.uploaded_at) ?? "—"}
            </span>
            {/* Minted on the click: a five-minute signed URL rendered into the
                page is dead before anybody scrolls to it. */}
            <SignedFileButton
              path={`/uploads/${row.attachment_id}/url`}
              name={row.original_name ?? "certificate"}
              size="md"
            />
          </li>
        </ul>
      ) : (
        <p className="p-small p-muted">No certificate on file.</p>
      )}

      {row.previous.length > 0 ? (
        <details>
          <summary className="p-small p-muted" style={{ minHeight: 44, display: "flex", alignItems: "center" }}>
            {row.previous.length} superseded{" "}
            {row.previous.length === 1 ? "copy" : "copies"}
          </summary>
          <ul className="p-files">
            {row.previous.map((old) => (
              <li key={old.id}>
                <span>{old.original_name}</span>
                <span className="p-muted p-small">{formatDate(old.created_at)}</span>
                <SignedFileButton
                  path={`/uploads/${old.id}/url`}
                  name={old.original_name}
                  size="md"
                />
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {!canManage ? null : (
        <>
          <div className="p-grid2">
            {row.expires ? (
              <label className="p-field">
                <span>Expiry date</span>
                <input
                  className="p-input"
                  type="date"
                  value={expiry}
                  disabled={busy !== null}
                  onChange={(event) => setExpiry(event.target.value)}
                />
              </label>
            ) : (
              <p className="p-small p-muted">
                This document carries no expiry date, so it is counted on whether
                it is on file — not on a date that could be missing.
              </p>
            )}

            <label className="p-field">
              <span>Certificate</span>
              <input
                className="p-input"
                type="file"
                accept={acceptAttribute(limits)}
                disabled={busy !== null}
                onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
              />
            </label>
          </div>

          <div className="p-btnrow" style={{ marginTop: 10 }}>
            {row.expires ? (
              <button
                type="button"
                className="p-btn p-btn--ghost"
                disabled={busy !== null}
                onClick={() =>
                  run(
                    "expiry",
                    () =>
                      api(`${base}/expiry`, {
                        method: "POST",
                        body: JSON.stringify({ expiryDate: expiry || null }),
                      }),
                    expiry
                      ? `${row.label} expiry saved.`
                      : `${row.label} expiry cleared — it counts as missing again.`,
                  )
                }
              >
                {busy === "expiry" ? "Saving…" : "Save date"}
              </button>
            ) : null}

            <button
              type="button"
              className="p-btn"
              disabled={busy !== null || !file}
              onClick={() =>
                run(
                  "upload",
                  () =>
                    uploadFile(`${base}/certificate`, file as File, {
                      // Sent with the file: "upload it" and "say when it runs
                      // out" are one action, and splitting them is how a
                      // certificate lands on file with no date.
                      ...(row.expires && expiry ? { expiryDate: expiry } : {}),
                    }),
                  `${row.label} uploaded.`,
                )
              }
            >
              {busy === "upload" ? "Uploading…" : "Upload certificate"}
            </button>
          </div>

          {row.not_required ? (
            <div className="p-btnrow" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="p-btn p-btn--ghost"
                disabled={busy !== null}
                onClick={() =>
                  run(
                    "required",
                    () => api(`${base}/required`, { method: "POST" }),
                    `${row.label} is required again and back in the count.`,
                  )
                }
              >
                {busy === "required" ? "Saving…" : "Mark as required again"}
              </button>
            </div>
          ) : (
            <div className="p-grid2" style={{ marginTop: 8 }}>
              <label className="p-field">
                <span>Not required because</span>
                <input
                  className="p-input"
                  type="text"
                  value={reason}
                  maxLength={300}
                  placeholder="No sprinkler system in this unit"
                  disabled={busy !== null}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <div className="p-field">
                <span>&nbsp;</span>
                <button
                  type="button"
                  className="p-btn p-btn--ghost"
                  disabled={busy !== null || reason.trim().length === 0}
                  onClick={() =>
                    run(
                      "not-required",
                      () =>
                        api(`${base}/not-required`, {
                          method: "POST",
                          body: JSON.stringify({ reason }),
                        }),
                      `${row.label} marked not required and removed from the denominator.`,
                    )
                  }
                >
                  {busy === "not-required" ? "Saving…" : "Mark not required"}
                </button>
              </div>
            </div>
          )}

          {row.status === "Expiring" ? (
            <p className="p-note">
              Expires within {expiringWithinDays} days. It still counts as in
              date until the day it lapses.
            </p>
          ) : null}
        </>
      )}
    </li>
  );
}
