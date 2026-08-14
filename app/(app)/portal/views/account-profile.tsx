"use client";

/**
 * My profile — monday's "My profile" screen.
 *
 * monday's has the person's details, a password change, and a security block
 * listing the sessions the account is signed in on with "log out of all other
 * sessions". All three are here, each against the row that actually stores it:
 *
 *   details  → users.full_name / job_title / phone / timezone / avatar_colour
 *   password → POST /api/auth/password, which the authentication work owns
 *   sessions → the `sessions` table, via /api/account/sessions
 *
 * Nothing is invented. The password form posts to a route that may not have
 * landed yet and reports that plainly; the session list is empty until sign-in
 * writes a row and says so rather than showing a plausible device.
 */

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../../components";
import type { AccountSnapshot } from "../account-menu";
import {
  AccountCard,
  AccountEmpty,
  AccountError,
  AccountField,
  AccountHeading,
  AccountLoading,
  formatMoment,
} from "./account-ui";

type SessionRow = {
  id: string;
  issuedAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  ipAddress: string | null;
  organisationId: string | null;
  device: string;
  expired: boolean;
};

/** A short, honest list of zones rather than the full IANA database. */
const TIMEZONES = [
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Lisbon",
  "Europe/Warsaw",
  "Europe/Athens",
  "Europe/Istanbul",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "UTC",
];

