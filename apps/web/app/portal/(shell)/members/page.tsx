import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewerState, serverFetch } from "../../../../lib/session";
import {
  canManageMembers,
  type Invitation,
  type Member,
  type Scopes,
} from "../../../../lib/portal";
import MembersAdmin from "./members-admin";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Members" };

export default async function MembersPage() {
  const state = await getViewerState();
  if (state.kind !== "ok") return null;
  // Presentation only — every endpoint below re-checks. See requests/page.tsx.
  if (!canManageMembers(state.viewer.actor)) redirect("/portal/dashboard");

  const [list, scopes, invitations] = await Promise.all([
    serverFetch<{ members: Member[] }>("/members"),
    serverFetch<Scopes>("/members/scopes"),
    serverFetch<{ invitations: Invitation[] }>("/members/invitations"),
  ]);

  if (!list.ok) {
    return (
      <div className="card card--empty">
        <h1>Members</h1>
        <p className="muted">{list.error}</p>
      </div>
    );
  }

  return (
    <>
      <h1 className="p-h1">Members</h1>
      <p className="p-lede">
        Accounts waiting for approval come first — until one is approved it holds
        no role and can read nothing.
      </p>

      <MembersAdmin
        actor={state.viewer.actor}
        members={list.data.members}
        invitations={invitations.ok ? invitations.data.invitations : []}
        scopes={
          scopes.ok
            ? scopes.data
            : { organisations: [], sites: [], contractors: [] }
        }
      />
    </>
  );
}
