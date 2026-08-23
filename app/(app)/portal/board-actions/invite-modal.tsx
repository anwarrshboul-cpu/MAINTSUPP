"use client";

/**
 * "Invite to this board".
 *
 * A board has no membership of its own — everyone in the workspace can open
 * it — so the list is the workspace roster from `/api/board/members`, and
 * the note "Anyone at <org> can access this board" is the literal truth.
 * Inviting goes through `POST /api/auth/invitations`, the one writer of
 * invitations; the link it returns is shown once with Copy, and the dialog
 * says in words that no email was sent, because none is.
 *
 * All state lives in `InviteBody`, which the modal mounts only while open,
 * so each opening starts clean without an effect resetting anything.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { copyBoardText } from "../board-export";
import { ActionIcon } from "./board-icons";
import { BoardModal } from "./board-modal";

type Member = {
  id: string;
  email: string;
  name: string;
  role: string;
  title: string | null;
  avatarColour: string | null;
  isMe: boolean;
};

type Pending = { id: string; email: string; role: string; expiresAt: string; createdAt: string };

type MembersPayload = {
  organisation: { id: string; name: string };
  members: Member[];
  pending: Pending[];
  canInvite: boolean;
  inviteAs: string | null;
  inviteNote: string | null;
  delivery: string;
};

const ROLE_RANK: Record<string, number> = { client: 1, admin: 2, super_admin: 3 };
const ROLE_LABEL: Record<string, string> = { client: "Client", admin: "Admin", super_admin: "Super admin" };

/** The roles a caller of rank `granting` may hand out — never above their own. */
export function grantableRoles(granting: string | null): string[] {
  const rank = granting ? ROLE_RANK[granting] ?? 0 : 0;
  return Object.keys(ROLE_RANK).filter((role) => ROLE_RANK[role] <= rank);
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?").toUpperCase() + (parts[1]?.[0] ?? "").toUpperCase();
}