export function AccountProfilePanel({
  snapshot,
  onSnapshotChange,
  onNotify,
}: {
  snapshot: AccountSnapshot;
  onSnapshotChange: (next: AccountSnapshot) => void;
  onNotify: (message: string) => void;
}) {
  const profile = snapshot.profile;
  const [fullName, setFullName] = useState(profile.fullName ?? "");
  const [jobTitle, setJobTitle] = useState(profile.jobTitle ?? "");
  const [phone, setPhone] = useState(profile.phone ?? "");
  const [timezone, setTimezone] = useState(profile.timezone);
  const [avatarColour, setAvatarColour] = useState(profile.avatarColour ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);

  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [sessionNote, setSessionNote] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);

  const loadSessions = useCallback(async () => {
    try {
      const response = await fetch("/api/account/sessions", {
        headers: { Accept: "application/json" },
      });
      const payload = (await response.json()) as {
        sessions?: SessionRow[];
        note?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Sessions unavailable.");
      setSessions(payload.sessions ?? []);
      setSessionNote(payload.note ?? null);
    } catch (error) {
      setSessionError(
        error instanceof Error ? error.message : "Sessions could not be loaded.",
      );
    }
  }, []);

  useEffect(() => {
    // Deferred a tick, matching the portal's own loaders: the state lands from
    // the timer rather than synchronously inside the effect body.
    const timer = window.setTimeout(() => void loadSessions(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSessions]);

  const saveDetails = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName,
          jobTitle,
          phone,
          timezone,
          avatarColour,
        }),
      });
      const payload = (await response.json()) as {
        profile?: AccountSnapshot["profile"];
        error?: string;
      };
      if (!response.ok || !payload.profile) {
        throw new Error(payload.error || "Your details could not be saved.");
      }
      onSnapshotChange({ ...snapshot, profile: payload.profile });
      onNotify("Your details were saved.");
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Your details could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };

  /**
   * Password change. `/api/auth/password` is owned by the authentication work;
   * a 404 here means it has not shipped yet, and that is what the reader is
   * told. The form is never disabled on a guess about whether it exists.
   */
  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setPasswordMessage(null);
    if (newPassword !== confirmPassword) {
      setPasswordMessage("The new password and its confirmation do not match.");
      return;
    }
    setPasswordBusy(true);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (response.status === 404) {
        setPasswordMessage(
          "Password changes are not available yet — /api/auth/password has not shipped. Nothing was sent.",
        );
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "The password could not be changed.");
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordMessage("Your password was changed.");
      onNotify("Your password was changed.");
    } catch (error) {
      setPasswordMessage(
        error instanceof Error ? error.message : "The password could not be changed.",
      );
    } finally {
      setPasswordBusy(false);
    }
  };

  /**
   * Sign out everywhere. Two halves: `/api/account/sessions` revokes every
   * stored token (the load-bearing half, and the one this screen owns), then
   * `/api/auth/logout` clears the browser's own cookie when it exists.
   */
  const signOutEverywhere = async () => {
    setSessionBusy(true);
    try {
      const response = await fetch("/api/account/sessions", { method: "POST" });
      const payload = (await response.json()) as {
        revoked?: number;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "The sessions could not be revoked.");
      }
      await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
      await loadSessions();
      onNotify(
        payload.revoked
          ? `${payload.revoked} session${payload.revoked === 1 ? "" : "s"} revoked.`
          : "There were no active sessions to revoke.",
      );
    } catch (error) {
      setSessionError(
        error instanceof Error ? error.message : "The sessions could not be revoked.",
      );
    } finally {
      setSessionBusy(false);
    }
  };

  return (
    <>
      <AccountHeading
        eyebrow="Account"
        title="My profile"
        lede="Your details, your password and the devices this account is signed in on."
      />

      {!profile.exists && (
        <AccountCard tone="notice" title="No account record for this identity">
          <p className="account-note">
            The workspace resolved you as <code>{profile.email}</code>, but there is
            no row in <code>users</code> for that address, so there is nothing to
            save against. Sign in with a seeded account, or ask an administrator to
            invite this address.
          </p>
        </AccountCard>
      )}

      <AccountCard
        title="Your details"
        description="Saved to your own user record. Changing them here changes them everywhere your name appears."
      >
        <form className="account-form" onSubmit={saveDetails}>
          <div className="account-form__grid">
            <AccountField label="Full name">
              <input
                type="text"
                value={fullName}
                maxLength={120}
                disabled={!profile.exists}
                onChange={(event) => setFullName(event.target.value)}
              />
            </AccountField>
            <AccountField label="Email" hint="Your email is your identity and cannot be edited here.">
              <input type="email" value={profile.email} readOnly disabled />
            </AccountField>
            <AccountField label="Job title">
              <input
                type="text"
                value={jobTitle}
                maxLength={120}
                disabled={!profile.exists}
                onChange={(event) => setJobTitle(event.target.value)}
              />
            </AccountField>
            <AccountField label="Phone">
              <input
                type="tel"
                value={phone}
                maxLength={40}
                disabled={!profile.exists}
                onChange={(event) => setPhone(event.target.value)}
              />
            </AccountField>
            <AccountField
              label="Time zone"
              hint="Used when a date is shown to you rather than stored."
            >
              <select
                value={timezone}
                disabled={!profile.exists}
                onChange={(event) => setTimezone(event.target.value)}
              >
                {(TIMEZONES.includes(timezone)
                  ? TIMEZONES
                  : [timezone, ...TIMEZONES]
                ).map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </AccountField>
            <AccountField label="Role" hint="Set by your membership, not by you.">
              <input type="text" value={profile.role ?? "—"} readOnly disabled />
            </AccountField>
          </div>

          <fieldset className="account-swatches" disabled={!profile.exists}>
            <legend>Avatar colour</legend>
            <p className="account-note">
              Applied to your avatar in the account menu, top right. Save to see it.
            </p>
            <div>
              {snapshot.options.avatarColours.map((colour) => (
                <button
                  key={colour}
                  type="button"
                  className={avatarColour === colour ? "is-active" : ""}
                  style={{ background: colour }}
                  aria-label={`Use ${colour}`}
                  aria-pressed={avatarColour === colour}
                  onClick={() => setAvatarColour(colour)}
                />
              ))}
              <button
                type="button"
                className={`account-swatches__clear${avatarColour ? "" : " is-active"}`}
                aria-pressed={!avatarColour}
                onClick={() => setAvatarColour("")}
              >
                Default
              </button>
            </div>
          </fieldset>

          {saveError && <AccountError message={saveError} />}

          <div className="account-form__actions">
            <button
              className="primary-button"
              type="submit"
              disabled={saving || !profile.exists}
            >
              {saving ? "Saving…" : "Save details"}
            </button>
          </div>
        </form>
      </AccountCard>

      <AccountCard
        title="Password"
        description={
          profile.passwordUpdatedAt
            ? `Last changed ${formatMoment(profile.passwordUpdatedAt, profile.timezone)}.`
            : "This account has never set a password."
        }
      >
        <form className="account-form" onSubmit={changePassword}>
          <div className="account-form__grid">
            <AccountField label="Current password">
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </AccountField>
            <AccountField label="New password" hint="At least 12 characters.">
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </AccountField>
            <AccountField label="Confirm new password">
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </AccountField>
          </div>
          {passwordMessage && <p className="account-note">{passwordMessage}</p>}
          <div className="account-form__actions">
            <button
              className="secondary-button"
              type="submit"
              disabled={passwordBusy || !newPassword}
            >
              {passwordBusy ? "Changing…" : "Change password"}
            </button>
          </div>
        </form>
      </AccountCard>

      <AccountCard
        title="Active sessions"
        description="Every device holding a valid token for this account."
        aside={
          <button
            className="secondary-button"
            type="button"
            disabled={sessionBusy}
            onClick={() => void signOutEverywhere()}
          >
            <Icon name="shield" size={16} />
            {sessionBusy ? "Signing out…" : "Sign out everywhere"}
          </button>
        }
      >
        {sessionError && <AccountError message={sessionError} />}
        {sessions === null && !sessionError && <AccountLoading label="Reading sessions" />}
        {sessions?.length === 0 && (
          <AccountEmpty icon="shield" title="No active sessions">
            {sessionNote ??
              "Nothing has written a session row yet: this workspace still resolves identity from a cookie, so no token exists to list. Signing out everywhere is still safe to press — it revokes anything that is there."}
          </AccountEmpty>
        )}
        {sessions && sessions.length > 0 && (
          <div className="account-table-wrap">
            <table className="account-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Signed in</th>
                  <th>Last seen</th>
                  <th>Expires</th>
                  <th>Address</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td>{session.device}</td>
                    <td>{formatMoment(session.issuedAt, profile.timezone)}</td>
                    <td>{formatMoment(session.lastSeenAt, profile.timezone)}</td>
                    <td>
                      {formatMoment(session.expiresAt, profile.timezone)}
                      {session.expired && <span className="account-tag">Expired</span>}
                    </td>
                    <td>{session.ipAddress ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AccountCard>

      <AccountCard title="Account record">
        <dl className="account-definitions">
          <div>
            <dt>Created</dt>
            <dd>{formatMoment(profile.createdAt, profile.timezone)}</dd>
          </div>
          <div>
            <dt>Last sign-in</dt>
            <dd>{formatMoment(profile.lastLoginAt, profile.timezone)}</dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd>{snapshot.workspace.name}</dd>
          </div>
          <div>
            <dt>Working status</dt>
            <dd>
              {profile.workingStatus
                ? profile.workingStatus.replace(/_/g, " ")
                : "Not set"}
            </dd>
          </div>
        </dl>
      </AccountCard>
    </>
  );
}
