"use client";

import { useState } from "react";
import "./contractor-app-invite.css";

type Invite = {
  url: string;
  message: string;
  whatsapp: string | null;
  sms: string | null;
  email: string | null;
};

/**
 * THE CONTRACTOR APP INVITE — one strip in the contractor drawer.
 *
 * "Send app link" asks POST /api/contractor/invites for a personal link
 * (/c/<token>) that signs this contractor in to the MAINTSUPP app with their
 * jobs only. The office sends it from its OWN WhatsApp, texts or email, so it
 * works today with no messaging provider connected.
 */
export function ContractorAppInvite({
  contractorId,
  contractorName,
  active,
}: {
  contractorId: string;
  contractorName: string;
  active: boolean;
}) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function create() {
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/contractor/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractorId }),
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<Invite> & { error?: string };
      if (!response.ok || !payload.url) throw new Error(payload.error ?? "The link could not be created.");
      setInvite(payload as Invite);
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : "The link could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.message);
      setNote("Copied — paste it into any message.");
    } catch {
      setNote(invite.url);
    }
  }

  if (!active) return null;

  return (
    <div className="contractor-app-invite">
      <div className="contractor-app-invite__text">
        <strong>MAINTSUPP app</strong>
        <span>
          {invite
            ? `Send ${contractorName} their link. It works for 14 days and shows only their jobs, without prices.`
            : "Give this contractor their own sign-in to see their jobs and get alerts."}
        </span>
      </div>
      <div className="contractor-app-invite__actions">
        {!invite ? (
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void create()}>
            {busy ? "Creating…" : "Send app link"}
          </button>
        ) : (
          <>
            {invite.whatsapp && (
              <a className="secondary-button" href={invite.whatsapp} target="_blank" rel="noreferrer">
                WhatsApp
              </a>
            )}
            {invite.sms && (
              <a className="secondary-button" href={invite.sms}>
                Text
              </a>
            )}
            {invite.email && (
              <a className="secondary-button" href={invite.email}>
                Email
              </a>
            )}
            <button type="button" className="secondary-button" onClick={() => void copy()}>
              Copy
            </button>
          </>
        )}
      </div>
      {note && (
        <p className="contractor-app-invite__note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
