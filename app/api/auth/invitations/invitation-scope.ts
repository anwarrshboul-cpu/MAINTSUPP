/**
 * Reading an invitation's workspace list. Pure, so tests can load it; the
 * invitation service re-exports it.
 *
 * `workspace_ids` is a JSON array written by `createInvitation`. Invitations
 * written before client companies existed have none and grant their landing
 * workspace (`organisation_id`) alone, and so does a list that cannot be read —
 * never more than the row plainly names.
 */

/** The workspace ids a stored invitation grants, oldest format included. */
export function invitationWorkspaceIds(invitation: {
  workspace_ids?: string | null;
  organisation_id?: string | null;
}): string[] {
  if (invitation.workspace_ids) {
    try {
      const parsed = JSON.parse(invitation.workspace_ids) as unknown;
      if (Array.isArray(parsed)) {
        const ids = parsed.filter((item): item is string => typeof item === "string" && Boolean(item));
        if (ids.length) return [...new Set(ids)];
      }
    } catch {
      /* An unreadable list falls back to the landing workspace below. */
    }
  }
  return invitation.organisation_id ? [invitation.organisation_id] : [];
}
