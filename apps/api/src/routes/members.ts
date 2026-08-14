import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import {
  canActOnMember,
  canGrantRole,
  canManageMembers,
  isStaff,
  type Role,
} from "../lib/access.ts";
import { requireActor, requireCapability, type Env } from "../lib/middleware.ts";
import { hashOneTimeToken } from "../lib/provision.ts";
import { revokeAllSessions } from "../lib/sessions.ts";
import { sendMailBestEffort, templates } from "../lib/mail.ts";
import { email as normaliseEmail, isEmail, str } from "../lib/http.ts";

const webUrl = () =>
  (process.env.WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");

const ROLES: Role[] = [
  "owner",
  "super_admin",
  "admin",
  "client_admin",
  "client_user",
  "contractor",
];

export const members = new Hono<Env>();

members.use("*", requireActor);
members.use("*", requireCapability(canManageMembers, "Only staff manage members."));

/** Everyone, with their scope. The Members page and the approval queue. */
members.get("/", async (c) => {
  const db = c.get("db");
  const rows = await db.query(
    `select p.id::text, p.email, p.full_name, p.phone, p.role, p.status,
            p.organisation_id::text, o.name as organisation_name,
            p.contractor_id::text, ct.name as contractor_name,
            p.created_at::text, p.last_seen_at::text,
            u.email_verified_at is not null as email_verified,
            coalesce(array_agg(s.name) filter (where s.name is not null), '{}') as site_names
       from profiles p
       join users u on u.id = p.id
       left join organisations o on o.id = p.organisation_id
       left join contractors ct on ct.id = p.contractor_id
       left join profile_sites ps on ps.profile_id = p.id
       left join sites s on s.id = ps.site_id
      group by p.id, p.email, p.full_name, p.phone, p.role, p.status,
               p.organisation_id, o.name, p.contractor_id, ct.name,
               p.created_at, p.last_seen_at, u.email_verified_at
      order by (p.status = 'pending_approval') desc, p.created_at desc`,
  );
  return c.json({ members: rows });
});

/**
 * Invite by email.
 *
 * No user row is created. The invitation records the role and scope, and
 * `provisionProfile` applies them when the invitee registers — so an
 * invitation that is never accepted leaves nothing behind, and the invitee
 * chooses their own password rather than being sent one.
 */
members.post("/invite", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = await c.req.json().catch(() => ({}));

  const address = normaliseEmail(body.email);
  const role = str(body.role, 30) as Role;
  const organisationId = str(body.organisationId, 40) || null;
  const contractorId = str(body.contractorId, 40) || null;

  if (!isEmail(address)) return c.json({ error: "Enter a valid email address." }, 400);
  if (!ROLES.includes(role)) return c.json({ error: "Choose a role." }, 400);

  // You cannot invite someone more powerful than yourself.
  if (!canGrantRole(actor, role)) {
    return c.json({ error: "You cannot grant that role." }, 403);
  }
  if ((role === "client_admin" || role === "client_user") && !organisationId) {
    return c.json({ error: "Choose an organisation for a client role." }, 400);
  }
  if (role === "contractor" && !contractorId) {
    return c.json({ error: "Choose a contractor." }, 400);
  }

  const [existing] = await db.query<{ id: string }>(
    "select id::text from users where lower(email) = $1",
    [address],
  );
  if (existing) {
    return c.json({ error: "That address already has an account." }, 409);
  }

  const token = randomBytes(32).toString("base64url");

  // Supersede any outstanding invitation: the partial unique index allows only
  // one pending row per address, and two live links would make "which one
  // works" depend on which email got opened.
  await db.transaction(async (tx) => {
    await tx.query(
      "update invitations set status = 'revoked' where lower(email) = $1 and status = 'pending'",
      [address],
    );
    await tx.query(
      `insert into invitations (email, role, organisation_id, contractor_id, token_hash, invited_by)
       values ($1,$2,$3,$4,$5,$6)`,
      [address, role, organisationId, contractorId, hashOneTimeToken(token), actor.profileId],
    );
  });

  sendMailBestEffort({
    to: address,
    ...templates.invitation(
      `${webUrl()}/portal?invite=${token}&email=${encodeURIComponent(address)}`,
      actor.email,
      role,
    ),
  });

  return c.json({ ok: true, invited: address, role });
});

members.get("/invitations", async (c) => {
  const rows = await c.get("db").query(
    `select i.id::text, i.email, i.role, i.status, i.expires_at::text,
            i.created_at::text, o.name as organisation_name
       from invitations i
       left join organisations o on o.id = i.organisation_id
      where i.status = 'pending' and i.expires_at > now()
      order by i.created_at desc`,
  );
  return c.json({ invitations: rows });
});

members.post("/invitations/:id/revoke", async (c) => {
  const rows = await c.get("db").query<{ id: string }>(
    "update invitations set status = 'revoked' where id = $1 and status = 'pending' returning id::text",
    [c.req.param("id")],
  );
  if (!rows.length) return c.json({ error: "No pending invitation." }, 404);
  return c.json({ ok: true });
});

