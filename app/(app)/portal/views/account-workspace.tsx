"use client";

/**
 * The workspace-side panels behind the avatar menu's Account column:
 * Workspaces (monday's Spaces), Trash, Archive and Plan & billing (monday's
 * Upgrade account).
 *
 * The load-bearing decision is in Trash, and IT WAS REVERSED IN STAGE 23.
 *
 * This file used to say: monday's Trash restores, MAINTSUPP's cannot, because
 * no table stores a deleted row. That was true when it was written, and the
 * screen said so rather than growing a Restore button that could not work.
 *
 * The owner asked for the monday behaviour instead — 30 days of backup and a
 * place to find deleted things — so `maintenance_requests` and
 * `maintenance_groups` now carry `deleted_at`, `recycle_bin` records where each
 * deleted row was sitting, and the Restore button below is real. The deletion
 * history the screen used to show INSTEAD of a bin is still there, below it,
 * because it covers what the bin cannot: everything deleted before Stage 23,
 * and everything since deleted for good.
 *
 * Archive is still a separate, indefinite thing. See the note on that panel.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../../components";
import type { AccountSnapshot } from "../account-menu";
import {
  AccountCard,
  AccountEmpty,
  AccountError,
  AccountHeading,
  AccountLoading,
  AccountStats,
  formatMoment,
} from "./account-ui";

/* ── Workspaces — monday's "Spaces" ─────────────────────────────────────── */

export function AccountWorkspacesPanel({
  snapshot,
  onNotify,
}: {
  snapshot: AccountSnapshot;
  onNotify: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  /*
   * Switching workspace goes through `/api/context`, the same route the sidebar
   * switcher uses. Doing it here rather than reimplementing the selection keeps
   * one rule about which workspace a browser is looking at.
   */
  const select = async (organisationId: string) => {
    setBusy(organisationId);
    try {
      const response = await fetch("/api/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "select_organisation", organisationId }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "The workspace could not be selected.");
      }
      window.location.assign("/dashboard");
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : "The workspace could not be selected.",
      );
      setBusy(null);
    }
  };

  return (
    <>
      <AccountHeading
        eyebrow="Account"
        title="Workspaces"
        lede="Every workspace your membership lets you read. The list is the authority — a workspace you are not a member of cannot be selected, whatever the browser asks for."
      />
      <AccountCard
        title="Your workspaces"
        description={
          snapshot.crossOrganisation
            ? "You are a super admin, so this is every active workspace."
            : "These come from your membership rows."
        }
      >
        <div className="account-list">
          {snapshot.workspaces.map((workspace) => (
            <div
              key={workspace.id}
              className={`account-list__row${workspace.current ? " is-current" : ""}`}
            >
              <div>
                <strong>{workspace.name}</strong>
                <span>
                  {workspace.slug} · {workspace.planTier} · {workspace.status}
                </span>
              </div>
              {workspace.current ? (
                <span className="account-tag account-tag--on">Current</span>
              ) : (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void select(workspace.id)}
                >
                  {busy === workspace.id ? "Switching…" : "Switch"}
                </button>
              )}
            </div>
          ))}
        </div>
      </AccountCard>
    </>
  );
}

/* ── Trash ──────────────────────────────────────────────────────────────── */

/*
 * A DECISION WAS REVERSED ON THIS SCREEN. THE OLD ONE IS RECORDED, NOT ERASED.
 *
 * This panel used to lead with a card headed "Nothing here can be restored",
 * and it was telling the truth: no table carried a `deleted_at`, every delete
 * was a real DELETE, and a Restore button here would have been a lie rendered
 * in a nice font. Showing the deletion history instead was the honest thing to
 * do with the data that actually existed.
 *
 * The owner asked for monday's behaviour — "when someone deleted something we
 * should have backup for 30 days and where he can find also the deleted
 * section" — so Stage 23 changed the schema underneath it. The Restore button
 * below is real: it reads `recycle_bin`, and it puts a job back in its group at
 * the position it held.
 *
 * The history did NOT go away to make room for it. It is still here, below the
 * bin, because the two answer different questions. The bin answers "what can I
 * get back". The history answers "what happened" — including every deletion
 * from before Stage 23, which is gone for ever, and every permanent purge
 * since, which is gone by design. Replacing the second with the first would
 * have quietly destroyed the only record of everything the bin is too late for.
 */

