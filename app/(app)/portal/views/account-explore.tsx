"use client";

/**
 * The Explore column's screens: Mobile access, Beta features, Shortcuts,
 * Invite members, Get help and Change theme.
 *
 * monday's equivalents are Mobile app, monday.labs, Shortcuts, Invite members,
 * Get help and Change theme. Two of them are where the temptation to invent is
 * strongest, and both are answered from the code instead:
 *
 *   Shortcuts — every row is a key handler that exists in this repository. The
 *   list was read out of the components, not imagined; a shortcut nobody
 *   implemented is not on it.
 *
 *   Change theme — the picker offers all three, and System is the default: the
 *   choice lives in `localStorage` and is applied before first paint by the
 *   boot script, so this panel reads the shared store in `theme.ts` rather than
 *   the account row. `users.theme_preference` is still written, as the record
 *   of what was chosen; it is not what decides how a browser paints.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "../../../components";
import type { AccountSnapshot } from "../account-menu";
import {
  AccountCard,
  AccountError,
  AccountHeading,
  AccountLoading,
  AccountStatus,
} from "./account-ui";
import {
  type ThemeChoice,
  setThemeChoice,
  useResolvedTheme,
  useThemeChoice,
} from "../theme";

/* ── Mobile access ──────────────────────────────────────────────────────── */

export function AccountMobilePanel() {
  return (
    <>
      <AccountHeading
        eyebrow="Explore"
        title="Mobile access"
        lede="monday has native apps to download. MAINTSUPP has none — what it has is a layout built for a phone and two entry points that work without an account at all."
      />

      <AccountCard tone="notice" title="There is no app to install">
        <p className="account-note">
          No iOS or Android build exists, and there is no web app manifest, so the
          browser will not offer to add this to a home screen either. Pointing you
          at an app store would be pointing at nothing. What follows is what does
          work on a phone today.
        </p>
      </AccountCard>

      <AccountCard
        title="The dashboard on a phone"
        description="Below 760px the portal switches to its own layout: a compact top bar, a slide-over navigation with a scrim, larger tap targets and full-width panels."
      >
        <dl className="account-definitions">
          <div>
            <dt>Address</dt>
            <dd>
              This same address, at <code>/dashboard</code>.
            </dd>
          </div>
          <div>
            <dt>Sign-in</dt>
            <dd>The same as on a desktop — this is the same application.</dd>
          </div>
          <div>
            <dt>Add to home screen</dt>
            <dd>
              Use your browser&rsquo;s own &ldquo;Add to home screen&rdquo;. It will
              open as a normal tab: without a manifest there is no standalone mode.
            </dd>
          </div>
        </dl>
      </AccountCard>

      <AccountCard
        title="What a contractor uses instead"
        description="Neither of these needs an account, which is the point: the person on site is not a member of the workspace."
      >
        <div className="account-list">
          <div className="account-list__row">
            <div>
              <strong>Contractor job link</strong>
              <span>
                A scoped, expiring link to one job. Opens on any phone, allows
                photos, comments and a completion request — nothing else.
              </span>
            </div>
            <Link className="secondary-button" href="/dashboard/jobs">
              Issue a link
            </Link>
          </div>
          <div className="account-list__row">
            <div>
              <strong>Public request form</strong>
              <span>Anyone with the address can raise a job. No credential.</span>
            </div>
            <a className="secondary-button" href="/request">
              Open the form
            </a>
          </div>
        </div>
      </AccountCard>
    </>
  );
}

/* ── Beta features — monday.labs ────────────────────────────────────────── */

type RuntimeFlags = {
  testingMode: boolean;
  authenticationEnabled: boolean;
};

