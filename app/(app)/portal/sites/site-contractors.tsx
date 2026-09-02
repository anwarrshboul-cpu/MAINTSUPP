"use client";

import { useCallback, useState } from "react";
import { useLoader } from "./use-loader";
import { api, formatDate } from "./site-types";

/**
 * W05-09 — THE FIFTH CONNECTION on a site profile.
 *
 * Jobs, Compliance, Documents and Assets were all reachable from a store; its
 * contractors were not, in any form. There was no tab, `GET /api/sites?id=`
 * carried no `contractors` key, and `contractors` has no `site_id` — so the
 * only path from a store to the people who look after it ran through the job
 * history, which answers a different question. See `app/api/contractor-sites/route.ts`
 * for why the relation is a table and not an inference over `coverage_areas`.
 *
 * The section is deliberately its own component rather than more markup inside
 * `site-detail.tsx`: it is the only part of that screen with its own fetch, its
 * own writes and its own error state, and folding those into the profile's
 * single `useLoader` would mean a failed unlink blanked the whole page.
 */

type LinkedContractor = {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  whatsappNumber: string | null;
  availability: string | null;
  active: boolean;
};

type LinkRow = {
  id: string;
  contractor: LinkedContractor;
  createdAt: string;
  createdBy: string | null;
};

type Payload = {
  siteId: string;
  links: LinkRow[];
  /**
   * `sites.edit`, as the server resolved it.
   *
   * Read from the answer rather than from the role name, for the reason
   * `/api/registers` states `canConfigure`: a role whose `sites.edit` was
   * revoked in Roles is still called "Admin", and a screen that decides by role
   * draws controls the server will refuse.
   */
  canEdit: boolean;
  candidates: LinkedContractor[];
  candidateTotal: number;
  candidateLimit: number;
};

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="analytics-empty">{children}</p>;
}

/** The one line of contact a coordinator scans down the list for. */
function contactLine(contractor: LinkedContractor) {
  return (
    [contractor.contactName, contractor.phone ?? contractor.whatsappNumber, contractor.email]
      .map((part) => (part ?? "").trim())
      .filter(Boolean)
      .join(" · ") || "No contact details"
  );
}

export function SiteContractors({
  siteId,
  siteName,
}: {
  siteId: string;
  siteName: string;
}) {
  /*
   * The search term is part of the REQUEST, not a filter over what arrived.
   *
   * `candidates` is capped at `candidateLimit` on the server, so narrowing on
   * the client would only ever search the first hundred — which on a large
   * estate means the contractor somebody is looking for is unfindable and the
   * box looks broken. Sending `q` searches the whole tenant.
   */
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const fetcher = useCallback(
    () =>
      api<Payload>(
        `/api/contractor-sites?siteId=${encodeURIComponent(siteId)}${
          search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ""
        }`,
      ),
    [siteId, search],
  );
  const { data, error: loadError, reload } = useLoader<Payload>(
    fetcher,
    "This site's contractors could not be loaded.",
  );

  async function link() {
    if (!pending) return;
    setBusy("link");
    setError("");
    try {
      await api("/api/contractor-sites", {
        method: "POST",
        body: { contractorId: pending, siteId },
      });
      setPending("");
      reload();
    } catch (caught) {
      // The server's own sentence — "Contractor not found." is an answer, and
      // replacing it with a generic one loses which of the two ids was wrong.
      setError(caught instanceof Error ? caught.message : "That contractor could not be linked.");
    } finally {
      setBusy(null);
    }
  }

  async function unlink(row: LinkRow) {
    setBusy(row.id);
    setError("");
    try {
      await api(`/api/contractor-sites?id=${encodeURIComponent(row.id)}`, { method: "DELETE" });
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That link could not be removed.");
    } finally {
      setBusy(null);
    }
  }

  if (loadError) return <Empty>{loadError}</Empty>;
  if (!data) return <Empty>Loading contractors…</Empty>;

  const more = data.candidateTotal > data.candidates.length;

  return (
    <div className="site-contractors">
      {data.canEdit && (
        <div className="site-contractors__link">
          <label className="visually-hidden" htmlFor="site-contractor-search">
            Search contractors
          </label>
          <input
            id="site-contractor-search"
            type="search"
            className="site-contractors__search"
            placeholder="Search contractors…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <label className="visually-hidden" htmlFor="site-contractor-choice">
            Contractor to link
          </label>
          <select
            id="site-contractor-choice"
            value={pending}
            onChange={(event) => setPending(event.target.value)}
          >
            {/*
              Only the UNLINKED ones are offered — the server removed the rest.
              A picker that listed a contractor already on the list would be
              offering a choice whose only outcome is "already linked", which is
              a dead end the reader could not see coming.
            */}
            <option value="">Choose a contractor…</option>
            {data.candidates.map((contractor) => (
              <option key={contractor.id} value={contractor.id}>
                {contractor.name}
                {contractor.active ? "" : " (archived)"}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="primary-button"
            disabled={!pending || busy === "link"}
            onClick={() => void link()}
          >
            {busy === "link" ? "Linking…" : "Link contractor"}
          </button>
          {/*
            The cap, said out loud. The list is bounded on the server, and a
            bounded list that does not say so is how somebody concludes a
            contractor is not in the workspace when they are simply past the
            hundredth name.
          */}
          {more && (
            <p className="drawer-label site-contractors__more">
              Showing {data.candidates.length} of {data.candidateTotal} available
              contractors. Search to narrow the list.
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {data.links.length === 0 ? (
        <Empty>
          No contractors are linked to {siteName} yet.
          {data.canEdit ? "" : " Ask somebody with site editing rights to add one."}
        </Empty>
      ) : (
        <div className="table-scroll">
          <table className="analytics-table analytics-table--mobile-cards">
            <caption className="visually-hidden">Contractors linked to {siteName}</caption>
            <thead>
              <tr>
                <th scope="col">Contractor</th>
                <th scope="col">Contact</th>
                <th scope="col">Availability</th>
                <th scope="col">Linked</th>
                {data.canEdit && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {data.links.map((row) => (
                <tr key={row.id}>
                  <td data-label="Contractor">
                    <strong>{row.contractor.name}</strong>
                    {/*
                      An archived contractor keeps their link — being taken off
                      the register is not the same as never having been
                      appointed — but a reader ringing down this list has to be
                      able to see it before they dial.
                    */}
                    {!row.contractor.active && (
                      <span className="contractor-archived-chip">
                        Archived
                        <span className="visually-hidden">
                          {" "}
                          — off the register; this is not their availability
                        </span>
                      </span>
                    )}
                  </td>
                  <td data-label="Contact">{contactLine(row.contractor)}</td>
                  <td data-label="Availability">{row.contractor.availability || "—"}</td>
                  <td data-label="Linked">{formatDate(row.createdAt)}</td>
                  {data.canEdit && (
                    <td data-label="Actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy === row.id}
                        onClick={() => void unlink(row)}
                      >
                        {busy === row.id ? "Removing…" : "Unlink"}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
