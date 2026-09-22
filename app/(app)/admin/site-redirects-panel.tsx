"use client";

/**
 * The website's redirects — old `/p/<slug>` addresses and where they now lead.
 *
 * Two kinds, shown together because a visitor cannot tell them apart:
 *
 *   - MOVED: written by the server when a page's address changes, so a link
 *     anyone saved to the old address keeps working.
 *   - MANUAL: added here by platform staff.
 *
 * Every rule lives on the server (`app/lib/cms-seo.ts`): a source must be a
 * `/p/` address, a target another `/p/` address or a page on maintsupp.com —
 * never another site — and a chain is collapsed and a loop refused before
 * anything is stored. This panel sends what was typed and prints the answer; a
 * refusal arrives as the server's own sentence.
 */

import { useState } from "react";

import { Icon } from "../../components";
import { adminWrite } from "../portal/views/admin-shell";
import { formatShortDateTime } from "../../lib/format-date";

export type SiteRedirect = {
  from: string;
  to: string;
  kind: "moved" | "manual";
  createdByEmail: string | null;
  createdAt: string;
};

export function SiteRedirectsPanel({
  redirects,
  onChanged,
  setFlash,
}: {
  redirects: SiteRedirect[];
  onChanged: () => Promise<void> | void;
  setFlash: (flash: { ok: boolean; message: string }) => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    const result = await adminWrite("/api/site-pages", "PUT", { redirect: { from: from.trim(), to: to.trim() } });
    setBusy(false);
    setFlash({ ok: result.ok, message: result.ok ? `${from.trim()} now redirects.` : result.message });
    if (result.ok) {
      setFrom("");
      setTo("");
      await onChanged();
    }
  };

  const remove = async (path: string) => {
    if (!window.confirm(`Remove the redirect from ${path}? That address will answer "page not found".`)) return;
    const result = await adminWrite(`/api/site-pages?redirect=${encodeURIComponent(path)}`, "DELETE");
    setFlash({ ok: result.ok, message: result.ok ? `Removed the redirect from ${path}.` : result.message });
    if (result.ok) await onChanged();
  };

  return (
    <div className="admin-panel cms-admin__redirects">
      <strong>Redirects</strong>
      <p>
        <small>
          An old address and where it now leads, answered with a permanent (308) redirect. A page that lives at an
          address always wins over a redirect from it.
        </small>
      </p>
      {redirects.length === 0 ? (
        <p>
          <small>No redirects yet. Moving a page adds one for its old address.</small>
        </p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>From</th>
              <th>To</th>
              <th>Why</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {redirects.map((entry) => (
              <tr key={entry.from}>
                <td>
                  <code>{entry.from}</code>
                </td>
                <td>
                  <code>{entry.to}</code>
                </td>
                <td>
                  <small>
                    {entry.kind === "moved" ? "Page moved" : "Added by hand"} · {formatShortDateTime(entry.createdAt)}
                    {entry.createdByEmail ? ` · ${entry.createdByEmail}` : ""}
                  </small>
                </td>
                <td>
                  <button
                    aria-label={`Remove the redirect from ${entry.from}`}
                    className="secondary-button admin-mini admin-mini--danger"
                    onClick={() => void remove(entry.from)}
                    type="button"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="cms-admin__redirect-form">
        <label className="admin-field">
          <span>From</span>
          <input onChange={(event) => setFrom(event.target.value)} placeholder="/p/old-page" value={from} />
          <small>An old website page address, /p/ and its name.</small>
        </label>
        <label className="admin-field">
          <span>To</span>
          <input onChange={(event) => setTo(event.target.value)} placeholder="/p/new-page" value={to} />
          <small>Another /p/ address, or a page on https://maintsupp.com. Never another site.</small>
        </label>
        <button
          className="secondary-button"
          disabled={busy || !from.trim() || !to.trim()}
          onClick={() => void add()}
          type="button"
        >
          <Icon name="plus" size={16} /> Add redirect
        </button>
      </div>
    </div>
  );
}
