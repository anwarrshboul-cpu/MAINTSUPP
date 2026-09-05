"use client";

/**
 * The one button between an emailed link and a spent token.
 *
 * See `app/api/reminders/action/route.ts` for why this exists at all: mail
 * scanners fetch links before a human sees them, and a single-use token spent
 * by a scanner leaves the recipient with a dead link and the record claiming
 * they acknowledged something at three in the morning. The confirmation turns a
 * machine-followable GET into a deliberate POST.
 */

import { useState } from "react";
/*
 * Imported HERE and not from `page.tsx`, matching
 * `(public)/f/[token]/form-renderer.tsx`. A `?url` import of this file from
 * the server page is refused by the module runner with ERR_DENIED_ID; the
 * client component is the import site that works, and it is the one the
 * other public form already uses.
 */
import reminderActionCss from "./reminder-action.css?url";

const TITLES: Record<string, { heading: string; button: string; blurb: string }> = {
  ack: {
    heading: "Acknowledge this reminder",
    button: "Acknowledge",
    blurb:
      "This stops this reminder repeating. Later steps in the cascade will still be sent, so you will hear about it again as the date gets closer.",
  },
  snooze: {
    heading: "Snooze this reminder for 7 days",
    button: "Snooze 7 days",
    blurb: "The reminder will come back in a week. Nothing else changes.",
  },
  renew: {
    heading: "Mark this as renewed",
    button: "Mark renewed",
    blurb:
      "This cancels every outstanding reminder on the record. Only do this if the work has actually been done — you will be asked for the new certificate.",
  },
};

export default function ConfirmReminderAction({
  action,
  token,
}: {
  action: string;
  token: string;
}) {
  const copy = TITLES[action];
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");

  if (!copy) {
    return (
      <main className="reminder-action">
        <h1>That link is not one we recognise</h1>
        <p>Please use the buttons in the reminder email.</p>
      </main>
    );
  }

  async function confirm() {
    setState("sending");
    try {
      const response = await fetch("/api/reminders/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, email: email.trim() || undefined }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; message?: string }
        | null;
      setMessage(payload?.message ?? "The action could not be completed.");
      setState(payload?.ok ? "done" : "error");
    } catch {
      setMessage("The action could not be completed. Please check your connection and try again.");
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <main className="reminder-action">
        <h1>Done</h1>
        <p>{message}</p>
      </main>
    );
  }

  return (
    <main className="reminder-action">
      <link rel="stylesheet" href={reminderActionCss} />
      <h1>{copy.heading}</h1>
      <p>{copy.blurb}</p>
      <label className="reminder-action__field">
        <span>Your email address (optional)</span>
        {/*
          Recorded on the activity log so the record says who acted, not merely
          that somebody with the link did. It grants nothing — the token already
          carried the authority — which is why it is optional rather than a
          gate that would lock out the person the link was sent to.
        */}
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
        />
      </label>
      <button
        type="button"
        className="reminder-action__confirm"
        onClick={confirm}
        disabled={state === "sending"}
      >
        {state === "sending" ? "Working…" : copy.button}
      </button>
      {state === "error" ? (
        <p className="reminder-action__error" role="alert">
          {message}
        </p>
      ) : null}
    </main>
  );
}
