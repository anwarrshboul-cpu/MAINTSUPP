"use client";

/**
 * "Invite to this board".
 *
 * A board has no membership of its own — everyone in the workspace can open
 * it — so the list is the workspace roster from `/api/board/members`, and
 * the note "Anyone at <org> can access this board" is the literal truth.
 * Inviting goes through `POST /api/auth/invitations`, the one writer of
 * invitations. That route now emails the invitation from admin@maintsupp.com
 * where email is configured, and answers with `delivery` saying whether it
 * did; the dialog repeats that sentence rather than assuming, and shows the
 * link once with Copy either way.
 *
 * All state lives in `InviteBody`, which the modal mounts only while open,
 * so each opening starts clean without an effect resetting anything.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ROLE_LABELS, assignableRoles, roleLabel } from "../../../lib/roles";
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

/*
 * The labels and the ordering are `roles.ts`'s. This file used to carry its own
 * three-role rank table, which is the kind of copy a fourth role is left out
 * of: `manager` would have been ranked 0 and never offered.
 */
const ROLE_LABEL: Record<string, string> = ROLE_LABELS;

/**
 * The roles a caller holding `granting` may hand out here — never above their
 * own, and never Owner: this dialog invites into THIS workspace, and an Owner
 * is appointed to a whole client company from Users & access.
 */
export function grantableRoles(granting: string | null): string[] {
  return assignableRoles(granting).filter((role) => role !== "owner");
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
  const [issued, setIssued] = useState<{
    email: string;
    role: string;
    url: string;
    delivery: { status: string; message: string } | null;
  } | null>(null);
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
    // One request per press; the server also refuses a duplicate invitation.
    if (busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const response = await fetch("/api/auth/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        /* The workspace this dialog is showing, named explicitly — the board
           lists `payload.organisation`, so that is where the person is being
           invited, whatever the session last selected. */
        body: JSON.stringify({ email: email.trim(), role, organisationId: payload?.organisation.id }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        inviteUrl?: string;
        delivery?: { status: string; message: string };
      };
      if (!response.ok || !body.inviteUrl) throw new Error(body.error || "The invitation could not be issued.");
      setIssued({ email: email.trim(), role, url: body.inviteUrl, delivery: body.delivery ?? null });
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
            Invitation for <strong>{issued.email}</strong> as {roleLabel(issued.role)}.
          </p>
          <code>{issued.url}</code>
          <div className="ba-invite__linkrow">
            <button type="button" className="ba-btn ba-btn--small" onClick={() => void copy()}>
              <ActionIcon name={copied ? "check" : "copy"} size={14} /> {copied ? "Copied" : "Copy link"}
            </button>
            {issued.delivery?.status === "sent" ? (
              <p>
                <strong>Emailed from admin@maintsupp.com.</strong> The link is here too.
              </p>
            ) : (
              <p>
                <strong>No email was sent.</strong> {issued.delivery?.message ?? "Share this link."}
              </p>
            )}
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
