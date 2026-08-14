"use client";

/**
 * Teams — the screen behind /dashboard/teams.
 *
 * Two panels, because there are two questions and they are not the same one.
 * The left is "who is on this team", which is how you staff a rota. The right
 * is "which teams is this person on", which is the question actually asked when
 * somebody leaves, and deriving it by reading every team card is exactly the
 * work a screen is supposed to do for you.
 *
 * A person may be on any number of teams; nothing here is exclusive. "Lead"
 * marks who to escalate to and grants nothing — the API says the same, so the
 * badge is not a lie the UI tells about permissions it does not enforce.
 *
 * Archiving, not deleting. An archived team keeps its members and its history;
 * it is hidden behind a toggle rather than removed, so a question about last
 * quarter still resolves to a name. That is a product rule, and the wording on
 * the button says so rather than saying "Delete" and quietly doing something
 * else.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../../../components";
import teamsCss from "./teams-manager.css?url";

type TeamMember = {
  id: string;
  userId: string;
  teamRole: string;
  email: string;
  fullName: string | null;
  active: boolean;
  since: string | null;
};

type Team = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  colourHex: string;
  position: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  members: TeamMember[];
};

type Person = {
  userId: string;
  email: string;
  fullName: string | null;
  active: boolean;
  role: string;
  status: string;
};

type TeamsPayload = {
  organisation: { id: string; name: string };
  canManage: boolean;
  teams: Team[];
  people: Person[];
};

/**
 * The starting colours.
 *
 * MAINTSUPP's own hues first so a new team looks like part of the product
 * before anybody has chosen anything. A free colour input sits beside them for
 * the workspaces that already have their own convention.
 */
const SWATCHES = [
  "#12B4A8",
  "#3E8FD8",
  "#7C5CD6",
  "#F08B23",
  "#DA4646",
  "#38BE7B",
  "#EEAB25",
  "#81949F",
];

function personLabel(person: { fullName: string | null; email: string }) {
  return person.fullName?.trim() || person.email;
}

/**
 * Two letters for the avatar.
 *
 * Punctuation is stripped before the split, because the seeded names carry
 * parenthesised suffixes — "Admin (testing)" would otherwise read as "A(".
 */
function initials(person: { fullName: string | null; email: string }) {
  const parts = personLabel(person)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const letters = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
  return (letters || parts[0]?.slice(0, 2) || "?").toUpperCase();
}