export function AccountBetaPanel() {
  const [flags, setFlags] = useState<RuntimeFlags | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/context", {
          headers: { Accept: "application/json" },
        });
        const payload = (await response.json()) as {
          context?: RuntimeFlags;
          error?: string;
        };
        if (!response.ok || !payload.context) {
          throw new Error(payload.error || "The runtime flags are unavailable.");
        }
        setFlags({
          testingMode: payload.context.testingMode,
          authenticationEnabled: payload.context.authenticationEnabled,
        });
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "The runtime flags are unavailable.",
        );
      }
    })();
  }, []);

  return (
    <>
      <AccountHeading
        eyebrow="Explore"
        title="Beta features"
        lede="monday.labs lets a person switch experimental features on for themselves. There is no feature-flag table here, so nothing on this page is a switch — it is the register of what the running server declares about itself."
      />

      {error && <AccountError message={error} />}
      {!flags && !error && <AccountLoading label="Reading the runtime" />}

      {flags && (
        <AccountCard
          title="What the server reports"
          description="Straight from /api/context. These are workspace-wide states, not per-person preferences."
        >
          <div className="account-list">
            <div className="account-list__row">
              <div>
                <strong>Testing mode</strong>
                <span>
                  The role selector in the sidebar switches identity, not just a
                  label: choosing a role signs the browser in as that role&rsquo;s
                  seeded account. Real sign-in replaces this.
                </span>
              </div>
              <AccountStatus ok={flags.testingMode} okLabel="On" offLabel="Off" />
            </div>
            <div className="account-list__row">
              <div>
                <strong>Account authentication</strong>
                <span>
                  When off, identity is resolved from a cookie rather than from a
                  password and a session. Memberships still decide what that
                  identity may read.
                </span>
              </div>
              <AccountStatus
                ok={flags.authenticationEnabled}
                okLabel="Enabled"
                offLabel="Not enabled"
              />
            </div>
            <div className="account-list__row">
              <div>
                <strong>Light theme</strong>
                <span>
                  Not built. Every themed rule in the stylesheets targets dark —
                  see <Link href="/dashboard/account/theme">Change theme</Link> for what
                  that means and what would have to change.
                </span>
              </div>
              <AccountStatus ok={false} okLabel="Available" offLabel="Dark only" />
            </div>
          </div>
        </AccountCard>
      )}

      <AccountCard tone="notice" title="Why there are no toggles">
        <p className="account-note">
          A per-person feature flag needs somewhere to store it. No table in this
          workspace holds one, so a switch on this page would have nothing to write
          to and would forget itself on reload. Listing the real states is worth
          more than three switches that do nothing.
        </p>
      </AccountCard>
    </>
  );
}

/* ── Shortcuts ──────────────────────────────────────────────────────────── */

/**
 * Every entry below corresponds to a key handler that exists in this codebase.
 * The source file is named on each group so the claim is checkable rather than
 * taken on trust — this is a reference, and a reference that lies is worse than
 * none.
 */
const SHORTCUT_GROUPS: Array<{
  title: string;
  source: string;
  /** Behaviour the browser provides, which no handler in the source implements. */
  note?: string;
  rows: Array<{ keys: string[]; action: string }>;
}> = [
  {
    title: "Anywhere",
    source: "board-primitives.tsx, evidence-manager.tsx, live-board.tsx",
    rows: [
      { keys: ["Esc"], action: "Close the open menu, drawer, dialog or viewer" },
      { keys: ["Tab"], action: "Move to the next control; focus stays inside an open dialog" },
    ],
  },
  {
    title: "Account menu",
    source: "account-menu.tsx",
    note: "The avatar is an ordinary button, so Enter or Space opens the menu — that is the browser, not a handler.",
    rows: [
      { keys: ["↑", "↓"], action: "Move within the Account or Explore column" },
      { keys: ["←", "→"], action: "Move between the two columns" },
      { keys: ["Home", "End"], action: "First or last item of the column" },
      { keys: ["Esc"], action: "Close and return focus to the avatar" },
    ],
  },
  {
    title: "Sidebar",
    source: "sidebar-nav.tsx",
    rows: [
      { keys: ["Alt", "↑"], action: "Move the selected navigation item up" },
      { keys: ["Alt", "↓"], action: "Move the selected navigation item down" },
      { keys: ["Enter"], action: "Confirm a rename" },
      { keys: ["Esc"], action: "Abandon a rename" },
    ],
  },
  {
    title: "Board cells",
    source: "board-cells.tsx, cells/expiry-cell.tsx",
    rows: [
      { keys: ["Enter"], action: "Commit the cell being edited" },
      { keys: ["Esc"], action: "Abandon the edit and restore the previous value" },
    ],
  },
  {
    title: "Groups and sub-items",
    source: "live-board.tsx, board-subitems.tsx, board-chrome.tsx",
    rows: [
      { keys: ["Enter"], action: "Create the group, sub-item or option being typed" },
      { keys: ["Esc"], action: "Cancel the group creator, rename or draft" },
    ],
  },
  {
    title: "Store documentation tabs",
    source: "views/store-documentation-board.tsx",
    rows: [
      { keys: ["←", "→"], action: "Previous or next tab, focus following selection" },
      { keys: ["Home", "End"], action: "First or last tab" },
    ],
  },
  {
    title: "Expiry calendar",
    source: "views/store-expiry-calendar.tsx",
    rows: [
      { keys: ["←", "→", "↑", "↓"], action: "Move by a day or a week" },
      { keys: ["Home", "End"], action: "Start or end of the week" },
      { keys: ["PgUp", "PgDn"], action: "Previous or next month" },
      { keys: ["Shift", "PgUp"], action: "Back a year" },
      { keys: ["Shift", "PgDn"], action: "Forward a year" },
      { keys: ["Enter"], action: "Open the first entry on the focused day" },
    ],
  },
];

