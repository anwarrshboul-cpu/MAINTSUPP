import { getChatGPTUser } from "../chatgpt-auth";

export type WorkspaceRole = "super_admin" | "admin" | "client";

export type WorkspaceActor = {
  email: string;
  displayName: string;
  role: WorkspaceRole;
};

const roleNames: Record<WorkspaceRole, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  client: "Client",
};

export function workspaceCookieValue(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export function workspaceRoleFromRequest(request: Request): WorkspaceRole {
  /*
   * The role cookie is a preview affordance and carries no authority.
   *
   * Outside the preview it is ignored outright, and the actor is the least
   * privileged role there is. Two things depended on the old behaviour, and both
   * are anonymous-caller escalations: an absent cookie meant `super_admin`, and
   * `resolveTenantAccess` falls back to `actor.role` when there is no session —
   * so `Cookie: maintsupp_demo_role=admin` was an admin grant for the asking.
   * Returning early keeps the cookie from deciding anything in production.
   *
   * The NODE_ENV test is inlined rather than imported from `tenant-access.ts`,
   * which imports this module — the dependency only runs one way.
   */
  if (process.env.NODE_ENV === "production") return "client";
  const value = workspaceCookieValue(request, "maintsupp_demo_role");
  return value === "admin" || value === "client" ? value : "super_admin";
}

/**
 * Public development-mode identity. The role cookie is only a preview of the
 * future permission model; all three roles may edit while the product is in
 * its public testing phase. Replace this helper with server-enforced account
 * membership when production authentication is enabled.
 */
export async function getWorkspaceActor(
  request: Request,
): Promise<WorkspaceActor> {
  const role = workspaceRoleFromRequest(request);
  const signedIn = await getChatGPTUser();
  return {
    email: signedIn?.email ?? `${role.replace("_", "-")}@test.maintsupp.com`,
    displayName: signedIn?.displayName ?? roleNames[role],
    role,
  };
}

export function workspaceRoleLabel(role: WorkspaceRole) {
  return roleNames[role];
}