export function TeamsManager({ onNotify }: { onNotify?: (message: string) => void }) {
  const [data, setData] = useState<TeamsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newColour, setNewColour] = useState(SWATCHES[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");

  const notify = useCallback(
    (message: string) => {
      if (onNotify) onNotify(message);
    },
    [onNotify],
  );

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/teams", { cache: "no-store" });
      const payload = (await response.json()) as TeamsPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Teams could not be loaded.");
      setData(payload);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Teams could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- `load` awaits the fetch
     before it touches state, so nothing runs synchronously in the effect body;
     the rule cannot see through the promise. Loading server-held rows on mount
     is the external-system synchronisation effects exist for. */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /**
   * One place every write goes through.
   *
   * Reloads from the server rather than patching local state: team membership
   * has two views of the same rows on this screen, and hand-maintaining both
   * after every edit is how they drift apart.
   */
  const send = useCallback(
    async (url: string, method: string, body: Record<string, unknown>, done: string) => {
      setBusy(true);
      try {
        const response = await fetch(url, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "That change could not be saved.");
        await load();
        notify(done);
        return true;
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "That change could not be saved.";
        setError(message);
        notify(message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, notify],
  );

  /* Memoised because three `useMemo`s below depend on it: a fresh `[]` on every
     render would make each of them recompute every render. */
  const teams = useMemo(() => data?.teams ?? [], [data]);
  const people = useMemo(() => data?.people ?? [], [data]);
  const canManage = data?.canManage ?? false;

  const visibleTeams = useMemo(
    () => teams.filter((team) => showArchived || !team.archived),
    [teams, showArchived],
  );
  const archivedCount = useMemo(
    () => teams.filter((team) => team.archived).length,
    [teams],
  );

  /** Person → the teams they are on. The right-hand panel's whole content. */
  const teamsByPerson = useMemo(() => {
    const map = new Map<string, Array<{ team: Team; teamRole: string }>>();
    for (const team of teams) {
      for (const member of team.members) {
        const list = map.get(member.userId) ?? [];
        list.push({ team, teamRole: member.teamRole });
        map.set(member.userId, list);
      }
    }
    return map;
  }, [teams]);

  const createTeam = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const ok = await send(
      "/api/teams",
      "POST",
      { name, description: newDescription.trim(), colourHex: newColour },
      `Created the team "${name}".`,
    );
    if (ok) {
      setNewName("");
      setNewDescription("");
    }
  };

  const saveEdit = async (team: Team) => {
    const name = editName.trim();
    if (!name) return;
    const ok = await send(
      "/api/teams",
      "PATCH",
      { id: team.id, name, description: editDescription.trim() },
      `Saved "${name}".`,
    );
    if (ok) setEditingId(null);
  };

  const stylesheet = <link rel="stylesheet" href={teamsCss} precedence="default" />;

  if (loading) {
    return (
      <section className="teams">
        {stylesheet}
        <p className="teams__loading">Loading teams…</p>
      </section>
    );
  }

  return (
    <section className="teams">
      {stylesheet}

      <header className="teams__head">
        <div>
          <h2>Teams</h2>
          <p>
            Groups of people inside {data?.organisation.name ?? "this workspace"}. A team
            says who to call — it does not grant access, which still comes from a
            person&apos;s role.
          </p>
        </div>
        <div className="teams__head-actions">
          {archivedCount > 0 && (
            <button
              type="button"
              className={`teams__toggle${showArchived ? " is-on" : ""}`}
              onClick={() => setShowArchived((value) => !value)}
            >
              <Icon name="folder" size={15} />
              {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
            </button>
          )}
        </div>
      </header>

      {error && (
        <p className="teams__error" role="alert">
          <Icon name="alert" size={15} /> {error}
        </p>
      )}

      {!canManage && (
        <p className="teams__notice">
          You can see every team here. Creating and changing them is an admin action.
        </p>
      )}

      <div className="teams__layout">
        <div className="teams__main">
          {canManage && (
            <form className="teams__create" onSubmit={createTeam}>
              <div className="teams__create-row">
                <label className="teams__field">
                  <span>Team name</span>
                  <input
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    placeholder="Facilities"
                    maxLength={80}
                  />
                </label>
                <label className="teams__field teams__field--grow">
                  <span>Description</span>
                  <input
                    value={newDescription}
                    onChange={(event) => setNewDescription(event.target.value)}
                    placeholder="What this team covers"
                    maxLength={400}
                  />
                </label>
              </div>
              <div className="teams__create-row">
                <div className="teams__swatches" role="group" aria-label="Team colour">
                  {SWATCHES.map((colour) => (
                    <button
                      key={colour}
                      type="button"
                      aria-label={`Use colour ${colour}`}
                      aria-pressed={newColour.toLowerCase() === colour.toLowerCase()}
                      className={`teams__swatch${
                        newColour.toLowerCase() === colour.toLowerCase() ? " is-on" : ""
                      }`}
                      style={{ background: colour }}
                      onClick={() => setNewColour(colour)}
                    />
                  ))}
                  <input
                    type="color"
                    className="teams__colour-input"
                    aria-label="Custom team colour"
                    value={newColour}
                    onChange={(event) => setNewColour(event.target.value.toUpperCase())}
                  />
                </div>
                <button
                  type="submit"
                  className="teams__primary"
                  disabled={busy || !newName.trim()}
                >
                  <Icon name="plus" size={15} /> Create team
                </button>
              </div>
            </form>
          )}

          {!visibleTeams.length ? (
            <div className="teams__empty">
              <Icon name="users" size={26} />
              <h3>No teams yet</h3>
              <p>
                {canManage
                  ? "Create the first team above. Nothing is invented here — the list stays empty until somebody makes one."
                  : "This workspace has no teams yet."}
              </p>
            </div>
          ) : (
            <ul className="teams__list">
              {visibleTeams.map((team) => {
                const available = people.filter(
                  (person) => !team.members.some((member) => member.userId === person.userId),
                );
                return (
                  <li
                    key={team.id}
                    className={`teams__card${team.archived ? " is-archived" : ""}`}
                    style={{ ["--team-colour" as string]: team.colourHex }}
                  >
                    <div className="teams__card-head">
                      <span className="teams__dot" aria-hidden="true" />
                      {editingId === team.id ? (
                        <div className="teams__edit">
                          <input
                            value={editName}
                            onChange={(event) => setEditName(event.target.value)}
                            maxLength={80}
                            aria-label="Team name"
                          />
                          <input
                            value={editDescription}
                            onChange={(event) => setEditDescription(event.target.value)}
                            maxLength={400}
                            placeholder="Description"
                            aria-label="Team description"
                          />
                          <button
                            type="button"
                            className="teams__primary"
                            disabled={busy}
                            onClick={() => void saveEdit(team)}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="teams__ghost"
                            onClick={() => setEditingId(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="teams__title">
                          <h3>
                            {team.name}
                            {team.archived && <span className="teams__tag">Archived</span>}
                          </h3>
                          <p>
                            {team.description ||
                              `${team.members.length} member${team.members.length === 1 ? "" : "s"}`}
                          </p>
                        </div>
                      )}

                      {canManage && editingId !== team.id && (
                        <div className="teams__card-actions">
                          <input
                            type="color"
                            className="teams__colour-input"
                            aria-label={`Colour for ${team.name}`}
                            value={team.colourHex}
                            onChange={(event) =>
                              void send(
                                "/api/teams",
                                "PATCH",
                                { id: team.id, colourHex: event.target.value.toUpperCase() },
                                `Recoloured "${team.name}".`,
                              )
                            }
                          />
                          <button
                            type="button"
                            className="teams__ghost"
                            onClick={() => {
                              setEditingId(team.id);
                              setEditName(team.name);
                              setEditDescription(team.description ?? "");
                            }}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            className="teams__ghost"
                            disabled={busy}
                            onClick={() =>
                              void send(
                                "/api/teams",
                                "PATCH",
                                { id: team.id, archived: !team.archived },
                                team.archived
                                  ? `Restored "${team.name}".`
                                  : `Archived "${team.name}". Its members are kept.`,
                              )
                            }
                          >
                            {team.archived ? "Restore" : "Archive"}
                          </button>
                        </div>
                      )}
                    </div>

                    {team.members.length ? (
                      <ul className="teams__members">
                        {team.members.map((member) => (
                          <li key={member.id} className="teams__member">
                            <span className="teams__avatar" aria-hidden="true">
                              {initials(member)}
                            </span>
                            <span className="teams__member-name">
                              {personLabel(member)}
                              {member.teamRole === "lead" && (
                                <span className="teams__lead">Lead</span>
                              )}
                            </span>
                            <span className="teams__member-email">{member.email}</span>
                            {canManage && (
                              <span className="teams__member-actions">
                                <button
                                  type="button"
                                  className="teams__ghost"
                                  disabled={busy}
                                  onClick={() =>
                                    void send(
                                      "/api/teams/members",
                                      "POST",
                                      {
                                        teamId: team.id,
                                        userId: member.userId,
                                        teamRole: member.teamRole === "lead" ? "member" : "lead",
                                      },
                                      member.teamRole === "lead"
                                        ? `${personLabel(member)} is no longer lead.`
                                        : `${personLabel(member)} now leads "${team.name}".`,
                                    )
                                  }
                                >
                                  {member.teamRole === "lead" ? "Unset lead" : "Make lead"}
                                </button>
                                <button
                                  type="button"
                                  className="teams__ghost teams__ghost--danger"
                                  disabled={busy}
                                  onClick={() =>
                                    void send(
                                      "/api/teams/members",
                                      "DELETE",
                                      { teamId: team.id, userId: member.userId },
                                      `Removed ${personLabel(member)} from "${team.name}".`,
                                    )
                                  }
                                >
                                  Remove
                                </button>
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="teams__no-members">Nobody is on this team yet.</p>
                    )}

                    {canManage && !team.archived && (
                      <label className="teams__add">
                        <span className="teams__add-label">Add someone</span>
                        <select
                          value=""
                          disabled={busy || !available.length}
                          onChange={(event) => {
                            const userId = event.target.value;
                            if (!userId) return;
                            const person = available.find((entry) => entry.userId === userId);
                            void send(
                              "/api/teams/members",
                              "POST",
                              { teamId: team.id, userId, teamRole: "member" },
                              person
                                ? `Added ${personLabel(person)} to "${team.name}".`
                                : `Added somebody to "${team.name}".`,
                            );
                          }}
                        >
                          <option value="">
                            {available.length
                              ? "Choose a person…"
                              : "Everyone in this workspace is already on this team"}
                          </option>
                          {available.map((person) => (
                            <option key={person.userId} value={person.userId}>
                              {personLabel(person)} — {person.email}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <aside className="teams__side">
          <h3>People</h3>
          <p className="teams__side-note">
            Everyone with an active membership here, and the teams they belong to.
          </p>
          {!people.length ? (
            <p className="teams__no-members">
              No one has been invited to this workspace yet.
            </p>
          ) : (
            <ul className="teams__people">
              {people.map((person) => {
                const memberships = teamsByPerson.get(person.userId) ?? [];
                return (
                  <li key={person.userId} className="teams__person">
                    <span className="teams__avatar" aria-hidden="true">
                      {initials(person)}
                    </span>
                    <div className="teams__person-body">
                      <strong>{personLabel(person)}</strong>
                      <span className="teams__person-email">{person.email}</span>
                      {memberships.length ? (
                        <span className="teams__person-teams">
                          {memberships.map(({ team, teamRole }) => (
                            <span
                              key={team.id}
                              className={`teams__chip${team.archived ? " is-archived" : ""}`}
                              style={{ ["--team-colour" as string]: team.colourHex }}
                            >
                              {team.name}
                              {teamRole === "lead" ? " · lead" : ""}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="teams__person-none">On no teams</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>
    </section>
  );
}

export default TeamsManager;