export function AccountShortcutsPanel() {
  return (
    <>
      <AccountHeading
        eyebrow="Explore"
        title="Shortcuts"
        lede="Keys this application actually listens for. Each group names the file that handles them."
      />

      {SHORTCUT_GROUPS.map((group) => (
        <AccountCard
          key={group.title}
          title={group.title}
          description={
            <>
              <code>{group.source}</code>
              {group.note && <> · {group.note}</>}
            </>
          }
        >
          <div className="account-table-wrap">
            <table className="account-table account-table--shortcuts">
              <tbody>
                {group.rows.map((row) => (
                  <tr key={`${group.title}-${row.action}`}>
                    <td>
                      {row.keys.map((key, index) => (
                        <span key={key}>
                          {index > 0 && <em>+</em>}
                          <kbd>{key}</kbd>
                        </span>
                      ))}
                    </td>
                    <td>{row.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AccountCard>
      ))}

      <AccountCard tone="notice" title="No global command palette">
        <p className="account-note">
          monday has single-key shortcuts that work anywhere on a board. Nothing in
          this application binds a bare letter key, so there is no palette and no
          quick-add key to document.
        </p>
      </AccountCard>
    </>
  );
}

/* ── Invite members ─────────────────────────────────────────────────────── */

export function AccountInvitePanel({
  snapshot,
  onNotify,
}: {
  snapshot: AccountSnapshot;
  onNotify: (message: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("client");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  /**
   * `/api/auth/invitations` belongs to the authentication work. This form does
   * not reimplement invitations — it posts to that route and reports what came
   * back, including the case where the route has not shipped yet.
   */
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch("/api/auth/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          role,
          message,
          organisationId: snapshot.workspace.id,
        }),
      });
      if (response.status === 404) {
        setResult(
          "Invitations are not available yet — /api/auth/invitations has not shipped. Nothing was sent and no invitation was created.",
        );
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "The invitation could not be sent.");
      }
      setEmail("");
      setMessage("");
      setResult(`Invitation created for ${email}.`);
      onNotify("Invitation created.");
    } catch (caught) {
      setResult(
        caught instanceof Error ? caught.message : "The invitation could not be sent.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <AccountHeading
        eyebrow="Explore"
        title="Invite members"
        lede={`Invite someone into ${snapshot.workspace.name}. The role travels on the invitation, so accepting it cannot grant more than was offered.`}
      />

      <AccountCard title="Send an invitation">
        <form className="account-form" onSubmit={submit}>
          <div className="account-form__grid">
            <label className="account-field">
              <span>Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="account-field">
              <span>Role</span>
              <select value={role} onChange={(event) => setRole(event.target.value)}>
                <option value="client">Client</option>
                <option value="admin">Admin</option>
                <option value="super_admin">Super admin</option>
              </select>
            </label>
          </div>
          <label className="account-field">
            <span>Message (optional)</span>
            <textarea
              rows={3}
              maxLength={400}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
          {result && <p className="account-note">{result}</p>}
          <div className="account-form__actions">
            <button className="primary-button" type="submit" disabled={busy || !email}>
              {busy ? "Sending…" : "Send invitation"}
            </button>
            <Link className="secondary-button" href="/dashboard/teams">
              Manage teams
            </Link>
          </div>
        </form>
      </AccountCard>

      <AccountCard tone="notice" title="Where the rule lives">
        <p className="account-note">
          The role is written onto the invitation row, and the membership is created
          from that row rather than from anything the invitee sends back. Accepting
          an invitation therefore cannot escalate a role, whatever is posted at the
          acceptance endpoint.
        </p>
      </AccountCard>
    </>
  );
}

/* ── Get help ───────────────────────────────────────────────────────────── */

export function AccountHelpPanel() {
  const [support, setSupport] = useState<{
    salesInbox: string;
    opsInbox: string;
    emailDeliveryConfigured: boolean;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/account/platform", {
          headers: { Accept: "application/json" },
        });
        const payload = (await response.json()) as {
          platform?: {
            support: {
              salesInbox: string;
              opsInbox: string;
              emailDeliveryConfigured: boolean;
            };
          };
        };
        if (payload.platform?.support) setSupport(payload.platform.support);
      } catch {
        // The rest of the page is still useful without the configured inboxes.
      }
    })();
  }, []);

  return (
    <>
      <AccountHeading
        eyebrow="Explore"
        title="Get help"
        lede="Where to go when something is wrong, and who actually receives it."
      />

      <AccountCard
        title="Contact"
        description="These are the inboxes this deployment is configured to notify, read from the Worker's own settings rather than typed onto this page."
      >
        {support ? (
          <dl className="account-definitions">
            <div>
              <dt>Operations</dt>
              <dd>
                <a href={`mailto:${support.opsInbox}`}>{support.opsInbox}</a>
              </dd>
            </div>
            <div>
              <dt>Sales and accounts</dt>
              <dd>
                <a href={`mailto:${support.salesInbox}`}>{support.salesInbox}</a>
              </dd>
            </div>
            <div>
              <dt>Automated email</dt>
              <dd>
                <AccountStatus
                  ok={support.emailDeliveryConfigured}
                  okLabel="Delivering"
                  offLabel="Not configured — messages are logged, not sent"
                />
              </dd>
            </div>
          </dl>
        ) : (
          <AccountLoading label="Reading the configured inboxes" />
        )}
      </AccountCard>

      <AccountCard
        title="Answers already written down"
        description="Real pages in this application, not a knowledge base that does not exist."
      >
        <div className="account-list">
          {[
            { href: "/faqs", label: "Frequently asked questions", note: "How MAINTSUPP handles jobs, compliance and contractors." },
            { href: "/dashboard/account/shortcuts", label: "Keyboard shortcuts", note: "Every key this application listens for." },
            { href: "/dashboard/account/integrations", label: "Integrations status", note: "Whether email, storage and imports are live right now." },
            { href: "/terms", label: "Terms of service", note: "" },
            { href: "/privacy", label: "Privacy notice", note: "" },
            { href: "/cookies", label: "Cookie notice", note: "" },
          ].map((entry) => (
            <div key={entry.href} className="account-list__row">
              <div>
                <strong>{entry.label}</strong>
                {entry.note && <span>{entry.note}</span>}
              </div>
              <a className="secondary-button" href={entry.href}>
                Open
              </a>
            </div>
          ))}
        </div>
      </AccountCard>

      <AccountCard
        title="Something looks wrong with the data"
        description="Two checks answer most of it before anyone needs to be emailed."
      >
        <ol className="account-steps">
          <li>
            Check the workspace indicator in the top bar reads{" "}
            <strong>Live workspace</strong>. &ldquo;Loading workspace&rdquo; means
            the board on screen is sample data, not yours.
          </li>
          <li>
            Check which workspace is selected under{" "}
            <Link href="/dashboard/account/workspaces">Workspaces</Link>. An empty board
            and a board belonging to another client look identical.
          </li>
        </ol>
      </AccountCard>
    </>
  );
}

