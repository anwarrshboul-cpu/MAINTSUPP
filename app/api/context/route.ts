import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { getD1 } from "../../../db";
import { ensureDatabase, seedBoardStructure } from "../../../db/init";
import { seedStoreDocumentationBoard } from "../../../db/seed-store-documentation";
import {
  maintenanceRequests,
  memberships,
  optionSets,
  optionValues,
  organisations,
  sites,
  users,
} from "../../../db/schema";
import { anonymousRefusal, scopedDb, type ScopedDatabase } from "../../lib/tenant-db";
import {
  demoIdentityAllowed,
  IDENTITY_COOKIE,
  ORGANISATION_COOKIE,
  organisationIdentityEmail,
  roleIdentityEmail,
} from "../../lib/tenant-access";
import { listOptionValues } from "../../lib/options-repository";
import { type WorkspaceRole } from "../../lib/workspace-actor";

function clean(value: unknown, max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function toSlug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function cookie(name: string, value: string) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;
}

/**
 * Per-organisation row counts, for a super admin only.
 *
 * "Only the super admins have the view on everything" is otherwise only
 * demonstrable by switching client and looking, one at a time. This answers it
 * in one payload — and it is the one place in the API that reads across
 * organisation boundaries at all, which is why the guard is on the caller's
 * resolved `crossOrganisation` flag rather than on anything in the request.
 */
async function tenantSummary(context: ScopedDatabase) {
  if (!context.crossOrganisation) return null;
  const ids = context.organisationIds;
  if (!ids.length) return null;

  const [jobRows, siteRows] = await Promise.all([
    context.db
      .select({
        organisationId: maintenanceRequests.organisationId,
        value: count(),
      })
      .from(maintenanceRequests)
      .where(
        and(
          inArray(maintenanceRequests.organisationId, ids),
          // Stage 23 — binned jobs are not part of a tenant's job count.
          isNull(maintenanceRequests.deletedAt),
        ),
      )
      .groupBy(maintenanceRequests.organisationId),
    context.db
      .select({ organisationId: sites.organisationId, value: count() })
      .from(sites)
      .where(inArray(sites.organisationId, ids))
      .groupBy(sites.organisationId),
  ]);

  const jobs = new Map(jobRows.map((row) => [row.organisationId, row.value]));
  const siteCounts = new Map(
    siteRows.map((row) => [row.organisationId, row.value]),
  );
  return context.activeOrganisations
    .filter((organisation) => ids.includes(organisation.id))
    .map((organisation) => ({
      id: organisation.id,
      name: organisation.name,
      slug: organisation.slug,
      maintenanceRequests: jobs.get(organisation.id) ?? 0,
      sites: siteCounts.get(organisation.id) ?? 0,
    }));
}

async function contextPayload(request: Request) {
  const context = await scopedDb(request);

  // The organisations this actor may read — their memberships, or every active
  // organisation for a super admin. A client is handed exactly one entry, so
  // the sidebar's client switcher has nothing to switch to.
  const visibleOrganisations = context.activeOrganisations
    .filter((organisation) => context.organisationIds.includes(organisation.id))
    .sort((left, right) => left.name.localeCompare(right.name));

  const [siteRows, priorities, engineers, labels] = await Promise.all([
    context.db
      .select({ id: sites.id, name: sites.name })
      .from(sites)
      .where(eq(sites.organisationId, context.orgId))
      .orderBy(asc(sites.name)),
    listOptionValues(context.db, context.orgId, "priority"),
    listOptionValues(context.db, context.orgId, "engineer_required"),
    listOptionValues(context.db, context.orgId, "maintenance_label"),
  ]);

  return {
    actor: context.actor,
    currentOrganisation: context.organisation,
    organisations: visibleOrganisations,
    // Stage 19 — what the actor is allowed to see, and how it was decided.
    identity: {
      email: context.identityEmail,
      organisationIds: context.organisationIds,
      crossOrganisation: context.crossOrganisation,
      // No membership matched; the actor is confined to the primary
      // organisation on the cookie role alone.
      unaffiliated: context.unaffiliated,
    },
    tenantSummary: await tenantSummary(context),
    /*
     * Whether this caller proved who they are.
     *
     * `testingMode` is now the inverse of being signed in rather than a
     * constant: with a real session the sidebar role switcher is not merely
     * unnecessary, it is misleading, because `resolveTenantAccess` refuses to
     * let it widen a session's reach — a user clicking "Super Admin" would see
     * nothing change and reasonably conclude the app was broken.
     */
    testingMode: !context.authenticated,
    authenticationEnabled: context.authenticated,
    requestConfiguration: {
      sites: siteRows,
      priorities: priorities.filter((item) => item.active),
      engineers: engineers.filter((item) => item.active),
      categories: labels.filter((item) => item.active && item.value),
    },
  };
}

