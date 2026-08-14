"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../../../lib/api";
import type { Setting } from "../../../../lib/portal";

/**
 * The switches, one row each.
 *
 * A boolean setting saves on change rather than behind a Save button: there is
 * one control and one decision, and a two-step commit for a single switch is
 * the pattern that leaves people unsure whether their change took. The row goes
 * disabled while the request is in flight and the server's answer is what
 * re-renders it — the value shown is always the value stored, never the value
 * this component hoped for.
 */
export default function SettingsForm({ settings }: { settings: Setting[] }) {
  const router = useRouter();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save(setting: Setting, next: boolean) {
    if (pendingKey) return;
    setPendingKey(setting.key);
    setError(null);
    setNotice(null);

    const result = await api(`/settings/${setting.key}`, {
      method: "POST",
      body: JSON.stringify({ value: next }),
    });
    setPendingKey(null);

    if (!result.ok) return setError(result.error);
    setNotice(`${setting.label} is now ${next ? "on" : "off"}.`);
    // Re-render from the server: the source badge and the audit trail below
    // both change with this write, and neither is derivable here.
    router.refresh();
  }

  return (
    <section className="p-panel">
      <div aria-live="polite" aria-atomic="true">
        {error ? (
          <p className="alert alert--bad" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className="alert alert--good">{notice}</p> : null}
      </div>

      {settings.map((setting) => {
        const on = setting.value === true;
        return (
          <div key={setting.key} style={{ marginTop: 8 }}>
            <h2 className="p-h1" style={{ fontSize: 16 }}>
              {setting.label}
            </h2>
            <p className="p-note" style={{ marginTop: 4 }}>
              {setting.description}
            </p>

            {setting.type === "boolean" ? (
              <div className="p-switch">
                <label className="p-check">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={pendingKey !== null}
                    onChange={(event) => save(setting, event.target.checked)}
                  />
                  {/* The state is spelled out. A tick box whose only signal is
                      its own tick is ambiguous the moment somebody is not sure
                      which way round the switch reads. */}
                  <span className="p-switch-state">
                    {pendingKey === setting.key ? "Saving…" : on ? "On" : "Off"}
                  </span>
                </label>
                <span className="p-source">
                  {setting.source === "database"
                    ? "set here"
                    : setting.source === "environment"
                      ? `from ${setting.envVar}`
                      : "default"}
                </span>
              </div>
            ) : null}

            <p className="p-note">
              {setting.source === "database" ? (
                <>
                  Last changed by {setting.updatedByEmail ?? "an account since removed"}
                  {setting.updatedAt ? ` on ${setting.updatedAt.slice(0, 10)}` : ""}.
                  {setting.envVar && setting.envValue !== null ? (
                    <>
                      {" "}
                      The server still sets <code>{setting.envVar}</code> to{" "}
                      <code>{setting.envValue}</code>; your choice here overrides it.
                    </>
                  ) : null}
                </>
              ) : setting.source === "environment" ? (
                <>
                  Nobody has set this in the portal, so the server’s{" "}
                  <code>{setting.envVar}</code> decides. Change it here and this
                  becomes the account’s answer for good.
                </>
              ) : (
                <>Nobody has changed this — it is the product’s default.</>
              )}
            </p>
          </div>
        );
      })}
    </section>
  );
}
