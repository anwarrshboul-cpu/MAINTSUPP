import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewerState, serverFetch } from "../../../../lib/session";
import {
  canManageSettings,
  formatDateTime,
  type Setting,
  type SettingAuditEntry,
} from "../../../../lib/portal";
import SettingsForm from "./settings-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Settings" };

/** `true`/`false`/`null` as words, since the trail stores raw JSON values. */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) return "not set";
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

export default async function SettingsPage() {
  const state = await getViewerState();
  if (state.kind !== "ok") return null;
  /*
   * Presentation only — `/settings` refuses everybody but the owner, and would
   * do so if this line were deleted. It exists so a super_admin who guesses the
   * URL gets the board rather than an error box, which is a better answer to
   * "this page is not yours" than a 403 rendered as a broken screen.
   */
  if (!canManageSettings(state.viewer.actor)) redirect("/portal/dashboard");

  const [list, trail] = await Promise.all([
    serverFetch<{ settings: Setting[] }>("/settings"),
    serverFetch<{ entries: SettingAuditEntry[] }>("/settings/audit?limit=20"),
  ]);

  if (!list.ok) {
    return (
      <div className="card card--empty">
        <h1>Settings</h1>
        <p className="muted">{list.error}</p>
      </div>
    );
  }

  const entries = trail.ok ? trail.data.entries : [];

  return (
    <>
      <h1 className="p-h1">Settings</h1>
      <p className="p-lede">
        Account-level switches. Only the owner account can see or change these,
        and every change is recorded below.
      </p>

      <SettingsForm settings={list.data.settings} />

      <section className="p-section">
        <div className="p-section-head">
          <h2>What has been changed</h2>
        </div>

        <div className="p-panel">
          {entries.length ? (
            <ul className="p-thread">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <p style={{ margin: 0 }}>
                    <strong>{entry.changed_by_email}</strong> set{" "}
                    <span className="p-mono">{entry.key}</span> to{" "}
                    <strong>{describeValue(entry.new_value)}</strong>
                    {/* Null means there was no row before, which is not the
                        same history as "it was already off" — the trail says
                        so rather than inventing a previous value. */}
                    {entry.old_value === null
                      ? " (it had never been set in the portal)"
                      : `, from ${describeValue(entry.old_value)}`}
                    .
                  </p>
                  <p className="p-note" style={{ marginTop: 2 }}>
                    {formatDateTime(entry.created_at) ?? entry.created_at}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-note" style={{ marginTop: 0 }}>
              Nothing has been changed yet. Until a switch is touched here, the
              server’s environment decides — and that is what the badge above
              each switch is telling you.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
