"use client";

import { useEffect, useState } from "react";
import { askAlertPermissionNow } from "../../../lib/push-client";

/**
 * Signs the contractor in the moment the link opens, then offers ONE button —
 * "Open my jobs" — whose tap also carries the phone's one-time alerts Allow.
 */
export default function AcceptInvite({ token }: { token: string }) {
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      const response = await fetch("/api/contractor/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, remember: true }),
      }).catch(() => null);
      const payload = response ? ((await response.json().catch(() => ({}))) as { name?: string; error?: string }) : {};
      if (!active) return;
      if (response?.ok) {
        setName(payload.name ?? "");
        setState("done");
      } else {
        setMessage(payload.error ?? "This link didn't work. Ask your coordinator for a new one.");
        setState("failed");
      }
    })();
    return () => {
      active = false;
    };
  }, [token]);

  return (
    <main className="mapp ctr">
      <section className="mapp__card ctr__welcome">
        {state === "working" && <p className="mapp__muted">Signing you in…</p>}
        {state === "done" && (
          <>
            <h1 className="ctr__title">You&rsquo;re in{name ? `, ${name}` : ""}</h1>
            <p className="mapp__muted">Your MAINTSUPP jobs are ready. You&rsquo;ll stay signed in on this phone.</p>
            <button
              type="button"
              className="mapp__btn mapp__btn--big"
              onClick={() => {
                void askAlertPermissionNow();
                window.location.href = "/contractor";
              }}
            >
              Open my jobs
            </button>
            <a className="mapp__skip" href="/app">
              Add MAINTSUPP to your home screen
            </a>
          </>
        )}
        {state === "failed" && (
          <>
            <h1 className="ctr__title">Link expired</h1>
            <p className="mapp__error">{message}</p>
            <a className="mapp__btn mapp__btn--ghost" href="/contractor">
              Sign in with a code instead
            </a>
          </>
        )}
      </section>
    </main>
  );
}
