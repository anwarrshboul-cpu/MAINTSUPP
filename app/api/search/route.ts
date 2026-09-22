/**
 * `GET /api/search?q=` — the portal's global search. §36.
 *
 * THE CURRENT WORKSPACE ONLY — the owner's decision. The organisation comes
 * from the session through `scopedDb`, never from the request, so there is no
 * parameter to point this at another tenant. Cross-workspace search is the
 * Platform console's, under Platform authority, not this route's.
 *
 * EVERY GROUP ASKS ITS OWN QUESTION, and a group the caller may not see is not
 * answered at all — absent from `groups` and from `searched`, rather than
 * returned empty, so the panel never implies "no invoices match" to someone
 * who cannot see invoices:
 *
 *   jobs, sites, contractors  `board.view`, the capability their own screens ask;
 *                             jobs and sites also inside the member's site
 *                             restriction (`withinMemberScope`'s rule: a row with
 *                             no site is not provably theirs)
 *   documents                 the document register's OWN handler, called with
 *                             the caller's request — so the capability, the
 *                             live-document filter and every site-restriction
 *                             rule (Q5 included) are the register's, not a copy
 *   invoices, quotes          the Invoice Tracker's door: `board.view` AND a role
 *                             ranked Administrator or above (`guardFinance`)
 *   people                    `users.view`, as the directory itself
 *
 * Matching is case-insensitive on both databases (`app/lib/search-text.ts`).
 * Each group returns a handful — this is a way to get somewhere, not a report.
 */
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { contractors, maintenanceRequests, memberships, sites, users } from "../../../db/schema";
import { FINANCE_CAPABILITIES } from "../../lib/finance/access";
import { listInvoices, listQuotes } from "../../lib/finance/repository";
import { can, requireCapability, resolvePermissions } from "../../lib/permissions";
import { ROLE_RANK } from "../../lib/roles";
import { containsText, searchNeedle, SEARCH_MIN_LENGTH } from "../../lib/search-text";
import { anonymousRefusal, scopedDb } from "../../lib/tenant-db";
import { GET as listDocuments } from "../files/route";

export const dynamic = "force-dynamic";

const PER_GROUP = 6;

export type SearchItem = {
  id: string;
  title: string;
  subtitle: string;
  /** Where the result opens. Jobs open the drawer in place instead — see `kind`. */
  href: string | null;
  kind: "job" | "site" | "contractor" | "document" | "invoice" | "quote" | "person";
};