type BinEntry = {
  id: string;
  entityType: string;
  entityId: string;
  boardId: string | null;
  title: string;
  summary: string | null;
  group: string | null;
  deletedBy: string | null;
  deletedByEmail: string | null;
  deletedAt: string;
  expiresAt: string;
  daysLeft: number;
  expired: boolean;
};

type BinPayload = {
  recoverable: boolean;
  /** Whether this reader may restore. A client may read the bin and not act. */
  canRestore?: boolean;
  /** Whether this reader may purge. `data.delete`, which admin lacks by default. */
  canPurge?: boolean;
  retentionDays: number;
  entries: BinEntry[];
  total: number;
  matched: number;
  kinds: string[];
  boards: string[];
  actors: Array<{ email: string | null; name: string | null }>;
};

type TrashPayload = {
  recoverable: boolean;
  reason: string;
  recoveryMatrix: Array<{
    entity: string;
    table: string;
    softDelete: boolean;
    archivable: boolean;
    note: string;
  }>;
  deletions: Array<{
    id: string;
    source: string;
    entityType: string;
    entityId: string;
    action: string;
    actor: string | null;
    summary: string;
    createdAt: string;
  }>;
  deletionCount: number;
};

/** How many deletions the screen shows before asking to be expanded. */
const TRASH_PAGE = 25;

/**
 * What each `entity_type` in the bin is called on screen.
 *
 * A kind with no entry here fell back to its raw database value, so a restored
 * board view read as "board_view" in the one screen whose job is to be legible
 * under pressure. Every kind `sendToBin` can write has a name here.
 */
const BIN_KIND_LABEL: Record<string, string> = {
  job: "Job",
  group: "Board group",
  board_view: "Board view",
  column: "Board column",
};

/**
 * The recycle bin: what was deleted, what can be brought back, and what is
 * about to expire.
 *
 * IT TAKES A TIME ZONE, NOT AN ACCOUNT.
 *
 * The panel used to take the whole `AccountSnapshot` and read one field out of
 * it. That single field was what confined it to the account area, and being
 * confined there is why the bin was reported as unreachable: it sat nine items
 * down a menu behind an avatar, and nothing in the portal linked to it. It is
 * now mounted twice — here, under the account rail, and as "Recycle Bin" in the
 * portal sidebar — from one component, over one API, with one retention model.
 * A second implementation is exactly what must not exist.
 */