/** Loads a member and checks the actor may act on them. */
async function target(c: Context<Env>) {
  const db = c.get("db");
  const [row] = await db.query<{ id: string; email: string; role: Role; status: string }>(
    "select id::text, email, role, status from profiles where id = $1",
    [c.req.param("id")],
  );
  if (!row) return { error: c.json({ error: "No such member." }, 404) };

  const verdict = canActOnMember(c.get("actor"), row);
  if (!verdict.allowed) return { error: c.json({ error: verdict.reason }, 403) };
  return { row };
}

/**
 * Approve a pending account: role, scope and active, in one statement.
 *
 * One statement because a half-applied approval — active with no organisation —
 * is a client who can see nothing and an admin who thinks they fixed it. The
 * CHECK constraint on `profiles` refuses that shape outright.
 */
members.post("/:id/approve", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const found = await target(c);
  if (found.error) return found.error;

  const body = await c.req.json().catch(() => ({}));
  const role = str(body.role, 30) as Role;
  const organisationId = str(body.organisationId, 40) || null;
  const contractorId = str(body.contractorId, 40) || null;
  const siteIds: string[] = Array.isArray(body.siteIds)
    ? body.siteIds.filter((v: unknown) => typeof v === "string").slice(0, 200)
    : [];

  if (!ROLES.includes(role)) return c.json({ error: "Choose a role." }, 400);
  if (!canGrantRole(actor, role)) {
    return c.json({ error: "You cannot grant that role." }, 403);
  }

  try {
    await db.transaction(async (tx) => {
      await tx.query(
        `update profiles
            set role = $2, status = 'active',
                organisation_id = $3, contractor_id = $4
          where id = $1`,
        [found.row.id, role, organisationId, contractorId],
      );
      await tx.query("delete from profile_sites where profile_id = $1", [found.row.id]);

      /*
       * Every site must belong to the organisation being granted.
       *
       * This accepted any site id at all, so approving a store manager with a
       * site from another client handed them that client's site register,
       * compliance register and expiry calendar. `scopeFor` refused their jobs,
       * which made the mistake look harmless right up until somebody opened
       * /portal/compliance.
       *
       * The insert selects from `sites` rather than inserting the id directly,
       * so a site outside the organisation is not rejected — it simply does not
       * exist to this statement. The count is compared afterwards, so a caller
       * who sends one is told, rather than quietly getting fewer sites than
       * they asked for.
       */
      if (siteIds.length > 0) {
        const granted = await tx.query<{ site_id: string }>(
          `insert into profile_sites (profile_id, site_id)
           select $1, s.id from sites s
            where s.id = any($2::uuid[]) and s.organisation_id = $3
           on conflict do nothing
           returning site_id::text`,
          [found.row.id, siteIds, organisationId],
        );
        if (granted.length !== siteIds.length) {
          throw new Error("site-outside-organisation");
        }
      }
    });
  } catch (error) {
    // Two different mistakes, told apart, because "that didn't work" leaves an
    // administrator guessing which field to change.
    if ((error as Error).message === "site-outside-organisation") {
      return c.json(
        { error: "One of those sites belongs to a different organisation." },
        400,
      );
    }
    // Otherwise the scope CHECK fired: an active client role with no
    // organisation, or a contractor with no contractor.
    return c.json(
      { error: "A client role needs an organisation, and a contractor needs a contractor." },
      400,
    );
  }

  sendMailBestEffort({ to: found.row.email, ...templates.approved(role) });
  return c.json({ ok: true });
});

members.post("/:id/role", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const found = await target(c);
  if (found.error) return found.error;

  const role = str((await c.req.json().catch(() => ({}))).role, 30) as Role;
  if (!ROLES.includes(role)) return c.json({ error: "Choose a role." }, 400);
  if (!canGrantRole(actor, role)) {
    return c.json({ error: "You cannot grant that role." }, 403);
  }

  await db.query("update profiles set role = $2 where id = $1", [found.row.id, role]);
  return c.json({ ok: true });
});

/**
 * Deactivate.
 *
 * Sessions are revoked in the same breath. Flipping `status` alone would leave
 * a deactivated user browsing on their existing cookie until it expired —
 * which is exactly the window that matters when somebody is removed in a hurry.
 */
members.post("/:id/deactivate", async (c) => {
  const db = c.get("db");
  const found = await target(c);
  if (found.error) return found.error;

  await db.query("update profiles set status = 'suspended' where id = $1", [found.row.id]);
  const revoked = await revokeAllSessions(db, found.row.id);
  return c.json({ ok: true, sessionsRevoked: revoked });
});

members.post("/:id/reactivate", async (c) => {
  const db = c.get("db");
  const found = await target(c);
  if (found.error) return found.error;
  await db.query(
    "update profiles set status = 'active' where id = $1 and status = 'suspended'",
    [found.row.id],
  );
  return c.json({ ok: true });
});

/** Organisations, sites and contractors — for the invite and approve forms. */
members.get("/scopes", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!isStaff(actor.role)) return c.json({ error: "Not permitted." }, 403);

  const [organisations, sites, contractors] = await Promise.all([
    db.query("select id::text, name from organisations where active order by name"),
    db.query("select id::text, name, organisation_id::text from sites where active order by name"),
    db.query("select id::text, name from contractors where active order by name"),
  ]);
  return c.json({ organisations, sites, contractors });
});
