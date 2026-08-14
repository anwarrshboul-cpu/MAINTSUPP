import type { Metadata } from "next";
import { getD1 } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import {
  invitationProblem,
  resolveInvitation,
  ROLE_LABEL,
  normaliseRole,
} from "../../../api/auth/invitations/invitation-tokens";
import AcceptInviteForm from "./accept-invite-form";
import inviteCss from "./invite.css?url";

// The URL contains the token, so it is a credential. Indexing it would publish
// working invitations, and a referrer would leak them to whatever the page
// links to.
export const metadata: Metadata = {
  title: "Join a workspace | MAINTSUPP",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

type UserRow = { password_hash?: string | null };

/**
 * /invite/[token] — Stage 20.
 *
 * The invitation is resolved on the server, before anything renders, so an
 * expired or withdrawn link produces a page that says so rather than a form
 * that flashes into view and then fails. Fail closed, and be legible about it:
 * the person reading this was sent a link by a colleague and needs to know
 * whether to ask for another one.
 *
 * The state of the token is safe to name, even though the sign-in page refuses
 * to name why *it* failed. The difference is what an attacker learns. On
 * /login, a specific message reveals whether an email has an account here. Here
 * the reader already holds the token; telling them it expired discloses nothing
 * they could not establish by trying it.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  await ensureDatabase();
  const { token } = await params;
  const d1 = await getD1();

  const { state, invitation } = await resolveInvitation(d1, token);

  if (state !== "valid" || !invitation) {
    return (
      <>
        <link rel="stylesheet" href={inviteCss} />
        <main className="invite">
          <span className="invite__brand">
            <span>MAINT</span><strong>SUPP</strong>
          </span>
          <div className="invite__card invite__card--closed">
            <div className="invite__icon" aria-hidden="true">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7.5v5.5M12 16.2v.2" />
              </svg>
            </div>
            <p className="invite__eyebrow">Invitation</p>
            <h1>This link cannot be used</h1>
            <p className="invite__lede">{invitationProblem(state)}</p>
            <a className="invite__link" href="/login">
              Go to sign in
            </a>
          </div>
          <p className="invite__legal">
            Invitation links are single use and expire. Nothing about the
            workspace is shown until a valid link is opened.
          </p>
        </main>
      </>
    );
  }

  const email = (invitation.email ?? "").toLowerCase();
  const role = normaliseRole(invitation.role) ?? "client";

  /*
   * Does this address already have a password?
   *
   * Decided here so the form knows which of its two shapes to render. The
   * answer is not a disclosure: the invitation names this exact address, and
   * whoever holds the link was sent it for that address.
   */
  const existingResult = await d1
    .prepare("SELECT password_hash FROM users WHERE lower(email) = ? LIMIT 1")
    .bind(email)
    .all();
  const [existing] = (existingResult.results ?? []) as UserRow[];
  const existingAccount = !!existing?.password_hash;

  const expires = invitation.expires_at
    ? new Date(
        /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(invitation.expires_at)
          ? `${invitation.expires_at.replace(" ", "T")}Z`
          : invitation.expires_at,
      )
    : null;

  return (
    <>
      <link rel="stylesheet" href={inviteCss} />
      <main className="invite">
        <span className="invite__brand">
          <span>MAINT</span><strong>SUPP</strong>
        </span>

        <div className="invite__card">
          <p className="invite__eyebrow">Invitation</p>
          <h1>Join {invitation.organisation_name}</h1>
          <p className="invite__lede">
            {existingAccount
              ? "You have been added to this workspace."
              : "Set a password and your account is ready."}
          </p>

          <dl className="invite__facts">
            <dt>Workspace</dt>
            <dd>{invitation.organisation_name}</dd>
            <dt>Email</dt>
            <dd>{email}</dd>
            <dt>Role</dt>
            <dd>
              <span className="invite__role">{ROLE_LABEL[role]}</span>
            </dd>
            {expires && !Number.isNaN(expires.getTime()) ? (
              <>
                <dt>Link expires</dt>
                <dd>
                  {expires.toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </dd>
              </>
            ) : null}
          </dl>

          <AcceptInviteForm
            token={token}
            email={email}
            existingAccount={existingAccount}
          />
        </div>

        <p className="invite__legal">
          The role above was set by the administrator who invited you and cannot
          be changed from this page.
        </p>
      </main>
    </>
  );
}