function InviteBody({ onMembersChanged }: { onMembersChanged: () => void }) {
  const [payload, setPayload] = useState<MembersPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [email, setEmail] = useState("");
  const [chosenRole, setChosenRole] = useState("client");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ email: string; role: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/board/members");
      const body = (await response.json().catch(() => ({}))) as MembersPayload & { error?: string };
      if (!response.ok) throw new Error(body.error || "The member list could not be loaded.");
      setPayload(body);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The member list could not be loaded.");
    }
  }, []);

  // Deferred through a timer, as the loads in portal-app.tsx are.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const roles = useMemo(() => grantableRoles(payload?.inviteAs ?? null), [payload?.inviteAs]);
  // Never a role above the caller's own: the choice falls back to the lowest offered.
  const role = roles.includes(chosenRole) ? chosenRole : roles[0] ?? "client";

  const needle = query.trim().toLowerCase();
  const members = (payload?.members ?? []).filter(
    (member) => !needle || member.name.toLowerCase().includes(needle) || member.email.toLowerCase().includes(needle),
  );
  const pending = (payload?.pending ?? []).filter((entry) => !needle || entry.email.toLowerCase().includes(needle));

  const invite = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const response = await fetch("/api/auth/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; inviteUrl?: string };
      if (!response.ok || !body.inviteUrl) throw new Error(body.error || "The invitation could not be issued.");
      setIssued({ email: email.trim(), role, url: body.inviteUrl });
      setEmail("");
      await load();
      onMembersChanged();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "The invitation could not be issued.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!issued) return;
    try {
      await copyBoardText(issued.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setFormError("The clipboard is unavailable here — select the link and copy it.");
    }
  };

  return (
    <div className="ba-modal__body">
      {error && (
        <p className="ba-error" role="alert">
          {error}
        </p>
      )}
      {payload && (
        <p className="ba-invite__note">
          <ActionIcon name="shield" size={14} /> Anyone at <strong>{payload.organisation.name}</strong> can access this board.
        </p>
      )}

      <div className="ba-search">
        <ActionIcon name="search" size={16} />
        <input
          className="ba-input"
          type="search"
          placeholder="Search by name or email"
          aria-label="Search members by name or email"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {payload?.canInvite ? (
        <form
          className="ba-invite__form"
          onSubmit={(event) => {
            event.preventDefault();
            void invite();
          }}
        >
          <label className="ba-field">
            <span>Email address</span>
            <input
              className="ba-input"
              type="email"
              required
              value={email}
              placeholder="name@company.com"
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="ba-field">
            <span>Role</span>
            <select className="ba-select" value={role} onChange={(event) => setChosenRole(event.target.value)}>
              {roles.map((entry) => (
                <option key={entry} value={entry}>
                  {ROLE_LABEL[entry] ?? entry}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="ba-btn ba-btn--primary" disabled={busy || !email.trim()}>
            {busy ? "Inviting…" : "Invite"}
          </button>
        </form>
      ) : (
        payload && (
          <p className="ba-hint ba-invite__denied" role="note">
            <ActionIcon name="info" size={14} /> {payload.inviteNote ?? "Only admins can invite."}
          </p>
        )
      )}
      {formError && (
        <p className="ba-error" role="alert">
          {formError}
        </p>
      )}

      {issued && (
        <div className="ba-invite__link" role="status">
          <p>
            Invitation for <strong>{issued.email}</strong> as {ROLE_LABEL[issued.role] ?? issued.role}.
          </p>
          <code>{issued.url}</code>
          <div className="ba-invite__linkrow">
            <button type="button" className="ba-btn ba-btn--small" onClick={() => void copy()}>
              <ActionIcon name={copied ? "check" : "copy"} size={14} /> {copied ? "Copied" : "Copy link"}
            </button>
            <p>
              <strong>No email was sent.</strong> Share this link.
            </p>
          </div>
        </div>
      )}

      <section className="ba-invite__section" aria-label="Members">
        <h3>Members{payload ? ` · ${payload.members.length}` : ""}</h3>
        {!payload && !error && <p className="ba-hint">Loading members…</p>}
        {payload && members.length === 0 && <p className="ba-hint">Nobody matches that search.</p>}
        <ul className="ba-people">
          {members.map((member) => (
            <li key={member.id} className="ba-person">
              <span className="ba-person__avatar" style={member.avatarColour ? { background: member.avatarColour, color: "#fff" } : undefined} aria-hidden="true">
                {initials(member.name)}
              </span>
              <span className="ba-person__meta">
                <strong>
                  {member.name}
                  {member.isMe ? " (you)" : ""}
                </strong>
                <span>{[member.title, member.email].filter(Boolean).join(" · ")}</span>
              </span>
              <em className="ba-person__role">{ROLE_LABEL[member.role] ?? member.role}</em>
            </li>
          ))}
        </ul>
      </section>

      {payload && payload.pending.length > 0 && (
        <section className="ba-invite__section" aria-label="Pending invitations">
          <h3>Pending invitations · {payload.pending.length}</h3>
          <ul className="ba-people">
            {pending.map((entry) => (
              <li key={entry.id} className="ba-person">
                <span className="ba-person__avatar" aria-hidden="true">
                  <ActionIcon name="mail" size={16} />
                </span>
                <span className="ba-person__meta">
                  <strong>{entry.email}</strong>
                  <span>Invited {new Date(entry.createdAt).toLocaleDateString()} · expires {new Date(entry.expiresAt).toLocaleDateString()}</span>
                </span>
                <em className="ba-person__role">{ROLE_LABEL[entry.role] ?? entry.role}</em>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function InviteModal({
  open,
  onClose,
  onMembersChanged,
}: {
  open: boolean;
  onClose: () => void;
  onMembersChanged: () => void;
}) {
  return (
    <BoardModal open={open} onClose={onClose} title="Invite to this board" titleId="ba-invite-title" size="md" className="ba-invite">
      <InviteBody onMembersChanged={onMembersChanged} />
    </BoardModal>
  );
}
