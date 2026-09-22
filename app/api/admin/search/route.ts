/**
 * `GET /api/admin/search?q=` — one search across every workspace on this
 * installation. The platform console's, and only the platform console's.
 *
 * WHY THIS IS A SECOND SEARCH RATHER THAN A PARAMETER ON THE FIRST.
 *
 * §36's `/api/search` is deliberately single-workspace: "the organisation comes
 * from the session through `scopedDb`, never from the request, so there is no
 * parameter to point this at another tenant". Adding `?allWorkspaces=1` to it
 * would put a widening switch on the one route every member of every workspace
 * can call, and the whole safety of that route is that no such switch exists.
 * The owner's note when §36 shipped was that /admin search *may* span
 * workspaces — so it is a separate route, behind the platform gate, and the
 * portal's search is untouched.
 *
 * THE GATE IS `platformAdmin`, NOT A CAPABILITY, for the reason the Clients and
 * enquiries screens already record: every capability in this product is
 * per-workspace, and this answer is deliberately about all of them at once.
 * `scope.organisationIds` is already widened for platform staff
 * (`crossOrganisation: platformAdmin`), which is the same instrument
 * `GET /api/audit` and the enquiry inbox use to read across tenants.
 *
 * EVERY ROW NAMES ITS WORKSPACE. A cross-tenant list where two clients' sites
 * are indistinguishable is worse than no list: the first thing a reader needs is
 * whose data they are looking at, and the second is to be able to go there —
 * which the screen does by switching workspace through `/api/context`, the
 * same door the Clients screen uses, so an organisation the actor is not a
 * member of is still refused.
 *
 * WHAT IT DOES NOT DO. It does not search a workspace's DOCUMENTS or its
 * FINANCE. The document register's own handler applies live-document and
 * site-restriction rules per workspace and cannot be asked "for all of them";
 * the ledger is a workspace's books, read at Admin rank inside that workspace.
 * Both are one workspace switch away, and a cross-tenant view of either is a
 * product decision nobody has taken. The omissions are stated on the screen
 * rather than left for a reader to notice.
 */
import { and, asc, count, desc, eq, inArray, isNull, or } from "drizzle-orm";

import { ensureDatabase } from "../../../../db/init";
import {
  contractors,
  leads,
  maintenanceRequests,
  memberships,
  organisations,
  sitePages,
  sites,
  users,
} from "../../../../db/schema";
import { containsText, searchNeedle, SEARCH_MIN_LENGTH } from "../../../lib/search-text";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

/** A handful per group: this is a way to get somewhere, not a report. */
const PER_GROUP = 8;

export type ConsoleSearchItem = {
  id: string;
  title: string;
  subtitle: string;
  /** Which workspace the row belongs to, or null for the platform's own rows. */
  workspaceId: string | null;
  workspaceName: string | null;
  /** Where the console can open it, when the console is where it lives. */
  href: string | null;
  /** Where the PORTAL shows it, once the reader has switched workspace. */
  portalHref: string | null;
};

export type ConsoleSearchGroup = {
  key: string;
  label: string;
  items: ConsoleSearchItem[];
};

