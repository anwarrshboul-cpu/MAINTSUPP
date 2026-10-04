"use client";

import { useEffect, useState } from "react";
import { useCapability } from "../../../lib/client-capabilities";
import { AccountCard } from "./account-ui";
import "./account-announcements.css";

type Audience = "clients" | "contractors" | "both";
type Reach = Record<Audience, number>;

const AUDIENCES: { key: Audience; label: string; hint: string }[] = [
  { key: "clients", label: "Clients", hint: "Everyone signed in to the portal app" },
  { key: "contractors", label: "Contractors", hint: "The contractor app and job-link phones" },
  { key: "both", label: "Both", hint: "Clients and contractors" },
];

/**
 * ANNOUNCEMENTS — a phone alert to every client, every contractor, or both
 * (owner, 2026-10-04). Owner and Admin only (`settings.edit`); sent through
 * /api/push/announce, which counts and re-checks every recipient itself.
 */
export function AccountAnnouncements() {
  const allowed = useCapability("settings.edit");
  const [reach, setReach] = useState<Reach | null>(null);
  const [configured, setConfigured] = useState(true);
  const [audience, setAudience] = useState<Audience>("both");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const response = await fetch("/api/push/announce", { headers: { Accept: "application/json" } });
    if (!response.ok) return;
    const payload = (await response.json().catch(() => null)) as { configured?: boolean; reach?: Reach } | null;
    if (payload?.reach) setReach(payload.reach);
    setConfigured(payload?.configured !== false);
  }

  useEffect(() => {
    if (!allowed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading the server's reach counts once the capability is known
    void load().catch(() => {});
  }, [allowed]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const response = await fetch("/api/push/announce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audience, title, body }),
      });
      const payload = (await response.json().catch(() => ({}))) as { sent?: number; devices?: number; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The announcement could not be sent.");
      setNote(`Sent to ${payload.sent ?? 0} of ${payload.devices ?? 0} phones.`);
      setTitle("");
      setBody("");
      void load().catch(() => {});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The announcement could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) return null;

  const count = reach ? reach[audience] : null;

  return (
    <AccountCard
      title="Send an announcement"
      description="A phone alert, with the MAINTSUPP sound, to everyone who has the app and alerts switched on."
    >
      {!configured ? (
        <p className="account-note">Phone alerts are not set up on this server.</p>
      ) : (
        <form className="announce" onSubmit={send}>
          <fieldset className="announce__audience">
            <legend>Send to</legend>
            {AUDIENCES.map((option) => (
              <label key={option.key} className={audience === option.key ? "is-on" : undefined}>
                <input
                  type="radio"
                  name="announce-audience"
                  value={option.key}
                  checked={audience === option.key}
                  onChange={() => setAudience(option.key)}
                />
                <strong>{option.label}</strong>
                <span>
                  {option.hint}
                  {reach ? ` · ${reach[option.key]} ${reach[option.key] === 1 ? "phone" : "phones"}` : ""}
                </span>
              </label>
            ))}
          </fieldset>
          <label className="announce__field">
            Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} required />
          </label>
          <label className="announce__field">
            Message
            <textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={240} rows={3} required />
            <span className="announce__count">{body.length}/240</span>
          </label>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !title.trim() || !body.trim() || count === 0}
          >
            {busy ? "Sending…" : count === 0 ? "No phones to send to yet" : `Send to ${count ?? ""} ${count === 1 ? "phone" : "phones"}`}
          </button>
          {note && (
            <p className="account-note" role="status">
              {note}
            </p>
          )}
          {error && (
            <p className="account-note announce__error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </AccountCard>
  );
}