export type SearchGroup = { key: string; label: string; items: SearchItem[] };

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const raw = url.searchParams.get("q") ?? "";
    const needle = searchNeedle(raw);
    if (!needle) {
      return Response.json(
        { error: `Type at least ${SEARCH_MIN_LENGTH} characters to search.` },
        { status: 400 },
      );
    }
    const scope = await scopedDb(request);
    const { db, orgId, siteScope } = scope;
    const subject = await resolvePermissions(db, orgId, scope.actor.role, scope.siteScope);
    /* The search box lives in the board's shell; a reader who cannot open the
       board cannot use it — the same answer every board read gives. */
    const refusal = requireCapability(subject, "board.view");
    if (refusal) return refusal;
    const restricted = siteScope && siteScope.length ? siteScope : null;
    const groups: SearchGroup[] = [];

    /* ── Jobs ── */
    const jobRows = await db
      .select({
        id: maintenanceRequests.id,
        reference: maintenanceRequests.reference,
        title: maintenanceRequests.title,
        location: maintenanceRequests.location,
        stage: maintenanceRequests.stage,
        status: maintenanceRequests.status,
      })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          isNull(maintenanceRequests.deletedAt),
          restricted ? inArray(maintenanceRequests.siteId, restricted) : undefined,
          or(
            containsText(maintenanceRequests.id, needle),
            containsText(maintenanceRequests.reference, needle),
            containsText(maintenanceRequests.title, needle),
            containsText(maintenanceRequests.location, needle),
            containsText(maintenanceRequests.description, needle),
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
        href: null,
        kind: "job",
      })),
    });

    /* ── Sites ── */
    const siteRows = await db
      .select({ id: sites.id, name: sites.name, code: sites.code, city: sites.city, postcode: sites.postcode })
      .from(sites)
      .where(
        and(
          eq(sites.organisationId, orgId),
          restricted ? inArray(sites.id, restricted) : undefined,
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
        href: `/dashboard/sites?site=${encodeURIComponent(row.id)}`,
        kind: "site",
      })),
    });

    /* ── Contractors ── */
    const contractorRows = await db
      .select({ id: contractors.id, name: contractors.name, contactName: contractors.contactName, active: contractors.active })
      .from(contractors)
      .where(
        and(
          eq(contractors.organisationId, orgId),
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
        href: `/dashboard/contractors?q=${encodeURIComponent(text(row.name))}`,
        kind: "contractor",
      })),
    });

    /* ── Documents: the register's own query, with the caller's own request ── */
    const documentUrl = new URL("/api/files", url);
    documentUrl.searchParams.set("q", raw.trim().slice(0, 80));
    documentUrl.searchParams.set("limit", String(PER_GROUP));
    const documentResponse = await listDocuments(new Request(documentUrl, { headers: request.headers }));
    if (documentResponse.ok) {
      const payload = (await documentResponse.json().catch(() => ({}))) as {
        files?: Array<{ id: string; title?: string | null; originalName?: string; documentType?: string | null }>;
      };
      groups.push({
        key: "documents",
        label: "Documents",
        items: (payload.files ?? []).slice(0, PER_GROUP).map((file) => ({
          id: file.id,
          title: text(file.title) || text(file.originalName) || "Document",
          subtitle: [file.documentType, file.title ? file.originalName : null].filter(Boolean).join(" · "),
          href: `/api/files/${encodeURIComponent(file.id)}`,
          kind: "document",
        })),
      });
    }

    /* ── Invoices and quotes: the Invoice Tracker's door, rank and capability ── */
    const financeReader =
      ROLE_RANK[scope.actor.role] >= ROLE_RANK.admin && can(subject, FINANCE_CAPABILITIES["ledger.read"]);
    if (financeReader) {
      const term = raw.trim().slice(0, 80);
      const invoicePage = await listInvoices(db, orgId, { search: term, limit: PER_GROUP });
      groups.push({
        key: "invoices",
        label: "Invoices",
        items: invoicePage.rows.map((row) => ({
          id: row.id,
          title: text(row.invoiceNumber) || text(row.internalRef) || "Invoice",
          subtitle: [row.counterpartyName, row.status].filter(Boolean).join(" · "),
          href: `/dashboard/invoice-tracker?tab=${row.direction === "receivable" ? "receivable" : "payable"}&q=${encodeURIComponent(text(row.invoiceNumber) || text(row.internalRef))}`,
          kind: "invoice",
        })),
      });
      if (can(subject, FINANCE_CAPABILITIES["quote.read"])) {
        const quotePage = await listQuotes(db, orgId, { search: term, limit: PER_GROUP });
        groups.push({
          key: "quotes",
          label: "Quotes",
          items: quotePage.rows.map((row) => ({
            id: row.id,
            title: text(row.internalRef) || text(row.supplierRef) || "Quote",
            subtitle: [row.supplierRef && row.internalRef ? row.supplierRef : null, row.status].filter(Boolean).join(" · "),
            href: `/dashboard/invoice-tracker?tab=quotes&q=${encodeURIComponent(text(row.internalRef) || text(row.supplierRef))}`,
            kind: "quote",
          })),
        });
      }
    }

    /* ── People: the directory's own capability ── */
    if (can(subject, "users.view")) {
      const people = await db
        .select({ id: users.id, fullName: users.fullName, email: users.email, role: memberships.role })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organisationId, orgId),
            eq(memberships.status, "active"),
            or(containsText(users.fullName, needle), containsText(users.email, needle)),
          ),
        )
        .orderBy(asc(users.fullName))
        .limit(PER_GROUP);
      groups.push({
        key: "people",
        label: "People",
        items: people.map((row) => ({
          id: row.id,
          title: text(row.fullName) || text(row.email),
          subtitle: [row.email, row.role].filter(Boolean).join(" · "),
          href: "/dashboard/admin",
          kind: "person",
        })),
      });
    }

    return Response.json({
      query: raw.trim(),
      searched: groups.map((group) => group.key),
      groups: groups.filter((group) => group.items.length > 0),
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    console.error("[/api/search]", error);
    return Response.json({ error: "Search is temporarily unavailable." }, { status: 503 });
  }
}