/* ── Change theme ───────────────────────────────────────────────────────── */

export function AccountThemePanel({
  snapshot,
  onSnapshotChange,
  onNotify,
}: {
  snapshot: AccountSnapshot;
  onSnapshotChange: (next: AccountSnapshot) => void;
  onNotify: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  /*
   * The device is the source of truth for what is painted, so the picker reads
   * the shared store rather than the account row. It used to read the column
   * and write the raw value straight onto the document — which put
   * `data-theme="system"` there, a value no stylesheet matches, so choosing
   * System produced a third unintended skin. `setThemeChoice` resolves it.
   */
  const current = useThemeChoice();
  const resolved = useResolvedTheme();

  const choose = async (theme: ThemeChoice) => {
    // Applied and stored first: the theme is a local decision and should not
    // wait on a request, or be lost if one fails.
    setThemeChoice(theme);
    setBusy(true);
    try {
      const response = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themePreference: theme }),
      });
      const payload = (await response.json()) as {
        profile?: AccountSnapshot["profile"];
        error?: string;
      };
      if (!response.ok || !payload.profile) {
        throw new Error(payload.error || "The theme could not be saved.");
      }
      onSnapshotChange({ ...snapshot, profile: payload.profile });
      onNotify("Theme saved.");
    } catch (caught) {
      onNotify(
        caught instanceof Error ? caught.message : "The theme could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <AccountHeading
        eyebrow="Explore"
        title="Change theme"
        lede="System is the default: with nothing chosen, MAINTSUPP paints whatever the device asks for. Picking Light or Dark overrides that on this browser until you change it."
      />

      <AccountCard
        title="Theme"
        description="Saved to your own user record, and applied immediately."
      >
        <div className="account-themes">
          <button
            type="button"
            className={`account-theme${current === "dark" ? " is-active" : ""}`}
            disabled={busy}
            aria-pressed={current === "dark"}
            onClick={() => void choose("dark")}
          >
            <span className="account-theme__swatch account-theme__swatch--dark" aria-hidden="true" />
            <strong>
              <Icon name="moon" size={15} /> Dark
            </strong>
            <small>The default, and what the product was designed in.</small>
          </button>
          <button
            type="button"
            className={`account-theme${current === "light" ? " is-active" : ""}`}
            disabled={busy}
            aria-pressed={current === "light"}
            onClick={() => void choose("light")}
          >
            <span className="account-theme__swatch account-theme__swatch--light" aria-hidden="true" />
            <strong>
              <Icon name="sun" size={15} /> Light
            </strong>
            <small>The original palette, on a white canvas.</small>
          </button>
          <button
            type="button"
            className={`account-theme${current === "system" ? " is-active" : ""}`}
            disabled={busy}
            aria-pressed={current === "system"}
            onClick={() => void choose("system")}
          >
            <span className="account-theme__swatch account-theme__swatch--dark" aria-hidden="true" />
            <strong>
              <Icon name="sun" size={15} /> System
            </strong>
            <small>Follows the device setting.</small>
          </button>
        </div>
      </AccountCard>

      <AccountCard tone="notice" title="How far the light theme goes">
        <p className="account-note">
          The light palette was always the base set of tokens in{" "}
          <code>globals.css</code>; the dark skin overrode it, and an unscoped{" "}
          <code>:root</code> later in the file meant the light values could never
          win. The dark block is now scoped to{" "}
          <code>:root:not([data-theme=&quot;light&quot;])</code>, so the tokens that
          were already written are what light mode paints.
        </p>
        <p className="account-note">
          Surfaces that read the palette follow automatically. A number of rules
          still name a dark colour literally rather than through a token, so
          isolated panels can stay dark in light mode — those are being converted
          as they are found, and none of them affect legibility of the shell.
        </p>
      </AccountCard>

      <AccountCard title="What the column holds now">
        <dl className="account-definitions">
          <div>
            <dt>Chosen on this browser</dt>
            <dd>
              <code>maintsupp:theme-preference</code> ={" "}
              <strong>{current}</strong>
            </dd>
          </div>
          <div>
            <dt>Applied</dt>
            <dd>
              <code>data-theme=&quot;{resolved}&quot;</code> on{" "}
              <code>&lt;html&gt;</code> and <code>&lt;body&gt;</code>
            </dd>
          </div>
          <div>
            <dt>Recorded on the account</dt>
            <dd>
              <code>users.theme_preference</code> ={" "}
              <strong>{snapshot.profile.themePreference}</strong>
            </dd>
          </div>
        </dl>
      </AccountCard>
    </>
  );
}