/** What this search cannot answer, said on the screen rather than implied. */
export const CONSOLE_SEARCH_OMISSIONS: readonly string[] = [
  "Documents are not searched here. The register applies each workspace's live-document and site-restriction rules, which only that workspace can answer — open the workspace and search there.",
  "Finance is not searched here. A ledger is a workspace's own books, read at Administrator rank inside it.",
  "Each group shows the first few matches, newest or alphabetical, not every match.",
];

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    if (scope.platformAdmin !== true || !scope.authenticated) {
      return Response.json(
        { error: "Searching across workspaces is MAINTSUPP platform staff's." },
        { status: 403 },
      );
    }

    const url = new URL(request.url);
    const raw = url.searchParams.get("q") ?? "";
    const needle = searchNeedle(raw);
    if (!needle) {
      return Response.json(
        { error: `Type at least ${SEARCH_MIN_LENGTH} characters to search.` },
        { status: 400 },
      );
    }

    const ids = scope.organisationIds;
    const db = scope.db;
    const groups: ConsoleSearchGroup[] = [];
    if (!ids.length) {
      return Response.json({ query: raw.trim(), groups, searched: [], omissions: CONSOLE_SEARCH_OMISSIONS });
    }

    /* Named once, so every row below can say whose data it is without a join. */
    const workspaceRows = await db
      .select({ id: organisations.id, name: organisations.name })
      .from(organisations)
      .where(inArray(organisations.id, ids));
    const names = new Map(workspaceRows.map((row) => [row.id, row.name]));
    const named = (organisationId: string) => ({
      workspaceId: organisationId,
      workspaceName: names.get(organisationId) ?? null,
    });

    /* ── Workspaces themselves ── */
    const matchedWorkspaces = workspaceRows
      .filter((row) => text(row.name).toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle))
      .slice(0, PER_GROUP);
    if (matchedWorkspaces.length) {
      const counts = await db
        .select({ organisationId: memberships.organisationId, value: count() })
        .from(memberships)
        .where(
          and(
            inArray(memberships.organisationId, matchedWorkspaces.map((row) => row.id)),
            eq(memberships.status, "active"),
          ),
        )
        .groupBy(memberships.organisationId);
      const people = new Map(counts.map((row) => [row.organisationId, Number(row.value)]));
      groups.push({
        key: "workspaces",
        label: "Workspaces",
        items: matchedWorkspaces.map((row) => ({
          id: row.id,
          title: text(row.name),
          subtitle: `${people.get(row.id) ?? 0} active ${(people.get(row.id) ?? 0) === 1 ? "member" : "members"}`,
          ...named(row.id),
          href: "/admin/clients",
          portalHref: "/dashboard",
        })),
      });
    }

    /* ── Jobs ── */
    const jobRows = await db
      .select({
        id: maintenanceRequests.id,
        organisationId: maintenanceRequests.organisationId,
        reference: maintenanceRequests.reference,
        title: maintenanceRequests.title,
        location: maintenanceRequests.location,
        stage: maintenanceRequests.stage,
        status: maintenanceRequests.status,
      })
      .from(maintenanceRequests)
      .where(
        and(
          inArray(maintenanceRequests.organisationId, ids),
          isNull(maintenanceRequests.deletedAt),
          or(
            containsText(maintenanceRequests.id, needle),
            containsText(maintenanceRequests.reference, needle),
            containsText(maintenanceRequests.title, needle),
            containsText(maintenanceRequests.location, needle),
          ),
        ),
      )
      .orderBy(desc(maintenanceRequests.requestedAt))
      .limit(PER_GROUP);
    groups.push({
      key: "jobs",
      label: "Jobs",
      items: jobRows.map((row) => ({
        id: row.id,
        title: `${row.reference ?? row.id} · ${text(row.title) || "Untitled job"}`,
        subtitle: [row.location, row.status || row.stage].filter(Boolean).join(" · "),
        ...named(row.organisationId),
        href: null,
        portalHref: "/dashboard",
      })),
    });

    /* ── Sites ── */
    const siteRows = await db
      .select({
        id: sites.id,
        organisationId: sites.organisationId,
        name: sites.name,
        code: sites.code,
        city: sites.city,
        postcode: sites.postcode,
      })
      .from(sites)
      .where(
        and(
          inArray(sites.organisationId, ids),
          or(
            containsText(sites.name, needle),
            containsText(sites.code, needle),
            containsText(sites.city, needle),
            containsText(sites.postcode, needle),
          ),
        ),
      )
      .orderBy(asc(sites.name))
      .limit(PER_GROUP);
    groups.push({
      key: "sites",
      label: "Sites",
      items: siteRows.map((row) => ({
        id: row.id,
        title: text(row.name),
        subtitle: [row.code, row.city, row.postcode].filter(Boolean).join(" · "),
        ...named(row.organisationId),
        href: null,
        portalHref: `/dashboard/sites?site=${encodeURIComponent(row.id)}`,
      })),
    });

    /* ── Contractors ── */
    const contractorRows = await db
      .select({
        id: contractors.id,
        organisationId: contractors.organisationId,
        name: contractors.name,
        contactName: contractors.contactName,
        active: contractors.active,
      })
      .from(contractors)
      .where(
        and(
          inArray(contractors.organisationId, ids),
          or(containsText(contractors.name, needle), containsText(contractors.contactName, needle)),
        ),
      )
      .orderBy(asc(contractors.name))
      .limit(PER_GROUP);
    groups.push({
      key: "contractors",
      label: "Contractors",
      items: contractorRows.map((row) => ({
        id: row.id,
        title: text(row.name),
        subtitle: [row.contactName, row.active === false ? "Archived" : null].filter(Boolean).join(" · "),
        ...named(row.organisationId),
        href: null,
        portalHref: `/dashboard/contractors?q=${encodeURIComponent(text(row.name))}`,
      })),
    });

    /* ── People: one row per membership, so the same person in two workspaces
          appears once for each, which is what a reader of this console needs. ── */
    const peopleRows = await db
      .select({
        id: users.id,
        organisationId: memberships.organisationId,
        fullName: users.fullName,
        email: users.email,
        role: memberships.role,
        status: memberships.status,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          inArray(memberships.organisationId, ids),
          or(containsText(users.fullName, needle), containsText(users.email, needle)),
        ),
      )
      .orderBy(asc(users.fullName))
      .limit(PER_GROUP);
    groups.push({
      key: "people",
      label: "People",
      items: peopleRows.map((row) => ({
        id: `${row.organisationId}:${row.id}`,
        title: text(row.fullName) || text(row.email),
        subtitle: [row.email, row.role, row.status !== "active" ? row.status : null].filter(Boolean).join(" · "),
        ...named(row.organisationId),
        href: "/admin/users",
        portalHref: "/dashboard/admin",
      })),
    });

    /* ── The platform's OWN rows: website pages and enquiries. They belong to no
          workspace, and the console is where they live, so they carry a `href`
          and no workspace name. ── */
    const pageRows = await db
      .select({ id: sitePages.id, slug: sitePages.slug, title: sitePages.title, published: sitePages.published })
      .from(sitePages)
      .where(or(containsText(sitePages.title, needle), containsText(sitePages.slug, needle)))
      .orderBy(asc(sitePages.slug))
      .limit(PER_GROUP);
    groups.push({
      key: "pages",
      label: "Website pages",
      items: pageRows.map((row) => ({
        id: row.id,
        title: text(row.title),
        subtitle: [`/p/${row.slug}`, Number(row.published) === 1 ? "Published" : "Draft"].join(" · "),
        workspaceId: null,
        workspaceName: null,
        href: "/admin/pages",
        portalHref: null,
      })),
    });

    const leadRows = await db
      .select({ id: leads.id, name: leads.name, company: leads.company, email: leads.email, status: leads.status, createdAt: leads.createdAt })
      .from(leads)
      .where(
        and(
          inArray(leads.organisationId, ids),
          or(containsText(leads.name, needle), containsText(leads.company, needle), containsText(leads.email, needle)),
        ),
      )
      .orderBy(desc(leads.createdAt))
      .limit(PER_GROUP);
    groups.push({
      key: "enquiries",
      label: "Website enquiries",
      items: leadRows.map((row) => ({
        id: row.id,
        title: [text(row.name), text(row.company)].filter(Boolean).join(" · ") || text(row.email),
        subtitle: [row.email, row.status].filter(Boolean).join(" · "),
        /* An enquiry is the platform's, whatever workspace id the row carries —
           see `app/api/leads/route.ts`. So it is not labelled with one. */
        workspaceId: null,
        workspaceName: null,
        href: "/admin/leads",
        portalHref: null,
      })),
    });

    return Response.json({
      query: raw.trim(),
      /* Which groups were asked, so the screen can say "no matches" for a group
         rather than leaving a reader wondering whether it was searched. */
      searched: groups.map((group) => group.key),
      groups: groups.filter((group) => group.items.length > 0),
      workspaces: workspaceRows.length,
      omissions: CONSOLE_SEARCH_OMISSIONS,
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    console.error("[/api/admin/search]", error);
    return Response.json({ error: "The search is temporarily unavailable." }, { status: 503 });
  }
}
