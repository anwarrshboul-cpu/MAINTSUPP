"use client";

import { useEffect, useState } from "react";
import {
  deviceUnlockAvailable,
  registerThisDevice,
  unlockLabel,
} from "../../lib/passkey-client";
import {
  alertPromptSnoozed,
  alertSupport,
  alertsTurnedOff,
  keepAlertsOn,
  snoozeAlertPrompt,
  turnOnAlerts,
} from "../../lib/push-client";
import "./alerts-prompt.css";

const FACE_ID_SNOOZE = "maintsupp:faceid-offer-snoozed-until";

function faceIdSnoozed() {
  try {
    return Number(window.localStorage.getItem(FACE_ID_SNOOZE) ?? 0) > Date.now();
  } catch {
    return true;
  }
}

function snoozeFaceId() {
  try {
    window.localStorage.setItem(FACE_ID_SNOOZE, String(Date.now() + 30 * 24 * 60 * 60 * 1000));
  } catch {
    /* Storage refused: asked again next visit, which is harmless. */
  }
}

type Offer = "face-id" | "alerts" | null;

/**
 * THE TWO ONE-TAP OFFERS, made where they are needed instead of in settings.
 *
 * Mounted on every signed-in dashboard page, one card at a time:
 *
 *   1. FACE ID FOR NEXT TIME — on a device with Face ID / a fingerprint and no
 *      MAINTSUPP passkey yet: "Sign in with Face ID next time? Turn on". One
 *      tap, then the phone's own Face ID check. Not again for 30 days after
 *      "Not now".
 *   2. ALERTS — on by default as far as a phone allows (app/lib/push-client.ts):
 *      already allowed → subscribed silently for this account; not yet asked →
 *      "Allow alerts"; switched off in Account or blocked → nothing.
 */
export default function AlertsPrompt() {
  const [offer, setOffer] = useState<Offer>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [label, setLabel] = useState("Face ID");

  useEffect(() => {
    let active = true;
    void (async () => {
      /* Alerts already allowed on this phone: tie them to this account now. */
      if (alertSupport() === "ready" && !alertsTurnedOff() && Notification.permission === "granted") {
        await keepAlertsOn();
      }

      if (!faceIdSnoozed() && (await deviceUnlockAvailable())) {
        const response = await fetch("/api/auth/passkeys").catch(() => null);
        const payload = response?.ok
          ? ((await response.json().catch(() => ({}))) as { passkeys?: unknown[] })
          : null;
        if (active && payload && Array.isArray(payload.passkeys) && payload.passkeys.length === 0) {
          setLabel(unlockLabel());
          setOffer("face-id");
          return;
        }
      }

      if (
        active &&
        alertSupport() === "ready" &&
        !alertsTurnedOff() &&
        Notification.permission === "default" &&
        !alertPromptSnoozed()
      ) {
        setOffer("alerts");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (!offer) return null;

  function next() {
    setMessage(null);
    if (
      offer === "face-id" &&
      alertSupport() === "ready" &&
      !alertsTurnedOff() &&
      Notification.permission === "default" &&
      !alertPromptSnoozed()
    ) {
      setOffer("alerts");
    } else {
      setOffer(null);
    }
  }

  async function accept() {
    setBusy(true);
    try {
      if (offer === "face-id") {
        await registerThisDevice();
        setMessage(`${label} is on. Next time, tap “Sign in with ${label}”.`);
      } else {
        await turnOnAlerts();
        setMessage("Alerts are on. You can switch them off in Account.");
      }
      window.setTimeout(next, 2500);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "That didn't work. Try again later.");
      window.setTimeout(next, 4000);
    } finally {
      setBusy(false);
    }
  }

  function later() {
    if (offer === "face-id") snoozeFaceId();
    else snoozeAlertPrompt();
    next();
  }

  const title = offer === "face-id" ? `Sign in with ${label} next time?` : "Get job alerts on this device";
  const detail =
    offer === "face-id"
      ? "No password to type. Your face or fingerprint never leaves the device."
      : "New jobs, status changes and updates — as they happen.";

  return (
    <div className="alerts-prompt" role="dialog" aria-label={title}>
      <p>
        <strong>{title}</strong>
        <span>{message ?? detail}</span>
      </p>
      {!message && (
        <div className="alerts-prompt__actions">
          <button type="button" className="alerts-prompt__allow" disabled={busy} onClick={() => void accept()}>
            {busy ? "…" : offer === "face-id" ? "Turn on" : "Allow alerts"}
          </button>
          <button type="button" className="alerts-prompt__later" onClick={later}>
            Not now
          </button>
        </div>
      )}
    </div>
  );
}
