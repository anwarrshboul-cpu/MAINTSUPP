"use client";

import { useEffect, useState } from "react";
import {
  alertSupport,
  alertsTurnedOff,
  currentSubscription,
  sendTestAlert,
  turnOffAlerts,
  turnOnAlerts,
} from "../../../lib/push-client";
import { AccountCard } from "./account-ui";

type State = "loading" | "on" | "off" | "blocked" | "needs-install" | "unsupported";

/**
 * Account → Phone alerts. Alerts are on by default (the dashboard asks once,
 * see alerts-prompt.tsx); this is where a person switches them off — or back
 * on — for the device in their hand.
 */
export function AccountAlerts() {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const support = alertSupport();
      let next: State;
      if (support !== "ready") next = support;
      else if (Notification.permission === "denied") next = "blocked";
      else if (alertsTurnedOff()) next = "off";
      else next = (await currentSubscription().catch(() => null)) ? "on" : "off";
      if (active) setState(next);
    })();
    return () => {
      active = false;
    };
  }, []);

  async function switchOn() {
    setBusy(true);
    setNote(null);
    try {
      await turnOnAlerts();
      setState("on");
      setNote("Alerts are on for this device.");
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : "Alerts could not be switched on.");
    } finally {
      setBusy(false);
    }
  }

  async function switchOff() {
    setBusy(true);
    try {
      await turnOffAlerts();
      setState("off");
      setNote("Alerts are off for this device.");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setNote((await sendTestAlert().catch(() => false)) ? "Test sent." : "The test could not be sent.");
  }

  return (
    <AccountCard
      title="Phone alerts"
      description="New jobs, status changes and updates on this device, with the MAINTSUPP sound while the app is open."
      aside={
        state === "on" ? (
          <>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void test()}>
              Send a test
            </button>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void switchOff()}>
              Turn off
            </button>
          </>
        ) : state === "off" ? (
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void switchOn()}>
            Turn on
          </button>
        ) : undefined
      }
    >
      <p className="account-note">
        {state === "loading"
          ? "Checking this device…"
          : state === "on"
            ? "On for this device."
            : state === "off"
              ? "Off for this device."
              : state === "blocked"
                ? "Blocked in this phone's settings. Allow notifications for MAINTSUPP in Settings, then come back."
                : state === "needs-install"
                  ? "On iPhone, alerts work in the MAINTSUPP app: open maintsupp.com/app in Safari and add it to your Home Screen."
                  : "This browser can't show alerts."}
      </p>
      {note && <p className="account-note">{note}</p>}
    </AccountCard>
  );
}