export function AccountTrashPanel({
  timezone,
  onNotify,
}: {
  /** For rendering deletion and expiry times. Absent means the browser's own. */
  timezone?: string;
  onNotify: (message: string) => void;
}) {
  const [bin, setBin] = useState<BinPayload | null>(null);
  const [binError, setBinError] = useState<string | null>(null);
  const [data, setData] = useState<TrashPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Filters. Held here rather than pushed into the query string because the
  // panel is one of nine behind the avatar menu and none of the others own the
  // URL; `q` is the only one applied server-side in the same request.
  const [kind, setKind] = useState("all");
  const [board, setBoard] = useState("all");
  const [actor, setActor] = useState("all");
  const [query, setQuery] = useState("");

  /*
   * `reload` is a counter, not a callback.
   *
   * The bin has to refetch on two different triggers: a filter changing, and a
   * restore or purge having just succeeded. Hoisting the fetch into a
   * `useCallback` and calling it from both made the effect depend on a function
   * that sets state, which is the cascading-render pattern the React lint rule
   * exists to catch. Bumping a number instead keeps one effect, one fetch and
   * one dependency list.
   */
  const [reload, setReload] = useState(0);

  useEffect(() => {
    void (async () => {
      try {
        const params = new URLSearchParams();
        if (kind !== "all") params.set("kind", kind);
        if (board !== "all") params.set("board", board);
        if (actor !== "all") params.set("actor", actor);
        if (query.trim()) params.set("q", query.trim());
        const response = await fetch(`/api/trash?${params.toString()}`, {
          headers: { Accept: "application/json" },
        });
        const payload = (await response.json()) as { bin?: BinPayload; error?: string };
        if (!response.ok || !payload.bin) {
          throw new Error(payload.error || "The recycle bin could not be loaded.");
        }
        setBin(payload.bin);
        setBinError(null);
      } catch (caught) {
        setBinError(
          caught instanceof Error ? caught.message : "The recycle bin could not be loaded.",
        );
      }
    })();
  }, [kind, board, actor, query, reload]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/account/trash", {
          headers: { Accept: "application/json" },
        });
        const payload = (await response.json()) as {
          trash?: TrashPayload;
          error?: string;
        };
        if (!response.ok || !payload.trash) {
          throw new Error(payload.error || "The trash could not be loaded.");
        }
        setData(payload.trash);
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "The trash could not be loaded.",
        );
      }
    })();
  }, []);

  const restore = async (entry: BinEntry) => {
    setBusy(entry.id);
    try {
      const response = await fetch("/api/trash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id }),
      });
      const payload = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "It could not be restored.");
      onNotify(payload.message || "Restored.");
      setReload((value) => value + 1);
    } catch (caught) {
      onNotify(caught instanceof Error ? caught.message : "It could not be restored.");
    } finally {
      setBusy(null);
    }
  };

  /*
   * The confirm() is deliberate and it names the thing.
   *
   * Everything else on this screen is reversible, which is the point of the
   * screen. This one button is not, and it is sitting in a row of buttons that
   * are — so it asks, and it asks using the row's own title rather than "this
   * item", because the failure mode being guarded against is pressing it on the
   * wrong row.
   */
  const purge = async (entry: BinEntry) => {
    const confirmed = window.confirm(
      `Delete "${entry.title}" for good?\n\nThis cannot be undone. It will not go back to the board and it will not stay in the bin.`,
    );
    if (!confirmed) return;
    setBusy(entry.id);
    try {
      const response = await fetch(`/api/trash?id=${encodeURIComponent(entry.id)}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "It could not be deleted.");
      onNotify(payload.message || "Deleted for good.");
      setReload((value) => value + 1);
    } catch (caught) {
      onNotify(caught instanceof Error ? caught.message : "It could not be deleted.");
    } finally {
      setBusy(null);
    }
  };

  const filtered = kind !== "all" || board !== "all" || actor !== "all" || query.trim() !== "";

  return (
    <>
      <AccountHeading
        eyebrow="Account"
        title="Trash"
        lede={
          bin
            ? `Deleted jobs and board groups stay here for ${bin.retentionDays} days, then empty automatically. Restoring puts a job back in its group, at the position it held.`
            : "What has been deleted in this workspace, and what can be brought back."
        }
      />

      {binError && <AccountError message={binError} />}
      {!bin && !binError && <AccountLoading label="Reading the recycle bin" />}

      {bin && (
        <>
          <AccountStats
            items={[
              {
                label: "In the bin",
                value: bin.total,
                hint: `Recoverable for ${bin.retentionDays} days`,
              },
              {
                label: "Expiring within 7 days",
                value: bin.entries.filter((entry) => entry.daysLeft <= 7).length,
                hint: "Restore these before they go",
              },
              {
                label: "Retention",
                value: `${bin.retentionDays} days`,
                hint: "Then deleted for good",
              },
            ]}
          />

          <AccountCard
            title="Recycle bin"
            description={
              filtered
                ? `Showing ${bin.matched} of ${bin.total} item${bin.total === 1 ? "" : "s"}.`
                : "Everything deleted in the last 30 days that can still be brought back."
            }
            aside={
              bin.total > 0 ? (
                <span className="account-tag account-tag--on">
                  {bin.total} recoverable
                </span>
              ) : undefined
            }
          >
            <div className="account-form__grid">
              <label className="account-field">
                <span>Search</span>
                <input
                  type="search"
                  value={query}
                  placeholder="Title or reference"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <label className="account-field">
                <span>Type</span>
                <select value={kind} onChange={(event) => setKind(event.target.value)}>
                  <option value="all">All types</option>
                  {bin.kinds.map((value) => (
                    <option key={value} value={value}>
                      {BIN_KIND_LABEL[value] ?? value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="account-field">
                <span>Board</span>
                <select value={board} onChange={(event) => setBoard(event.target.value)}>
                  <option value="all">All boards</option>
                  {bin.boards.map((value) => (
                    <option key={value} value={value ?? ""}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="account-field">
                <span>Deleted by</span>
                <select value={actor} onChange={(event) => setActor(event.target.value)}>
                  <option value="all">Anyone</option>
                  {bin.actors.map((person) => (
                    <option key={person.email ?? ""} value={person.email ?? ""}>
                      {person.name || person.email}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {bin.entries.length === 0 ? (
              <AccountEmpty
                icon="inbox"
                title={filtered ? "Nothing matches those filters" : "The bin is empty"}
              >
                {filtered
                  ? `The bin holds ${bin.total} item${bin.total === 1 ? "" : "s"}; none of them match. Clear the filters to see everything.`
                  : "Nothing has been deleted recently. Deleted jobs and board groups appear here for 30 days."}
              </AccountEmpty>
            ) : (
              <div className="account-table-wrap">
                <table className="account-table">
                  <thead>
                    <tr>
                      <th>What</th>
                      <th>Where it was</th>
                      <th>Deleted by</th>
                      <th>Deleted</th>
                      <th>Expires</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {bin.entries.map((entry) => (
                      <tr key={entry.id}>
                        <td>
                          {entry.title}
                          <small>
                            {BIN_KIND_LABEL[entry.entityType] ?? entry.entityType}
                            {entry.summary ? ` · ${entry.summary}` : ""}
                          </small>
                        </td>
                        <td>
                          {entry.group ?? "—"}
                          {entry.boardId && <small>{entry.boardId}</small>}
                        </td>
                        <td>{entry.deletedBy ?? "—"}</td>
                        <td>{formatMoment(entry.deletedAt, timezone)}</td>
                        <td>
                          {/*
                            Days rather than a date, because "4 days left" is the
                            fact a person acts on and a timestamp makes them do
                            the arithmetic. The date is still in the title so it
                            is available without being in the way.
                          */}
                          <span
                            className={`account-tag${entry.daysLeft <= 7 ? " account-tag--off" : " account-tag--on"}`}
                            title={formatMoment(entry.expiresAt, timezone)}
                          >
                            {entry.expired
                              ? "Due to be purged"
                              : `${entry.daysLeft} day${entry.daysLeft === 1 ? "" : "s"} left`}
                          </span>
                        </td>
                        <td>
                          {/*
                            A button that can only answer 403 is worse than no
                            button: it reads as a fault in the product rather
                            than as a permission. Restoring needs `board.edit`
                            and purging needs `data.delete`; the route says
                            which of them this reader holds.
                          */}
                          {bin.canRestore === false && bin.canPurge === false ? (
                            <span className="account-hint">
                              Ask an admin to restore this.
                            </span>
                          ) : (
                            <>
                              {bin.canRestore !== false && (
                                <button
                                  className="secondary-button"
                                  type="button"
                                  disabled={busy !== null}
                                  onClick={() => void restore(entry)}
                                >
                                  {busy === entry.id ? "Working…" : "Restore"}
                                </button>
                              )}{" "}
                              {bin.canPurge !== false && (
                                <button
                                  className="secondary-button"
                                  type="button"
                                  disabled={busy !== null}
                                  onClick={() => void purge(entry)}
                                >
                                  Delete for good
                                </button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AccountCard>
        </>
      )}

      {error && <AccountError message={error} />}
      {!data && !error && <AccountLoading label="Reading the deletion history" />}

      {data && (
        <>
          <AccountCard
            title="What happens when each thing is deleted"
            description="Read from the schema, not from policy: a row is recoverable only if a column somewhere remembers it."
          >
            <p className="account-note">{data.reason}</p>
            <div className="account-table-wrap">
              <table className="account-table">
                <thead>
                  <tr>
                    <th>Record</th>
                    <th>Table</th>
                    <th>Recoverable</th>
                    <th>What happens</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recoveryMatrix.map((entry) => (
                    <tr key={entry.entity}>
                      <td>{entry.entity}</td>
                      <td>
                        <code>{entry.table}</code>
                      </td>
                      <td>
                        {/*
                          Three states, not two. "Recycle bin" and "Archive
                          instead" are different promises — one is a 30-day
                          countdown, the other is indefinite — and collapsing
                          them into a tick would misdescribe both.
                        */}
                        <span
                          className={`account-tag${entry.softDelete || entry.archivable ? " account-tag--on" : " account-tag--off"}`}
                        >
                          {entry.softDelete
                            ? "Recycle bin"
                            : entry.archivable
                              ? "Archive instead"
                              : "No"}
                        </span>
                      </td>
                      <td>{entry.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="account-note">
              <Link href="/dashboard/account/archive">Archive</Link> is the other
              reversible operation, and it is not the same one: archiving keeps a row
              indefinitely and never expires. The bin is a 30-day safety net for things
              you deleted, not a place to file things you want to keep.
            </p>
          </AccountCard>

          <AccountCard
            title="Deletion history"
            description={
              data.deletions.length > TRASH_PAGE && !showAll
                ? `Every deletion this workspace has recorded, from the activity log and the audit trail — including the ones from before the bin existed, and the ones since deleted for good. This is a history, not a bin. Showing the ${TRASH_PAGE} most recent of ${data.deletions.length}.`
                : "Every deletion this workspace has recorded, from the activity log and the audit trail — including the ones from before the bin existed, and the ones since deleted for good. This is a history, not a bin."
            }
            aside={
              data.deletions.length > TRASH_PAGE ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setShowAll((value) => !value)}
                >
                  {showAll ? `Show ${TRASH_PAGE}` : `Show all ${data.deletions.length}`}
                </button>
              ) : undefined
            }
          >
            {data.deletions.length === 0 ? (
              <AccountEmpty icon="activity" title="Nothing has been deleted">
                No entry in <code>activity_log</code> or <code>audit_events</code> for
                this workspace records a deletion.
              </AccountEmpty>
            ) : (
              <div className="account-table-wrap">
                <table className="account-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>What</th>
                      <th>Action</th>
                      <th>Who</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(showAll
                      ? data.deletions
                      : data.deletions.slice(0, TRASH_PAGE)
                    ).map((entry) => (
                      <tr key={`${entry.source}-${entry.id}`}>
                        <td>{formatMoment(entry.createdAt, timezone)}</td>
                        <td>
                          {entry.summary || entry.entityId}
                          <small>{entry.entityType}</small>
                        </td>
                        <td>
                          <code>{entry.action}</code>
                        </td>
                        <td>{entry.actor ?? "—"}</td>
                        <td>
                          <code>{entry.source}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AccountCard>
        </>
      )}
    </>
  );
}

/* ── Archive ────────────────────────────────────────────────────────────── */

type ArchiveGroup = {
  kind: string;
  label: string;
  restorable: boolean;
  timestamps: boolean;
  restoreNote?: string;
  restoreHref?: string;
  items: Array<{
    id: string;
    title: string;
    detail: string;
    archivedAt: string | null;
    updatedAt: string | null;
  }>;
};

export function AccountArchivePanel({
  snapshot,
  onNotify,
}: {
  snapshot: AccountSnapshot;
  onNotify: (message: string) => void;
}) {
  const [groups, setGroups] = useState<ArchiveGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/account/archive", {
        headers: { Accept: "application/json" },
      });
      const payload = (await response.json()) as {
        archive?: { groups: ArchiveGroup[] };
        error?: string;
      };
      if (!response.ok || !payload.archive) {
        throw new Error(payload.error || "The archive could not be loaded.");
      }
      setGroups(payload.archive.groups);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The archive could not be loaded.",
      );
    }
  }, []);

  useEffect(() => {
    // Deferred a tick, matching the portal's own loaders: the state lands from
    // the timer rather than synchronously inside the effect body.
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const restore = async (kind: string, id: string) => {
    setBusy(id);
    try {
      const response = await fetch("/api/account/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, id }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "The item could not be restored.");
      }
      await load();
      onNotify("Restored. It is back where it was archived from.");
    } catch (caught) {
      onNotify(
        caught instanceof Error ? caught.message : "The item could not be restored.",
      );
    } finally {
      setBusy(null);
    }
  };

  const total = groups?.reduce((sum, group) => sum + group.items.length, 0) ?? 0;

  return (
    <>
      <AccountHeading
        eyebrow="Account"
        title="Archive"
        lede="Archiving is the reversible half of removing something. Everything here still exists and can be put back."
      />

      {error && <AccountError message={error} />}
      {!groups && !error && <AccountLoading label="Reading the archive" />}

      {groups && total === 0 && (
        <AccountCard>
          <AccountEmpty icon="folder" title="Nothing is archived">
            Four kinds of record can be archived in this workspace — jobs, board
            groups, boards and teams. None of them currently is.
          </AccountEmpty>
        </AccountCard>
      )}

      {groups?.map((group) =>
        group.items.length === 0 ? null : (
          <AccountCard
            key={group.kind}
            title={group.label}
            description={
              group.restorable
                ? `${group.items.length} archived.`
                : group.restoreNote
            }
            aside={
              !group.restorable && group.restoreHref ? (
                <a className="secondary-button" href={group.restoreHref}>
                  Open Teams
                </a>
              ) : undefined
            }
          >
            <div className="account-list">
              {group.items.map((item) => (
                <div key={item.id} className="account-list__row">
                  <div>
                    <strong>{item.title}</strong>
                    <span>
                      {item.detail}
                      {group.timestamps && item.archivedAt
                        ? ` · archived ${formatMoment(item.archivedAt, snapshot.profile.timezone)}`
                        : ""}
                    </span>
                  </div>
                  {group.restorable ? (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void restore(group.kind, item.id)}
                    >
                      <Icon name="updates" size={15} />
                      {busy === item.id ? "Restoring…" : "Restore"}
                    </button>
                  ) : (
                    <span className="account-tag">Restore elsewhere</span>
                  )}
                </div>
              ))}
            </div>
          </AccountCard>
        ),
      )}
    </>
  );
}

/* ── Plan & billing — monday's "Upgrade account" ────────────────────────── */

export function AccountBillingPanel({ snapshot }: { snapshot: AccountSnapshot }) {
  const tier = snapshot.workspace.planTier;
  return (
    <>
      <AccountHeading
        eyebrow="Explore"
        title="Plan & billing"
        lede="monday puts an Upgrade button here. There is nothing to upgrade to yet, so this shows the plan the workspace row actually carries and what it holds."
      />

      <AccountCard
        title="Current plan"
        aside={<span className="account-plan-pill">{tier}</span>}
        description={
          <>
            Read from <code>organisations.plan_tier</code> for{" "}
            <strong>{snapshot.workspace.name}</strong>.
          </>
        }
      >
        <AccountStats
          items={[
            { label: "Jobs", value: snapshot.usage.maintenanceRequests.toLocaleString("en-GB") },
            { label: "Sites", value: snapshot.usage.sites.toLocaleString("en-GB") },
            { label: "Units", value: snapshot.usage.units.toLocaleString("en-GB") },
            { label: "Active members", value: snapshot.usage.members.toLocaleString("en-GB") },
          ]}
        />
      </AccountCard>

      <AccountCard tone="notice" title="No billing is connected">
        <p className="account-note">
          There is no payment provider, no subscription record and no seat metering
          in this product. <code>plan_tier</code> is a label on the workspace that
          other screens can read; it does not gate anything and nothing is charged
          against it. A price list here would be an invention, so there is not one.
        </p>
        <p className="account-note">
          To change the tier on a workspace, an administrator edits the workspace
          record — see <Link href="/dashboard/admin">Administration</Link>.
        </p>
      </AccountCard>

      <AccountCard title="Workspace record">
        <dl className="account-definitions">
          <div>
            <dt>Workspace</dt>
            <dd>{snapshot.workspace.name}</dd>
          </div>
          <div>
            <dt>Slug</dt>
            <dd>
              <code>{snapshot.workspace.slug}</code>
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{snapshot.workspace.status}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>
              {formatMoment(snapshot.workspace.createdAt, snapshot.profile.timezone)}
            </dd>
          </div>
        </dl>
      </AccountCard>
    </>
  );
}