export async function GET(request: Request) {
  await ensureDatabase();
  try {
    return Response.json({ context: await contextPayload(request) });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The workspace context could not be loaded.",
      },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  await ensureDatabase();
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const action = clean(payload.action, 40);

    const context = await scopedDb(request);

    if (action === "set_role") {
      /*
       * The testing role switcher is a preview affordance, not a product one.
       *
       * It writes `maintsupp_demo_role` and `maintsupp_demo_identity` with no
       * session and no capability check, so in production it hands any
       * anonymous caller a super-admin cookie for the asking. It stays for the
       * public preview and is refused once NODE_ENV says production, where the
       * role must come from a membership.
       */
      if (!demoIdentityAllowed()) {
        return Response.json(
          { error: "The testing role switcher is not available." },
          { status: 403 },
        );
      }
      const role = clean(payload.role, 40) as WorkspaceRole;
      if (role !== "super_admin" && role !== "admin" && role !== "client") {
        return Response.json({ error: "Choose a valid testing role." }, { status: 400 });
      }

      /*
       * Stage 19 — the role selector now switches *identity*, not just a label.
       *
       * Role and organisation are read from `memberships`, so setting the role
       * cookie alone would change nothing. Picking "Client" while Demo Client
       * Ltd is selected therefore signs the browser in as that organisation's
       * own client account, and the tenant rules take it from there: the
       * organisation cookie stops having any effect, and the client sees the
       * one organisation their membership names.
       *
       * The per-organisation identity is preferred, falling back to the
       * unqualified demo account (which belongs to Sunnamusk UK) when the
       * selected organisation has none seeded.
       */
      const wanted =
        role === "super_admin"
          ? [roleIdentityEmail(role)]
          : [
              organisationIdentityEmail(context.organisation.slug, role),
              roleIdentityEmail(role),
            ];
      const identityRows = await context.db
        .select({ email: users.email })
        .from(users)
        .innerJoin(memberships, eq(memberships.userId, users.id))
        .where(
          and(
            inArray(users.email, wanted),
            eq(memberships.status, "active"),
            eq(memberships.role, role),
          ),
        );
      const available = new Set(identityRows.map((row) => row.email));
      const identity = wanted.find((email) => available.has(email)) ?? null;

      const response = Response.json({ ok: true, role, identity });
      response.headers.append("Set-Cookie", cookie("maintsupp_demo_role", role));
      response.headers.append(
        "Set-Cookie",
        identity
          ? cookie(IDENTITY_COOKIE, identity)
          : // No seeded identity for this role. Clear the cookie rather than
            // leave the previous one in place, which would silently keep the
            // browser signed in as the organisation it just left.
            `${IDENTITY_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`,
      );
      return response;
    }

    // Everything below manages client workspaces, which only a super admin may
    // do — and `context.actor.role` is the role the database granted, not the
    // one the role cookie claimed.
    if (context.actor.role !== "super_admin") {
      return Response.json(
        { error: "Only the Super Admin test role can manage client workspaces." },
        { status: 403 },
      );
    }

    if (action === "select_organisation") {
      const organisationId = clean(payload.organisationId, 100);
      const [organisation] = await context.db
        .select()
        .from(organisations)
        .where(eq(organisations.id, organisationId))
        .limit(1);
      if (!organisation || organisation.status !== "active") {
        return Response.json({ error: "That client workspace is unavailable." }, { status: 404 });
      }
      // Belt and braces: `scopedDb` ignores an organisation the actor may not
      // read, so this only turns a silent no-op into a legible error.
      if (!context.organisationIds.includes(organisation.id)) {
        return Response.json(
          { error: "That client workspace is not one you have access to." },
          { status: 403 },
        );
      }
      const response = Response.json({ ok: true, organisation });
      response.headers.append(
        "Set-Cookie",
        cookie(ORGANISATION_COOKIE, organisation.id),
      );
      return response;
    }

    if (action === "create_organisation") {
      const name = clean(payload.name, 120);
      const requestedSlug = clean(payload.slug, 80);
      const slug = toSlug(requestedSlug || name);
      if (!name || !slug) {
        return Response.json({ error: "A client name is required." }, { status: 400 });
      }
      const [existing] = await context.db
        .select({ id: organisations.id })
        .from(organisations)
        .where(eq(organisations.slug, slug))
        .limit(1);
      if (existing) {
        return Response.json({ error: "A client with that name already exists." }, { status: 409 });
      }
      const [created] = await context.db
        .insert(organisations)
        .values({
          id: `org_${crypto.randomUUID().replaceAll("-", "")}`,
          name,
          slug,
          logoUrl: null,
          primaryColour: "#12B4A8",
          planTier: "development",
          status: "active",
        })
        .returning();
      const sourceSets = await context.db
        .select()
        .from(optionSets)
        .where(eq(optionSets.organisationId, context.orgId));
      for (const sourceSet of sourceSets) {
        const newSetId = `set_${crypto.randomUUID().replaceAll("-", "")}`;
        await context.db.insert(optionSets).values({
          id: newSetId,
          organisationId: created.id,
          key: sourceSet.key,
          name: sourceSet.name,
          description: sourceSet.description,
        });
        const sourceValues = await context.db
          .select()
          .from(optionValues)
          .where(eq(optionValues.optionSetId, sourceSet.id));
        for (const sourceValue of sourceValues) {
          await context.db.insert(optionValues).values({
            id: `value_${crypto.randomUUID().replaceAll("-", "")}`,
            organisationId: created.id,
            optionSetId: newSetId,
            value: sourceValue.value,
            label: sourceValue.label,
            colourHex: sourceValue.colourHex,
            textColour: sourceValue.textColour,
            position: sourceValue.position,
            isDone: sourceValue.isDone,
            isDefault: sourceValue.isDefault,
            active: sourceValue.active,
            system: sourceValue.system,
          });
        }
      }

      /*
       * Stage 19 — a new client has to arrive with a board and with identities.
       *
       * Copying the option sets alone left the new organisation with no
       * columns, no groups and nobody who could sign into it, so "create
       * client" produced a workspace that rendered as an error. Both seeders are
       * idempotent and organisation-scoped, and neither writes a single row of
       * operational data: the new client is empty, which is the point.
       */
      const d1 = await getD1();
      await seedBoardStructure(d1, created.id);
      await seedStoreDocumentationBoard(d1, created.id);
      for (const role of ["admin", "client"] as const) {
        const email = organisationIdentityEmail(created.slug, role);
        const userId = `user-${email.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
        await context.db
          .insert(users)
          .values({
            id: userId,
            organisationId: created.id,
            email,
            fullName: `${created.name} ${role}`,
            role: role === "admin" ? "Admin" : "Client",
            active: true,
          })
          .onConflictDoNothing();
        await context.db
          .insert(memberships)
          .values({
            id: `membership-${userId}-${created.id}`,
            userId,
            organisationId: created.id,
            role,
            status: "active",
            acceptedAt: new Date().toISOString(),
          })
          .onConflictDoNothing();
      }

      const response = Response.json({ organisation: created }, { status: 201 });
      response.headers.append(
        "Set-Cookie",
        cookie(ORGANISATION_COOKIE, created.id),
      );
      return response;
    }

    return Response.json({ error: "Unsupported workspace action." }, { status: 400 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The workspace context could not be updated.",
      },
      { status: 400 },
    );
  }
}
