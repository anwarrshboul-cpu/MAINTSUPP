"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../../components";
import {
  deviceUnlockAvailable,
  passkeysSupported,
  registerThisDevice,
  unlockLabel,
} from "../../../lib/passkey-client";
import { AccountCard, AccountEmpty, AccountError } from "./account-ui";

type Passkey = { id: string; name: string; createdAt: string; lastUsedAt: string | null };

function when(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * "Sign in with Face ID" — set up on this device, and the list of devices.
 *
 * Each device is its own passkey, made on that device: set up on the iPhone to
 * use Face ID on the iPhone. Removing one stops that device signing in with it;
 * the password keeps working throughout.
 */
export function AccountPasskeys() {
  const [list, setList] = useState<Passkey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [label, setLabel] = useState("Face ID");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/passkeys", { headers: { Accept: "application/json" } });
      const payload = (await response.json().catch(() => ({}))) as { passkeys?: Passkey[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Your Face ID devices could not be loaded.");
      setList(payload.passkeys ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your Face ID devices could not be loaded.");
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- both calls await an
     external answer (the server, the device) before touching state. */
  useEffect(() => {
    let active = true;
    void load();
    void deviceUnlockAvailable().then((ready) => {
      if (!active) return;
      setAvailable(ready);
      setLabel(unlockLabel());
    });
    return () => {
      active = false;
    };
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function add() {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const name = await registerThisDevice();
      setNote(`Done — ${name} is set up. Next time, tap “Sign in with ${label}” on the sign-in page.`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Face ID could not be set up.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setNote(null);
    try {
      await fetch(`/api/auth/passkeys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
      setNote("Removed. That device now signs in with the password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AccountCard
      title="Face ID & fingerprint sign-in"
      description="Sign in on this phone or computer without typing your password. Your face or fingerprint never leaves the device."
      aside={
        available ? (
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void add()}>
            <Icon name="shield" size={16} />
            {busy ? "Setting up…" : `Set up ${label} on this device`}
          </button>
        ) : undefined
      }
    >
      {error && <AccountError message={error} />}
      {note && <p className="account-note">{note}</p>}
      {available === false && (
        <p className="account-note">
          {passkeysSupported()
            ? "This device has no Face ID, fingerprint reader or Windows Hello set up. Open your account on your phone to set it up there."
            : "This browser can't use Face ID sign-in. Use Safari on iPhone or Chrome on Android."}
        </p>
      )}
      {list && list.length === 0 && (
        <AccountEmpty icon="shield" title="Not set up yet">
          Set it up on each phone or computer you sign in from.
        </AccountEmpty>
      )}
      {list && list.length > 0 && (
        <ul className="account-passkeys">
          {list.map((passkey) => (
            <li key={passkey.id}>
              <div>
                <strong>{passkey.name}</strong>
                <span>
                  Set up {when(passkey.createdAt)} · Last used {when(passkey.lastUsedAt)}
                </span>
              </div>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => void remove(passkey.id)}
                aria-label={`Remove Face ID sign-in for ${passkey.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </AccountCard>
  );
}
