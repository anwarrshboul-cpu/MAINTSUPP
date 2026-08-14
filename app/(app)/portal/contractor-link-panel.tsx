"use client";

import { useEffect, useState } from "react";
import { Icon } from "../../components";

type LinkRecord = {
  id: string;
  label: string | null;
  allowedKinds: string[];
  expiresAt: string;
  revokedAt: string | null;
  firstOpenedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  state: "sent" | "opened" | "expired" | "revoked";
};

type PendingEvidence = {
  id: string;
  name: string;
  kind: string;
  submittedVia: string | null;
  createdAt: string;
};

type Completion = {
  completionRequestedAt: string | null;
  completionRequestedBy: string | null;
  /** K — the mark, the name beside it, and the server's own timestamp. */
  completionSignature: string | null;
  completionSignedAt: string | null;
  completionSignedBy: string | null;
  completionNote: string | null;
  blockedReason: string | null;
} | null;

const STATE_LABEL: Record<LinkRecord["state"], string> = {
  sent: "Sent, not opened",
  opened: "Opened",
  expired: "Expired",
  revoked: "Revoked",
};

function formatDate(value: string | null) {
  if (!value) return "—";
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(when);
}

/**
 * Coordinator view of a job's contractor links — Group Z, item Z11.
 *
 * The generated URL is shown once. It is not stored in plaintext anywhere, so
 * if it is lost the only remedy is to issue a new one.
 */
export default function ContractorLinkPanel({
  requestId,
  reference,
  siteName,
}: {
  requestId: string;
  reference: string | null;
  siteName?: string | null;
}) {
  const [links, setLinks] = useState<LinkRecord[]>([]);
  const [pending, setPending] = useState<PendingEvidence[]>([]);
  const [completion, setCompletion] = useState<Completion>(null);
  const [issued, setIssued] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiryDays, setExpiryDays] = useState(14);
  const [label, setLabel] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/api/board/links?requestId=${encodeURIComponent(requestId)}`,
        );
        if (!response.ok) throw new Error("Links could not be loaded.");
        const payload = await response.json();
        if (cancelled) return;
        setLinks(payload.links ?? []);
        setPending(payload.pendingEvidence ?? []);
        setCompletion(payload.completion ?? null);
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Something went wrong.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId, refreshToken]);

  const refresh = () => setRefreshToken((token) => token + 1);

  async function generate() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const response = await fetch("/api/board/links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, expiryDays, label: label.trim() }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "The link could not be created.");
        return;
      }
      setIssued({ url: payload.url, expiresAt: payload.expiresAt });
      setLabel("");
      refresh();
    } catch {
      setError("The link could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/board/links?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function review(attachmentId: string, decision: "accept" | "reject") {
    setBusy(true);
    try {
      await fetch("/api/board/links", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attachmentId, decision }),
      });
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Could not copy. Select the link and copy it manually.");
    }
  }

  const shareText = [
    `Job ${reference ?? ""}`.trim(),
    siteName ? `at ${siteName}` : "",
    "— details and photo upload:",
    issued?.url ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className="link-panel">
      <header className="link-panel__intro">
        <h3>Contractor link</h3>
        <p className="muted">
          A single URL for this job. No login needed — the contractor sees the site,
          the fault and the photos, and uploads his evidence. He can request
          completion; you accept it.
        </p>
      </header>

      {error && (
        <p className="link-panel__error" role="alert">
          {error}
        </p>
      )}

      {completion?.completionRequestedAt && (
        <div className="link-panel__completion" role="status">
          <Icon name="check" size={16} />
          <div>
            <strong>Completion requested</strong> by{" "}
            {completion.completionRequestedBy ?? "the contractor"} on{" "}
            {formatDate(completion.completionRequestedAt)}.
            {completion.completionNote && <p>“{completion.completionNote}”</p>}
            {/*
              The signature where the decision is made.
              
              A coordinator accepting a completion is the person who needs to
              see who signed for it, and this panel is where they do that. The
              timestamp shown is the server's, recorded when the mark was made
              — not the date the contractor typed for when the work was done,
              which is a different fact and is on the line above.
            */}
            {completion.completionSignature && (
              <figure className="link-panel__signature">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={completion.completionSignature}
                  alt={`Signature of ${completion.completionSignedBy ?? "the contractor"}`}
                />
                <figcaption>
                  Signed by {completion.completionSignedBy ?? "the contractor"}
                  {completion.completionSignedAt
                    ? ` · ${formatDate(completion.completionSignedAt)}`
                    : ""}
                </figcaption>
              </figure>
            )}
          </div>
        </div>
      )}

      {completion?.blockedReason && (
        <div className="link-panel__blocked" role="status">
          <Icon name="alert" size={16} />
          <div>
            <strong>Could not complete:</strong> {completion.blockedReason}
            {completion.completionNote && <p>“{completion.completionNote}”</p>}
          </div>
        </div>
      )}

      {pending.length > 0 && (
        <div className="link-panel__pending">
          <h4>Evidence waiting for review ({pending.length})</h4>
          <ul>
            {pending.map((item) => (
              <li key={item.id}>
                <span className="link-panel__pending-name">
                  {item.name}
                  <em>{item.kind}</em>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void review(item.id, "accept")}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="is-destructive"
                  disabled={busy}
                  onClick={() => void review(item.id, "reject")}
                >
                  Reject
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {issued ? (
        <div className="link-panel__issued">
          <p className="link-panel__warning">
            <Icon name="alert" size={15} />
            This is shown once. Send it now — it cannot be retrieved later.
          </p>
          <input
            readOnly
            value={issued.url}
            aria-label="Contractor link"
            onFocus={(event) => event.target.select()}
          />
          <div className="link-panel__share">
            <a
              className="link-panel__whatsapp"
              href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="message" size={16} />
              Share on WhatsApp
            </a>
            <button type="button" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy link"}
            </button>
            <a
              href={`mailto:?subject=${encodeURIComponent(
                `Job ${reference ?? ""}`.trim(),
              )}&body=${encodeURIComponent(shareText)}`}
            >
              Email
            </a>
          </div>
          <p className="muted">Works until {formatDate(issued.expiresAt)}.</p>
        </div>
      ) : (
        <div className="link-panel__create">
          <label>
            Who is it for (optional)
            <input
              value={label}
              placeholder="e.g. Saed, 24 Shutter Repairs"
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label>
            Expires after
            <select
              value={expiryDays}
              onChange={(event) => setExpiryDays(Number(event.target.value))}
            >
              {[3, 7, 14, 30].map((days) => (
                <option key={days} value={days}>
                  {days} days
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void generate()}
          >
            Generate link
          </button>
        </div>
      )}

      {links.length > 0 && (
        <div className="link-panel__history">
          <h4>Links issued</h4>
          <ul>
            {links.map((link) => (
              <li key={link.id} className={`is-${link.state}`}>
                <span className="link-panel__state">{STATE_LABEL[link.state]}</span>
                <span className="link-panel__label">
                  {link.label ?? "Contractor"}
                  <em>
                    {link.useCount} use{link.useCount === 1 ? "" : "s"} · expires{" "}
                    {formatDate(link.expiresAt)}
                  </em>
                </span>
                {link.state !== "revoked" && link.state !== "expired" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revoke(link.id)}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
